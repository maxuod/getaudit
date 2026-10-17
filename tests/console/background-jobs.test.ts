import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { connectLedger } from "../../src/db/index.ts";
import { LabService } from "../../src/console/service.ts";
import { BrowserJobs, type BrowserCollector, type GuestReadinessTask } from "../../src/console/browser-jobs.ts";
import { surfaces, type Capture, type PlanConfig, type SurfaceId } from "../../src/console/contracts.ts";

let lab: LabService, jobs: BrowserJobs, adapter: BrowserCollector;
const key = () => randomUUID();
function plan(count = 2, platforms: SurfaceId[] = ["chatgpt_search"], accountMode: PlanConfig["accountMode"] = "signed_out") {
  const brandId = lab.createBrand(key(), { name: "Synthetic background", aliases: [], ownedDomains: ["background.example"] }).id;
  const promptSetId = lab.createSet(key(), { brandId, label: "Background fixture", source: "Synthetic test; no provider traffic", kind: "hypothesis", locale: "en-CA",
    prompts: Array.from({ length: count }, (_, index) => ({ text: `Synthetic background question ${index + 1}?`, intent: "discovery" })) }).id;
  lab.freeze(key(), promptSetId);
  return lab.createPlan(key(), { promptSetId, label: "Background fixture", surfaces: platforms, accountMode,
    ...(accountMode === "signed_out" ? { guestPolicy: "no_login_v1" } : {}), country: "CA", locale: "en-CA", timezone: "UTC", device: "desktop", windows: [new Date().toISOString().slice(0, 10)] }).id;
}
function queued(planId: string, mode: "visible" | "silent" = "visible") {
  jobs.active.set("synthetic-queue-gate", { pause: false, controller: new AbortController(), intervals: new Set(), promise: Promise.resolve() });
  const result = jobs.create(key(), { planId, transmissionAcknowledged: true, browserMode: mode }); jobs.active.clear();
  return result;
}
function capture(planId: string, item: ReturnType<BrowserJobs["items"]>[number], extra: Partial<Capture> = {}): Capture {
  const slot = lab.plan(planId).slots.find(row => row.id === item.slot_id)!;
  return { slotId: slot.id, prompt: slot.prompt, observedAt: new Date().toISOString(), status: "observed", restriction: "none", reason: "Synthetic fixture",
    answer: "Synthetic background answer.", citations: [], model: "synthetic", sourceUrl: surfaces[slot.surface].url, account: "logged_out", session: "fresh",
    exitCountry: null, geo: "unverified", locale: "en-CA", timezone: "UTC", device: "desktop", geolocation: "denied", searchMode: surfaces[slot.surface].mode,
    collectionMode: "browser_capture", retrievalUsed: null, artifact: { mime: "text/plain", base64: Buffer.from("Synthetic fixture " + slot.id).toString("base64") }, ...extra };
}
function entry(task: GuestReadinessTask) {
  return { checkedAt: new Date().toISOString(), status: "ready" as const, restriction: "none" as const, account: "logged_out" as const,
    sourceUrl: surfaces[task.surface].url, reason: "Synthetic entry only", answer: "not_tested" as const, citations: "not_tested" as const, browserMode: task.browserMode };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
  lab = new LabService(connectLedger(":memory:"));
  adapter = { available: () => ({ available: true, message: "Synthetic" }), collect: vi.fn(), show: vi.fn(async () => {}), close: vi.fn(async () => {}), sessions: () => [], inspectGuest: vi.fn(async task => entry(task)) };
  jobs = new BrowserJobs(lab, adapter, async () => {});
});
afterEach(async () => { await jobs.pauseAll(); lab.db.close(); vi.useRealTimers(); });

describe("background browser jobs", () => {
  it("requests background entry checks by default and records only the adapter's actual mode", async () => {
    const id = plan();
    const result = await jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search" });
    expect(vi.mocked(adapter.inspectGuest!).mock.calls[0]![0].browserMode).toBe("silent");
    expect(result.platforms[0]!.latest).toMatchObject({ status: "ready", browserMode: "silent" });
    adapter.inspectGuest = vi.fn(async task => ({ ...entry(task), browserMode: "visible" }));
    const mismatch = await jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search" });
    expect(mismatch.platforms[0]!.latest).toMatchObject({ status: "unknown", browserMode: "visible", reason: expect.stringContaining("different browser mode") });
    expect(adapter.collect).not.toHaveBeenCalled(); expect(adapter.show).not.toHaveBeenCalled();
  });

  it("keeps historical entry modes unknown instead of relabeling them as background", async () => {
    const id = plan(), row = lab.planRow(id), observation = entry({ planId: id, surface: "chatgpt_search", config: lab.plan(id).config, browserMode: "visible" });
    const { browserMode: _mode, ...legacy } = observation;
    const stored = JSON.stringify(legacy);
    lab.db.prepare("INSERT INTO console_browser_guest_check(id,plan_id,surface,config_hash,result_json) VALUES(?,?,?,?,?)").run(key(), id, "chatgpt_search", row.config_hash, stored);
    expect(jobs.guestReadiness(id).platforms[0]!.latest).not.toHaveProperty("browserMode");
    expect(lab.db.prepare("SELECT result_json FROM console_browser_guest_check").get()).toEqual({ result_json: stored });
    adapter.inspectGuest = vi.fn(async task => { const { browserMode: _requested, ...unknown } = entry(task); return unknown; });
    expect((await jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search" })).platforms[0]!.latest).not.toHaveProperty("browserMode");
  });

  it("explicitly continues only safe current-day positions in a new background job with frozen history", () => {
    const planId = plan(4, ["chatgpt_search", "gemini"]), original = queued(planId), items = jobs.items(original.id);
    const chatgpt = items.filter(item => lab.slot(item.slot_id).surface === "chatgpt_search"), gemini = items.filter(item => lab.slot(item.slot_id).surface === "gemini");
    const saved = lab.capture(key(), capture(planId, chatgpt[0]!));
    lab.db.prepare("UPDATE console_browser_item SET state='captured',stage='saved',attempt_id=? WHERE id=?").run(saved.id, chatgpt[0]!.id);
    lab.db.prepare("UPDATE console_browser_item SET state='uncertain',stage='waiting' WHERE id=?").run(chatgpt[1]!.id);
    lab.db.prepare("UPDATE console_browser_item SET stage='submitting' WHERE id=?").run(chatgpt[2]!.id);
    const stopped = lab.capture(key(), capture(planId, gemini[0]!, { status: "unavailable", restriction: "captcha", answer: "", reason: "Synthetic CAPTCHA" }));
    lab.db.prepare("UPDATE console_browser_item SET state='captured',stage='saved',attempt_id=? WHERE id=?").run(stopped.id, gemini[0]!.id);
    for (const item of gemini.slice(1)) lab.db.prepare("UPDATE console_browser_item SET state='blocked' WHERE id=?").run(item.id);
    const attempts = lab.db.prepare("SELECT * FROM console_attempt ORDER BY rowid").all(), stops = lab.db.prepare("SELECT * FROM console_restriction ORDER BY rowid").all();
    const frozenJob = jobs.job(original.id).config_json, frozenPlan = lab.planRow(planId).config_json;
    const start = vi.spyOn(jobs, "start").mockImplementation(() => {});
    const next = jobs.control({ id: original.id, action: "resume", browserMode: "silent" }) as ReturnType<BrowserJobs["resume"]>;
    expect(next).toMatchObject({ continued: 1 }); expect(next.id).not.toBe(original.id);
    expect(jobs.job(next.id).config.browserMode).toBe("silent"); expect(lab.plan(next.planId).config.surfaces).toEqual(["chatgpt_search"]);
    expect(jobs.items(original.id).find(item => item.id === chatgpt[3]!.id)?.state).toBe("carried_forward");
    expect(jobs.items(original.id).find(item => item.id === chatgpt[1]!.id)?.state).toBe("uncertain");
    expect(jobs.items(original.id).filter(item => item.state === "blocked")).toHaveLength(3);
    expect(jobs.job(original.id).config_json).toBe(frozenJob); expect(lab.planRow(planId).config_json).toBe(frozenPlan);
    expect(lab.db.prepare("SELECT * FROM console_attempt ORDER BY rowid").all()).toEqual(attempts);
    expect(lab.db.prepare("SELECT * FROM console_restriction ORDER BY rowid").all()).toEqual(stops);
    expect(jobs.resume(original.id, { browserMode: "silent" }).id).toBe(next.id);
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_browser_continuation").get()).toEqual({ n: 1 });
    expect(adapter.collect).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledTimes(2);
  });

  it("converts expired visible work explicitly while ordinary continuation keeps its recorded mode", () => {
    const first = queued(plan(1)), second = queued(plan(1));
    const start = vi.spyOn(jobs, "start").mockImplementation(() => {});
    vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
    const background = jobs.resume(first.id, { browserMode: "silent" }), unchanged = jobs.resume(second.id);
    expect(jobs.job(background.id).config.browserMode).toBe("silent"); expect(jobs.job(unchanged.id).config.browserMode).toBe("visible");
    expect(lab.plan(background.planId).slots[0]!.window).toBe("2026-10-16"); expect(start).toHaveBeenCalledTimes(2);
  });

  it("defaults public resume controls to a new background continuation without rewriting a visible batch", () => {
    const planId = plan(1), original = queued(planId), frozen = jobs.job(original.id).config_json;
    vi.spyOn(jobs, "start").mockImplementation(() => {});
    const next = jobs.control({ id: original.id, action: "resume" }) as ReturnType<BrowserJobs["resume"]>;
    expect(next).toMatchObject({ continued: 1 }); expect(next.id).not.toBe(original.id);
    expect(jobs.job(next.id).config.browserMode).toBe("silent");
    expect(jobs.job(original.id).config_json).toBe(frozen);
    expect(jobs.control({ id: original.id, action: "resume" })).toMatchObject({ id: next.id });
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_browser_continuation").get()).toEqual({ n: 1 });
    expect(adapter.collect).not.toHaveBeenCalled(); expect(adapter.show).not.toHaveBeenCalled();
  });

  it("requires active visible work to finish pausing before any mode conversion", () => {
    const original = queued(plan()); jobs.setStatus(original.id, "running");
    jobs.active.set(original.id, { pause: false, controller: new AbortController(), intervals: new Set(), promise: Promise.resolve() });
    expect(() => jobs.resume(original.id, { browserMode: "silent" })).toThrow("Pause this batch");
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_browser_job").get()).toEqual({ n: 1 }); jobs.active.clear();
    expect(() => jobs.control({ id: original.id, action: "show", browserMode: "silent" })).toThrow(); expect(adapter.show).not.toHaveBeenCalled();
  });

  it("does not move an isolated platform's stopped work into an unrestricted new scope", () => {
    const planId = plan(2, ["chatgpt_search", "gemini"], "isolated"), original = queued(planId);
    const chatgpt = jobs.items(original.id).find(item => lab.slot(item.slot_id).surface === "chatgpt_search")!;
    lab.capture(key(), capture(planId, chatgpt, { status: "unavailable", restriction: "login", answer: "", reason: "Synthetic isolated login wall" }));
    const stops = lab.db.prepare("SELECT * FROM console_restriction ORDER BY rowid").all();
    vi.spyOn(jobs, "start").mockImplementation(() => {});
    const next = jobs.resume(original.id, { browserMode: "silent" });
    expect(next.continued).toBe(2); expect(lab.plan(next.planId).config.surfaces).toEqual(["gemini"]);
    expect(lab.db.prepare("SELECT * FROM console_restriction ORDER BY rowid").all()).toEqual(stops);
    expect(jobs.items(original.id).filter(item => lab.slot(item.slot_id).surface === "chatgpt_search").every(item => item.state !== "carried_forward")).toBe(true);
  });

  it("persists isolated required-login preparation across a new continuation and restart", () => {
    const planId = plan(2, ["chatgpt_search"], "isolated"), original = queued(planId), first = jobs.items(original.id)[0]!;
    lab.capture(key(), capture(planId, first, { status: "unavailable", restriction: "login", answer: "", reason: "Synthetic released login wall" }));
    lab.release(key(), { scope: lab.scope(lab.slot(first.slot_id)), reason: "Synthetic confirmed login; test only" });
    const start = vi.spyOn(jobs, "start").mockImplementation(() => {});
    const next = jobs.resume(original.id, { browserMode: "silent" });
    expect(next).toMatchObject({ continued: 1, needsLogin: true }); expect(start).not.toHaveBeenCalled();
    jobs = new BrowserJobs(lab, adapter, async () => {});
    expect(jobs.loginReadiness(next.planId).platforms[0]).toMatchObject({ required: true, confirmed: false });
    expect(() => jobs.assertSessions(next.planId)).toThrow("fresh confirmed login");
    adapter.ready = (id, required) => id === next.planId && required.includes("chatgpt_search");
    expect(() => jobs.assertSessions(next.planId)).not.toThrow(); expect(adapter.collect).not.toHaveBeenCalled();
  });

  it("requires fresh preparation when the source isolated batch had a verified dedicated login", () => {
    const planId = plan(1, ["chatgpt_search"], "isolated");
    adapter.sessions = () => [{ planId, surface: "chatgpt_search", verified: true }];
    adapter.ready = id => id === planId;
    const original = queued(planId), start = vi.spyOn(jobs, "start").mockImplementation(() => {});
    const next = jobs.resume(original.id, { browserMode: "silent" });
    expect(next).toMatchObject({ continued: 1, needsLogin: true }); expect(start).not.toHaveBeenCalled();
    expect(jobs.loginReadiness(next.planId).platforms[0]).toMatchObject({ required: true, confirmed: false });
    expect(() => jobs.assertSessions(next.planId)).toThrow("fresh confirmed login");
    expect(adapter.collect).not.toHaveBeenCalled();
  });
});
