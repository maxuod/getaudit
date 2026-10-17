import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connectLedger } from "../../src/db/index.ts";
import { LabService } from "../../src/console/service.ts";
import { BrowserJobs, type BrowserCollector, type BrowserTask } from "../../src/console/browser-jobs.ts";
import { surfaces, type Capture, type PlanConfig, type SurfaceId } from "../../src/console/contracts.ts";

const key = () => randomUUID();
const newSurfaces: SurfaceId[] = ["bing_copilot", "perplexity", "grok"];
let root: string, lab: LabService, jobs: BrowserJobs, calls: BrowserTask[], prepared: Set<string>, verified: Set<string>;
let verifyFailure: boolean, verifyResult: boolean;
const identity = (planId: string, surface: SurfaceId) => `${planId}:${surface}`;
function plan(count: number, platforms: SurfaceId[], accountMode: PlanConfig["accountMode"] = "isolated") {
  const brandId = lab.createBrand(key(), { name: "Synthetic Northstar", aliases: [], ownedDomains: ["northstar.example"] }).id;
  const promptSetId = lab.createSet(key(), { brandId, label: "Synthetic session recovery", locale: "en-CA", source: "Synthetic isolated tests only", kind: "hypothesis", prompts: Array.from({ length: count }, (_, i) => ({ text: `Synthetic recovery question ${i + 1}?`, intent: "discovery" })) }).id;
  lab.freeze(key(), promptSetId);
  return lab.createPlan(key(), { promptSetId, label: "Synthetic login recovery", surfaces: platforms, accountMode, country: "CA", locale: "en-CA", timezone: "UTC", device: "desktop", windows: [new Date().toISOString().slice(0, 10)] }).id;
}
function queued(count: number, platforms: SurfaceId[]) {
  const planId = plan(count, platforms);
  jobs.active.set("synthetic-dispatch-gate", { pause: false, controller: new AbortController(), promise: Promise.resolve(), intervals: new Set() });
  const job = jobs.create(key(), { planId, transmissionAcknowledged: true, intervalSeconds: 5 });
  jobs.active.clear();
  return { planId, jobId: job.id };
}
function capture(slotId: string, extra: Partial<Capture> = {}): Capture {
  const slot = lab.slot(slotId), p = lab.plan(slot.plan_id).slots.find(s => s.id === slotId)!;
  return {
    slotId, prompt: p.prompt, observedAt: new Date().toISOString(), status: "observed", restriction: "none", reason: "",
    answer: "Synthetic Northstar completed scheduling answer.", citations: [{ url: "https://northstar.example/guide" }], model: "synthetic",
    sourceUrl: surfaces[slot.surface].url, account: "logged_out", session: "fresh", exitCountry: "CA", geo: "ip_observed", locale: "en-CA", timezone: "UTC", device: "desktop", geolocation: "denied", searchMode: surfaces[slot.surface].mode, collectionMode: "browser_capture", retrievalUsed: true,
    privacy: { mode: "signed_out", temporaryChat: "not_applicable", personalization: "unknown", newConversation: true },
    browser: { name: "Google Chrome", version: "synthetic", extractorVersion: "recovery-test", answerComplete: true, citationsComplete: true, notes: ["Synthetic test only"] },
    artifact: { mime: "text/plain", base64: Buffer.from("Synthetic recovery evidence " + slotId).toString("base64") }, ...extra,
  };
}
function items(jobId: string, surface: SurfaceId) { return jobs.items(jobId).filter(i => lab.slot(i.slot_id).surface === surface); }
function restrictionScope(jobId: string, surface: SurfaceId) { return lab.scope(lab.slot(items(jobId, surface)[0]!.slot_id)); }
function state(itemId: string, next: string, stage = "") { lab.db.prepare("UPDATE console_browser_item SET state=?,stage=?,message='Synthetic original item state' WHERE id=?").run(next, stage, itemId); }
function wall(jobId: string, surface: SurfaceId, index = 0, restriction: Capture["restriction"] = "login") {
  const item = items(jobId, surface)[index]!;
  const attempt = lab.capture(key(), capture(item.slot_id, { status: "unavailable", restriction, reason: `Synthetic ${restriction} wall`, answer: "", citations: [], account: "unknown", browser: { name: "Google Chrome", version: "synthetic", extractorVersion: "recovery-test", answerComplete: false, citationsComplete: false, notes: ["Synthetic test only"] } }));
  lab.db.prepare("UPDATE console_browser_item SET state='captured',stage='saved',attempt_id=? WHERE id=?").run(attempt.id, item.id);
  for (const pending of items(jobId, surface).filter(i => i.state === "pending")) state(pending.id, "blocked");
  jobs.setStatus(jobId, "needs_attention", "Synthetic login wall retains original evidence");
  return attempt;
}
async function verify(planId: string, surface: SurfaceId) {
  await jobs.sessionControl({ planId, surface, action: "open" });
  return jobs.sessionControl({ planId, surface, action: "verify" });
}
const attempts = () => lab.db.prepare("SELECT * FROM console_attempt ORDER BY rowid").all();
const restrictions = () => lab.db.prepare("SELECT * FROM console_restriction ORDER BY rowid").all();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "platform-session-recovery-")); lab = new LabService(connectLedger(join(root, "ledger.db")));
  calls = []; prepared = new Set(); verified = new Set(); verifyFailure = false; verifyResult = true;
  const collector: BrowserCollector = {
    available: () => ({ available: true, message: "Synthetic dedicated session" }),
    collect: async task => { calls.push(task); return capture(task.slotId, { account: "logged_in", session: "active", privacy: { mode: "signed_in_independent", temporaryChat: "unknown", personalization: "unknown", newConversation: true } }); },
    show: async () => {}, close: async () => { prepared.clear(); verified.clear(); },
    ready: (id, platforms) => platforms.every(s => verified.has(identity(id, s as SurfaceId))),
    prepareSession: async task => { prepared.add(identity(task.planId, task.surface)); return { opened: true }; },
    verifySession: async (id, surface) => {
      if (!prepared.has(identity(id, surface))) throw new Error("Synthetic session not prepared");
      if (verifyFailure) throw new Error("Synthetic login not confirmed");
      if (verifyResult) verified.add(identity(id, surface));
      return { verified: verifyResult, note: "Synthetic verified dedicated login" };
    },
  };
  jobs = new BrowserJobs(lab, collector, async () => {});
});
afterEach(async () => { await jobs.pauseAll(); lab.db.close(); rmSync(root, { recursive: true, force: true }); });

describe("verified independent login recovery", () => {
  it.each(newSurfaces)("%s: releases only the saved login wall and continues remaining unsent work on explicit resume", async surface => {
    const { planId, jobId } = queued(2, [surface]);
    const saved = wall(jobId, surface), beforeAttempts = attempts(), beforeRestrictions = restrictions();
    const result = await verify(planId, surface);
    expect(result).toMatchObject({ verified: true, recovered: 1, restrictionReleased: true });
    expect(calls).toHaveLength(0);
    expect(jobs.job(jobId).status).toBe("paused");
    expect(items(jobId, surface).map(i => i.state)).toEqual(["captured", "pending"]);
    expect(attempts()).toEqual(beforeAttempts);
    expect(restrictions().slice(0, beforeRestrictions.length)).toEqual(beforeRestrictions);
    expect(restrictions()).toHaveLength(beforeRestrictions.length + 1);
    expect(restrictions().at(-1)).toMatchObject({ action: "release", attempt_id: null });
    expect(String(restrictions().at(-1)!.reason)).toContain(saved.id);
    expect(String(restrictions().at(-1)!.reason)).toContain("原受限记录");
    expect(await jobs.sessionControl({ planId, surface, action: "verify" })).toMatchObject({ recovered: 0, restrictionReleased: false });
    expect(restrictions()).toHaveLength(beforeRestrictions.length + 1);
    jobs.resume(jobId); await jobs.active.get(jobId)?.promise;
    expect(calls).toHaveLength(1); expect(calls[0]!.slotId).toBe(items(jobId, surface)[1]!.slot_id);
    expect(attempts().slice(0, beforeAttempts.length)).toEqual(beforeAttempts);
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_review").get()).toEqual({ n: 0 });
  });

  it("preserves other plans/providers, captured failures, outside captures and committed/unknown positions through Continue", async () => {
    const current = queued(6, ["bing_copilot", "grok"]), other = queued(2, ["bing_copilot"]);
    const same = items(current.jobId, "bing_copilot");
    // Existing evidence collected outside this queue must never be replayed.
    lab.capture(key(), capture(same[4]!.slot_id));
    wall(current.jobId, "grok", 0, "captcha");
    wall(current.jobId, "bing_copilot");
    state(same[2]!.id, "blocked", "waiting");
    state(same[3]!.id, "uncertain", "waiting");
    state(same[5]!.id, "pending", "submitting");
    for (const item of items(other.jobId, "bing_copilot")) state(item.id, "blocked");
    const beforeOther = jobs.items(other.jobId), beforeGrok = items(current.jobId, "grok"), beforeAttempts = attempts(), beforeRestrictions = restrictions();
    const protectedItems = [jobs.items(current.jobId).find(i => i.id === same[0]!.id)!, jobs.items(current.jobId).find(i => i.id === same[2]!.id)!, jobs.items(current.jobId).find(i => i.id === same[3]!.id)!, jobs.items(current.jobId).find(i => i.id === same[4]!.id)!];
    expect(await verify(other.planId, "bing_copilot")).toMatchObject({ recovered: 0, restrictionReleased: false });
    expect(restrictions()).toEqual(beforeRestrictions);
    expect(await verify(current.planId, "bing_copilot")).toMatchObject({ recovered: 1, restrictionReleased: true });
    expect(calls).toHaveLength(0);
    expect(jobs.job(current.jobId).status).toBe("needs_attention");
    expect(jobs.items(other.jobId)).toEqual(beforeOther);
    expect(items(current.jobId, "grok")).toEqual(beforeGrok);
    for (const item of protectedItems) expect(jobs.items(current.jobId).find(i => i.id === item.id)).toEqual(item);
    jobs.resume(current.jobId); await jobs.active.get(current.jobId)?.promise;
    expect(calls.map(c => c.slotId)).toEqual([same[1]!.slot_id]);
    for (const item of protectedItems) expect(jobs.items(current.jobId).find(i => i.id === item.id)).toEqual(item);
    expect(jobs.items(current.jobId).find(i => i.id === same[5]!.id)).toMatchObject({ state: "uncertain", stage: "submitting", message: "此位置保留已提交检查点，结果未知；未自动重发" });
    expect(jobs.items(other.jobId)).toEqual(beforeOther);
    expect(items(current.jobId, "grok")).toEqual(beforeGrok);
    expect(attempts().slice(0, beforeAttempts.length)).toEqual(beforeAttempts);
    expect(restrictions().slice(0, beforeRestrictions.length)).toEqual(beforeRestrictions);
    expect(lab.restriction(restrictionScope(current.jobId, "grok"))).toMatchObject({ action: "stop" });
  });

  it("isolates identical provider/country login restrictions between separate plans", async () => {
    const current = queued(2, ["bing_copilot"]), other = queued(2, ["bing_copilot"]);
    const currentScope = restrictionScope(current.jobId, "bing_copilot"), otherScope = restrictionScope(other.jobId, "bing_copilot");
    expect(currentScope).toBe(`bing_copilot:CA:isolated:${current.planId}`);
    expect(otherScope).toBe(`bing_copilot:CA:isolated:${other.planId}`);
    expect(currentScope).not.toBe(otherScope);
    wall(current.jobId, "bing_copilot");
    // This same-provider capture is independently allowed despite current's stop.
    wall(other.jobId, "bing_copilot", 0, "captcha");
    const otherRestriction = lab.restriction(otherScope), otherItems = jobs.items(other.jobId), saved = attempts();
    expect(await verify(current.planId, "bing_copilot")).toMatchObject({ recovered: 1, restrictionReleased: true });
    expect(lab.restriction(currentScope)).toMatchObject({ action: "release" });
    expect(lab.restriction(otherScope)).toEqual(otherRestriction);
    expect(lab.restriction(otherScope)).toMatchObject({ action: "stop", reason: "captcha: Synthetic captcha wall" });
    expect(jobs.items(other.jobId)).toEqual(otherItems); expect(attempts()).toEqual(saved);
    expect(calls).toHaveLength(0);
  });

  it.each(["captcha", "rate_limit", "region"] as const)("never clears a %s stop after login verification", async restriction => {
    const { planId, jobId } = queued(2, ["bing_copilot"]); wall(jobId, "bing_copilot", 0, restriction);
    const saved = { attempts: attempts(), restrictions: restrictions(), items: jobs.items(jobId), job: jobs.job(jobId) };
    expect(await verify(planId, "bing_copilot")).toMatchObject({ verified: true, recovered: 0, restrictionReleased: false });
    expect(attempts()).toEqual(saved.attempts); expect(restrictions()).toEqual(saved.restrictions); expect(jobs.items(jobId)).toEqual(saved.items); expect(jobs.job(jobId)).toEqual(saved.job);
    expect(calls).toHaveLength(0);
  });

  it("keeps the latest non-login stop even when older immutable login evidence exists", async () => {
    const { planId, jobId } = queued(3, ["perplexity"]); wall(jobId, "perplexity");
    lab.release(key(), { scope: restrictionScope(jobId, "perplexity"), reason: "Synthetic setup permits recording later CAPTCHA evidence" });
    wall(jobId, "perplexity", 1, "captcha");
    const savedRestrictions = restrictions(), savedItems = jobs.items(jobId);
    expect(await verify(planId, "perplexity")).toMatchObject({ recovered: 0, restrictionReleased: false });
    expect(restrictions()).toEqual(savedRestrictions); expect(jobs.items(jobId)).toEqual(savedItems);
  });

  it("requires intact saved login evidence and does not infer a release from a free-text stop reason", async () => {
    const { planId, jobId } = queued(2, ["grok"]); const attempt = wall(jobId, "grok");
    const hash = lab.plan(planId).slots.find(s => s.id === items(jobId, "grok")[0]!.slot_id)!.latest!.capture.artifactHash!;
    lab.db.exec("DROP TRIGGER console_artifact_immutable_UPDATE"); lab.db.prepare("UPDATE console_artifact SET bytes=? WHERE hash=?").run(Buffer.from("Synthetic altered original"), hash);
    const savedRestrictions = restrictions(), savedItems = jobs.items(jobId);
    expect(await verify(planId, "grok")).toMatchObject({ recovered: 0, restrictionReleased: false });
    expect(restrictions()).toEqual(savedRestrictions); expect(jobs.items(jobId)).toEqual(savedItems);
    expect(lab.plan(planId).slots.find(s => s.id === items(jobId, "grok")[0]!.slot_id)!.latest).toMatchObject({ id: attempt.id, integrity: false });
    lab.db.prepare("INSERT INTO console_restriction(id,scope,action,reason) VALUES(?,?,?,?)").run(key(), restrictionScope(jobId, "grok"), "stop", "login: Synthetic stop without evidence identity");
    const rows = restrictions();
    expect(await jobs.sessionControl({ planId, surface: "grok", action: "verify" })).toMatchObject({ recovered: 0, restrictionReleased: false });
    expect(restrictions()).toEqual(rows);
  });

  it("does not mutate restrictions or queue states when login confirmation fails or reports unverified", async () => {
    const { planId, jobId } = queued(2, ["perplexity"]); wall(jobId, "perplexity");
    const rows = restrictions(), queue = jobs.items(jobId);
    await jobs.sessionControl({ planId, surface: "perplexity", action: "open" }); verifyFailure = true;
    await expect(jobs.sessionControl({ planId, surface: "perplexity", action: "verify" })).rejects.toThrow("Synthetic login not confirmed");
    verifyFailure = false; verifyResult = false;
    expect(await jobs.sessionControl({ planId, surface: "perplexity", action: "verify" })).toEqual({ verified: false, note: "Synthetic verified dedicated login" });
    expect(restrictions()).toEqual(rows); expect(jobs.items(jobId)).toEqual(queue); expect(calls).toHaveLength(0);
  });

  it("does not restore a blocked continuation source position", async () => {
    const source = queued(2, ["bing_copilot"]), target = queued(2, ["bing_copilot"]);
    wall(source.jobId, "bing_copilot"); const sourceItem = items(source.jobId, "bing_copilot")[1]!, targetItem = items(target.jobId, "bing_copilot")[1]!;
    lab.db.prepare("INSERT INTO console_browser_continuation(source_item_id,target_item_id) VALUES(?,?)").run(sourceItem.id, targetItem.id);
    expect(await verify(source.planId, "bing_copilot")).toMatchObject({ recovered: 0, restrictionReleased: true });
    expect(jobs.items(source.jobId).find(i => i.id === sourceItem.id)!.state).toBe("blocked");
    expect(calls).toHaveLength(0);
  });

  it("preserves strict signed-out/private preparation behavior without automatic restriction releases", async () => {
    const signedOut = plan(1, ["bing_copilot"], "signed_out");
    await expect(jobs.sessionControl({ planId: signedOut, surface: "bing_copilot", action: "open" })).rejects.toThrow("当前计划没有启用此登录态入口");
    const privatePlan = plan(1, ["chatgpt_search"], "signed_in_private"), slot = lab.plan(privatePlan).slots[0]!;
    lab.capture(key(), capture(slot.id, { status: "unavailable", restriction: "login", answer: "", citations: [], reason: "Synthetic strict private login wall" }));
    const rows = restrictions();
    expect(lab.scope(lab.slot(slot.id))).toBe("chatgpt_search:CA:signed-out");
    expect(lab.scope(lab.slot(lab.plan(signedOut).slots[0]!.id))).toBe("bing_copilot:CA:signed-out");
    expect(await verify(privatePlan, "chatgpt_search")).toEqual({ verified: true, note: "Synthetic verified dedicated login" });
    expect(restrictions()).toEqual(rows); expect(calls).toHaveLength(0);
  });
});
