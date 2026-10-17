import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { connectLedger } from "../../src/db/index.ts";
import { LabService } from "../../src/console/service.ts";
import { serveConsole } from "../../src/console/server.ts";
import type { GuestReadinessTask, GuestReadinessObservation } from "../../src/console/browser-jobs.ts";
import { surfaces } from "../../src/console/contracts.ts";

type Runtime = Awaited<ReturnType<typeof serveConsole>>;
const opened: { app: Runtime; lab: LabService }[] = [];
afterEach(async () => {
  for (const { app, lab } of opened.splice(0)) {
    await app.browserJobs.pauseAll(); await app.keywordAudit.stop(); app.server.closeAllConnections();
    await new Promise<void>(done => app.server.close(() => done())); lab.db.close();
  }
});
async function fixture(demo = false) {
  const lab = new LabService(connectLedger(":memory:"));
  const inspectGuest = vi.fn(async (task: GuestReadinessTask): Promise<GuestReadinessObservation> => ({ checkedAt: new Date().toISOString(), status: "ready", restriction: "none", account: "logged_out",
    sourceUrl: surfaces[task.surface].url, reason: "Synthetic entry only; no provider request.", answer: "not_tested", citations: "not_tested" }));
  const collect = vi.fn(async () => { throw new Error("No answers may be collected in an entry check"); });
  const prepareSession = vi.fn(async () => { throw new Error("Guest checks must not prepare a login"); });
  const app = await serveConsole(lab, { demo, autoGsc: false, browserCollector: { available: () => ({ available: true, message: "Synthetic collector" }), inspectGuest, collect, prepareSession,
    sessions: () => [], show: async () => {}, close: async () => {} } });
  opened.push({ app, lab });
  const brandId = lab.createBrand(randomUUID(), { name: "Synthetic strict guest HTTP", aliases: [], ownedDomains: ["guest.example"] }).id;
  const promptSetId = lab.createSet(randomUUID(), { brandId, label: "Synthetic guest HTTP", source: "Synthetic HTTP fixture", kind: "hypothesis", locale: "en-CA", prompts: [{ text: "Synthetic unsent question?", intent: "discovery" }] }).id;
  lab.freeze(randomUUID(), promptSetId);
  const planId = lab.createPlan(randomUUID(), { promptSetId, label: "Synthetic strict guest", surfaces: ["chatgpt_search", "duckduckgo_search_assist"], accountMode: "signed_out", guestPolicy: "no_login_v1",
    country: "CA", locale: "en-CA", timezone: "UTC", device: "desktop", windows: [new Date().toISOString().slice(0, 10)] }).id;
  const headers = { Authorization: "Bearer " + app.token };
  const get = () => fetch(app.origin + "/api/browser-guest-readiness?id=" + planId, { headers });
  const post = (token = app.token, input: object = { planId, surface: "duckduckgo_search_assist", browserMode: "visible" }) => fetch(app.origin + "/api/browser-guest-readiness", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ requestId: randomUUID(), input }),
  });
  return { lab, app, planId, headers, get, post, inspectGuest, collect, prepareSession };
}

describe("strict guest readiness HTTP", () => {
  it("keeps GET local, authenticated, and read-only; POST explicitly inspects only the chosen guest entry", async () => {
    const f = await fixture(), url = f.app.origin + "/api/browser-guest-readiness?id=" + f.planId;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { ...f.headers, Origin: "https://foreign.example" } })).status).toBe(403);
    expect((await fetch(f.app.origin + "/api/browser-guest-readiness?id=invalid", { headers: f.headers })).status).toBe(400);
    expect((await f.post("wrong-token")).status).toBe(401);
    const before = await (await f.get()).json();
    expect(before.platforms.every((row: { latest: unknown }) => row.latest === null)).toBe(true);
    expect(f.inspectGuest).not.toHaveBeenCalled();
    expect((await f.post()).status).toBe(200);
    const after = await (await f.get()).json();
    expect(after.platforms.find((row: { surface: string }) => row.surface === "duckduckgo_search_assist")).toMatchObject({ latest: { status: "ready", account: "logged_out", answer: "not_tested", citations: "not_tested" } });
    expect(after.platforms.find((row: { surface: string }) => row.surface === "chatgpt_search").latest).toBeNull();
    expect(f.inspectGuest).toHaveBeenCalledTimes(1); expect(f.collect).not.toHaveBeenCalled(); expect(f.prepareSession).not.toHaveBeenCalled();
    expect(f.lab.db.prepare("SELECT COUNT(*) n FROM console_attempt").get()).toEqual({ n: 0 });
  });

  it("does not open live entries in demo mode and rejects unsupported input without provider traffic", async () => {
    const f = await fixture(true);
    expect((await f.post()).status).toBe(400); expect(f.inspectGuest).not.toHaveBeenCalled();
    const live = await fixture();
    expect((await live.post(live.app.token, { planId: live.planId, surface: "grok", browserMode: "visible" })).status).toBe(400);
    expect((await live.post(live.app.token, { planId: live.planId, surface: "chatgpt_search", browserMode: "unsupported" })).status).toBe(400);
    expect(live.inspectGuest).not.toHaveBeenCalled();
  });
});
