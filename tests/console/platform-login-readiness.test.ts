import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connectLedger } from "../../src/db/index.ts";
import { LabService } from "../../src/console/service.ts";
import { BrowserJobs, type BrowserCollector } from "../../src/console/browser-jobs.ts";
import { surfaces, type Capture, type PlanConfig, type SurfaceId } from "../../src/console/contracts.ts";

const key = () => randomUUID();
let root: string, lab: LabService, jobs: BrowserJobs;
let sessions: { planId: string; surface: string; verified: boolean }[];
let adapter: BrowserCollector;
function plan(platforms: SurfaceId[] = ["grok"], accountMode: PlanConfig["accountMode"] = "isolated", country = "CA") {
  const brandId = lab.createBrand(key(), { name: "Synthetic readiness", aliases: [], ownedDomains: ["readiness.example"] }).id;
  const promptSetId = lab.createSet(key(), { brandId, label: "Synthetic readiness", locale: "en-CA", source: "Synthetic login readiness verification only", kind: "hypothesis", prompts: [{ text: "Synthetic buyer question?", intent: "discovery" }] }).id;
  lab.freeze(key(), promptSetId);
  return lab.createPlan(key(), { promptSetId, label: "Synthetic readonly readiness", surfaces: platforms, accountMode,
    country, locale: "en-CA", timezone: "UTC", device: "desktop", windows: [new Date().toISOString().slice(0, 10)] }).id;
}
function wall(planId: string, surface: SurfaceId = "grok", restriction: Capture["restriction"] = "login") {
  const p = lab.plan(planId), s = p.slots.find(slot => slot.surface === surface)!;
  const data: Capture = { slotId: s.id, prompt: s.prompt, observedAt: new Date().toISOString(), status: "unavailable", restriction,
    reason: `Synthetic ${restriction} wall mentioning login`, answer: "", citations: [], sourceUrl: surfaces[surface].url,
    model: "unknown", account: "unknown", session: "unknown", exitCountry: null, geo: "unverified", locale: "en-CA", timezone: "UTC",
    device: "desktop", geolocation: "denied", searchMode: surfaces[surface].mode, collectionMode: "browser_capture", retrievalUsed: null,
    artifact: { mime: "text/plain", base64: Buffer.from("Synthetic immutable wall " + s.id).toString("base64") } };
  return lab.capture(key(), data);
}
function scope(planId: string, surface: SurfaceId = "grok") { return lab.scope(lab.plan(planId).slots.find(slot => slot.surface === surface)!); }
const row = (planId: string, surface: SurfaceId = "grok") => jobs.loginReadiness(planId).platforms.find(item => item.surface === surface)!;
function preserved() { return {
  attempts: lab.db.prepare("SELECT * FROM console_attempt ORDER BY rowid").all(),
  restrictions: lab.db.prepare("SELECT * FROM console_restriction ORDER BY rowid").all(),
  plans: lab.db.prepare("SELECT * FROM console_plan ORDER BY rowid").all(),
  queue: lab.db.prepare("SELECT * FROM console_browser_item ORDER BY rowid").all(),
  commands: lab.db.prepare("SELECT * FROM console_command ORDER BY rowid").all(),
}; }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "platform-login-readiness-"));
  lab = new LabService(connectLedger(join(root, "ledger.db"))); sessions = [];
  adapter = { available: () => ({ available: true, message: "Synthetic collector" }), collect: vi.fn(),
    show: vi.fn(async () => {}), close: vi.fn(async () => {}), prepareSession: vi.fn(async () => ({ opened: true })),
    verifySession: vi.fn(async () => ({ verified: true })), sessions: () => sessions,
    ready: (id, required) => required.every(surface => sessions.some(session => session.planId === id && session.surface === surface && session.verified)) };
  jobs = new BrowserJobs(lab, adapter);
});
afterEach(() => { lab.db.close(); rmSync(root, { recursive: true, force: true }); });

describe("read-only platform login readiness", () => {
  it("keeps isolated platforms optional until intact evidence proves a login wall, without changing the ledger or opening a browser", () => {
    const id = plan(["grok", "perplexity"]), frozen = preserved();
    expect(jobs.loginReadiness(id)).toMatchObject({ planId: id, accountMode: "isolated", ready: true, samplingActive: false });
    expect(row(id)).toMatchObject({ status: "optional", required: false, canConfigure: true, sessionOpen: false, confirmed: false });
    const saved = wall(id), before = preserved();
    expect(row(id)).toMatchObject({ status: "login_required", required: true, needsNewPlan: false, restriction: { active: true, type: "login", evidence: { attemptId: saved.id, sourcePlanId: id } } });
    expect(row(id, "perplexity")).toMatchObject({ status: "optional", required: false });
    expect(jobs.loginReadiness(id).ready).toBe(false);
    expect(preserved()).toEqual(before); expect(before.plans).toEqual(frozen.plans);
    expect(adapter.collect).not.toHaveBeenCalled(); expect(adapter.prepareSession).not.toHaveBeenCalled(); expect(adapter.verifySession).not.toHaveBeenCalled(); expect(adapter.close).not.toHaveBeenCalled();
  });
  it("requires every entry on a signed-in private plan and confirms only matching live sessions", () => {
    const id = plan(["chatgpt_search", "google_aio"], "signed_in_private");
    expect(jobs.loginReadiness(id).platforms.every(item => item.status === "not_configured" && item.required)).toBe(true);
    sessions.push({ planId: key(), surface: "chatgpt_search", verified: true }, { planId: id, surface: "chatgpt_search", verified: false });
    expect(row(id, "chatgpt_search")).toMatchObject({ status: "awaiting_confirmation", confirmed: false, canConfigure: false });
    expect(row(id, "google_aio")).toMatchObject({ status: "not_configured", confirmed: false });
    sessions = [{ planId: id, surface: "chatgpt_search", verified: true }];
    expect(row(id, "chatgpt_search").status).toBe("confirmed"); expect(jobs.loginReadiness(id).ready).toBe(false);
    sessions.push({ planId: id, surface: "google_aio", verified: true });
    expect(jobs.loginReadiness(id).ready).toBe(true);
    adapter.ready = () => false;
    expect(row(id, "chatgpt_search")).toMatchObject({ status: "awaiting_confirmation", confirmed: false });
  });
  it("keeps the immutable login record after a release and reminds configuration again when its in-memory session closes or the collector restarts", () => {
    const id = plan(), saved = wall(id);
    lab.release(key(), { scope: scope(id), reason: "Synthetic explicit release preserving the original login record" });
    sessions = [{ planId: id, surface: "grok", verified: true }];
    const before = preserved();
    expect(row(id)).toMatchObject({ status: "confirmed", required: true, restriction: { active: false }, previousLoginEvidence: { attemptId: saved.id } });
    sessions = [];
    expect(row(id)).toMatchObject({ status: "not_configured", required: true, confirmed: false });
    expect(row(id).reason).toContain("重新配置");
    jobs = new BrowserJobs(lab, adapter);
    expect(row(id)).toMatchObject({ status: "not_configured", required: true }); expect(preserved()).toEqual(before);
  });
  it("requires a new isolated plan for a signed-out login wall and never mutates the frozen account mode", () => {
    const id = plan(["grok"], "signed_out"); expect(row(id)).toMatchObject({ status: "optional", canConfigure: false });
    wall(id); const before = preserved();
    expect(row(id)).toMatchObject({ status: "login_required", required: true, needsNewPlan: true, canConfigure: false });
    expect(row(id).reason).toContain("新建独立会话计划"); expect(preserved()).toEqual(before);
  });
  it.each(["captcha", "rate_limit", "region"] as const)("labels an actual %s capture as another restriction even when the reason mentions login", restriction => {
    const id = plan(); wall(id, "grok", restriction); const before = preserved();
    expect(row(id)).toMatchObject({ status: "restricted", required: false, restriction: { type: restriction } });
    expect(row(id).reason).toContain("登录配置不能解除"); expect(preserved()).toEqual(before);
  });
  it("gives the latest non-login stop priority over historical login evidence without erasing the history", () => {
    const id = plan(), login = wall(id);
    lab.release(key(), { scope: scope(id), reason: "Synthetic explicit release to record a later access condition" });
    wall(id, "grok", "captcha");
    expect(row(id)).toMatchObject({ status: "restricted", restriction: { type: "captcha" }, previousLoginEvidence: { attemptId: login.id } });
    expect(row(id).reason).not.toContain("重新配置登录");
  });
  it("does not guess from reason-only records and rejects corrupted capture artifacts", () => {
    const id = plan(), saved = wall(id);
    const hash = lab.plan(id).slots[0]!.latest!.capture.artifactHash!;
    lab.db.exec("DROP TRIGGER console_artifact_immutable_UPDATE");
    lab.db.prepare("UPDATE console_artifact SET bytes=? WHERE hash=?").run(Buffer.from("Synthetic corruption"), hash);
    expect(row(id)).toMatchObject({ status: "restricted", required: false, restriction: { type: null, evidence: null }, previousLoginEvidence: null });
    lab.db.prepare("INSERT INTO console_restriction(id,scope,action,reason) VALUES(?,?,?,?)").run(key(), scope(id), "stop", "login: Synthetic unlinked reason");
    expect(row(id)).toMatchObject({ status: "restricted", required: false, restriction: { type: null } });
    expect(saved.id).toBeTruthy();
  });
  it("never treats a login attempt from a different isolated plan or country scope as evidence for this plan", () => {
    const current = plan(), other = plan(), saved = wall(other);
    lab.db.prepare("INSERT INTO console_restriction(id,scope,action,reason,attempt_id) VALUES(?,?,?,?,?)").run(key(), scope(current), "stop", "login: Synthetic wrong-plan reference", saved.id);
    expect(row(current)).toMatchObject({ status: "restricted", required: false, restriction: { type: null, evidence: null } });
    const otherCountry = plan(["grok"], "signed_out", "US"), foreign = wall(otherCountry);
    const signedOut = plan(["grok"], "signed_out", "CA");
    lab.db.prepare("INSERT INTO console_restriction(id,scope,action,reason,attempt_id) VALUES(?,?,?,?,?)").run(key(), scope(signedOut), "stop", "login: Synthetic wrong-country reference", foreign.id);
    expect(row(signedOut)).toMatchObject({ status: "restricted", needsNewPlan: false, restriction: { type: null } });
  });
  it("applies a genuine shared signed-out scope login stop but never borrows history into a fresh isolated plan", () => {
    const source = plan(["grok"], "signed_out"), saved = wall(source);
    const sameScope = plan(["grok"], "signed_out"), independent = plan();
    expect(row(sameScope)).toMatchObject({ status: "login_required", needsNewPlan: true, restriction: { evidence: { attemptId: saved.id, sourcePlanId: source } }, previousLoginEvidence: null });
    expect(row(independent)).toMatchObject({ status: "optional", required: false, previousLoginEvidence: null });
  });
  it("does not configure during active sampling or when the collector is unavailable, and counts only this plan's blocked slots", () => {
    const id = plan(); jobs.active.set("synthetic-gate", { pause: false, controller: new AbortController(), promise: Promise.resolve(), intervals: new Set() });
    const job = jobs.create(key(), { planId: id, transmissionAcknowledged: true, intervalSeconds: 5 });
    lab.db.prepare("UPDATE console_browser_item SET state='blocked' WHERE job_id=?").run(job.id);
    expect(row(id)).toMatchObject({ status: "optional", canConfigure: false, blockedCount: 1 });
    expect(row(id).reason).toContain("暂停"); jobs.active.clear();
    expect(row(id).canConfigure).toBe(true);
    jobs = new BrowserJobs(lab);
    expect(row(id)).toMatchObject({ canConfigure: false }); expect(jobs.loginReadiness(id).sessionInspectionAvailable).toBe(false);
  });
});
