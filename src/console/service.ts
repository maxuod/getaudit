import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Ledger } from "../db/index.ts";
import { inTransaction, readJsonArray } from "../db/index.ts";
import {
  createBrand,
  createPromptSet,
  addPrompts,
  freezePromptSet,
  getBrand,
  getPromptSet,
  listPrompts,
  listRuns,
  startRun,
  recordObservation,
  PARSER_VERSION,
} from "../ledger/repo.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
import { mentionsBrand } from "../lib/brand-match.ts";
import { inspectExperimentReadiness } from "../experiment/readiness.ts";
import { ALL_ENGINES } from "../engines/index.ts";
import {
  captureSchema,
  planSchema,
  surfaces,
  id,
} from "./contracts.ts";
import type { PlanConfig, Capture, CaptureRecord } from "./contracts.ts";
import {migrateSlotRepetitions} from './slot-migration.ts';
import {normalizeDomain} from '../lib/url.ts';
import { assessCapture, AUTO_QUALITY_VERSION } from './auto-quality.ts';
import type { QualityContext } from './auto-quality.ts';
import { normalizeSourceUrl } from './sources.ts';

const brandFields = z
      .object({
        name: z.string().trim().min(1).max(120),
        ownedDomains: z
          .array(
            z
              .string()
              .trim()
              .toLowerCase()
              .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/),
          )
          .min(1)
          .max(20),
        aliases: z.array(z.string().trim().min(1).max(120)).max(20),
        category: z.string().max(200).optional(),
      })
      .strict();

type Row = {
  id: string;
  prompt_id: string;
  prompt: string;
  engine: string;
  observed_at: string;
  answer_text: string;
  model_version: string | null;
  error_message: string | null;
  brand_mentioned: number;
  product_surface: string | null;
  collection_mode: string | null;
};
type PlanRow = {
  id: string;
  prompt_set_id: string;
  run_id: string;
  label: string;
  config_json: string;
  config_hash: string;
  created_at: string;
};
type Slot = {
  id: string;
  plan_id: string;
  prompt_id: string;
  surface: keyof typeof surfaces;
  window: string;
  run_idx: number;
};
type AttemptRow = {
  id: string;
  slot_id: string;
  sequence: number;
  capture_json: string;
  capture_hash: string;
  artifact_hash: string | null;
  created_at: string;
};
const trustedBrowserCaptureContextSchema = z.object({
  jobId: z.string().uuid(),
  itemId: z.string().uuid(),
}).strict();
/** Internal queue identity, never accepted from the capture API payload. */
export type TrustedBrowserCaptureContext = z.infer<typeof trustedBrowserCaptureContextSchema>;
export class LabService {
  readonly db: Ledger;
  constructor(db: Ledger) {
    this.db = db;
    migrateSlotRepetitions(db);
    db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    for (const table of [
      "console_plan",
      "console_slot",
      "console_artifact",
      "console_attempt",
      "console_review",
      "console_restriction",
      "console_question_source",
      "console_command",
      "console_brand_change",
      "console_question_document",
      "console_question_candidate",
      "console_question_evidence",
      "console_question_scan",
      "console_question_candidate_prompt",
    ]) {
      for (const action of ["UPDATE", "DELETE"])
        db.exec(
          `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Console 证据不可修改'); END`,
        );
    }
  }
  command<T>(requestId: string, kind: string, input: unknown, fn: () => T): T {
    id.parse(requestId);
    const fingerprint = sha256(canonicalJson({ kind, input }));
    return inTransaction(this.db, () => {
      const prev = this.db
        .prepare("SELECT * FROM console_command WHERE id=?")
        .get(requestId) as { fingerprint: string; result: string } | undefined;
      if (prev) {
        if (prev.fingerprint !== fingerprint)
          throw new Error("请求标识已被另一操作使用");
        return JSON.parse(prev.result) as T;
      }
      const result = fn();
      this.db
        .prepare("INSERT INTO console_command VALUES(?,?,?)")
        .run(requestId, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  createBrand(requestId: string, input: unknown) {
    const c = brandFields.parse(input);
    return this.command(requestId, "brand", c, () => ({
      id: createBrand(this.db, c),
    }));
  }
  brandProfile(brandId: string) {
    const brand = getBrand(this.db, id.parse(brandId));
    const latest = this.db.prepare("SELECT id,action,created_at FROM console_brand_change WHERE brand_id=? ORDER BY rowid DESC LIMIT 1").get(brandId) as {id:string;action:string;created_at:string}|undefined;
    const count = (sql: string) => Number((this.db.prepare(sql).get(brandId) as {n:number}).n);
    return {...brand, version:sha256(canonicalJson({brand,eventId:latest?.id??null})), deletedAt:latest?.action==="delete"?latest.created_at:null,
      setCount:count("SELECT COUNT(*) n FROM prompt_set WHERE brand_id=?"),
      planCount:count("SELECT COUNT(*) n FROM console_plan p JOIN prompt_set s ON s.id=p.prompt_set_id WHERE s.brand_id=?"),
      observationCount:count("SELECT COUNT(DISTINCT o.id) n FROM observation o JOIN prompt p ON p.id=o.prompt_id JOIN prompt_set s ON s.id=p.prompt_set_id WHERE s.brand_id=?")};
  }
  assertBrandActive(brandId: string) {
    if(this.brandProfile(brandId).deletedAt)throw new Error("项目已删除，请先在品牌与项目中恢复");
  }
  assertSetActive(setId: string) {
    const set=getPromptSet(this.db,setId);this.assertBrandActive(set.brand_id);return set;
  }
  private assertBrandIdle(brandId: string) {
    const tables=[
      ["console_api_job","SELECT 1 FROM console_api_job j JOIN prompt_set s ON s.id=j.prompt_set_id WHERE s.brand_id=? AND j.status IN ('running','queued') LIMIT 1"],
      ["console_browser_job","SELECT 1 FROM console_browser_job j JOIN console_plan p ON p.id=j.plan_id JOIN prompt_set s ON s.id=p.prompt_set_id WHERE s.brand_id=? AND j.status IN ('running','pausing','queued') LIMIT 1"],
      ["console_ai_job","SELECT 1 FROM console_ai_job j JOIN console_plan p ON p.id=j.plan_id JOIN prompt_set s ON s.id=p.prompt_set_id WHERE s.brand_id=? AND j.status='running' LIMIT 1"],
    ];
    for(const [table,sql] of tables)if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table!)&&this.db.prepare(sql!).get(brandId))
      throw new Error("此项目仍有任务运行，请暂停并等待当前任务结束后再编辑或删除");
  }
  changeBrand(requestId: string, action: "edit"|"delete"|"restore", input: unknown) {
    const identity=z.object({id,version:z.string().regex(/^[a-f0-9]{64}$/)});
    const c=(action==="edit"?identity.extend(brandFields.shape):identity).strict().parse(input);
    return this.command(requestId,"brand-"+action,c,()=>{
      const before=this.brandProfile(c.id);
      if(before.version!==c.version)throw new Error("品牌已被修改，请刷新后重新操作");
      if(action==="restore"?!before.deletedAt:!!before.deletedAt)throw new Error(action==="restore"?"项目不在已删除列表中":"项目已删除，请先恢复");
      this.assertBrandIdle(c.id);
      if(action==="edit"){
        const fields=brandFields.strip().parse(c);
        this.db.prepare("UPDATE brand SET name=?,owned_domains=?,aliases=?,category=? WHERE id=?")
          .run(fields.name,canonicalJson(fields.ownedDomains),canonicalJson(fields.aliases),fields.category?.trim()||null,c.id);
      }
      this.db.prepare("INSERT INTO console_brand_change(id,brand_id,action,before_json,after_json) VALUES(?,?,?,?,?)")
        .run(randomUUID(),c.id,action,canonicalJson(before),canonicalJson(getBrand(this.db,c.id)));
      return {id:c.id,action,version:this.brandProfile(c.id).version};
    });
  }
  createSet(requestId: string, input: unknown) {
    const c = z
      .object({
        brandId: id,
        label: z.string().trim().min(1).max(160),
        locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
        source: z.string().trim().min(1).max(300),
        kind: z.enum(["business", "hypothesis", "ai_draft"]),
        prompts: z
          .array(
            z
              .object({
                text: z.string().trim().min(1).max(3000),
                intent: z.enum(["discovery", "branded"]),
              })
              .strict(),
          )
          .min(1)
          .max(500),
      })
      .strict()
      .parse(input);
    this.assertBrandActive(c.brandId);
    return this.command(requestId, "set", c, () => {
      const setId = createPromptSet(this.db, {
        brandId: c.brandId,
        label: c.label,
        note: c.source,
      });
      addPrompts(
        this.db,
        setId,
        c.prompts.map((p) => ({ ...p, locale: c.locale })),
      );
      for (const p of listPrompts(this.db, setId))
        this.db
          .prepare("INSERT INTO console_question_source VALUES(?,?,?)")
          .run(p.id, c.source, c.kind);
      return { id: setId };
    });
  }
  freeze(requestId: string, setId: string) {
    return this.command(requestId, "freeze", { setId }, () => {
      this.assertSetActive(setId);return {hash: freezePromptSet(this.db, setId)};
    });
  }
  createPlan(requestId: string, input: unknown) {
    const c = planSchema.parse(input),
      set = this.assertSetActive(c.promptSetId),
      prompts = listPrompts(this.db, c.promptSetId);
    if (!set.frozen_at) throw new Error("请先冻结问题集");
    if (prompts.some((p) => p.locale !== c.locale))
      throw new Error("计划语言必须与全部冻结问题一致");
    if (prompts.length * c.surfaces.length * c.windows.length * (c.repetitions??1) > 5000)
      throw new Error("单计划最多 5000 个采样位置");
    return this.command(requestId, "plan", c, () => {
      const planId = randomUUID(),
        config = canonicalJson({
          ...c,
          brandSnapshot: getBrand(this.db, set.brand_id),
        });
      const runId = startRun(this.db, {
        promptSetId: c.promptSetId,
        phase: "baseline",
        runsPerPrompt: c.windows.length * (c.repetitions??1),
        note: `Console consumer-web v2 / ${planId}. Terminal denominators: console_slot; descriptive only.`,
      });
      this.db
        .prepare(
          "INSERT INTO console_plan(id,prompt_set_id,run_id,label,config_json,config_hash) VALUES(?,?,?,?,?,?)",
        )
        .run(planId, c.promptSetId, runId, c.label, config, sha256(config));
      for (const p of prompts)
        for (const s of c.surfaces)
          for (const [i, w] of c.windows.entries())
            for(let repeat=1;repeat<=(c.repetitions??1);repeat++)
            this.db
              .prepare("INSERT INTO console_slot VALUES(?,?,?,?,?,?)")
              .run(randomUUID(), planId, p.id, s, w, i * (c.repetitions??1) + repeat);
      return { id: planId };
    });
  }
  planRow(planId: string): PlanRow {
    const p = this.db
      .prepare("SELECT * FROM console_plan WHERE id=?")
      .get(id.parse(planId)) as PlanRow | undefined;
    if (!p) throw new Error("采样计划不存在");
    return p;
  }
  brandForPlan(plan: PlanRow) {
    const snapshot = (
      JSON.parse(plan.config_json) as {
        brandSnapshot?: ReturnType<typeof getBrand>;
      }
    ).brandSnapshot;
    return (
      snapshot ??
      getBrand(this.db, getPromptSet(this.db, plan.prompt_set_id).brand_id)
    );
  }
  slot(slotId: string): Slot {
    const s = this.db
      .prepare("SELECT * FROM console_slot WHERE id=?")
      .get(id.parse(slotId)) as Slot | undefined;
    if (!s) throw new Error("采样位置不存在");
    return s;
  }
  restriction(scope: string) {
    return this.db
      .prepare(
        "SELECT * FROM console_restriction WHERE scope=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(scope) as { action: string; reason: string } | undefined;
  }
  scope(slot: Slot) {
    const p = JSON.parse(this.planRow(slot.plan_id).config_json) as PlanConfig;
    return p.accountMode==='isolated'?`${slot.surface}:${p.country}:isolated:${slot.plan_id}`:`${slot.surface}:${p.country}:signed-out`;
  }
  release(requestId: string, input: unknown) {
    const c = z
      .object({
        scope: z
          .string()
          .regex(new RegExp('^('+Object.keys(surfaces).join('|')+'):[A-Z]{2}:(signed-out|isolated(?::[a-f0-9-]{36})?)$')),
        reason: z.string().trim().min(15).max(1000),
      })
      .strict()
      .parse(input);
    return this.command(requestId, "release", c, () => {
      this.db
        .prepare(
          "INSERT INTO console_restriction(id,scope,action,reason) VALUES(?,?,?,?)",
        )
        .run(randomUUID(), c.scope, "release", c.reason);
      return { ok: true };
    });
  }
  private mayPreserveCrossWindowBrowserCapture(c: Capture, slot: Slot, config: PlanConfig, context: TrustedBrowserCaptureContext) {
    if (c.collectionMode !== "browser_capture") return false;
    const tables = this.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('console_browser_item','console_browser_job')").get() as {n:number};
    if (tables.n !== 2) return false;
    const row = this.db.prepare(`SELECT i.started_at,j.config_json FROM console_browser_item i
      JOIN console_browser_job j ON j.id=i.job_id
      WHERE i.id=? AND i.job_id=? AND i.slot_id=? AND j.plan_id=?
        AND i.state='running' AND i.stage='capturing' AND i.attempt_id IS NULL
        AND j.status IN ('running','pausing')
        AND NOT EXISTS (SELECT 1 FROM console_attempt a WHERE a.slot_id=i.slot_id)
        AND NOT EXISTS (SELECT 1 FROM console_browser_continuation link WHERE link.source_item_id=i.id)`)
      .get(context.itemId, context.jobId, slot.id, slot.plan_id) as {started_at:string|null;config_json:string}|undefined;
    if (!row?.started_at) return false;
    try {
      if (JSON.parse(row.config_json)?.planId !== slot.plan_id) return false;
      // SQLite datetime('now') is UTC but omits its zone; never parse it as local time.
      const startedAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.started_at)
        ? row.started_at.replace(" ", "T") + "Z" : row.started_at;
      if (!z.iso.datetime({offset:true}).safeParse(startedAt).success) return false;
      const started = Date.parse(startedAt);
      return Number.isFinite(started) && Date.parse(c.observedAt) >= started &&
        new Intl.DateTimeFormat("en-CA", {timeZone:config.timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(started)) === slot.window;
    } catch { return false; }
  }
  capture(requestId: string, input: unknown, trustedBrowserContext?: TrustedBrowserCaptureContext) {
    const c = captureSchema.parse(input),
      s = this.slot(c.slotId),
      p = this.planRow(s.plan_id),
      config = JSON.parse(p.config_json) as PlanConfig;
    this.assertSetActive(p.prompt_set_id);
    const prompt = listPrompts(this.db, p.prompt_set_id).find(
      (q) => q.id === s.prompt_id,
    )!;
    if (c.prompt !== prompt.text)
      throw new Error("问题原文必须与冻结版本逐字一致");
    if (c.status === "not_triggered" && !["google_aio", "duckduckgo_search_assist"].includes(s.surface))
      throw new Error("Not triggered applies only to consumer search AI features.");
    const context = trustedBrowserContext === undefined ? undefined : trustedBrowserCaptureContextSchema.parse(trustedBrowserContext);
    const outsideWindow =
      c.status !== "cancelled" &&
      new Intl.DateTimeFormat("en-CA", {
        timeZone: config.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(c.observedAt)) !== s.window;
    if (outsideWindow && !context)
      throw new Error("观测时间不在计划窗口内");
    return this.command(requestId, "capture", c, () => {
      // Preserve a response that finished after midnight only for the current
      // committed queue item. Its actual time remains excluded by automatic quality.
      if (outsideWindow && (!context || !this.mayPreserveCrossWindowBrowserCapture(c, s, config, context)))
        throw new Error("观测时间不在计划窗口内；未确认本次在途浏览器请求");
      if (
        this.restriction(this.scope(s))?.action === "stop" &&
        c.status !== "cancelled"
      )
        throw new Error("此入口有未解除的访问限制，请先记录已变化的允许条件");
      const last = this.db
        .prepare(
          `SELECT a.*,r.decision FROM console_attempt a LEFT JOIN console_review r ON r.attempt_id=a.id WHERE slot_id=? ORDER BY sequence DESC LIMIT 1`,
        )
        .get(s.id) as (AttemptRow & { decision: string | null }) | undefined;
      if (last) {
        if (!this.attempt(last).quality.retryable)
          throw new Error("此位置已有已完成证据，不能替换答案");
        if (last.sequence >= 3) throw new Error("此位置已达到三次尝试上限");
      }
      let artifactHash: string | null = null;
      if (c.artifact) {
        const bytes = Buffer.from(c.artifact.base64, "base64");
        if (
          !bytes.length ||
          bytes.length > 4 * 1024 * 1024 ||
          bytes.toString("base64") !== c.artifact.base64
        )
          throw new Error("证据文件无效或超过 4 MB");
        const mime = c.artifact.mime;
        if (
          (mime === "image/png" &&
            bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") ||
          (mime === "image/jpeg" &&
            bytes.subarray(0, 3).toString("hex") !== "ffd8ff") ||
          (mime === "image/webp" &&
            !(
              bytes.subarray(0, 4).toString() === "RIFF" &&
              bytes.subarray(8, 12).toString() === "WEBP"
            ))
        )
          throw new Error("文件内容与图片类型不符");
        artifactHash = createHash("sha256").update(bytes).digest("hex");
        this.db
          .prepare("INSERT OR IGNORE INTO console_artifact VALUES(?,?,?)")
          .run(artifactHash, mime, bytes);
      }
      const { artifact: _, ...fields } = c,
        record = { ...fields, artifactHash },
        json = canonicalJson(record),
        attemptId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO console_attempt(id,slot_id,sequence,capture_json,capture_hash,artifact_hash) VALUES(?,?,?,?,?,?)",
        )
        .run(
          attemptId,
          s.id,
          (last?.sequence ?? 0) + 1,
          json,
          sha256(json),
          artifactHash,
        );
      if (c.status === "unavailable")
        this.db
          .prepare(
            "INSERT INTO console_restriction(id,scope,action,reason,attempt_id) VALUES(?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            this.scope(s),
            "stop",
            `${c.restriction}: ${c.reason}`,
            attemptId,
          );
      return { id: attemptId };
    });
  }
  artifact(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("文件标识无效");
    const row = this.db
      .prepare("SELECT * FROM console_artifact WHERE hash=?")
      .get(hash) as
      { hash: string; mime: string; bytes: Uint8Array } | undefined;
    if (!row || createHash("sha256").update(row.bytes).digest("hex") !== hash)
      throw new Error("证据缺失或哈希不匹配");
    return row;
  }
  private qualityContext(p: PlanRow, s: Slot, prompts = listPrompts(this.db, p.prompt_set_id)): QualityContext {
    const config = JSON.parse(p.config_json) as PlanConfig, set = getPromptSet(this.db, p.prompt_set_id);
    const integrityIssues: string[] = [];
    if (sha256(p.config_json) !== p.config_hash) integrityIssues.push("计划配置哈希不匹配");
    if (!set.frozen_at || !set.frozen_hash || sha256(prompts.map(q => q.text).sort().join("\n")) !== set.frozen_hash)
      integrityIssues.push("冻结问题集完整性检查失败");
    if (config.promptSetId !== p.prompt_set_id || !config.surfaces.includes(s.surface) || !config.windows.includes(s.window))
      integrityIssues.push("采样位置与计划配置不符");
    const prompt = prompts.find(q => q.id === s.prompt_id);
    if (!prompt) integrityIssues.push("计划中的冻结问题缺失");
    return { config, configHash: p.config_hash, frozenHash: set.frozen_hash, prompt: prompt?.text ?? "", slotId: s.id, surface: s.surface, window: s.window, integrityIssues };
  }
  attempt(row: AttemptRow, suppliedContext?: QualityContext) {
    const s = suppliedContext ? null : this.slot(row.slot_id), context = suppliedContext ?? this.qualityContext(this.planRow(s!.plan_id), s!);
    let capture: CaptureRecord, readError: string | null = null;
    let integrity = sha256(row.capture_json) === row.capture_hash;
    try {
      capture = JSON.parse(row.capture_json) as CaptureRecord;
      // Structural damage must exclude only this attempt, not crash all results.
      if (!capture || typeof capture !== "object" || typeof capture.answer !== "string" || !Array.isArray(capture.citations)) throw new Error("invalid capture");
    } catch {
      integrity = false; readError = "保存的采集原文无法解析，已保留原始字节并排除此记录";
      capture = { slotId: row.slot_id, prompt: context.prompt, status: "error", reason: readError, restriction: "none", observedAt: `${context.window}T00:00:00Z`, answer: "", citations: [], model: "unknown", account: "unknown", session: "unknown", exitCountry: null, geo: "unverified", locale: context.config.locale, timezone: context.config.timezone, device: "unknown", geolocation: "unknown", searchMode: "unknown", collectionMode: "manual_capture", retrievalUsed: null, artifactHash: row.artifact_hash };
    }
    if (row.artifact_hash !== capture.artifactHash) integrity = false;
    try {
      if (row.artifact_hash) this.artifact(row.artifact_hash);
    } catch {
      integrity = false;
    }
    const review = this.db
      .prepare("SELECT * FROM console_review WHERE attempt_id=?")
      .get(row.id) as
      | { decision: string; note: string; observation_id: string | null }
      | undefined;
    return {
      id: row.id,
      sequence: row.sequence,
      hash: row.capture_hash,
      capture,
      integrity,
      readError,
      review: review ?? null,
      quality: assessCapture({ capture, captureHash: row.capture_hash, integrity, context, manualDecision: review?.decision }),
    };
  }
  review(requestId: string, input: unknown) {
    const c = z
      .object({
        attemptId: id,
        decision: z.enum(["accept", "reject"]),
        note: z.string().trim().min(1).max(1500),
        privacyReviewed: z.literal(true),
      })
      .strict()
      .parse(input);
    return this.command(requestId, "review", c, () => {
      const row = this.db
        .prepare("SELECT * FROM console_attempt WHERE id=?")
        .get(c.attemptId) as AttemptRow | undefined;
      if (!row) throw new Error("证据不存在");
      const a = this.attempt(row),
        s = this.slot(row.slot_id),
        p = this.planRow(s.plan_id),
        set = this.assertSetActive(p.prompt_set_id),
        brand = this.brandForPlan(p),
        conf = JSON.parse(p.config_json) as PlanConfig;
      if (a.review) throw new Error("此证据已复核");
      if (c.decision === "accept" && !a.integrity)
        throw new Error("证据完整性检查失败");
      let observationId: string | null = null;
      if (c.decision === "accept" && a.capture.status === "observed") {
        const v = a.capture,
          surface = surfaces[s.surface];
        observationId = recordObservation(this.db, {
          runId: p.run_id,
          promptId: s.prompt_id,
          runIdx: s.run_idx,
          observedAt: v.observedAt,
          brand,
          locale: v.locale,
          observation: {
            engine: `consumer_web_${s.surface}`,
            provenance: `Console v2 / ${v.collectionMode} / ${a.id}`,
            fidelity: v.citations.length ? "web_grounded" : "weights_only",
            modelVersion: v.model === "unknown" ? undefined : v.model,
            answerText: v.answer,
            citations: v.citations,
            raw: { attempt_id: a.id, capture_hash: a.hash },
            interpretation: {
              retrievalUsed: v.retrievalUsed ?? undefined,
              surfacePresent: true,
              extractionStatus: v.citations.length
                ? "extracted"
                : "no_extraction",
            },
          },
          surfaceContext: {
            surfaceClass: "consumer_web",
            provider: surface.provider,
            productSurface: surface.name,
            collectionMode: v.collectionMode === "browser_capture" ? "browser_automation" : "manual_capture",
            accountState: v.account,
            personalizationState: v.privacy?.personalization === "enabled" ? "active" : v.privacy?.personalization ?? v.session,
            searchMode: v.searchMode,
            targetCountry: conf.country,
            exitCountry: v.exitCountry ?? undefined,
            geoVerification: v.geo,
            locationStatus:
              v.geo === "ip_observed"
                ? v.exitCountry === conf.country
                  ? "matched"
                  : "mismatched"
                : "unverified",
            browserLocale: v.locale,
            timezoneId: v.timezone,
            geolocationPolicy: v.geolocation,
            device: v.device,
            evidenceSha256: a.hash,
            captureReference: `console-artifact:${v.artifactHash}`,
          },
        });
      }
      this.db
        .prepare(
          "INSERT INTO console_review(attempt_id,decision,note,observation_id) VALUES(?,?,?,?)",
        )
        .run(c.attemptId, c.decision, c.note, observationId);
      return { observationId };
    });
  }
  plan(planId: string) {
    const p = this.planRow(planId),
      config = JSON.parse(p.config_json) as PlanConfig,
      prompts = listPrompts(this.db, p.prompt_set_id);
    const continuations=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='console_browser_continuation'").get()
      ? this.db.prepare(`SELECT source.slot_id sourceSlotId,target.slot_id slotId,s.plan_id planId,s.window
          FROM console_browser_continuation c JOIN console_browser_item source ON source.id=c.source_item_id
          JOIN console_browser_item target ON target.id=c.target_item_id JOIN console_slot s ON s.id=target.slot_id
          JOIN console_slot old ON old.id=source.slot_id WHERE old.plan_id=?`).all(planId) as {sourceSlotId:string;slotId:string;planId:string;window:string}[]
      : [];
    const slots = (
      this.db
        .prepare(
          "SELECT s.* FROM console_slot s JOIN prompt p ON p.id=s.prompt_id WHERE s.plan_id=? ORDER BY s.window,s.run_idx,p.text,s.surface",
        )
        .all(planId) as Slot[]
    ).map((s) => {
      const attempts = (
        this.db
          .prepare(
            "SELECT * FROM console_attempt WHERE slot_id=? ORDER BY sequence",
          )
          .all(s.id) as AttemptRow[]
      ).map((a) => this.attempt(a, this.qualityContext(p, s, prompts)));
      const latest = attempts.at(-1) ?? null;
      const issues = latest?.quality.conditionIssues ?? [];
      return {
        ...s,
        prompt: prompts.find((p) => p.id === s.prompt_id)!.text,
        attempts,
        latest,
        continuation:continuations.find(c=>c.sourceSlotId===s.id)??null,
        issues,
        restriction: this.restriction(this.scope(s)) ?? null,
        scope: this.scope(s),
      };
    });
    return { ...p, config, slots };
  }
  state(setId?: string) {
    const profiles=(this.db.prepare("SELECT id FROM brand ORDER BY created_at").all() as {id:string}[]).map(b=>this.brandProfile(b.id));
    const brands=profiles.filter(b=>!b.deletedAt),deletedBrands=profiles.filter(b=>b.deletedAt);
    const activeIds=new Set(brands.map(b=>b.id));
    const sets = this.db
      .prepare(
        "SELECT s.*,COUNT(p.id) prompt_count FROM prompt_set s LEFT JOIN prompt p ON p.prompt_set_id=s.id GROUP BY s.id ORDER BY s.created_at DESC",
      )
      .all().filter(s=>activeIds.has(String(s.brand_id)));
    if (setId && !activeIds.has(getPromptSet(this.db, setId).brand_id)) setId=undefined;
    return {
      brands,
      deletedBrands,
      sets,
      selectedSetId: setId ?? null,
      prompts: setId
        ? this.db
            .prepare(
              "SELECT p.*,q.source,q.kind FROM prompt p LEFT JOIN console_question_source q ON q.prompt_id=p.id WHERE p.prompt_set_id=? ORDER BY p.text",
            )
            .all(setId)
        : [],
      runs: setId ? listRuns(this.db, setId) : [],
      plans: setId
        ? (
            this.db
              .prepare(
                "SELECT id FROM console_plan WHERE prompt_set_id=? ORDER BY created_at DESC",
              )
              .all(setId) as { id: string }[]
          ).map((p) => this.plan(p.id))
        : [],
      engines: ALL_ENGINES.map((e) => ({
        name: e.name,
        configured: e.isConfigured(),
        config: e.getRunConfig?.() ?? {},
      })),
      readiness: setId
        ? inspectExperimentReadiness(this.db, {
            promptSetId: setId,
            parserVersion: PARSER_VERSION,
          })
        : null,
    };
  }
  observations(runId: string) {
    id.parse(runId);
    const run = this.db
      .prepare("SELECT * FROM collection_run WHERE id=?")
      .get(runId);
    if (!run) throw new Error("轮次不存在");
    const rows = this.db
      .prepare(
        "SELECT o.id,o.prompt_id,p.text prompt,o.engine,o.observed_at,o.answer_text,o.model_version,o.error_message,o.brand_mentioned,s.product_surface,s.collection_mode FROM observation o JOIN prompt p ON p.id=o.prompt_id LEFT JOIN observation_surface_context s ON s.observation_id=o.id WHERE o.run_id=? ORDER BY o.observed_at LIMIT 1000",
      )
      .all(runId) as Row[];
    return {
      run,
      total: (
        this.db
          .prepare("SELECT COUNT(*) n FROM observation WHERE run_id=?")
          .get(runId) as { n: number }
      ).n,
      rows: rows.map((o) => ({
        ...o,
        citations: this.db
          .prepare(
            "SELECT url,title,ownership FROM citation WHERE observation_id=? ORDER BY position",
          )
          .all(o.id as string),
      })),
    };
  }
  report(planId: string) {
    const plan = this.plan(planId),
      set = getPromptSet(this.db, plan.prompt_set_id),
      brand = this.brandForPlan(plan);
    const groups = plan.config.surfaces.map((surface) => {
      const slots = plan.slots.filter((s) => s.surface === surface),
        checked = slots.filter(s => !!s.latest),
        answers = slots.filter(s => s.latest?.quality.contentQualified),
        eligible = answers.filter(s => s.latest!.quality.metricEligible);
      const hasBrand = (s: typeof slots[number]) => mentionsBrand(s.latest!.capture.answer, [brand.name, ...readJsonArray(brand.aliases)]);
      const hasOwnedCitation = (s: typeof slots[number]) => s.latest!.capture.citations.some(c => {
        const host = normalizeDomain(normalizeSourceUrl(c.url) ?? c.url);
        return readJsonArray(brand.owned_domains).some(d => host === normalizeDomain(d) || host.endsWith("." + normalizeDomain(d)));
      });
      return {
        surface,
        label: surfaces[surface].name,
        planned: slots.length,
        reviewed: checked.filter(s => s.latest?.review?.decision === "accept" && s.latest.integrity).length,
        manualReviewed: checked.filter(s => !!s.latest?.review).length,
        autoChecked: checked.length,
        autoExcluded: checked.filter(s => !s.latest!.quality.metricEligible).length,
        contentExcluded: checked.filter(s => s.latest!.capture.status === "observed" && !s.latest!.quality.contentQualified).length,
        conditionMismatched: answers.filter(s => !s.latest!.quality.metricEligible).length,
        contentQualified: answers.length,
        candidateDenominator: answers.length,
        candidateBrandMentions: answers.filter(hasBrand).length,
        candidateOwnedCitations: answers.filter(hasOwnedCitation).length,
        observed: answers.length,
        eligible: eligible.length,
        brandMentions: eligible.filter(hasBrand).length,
        ownedCitations: eligible.filter(hasOwnedCitation).length,
        notTriggered: checked.filter(
          (s) => s.latest!.capture.status === "not_triggered",
        ).length,
        unavailable: checked.filter(
          (s) => s.latest!.capture.status === "unavailable",
        ).length,
        errors: checked.filter((s) => s.latest!.capture.status === "error")
          .length,
        cancelled: checked.filter(
          (s) => s.latest!.capture.status === "cancelled",
        ).length,
        pending: slots.length - checked.length,
        restrictedUnexecuted: slots.filter(s => !s.latest && s.restriction?.action === "stop").length,
      };
    });
    return {
      schema: "console-descriptive-report-v2",
      planId,
      brand: brand.name,
      label: plan.label,
      promptSetId: set.id,
      frozenHash: set.frozen_hash,
      qualityPolicy: { evaluatorVersion: AUTO_QUALITY_VERSION, mode: "automatic", humanReviewRequired: false, verifiesAnswerTruth: false, metricDenominator: "content_and_conditions_matched", candidateDenominator: "content_qualified_only" },
      config: plan.config,
      groups,
      scope:
        (plan.config.accountMode === "signed_in_private" ? "登录态独立临时采样，与未登录基线分开统计。" : plan.config.accountMode==="isolated"?"独立无痕会话，按平台优先未登录、确需时使用专用登录；实际账号状态逐条保留。":"") + "仅描述这些固定问题、入口和时间窗口；不代表用户总体、因果提升或转化。自动内容筛查基于正文与引用完整性通过的答案；正式品牌指标进一步要求地区、账号、语言、时间和设备等采样条件匹配。自动质检只验证采集质量，不验证答案事实；无需人工复核，可选人工拒绝会排除记录。",
      records: plan.slots.map((s) => ({
        slotId: s.id,
        prompt: s.prompt,
        surface: s.surface,
        window: s.window,
        attemptCount: s.attempts.length,
        attempts: s.attempts.map((a) => ({
          id: a.id,
          sequence: a.sequence,
          status: a.capture.status,
          reason: a.capture.reason,
          observedAt: a.capture.observedAt,
          integrity: a.integrity,
          decision: a.quality.effectiveDecision,
          manualDecision: a.review?.decision ?? null,
          quality: a.quality,
          readError: a.readError,
          evidenceHash: a.hash,
        })),
        conditions: s.latest
          ? {
              observedAt: s.latest.capture.observedAt,
              model: s.latest.capture.model,
              account: s.latest.capture.account,
              session: s.latest.capture.session,
              ...(s.latest.capture.privacy ? { privacy: s.latest.capture.privacy } : {}),
              exitCountry: s.latest.capture.exitCountry,
              geo: s.latest.capture.geo,
              locale: s.latest.capture.locale,
              timezone: s.latest.capture.timezone,
              device: s.latest.capture.device,
              geolocation: s.latest.capture.geolocation,
              searchMode: s.latest.capture.searchMode,
              collectionMode: s.latest.capture.collectionMode,
              artifactHash: s.latest.capture.artifactHash,
              // Session paths and challenge query strings are private; only
              // expose the provider origin in derived report data.
              sourceUrl: (() => { try { return s.latest.capture.sourceUrl ? new URL(s.latest.capture.sourceUrl).origin : null; } catch { return null; } })(),
              sessionRef: s.latest.capture.sessionRef ?? null,
            }
          : null,
        status: s.latest?.capture.status ?? "pending",
        decision: s.latest?.quality.effectiveDecision ?? "unexecuted",
        manualDecision: s.latest?.review?.decision ?? null,
        quality: s.latest?.quality ?? null,
        restriction: s.restriction,
        exclusionReasons: s.latest ? s.latest.quality.reasons : ["尚未执行或保存采集记录", ...(s.restriction?.action === "stop" ? [`入口限制未解除：${s.restriction.reason}`] : [])],
        integrity: s.latest?.integrity ?? null,
        issues: s.issues,
        evidenceHash: s.latest?.hash ?? null,
        observationId: s.latest?.review?.observation_id ?? null,
        reviewNote:
          s.latest?.review?.decision === "accept" ? s.latest.review.note : null,
        answer:
          s.latest?.quality.contentQualified
            ? s.latest.capture.answer
            : null,
        citations:
          s.latest?.quality.contentQualified
            ? s.latest.capture.citations
            : [],
      })),
    };
  }
}
