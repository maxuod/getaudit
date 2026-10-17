import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { connectLedger } from "../../src/db/index.ts";
import { LabService } from "../../src/console/service.ts";
import { BrowserJobs, type BrowserCollector, type GuestReadinessObservation, type GuestReadinessTask } from "../../src/console/browser-jobs.ts";
import { surfaces, type PlanConfig, type SurfaceId } from "../../src/console/contracts.ts";

let lab: LabService, jobs: BrowserJobs, adapter: BrowserCollector;
let sessions: { planId: string; surface: string; verified: boolean }[];
const key = () => randomUUID();
function plan(accountMode: PlanConfig["accountMode"] = undefined, platforms: SurfaceId[] = ["chatgpt_search", "perplexity"], guestPolicy?: PlanConfig["guestPolicy"]) {
  const brandId = lab.createBrand(key(), { name: "Synthetic guest checks", aliases: [], ownedDomains: ["guest.example"] }).id;
  const promptSetId = lab.createSet(key(), { brandId, label: "Synthetic guest checks", source: "Synthetic tests only; no provider requests", kind: "hypothesis", locale: "en-CA", prompts: [
    { text: "Synthetic unsent question one?", intent: "discovery" }, { text: "Synthetic unsent question two?", intent: "discovery" },
  ] }).id;
  lab.freeze(key(), promptSetId);
  return lab.createPlan(key(), { promptSetId, label: "Synthetic strict guest plan", surfaces: platforms, ...(accountMode ? { accountMode } : {}), ...(guestPolicy ? { guestPolicy } : {}), country: "CA", locale: "en-CA", timezone: "UTC", device: "desktop", windows: [new Date().toISOString().slice(0, 10)] }).id;
}
function ready(task: GuestReadinessTask): GuestReadinessObservation {
  return { checkedAt: new Date().toISOString(), status: "ready", restriction: "none", account: "logged_out", sourceUrl: surfaces[task.surface].url,
    reason: "Synthetic fresh guest entry has a composer; no question was sent.", answer: "not_tested", citations: "not_tested" };
}
const snapshot = () => Object.fromEntries(["console_plan", "console_slot", "console_attempt", "console_restriction", "console_browser_job", "console_browser_item"].map(table => [table, lab.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
function wall(planId: string) {
  const slot = lab.plan(planId).slots.find(row => row.surface === "chatgpt_search")!;
  return lab.capture(key(), { slotId: slot.id, prompt: slot.prompt, observedAt: new Date().toISOString(), status: "unavailable", restriction: "login", reason: "Synthetic historical login wall", answer: "", citations: [], model: "unknown",
    sourceUrl: surfaces.chatgpt_search.url, account: "unknown", session: "unknown", exitCountry: null, geo: "unverified", locale: "en-CA", timezone: "UTC", device: "desktop", geolocation: "denied", searchMode: "explicit_search", collectionMode: "browser_capture", retrievalUsed: null,
    artifact: { mime: "text/plain", base64: Buffer.from("Synthetic guest wall " + slot.id).toString("base64") } });
}
beforeEach(() => {
  lab = new LabService(connectLedger(":memory:")); sessions = [];
  adapter = { available: () => ({ available: true, message: "Synthetic collector" }), collect: vi.fn(), show: vi.fn(async () => {}), close: vi.fn(async () => {}),
    prepareSession: vi.fn(async () => ({ opened: true })), verifySession: vi.fn(async () => ({ verified: true })), sessions: () => sessions,
    inspectGuest: vi.fn(async task => ready(task)) };
  jobs = new BrowserJobs(lab, adapter, async () => {});
});
afterEach(async () => { vi.useRealTimers(); await jobs.pauseAll(); lab.db.close(); });

describe("strict guest entry checks", () => {
  it.each([
    { policy: "no_login_v1", mode: undefined, expected: "silent" },
    { policy: undefined, mode: undefined, expected: "silent" },
    { policy: "no_login_v1", mode: "silent", expected: "silent" },
    { policy: "no_login_v1", mode: "visible", expected: "visible" },
    { policy: undefined, mode: "visible", expected: "visible" },
  ] as const)("uses the correct new-job browser default without overriding explicit or legacy settings: %j", ({ policy, mode, expected }) => {
    const id = plan("signed_out", ["chatgpt_search"], policy);
    jobs.active.set("synthetic-queue-gate", { pause: false, controller: new AbortController(), intervals: new Set(), promise: Promise.resolve() });
    const before = lab.planRow(id).config_json;
    const job = jobs.create(key(), { planId: id, transmissionAcknowledged: true, ...(mode ? { browserMode: mode } : {}) });
    jobs.active.clear();
    expect(jobs.job(job.id).config.browserMode).toBe(expected); expect(lab.planRow(id).config_json).toBe(before); expect(adapter.collect).not.toHaveBeenCalled();
  });

  it("keeps default and explicit signed-out plans frozen and refuses every login action", async () => {
    for (const mode of [undefined, "signed_out"] as const) {
      const id = plan(mode), before = snapshot();
      for (const action of ["open", "verify", "close"]) await expect(jobs.sessionControl({ planId: id, surface: "chatgpt_search", action })).rejects.toThrow("当前计划没有启用此登录态入口");
      expect(jobs.guestReadiness(id)).toMatchObject({ accountMode: "signed_out", inspectionAvailable: true, samplingActive: false });
      await jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search", browserMode: "visible" });
      expect(snapshot()).toEqual(before);
    }
    expect(adapter.prepareSession).not.toHaveBeenCalled(); expect(adapter.verifySession).not.toHaveBeenCalled(); expect(adapter.collect).not.toHaveBeenCalled(); expect(adapter.close).not.toHaveBeenCalled();
  });

  it("records a new dated guest entry without releasing an old login stop or replaying its blocked queue", async () => {
    const id = plan(), saved = wall(id);
    jobs.active.set("synthetic-queue-gate", { pause: false, controller: new AbortController(), intervals: new Set(), promise: Promise.resolve() });
    const job = jobs.create(key(), { planId: id, transmissionAcknowledged: true, intervalSeconds: 5 }); jobs.active.clear();
    const before = snapshot(), prior = jobs.guestReadiness(id).platforms[0]!;
    expect(prior).toMatchObject({ restriction: { active: true, type: "login", evidence: { attemptId: saved.id } }, latest: null, canCheck: true });
    const result = await jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search", browserMode: "visible" });
    expect(result.platforms[0]).toMatchObject({ canCheck: true, restriction: { active: true, type: "login" }, latest: { status: "ready", account: "logged_out", answer: "not_tested", citations: "not_tested" } });
    expect(result.platforms[1]!.latest).toBeNull(); expect(snapshot()).toEqual(before);
    expect(jobs.items(job.id).filter(row => row.state === "blocked")).toHaveLength(1); expect(adapter.collect).not.toHaveBeenCalled();
    expect(adapter.inspectGuest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adapter.inspectGuest!).mock.calls[0]![0].config.accountMode).toBe("signed_out");
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_browser_guest_check").get()).toEqual({ n: 1 });
    expect(() => lab.db.prepare("UPDATE console_browser_guest_check SET result_json='{}'").run()).toThrow("immutable");
    expect(() => lab.db.prepare("DELETE FROM console_browser_guest_check").run()).toThrow("cannot be deleted");
  });

  it("never borrows prepared sessions or opens a fresh check during sampling", async () => {
    const id = plan(); sessions = [{ planId: key(), surface: "chatgpt_search", verified: true }];
    expect(jobs.guestReadiness(id).platforms.every(row => !row.canCheck)).toBe(true);
    await expect(jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search" })).rejects.toThrow("close prepared login sessions");
    sessions = []; jobs.active.set("synthetic-sampling", { pause: false, controller: new AbortController(), intervals: new Set(), promise: Promise.resolve() });
    await expect(jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search" })).rejects.toThrow("Pause browser sampling");
    jobs.active.clear(); expect(adapter.inspectGuest).not.toHaveBeenCalled();
    adapter.sessions = () => { throw new Error("Synthetic unavailable session state"); };
    expect(jobs.guestReadiness(id).platforms.every(row => !row.canCheck)).toBe(true);
  });

  it.each([
    { account: "logged_in" }, { restriction: "login" }, { sourceUrl: "https://chatgpt.com.evil.example/" },
    { sourceUrl: "https://user:password@chatgpt.com/" }, { sourceUrl: "http://chatgpt.com/" },
  ] as const)("does not claim guest readiness for conflicting entry data %j", async conflict => {
    const id = plan(); adapter.inspectGuest = vi.fn(async task => ({ ...ready(task), ...conflict }));
    const result = await jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search" });
    expect(result.platforms[0]!.latest).toMatchObject({ status: "unknown", answer: "not_tested", citations: "not_tested" });
    expect(adapter.collect).not.toHaveBeenCalled();
  });

  it("keeps repeated entry observations append-only and separate from answer evidence", async () => {
    const id = plan(); adapter.inspectGuest = vi.fn(async task => ({ ...ready(task), status: "restricted", restriction: "captcha", account: "unknown" }));
    const first = await jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search" });
    expect(first.platforms[0]!.latest).toMatchObject({ status: "restricted", restriction: "captcha" });
    adapter.inspectGuest = vi.fn(async task => ready(task));
    const next = await jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search" });
    expect(next.platforms[0]!.latest!.id).not.toBe(first.platforms[0]!.latest!.id);
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_browser_guest_check").get()).toEqual({ n: 2 });
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_attempt").get()).toEqual({ n: 0 });
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_restriction").get()).toEqual({ n: 0 });
  });

  it("bounds inspection time and holds the browser gate until a timed-out adapter finishes cleanup", async () => {
    vi.useFakeTimers(); const id = plan(); let finish!: (value: GuestReadinessObservation) => void;
    adapter.inspectGuest = vi.fn(task => new Promise(resolve => { finish = resolve; }));
    const pending = jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search" }); await vi.advanceTimersByTimeAsync(45_000);
    const result = await pending;
    expect(result).toMatchObject({ inspectionActive: true }); expect(result.platforms[0]!.latest).toMatchObject({ status: "unknown", reason: expect.stringContaining("timed out") });
    expect(() => jobs.assertSessions(id)).toThrow("Wait for the guest entry check");
    await expect(jobs.checkGuestReadiness({ planId: id, surface: "perplexity" })).rejects.toThrow("Pause browser sampling");
    finish(ready({ planId: id, surface: "chatgpt_search", config: lab.plan(id).config, browserMode: "visible" })); await vi.advanceTimersByTimeAsync(0);
    expect(jobs.guestReadiness(id).inspectionActive).toBe(false); expect(adapter.collect).not.toHaveBeenCalled();
  });

  it("requires strict guest mode and only platforms in its frozen plan", async () => {
    const isolated = plan("isolated"); expect(() => jobs.guestReadiness(isolated)).toThrow("strict signed-out plan");
    const id = plan(); await expect(jobs.checkGuestReadiness({ planId: id, surface: "grok" })).rejects.toThrow("not included");
    await expect(jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search", browserMode: "unsupported" })).rejects.toThrow();
    const missing = new BrowserJobs(lab); expect(missing.guestReadiness(id)).toMatchObject({ inspectionAvailable: false });
    await expect(missing.checkGuestReadiness({ planId: id, surface: "chatgpt_search" })).rejects.toThrow("updated Mac app");
    expect(adapter.inspectGuest).not.toHaveBeenCalled();
  });

  it("preserves an opted-in strict guest policy in a dated continuation and gates all continuation writes during entry inspection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
    const id = plan("signed_out", ["chatgpt_search"], "no_login_v1");
    jobs.active.set("synthetic-queue-gate", { pause: false, controller: new AbortController(), intervals: new Set(), promise: Promise.resolve() });
    const job = jobs.create(key(), { planId: id, transmissionAcknowledged: true, intervalSeconds: 5 }); jobs.active.clear();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    let finish!: (value: GuestReadinessObservation) => void;
    adapter.inspectGuest = vi.fn(task => new Promise(resolve => { finish = resolve; }));
    const pending = jobs.checkGuestReadiness({ planId: id, surface: "chatgpt_search" }); await Promise.resolve();
    const before = snapshot(); expect(() => jobs.resume(job.id)).toThrow("Wait for the guest entry check"); expect(snapshot()).toEqual(before);
    finish(ready({ planId: id, surface: "chatgpt_search", config: lab.plan(id).config, browserMode: "visible" })); await pending;
    const start = vi.spyOn(jobs, "start").mockImplementation(() => {});
    const result = jobs.resume(job.id);
    expect(result).toMatchObject({ continued: 2 });
    expect(lab.plan(result.planId).config).toMatchObject({ accountMode: "signed_out", guestPolicy: "no_login_v1", windows: ["2026-10-15"] });
    expect(lab.plan(id).config).toMatchObject({ guestPolicy: "no_login_v1", windows: ["2026-10-14"] });
    expect(start).toHaveBeenCalledOnce(); expect(adapter.collect).not.toHaveBeenCalled(); start.mockRestore();
  });
});
