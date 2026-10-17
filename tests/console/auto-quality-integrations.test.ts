import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connectLedger } from "../../src/db/index.ts";
import { LabService } from "../../src/console/service.ts";
import { BrowserJobs, type BrowserCollector, type BrowserTask } from "../../src/console/browser-jobs.ts";
import { AiAnalysis } from "../../src/console/ai-analysis.ts";
import { identifySources } from "../../src/console/sources.ts";
import { answerMarkdown } from "../../src/console/answer-markdown.ts";
import { canonicalJson, sha256 } from "../../src/lib/canonical-json.ts";
import type { Capture } from "../../src/console/contracts.ts";

const key = () => randomUUID();
let root: string, lab: LabService, jobs: BrowserJobs;
function plan(count: number) {
  const brandId = lab.createBrand(key(), { name: "Northstar", aliases: [], ownedDomains: ["northstar.example"] }).id;
  const promptSetId = lab.createSet(key(), { brandId, label: "Synthetic integration QA", locale: "en-CA", source: "Synthetic test only", kind: "hypothesis", prompts: Array.from({ length: count }, (_, i) => ({ text: `Question ${i + 1}?`, intent: "discovery" })) }).id;
  lab.freeze(key(), promptSetId);
  return lab.createPlan(key(), { promptSetId, label: "Synthetic quality integration", surfaces: ["chatgpt_search"], country: "CA", locale: "en-CA", timezone: "UTC", device: "desktop", windows: [new Date().toISOString().slice(0, 10)] }).id;
}
function capture(task: Pick<BrowserTask, "slotId" | "prompt">, extra: Partial<Capture> = {}): Capture {
  return {
    slotId: task.slotId, prompt: task.prompt, observedAt: new Date().toISOString(), status: "observed", restriction: "none", reason: "",
    answer: "Compare Northstar scheduling for weekly shifts.", citations: [{ url: "https://northstar.example/guide", placement: "answer_link" }], model: "synthetic-test-model",
    sourceUrl: "https://chatgpt.com/", account: "logged_out", session: "fresh", exitCountry: "CA", geo: "ip_observed", locale: "en-CA", timezone: "UTC", device: "desktop", geolocation: "denied", searchMode: "explicit_search", collectionMode: "browser_capture", retrievalUsed: true,
    browser: { name: "Google Chrome", version: "synthetic", extractorVersion: "integration-test", answerComplete: true, citationsComplete: true, notes: ["Synthetic test only"] },
    artifact: { mime: "text/plain", base64: Buffer.from("Synthetic raw evidence " + task.slotId).toString("base64") }, ...extra,
  };
}
function queued(count: number) {
  const planId = plan(count);
  jobs = new BrowserJobs(lab, { available: () => ({ available: true, message: "Synthetic test only" }), collect: async () => { throw new Error("Isolated queue must not dispatch"); }, show: async () => {}, close: async () => {} });
  // Block only the dispatcher in this isolated ledger; save fixture captures by hand.
  jobs.active.set("synthetic-gate", { pause: false, controller: new AbortController(), promise: Promise.resolve(), intervals: new Set() });
  const job = jobs.create(key(), { planId, transmissionAcknowledged: true, intervalSeconds: 5 });
  jobs.active.clear();
  return { planId, job };
}
function save(jobId: string, index: number, extra: Partial<Capture> = {}) {
  const item = jobs.items(jobId)[index]!, slot = lab.slot(item.slot_id), p = lab.plan(slot.plan_id).slots.find(s => s.id === slot.id)!;
  const attempt = lab.capture(key(), capture({ slotId: slot.id, prompt: p.prompt }, extra));
  lab.db.prepare("UPDATE console_browser_item SET state='captured',stage='saved',attempt_id=? WHERE id=?").run(attempt.id, item.id);
  return attempt;
}
const browser = (extra: Partial<NonNullable<Capture["browser"]>>) => ({ name: "Google Chrome" as const, version: "synthetic", extractorVersion: "integration-test", answerComplete: true, citationsComplete: true, notes: [], ...extra });

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "auto-quality-integrations-")); lab = new LabService(connectLedger(join(root, "ledger.db"))); });
afterEach(async () => { await jobs?.pauseAll(); lab.db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe("automatic quality integration without mandatory human review", () => {
  it("completes browser sampling and publishes eligible screening rows without creating reviews or observations", async () => {
    const planId = plan(2), calls: string[] = [];
    const collector: BrowserCollector = { available: () => ({ available: true, message: "Synthetic test" }), collect: async task => { calls.push(task.slotId); return capture(task); }, show: async () => {}, close: async () => {} };
    jobs = new BrowserJobs(lab, collector, async () => {});
    const job = jobs.create(key(), { planId, transmissionAcknowledged: true, intervalSeconds: 5 });
    await jobs.active.get(job.id)?.promise;
    const screening = jobs.screening(job.id);
    expect(calls).toHaveLength(2);
    expect(screening).toMatchObject({ captured: 2, checked: 2, reviewed: 0, contentQualified: 2, eligible: 2 });
    expect(screening.rows.every(row => row.review === null && row.quality?.effectiveDecision === "auto_accept" && row.category === "owned_citation")).toBe(true);
    expect(screening.rows.every(row => !row.nextAction.includes("复核"))).toBe(true);
    expect(jobs.job(job.id)).toMatchObject({ status: "completed", message: "本批已完成；自动质检与结果已更新，可直接查看或导出" });
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_review").get()).toEqual({ n: 0 });
    expect(lab.db.prepare("SELECT COUNT(*) n FROM observation").get()).toEqual({ n: 0 });
    expect(jobs.screening(job.id).hash).toBe(screening.hash);
  });

  it("keeps quality failures, fixtures, unknown sampling conditions and optional manual rejection outside official screening counts", () => {
    const { job } = queued(7);
    save(job.id, 0);
    save(job.id, 1, { exitCountry: "US" });
    save(job.id, 2, { browser: browser({ citationsComplete: false, unresolvedCitations: 1 }) });
    save(job.id, 3, { collectionMode: "fixture" });
    save(job.id, 4, { status: "error", answer: "", citations: [], reason: "Synthetic incomplete response" });
    save(job.id, 5, { account: "unknown", session: "unknown" });
    const rejected = save(job.id, 6);
    lab.review(key(), { attemptId: rejected.id, decision: "reject", note: "Synthetic optional privacy rejection", privacyReviewed: true });
    const screening = jobs.screening(job.id);
    expect(screening).toMatchObject({ captured: 7, checked: 7, reviewed: 1, contentQualified: 3, eligible: 1, conditionExcluded: 2 });
    expect(screening.rows[1]).toMatchObject({ contentQualified: true, eligible: false, brandMentioned: true });
    for (const i of [2, 3, 4, 6]) expect(screening.rows[i]).toMatchObject({ eligible: false, category: "insufficient", brandMentioned: null, ownedCitation: null });
    expect(screening.rows[5]!.quality!.conditionIssues).toContain("未确认退出账号");
    expect(screening.rows[6]!.quality).toMatchObject({ manualDecision: "reject", effectiveDecision: "manual_reject" });
    expect(screening.rows.every(row => row.quality!.assessmentHash.length === 64 && row.evidenceHash!.length === 64)).toBe(true);
  });

  it("previews content-qualified raw evidence and preserves condition exclusions while paid analysis still needs explicit transmission and cost acknowledgements", async () => {
    const { planId, job } = queued(4);
    save(job.id, 0);
    save(job.id, 1, { exitCountry: "US" });
    save(job.id, 2, { browser: browser({ citationsComplete: false }) });
    save(job.id, 3, { collectionMode: "fixture" });
    const send = vi.fn(async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: "Synthetic draft only", findings: [] }) }] }] }), { headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
    const ai = new AiAnalysis(lab, send), preview = ai.preview(planId);
    expect(send).not.toHaveBeenCalled();
    expect(preview).toMatchObject({ includedAnswers: 2, eligibleAnswers: 2, metricEligibleAnswers: 1 });
    expect(preview.evidence[1]).toMatchObject({ metricEligible: false, quality: { contentQualified: true, metricEligible: false, status: "condition_mismatch" } });
    expect(preview.evidence[1]!.quality.conditionIssues).toContain("出口地区未核验或不匹配");
    expect(preview.scope).toContain("不能加入正式品牌指标");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-test-key"); vi.stubEnv("OPENAI_MODEL", "synthetic-test-model");
    const input = { planId, previewHash: sha256(canonicalJson(preview)), transmissionAcknowledged: true, costAcknowledged: true };
    expect(() => ai.create(key(), { ...input, costAcknowledged: false })).toThrow();
    expect(() => ai.create(key(), { ...input, transmissionAcknowledged: false })).toThrow();
    expect(() => ai.create(key(), { ...input, previewHash: "0".repeat(64) })).toThrow(/证据已变化/);
    expect(send).not.toHaveBeenCalled();
    const created = ai.create(key(), input); await ai.active.get(created.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ai.rows(planId)[0]).toMatchObject({ status: "draft", review: undefined });
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_review").get()).toEqual({ n: 0 });
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_ai_review").get()).toEqual({ n: 0 });
  });

  it("labels raw Markdown and source candidates independently from automatic official eligibility", () => {
    const { planId, job } = queued(4);
    save(job.id, 0);
    save(job.id, 1, { browser: browser({ citationsComplete: false, unresolvedCitations: 2 }) });
    save(job.id, 2, { collectionMode: "fixture" });
    save(job.id, 3, { exitCountry: "US" });
    const p = lab.plan(planId), sources = identifySources(p, ["northstar.example"]), md = answerMarkdown(p, ["northstar.example"], "zh-CN");
    expect(sources).toMatchObject({ observedPositions: 4, completeSourcePositions: 2, eligiblePositions: 1, fixturePositions: 1, unresolved: 2 });
    expect(sources.pages[0]).toMatchObject({ observationCount: 4, eligibleObservations: 1 });
    expect(sources.pages[0]!.occurrences.filter(o => o.fixture)).toHaveLength(1);
    expect(sources.pages[0]!.occurrences.find(o => o.fixture)!.eligible).toBe(false);
    expect(md.exportedAnswers).toBe(4);
    expect(md.markdown).toContain("自动采集检查：自动质检通过 · 正式指标：纳入");
    expect(md.markdown).toContain("未请求（不阻塞结果）");
    expect(md.markdown).toContain("仍有未解析引用");
    expect(md.markdown).toContain("合成演示数据不能作为网页观测结果");
    expect(md.markdown).not.toContain("待复核");
  });

  it("keeps malformed saved source metadata excluded without crashing diagnostic exports", () => {
    const { planId, job } = queued(1), attempt = save(job.id, 0);
    const saved = lab.db.prepare("SELECT capture_json FROM console_attempt WHERE id=?").get(attempt.id) as { capture_json: string };
    const malformed = canonicalJson({ ...JSON.parse(saved.capture_json), sourceUrl: "invalid provider address" });
    lab.db.exec("DROP TRIGGER console_attempt_immutable_UPDATE");
    lab.db.prepare("UPDATE console_attempt SET capture_json=?,capture_hash=? WHERE id=?").run(malformed, sha256(malformed), attempt.id);
    const p = lab.plan(planId), md = answerMarkdown(p, [], "zh-CN");
    expect(p.slots[0]!.latest!.quality).toMatchObject({ contentQualified: false, metricEligible: false });
    expect(md.exportedAnswers).toBe(0);
    expect(md.markdown).toContain("入口网址无效");
    expect(md.markdown).toContain("保存的采集记录格式无效");
    expect(identifySources(p, []).pages).toHaveLength(0);
  });

  it("normalizes visible redirect targets consistently and excludes opaque targets from official results", () => {
    const { planId, job } = queued(2);
    save(job.id, 0, { citations: [{ url: "https://www.google.com/url?q=https%3A%2F%2Fnorthstar.example%2Fguide" }] });
    save(job.id, 1, { citations: [{ url: "https://www.google.com/goto?token=opaque" }] });
    const screening = jobs.screening(job.id), report = lab.report(planId), sources = identifySources(lab.plan(planId), ["northstar.example"]);
    expect(screening).toMatchObject({ eligible: 1, contentQualified: 1 });
    expect(screening.rows[0]).toMatchObject({ ownedCitation: true, eligible: true });
    expect(screening.rows[1]).toMatchObject({ ownedCitation: null, eligible: false });
    expect(report.groups[0]).toMatchObject({ ownedCitations: 1, eligible: 1 });
    expect(sources).toMatchObject({ unresolved: 1, eligiblePositions: 1 });
    expect(sources.pages[0]).toMatchObject({ url: "https://northstar.example/guide", owned: true, eligibleObservations: 1 });
  });

  it("excludes altered evidence consistently from browser, AI preview, source lists and raw Markdown", () => {
    const { planId, job } = queued(1), attempt = save(job.id, 0);
    const hash = lab.plan(planId).slots[0]!.latest!.capture.artifactHash!;
    lab.db.exec("DROP TRIGGER console_artifact_immutable_UPDATE");
    lab.db.prepare("UPDATE console_artifact SET bytes=? WHERE hash=?").run(Buffer.from("Synthetic tampered bytes"), hash);
    const screening = jobs.screening(job.id), p = lab.plan(planId);
    expect(screening.rows[0]).toMatchObject({ attemptId: attempt.id, integrity: false, eligible: false, brandMentioned: null, category: "insufficient" });
    expect(new AiAnalysis(lab, vi.fn() as unknown as typeof fetch).preview(planId).includedAnswers).toBe(0);
    expect(identifySources(p, []).pages).toHaveLength(0);
    expect(answerMarkdown(p, []).exportedAnswers).toBe(0);
  });
});
