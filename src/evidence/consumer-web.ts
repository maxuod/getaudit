import { z } from "zod";
import type { Ledger } from "../db/index.ts";
import type { ObservationSurfaceContext, RawCitation } from "../engines/types.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
import {
  finishRun,
  getBrand,
  getPromptSet,
  listPrompts,
  recordObservation,
  startRun,
} from "../ledger/repo.ts";

const countryCode = z.string().regex(/^[A-Z]{2}$/, "国家代码必须是两位大写 ISO 代码，如 US");
const evidenceHash = z.string().regex(/^[a-f0-9]{64}$/, "SHA-256 必须是 64 位小写十六进制");

const citationSchema = z
  .object({
    url: z.url(),
    title: z.string().min(1).optional(),
    snippet: z.string().min(1).optional(),
  })
  .strict();

const surfaceSchema = z
  .object({
    engine: z
      .string()
      .regex(
        /^consumer_web_[a-z0-9_]+$/,
        "engine 必须以 consumer_web_ 开头且只含小写字母、数字和下划线",
      ),
    provider: z.string().min(1),
    product_surface: z.string().min(1),
    collection_mode: z.enum(["manual_capture", "managed_scraper", "browser_automation"]),
    account_state: z.enum(["logged_out", "logged_in", "unknown"]),
    personalization_state: z.enum(["fresh", "active", "disabled", "unknown"]),
    search_mode: z.enum(["natural", "explicit_search", "forced_search", "unknown"]),
    target_country: countryCode,
    exit_country: countryCode.optional(),
    geo_verification: z.enum(["ip_observed", "provider_asserted", "unverified"]),
    browser_locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/, "browser_locale 示例：en-US"),
    timezone_id: z.string().min(1),
    geolocation_policy: z.enum(["denied", "unavailable", "city_emulated", "real", "unknown"]),
    device: z.enum(["desktop", "mobile", "tablet", "unknown"]),
    account_label: z.string().min(1).max(80).optional(),
  })
  .strict()
  .superRefine((surface, ctx) => {
    if (surface.geo_verification === "ip_observed" && !surface.exit_country) {
      ctx.addIssue({
        code: "custom",
        path: ["exit_country"],
        message: "geo_verification=ip_observed 时必须填写 exit_country",
      });
    }
    if (surface.account_state === "logged_in" && !surface.account_label) {
      ctx.addIssue({
        code: "custom",
        path: ["account_label"],
        message: "登录观测必须用非邮箱别名区分账号队列，如 personal-paid-a",
      });
    }
    if (surface.account_label?.includes("@")) {
      ctx.addIssue({
        code: "custom",
        path: ["account_label"],
        message: "account_label 不得使用邮箱；请使用匿名队列别名",
      });
    }
  });

const captureSchema = z
  .object({
    prompt_id: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    observed_at: z.iso.datetime({ offset: true }),
    answer_text: z.string().min(1),
    citations: z.array(citationSchema).default([]),
    retrieval_used: z.boolean().nullable().optional(),
    model_version: z.string().min(1).optional(),
    capture_reference: z.string().min(1).optional(),
    screenshot_sha256: evidenceHash.optional(),
  })
  .strict()
  .superRefine((capture, ctx) => {
    if (Boolean(capture.prompt_id) === Boolean(capture.prompt)) {
      ctx.addIssue({
        code: "custom",
        path: ["prompt_id"],
        message: "每条捕获必须且只能填写 prompt_id 或 prompt 其中一个",
      });
    }
  });

export const consumerWebEvidenceSchema = z
  .object({
    schema_version: z.literal("consumer-web-evidence-v1"),
    prompt_set_id: z.string().min(1),
    phase: z.enum(["baseline", "followup"]),
    note: z.string().optional(),
    surface: surfaceSchema,
    observations: z.array(captureSchema).min(1),
  })
  .strict();

export type ConsumerWebEvidenceBundle = z.infer<typeof consumerWebEvidenceSchema>;

export interface ConsumerWebImportResult {
  runId: string;
  engine: string;
  observations: number;
  bundleSha256: string;
  locationStatus: ObservationSurfaceContext["locationStatus"];
}

function locationStatus(
  surface: ConsumerWebEvidenceBundle["surface"],
): ObservationSurfaceContext["locationStatus"] {
  if (surface.geo_verification === "unverified") return "unverified";
  if (surface.exit_country) {
    return surface.exit_country === surface.target_country ? "matched" : "mismatched";
  }
  // provider_asserted 表示供应商明确执行了 target_country 参数，但并不等于 IP 实测。
  return surface.geo_verification === "provider_asserted" ? "matched" : "unverified";
}

/**
 * 导入用户手工或合规供应商取得的消费级网页证据。
 *
 * 安全边界：输入只包含答案、引用和非秘密实验条件；不得包含密码、cookie、
 * Authorization header 或完整账号邮箱。每个 bundle 必须完整覆盖冻结 prompt 集，
 * 才会被封存成可进入正式完整性检查的 run。
 */
export function importConsumerWebEvidence(
  db: Ledger,
  input: unknown,
): ConsumerWebImportResult {
  const bundle = consumerWebEvidenceSchema.parse(input);
  const set = getPromptSet(db, bundle.prompt_set_id);
  if (!set.frozen_at || !set.frozen_hash) {
    throw new Error("prompt 集尚未冻结；网页版证据只能导入已冻结集合");
  }

  const prompts = listPrompts(db, bundle.prompt_set_id);
  const byId = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const byText = new Map(prompts.map((prompt) => [prompt.text, prompt]));
  const resolved = bundle.observations.map((capture) => {
    const prompt = capture.prompt_id ? byId.get(capture.prompt_id) : byText.get(capture.prompt!);
    if (!prompt) {
      throw new Error(
        capture.prompt_id
          ? `证据包含不属于该集合的 prompt_id：${capture.prompt_id}`
          : `证据中的 prompt 与冻结集合不完全匹配：${capture.prompt}`,
      );
    }
    return { capture, prompt };
  });

  const uniquePromptIds = new Set(resolved.map((row) => row.prompt.id));
  if (uniquePromptIds.size !== resolved.length) {
    throw new Error("证据包重复包含同一条 prompt");
  }
  if (uniquePromptIds.size !== prompts.length) {
    const missing = prompts.filter((prompt) => !uniquePromptIds.has(prompt.id));
    throw new Error(
      `证据包未完整覆盖冻结集合：计划 ${prompts.length} 条，实际 ${uniquePromptIds.size} 条；` +
        `缺少 ${missing.slice(0, 3).map((prompt) => prompt.text).join(" | ")}`,
    );
  }

  const localeMismatch = prompts.find(
    (prompt) => prompt.locale.toLowerCase() !== bundle.surface.browser_locale.toLowerCase(),
  );
  if (localeMismatch) {
    throw new Error(
      `浏览器 locale=${bundle.surface.browser_locale} 与 prompt locale=${localeMismatch.locale} 不一致；` +
        "请分开建立地域/语言队列，不能混在同一 run",
    );
  }

  const status = locationStatus(bundle.surface);
  if (status === "mismatched") {
    throw new Error(
      `出口国家 ${bundle.surface.exit_country} 与目标国家 ${bundle.surface.target_country} 不一致；` +
        "拒绝导入，先修正代理/VPN 与浏览器地域条件",
    );
  }
  if (status === "unverified") {
    throw new Error(
      "地域尚未验证；手工浏览器请先做中立 IP 国家检查，供应商采集请使用 provider_asserted",
    );
  }
  const bundleSha256 = sha256(canonicalJson(bundle));
  const prepared = resolved.map(({ capture, prompt }) => {
    const itemSha256 = sha256(
      canonicalJson({
        schema_version: bundle.schema_version,
        prompt_set_id: bundle.prompt_set_id,
        surface: bundle.surface,
        prompt_id: prompt.id,
        capture,
      }),
    );
    return { capture, prompt, itemSha256 };
  });

  // 在创建 run 前阻止重复导入，避免唯一约束失败后留下空的未封存轮次。
  const duplicate = prepared.find(({ itemSha256 }) =>
    db
      .prepare(`SELECT 1 AS found FROM observation_surface_context WHERE evidence_sha256 = ?`)
      .get(itemSha256),
  );
  if (duplicate) throw new Error(`该网页证据已导入：${duplicate.itemSha256}`);

  const configJson = canonicalJson({
    schema_version: "run-config-v1",
    prompt_set_id: bundle.prompt_set_id,
    prompt_set_hash: set.frozen_hash,
    phase: bundle.phase,
    prompt_locales: [...new Set(prompts.map((prompt) => prompt.locale))].sort(),
    sampling: { default: 1, by_engine: {} },
    engines: [
      {
        name: bundle.surface.engine,
        config: {
          evidence_schema: bundle.schema_version,
          surface_class: "consumer_web",
          provider: bundle.surface.provider,
          product_surface: bundle.surface.product_surface,
          collection_mode: bundle.surface.collection_mode,
          account_state: bundle.surface.account_state,
          account_label: bundle.surface.account_label ?? null,
          personalization_state: bundle.surface.personalization_state,
          search_mode: bundle.surface.search_mode,
          target_country: bundle.surface.target_country,
          exit_country: bundle.surface.exit_country ?? null,
          geo_verification: bundle.surface.geo_verification,
          location_status: status,
          browser_locale: bundle.surface.browser_locale,
          timezone_id: bundle.surface.timezone_id,
          geolocation_policy: bundle.surface.geolocation_policy,
          device: bundle.surface.device,
        },
      },
    ],
  });

  const runId = startRun(db, {
    promptSetId: bundle.prompt_set_id,
    phase: bundle.phase,
    runsPerPrompt: 1,
    runsConfig: "1",
    configJson,
    configHash: sha256(configJson),
    note: [bundle.note, `consumer web evidence bundle sha256=${bundleSha256}`]
      .filter(Boolean)
      .join("; "),
  });
  const brand = getBrand(db, set.brand_id);

  for (const { capture, prompt, itemSha256 } of prepared) {
    const citations = capture.citations as RawCitation[];
    const retrievalUsed = capture.retrieval_used ?? undefined;
    recordObservation(db, {
      runId,
      promptId: prompt.id,
      runIdx: 1,
      locale: prompt.locale,
      observedAt: capture.observed_at,
      brand,
      surfaceContext: {
        surfaceClass: "consumer_web",
        provider: bundle.surface.provider,
        productSurface: bundle.surface.product_surface,
        collectionMode: bundle.surface.collection_mode,
        accountState: bundle.surface.account_state,
        personalizationState: bundle.surface.personalization_state,
        searchMode: bundle.surface.search_mode,
        targetCountry: bundle.surface.target_country,
        exitCountry: bundle.surface.exit_country,
        geoVerification: bundle.surface.geo_verification,
        locationStatus: status,
        browserLocale: bundle.surface.browser_locale,
        timezoneId: bundle.surface.timezone_id,
        geolocationPolicy: bundle.surface.geolocation_policy,
        device: bundle.surface.device,
        accountLabel: bundle.surface.account_label,
        evidenceSha256: itemSha256,
        captureReference: capture.capture_reference,
      },
      observation: {
        engine: bundle.surface.engine,
        provenance:
          `consumer_web:${bundle.surface.provider}:${bundle.surface.product_surface}:` +
          bundle.surface.collection_mode,
        fidelity:
          retrievalUsed === true || citations.length > 0 ? "web_grounded" : "weights_only",
        modelVersion: capture.model_version,
        answerText: capture.answer_text,
        citations,
        raw: {
          evidence_schema: bundle.schema_version,
          evidence_sha256: itemSha256,
          screenshot_sha256: capture.screenshot_sha256 ?? null,
          capture_reference: capture.capture_reference ?? null,
        },
        interpretation: {
          retrievalUsed,
          surfacePresent: true,
          extractionStatus: citations.length ? "extracted" : "no_extraction",
        },
      },
    });
  }

  finishRun(db, runId, 0);
  return {
    runId,
    engine: bundle.surface.engine,
    observations: prepared.length,
    bundleSha256,
    locationStatus: status,
  };
}
