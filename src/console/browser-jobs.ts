import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { inTransaction } from "../db/index.ts";
import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
import { mentionsBrand } from "../lib/brand-match.ts";
import {normalizeDomain} from '../lib/url.ts';
import { startRun } from "../ledger/repo.ts";
import { surfaces,surface as surfaceSchema } from "./contracts.ts";
import type { Capture, PlanConfig, SourceRule } from "./contracts.ts";
import type { LabService } from "./service.ts";
import { normalizeSourceUrl } from "./sources.ts";

export type BrowserStage = "opening" | "preparing" | "submitting" | "waiting" | "capturing";
export type BrowserTask = {
  planId?: string; slotId: string; prompt: string; surface: keyof typeof surfaces;
  config: PlanConfig; timeoutSeconds: number;
  captureScreenshot?: boolean;
  browserMode?: 'silent' | 'visible';
  verifiedCountry: string | null; geoVerificationNote: string;
  confirmEgress?: (proof:{country:string;fingerprint:string;verifiedAt:string;provider:'cloudflare_trace'})=>void;
};
export type GuestReadinessObservation = {
  checkedAt: string; status: "ready" | "restricted" | "unknown";
  restriction: Capture["restriction"]; account: Capture["account"];
  sourceUrl: string; reason: string; answer: "not_tested"; citations: "not_tested";
  /** Actual adapter mode. Older observations omit this and remain unknown. */
  browserMode?: "silent" | "visible";
};
export type GuestReadinessTask = {
  planId: string; surface: keyof typeof surfaces; config: PlanConfig; browserMode: "silent" | "visible";
};
export interface BrowserCollector {
  available(): { available: boolean; message: string };
  collect(task: BrowserTask, signal: AbortSignal, stage: (value: BrowserStage) => void): Promise<Capture>;
  show(): Promise<void>;
  close(): Promise<void>;
  closePlanSessions?(planId:string): Promise<void>;
  prepareSession?(task: {planId:string;surface:keyof typeof surfaces;config:PlanConfig}): Promise<unknown>;
  verifySession?(planId:string,surface:keyof typeof surfaces): Promise<unknown>;
  sessions?(): {planId:string;surface:string;verified:boolean}[];
  ready?(planId:string,required:string[]): boolean;
  /** Fresh signed-out entry inspection only. Never submits a question or restores login preparation. */
  inspectGuest?(task: GuestReadinessTask, signal: AbortSignal): Promise<GuestReadinessObservation>;
}
export type GuestReadiness = {
  planId: string; accountMode: "signed_out"; samplingActive: boolean; inspectionActive: boolean;
  inspectionAvailable: boolean; note: string;
  platforms: {
    surface: keyof typeof surfaces; name: string; url: string; canCheck: boolean;
    restriction: PlatformLoginReadiness["restriction"];
    latest: (GuestReadinessObservation & { id: string }) | null;
  }[];
};
export type PlatformLoginStatus = "login_required" | "not_configured" | "awaiting_confirmation" | "confirmed" | "optional" | "restricted";
export type LoginRestrictionEvidence = { attemptId: string; hash: string; sourcePlanId: string };
export type PlatformLoginReadiness = {
  surface: keyof typeof surfaces; name: string; url: string; status: PlatformLoginStatus;
  required: boolean; canConfigure: boolean; needsNewPlan: boolean;
  sessionOpen: boolean; confirmed: boolean; blockedCount: number; reason: string;
  restriction: { active: boolean; type: Capture["restriction"] | null; reason: string; evidence: LoginRestrictionEvidence | null };
  previousLoginEvidence: LoginRestrictionEvidence | null;
};
export type LoginReadiness = {
  planId: string; accountMode: NonNullable<PlanConfig["accountMode"]>;
  /** Login preparation only; does not release a stop or gate other provider lanes. */
  ready: boolean; samplingActive: boolean; sessionInspectionAvailable: boolean;
  note: string; platforms: PlatformLoginReadiness[];
};
type SavedRestriction = { id: string; action: string; reason: string; attempt_id: string | null };
const guestObservationSchema = z.object({
  checkedAt: z.string().datetime({ offset: true }), status: z.enum(["ready", "restricted", "unknown"]),
  restriction: z.enum(["none", "login", "captcha", "rate_limit", "region"]),
  account: z.enum(["logged_out", "logged_in", "unknown"]), sourceUrl: z.string().url().max(4000),
  reason: z.string().max(2000), answer: z.literal("not_tested"), citations: z.literal("not_tested"),
  browserMode: z.enum(["silent", "visible"]).optional(),
}).strict();
const GUEST_INSPECTION_TIMEOUT_MS = 45_000;
const configSchema = z.object({
  planId: z.string().uuid(),
  intervalSeconds: z.number().int().min(5).max(300).default(10),
  executionMode: z.enum(["parallel", "serial"]).default("parallel"),
  browserMode: z.enum(["silent", "visible"]).default("silent"),
  timeoutSeconds: z.number().int().min(45).max(300).default(150),
  verifiedCountry: z.string().regex(/^[A-Z]{2}$/).nullable().default(null),
  geoVerificationNote: z.string().trim().max(500).default(""),
  transmissionAcknowledged: z.literal(true),
  captureScreenshot: z.boolean().default(false),
}).strict().refine(c => !c.verifiedCountry || c.geoVerificationNote.length >= 15, "确认出口国家时需填写核验依据（至少 15 字符）");
type Config = z.infer<typeof configSchema>;
type Job = { id: string; plan_id: string; config_json: string; status: string; message: string; created_at: string; updated_at: string };
type Item = { id: string; job_id: string; slot_id: string; ordinal: number; state: string; stage: string; attempt_id: string | null; message: string; started_at: string | null; finished_at: string | null };
type Running = { pause: boolean; controller: AbortController; promise: Promise<void>; intervals: Set<AbortController>; pauseMessage?: string; keepPreparedSessions?: boolean };
const submitted = new Set(["submitting", "waiting", "capturing"]);
const today = (timezone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** One dispatcher per ledger. A committed submission checkpoint is never silently replayed. */
export class BrowserJobs {
  readonly active = new Map<string, Running>();
  private guestInspection: { controller: AbortController; operation: Promise<unknown> } | undefined;
  constructor(readonly lab: LabService, readonly collector?: BrowserCollector,
    private readonly wait = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal })) {
    lab.db.exec(`
      CREATE TABLE IF NOT EXISTS console_browser_job (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES console_plan(id), config_json TEXT NOT NULL,
        status TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT(datetime('now')),
        updated_at TEXT NOT NULL DEFAULT(datetime('now')));
      CREATE TABLE IF NOT EXISTS console_browser_item (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES console_browser_job(id),
        slot_id TEXT NOT NULL UNIQUE REFERENCES console_slot(id), ordinal INTEGER NOT NULL,
        state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '', attempt_id TEXT UNIQUE REFERENCES console_attempt(id),
        message TEXT NOT NULL DEFAULT '', started_at TEXT, finished_at TEXT);
      CREATE TRIGGER IF NOT EXISTS console_browser_job_identity BEFORE UPDATE ON console_browser_job
        WHEN NEW.id IS NOT OLD.id OR NEW.plan_id IS NOT OLD.plan_id OR NEW.config_json IS NOT OLD.config_json OR NEW.created_at IS NOT OLD.created_at
        BEGIN SELECT RAISE(ABORT,'浏览器任务条件不可修改'); END;
      CREATE TRIGGER IF NOT EXISTS console_browser_item_identity BEFORE UPDATE ON console_browser_item
        WHEN NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.slot_id IS NOT OLD.slot_id OR NEW.ordinal IS NOT OLD.ordinal
          OR (OLD.attempt_id IS NOT NULL AND NEW.attempt_id IS NOT OLD.attempt_id)
        BEGIN SELECT RAISE(ABORT,'浏览器任务身份与证据不可修改'); END;
      CREATE TRIGGER IF NOT EXISTS console_browser_job_no_delete BEFORE DELETE ON console_browser_job BEGIN SELECT RAISE(ABORT,'浏览器任务历史不可删除'); END;
      CREATE TRIGGER IF NOT EXISTS console_browser_item_no_delete BEFORE DELETE ON console_browser_item BEGIN SELECT RAISE(ABORT,'浏览器任务历史不可删除'); END;
      CREATE TABLE IF NOT EXISTS console_browser_continuation (
        source_item_id TEXT PRIMARY KEY REFERENCES console_browser_item(id),
        target_item_id TEXT NOT NULL UNIQUE REFERENCES console_browser_item(id),
        created_at TEXT NOT NULL DEFAULT(datetime('now')));
      CREATE TRIGGER IF NOT EXISTS console_browser_continuation_no_update BEFORE UPDATE ON console_browser_continuation
        BEGIN SELECT RAISE(ABORT,'续采关联不可修改'); END;
      CREATE TRIGGER IF NOT EXISTS console_browser_continuation_no_delete BEFORE DELETE ON console_browser_continuation
        BEGIN SELECT RAISE(ABORT,'续采关联不可删除'); END;
      CREATE TABLE IF NOT EXISTS console_browser_egress (
        plan_id TEXT PRIMARY KEY REFERENCES console_plan(id),country TEXT NOT NULL,
        fingerprint TEXT NOT NULL,verified_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS console_browser_egress_no_update BEFORE UPDATE ON console_browser_egress
        BEGIN SELECT RAISE(ABORT,'已锁定的采样出口不可修改'); END;
      CREATE TRIGGER IF NOT EXISTS console_browser_egress_no_delete BEFORE DELETE ON console_browser_egress
        BEGIN SELECT RAISE(ABORT,'已锁定的采样出口不可删除'); END;
      CREATE TABLE IF NOT EXISTS console_browser_guest_check (
        id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES console_plan(id),surface TEXT NOT NULL,
        config_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')));
      CREATE TRIGGER IF NOT EXISTS console_browser_guest_check_no_update BEFORE UPDATE ON console_browser_guest_check
        BEGIN SELECT RAISE(ABORT,'Guest entry checks are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS console_browser_guest_check_no_delete BEFORE DELETE ON console_browser_guest_check
        BEGIN SELECT RAISE(ABORT,'Guest entry check history cannot be deleted'); END;
      UPDATE console_browser_item SET state=CASE WHEN stage IN ('submitting','waiting','capturing') THEN 'uncertain' ELSE 'pending' END,
        message='服务中断；已提交但结果未知的请求保留，不自动重发' WHERE state='running';
      UPDATE console_browser_job SET status='interrupted',message='服务曾中断，已保存进度；恢复只执行未提交任务',updated_at=datetime('now') WHERE status IN ('running','pausing');
    `);
  }
  availability() { return this.collector?.available() ?? { available: false, message: "批量 Chrome 采样需要 Mac 应用" }; }
  /** Historical access stops and a fresh entry check describe separate facts. Neither is an answer sample. */
  guestReadiness(planId: string): GuestReadiness {
    const plan = this.lab.planRow(planId), config = JSON.parse(plan.config_json) as PlanConfig;
    if ((config.accountMode ?? "signed_out") !== "signed_out") throw new Error("Guest entry checks require a strict signed-out plan.");
    let prepared = false, sessionsKnown = true;
    try { prepared = (this.collector?.sessions?.() ?? []).length > 0; }
    catch { sessionsKnown = false; }
    const samplingActive = this.active.size > 0, inspectionActive = !!this.guestInspection;
    const inspectionAvailable = this.availability().available && !!this.collector?.inspectGuest;
    return {
      planId, accountMode: "signed_out", samplingActive, inspectionActive, inspectionAvailable,
      note: "Checks open a fresh signed-out entry without sending a question. They do not test answers or citations, release saved restrictions, or resume queued work.",
      platforms: config.surfaces.map(surface => {
        const scope = `${surface}:${config.country}:signed-out`;
        const restriction = this.lab.db.prepare("SELECT id,action,reason,attempt_id FROM console_restriction WHERE scope=? ORDER BY rowid DESC LIMIT 1").get(scope) as SavedRestriction | undefined;
        const active = restriction?.action === "stop";
        const evidence = active ? this.readRestrictionEvidence(restriction, scope, surface) : null;
        const latest = this.lab.db.prepare("SELECT id,result_json FROM console_browser_guest_check WHERE plan_id=? AND surface=? AND config_hash=? ORDER BY rowid DESC LIMIT 1").get(planId, surface, plan.config_hash) as { id: string; result_json: string } | undefined;
        return {
          surface, name: surfaces[surface].name, url: surfaces[surface].url,
          canCheck: inspectionAvailable && sessionsKnown && !prepared && !samplingActive && !inspectionActive,
          restriction: { active, type: evidence?.type ?? null, reason: active ? restriction!.reason : "", evidence: evidence?.evidence ?? null },
          latest: latest ? { id: latest.id, ...guestObservationSchema.parse(JSON.parse(latest.result_json)) } : null,
        };
      }),
    };
  }
  async checkGuestReadiness(input: unknown): Promise<GuestReadiness> {
    const request = z.object({ planId: z.string().uuid(), surface: surfaceSchema, browserMode: z.enum(["silent", "visible"]).default("silent") }).strict().parse(input);
    const readiness = this.guestReadiness(request.planId);
    const platform = readiness.platforms.find(row => row.surface === request.surface);
    if (!platform) throw new Error("This platform is not included in the selected plan.");
    if (!readiness.inspectionAvailable) throw new Error("Guest entry checks need the updated Mac app.");
    if (!platform.canCheck) throw new Error("Pause browser sampling and close prepared login sessions before checking a fresh guest entry.");
    const plan = this.lab.planRow(request.planId), config = JSON.parse(plan.config_json) as PlanConfig;
    this.lab.assertSetActive(plan.prompt_set_id);
    const controller = new AbortController();
    let settled = false;
    const operation = Promise.resolve().then(() => this.collector!.inspectGuest!({ ...request, config: { ...config, accountMode: "signed_out" } }, controller.signal))
      .then(result => { settled = true; return result; }, error => { settled = true; throw error; });
    const inspection = { controller, operation }; this.guestInspection = inspection;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let observation: GuestReadinessObservation;
    try {
      const result = await Promise.race([operation, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error("Guest entry check timed out; no question was sent.")); }, GUEST_INSPECTION_TIMEOUT_MS);
      })]);
      observation = guestObservationSchema.parse(result);
      if (observation.browserMode && observation.browserMode !== request.browserMode) {
        observation = { ...observation, status: "unknown", reason: "The entry used a different browser mode from the requested check. Answers and citations remain untested." };
      }
      const url = new URL(observation.sourceUrl), rules: readonly SourceRule[] = surfaces[request.surface].sourceRules;
      const official = url.protocol === "https:" && !url.username && !url.password && !url.port && rules.some(rule => rule.hosts.includes(url.hostname) && (rule.paths === null || rule.paths.some(path => url.pathname === path || rule.allowSubpaths && url.pathname.startsWith(path + "/"))));
      if (observation.status === "ready" && (!official || observation.account !== "logged_out" || observation.restriction !== "none")) {
        observation = { ...observation, status: "unknown", reason: "The entry did not confirm a signed-out session on the expected platform. Answers and citations remain untested." };
      }
    } catch (error) {
      observation = { checkedAt: new Date().toISOString(), status: "unknown", restriction: "none", account: "unknown", sourceUrl: surfaces[request.surface].url,
        reason: error instanceof Error ? error.message.slice(0, 2000) : "The guest entry could not be checked. No question was sent.", answer: "not_tested", citations: "not_tested" };
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
      // A stuck adapter stays gated until its isolated context has actually finished.
      if (settled) this.guestInspection = undefined;
      else void operation.catch(() => {}).finally(() => { if (this.guestInspection === inspection) this.guestInspection = undefined; });
    }
    this.lab.db.prepare("INSERT INTO console_browser_guest_check(id,plan_id,surface,config_hash,result_json) VALUES(?,?,?,?,?)")
      .run(randomUUID(), plan.id, request.surface, plan.config_hash, canonicalJson(observation));
    return this.guestReadiness(plan.id);
  }
  /** Inspect preparation without opening a browser, releasing limits or dispatching work. */
  loginReadiness(planId: string): LoginReadiness {
    const plan = this.lab.planRow(planId), config = JSON.parse(plan.config_json) as PlanConfig;
    const inheritedLogin = this.continuationLoginSurfaces(planId);
    const accountMode = config.accountMode ?? "signed_out", samplingActive = this.active.size > 0;
    let sessionInspectionAvailable = !!this.collector?.sessions;
    let sessions: { planId: string; surface: string; verified: boolean }[] = [];
    try { sessions = this.collector?.sessions?.() ?? []; }
    catch { sessionInspectionAvailable = false; }
    const availability = this.availability();
    const otherPlanPrepared = sessions.some(session => session.planId !== planId);
    const platformRows = config.surfaces.map(surface => {
      const capability = surfaces[surface];
      const scope = accountMode === "isolated" ? `${surface}:${config.country}:isolated:${planId}` : `${surface}:${config.country}:signed-out`;
      const latest = this.lab.db.prepare("SELECT id,action,reason,attempt_id FROM console_restriction WHERE scope=? ORDER BY rowid DESC LIMIT 1").get(scope) as SavedRestriction | undefined;
      const active = latest?.action === "stop";
      const current = active ? this.readRestrictionEvidence(latest, scope, surface) : null;
      // Shared signed-out stops can originate in another plan. Reconfiguration
      // after a closed temporary session is based only on this plan's history.
      const history = this.lab.db.prepare(`SELECT r.id,r.action,r.reason,r.attempt_id FROM console_restriction r
        JOIN console_attempt a ON a.id=r.attempt_id JOIN console_slot s ON s.id=a.slot_id
        WHERE r.scope=? AND r.action='stop' AND s.plan_id=? AND s.surface=? ORDER BY r.rowid DESC`).all(scope, planId, surface) as SavedRestriction[];
      let previousLoginEvidence: LoginRestrictionEvidence | null = null;
      for (const row of history) {
        const observed = this.readRestrictionEvidence(row, scope, surface);
        if (observed?.type === "login") { previousLoginEvidence = observed.evidence; break; }
      }
      const needsLogin = current?.type === "login";
      const required = accountMode === "signed_in_private" || needsLogin || accountMode === "isolated" && (!!previousLoginEvidence || inheritedLogin.includes(surface));
      const needsNewPlan = accountMode === "signed_out" && needsLogin;
      const supportsMode = accountMode === "isolated" && capability.independentLoginSupported || accountMode === "signed_in_private" && capability.privateSupported;
      const session = supportsMode ? sessions.find(value => value.planId === planId && value.surface === surface) : undefined;
      let confirmed = !!session?.verified;
      if (confirmed && this.collector?.ready) {
        try { confirmed = this.collector.ready(planId, [surface]); }
        catch { confirmed = false; sessionInspectionAvailable = false; }
      }
      const canConfigure = supportsMode && availability.available && !!this.collector?.prepareSession && !!this.collector.verifySession && !samplingActive && !otherPlanPrepared;
      const blockedCount = (this.lab.db.prepare(`SELECT COUNT(*) n FROM console_browser_item i
        JOIN console_browser_job j ON j.id=i.job_id JOIN console_slot s ON s.id=i.slot_id
        WHERE j.plan_id=? AND s.surface=? AND i.state='blocked'`).get(planId, surface) as { n: number }).n;
      let status: PlatformLoginStatus, reason: string;
      if (active && !needsLogin) {
        status = "restricted";
        reason = current ? `当前入口受 ${current.type} 限制；登录配置不能解除这类限制。${latest!.reason}`
          : "当前入口有受限记录，但缺少完整、匹配的捕获证据，无法认定为登录问题；原限制保留。";
      } else if (needsNewPlan) {
        status = "login_required";
        reason = "捕获证据确认此入口要求登录；当前计划已冻结为未登录条件，请新建独立会话计划后配置登录。原计划和采样记录保留。";
      } else if (confirmed) {
        status = "confirmed";
        reason = active ? accountMode === "isolated" ? "本计划的登录窗口已确认，但原登录限制仍保留；在配置处再次确认后，仅可手动继续未提交位置。"
          : "本计划的登录窗口已确认；当前未登录范围的登录限制仍保留，登录确认不会自动解除此限制。请查看限制处理，或新建独立会话计划。"
          : "本计划的独立登录已确认；关闭窗口、结束会话或重启应用后需要重新配置。";
      } else if (session) {
        status = "awaiting_confirmation";
        reason = "登录准备尚未确认或窗口已失效；请打开本计划的独立窗口，完成登录后点击确认登录。";
      } else if (needsLogin) {
        status = "login_required";
        reason = "捕获证据确认此入口要求登录；请在本计划的平台登录配置处打开独立窗口并确认登录，之后手动继续未提交任务。";
      } else if (required) {
        status = "not_configured";
        reason = accountMode === "signed_in_private" ? "此计划采用登录态临时采样，每个入口都需要先配置并确认独立登录窗口。"
          : "本计划曾遇到登录要求；当前没有已确认的独立会话，关闭会话或重启应用后请重新配置登录。";
      } else {
        status = "optional";
        reason = accountMode === "signed_out" ? "当前没有完整证据表明此入口要求登录；本计划保持未登录采样。"
          : "当前没有完整证据表明此入口要求登录；可以先未登录采样，必要时在本计划配置独立登录。";
      }
      if (!supportsMode && accountMode !== "signed_out") reason += " 此入口暂不支持当前计划的登录模式。";
      else if (supportsMode && !availability.available) reason += ` ${availability.message}`;
      else if (supportsMode && (!this.collector?.prepareSession || !this.collector.verifySession)) reason += " 登录配置需要更新后的 Mac 应用。";
      else if (supportsMode && samplingActive) reason += " 配置前需先暂停正在采样的批次。";
      else if (supportsMode && otherPlanPrepared) reason += " 另一个计划保有登录准备，请先结束其他计划的独立会话。";
      if (!sessionInspectionAvailable) reason += " 当前无法读取独立会话确认状态。";
      return { surface, name: capability.name, url: capability.url, status, required, canConfigure, needsNewPlan,
        sessionOpen: !!session, confirmed, blockedCount, reason,
        restriction: { active, type: current?.type ?? null, reason: active ? latest!.reason : "", evidence: current?.evidence ?? null },
        previousLoginEvidence } satisfies PlatformLoginReadiness;
    });
    return { planId, accountMode, ready: platformRows.every(row => !row.required || row.confirmed && !row.needsNewPlan),
      samplingActive, sessionInspectionAvailable,
      note: "登录配置仅用于所选计划的独立临时窗口，不保存账号密码；本检查不会打开网页、解除限制或开始采样。",
      platforms: platformRows };
  }
  private readRestrictionEvidence(row: SavedRestriction, scope: string, surface: keyof typeof surfaces) {
    if (row.action !== "stop" || !row.attempt_id) return null;
    const saved = this.lab.db.prepare("SELECT * FROM console_attempt WHERE id=?").get(row.attempt_id) as Parameters<LabService["attempt"]>[0] | undefined;
    if (!saved) return null;
    try {
      const slot = this.lab.slot(saved.slot_id);
      if (slot.surface !== surface || this.lab.scope(slot) !== scope) return null;
      const attempt = this.lab.attempt(saved);
      if (!attempt.integrity || attempt.capture.status !== "unavailable" || attempt.quality.status !== "terminal") return null;
      return { type: attempt.capture.restriction, evidence: { attemptId: attempt.id, hash: attempt.hash, sourcePlanId: slot.plan_id } };
    } catch { return null; }
  }
  confirmEgress(planId:string,proof:{country:string;fingerprint:string;verifiedAt:string}) {
    const old=this.lab.db.prepare('SELECT country,fingerprint FROM console_browser_egress WHERE plan_id=?').get(planId) as {country:string;fingerprint:string}|undefined;
    if(proof.country!==this.lab.plan(planId).config.country||(old&&(old.country!==proof.country||old.fingerprint!==proof.fingerprint)))
      throw Object.assign(new Error('目标国家出口不匹配或已变化；本计划已暂停，请恢复原出口后继续'),{code:'EGRESS_GUARD'});
    if(!old)this.lab.db.prepare('INSERT INTO console_browser_egress VALUES(?,?,?,?)').run(planId,proof.country,proof.fingerprint,proof.verifiedAt);
  }
  job(id: string) {
    const j = this.lab.db.prepare("SELECT * FROM console_browser_job WHERE id=?").get(id) as Job | undefined;
    if (!j) throw new Error("浏览器批次不存在");
    return { ...j, config: JSON.parse(j.config_json) as Config };
  }
  items(id: string) { return this.lab.db.prepare("SELECT * FROM console_browser_item WHERE job_id=? ORDER BY ordinal").all(id) as Item[]; }
  private resumeState(id: string) {
    const job=this.job(id),config=JSON.parse(this.lab.planRow(job.plan_id).config_json) as PlanConfig;
    const date=today(config.timezone);
    const candidates=this.items(id).filter(item=>["pending","blocked"].includes(item.state)&&!submitted.has(item.stage)&&!item.attempt_id)
      .map(item=>({item,slot:this.lab.slot(item.slot_id)}))
      .filter(({item,slot})=>!this.lab.db.prepare("SELECT 1 FROM console_attempt WHERE slot_id=?").get(slot.id)
        &&!this.lab.db.prepare("SELECT 1 FROM console_browser_continuation WHERE source_item_id=?").get(item.id)
        &&this.lab.restriction(this.lab.scope(slot))?.action!=="stop");
    const successor=this.lab.db.prepare(`SELECT target.job_id id,j.plan_id planId FROM console_browser_continuation c
      JOIN console_browser_item source ON source.id=c.source_item_id
      JOIN console_browser_item target ON target.id=c.target_item_id JOIN console_browser_job j ON j.id=target.job_id
      WHERE source.job_id=? ORDER BY c.rowid DESC LIMIT 1`).get(id) as {id:string;planId:string}|undefined;
    const parent=this.lab.db.prepare(`SELECT j.plan_id planId FROM console_browser_continuation c
      JOIN console_browser_item source ON source.id=c.source_item_id JOIN console_browser_job j ON j.id=source.job_id
      JOIN console_browser_item target ON target.id=c.target_item_id WHERE target.job_id=? LIMIT 1`).get(id) as {planId:string}|undefined;
    return {date,expired:candidates.filter(c=>c.slot.window<date),current:candidates.filter(c=>c.slot.window===date),successor,parent};
  }
  rows(setId?: string) {
    const jobs = this.lab.db.prepare(`SELECT j.* FROM console_browser_job j JOIN console_plan p ON p.id=j.plan_id ${setId ? "WHERE p.prompt_set_id=?" : ""} ORDER BY j.rowid DESC`).all(...(setId ? [setId] : [])) as Job[];
    return jobs.map(j => {
      const items = this.items(j.id), counts: Record<string, number> = {};
      for (const i of items) counts[i.state] = (counts[i.state] ?? 0) + 1;
      const failures = (this.lab.db.prepare("SELECT COUNT(*) n FROM console_browser_item i JOIN console_attempt a ON a.id=i.attempt_id WHERE i.job_id=? AND json_extract(a.capture_json,'$.status') IN ('error','unavailable')").get(j.id) as {n:number}).n;
      const resume=this.resumeState(j.id);
      return { ...j, config: JSON.parse(j.config_json) as Config, total: items.length, counts,
        resume:{date:resume.date,expired:resume.expired.length,current:resume.current.length,successor:resume.successor??null,parent:resume.parent??null},
        current: items.find(i => i.state === "running") ?? null,
        currents: items.filter(i => i.state === "running"),
        lanes: (this.lab.db.prepare(`SELECT s.surface,i.state,COUNT(*) n FROM console_browser_item i
          JOIN console_slot s ON s.id=i.slot_id WHERE i.job_id=? GROUP BY s.surface,i.state`).all(j.id) as {surface:string;state:string;n:number}[]),
        captured: counts.captured ?? 0, remaining: (counts.pending ?? 0) + (counts.blocked ?? 0),
        failedRecords: failures,
        finalizing: this.active.has(j.id) && !["running", "pausing"].includes(j.status),
        attention: (counts.failed ?? 0) + (counts.uncertain ?? 0) + (counts.blocked ?? 0) + failures };
    });
  }
  create(requestId: string, input: unknown) {
    // Every new batch runs in the background by default. Existing frozen jobs
    // retain their recorded mode unless explicitly continued into a new job.
    const config = configSchema.parse(input);
    const availability = this.availability();
    if (!availability.available) throw new Error(availability.message);
    const result = this.lab.command(requestId, "browser-job", config, () => {
      this.assertSessions(config.planId);
      const plan = this.lab.plan(config.planId);
      this.lab.assertSetActive(plan.prompt_set_id);
      if (plan.config.device !== "desktop") throw new Error("Chrome 批量采样目前只支持 desktop 计划");
      const occupied = new Set((this.lab.db.prepare("SELECT slot_id FROM console_browser_item").all() as {slot_id: string}[]).map(i => i.slot_id));
      const slots = plan.slots.filter(s => s.window === today(plan.config.timezone) && !s.latest && !occupied.has(s.id));
      if (!slots.length) throw new Error("当天没有尚未入队的空白位置；已有批次请使用恢复按钮");
      if (slots.length > 5000) throw new Error("单批最多 5000 个位置");
      const id = randomUUID();
      this.lab.db.prepare("INSERT INTO console_browser_job(id,plan_id,config_json,status) VALUES(?,?,?,'queued')").run(id, plan.id, canonicalJson(config));
      for (const [index,s] of slots.entries()) this.lab.db.prepare("INSERT INTO console_browser_item(id,job_id,slot_id,ordinal,state,message) VALUES(?,?,?,?,?,?)")
        .run(randomUUID(), id, s.id, index, s.restriction?.action === "stop" ? "blocked" : "pending", s.restriction?.action === "stop" ? s.restriction.reason : "");
      return { id };
    });
    // Explicit creation starts only this batch; other saved batches never auto-start.
    if (!this.active.size && this.job(result.id).status === "queued") this.start(result.id);
    return result;
  }
  assertSessions(planId:string) {
    if (this.guestInspection) throw new Error("Wait for the guest entry check to finish before starting browser sampling.");
    const plan=this.lab.plan(planId);
    if (plan.config.accountMode === "isolated" && plan.config.surfaces.some(surface => !surfaces[surface].independentLoginSupported)
      || plan.config.accountMode === "signed_in_private" && plan.config.surfaces.some(surface => !surfaces[surface].privateSupported))
      throw new Error("Guest-only platforms require a strict signed-out plan.");
    if(plan.config.accountMode==="signed_in_private" && !this.collector?.ready?.(planId,plan.config.surfaces)) throw new Error("请先为本计划的每个入口打开独立登录窗口，并确认登录状态；关闭应用后需重新登录");
    const inheritedLogin = this.continuationLoginSurfaces(planId);
    if (plan.config.accountMode === "isolated" && inheritedLogin.length && !this.collector?.ready?.(planId, inheritedLogin))
      throw new Error("This continuation needs fresh confirmed login sessions for its required platforms before sampling.");
  }
  private continuationLoginSurfaces(planId: string): (keyof typeof surfaces)[] {
    const config = JSON.parse(this.lab.planRow(planId).config_json) as PlanConfig & { continuationRequiredLoginSurfaces?: unknown };
    const saved = config.continuationRequiredLoginSurfaces;
    return Array.isArray(saved) ? config.surfaces.filter(surface => saved.includes(surface)) : [];
  }
  async sessionControl(input:unknown) {
    const c=z.object({planId:z.string().uuid(),surface:surfaceSchema,action:z.enum(["open","verify","close"])}).strict().parse(input);
    if(this.active.size||this.guestInspection)throw new Error("Pause browser sampling and wait for the guest entry check to finish before preparing a login session.");
    const plan=this.lab.plan(c.planId);
    this.lab.assertSetActive(plan.prompt_set_id);
    if(!["signed_in_private","isolated"].includes(plan.config.accountMode??"signed_out")||!plan.config.surfaces.includes(c.surface)||plan.config.accountMode==="signed_in_private"&&!surfaces[c.surface].privateSupported||plan.config.accountMode==="isolated"&&!surfaces[c.surface].independentLoginSupported)throw new Error("当前计划没有启用此登录态入口");
    if(c.action==="close"){await this.collector?.close();return {ok:true};}
    if(!this.collector?.prepareSession||!this.collector.verifySession)throw new Error("登录准备需要更新后的 Mac 应用");
    if(c.action==="open")return this.collector.prepareSession({planId:plan.id,surface:c.surface,config:plan.config});
    const result=await this.collector.verifySession(plan.id,c.surface);
    // Verification only releases a login stop originating in this plan.
    // Queue recovery never changes other plans or committed submissions.
    if(plan.config.accountMode!=="isolated"||!result||typeof result!=="object"||!("verified" in result)||result.verified!==true)return result;
    if(this.active.size)throw new Error("确认登录期间已有浏览器批次运行；请先暂停后再确认");
    return {...result,...this.recoverVerifiedLogin(plan.id,c.surface,plan.config.country)};
  }
  private safelyUnsubmitted(item:Item) {
    return !item.attempt_id&&!submitted.has(item.stage)
      &&!this.lab.db.prepare("SELECT 1 FROM console_attempt WHERE slot_id=?").get(item.slot_id)
      &&!this.lab.db.prepare("SELECT 1 FROM console_browser_continuation WHERE source_item_id=?").get(item.id);
  }
  private recoverVerifiedLogin(planId:string,surface:keyof typeof surfaces,country:string) {
    return inTransaction(this.lab.db,()=>{
      const untouched={recovered:0,restrictionReleased:false};
      const scope=`${surface}:${country}:isolated:${planId}`;
      const restriction=this.lab.db.prepare("SELECT id,action,attempt_id FROM console_restriction WHERE scope=? ORDER BY rowid DESC LIMIT 1").get(scope) as {id:string;action:string;attempt_id:string|null}|undefined;
      if(restriction?.action!=="stop"||!restriction.attempt_id)return untouched;
      const row=this.lab.db.prepare("SELECT * FROM console_attempt WHERE id=?").get(restriction.attempt_id) as Parameters<LabService["attempt"]>[0]|undefined;
      if(!row)return untouched;
      const slot=this.lab.slot(row.slot_id);
      if(slot.plan_id!==planId||slot.surface!==surface||this.lab.scope(slot)!==scope)return untouched;
      const attempt=this.lab.attempt(row);
      if(!attempt.integrity||attempt.capture.status!=="unavailable"||attempt.capture.restriction!=="login"||attempt.quality.status!=="terminal")return untouched;
      this.lab.release(`login-release:${sha256(canonicalJson({restrictionId:restriction.id,planId,surface}))}`,{
        scope,reason:`本计划的独立窗口已确认登录，仅解除原登录限制。原受限记录 ${attempt.id} 与证据哈希 ${attempt.hash} 保留；仅允许手动继续未提交位置，不重发已提交或结果未知的请求。`,
      });
      const candidates=this.lab.db.prepare(`SELECT i.* FROM console_browser_item i
        JOIN console_browser_job j ON j.id=i.job_id JOIN console_slot s ON s.id=i.slot_id
        WHERE j.plan_id=? AND s.surface=? AND i.state='blocked' ORDER BY i.ordinal`).all(planId,surface) as Item[];
      const recovered=candidates.filter(item=>this.safelyUnsubmitted(item)),affected=new Set<string>();
      for(const item of recovered){
        this.lab.db.prepare("UPDATE console_browser_item SET state='pending',message=? WHERE id=?").run("独立登录已确认；此位置尚未提交，可手动继续",item.id);
        affected.add(item.job_id);
      }
      for(const jobId of affected){
        const items=this.items(jobId),needsAttention=items.some(item=>["blocked","failed","uncertain"].includes(item.state));
        this.setStatus(jobId,needsAttention?"needs_attention":"paused",`独立登录已确认；${recovered.filter(item=>item.job_id===jobId).length} 个未提交位置可手动继续。原登录失败和未知请求保留，未自动开始采样。`);
      }
      return {recovered:recovered.length,restrictionReleased:true};
    });
  }
  setStatus(id: string, status: string, message = "") {
    this.lab.db.prepare("UPDATE console_browser_job SET status=?,message=?,updated_at=datetime('now') WHERE id=?").run(status,message,id);
  }
  /** Continue only unsent positions, keeping each observation in its actual date window. */
  resume(id: string, options?: { browserMode?: "silent" }): {ok:true;id:string;planId:string;continued?:number;needsLogin?:boolean} {
    if (this.guestInspection) throw new Error("Wait for the guest entry check to finish before continuing browser sampling.");
    if (this.active.has(id) && this.job(id).status !== "running")
      throw new Error("暂停收尾尚未完成；正在保存当前记录或关闭浏览器，完成后可继续采样");
    const job=this.job(id);
    const changeMode = options?.browserMode === "silent" && (job.config.browserMode ?? "visible") !== "silent";
    if (this.active.has(id) && changeMode)
      throw new Error("Pause this batch and wait for its in-flight answers to finish before continuing in the background.");
    if(this.active.has(id))return {ok:true,id,planId:job.plan_id};
    if(!this.availability().available)throw new Error(this.availability().message);
    const sourcePlan=this.lab.planRow(job.plan_id);this.lab.assertSetActive(sourcePlan.prompt_set_id);
    const state=this.resumeState(id);
    const candidates = changeMode ? [...state.expired, ...state.current] : state.expired;
    if(!candidates.length){
      if(state.current.length){this.start(id);return {ok:true,id,planId:job.plan_id};}
      if(state.successor)return this.resume(state.successor.id, options);
      if(job.status==="completed")return {ok:true,id,planId:job.plan_id};
      throw new Error("当前没有可继续的未提交任务；受限入口需先处理限制，已提交或结果未知的请求不会自动重发");
    }
    if(this.active.size)throw new Error("已有浏览器批次运行，请先暂停");
    const sourceReadiness = this.loginReadiness(sourcePlan.id);
    const eligibleSurfaces = [...new Set(candidates.map(candidate => candidate.slot.surface))];
    const requiredLoginSurfaces = sourceReadiness.platforms.filter(platform => eligibleSurfaces.includes(platform.surface)
      && (platform.required || sourceReadiness.accountMode === "isolated" && platform.confirmed)).map(platform => platform.surface);
    const result=inTransaction(this.lab.db,()=>{
      const planId=randomUUID(),jobId=randomUUID(),oldConfig=JSON.parse(sourcePlan.config_json);
      const label=`${sourcePlan.label.slice(0,110)} · 续采 ${state.date}`;
      const config=canonicalJson({...oldConfig,label,windows:[state.date],
        surfaces:eligibleSurfaces,
        continuationFromPlanId:sourcePlan.id,continuationFromJobId:id,
        continuationSourceSlots:candidates.map(c=>c.slot.id),
        ...(requiredLoginSurfaces.length ? { continuationRequiredLoginSurfaces: requiredLoginSurfaces } : {})});
      const runId=startRun(this.lab.db,{promptSetId:sourcePlan.prompt_set_id,phase:"baseline",runsPerPrompt:1,
        note:`Console dated continuation / ${planId} from ${sourcePlan.id}; only unsent positions; denominator is console_slot.`});
      this.lab.db.prepare("INSERT INTO console_plan(id,prompt_set_id,run_id,label,config_json,config_hash) VALUES(?,?,?,?,?,?)")
        .run(planId,sourcePlan.prompt_set_id,runId,label,config,sha256(config));
      const batchConfig=configSchema.parse({...job.config,planId,
        executionMode:job.config.executionMode??"parallel",
        intervalSeconds:job.config.executionMode?job.config.intervalSeconds:10,
        captureScreenshot:job.config.captureScreenshot??true,
        browserMode:options?.browserMode ?? job.config.browserMode??'visible',
        verifiedCountry:null,geoVerificationNote:""});
      this.lab.db.prepare("INSERT INTO console_browser_job(id,plan_id,config_json,status,message) VALUES(?,?,?,'queued',?)")
        .run(jobId,planId,canonicalJson(batchConfig),`从原批次续接 ${candidates.length} 个未提交位置；按 ${state.date} 记录，地区待重新核验`);
      for(const [ordinal,{item,slot}] of candidates.entries()){
        const slotId=randomUUID(),itemId=randomUUID();
        this.lab.db.prepare("INSERT INTO console_slot(id,plan_id,prompt_id,surface,window,run_idx) VALUES(?,?,?,?,?,?)")
          .run(slotId,planId,slot.prompt_id,slot.surface,state.date,slot.run_idx);
        this.lab.db.prepare("INSERT INTO console_browser_item(id,job_id,slot_id,ordinal,state) VALUES(?,?,?,?,'pending')")
          .run(itemId,jobId,slotId,ordinal);
        this.lab.db.prepare("INSERT INTO console_browser_continuation(source_item_id,target_item_id) VALUES(?,?)").run(item.id,itemId);
        this.lab.db.prepare("UPDATE console_browser_item SET state='carried_forward',message=? WHERE id=?")
          .run(`已转入 ${state.date} 的续采批次 ${jobId.slice(0,8)}；原位置与日期保留`,item.id);
      }
      this.setStatus(id,"needs_attention",`${candidates.length} 个未提交位置已转入 ${state.date} 的续采批次；已保存证据及入口限制保留`);
      return {ok:true as const,id:jobId,planId,continued:candidates.length};
    });
    const plan=this.lab.plan(result.planId);
    if(plan.config.accountMode==="signed_in_private" || requiredLoginSurfaces.length){
      this.setStatus(result.id,"queued","续采计划已建立；请为此计划重新准备并确认登录，再继续未提交任务");
      return {...result,needsLogin:true};
    }
    this.start(result.id);return result;
  }
  start(id: string) {
    const job = this.job(id);
    if (this.active.has(id)) return;
    if (this.active.size) throw new Error("已有浏览器批次运行，请先暂停");
    if (!this.availability().available) throw new Error(this.availability().message);
    if (job.status === "completed") return;
    this.lab.assertSetActive(this.lab.planRow(job.plan_id).prompt_set_id);
    this.assertSessions(job.plan_id);
    for (const item of this.items(id)) if (item.state === "blocked" && this.safelyUnsubmitted(item)) {
      const slot = this.lab.slot(item.slot_id);
      if (this.lab.restriction(this.lab.scope(slot))?.action !== "stop")
        this.lab.db.prepare("UPDATE console_browser_item SET state='pending',message='' WHERE id=?").run(item.id);
    }
    const running: Running = { pause: false, controller: new AbortController(), promise: Promise.resolve(), intervals: new Set() };
    this.active.set(id, running);
    this.setStatus(id,"running");
    running.promise = this.run(id, running).catch((error) => {
      this.setStatus(id,"needs_attention",error instanceof Error&&/身份不一致/.test(error.message)?error.message+"；全部入口已停止，未重复提交":"批次意外中断；保留未知请求，请检查后恢复");
      for (const item of this.items(id)) if (item.state === "running") this.lab.db.prepare("UPDATE console_browser_item SET state=?,message=? WHERE id=?").run(submitted.has(item.stage)?"uncertain":"pending","批次异常；未确认请求不会重发",item.id);
    }).finally(async () => {
      // A user pause drains in-flight answers without ending an already verified
      // dedicated login preparation. It stays only in the collector's memory;
      // resumed questions still check the actual restored account before sending.
      let keepPrepared=false;
      try {
        const mode=(JSON.parse(this.lab.planRow(job.plan_id).config_json) as PlanConfig).accountMode;
        keepPrepared=running.keepPreparedSessions===true&&!running.controller.signal.aborted&&this.job(id).status==="paused"
          &&["signed_in_private","isolated"].includes(mode??"signed_out")
          &&this.collector?.sessions?.().some(session=>session.planId===job.plan_id&&session.verified)===true;
      } catch { /* An unreadable preparation is never retained as verified. */ }
      try { if(!keepPrepared)await this.collector?.close().catch(() => {}); }
      finally { this.active.delete(id); }
    });
  }
  private async run(id: string, running: Running) {
    const job = this.job(id), plan = this.lab.plan(job.plan_id), signal = running.controller.signal;
    const items = this.items(id), held = new Set<string>();
    const holdSurface = (surface: string, message: string) => {
      held.add(surface);
      this.lab.db.prepare(`UPDATE console_browser_item SET message=? WHERE job_id=? AND state='pending'
        AND slot_id IN (SELECT id FROM console_slot WHERE surface=?)`).run(message,id,surface);
    };
    const work = async (queue: Item[]) => {
    let dispatched = 0;
    for (const item of queue) {
      if (running.pause || signal.aborted) break;
      if (item.state !== "pending" || item.attempt_id) continue;
      if(submitted.has(item.stage)){
        this.lab.db.prepare("UPDATE console_browser_item SET state='uncertain',message=? WHERE id=?").run("此位置保留已提交检查点，结果未知；未自动重发",item.id);
        continue;
      }
      const slot = this.lab.slot(item.slot_id);
      if (held.has(slot.surface)) continue;
      const restriction = this.lab.restriction(this.lab.scope(slot));
      if (restriction?.action === "stop") {
        this.lab.db.prepare("UPDATE console_browser_item SET state='blocked',message=? WHERE id=?").run(restriction.reason,item.id); continue;
      }
      if (slot.window !== today(plan.config.timezone)) {
        running.pause=true;running.pauseMessage="日期窗口已结束；剩余位置保留，需为新日期建立新计划";
        for(const interval of running.intervals)interval.abort();
        return;
      }
      if (this.lab.db.prepare("SELECT id FROM console_attempt WHERE slot_id=? LIMIT 1").get(slot.id)) {
        this.lab.db.prepare("UPDATE console_browser_item SET state='skipped',message='此位置已有其他途径取得的证据，未重复查询' WHERE id=?").run(item.id); continue;
      }
      if (dispatched++) {
        const interval = new AbortController();running.intervals.add(interval);
        try { await this.wait(job.config.intervalSeconds*1000, AbortSignal.any([signal, interval.signal])); }
        catch (error) { if(running.pause||signal.aborted)break;throw error; }
        finally { running.intervals.delete(interval); }
      }
      if (running.pause || signal.aborted) break;
      // Conditions can change while a lane waits. Never submit across its date window.
      if(slot.window!==today(plan.config.timezone)){
        running.pause=true;running.pauseMessage="日期窗口已结束；剩余位置保留，需为新日期建立新计划";
        for(const interval of running.intervals)interval.abort();return;
      }
      const latestRestriction=this.lab.restriction(this.lab.scope(slot));
      if(latestRestriction?.action==="stop"){
        this.lab.db.prepare("UPDATE console_browser_item SET state='blocked',message=? WHERE id=?").run(latestRestriction.reason,item.id);continue;
      }
      if(this.lab.db.prepare("SELECT id FROM console_attempt WHERE slot_id=? LIMIT 1").get(slot.id)){
        this.lab.db.prepare("UPDATE console_browser_item SET state='skipped',message='此位置已有其他途径取得的证据，未重复查询' WHERE id=?").run(item.id);continue;
      }
      const prompt = plan.slots.find(s=>s.id===slot.id)!.prompt;
      this.lab.db.prepare("UPDATE console_browser_item SET state='running',stage='opening',started_at=datetime('now'),message='' WHERE id=?").run(item.id);
      let stage: BrowserStage = "opening";
      let capture: Capture;
      let checkpointError: unknown;
      try {
        capture = await this.collector!.collect({planId:plan.id,slotId:slot.id,prompt,surface:slot.surface,config:plan.config,
          timeoutSeconds:job.config.timeoutSeconds,captureScreenshot:job.config.captureScreenshot??true,browserMode:job.config.browserMode??'visible',verifiedCountry:job.config.verifiedCountry,geoVerificationNote:job.config.geoVerificationNote,
          confirmEgress:proof=>this.confirmEgress(plan.id,proof)},signal,
          next => {
            stage=next;
            try{this.lab.db.prepare("UPDATE console_browser_item SET stage=? WHERE id=?").run(next,item.id);}
            catch(error){checkpointError=error;throw error;}
          });
      } catch(error) {
        if(checkpointError)throw checkpointError;
        if((error as {code?:string})?.code==='EGRESS_GUARD'&&!submitted.has(stage)){
          this.lab.db.prepare("UPDATE console_browser_item SET state='pending',message=?,finished_at=datetime('now') WHERE id=?")
            .run(error instanceof Error?error.message:'出口核验失败；未提交问题',item.id);
          running.pause=true;running.pauseMessage='目标国家出口未通过核验；未提交任务保留，恢复原出口后继续';
          for(const interval of running.intervals)interval.abort();return;
        }
        this.lab.db.prepare("UPDATE console_browser_item SET state=?,message=?,finished_at=datetime('now') WHERE id=?")
          .run(submitted.has(stage)?"uncertain":signal.aborted?"pending":"failed",
            signal.aborted?"已停止；可能已提交的请求不会自动重发":"采样未能完成；请查看浏览器或诊断日志，不自动重试",item.id);
        if(signal.aborted)return;
        holdSurface(slot.surface,"此入口采样中断；其余入口继续，检查后可继续未提交任务");
        continue;
      }
      // Identity/storage failures are global: drain all in-flight lanes before closing Chrome.
      if(checkpointError)throw checkpointError;
      if (capture.slotId !== slot.id || capture.prompt !== prompt) throw new Error("采集器返回的问题身份不一致");
      inTransaction(this.lab.db, () => {
        const attempt = this.lab.capture(`browser-capture:${item.id}`,capture,{jobId:id,itemId:item.id});
        this.lab.db.prepare("UPDATE console_browser_item SET state='captured',stage='saved',attempt_id=?,message=?,finished_at=datetime('now') WHERE id=?")
          .run(attempt.id,capture.reason || "答案与证据已保存，自动质检已更新",item.id);
      });
      if (capture.status === "error") holdSurface(slot.surface,"此入口出现失败，后续问题已暂停；其余入口继续，检查后可恢复");
    }
    };
    // Missing mode belongs to a historical serial batch; its frozen settings stay intact.
    const queues = job.config.executionMode === "parallel"
      ? plan.config.surfaces.map(surface=>items.filter(item=>this.lab.slot(item.slot_id).surface===surface))
      : [items];
    const results=await Promise.allSettled(queues.map(queue=>work(queue).catch(error=>{running.controller.abort();throw error;})));
    const fatal=results.find(result=>result.status==="rejected");
    if(fatal?.status==="rejected")throw fatal.reason;
    const remaining = this.items(id);
    if (running.pause || signal.aborted) this.setStatus(id,"paused",running.pauseMessage??"已暂停；各入口在途问题已处理，恢复只执行尚未提交的位置");
    else if (remaining.some(i=>["pending","blocked","uncertain","failed"].includes(i.state)) || remaining.some(i=>i.attempt_id && (()=>{
      const a=this.lab.db.prepare("SELECT capture_json FROM console_attempt WHERE id=?").get(i.attempt_id) as {capture_json:string};
      return ["error","unavailable"].includes(JSON.parse(a.capture_json).status);
    })())) this.setStatus(id,"needs_attention","其他可执行入口已处理；失败入口的未提交任务等待恢复，受限与未知位置不自动重发");
    else this.setStatus(id,"completed","本批已完成；自动质检与结果已更新，可直接查看或导出");
  }
  control(input: unknown) {
    const c=z.object({id:z.string().uuid(),action:z.enum(["resume","pause","stop","show"]),browserMode:z.literal("silent").optional()})
      .strict().refine(value => !value.browserMode || value.action === "resume", "Browser mode can only be selected for a continuation.").parse(input);
    this.job(c.id);
    if(c.action==="resume") return this.resume(c.id, { browserMode: c.browserMode ?? "silent" });
    else if(c.action==="show") return this.collector?.show().then(()=>({ok:true}));
    else {
      const active=this.active.get(c.id);
      if(active){
        active.pause=true;active.keepPreparedSessions=c.action==="pause";
        for(const interval of active.intervals)interval.abort();
        if(c.action==="stop"){
          active.pauseMessage="已停止；未提交位置保留，已提交但未返回的请求不会自动重发；独立登录准备已结束";
          active.controller.abort();
        }
        this.setStatus(c.id,"pausing",c.action==="stop"?"正在停止；已提交但未返回的请求将保留为未知":"等待各入口当前问题保存后暂停");
      } else {
        const job=this.job(c.id);
        if(c.action==="stop"&&this.active.size&&!this.collector?.closePlanSessions)
          throw new Error("另一个浏览器批次仍在运行，请先暂停后再结束此计划的登录准备");
        this.setStatus(c.id,"paused",c.action==="stop"?"已停止；未提交位置保留，此计划的独立登录准备已结束":"已暂停；恢复只执行尚未提交的位置");
        if(c.action==="stop"){
          const closed=this.collector?.closePlanSessions?this.collector.closePlanSessions(job.plan_id):this.collector?.close();
          return closed?.then(()=>({ok:true}))??{ok:true};
        }
      }
    }
    return {ok:true};
  }
  async pauseAll() { this.guestInspection?.controller.abort(); for(const a of this.active.values()){a.pause=true;for(const interval of a.intervals)interval.abort();a.controller.abort();} await Promise.all([...this.active.values()].map(a=>a.promise)); await this.collector?.close(); }
  screening(id: string) {
    const job=this.job(id), plan=this.lab.plan(job.plan_id), brand=this.lab.brandForPlan(this.lab.planRow(job.plan_id));
    const domains=JSON.parse(brand.owned_domains) as string[];
    const rows=this.items(id).map(item=>{
      const slot=plan.slots.find(s=>s.id===item.slot_id)!;
      const a=slot.attempts.find(a=>a.id===item.attempt_id), c=a?.capture;
      const quality=a?.quality??null;
      const issues=quality?.reasons??[item.message||"尚无完整证据"];
      const readable=quality?.contentQualified===true;
      const mentioned=readable?mentionsBrand(c!.answer,[brand.name,...JSON.parse(brand.aliases) as string[]]):null;
      const cited=readable?c!.citations.some(link=>{ const url=normalizeSourceUrl(link.url);if(!url)return false;const h=normalizeDomain(url);return domains.some(d=>h===normalizeDomain(d)||h.endsWith('.'+normalizeDomain(d))); }):null;
      return {slotId:slot.id,prompt:slot.prompt,surface:slot.surface,window:slot.window,state:item.state,stage:item.stage,
        status:c?.status??null,attemptId:a?.id??null,evidenceHash:a?.hash??null,integrity:a?.integrity??null,
        review:a?.review?.decision??null,manualReview:a?.review??null,quality,contentQualified:readable,issues,eligible:quality?.metricEligible===true,
        brandMentioned:mentioned,ownedCitation:cited,citationCount:readable?c!.citations.length:null,
        category:!readable?"insufficient":cited?"owned_citation":mentioned?"brand_mention":"not_mentioned",
        nextAction:!a?"等待采样完成":quality?.manualDecision==="reject"?"已排除；保留人工退回记录":!readable?"已自动排除；查看采集质量原因":!quality?.metricEligible?"已排除出正式指标；保留条件差异":cited?"查看已引用页面与结果":mentioned?"查看品牌提及与链接差异":"查看实际引用页面与待验证内容假设"};
    });
    const report={schema:"browser-screening-v1",jobId:id,planId:plan.id,accountMode:plan.config.accountMode??"signed_out",brand:brand.name,total:rows.length,
      captured:rows.filter(r=>r.attemptId).length,checked:rows.filter(r=>r.quality).length,reviewed:rows.filter(r=>r.review).length,
      contentQualified:rows.filter(r=>r.contentQualified).length,eligible:rows.filter(r=>r.eligible).length,
      conditionExcluded:rows.filter(r=>r.contentQualified&&!r.eligible).length,
      scope:"全量自动质检；完整答案与来源可用于候选观察，正式品牌指标只纳入质量通过且采样条件匹配的记录，无须人工逐条确认。人工退回仍排除。未提及不是原因判断。本表不调用付费模型，不构成网站技术审计。",rows};
    return {...report,hash:sha256(canonicalJson(report))};
  }
}
