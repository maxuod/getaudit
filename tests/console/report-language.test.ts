import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { connectLedger } from "../../src/db/index.ts";
import { LabService } from "../../src/console/service.ts";
import { exportReport, exportReportMarkdown } from "../../src/console/report.ts";
import { answerMarkdown } from "../../src/console/answer-markdown.ts";
import { reportCopy, reportLocale } from "../../src/console/report-language.ts";
import { sha256 } from "../../src/lib/canonical-json.ts";
import { createSnapshot, verifySnapshot } from "../../src/console/snapshots.ts";

let root: string, service: LabService, planId: string;
const question = "Original question 原始问题?";
const answer = "Original answer 原文。\n```\n<script>not executable</script>\n```";
const sourceTitle = "Original source 原始来源 <title>";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "getgeo-report-language-"));
  service = new LabService(connectLedger(join(root, "ledger.db")));
  const brandId = service.createBrand(randomUUID(), { name: "Synthetic <brand>", ownedDomains: ["owned.example"], aliases: [] }).id;
  const setId = service.createSet(randomUUID(), { brandId, label: "Original set 原始问题集", locale: "en-CA", source: "Synthetic test only", kind: "hypothesis", prompts: [{ text: question, intent: "discovery" }] }).id;
  service.freeze(randomUUID(), setId);
  planId = service.createPlan(randomUUID(), { promptSetId: setId, label: "Original plan 原始计划", country: "CA", locale: "en-CA", timezone: "UTC", device: "desktop", surfaces: ["chatgpt_search"], windows: ["2026-10-12"] }).id;
  const slot = service.plan(planId).slots[0]!;
  service.capture(randomUUID(), {
    slotId: slot.id, prompt: question, status: "observed", reason: "", restriction: "none", observedAt: "2026-10-12T12:00:00Z", answer,
    citations: [{ url: "https://owned.example/guide", title: sourceTitle, placement: "answer_link" }],
    model: "unknown", sourceUrl: "https://chatgpt.com/c/private-session", account: "logged_out", session: "fresh", exitCountry: "CA", geo: "ip_observed", locale: "en-CA", timezone: "UTC", device: "desktop", geolocation: "denied", searchMode: "explicit_search", collectionMode: "browser_capture", retrievalUsed: null,
    browser: { name: "Google Chrome", version: "test", extractorVersion: "test", answerComplete: true, citationsComplete: true, notes: [] },
    artifact: { mime: "text/plain", base64: Buffer.from("Synthetic text evidence").toString("base64") },
  });
});
afterEach(() => { service.db.close(); rmSync(root, { recursive: true, force: true }); });

function scriptFrom(html: string) {
  return html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
}

describe("English-first report interfaces without evidence translation", () => {
  it("defaults to English and returns identical redacted evidence and data hashes for both UI locales", () => {
    const before = service.report(planId);
    const en = exportReport(service, planId), zh = exportReport(service, planId, "zh-CN");
    expect(en.html).toContain('<html lang="en">');
    expect(en.html).toContain('id="report-language"');
    expect(en.html).toContain(">简体中文</button>");
    expect(en.html).toContain("Evidence notebook");
    expect(zh.html).toContain('<html lang="zh-CN">');
    expect(zh.html).toContain(">English</button>");
    expect(en.json).toEqual(zh.json);
    expect(service.report(planId)).toEqual(before);
    expect(en.json.report.records[0]!.answer).toBe(answer);
    expect(en.json.report.records[0]!.citations[0]!.title).toBe(sourceTitle);
    expect(en.html).toContain("&lt;script&gt;not executable&lt;/script&gt;");
    expect(en.html).not.toContain("private-session");
    expect(en.htmlHash).toBe(sha256(en.html));
    expect(zh.htmlHash).toBe(sha256(zh.html));
    expect(en.htmlHash).not.toBe(zh.htmlHash);
  });

  it("allows only the exact inline language script via CSP and keeps captured text out of that script", () => {
    const { html } = exportReport(service, planId), script = scriptFrom(html);
    const hash = createHash("sha256").update(script).digest("base64");
    expect(html).toContain(`script-src 'sha256-${hash}'`);
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).toContain("default-src 'none'");
    expect(script).not.toContain(question);
    expect(script).not.toContain(answer);
    expect(script).not.toContain(sourceTitle);
    expect(script).not.toMatch(/fetch\(|XMLHttpRequest|innerHTML|\.reload\(/);
    expect(html).not.toMatch(/\sonclick=/);
  });

  it("switches authored labels, remembers a valid choice and leaves evidence and open details untouched", () => {
    const script = scriptFrom(exportReport(service, planId).html);
    const evidence = { textContent: answer }, details = { open: true };
    const heading = { dataset: { reportLabel: "originalAnswer" }, textContent: "Original answer" };
    const region = { dataset: { reportRegion: "summary" }, attributes: {} as Record<string, string>, setAttribute(key: string, value: string) { this.attributes[key] = value; } };
    let click: (() => void) | undefined;
    const button = { textContent: "", lang: "", attributes: {} as Record<string, string>, setAttribute(key: string, value: string) { this.attributes[key] = value; }, addEventListener(_name: string, handler: () => void) { click = handler; } };
    const values = new Map([["getgeo-report-ui-locale", "zh-CN"]]);
    const document = { documentElement: { lang: "en" }, title: "", getElementById: () => button, querySelector: () => ({ dataset: { reportBrand: "Synthetic" } }), querySelectorAll: (selector: string) => selector === "[data-report-label]" ? [heading] : selector === "[data-report-region]" ? [region] : [] };
    runInNewContext(script, { document, localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) } });
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(heading.textContent).toBe("答案原文");
    expect(button.textContent).toBe("English");
    expect(region.attributes["aria-label"]).toBe("按平台汇总");
    click!();
    expect(document.documentElement.lang).toBe("en");
    expect(heading.textContent).toBe("Original answer");
    expect(values.get("getgeo-report-ui-locale")).toBe("en");
    expect(evidence.textContent).toBe(answer);
    expect(details.open).toBe(true);
  });

  it("keeps original answer blocks, source titles, collection language and hashes in both Markdown languages", () => {
    const en = exportReportMarkdown(service, planId), zh = exportReportMarkdown(service, planId, "zh-CN");
    expect(en.markdown).toContain("Automatic results report");
    expect(zh.markdown).toContain("自动结果报告");
    for (const result of [en, zh]) {
      expect(result.markdown).toContain("````text\n" + answer + "\n````");
      expect(result.markdown).toContain("Original source 原始来源 \\<title\\>");
      expect(result.markdown).toContain("en-CA");
      expect(result.sha256).toBe(sha256(result.markdown));
    }
    expect(en.dataHash).toBe(zh.dataHash);
    const plan = service.plan(planId), before = JSON.stringify(plan);
    const answersEn = answerMarkdown(plan, ["owned.example"]), answersZh = answerMarkdown(plan, ["owned.example"], "zh-CN");
    expect(answersEn.markdown).toContain("Answers and sources");
    expect(answersZh.markdown).toContain("答案与来源");
    expect(answersEn.exportedAnswers).toBe(answersZh.exportedAnswers);
    expect(answersEn.sourceCount).toBe(answersZh.sourceCount);
    expect(answersEn.markdown).toContain("````text\n" + answer + "\n````");
    expect(answersZh.markdown).toContain("````text\n" + answer + "\n````");
    expect(JSON.stringify(plan)).toBe(before);
  });

  it("falls back to English for unsupported locales and keeps both copy catalogs complete", () => {
    expect(reportLocale("fr")).toBe("en");
    expect(reportCopy("fr")).toEqual(reportCopy("en"));
    expect(Object.keys(reportCopy("en"))).toEqual(Object.keys(reportCopy("zh-CN")));
  });

  it("verifies each localized HTML against its own immutable snapshot without changing the evidence hash", () => {
    const en = createSnapshot(service, planId), zh = createSnapshot(service, planId, "zh-CN");
    expect(en.snapshot.schema).toBe("geo-console-snapshot-v1");
    expect(en.snapshot.report).toEqual(zh.snapshot.report);
    expect(en.snapshot.dataHash).toBe(zh.snapshot.dataHash);
    expect(en.snapshot.htmlHash).not.toBe(zh.snapshot.htmlHash);
    expect(verifySnapshot(en.json, en.html).valid).toBe(true);
    expect(verifySnapshot(zh.json, zh.html).valid).toBe(true);
    expect(verifySnapshot(en.json, zh.html)).toMatchObject({ valid: false, issues: ["HTML 文件哈希不匹配"] });
    expect(verifySnapshot(zh.json, en.html)).toMatchObject({ valid: false, issues: ["HTML 文件哈希不匹配"] });
    expect(service.db.prepare("SELECT COUNT(*) AS count FROM console_report_snapshot").get()).toEqual({ count: 2 });
  });
});
