import { createHash, randomUUID } from "node:crypto";
import type { Ledger } from "../db/index.ts";
import { inTransaction, readJsonArray, writeJsonArray } from "../db/index.ts";
import type { EngineObservation, ObservationSurfaceContext } from "../engines/types.ts";
import { domainFromUrl, isOwnedDomain } from "../lib/url.ts";
import { mentionsBrand } from "../lib/brand-match.ts";
import { inspectRunIntegrity } from "./run-integrity.ts";

export interface BrandRow {
  id: string;
  name: string;
  owned_domains: string;
  aliases: string;
  category: string | null;
}

export interface PromptRow {
  id: string;
  prompt_set_id: string;
  text: string;
  surface_guess: string;
  intent: string | null;
  locale: string;
}

export interface PromptSetRow {
  id: string;
  brand_id: string;
  label: string;
  frozen_at: string | null;
  frozen_hash: string | null;
}

export function createBrand(
  db: Ledger,
  input: { name: string; ownedDomains: string[]; aliases?: string[]; category?: string },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO brand (id, name, owned_domains, aliases, category)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    writeJsonArray(input.ownedDomains),
    writeJsonArray(input.aliases ?? [input.name]),
    input.category ?? null,
  );
  return id;
}

export function getBrand(db: Ledger, brandId: string): BrandRow {
  const row = db.prepare(`SELECT * FROM brand WHERE id = ?`).get(brandId) as BrandRow | undefined;
  if (!row) throw new Error(`品牌不存在: ${brandId}`);
  return row;
}

export function createPromptSet(
  db: Ledger,
  input: { brandId: string; label: string; note?: string },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO prompt_set (id, brand_id, label, note) VALUES (?, ?, ?, ?)`,
  ).run(id, input.brandId, input.label, input.note ?? null);
  return id;
}

export function addPrompts(
  db: Ledger,
  promptSetId: string,
  prompts: ReadonlyArray<{ text: string; intent?: string; locale?: string; surfaceGuess?: string }>,
): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO prompt (id, prompt_set_id, text, surface_guess, intent, locale)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  return inTransaction(db, () => {
    let added = 0;
    for (const row of prompts) {
      const text = row.text.trim();
      if (!text) continue;
      const result = insert.run(
        randomUUID(),
        promptSetId,
        text,
        row.surfaceGuess ?? "unknown",
        row.intent ?? null,
        row.locale ?? "en-US",
      );
      added += Number(result.changes);
    }
    return added;
  });
}

export function listPrompts(db: Ledger, promptSetId: string): PromptRow[] {
  return db
    .prepare(`SELECT * FROM prompt WHERE prompt_set_id = ? ORDER BY text`)
    .all(promptSetId) as unknown as PromptRow[];
}

export function getPromptSet(db: Ledger, promptSetId: string): PromptSetRow {
  const row = db.prepare(`SELECT * FROM prompt_set WHERE id = ?`).get(promptSetId) as
    | PromptSetRow
    | undefined;
  if (!row) throw new Error(`prompt 集不存在: ${promptSetId}`);
  return row;
}

/**
 * 冻结 prompt 集。
 *
 * hash 覆盖排序后的全部 prompt 文本 —— 任何增删改都会改变它。
 * 报告里公布这个 hash，等于把「我们没有事后挑选」这句话变成可验证的。
 */
export function freezePromptSet(db: Ledger, promptSetId: string): string {
  const set = getPromptSet(db, promptSetId);
  if (set.frozen_at) throw new Error(`prompt 集已于 ${set.frozen_at} 冻结，不可重复冻结`);

  const prompts = listPrompts(db, promptSetId);
  if (!prompts.length) throw new Error("空的 prompt 集不能冻结");

  const hash = createHash("sha256")
    .update(prompts.map((p) => p.text).sort().join("\n"))
    .digest("hex");

  db.prepare(`UPDATE prompt_set SET frozen_at = datetime('now'), frozen_hash = ? WHERE id = ?`)
    .run(hash, promptSetId);

  return hash;
}

export function startRun(
  db: Ledger,
  input: {
    promptSetId: string;
    phase: "baseline" | "followup";
    /** 有效采样次数（分引擎时取最大值），用于快速比较轮次密度 */
    runsPerPrompt: number;
    /** 完整采样配置，如 "default=0,perplexity_sonar=3"。审计链的一部分 */
    runsConfig?: string;
    /** 完整 canonical run 配置及其 sha256；续跑必须逐字匹配。 */
    configJson?: string;
    configHash?: string;
    note?: string;
  },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO collection_run
       (id, prompt_set_id, phase, runs_per_prompt, runs_config, config_json, config_hash, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.promptSetId,
    input.phase,
    input.runsPerPrompt,
    input.runsConfig ?? null,
    input.configJson ?? null,
    input.configHash ?? null,
    input.note ?? null,
  );
  return id;
}

export interface RunSummaryRow {
  id: string;
  phase: string;
  runs_per_prompt: number;
  runs_config: string | null;
  config_hash: string | null;
  started_at: string;
  finished_at: string | null;
  observations: number;
  /** 优先用采集时记录的花费（含兜底估算）；老轮次回退到 SUM(cost_usd) */
  cost_usd: number;
}

/** 列出某 prompt 集的所有采集轮次，用于找回中断的 run。 */
export function listRuns(db: Ledger, promptSetId: string): RunSummaryRow[] {
  return db
    .prepare(
      `SELECT r.id, r.phase, r.runs_per_prompt, r.runs_config, r.config_hash,
              r.started_at, r.finished_at,
              COUNT(o.id) AS observations,
              COALESCE(r.spent_usd, SUM(o.cost_usd), 0) AS cost_usd
       FROM collection_run r
       LEFT JOIN observation o ON o.run_id = r.id
       WHERE r.prompt_set_id = ?
       GROUP BY r.id
       ORDER BY r.started_at`,
    )
    .all(promptSetId) as unknown as RunSummaryRow[];
}

/** 列出某 run 已入账的观测标识，供续跑时跳过。 */
export function listRunObservationKeys(
  db: Ledger,
  runId: string,
): Array<{ prompt_id: string; engine: string; run_idx: number }> {
  return db
    .prepare(`SELECT prompt_id, engine, run_idx FROM observation WHERE run_id = ?`)
    .all(runId) as unknown as Array<{ prompt_id: string; engine: string; run_idx: number }>;
}

/** 结束轮次。spentUsd 含兜底估算 —— 直连引擎不报告成本，只靠 SUM 会漏。 */
export function finishRun(db: Ledger, runId: string, spentUsd?: number): void {
  const row = db
    .prepare(`SELECT config_json FROM collection_run WHERE id = ?`)
    .get(runId) as { config_json: string | null } | undefined;
  if (!row) throw new Error(`run 不存在：${runId}`);
  // 新版 canonical run 必须在封存前再次核对计划矩阵；旧版无 config 的历史/测试
  // run 仍可封存，但永远不能进入 formal manifest。
  if (row.config_json) {
    const integrity = inspectRunIntegrity(db, runId, { requireSealed: false });
    if (!integrity.valid) {
      throw new Error(`run 不完整，拒绝封存：${integrity.errors.join("；")}`);
    }
  }
  db.prepare(
    `UPDATE collection_run SET finished_at = datetime('now'),
            spent_usd = COALESCE(?, spent_usd) WHERE id = ?`,
  ).run(spentUsd ?? null, runId);
}

/** 部分轮次只更新累计成本，不封存；修复条件后可用同配置 resume。 */
export function updateRunSpend(db: Ledger, runId: string, spentUsd: number): void {
  db.prepare(`UPDATE collection_run SET spent_usd = ? WHERE id = ? AND finished_at IS NULL`).run(
    spentUsd,
    runId,
  );
}

/**
 * 写入一条观测及其引用。整体在事务里，避免出现「有观测没引用」的半截记录。
 * 注意：这里只 INSERT，永不 UPDATE —— 数据库触发器也会拦住任何修改企图。
 */
/**
 * 当前 parser 版本。改变解释逻辑时必须递增 ——
 * 旧版本的解释永久保留，历史报告才能复现。
 */
export const PARSER_VERSION = "v2-2026-08-09";

export function recordObservation(
  db: Ledger,
  input: {
    runId: string;
    promptId: string;
    runIdx: number;
    locale?: string;
    /** 网页手工捕获等外部证据的实际观测时间；API 采集缺省用数据库当前时间。 */
    observedAt?: string;
    brand: BrandRow;
    observation: EngineObservation;
    surfaceContext?: ObservationSurfaceContext;
  },
): string {
  const { observation, brand } = input;
  const observationId = randomUUID();

  const ownedDomains = readJsonArray(brand.owned_domains);
  const aliases = readJsonArray(brand.aliases);
  const names = aliases.length ? aliases : [brand.name];

  const insertObservation = db.prepare(
    `INSERT INTO observation
       (id, run_id, prompt_id, engine, run_idx, observed_at, provenance, fidelity,
        model_version, locale, raw_response, answer_text, brand_mentioned, cost_usd, error_message)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertCitation = db.prepare(
    `INSERT INTO citation (id, observation_id, position, url, domain, ownership, title, snippet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertInterpretation = db.prepare(
    `INSERT INTO observation_interpretation
       (observation_id, parser_version, retrieval_used, surface_present, extraction_status)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const insertSurfaceContext = db.prepare(
    `INSERT INTO observation_surface_context
       (observation_id, surface_class, provider, product_surface, collection_mode,
        account_state, personalization_state, search_mode, target_country, exit_country,
        geo_verification, location_status, browser_locale, timezone_id, geolocation_policy,
        device, account_label, evidence_sha256, capture_reference)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  inTransaction(db, () => {
    insertObservation.run(
      observationId,
      input.runId,
      input.promptId,
      observation.engine,
      input.runIdx,
      input.observedAt ?? null,
      observation.provenance,
      observation.fidelity,
      observation.modelVersion ?? null,
      input.locale ?? null,
      observation.raw === null ? null : JSON.stringify(observation.raw),
      observation.answerText || null,
      mentionsBrand(observation.answerText, names) ? 1 : 0,
      observation.costUsd ?? null,
      observation.errorMessage ?? null,
    );

    if (input.surfaceContext) {
      const context = input.surfaceContext;
      insertSurfaceContext.run(
        observationId,
        context.surfaceClass,
        context.provider,
        context.productSurface,
        context.collectionMode,
        context.accountState,
        context.personalizationState,
        context.searchMode,
        context.targetCountry,
        context.exitCountry ?? null,
        context.geoVerification,
        context.locationStatus,
        context.browserLocale,
        context.timezoneId,
        context.geolocationPolicy,
        context.device,
        context.accountLabel ?? null,
        context.evidenceSha256,
        context.captureReference ?? null,
      );
    }

    // 适配器没填时降级推断，并如实标注这是降级来源
    const interp = observation.interpretation ?? {
      retrievalUsed: observation.fidelity === "web_grounded" ? true : undefined,
      extractionStatus:
        observation.fidelity === "error"
          ? ("not_applicable" as const)
          : observation.citations.length > 0
            ? ("extracted" as const)
            : ("no_extraction" as const),
    };
    insertInterpretation.run(
      observationId,
      PARSER_VERSION,
      interp.retrievalUsed === undefined ? null : interp.retrievalUsed ? 1 : 0,
      interp.surfacePresent === undefined ? null : interp.surfacePresent ? 1 : 0,
      interp.extractionStatus,
    );

    observation.citations.forEach((citation, index) => {
      const domain = domainFromUrl(citation.url);
      if (!domain) return;
      insertCitation.run(
        randomUUID(),
        observationId,
        index + 1,
        citation.url,
        domain,
        isOwnedDomain(citation.url, ownedDomains) ? "owned" : "third_party",
        citation.title ?? null,
        citation.snippet ?? null,
      );
    });
  });

  return observationId;
}
