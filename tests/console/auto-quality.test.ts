import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectLedger } from "../../src/db/index.ts";
import { LabService } from "../../src/console/service.ts";
import { exportReport, exportReportMarkdown } from "../../src/console/report.ts";
import { createSnapshot, verifySnapshot } from "../../src/console/snapshots.ts";
import { canonicalJson, sha256 } from "../../src/lib/canonical-json.ts";
import { AUTO_QUALITY_VERSION } from "../../src/console/auto-quality.ts";

const key = () => randomUUID();
let lab: LabService, root: string, planId: string, setId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auto-quality-"));
  lab = new LabService(connectLedger(join(root, "ledger.db")));
  const brand = lab.createBrand(key(), { name: "Northstar", aliases: [], ownedDomains: ["northstar.example"] });
  setId = lab.createSet(key(), { brandId: brand.id, label: "Quality QA", locale: "en-CA", source: "Isolated synthetic questions", kind: "hypothesis", prompts: Array.from({ length: 2 }, (_, n) => ({ text: `Question ${n}?`, intent: "discovery" })) }).id;
  lab.freeze(key(), setId);
  planId = lab.createPlan(key(), { promptSetId: setId, label: "Quality QA", surfaces: ["google_aio", "chatgpt_search", "gemini"], windows: ["2026-09-26"], country: "CA", locale: "en-CA", timezone: "UTC", device: "desktop" }).id;
});
afterEach(() => { lab.db.close(); rmSync(root, { recursive: true, force: true }); });
const qaSlots = () => [...lab.plan(planId).slots].sort((a,b) => a.prompt.localeCompare(b.prompt) || ["google_aio", "chatgpt_search", "gemini"].indexOf(a.surface) - ["google_aio", "chatgpt_search", "gemini"].indexOf(b.surface));
function capture(index: number, extra: Record<string, unknown> = {}) {
  const slot = qaSlots()[index]!;
  return lab.capture(key(), {
    slotId: slot.id, prompt: slot.prompt, status: "observed", observedAt: "2026-09-26T10:00:00Z", answer: "Northstar has a useful scheduling guide.",
    citations: [{ url: "https://northstar.example/guide", placement: "answer_link", title: "Guide" }],
    sourceUrl: slot.surface === "google_aio" ? "https://www.google.com" : slot.surface === "gemini" ? "https://gemini.google.com" : "https://chatgpt.com", model: "unknown",
    account: "logged_out", session: "fresh", exitCountry: "CA", geo: "ip_observed", locale: "en-CA", timezone: "UTC", device: "desktop", geolocation: "denied",
    searchMode: slot.surface === "gemini" ? "natural" : "explicit_search", collectionMode: "browser_capture",
    browser: { name: "Google Chrome", version: "synthetic QA", extractorVersion: "test-v1", answerComplete: true, citationsComplete: true, unresolvedCitations: 0, citationOverflow: 0, notes: [] },
    artifact: { mime: "text/plain", base64: Buffer.from("Isolated capture bytes").toString("base64") }, ...extra,
  });
}
const latest = (index = 0) => qaSlots()[index]!.latest!;
function rewriteCapture(attemptId: string, transform: (capture: any) => any) {
  lab.db.exec("DROP TRIGGER IF EXISTS console_attempt_immutable_UPDATE");
  const row = lab.db.prepare("SELECT capture_json FROM console_attempt WHERE id=?").get(attemptId) as { capture_json: string };
  const json = canonicalJson(transform(JSON.parse(row.capture_json)));
  lab.db.prepare("UPDATE console_attempt SET capture_json=?,capture_hash=? WHERE id=?").run(json, sha256(json), attemptId);
}

describe("automatic capture quality and evidence-preserving reports", () => {
  it("includes complete real captures without writing artificial human reviews or legacy observations", () => {
    capture(0);
    const before = lab.db.prepare("SELECT total_changes() n").get();
    const first = latest().quality;
    expect(first).toMatchObject({ evaluatorVersion: AUTO_QUALITY_VERSION, status: "passed", contentQualified: true, metricEligible: true, effectiveDecision: "auto_accept", manualDecision: null });
    expect(first.assessmentHash).toHaveLength(64);
    expect(latest().quality).toEqual(first);
    const report = lab.report(planId), group = report.groups.find(g => g.surface === "google_aio")!;
    expect(group).toMatchObject({ autoChecked: 1, reviewed: 0, observed: 1, eligible: 1, contentQualified: 1, candidateBrandMentions: 1, candidateOwnedCitations: 1, brandMentions: 1, ownedCitations: 1, pending: 1 });
    expect(report.records.find(r => r.quality?.contentQualified)?.answer).toContain("Northstar");
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_review").get()).toEqual({ n: 0 });
    expect(lab.db.prepare("SELECT COUNT(*) n FROM observation").get()).toEqual({ n: 0 });
    expect(lab.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  });
  it("keeps complete geography-unverified answers as content screening but excludes strict metrics", () => {
    capture(0, { geo: "unverified", exitCountry: null });
    expect(latest().quality).toMatchObject({ status: "condition_mismatch", contentQualified: true, metricEligible: false });
    const report = lab.report(planId), group = report.groups[0]!;
    expect(group).toMatchObject({ candidateDenominator: 1, candidateBrandMentions: 1, candidateOwnedCitations: 1, eligible: 0, brandMentions: 0, ownedCitations: 0, conditionMismatched: 1 });
    expect(exportReport(lab, planId).html).toContain("Northstar has a useful scheduling guide.");
    expect(exportReportMarkdown(lab, planId).markdown).toContain("出口地区未核验或不匹配");
  });
  it("excludes incomplete answer/source ranges and inconsistent extraction flags", () => {
    const variants = [
      { answerComplete: false, citationsComplete: true },
      { answerComplete: true, citationsComplete: false },
      { answerComplete: true, citationsComplete: true, unresolvedCitations: 1 },
      { answerComplete: true, citationsComplete: true, citationOverflow: 1 },
      { answerComplete: true, citationsComplete: true, citationControls: 2, citationControlsOpened: 1 },
    ];
    variants.forEach((flags, i) => capture(i, { browser: { name: "Google Chrome", version: "QA", extractorVersion: "test", notes: [], ...flags } }));
    for (let n = 0; n < variants.length; n++) expect(latest(n).quality).toMatchObject({ contentQualified: false, metricEligible: false, status: "excluded" });
    const report = lab.report(planId);
    expect(report.records.filter(r => r.answer !== null)).toHaveLength(0);
    expect(report.records.filter(r => r.quality).every(r => r.exclusionReasons.length > 0)).toBe(true);
  });
  it("counts an explicitly complete empty citation range without inventing a reference", () => {
    capture(0, { citations: [] });
    expect(latest().quality).toMatchObject({ contentQualified: true, metricEligible: true });
    expect(lab.report(planId).groups[0]).toMatchObject({ eligible: 1, candidateOwnedCitations: 0, ownedCitations: 0 });
    expect(exportReportMarkdown(lab, planId, "zh-CN").markdown).toContain("未包含可识别来源链接");
  });
  it("excludes fixtures, unsafe or unresolved source URLs, and impersonating provider hosts", () => {
    capture(0, { collectionMode: "fixture" });
    capture(1, { citations: [{ url: "https://www.google.com/goto?token=opaque" }] });
    capture(2, { sourceUrl: "https://google.com.evil.test/search" });
    capture(3, { citations: [{ url: "https://user:password@northstar.example/guide" }] });
    for (let n = 0; n < 4; n++) expect(latest(n).quality.contentQualified).toBe(false);
    const exported = exportReport(lab, planId);
    expect(exported.html).not.toContain("https://user:password@");
    expect(exported.json.report.groups.reduce((sum, g) => sum + g.eligible, 0)).toBe(0);
  });
  it("normalizes explicit Google redirect targets for owned-domain counts", () => {
    capture(0, { citations: [{ url: "https://www.google.com/url?q=https%3A%2F%2Fnorthstar.example%2Fguide&ved=test" }] });
    expect(latest().quality.metricEligible).toBe(true);
    expect(lab.report(planId).groups[0]).toMatchObject({ candidateOwnedCitations: 1, ownedCitations: 1 });
  });
  it("retains failed, not-triggered, cancelled and unexecuted positions independently of reviews", () => {
    capture(0, { status: "not_triggered", answer: "", citations: [], reason: "No Overview displayed" });
    capture(1, { status: "error", answer: "", citations: [], reason: "Collector timeout" });
    capture(2, { status: "unavailable", answer: "", citations: [], reason: "Login required", restriction: "login" });
    capture(3, { status: "cancelled", answer: "", citations: [], reason: "Sampling cancelled", artifact: null });
    const report = lab.report(planId);
    expect(report.records).toHaveLength(6);
    expect(report.groups.reduce((sum, g) => sum + g.pending, 0)).toBe(2);
    expect(report.groups.reduce((sum, g) => sum + g.eligible, 0)).toBe(0);
    expect(report.groups.reduce((sum, g) => sum + g.notTriggered + g.errors + g.unavailable + g.cancelled, 0)).toBe(4);
    expect(report.records.filter(r => r.quality).every(r => r.quality!.status === "terminal" && r.exclusionReasons.length > 0)).toBe(true);
    expect(report.records.filter(r => !r.quality).every(r => r.exclusionReasons.includes("尚未执行或保存采集记录"))).toBe(true);
    const blocked = report.records.find(r => r.surface === "gemini" && !r.quality)!;
    expect(blocked.restriction).toMatchObject({ action: "stop", reason: "login: Login required" });
    expect(blocked.exclusionReasons).toContain("入口限制未解除：login: Login required");
    expect(report.groups.find(g => g.surface === "gemini")?.restrictedUnexecuted).toBe(1);
  });
  it("permits automatic failed-capture retries while locking completed evidence and preserving each attempt", () => {
    const first = capture(0, { status: "error", answer: "", citations: [], reason: "Retryable timeout" });
    const second = capture(0);
    const slot = qaSlots()[0]!;
    expect(slot.attempts.map(a => a.id)).toEqual([first.id, second.id]);
    expect(slot.latest!.quality.metricEligible).toBe(true);
    expect(() => capture(0)).toThrow(/不能替换/);
    capture(1, { browser: { name: "Google Chrome", version: "QA", extractorVersion: "test", answerComplete: true, citationsComplete: false, notes: [] } });
    expect(() => capture(1)).not.toThrow();
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_review").get()).toEqual({ n: 0 });
  });
  it("preserves manual accept/reject provenance, makes review optional, and never assumes pasted completeness", () => {
    const manual = capture(0, { collectionMode: "manual_capture", browser: undefined, sourceUrl: undefined });
    expect(latest().quality.contentQualified).toBe(false);
    lab.review(key(), { attemptId: manual.id, decision: "accept", privacyReviewed: true, note: "Legacy manual evidence review" });
    expect(latest().quality).toMatchObject({ contentQualified: true, metricEligible: true, effectiveDecision: "manual_accept", manualDecision: "accept" });
    const rejected = capture(1);
    lab.review(key(), { attemptId: rejected.id, decision: "reject", privacyReviewed: true, note: "Optional removal" });
    expect(latest(1).quality).toMatchObject({ contentQualified: false, metricEligible: false, effectiveDecision: "manual_reject", retryable: true });
    const third = capture(2, { collectionMode: "manual_capture", sourceUrl: undefined });
    expect(latest(2).quality.contentQualified).toBe(false);
    expect(lab.report(planId).records.find(r => r.slotId === qaSlots()[2]!.id)?.answer).toBeNull();
    expect(lab.db.prepare("SELECT COUNT(*) n FROM observation").get()).toEqual({ n: 1 });
    expect(lab.db.prepare("SELECT COUNT(*) n FROM console_review").get()).toEqual({ n: 2 });
    expect(third.id).toBeTruthy();
  });
  it("detects corrupt evidence, capture identities, configuration and frozen prompts without counting them", () => {
    const a = capture(0);
    rewriteCapture(a.id, c => ({ ...c, prompt: "A different frozen question?" }));
    expect(latest().quality.contentIssues).toContain("采集问题或位置与冻结计划不符");
    capture(1);
    lab.db.exec("DROP TRIGGER console_plan_immutable_UPDATE");
    const plan = lab.planRow(planId), config = JSON.parse(plan.config_json);
    lab.db.prepare("UPDATE console_plan SET config_json=? WHERE id=?").run(canonicalJson({ ...config, label: "Tampered metadata" }), planId);
    expect(latest(1).quality.contentIssues).toContain("计划配置哈希不匹配");
    lab.db.prepare("UPDATE console_plan SET config_json=? WHERE id=?").run(plan.config_json, planId);
    lab.db.exec("DROP TRIGGER prompt_no_update_after_freeze");
    lab.db.prepare("UPDATE prompt SET text=text||' tampered' WHERE prompt_set_id=?").run(setId);
    expect(latest(1).quality.contentIssues).toContain("冻结问题集完整性检查失败");
    expect(lab.report(planId).groups.reduce((sum, g) => sum + g.eligible, 0)).toBe(0);
  });
  it("excludes corrupted or malformed individual attempts instead of crashing the entire report", () => {
    const a = capture(0), b = capture(1), c = capture(2);
    rewriteCapture(a.id, v => ({ ...v, sourceUrl: "bad-url" }));
    rewriteCapture(b.id, v => ({ ...v, browser: { name: "Google Chrome", answerComplete: true, citationsComplete: true } }));
    lab.db.prepare("UPDATE console_attempt SET capture_json=? WHERE id=?").run("{broken", c.id);
    const report = lab.report(planId);
    expect(report.records).toHaveLength(6);
    expect(report.records.filter(r => r.answer !== null)).toHaveLength(0);
    expect(latest(2)).toMatchObject({ integrity: false, readError: expect.stringContaining("无法解析") });
    expect(() => exportReportMarkdown(lab, planId)).not.toThrow();
  });
  it("excludes mismatched artifact links even if the record and artifact hashes each remain individually valid", () => {
    const a = capture(0), b = capture(1, { artifact: { mime: "text/plain", base64: Buffer.from("Other distinct evidence").toString("base64") } });
    const artifact = lab.db.prepare("SELECT artifact_hash FROM console_attempt WHERE id=?").get(b.id) as { artifact_hash: string };
    rewriteCapture(a.id, v => ({ ...v, artifactHash: artifact.artifact_hash }));
    expect(latest().integrity).toBe(false);
    expect(latest().quality.contentQualified).toBe(false);
  });
  it("freezes automatic assessments in immutable snapshots and still verifies historical v2 envelopes", () => {
    const a = capture(0), snapshot = createSnapshot(lab, planId);
    expect(snapshot.snapshot.report.records.find(r => r.quality)?.quality?.assessmentHash).toBe(latest().quality.assessmentHash);
    expect(verifySnapshot(snapshot.json, snapshot.html).valid).toBe(true);
    lab.review(key(), { attemptId: a.id, decision: "reject", privacyReviewed: true, note: "Later optional review" });
    expect(lab.report(planId).records.find(r => r.slotId === qaSlots()[0]!.id)?.answer).toBeNull();
    const frozen = lab.db.prepare("SELECT json FROM console_report_snapshot WHERE hash=?").get(snapshot.hash) as { json: string };
    expect(frozen.json).toBe(snapshot.json);
    expect(verifySnapshot(frozen.json, snapshot.html).valid).toBe(true);
    expect(() => lab.db.prepare("UPDATE console_report_snapshot SET json=? WHERE hash=?").run("changed", snapshot.hash)).toThrow();
    const oldReport = { schema: "console-descriptive-report-v2", planId, groups: [], records: [{ decision: "accept", answer: "Historical accepted reading" }] };
    const old = canonicalJson({ schema: "geo-console-snapshot-v1", planId, report: oldReport, dataHash: sha256(canonicalJson(oldReport)), htmlHash: sha256("old HTML") });
    expect(verifySnapshot(old, "old HTML").valid).toBe(true);
  });
  it("exports redacted qualified originals, source links, excluded and unexecuted reasons, and version hashes in Markdown", () => {
    capture(0, { answer: "Northstar contact test@example.com\n```\n<script>raw answer</script>\n```", citations: [{ url: "https://northstar.example/guide?token=private-token", title: "[Guide]" }] });
    capture(1, { answer: "OMITTED incomplete answer", browser: { name: "Google Chrome", version: "QA", extractorVersion: "test", answerComplete: false, citationsComplete: true, notes: [] } });
    const result = exportReportMarkdown(lab, planId, "zh-CN");
    expect(result.markdown).toContain("[已隐去邮箱]");
    expect(result.markdown).not.toContain("test@example.com");
    expect(result.markdown).not.toContain("private-token");
    expect(result.markdown).toContain("````text");
    expect(result.markdown).not.toContain("OMITTED incomplete answer");
    expect(result.markdown).toContain("尚未执行或保存采集记录");
    expect(result.markdown).toContain(AUTO_QUALITY_VERSION);
    expect(result.markdown).toContain(latest().quality.assessmentHash);
    expect(result.markdown).toContain("### 1. ChatGPT Search");
    expect(result.markdown).not.toMatch(/^### \d+\. (?:google_aio|chatgpt_search|gemini) /m);
    expect(result.markdown).toContain("采样时间：2026-09-26T10:00:00Z · 地区：CA（已核验出口） · 账号：未登录 · 采集：自动浏览器采样");
    expect(result.markdown).not.toContain("完整尝试记录：");
    expect(result.markdown).not.toContain('"observedAt":');
    expect(result.markdown).not.toContain('"capture_hash":');
    expect(result.markdown).not.toContain('"assessmentHash":');
    expect(result.dataHash).toBe(exportReport(lab, planId).json.dataHash);
    expect(result.sha256).toBe(sha256(result.markdown));
    expect(exportReportMarkdown(lab, planId, "zh-CN")).toEqual(result);
  });
});
