import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHtmlReport } from "../src/analysis/html-report.ts";
import { buildLandscape, renderLandscapeHtml } from "../src/analysis/landscape.ts";
import {
  buildReportCredibility,
  finalizeReportDocument,
} from "../src/analysis/report-credibility.ts";
import { verifyReportHtmlAgainstLedger } from "../src/analysis/report-verifier.ts";
import { closeLedger, openLedger } from "../src/db/index.ts";
import { importConsumerWebEvidence } from "../src/evidence/consumer-web.ts";
import { verifyArtifactsForRun } from "../src/evidence/artifact-verifier.ts";
import {
  addPrompts,
  createBrand,
  createPromptSet,
  freezePromptSet,
  finishRun,
  getBrand,
  listPrompts,
  PARSER_VERSION,
  recordObservation,
  startRun,
} from "../src/ledger/repo.ts";
import { assertReportHtmlPublishable } from "../src/publish.ts";
import { canonicalJson, sha256 } from "../src/lib/canonical-json.ts";

let dir: string;
let db: ReturnType<typeof openLedger>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "geo-report-credibility-"));
  closeLedger();
  db = openLedger(join(dir, "test.db"));
});

afterEach(() => {
  closeLedger();
  rmSync(dir, { recursive: true, force: true });
});

function seed(engine = "perplexity_sonar", provenanceOverride?: string) {
  const brandId = createBrand(db, {
    name: "Acme",
    ownedDomains: ["acme.example"],
    aliases: ["Acme"],
  });
  const setId = createPromptSet(db, { brandId, label: "credibility" });
  addPrompts(db, setId, [
    { text: "best widgets", locale: "en-US" },
    { text: "widget suppliers", locale: "en-US" },
  ]);
  const promptSetHash = freezePromptSet(db, setId);
  const runId = startRun(db, { promptSetId: setId, phase: "baseline", runsPerPrompt: 1 });
  const brand = getBrand(db, brandId);
  listPrompts(db, setId).forEach((prompt, index) => {
    recordObservation(db, {
      runId,
      promptId: prompt.id,
      runIdx: 1,
      brand,
      observation: {
        engine,
        provenance:
          provenanceOverride ?? (engine === "perplexity_sonar"
            ? "perplexity:sonar:https://api.perplexity.ai/chat/completions:sonar:loc=US"
            : "test:unknown"),
        fidelity: "web_grounded",
        answerText: index === 0 ? "Acme is cited." : "Other suppliers are cited.",
        citations:
          index === 0
            ? [{ url: "https://acme.example/widgets" }, { url: "https://reviews.example/a" }]
            : [{ url: "https://reviews.example/b" }],
        raw: { index },
      },
    });
  });
  finishRun(db, runId, 0);
  return { setId, promptSetHash, runId };
}

describe("报告可信度封套", () => {
  it("精确命名 API 表面并允许边界明确的描述性报告通过门禁", () => {
    const { setId, promptSetHash, runId } = seed();
    const html = buildHtmlReport(db, setId, {
      parserVersion: PARSER_VERSION,
      promptSetHash,
      runIds: [runId],
    });

    expect(html).toContain("Perplexity Sonar API");
    expect(html).toContain('name="geo-proof-report-status" content="descriptive-only"');
    expect(html).toContain('name="geo-proof-publication-gate" content="pass"');
    expect(html).toContain("API/模型代理表面的描述性观测");
    expect(() => assertReportHtmlPublishable(html)).not.toThrow();
    expect(verifyReportHtmlAgainstLedger(db, html).checks).toContain("ledger-metrics");
  });

  it("榜单以全部成功回答为分母，不再伪称全部发生了实时检索", () => {
    const { setId, promptSetHash, runId } = seed();
    const report = buildLandscape(db, setId, {
      parserVersion: PARSER_VERSION,
      vendorDomains: ["acme.example"],
      category: "Widget citation surface",
      runIds: [runId],
    });
    const html = renderLandscapeHtml(report, {
      promptSetHash,
      date: "2026-08-14",
    });

    expect(html).toContain("all successful responses");
    expect(html).toContain("All successful responses count");
    expect(html).toContain("Perplexity Sonar API");
    expect(html).not.toContain("involved live web retrieval");
    expect(html).not.toContain("Only retrieval-backed answers count");
    expect(report.vendors[0]?.shareOfAnswers).toBe(0.5);
    expect(() => assertReportHtmlPublishable(html)).not.toThrow();
  });

  it("未知产品表面只能生成 internal-only 报告，发布门禁拒绝", () => {
    const { setId, promptSetHash, runId } = seed("test_engine");
    const html = buildHtmlReport(db, setId, {
      parserVersion: PARSER_VERSION,
      promptSetHash,
      runIds: [runId],
    });

    expect(html).toContain('name="geo-proof-report-status" content="internal-only"');
    expect(html).toContain('name="geo-proof-publication-gate" content="block"');
    expect(() => assertReportHtmlPublishable(html)).toThrow(/门禁未通过/);
  });

  it("已知 engine 名但 provenance 不匹配时仍阻止发布", () => {
    const { setId, promptSetHash, runId } = seed("perplexity_sonar", "manual:renamed-surface");
    const html = buildHtmlReport(db, setId, {
      parserVersion: PARSER_VERSION,
      promptSetHash,
      runIds: [runId],
    });

    expect(html).toContain("provenance mismatch or unknown");
    expect(html).toContain('name="geo-proof-publication-gate" content="block"');
    expect(() => assertReportHtmlPublishable(html)).toThrow(/门禁未通过/);
  });

  it("机器可读封套被改写后指纹校验失败", () => {
    const { setId, promptSetHash, runId } = seed();
    const html = buildHtmlReport(db, setId, {
      parserVersion: PARSER_VERSION,
      promptSetHash,
      runIds: [runId],
    });
    const tampered = html.replace('"successfulObservations":2', '"successfulObservations":3');
    expect(tampered).not.toBe(html);
    expect(() => assertReportHtmlPublishable(tampered)).toThrow(/指纹不匹配/);
  });

  it("只改可见 HTML 也会触发整份文档指纹失败", () => {
    const { setId, promptSetHash, runId } = seed();
    const html = buildHtmlReport(db, setId, {
      parserVersion: PARSER_VERSION,
      promptSetHash,
      runIds: [runId],
    });
    const tampered = html.replace("本轮被引用的自有页面", "已证明有效的页面");
    expect(tampered).not.toBe(html);
    expect(() => assertReportHtmlPublishable(tampered)).toThrow(/整份 HTML 指纹不匹配/);
  });

  it("攻击者同步重算文件 hash 后，台账复算仍能发现伪造指标", () => {
    const { setId, promptSetHash, runId } = seed();
    const html = buildHtmlReport(db, setId, {
      parserVersion: PARSER_VERSION,
      promptSetHash,
      runIds: [runId],
    });
    const scriptPattern = /(<script type="application\/json" id="geo-proof-evidence">)([\s\S]*?)(<\/script>)/;
    const originalJson = html.match(scriptPattern)?.[2];
    expect(originalJson).toBeTruthy();
    const envelope = JSON.parse(originalJson!);
    envelope.metrics.successfulObservations = 999;
    const forgedJson = canonicalJson(envelope);
    const forgedEvidenceHash = sha256(forgedJson);
    const forged = finalizeReportDocument(
      html
        .replace(scriptPattern, `$1${forgedJson}$3`)
        .replace(
          /(<meta name="geo-proof-evidence-sha256" content=")[a-f0-9]{64}(">)/,
          `$1${forgedEvidenceHash}$2`,
        ),
    );
    expect(() => assertReportHtmlPublishable(forged)).not.toThrow();
    expect(() => verifyReportHtmlAgainstLedger(db, forged)).toThrow(/不能由台账复算/);
  });

  it("消费级网页队列在报告中保留账号、地域与 artifact 覆盖", () => {
    const brandId = createBrand(db, {
      name: "Acme",
      ownedDomains: ["acme.example"],
      aliases: ["Acme"],
    });
    const setId = createPromptSet(db, { brandId, label: "consumer web" });
    addPrompts(db, setId, [{ text: "best widgets", locale: "en-US" }]);
    freezePromptSet(db, setId);
    const [prompt] = listPrompts(db, setId);
    const artifact = Buffer.from("synthetic screenshot bytes");
    writeFileSync(join(dir, "chatgpt-001.png"), artifact);
    const imported = importConsumerWebEvidence(db, {
      schema_version: "consumer-web-evidence-v1",
      prompt_set_id: setId,
      phase: "baseline",
      surface: {
        engine: "consumer_web_chatgpt",
        provider: "OpenAI",
        product_surface: "ChatGPT Search web",
        collection_mode: "manual_capture",
        account_state: "logged_out",
        personalization_state: "fresh",
        search_mode: "explicit_search",
        target_country: "US",
        exit_country: "US",
        geo_verification: "ip_observed",
        browser_locale: "en-US",
        timezone_id: "America/New_York",
        geolocation_policy: "city_emulated",
        device: "desktop",
      },
      observations: [
        {
          prompt_id: prompt!.id,
          observed_at: "2026-08-14T12:00:00-04:00",
          answer_text: "Acme is one option.",
          citations: [{ url: "https://acme.example/widgets" }],
          retrieval_used: true,
          capture_reference: "chatgpt-001.png",
          screenshot_sha256: sha256(artifact.toString()),
        },
      ],
    });
    verifyArtifactsForRun(db, imported.runId, dir);

    const credibility = buildReportCredibility(db, setId);
    expect(credibility.blockers).toEqual([]);
    expect(credibility.cohorts[0]).toMatchObject({
      label: "ChatGPT Search web",
      surfaceClass: "consumer_web",
      accountState: "logged_out",
      personalizationState: "fresh",
      targetCountry: "US",
      exitCountry: "US",
      geoVerification: "ip_observed",
      evidenceTier: "ui-ip-artifact-verified",
      captureReferences: 1,
      evidenceHashes: 1,
      verifiedArtifacts: 1,
    });
  });
});
