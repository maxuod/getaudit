import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectLedger } from "../../src/db/index.ts";
import { canonicalJson, sha256 } from "../../src/lib/canonical-json.ts";
import { LabService } from "../../src/console/service.ts";
import { assessCapture, AUTO_QUALITY_VERSION } from "../../src/console/auto-quality.ts";
import { captureSchema, conditionIssues, planSchema, surfaceIds, surfaces } from "../../src/console/contracts.ts";
import type { Capture, CaptureRecord, PlanConfig, SurfaceId } from "../../src/console/contracts.ts";
import { exportReportMarkdown } from "../../src/console/report.ts";

const key = () => randomUUID();
const newSurfaces: SurfaceId[] = ["bing_copilot", "perplexity", "grok"];
const legacySurfaces: SurfaceId[] = ["google_aio", "chatgpt_search", "gemini"];
const plan: PlanConfig = {
  promptSetId: "isolated-set", label: "Isolated platform contract QA",
  surfaces: [...legacySurfaces, ...newSurfaces], windows: ["2026-09-26"], accountMode: "signed_out",
  country: "CA", locale: "en-CA", timezone: "UTC", device: "desktop",
};
function capture(platform: SurfaceId, patch: Partial<Capture> = {}): Capture {
  return {
    slotId: "isolated-slot", prompt: "Which synthetic scheduling tool is useful?",
    status: "observed", reason: "", restriction: "none", observedAt: "2026-09-26T12:00:00Z",
    answer: "Synthetic Northstar scheduling answer.", citations: [{ url: "https://northstar.example/guide", title: "Synthetic guide" }],
    model: "unknown", sourceUrl: surfaces[platform].url,
    account: "logged_out", session: "fresh", exitCountry: "CA", geo: "ip_observed",
    locale: "en-CA", timezone: "UTC", device: "desktop", geolocation: "denied",
    searchMode: surfaces[platform].mode, collectionMode: "browser_capture", retrievalUsed: true,
    browser: { name: "Google Chrome", version: "isolated QA", extractorVersion: "isolated-v1", answerComplete: true, citationsComplete: true, notes: [] },
    artifact: { mime: "text/plain", base64: Buffer.from("Isolated synthetic evidence").toString("base64") },
    ...patch,
  };
}
function quality(platform: SurfaceId, patch: Partial<Capture> = {}, config: PlanConfig = plan) {
  const { artifact, ...c } = capture(platform, patch);
  const record: CaptureRecord = { ...c, artifactHash: artifact ? sha256("Isolated synthetic evidence") : null };
  return assessCapture({
    capture: record, captureHash: sha256(canonicalJson(record)), integrity: true,
    context: { config, configHash: sha256(canonicalJson(config)), frozenHash: sha256(c.prompt), prompt: c.prompt,
      slotId: c.slotId, surface: platform, window: "2026-09-26", integrityIssues: [] },
  });
}
const independentPrivacy: NonNullable<Capture["privacy"]> = {
  mode: "signed_in_independent", temporaryChat: "unknown", personalization: "unknown", newConversation: true,
};
const independentPatch: Partial<Capture> = { account: "logged_in", session: "active", privacy: independentPrivacy };
const guestPatch: Partial<Capture> = { account: "logged_out", session: "fresh", privacy: {
  mode: "signed_out", temporaryChat: "not_applicable", personalization: "unknown", newConversation: true,
} };

describe("consumer-web platform capabilities and quality contracts", () => {
  it("registers seven distinct consumer URLs and preserves the original modes", () => {
    expect(surfaceIds).toEqual([...legacySurfaces, ...newSurfaces, "duckduckgo_search_assist"]);
    expect(surfaces.bing_copilot).toMatchObject({ provider: "Microsoft", url: "https://copilot.microsoft.com/", mode: "natural", privateSupported: false });
    expect(surfaces.perplexity).toMatchObject({ provider: "Perplexity", url: "https://www.perplexity.ai/", mode: "natural", privateSupported: false });
    expect(surfaces.grok).toMatchObject({ provider: "xAI", url: "https://grok.com/", mode: "natural", privateSupported: false });
    expect(legacySurfaces.map(s => surfaces[s].mode)).toEqual(["explicit_search", "explicit_search", "natural"]);
    expect(new Set(surfaceIds.map(s => surfaces[s].url)).size).toBe(7);
    expect([...legacySurfaces, ...newSurfaces].every(s => surfaces[s].independentLoginSupported)).toBe(true);
    expect(surfaces.duckduckgo_search_assist.independentLoginSupported).toBe(false);
  });

  it("allows isolated plans with optional per-platform login without treating them as anonymous", () => {
    expect(planSchema.safeParse({ ...plan, accountMode: "isolated" }).success).toBe(true);
    expect(planSchema.safeParse({ ...plan, accountMode: "signed_in_independent" }).success).toBe(false);
    expect(planSchema.safeParse({ ...plan, accountMode: "signed_in_private" }).success).toBe(false);
    expect(captureSchema.safeParse(capture("bing_copilot", independentPatch)).success).toBe(true);
  });

  it.each([...legacySurfaces, ...newSurfaces])("qualifies %s isolated observations only when actual guest or logged-in conditions are complete", platform => {
    const isolated: PlanConfig = { ...plan, accountMode: "isolated" };
    const result = quality(platform, independentPatch, isolated);
    expect(result).toMatchObject({ status: "passed", contentQualified: true, metricEligible: true, effectiveDecision: "auto_accept" });
    expect(result.conditionIssues).toEqual([]);
    expect(quality(platform, guestPatch, isolated)).toMatchObject({ status: "passed", contentQualified: true, metricEligible: true });
    expect(quality(platform, { ...independentPatch, privacy: { ...independentPrivacy, temporaryChat: "verified", personalization: "disabled" } }, isolated).metricEligible).toBe(true);
    expect(quality(platform, { ...independentPatch, privacy: undefined }, isolated).conditionIssues).toContain("未确认独立采样会话");
    expect(quality(platform, { ...independentPatch, session: "fresh" }, isolated).conditionIssues).toContain("未确认独立采样会话");
    expect(quality(platform, { ...guestPatch, session: "active" }, isolated).conditionIssues).toContain("未确认独立采样会话");
    expect(quality(platform, { ...guestPatch, privacy: independentPrivacy }, isolated).conditionIssues).toContain("未确认独立采样会话");
    expect(quality(platform, { ...independentPatch, account: "unknown" }, isolated).conditionIssues).toContain("账号状态未确认");
    expect(quality(platform, { ...independentPatch, privacy: { ...independentPrivacy, newConversation: false } }, isolated).conditionIssues).toContain("未确认新对话或新搜索页面");
    expect(quality(platform, { privacy: independentPrivacy }).conditionIssues).toContain("登录态样本不能混入未登录基线");
    expect(quality(platform, { ...independentPatch, privacy: { ...independentPrivacy, mode: "signed_in_private" } }, isolated).conditionIssues).toContain("未确认独立采样会话");
    expect(quality(platform, independentPatch, { ...plan, accountMode: "signed_in_private" }).metricEligible).toBe(false);
  });

  it("accepts six signed-out surfaces but rejects unknown, duplicate, and unsupported private selections", () => {
    expect(planSchema.safeParse(plan).success).toBe(true);
    expect(planSchema.safeParse({ ...plan, surfaces: legacySurfaces, accountMode: undefined }).success).toBe(true);
    expect(planSchema.safeParse({ ...plan, surfaces: ["grok", "grok"] }).success).toBe(false);
    expect(planSchema.safeParse({ ...plan, surfaces: ["unknown"] }).success).toBe(false);
    expect(planSchema.safeParse({ ...plan, surfaces: ["google_aio", "chatgpt_search"], accountMode: "signed_in_private" }).success).toBe(true);
    for (const platform of ["gemini", ...newSurfaces])
      expect(planSchema.safeParse({ ...plan, surfaces: ["chatgpt_search", platform], accountMode: "signed_in_private" }).success).toBe(false);
  });

  it.each(newSurfaces)("accepts complete signed-out %s captures without relaxing quality or strict metrics", platform => {
    expect(quality(platform)).toMatchObject({ evaluatorVersion: AUTO_QUALITY_VERSION, status: "passed", contentQualified: true, metricEligible: true, effectiveDecision: "auto_accept", manualDecision: null });
    expect(quality(platform, { geo: "unverified", exitCountry: null })).toMatchObject({ status: "condition_mismatch", contentQualified: true, metricEligible: false });
    expect(quality(platform, { browser: { ...capture(platform).browser!, citationsComplete: false } })).toMatchObject({ status: "excluded", contentQualified: false, metricEligible: false });
    expect(quality(platform, { collectionMode: "fixture" }).contentQualified).toBe(false);
    expect(quality(platform, { searchMode: "explicit_search" }).conditionIssues).toContain("搜索模式与计划不符");
  });

  it("matches exact provider origins and excludes ordinary Bing search and impersonating hosts", () => {
    const valid: [SurfaceId, string][] = [
      ["bing_copilot", "https://copilot.microsoft.com/"], ["bing_copilot", "https://copilot.com/"],
      ["bing_copilot", "https://www.bing.com/chat"], ["bing_copilot", "https://bing.com/copilot/session"],
      ["bing_copilot", "https://m365.cloud.microsoft/chat"], ["bing_copilot", "https://m365.cloud.microsoft/chat/isolated"],
      ["perplexity", "https://perplexity.ai/"], ["perplexity", "https://www.perplexity.ai/search/isolated"],
      ["grok", "https://grok.com/"], ["grok", "https://grok.com/c/isolated"],
    ];
    for (const [platform, sourceUrl] of valid) expect(quality(platform, { sourceUrl }).contentQualified, sourceUrl).toBe(true);
    const invalid: [SurfaceId, string][] = [
      ["bing_copilot", "https://www.bing.com/"], ["bing_copilot", "https://www.bing.com/search?q=isolated"],
      ["bing_copilot", "https://bing.com/chatty"], ["bing_copilot", "https://copilot.microsoft.com.evil.example/"],
      ["bing_copilot", "https://m365.cloud.microsoft/"], ["bing_copilot", "https://m365.cloud.microsoft/search?q=isolated"],
      ["bing_copilot", "https://m365.cloud.microsoft/chatty"], ["bing_copilot", "https://m365.cloud.microsoft.evil.example/chat"],
      ["perplexity", "https://api.perplexity.ai/"], ["perplexity", "https://www.perplexity.ai.evil.example/"],
      ["grok", "https://x.com/i/grok"], ["grok", "https://grok.com.evil.example/"],
      ["grok", "https://grok.com:8443/"], ["grok", "https://user:password@grok.com/"],
      ["grok", "http://grok.com/"], ["grok", "https://chatgpt.com/"],
    ];
    for (const [platform, sourceUrl] of invalid) expect(quality(platform, { sourceUrl }).metricEligible, sourceUrl).toBe(false);
    expect(quality("bing_copilot", { ...independentPatch, sourceUrl: "https://m365.cloud.microsoft/chat" }, { ...plan, accountMode: "isolated" }))
      .toMatchObject({ contentQualified: true, metricEligible: true, conditionIssues: [] });
  });

  it("preserves the original two account modes' assessment hashes", () => {
    const config: PlanConfig = { promptSetId: "hash-set", label: "Hash regression", surfaces: ["chatgpt_search"], windows: ["2026-09-26"], country: "CA", locale: "en-CA", timezone: "UTC", device: "desktop" };
    const original: CaptureRecord = { slotId: "hash-slot", prompt: "Hash regression question?", status: "observed", reason: "", restriction: "none", observedAt: "2026-09-26T12:00:00Z", answer: "Hash regression answer", citations: [], model: "unknown", sourceUrl: "https://chatgpt.com/", account: "logged_out", session: "fresh", exitCountry: "CA", geo: "ip_observed", locale: "en-CA", timezone: "UTC", device: "desktop", geolocation: "denied", searchMode: "explicit_search", collectionMode: "browser_capture", retrievalUsed: true, browser: { name: "Google Chrome", version: "QA", extractorVersion: "QA-v1", answerComplete: true, citationsComplete: true, notes: [] }, artifactHash: sha256("hash bytes") };
    const expected = {
      signed_out: "d86db8d471bf4dd3d5b6a37c078a05ede67174ce511925554ac41da54eb5f502",
      signed_in_private: "7424844b662336b8b44cc73f2523fca0903f0078bf68e249f6c771c67fbbfd32",
    };
    for (const mode of ["signed_out", "signed_in_private"] as const) {
      const p = { ...config, accountMode: mode }, c: CaptureRecord = mode === "signed_out" ? original : { ...original, account: "logged_in", session: "active", privacy: { mode: "signed_in_private", temporaryChat: "verified", personalization: "disabled", newConversation: true } };
      const result = assessCapture({ capture: c, captureHash: sha256(canonicalJson(c)), integrity: true, context: { config: p, configHash: sha256(canonicalJson(p)), frozenHash: sha256(c.prompt), prompt: c.prompt, slotId: c.slotId, surface: "chatgpt_search", window: "2026-09-26", integrityIssues: [] } });
      expect(result.status).toBe("passed");
      expect(result.assessmentHash).toBe(expected[mode]);
    }
  });

  it.each(newSurfaces)("records login walls for %s rather than treating them as answers or private samples", platform => {
    expect(quality(platform, { status: "unavailable", reason: "Isolated login wall", restriction: "login", answer: "", citations: [],
      account: "unknown", browser: { ...capture(platform).browser!, answerComplete: false, citationsComplete: false } }))
      .toMatchObject({ status: "terminal", contentQualified: false, metricEligible: false, effectiveDecision: "terminal", retryable: true });
    const privateConfig: PlanConfig = { ...plan, surfaces: [platform], accountMode: "signed_in_private" };
    const { artifact: _, ...c } = capture(platform, { account: "logged_in", session: "active", privacy: {
      mode: "signed_in_private", temporaryChat: "verified", personalization: "disabled", newConversation: true,
    } });
    expect(conditionIssues(privateConfig, { ...c, artifactHash: "isolated" }, platform)).toContain("此入口不支持已核验的登录态临时采样");
    expect(quality(platform, { ...c }, privateConfig).metricEligible).toBe(false);
    expect(quality(platform, { account: "logged_in", session: "active" }).metricEligible).toBe(false);
  });
});

describe("additive six-platform plans and immutable legacy evidence", () => {
  let lab: LabService, root: string, setId: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "platform-contracts-"));
    lab = new LabService(connectLedger(join(root, "ledger.db")));
    const brand = lab.createBrand(key(), { name: "Synthetic Northstar", aliases: [], ownedDomains: ["northstar.example"] });
    setId = lab.createSet(key(), { brandId: brand.id, label: "Isolated frozen questions", locale: "en-CA", source: "Synthetic contract test", kind: "hypothesis",
      prompts: [{ text: "Which synthetic scheduling tool is useful?", intent: "discovery" }, { text: "How does synthetic shift swapping work?", intent: "discovery" }] }).id;
    lab.freeze(key(), setId);
  });
  afterEach(() => { lab.db.close(); rmSync(root, { recursive: true, force: true }); });

  it("creates one six-platform isolated plan mixing actual guest and logged-in answers without human review", () => {
    const planId = lab.createPlan(key(), { ...plan, promptSetId: setId, accountMode: "isolated" }).id;
    expect(lab.plan(planId).slots).toHaveLength(12);
    for (const slot of lab.plan(planId).slots) lab.capture(key(), capture(slot.surface, {
      ...(newSurfaces.includes(slot.surface) ? independentPatch : guestPatch), slotId: slot.id, prompt: slot.prompt,
    }));
    const report = lab.report(planId);
    expect(report.groups).toHaveLength(6);
    expect(report.groups.every(g => g.contentQualified === 2 && g.candidateDenominator === 2 && g.eligible === 2 && g.reviewed === 0)).toBe(true);
    expect(report.records.every(r => r.answer === "Synthetic Northstar scheduling answer." && r.exclusionReasons.length === 0)).toBe(true);
    expect(new Set(report.records.map(r => r.conditions?.account))).toEqual(new Set(["logged_in", "logged_out"]));
    const markdown = exportReportMarkdown(lab, planId).markdown;
    expect(markdown).toContain("Synthetic Northstar scheduling answer.");
    expect(markdown).not.toContain("登录态独立观察未核验匿名条件");
  });

  it("creates all independent six-platform repetitions while preserving every legacy row and hash", () => {
    const oldId = lab.createPlan(key(), { ...plan, promptSetId: setId, surfaces: legacySurfaces, accountMode: undefined }).id;
    const oldSlots = lab.plan(oldId).slots;
    for (const slot of oldSlots) lab.capture(key(), capture(slot.surface, { slotId: slot.id, prompt: slot.prompt }));
    const oldQuality = lab.plan(oldId).slots.map(s => [s.id, s.latest!.quality]);
    const tables = ["prompt_set", "prompt", "console_plan", "console_slot", "console_attempt", "console_artifact", "collection_run"];
    const before = Object.fromEntries(tables.map(table => [table, lab.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()]));
    const newId = lab.createPlan(key(), { ...plan, promptSetId: setId, repetitions: 3 }).id;
    expect(lab.plan(newId).slots).toHaveLength(36);
    for (const platform of plan.surfaces) {
      const slots = lab.plan(newId).slots.filter(s => s.surface === platform);
      expect(slots).toHaveLength(6);
      expect([...new Set(slots.map(s => s.run_idx))].sort()).toEqual([1, 2, 3]);
      const first = slots[0]!;
      lab.capture(key(), capture(platform, { slotId: first.id, prompt: first.prompt }));
    }
    for (const table of tables) {
      const after = lab.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all();
      expect(after.slice(0, before[table]!.length), table).toEqual(before[table]);
    }
    const report = lab.report(newId);
    expect(report.groups).toHaveLength(6);
    expect(report.groups.every(g => g.eligible === 1 && g.planned === 6 && g.reviewed === 0)).toBe(true);
    const markdown = exportReportMarkdown(lab, newId).markdown;
    for (const platform of newSurfaces) expect(markdown).toContain(surfaces[platform].name.split(" (")[0]);
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_review").get()).toEqual({ n: 0 });
    expect(lab.db.prepare("SELECT COUNT(*) n FROM observation").get()).toEqual({ n: 0 });
    lab.db.close();
    lab = new LabService(connectLedger(join(root, "ledger.db")));
    expect(lab.plan(oldId).slots.map(s => [s.id, s.latest!.quality])).toEqual(oldQuality);
    for (const table of tables) expect(lab.db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all().slice(0, before[table]!.length), table).toEqual(before[table]);
    expect(() => lab.db.prepare("UPDATE console_plan SET label='changed' WHERE id=?").run(oldId)).toThrow();
    expect(() => lab.db.prepare("UPDATE console_slot SET surface='grok' WHERE id=?").run(oldSlots[0]!.id)).toThrow();
  });
});
