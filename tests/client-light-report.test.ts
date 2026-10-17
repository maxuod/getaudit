import { describe, expect, it } from "vitest";
import {
  assertClientReportHasNoSourceLeak,
  renderClientLightReport,
  type ClientLightReportSnapshot,
} from "../src/analysis/client-light-report.ts";
import { verifyClientReportHtml } from "../src/analysis/client-report-verifier.ts";
import {
  assertReportDocumentFingerprint,
  finalizeReportDocument,
} from "../src/analysis/report-credibility.ts";

const snapshot: ClientLightReportSnapshot = {
  reportId: "SAMPLE-LITE-TEST",
  generatedAt: "2026-08-15T12:00:00-03:00",
  clientName: "Sample Studio",
  clientDomain: "sample-studio.example",
  preparedBy: "Sample Agency",
  market: "English Canada",
  newExternalDataCostUsd: 0,
  seo: {
    evidenceMode: "prospect-public",
    firstPartySearchAvailable: false,
    firstPartyAnalyticsAvailable: false,
    conversionMeasurementVerified: false,
    publicDemandEvidenceAvailable: false,
    observedAt: "2026-07-26T18:49:04.008Z",
    completeness: "partial",
    onPageHealth: 99,
    pagesChecked: 168,
    pagesDiscovered: 168,
    organicOpportunities: 2,
    questionsEvaluated: 37,
    questionPagesChecked: 14,
    questionsCovered: 22,
    questionsPartial: 10,
    questionsMissing: 5,
    citationReadyAnswers: 5,
    questionProvenance: {
      websiteDerived: 21,
      researchHypotheses: 16,
      publicMarketResearch: 0,
      privateFirstParty: 0,
      publicOnlyAtSource: true,
    },
    openQualityChallenges: 6,
    postFixVerificationAt: "2026-07-26",
    homepageLabLcpMs: 4312,
    frenchHomepageLabLcpMs: 4295,
    performanceEvidence: "partial",
    missingResearch: ["Competitor research", "Page performance measurement"],
    keywordOpportunities: [
      {
        theme: "7shifts alternative",
        question: "Is Sample Studio a good alternative to 7shifts for a small Canadian restaurant?",
        buyerStage: "Evaluate",
        ownerUrl: "https://sample-studio.example/blog/7shifts-vs-sample-studio-canada",
        websiteCoverage: "partial",
        decision: "Validate demand",
        decisionNote: "Confirm market demand, then strengthen the existing owner.",
        confidence: "Early",
      },
      {
        theme: "employee scheduling software Canada",
        question: "What is the best free employee scheduling software for a small business in Canada?",
        buyerStage: "Evaluate",
        ownerUrl: "https://sample-studio.example/employee-scheduling-software-canada",
        websiteCoverage: "partial",
        decision: "Validate demand",
        decisionNote: "Confirm market demand, then strengthen the existing owner.",
        confidence: "Early",
      },
    ],
  },
  geo: {
    observedFrom: "2026-08-08 18:10:02",
    observedTo: "2026-08-08 18:13:42",
    market: "English Canada",
    questionCount: 22,
    repeatsPerQuestion: 10,
    totalObservations: 220,
    successfulObservations: 220,
    failedObservations: 0,
    ownedResponseHits: 61,
    ownedCitationRate: 61 / 220,
    brandMentionCount: 0,
    brandMentionRate: 0,
    ownedLinkCount: 72,
    ownedCitationShare: 0.0168,
    highRepeatQuestions: 6,
    mixedQuestions: 1,
    zeroOwnedCitationQuestions: 15,
    surfaceCount: 1,
    surfaceScopeLabel: "One controlled answer system",
    targetSettingsLabel: "English-Canada target settings",
    executionLocationVerified: false,
    captureQuality: "legacy-limited",
    captureLimitations: [
      "Exact collection configuration was not sealed for this historical sample.",
      "Execution location was not independently verified.",
    ],
    topOwnedPages: [
      { url: "https://sample-studio.example/restaurant-schedule-maker", citations: 20 },
      {
        url: "https://sample-studio.example/blog/cheapest-restaurant-scheduling-app-canada",
        citations: 16,
      },
    ],
    topExternalSources: [
      { domain: "reddit.com", observationsWithDomain: 159, shareOfObservations: 0.723 },
      {
        domain: "joinhomebase.com",
        observationsWithDomain: 92,
        shareOfObservations: 0.418,
      },
    ],
  },
};

describe("lightweight client reports", () => {
  it("renders the combined SEO and GEO version without implementation-source leakage", () => {
    const html = renderClientLightReport(snapshot, "combined");

    expect(html).toContain("Search &amp; AI Answer Sample Baseline");
    expect(html).toContain("Search foundation");
    expect(html).not.toContain("5,093");
    expect(html).toContain("No private search or analytics account was used");
    expect(html).toContain("Opportunity themes worth validating before a larger investment");
    expect(html).toContain("7shifts alternative");
    expect(html).toContain("Market demand check required");
    expect(html).toContain("Validate demand");
    expect(html).toContain("61/220");
    expect(html).not.toContain("Prepared Aug 15, 2026");
    expect(html).not.toContain("Saved evidence through");
    expect(html).not.toContain("New external data cost");
    expect(html).not.toContain("<br>SAMPLE-LITE-TEST");
    expect(html).not.toContain("Prepared by Sample Agency · SAMPLE-LITE-TEST");
    expect(html).not.toContain('"reportId"');
    expect(html).not.toContain("SAMPLE-LITE-TEST");
    expect(html).not.toContain('"generatedAt"');
    expect(html).toContain("Website-derived and research questions reviewed");
    expect(html).toContain("21 website-derived; 16 research hypotheses");
    expect(html).toContain("37 website-derived and research questions were checked against 14 selected public pages");
    expect(html).toContain("The primary unit is 22 questions—not 220 independent market users");
    expect(html).toContain("6 consistently cited");
    expect(html).toContain("1 mixed");
    expect(html).toContain("15 never cited");
    expect(html).toContain("execution location not independently verified");
    expect(html).toContain("missingIsNotZero");
    expect(html).toContain("--bg-deep:#050914");
    expect(html).toContain("--accent:#b98f68");
    expect(html).toContain("--accent-hover:#d9bc93");
    expect(html).toContain("--info:#73a8ed");
    expect(html).not.toContain('data:image/png;base64,');
    expect(html).toContain('aria-label="getaudit"');
    expect(html).toContain("Evidence-led client report");
    expect(html).toContain("Prepared for <strong>Sample Studio</strong>");
    expect(html).not.toContain('<svg class="logo"');
    expect(html).toContain("class=\"bar\" role=\"img\"");
    expect(html).toContain("class=\"rank-fill owned\"");
    expect(html).toContain("class=\"rank-fill external\"");
    expect(html).toContain('<span class="rank-label">reddit.com</span>');
    expect(html).toContain('<small class="rank-detail">Community discussion</small>');
    expect(html).not.toContain("reddit.com · Community discussion");
    expect(html).toContain(".rank-meta{grid-template-columns:1fr;gap:5px}");
    expect(html).not.toMatch(
      /#115e38|#082b19|#15803d|#84cc16|#fdba74|#0d0b08|#15110d|#1d1812|#241f1c|#2b241c|#5c4938|#3a3128/i,
    );
    expect(() => assertClientReportHasNoSourceLeak(html)).not.toThrow();
    expect(() => assertReportDocumentFingerprint(html)).not.toThrow();
  });

  it("renders a GEO-only version without SEO metrics or a blended score", () => {
    const html = renderClientLightReport(snapshot, "geo-only");

    expect(html).toContain("AI Answer Sample Baseline");
    expect(html).not.toContain("Search foundation");
    expect(html).not.toContain("5,093");
    expect(html).toContain("Question themes worth a deeper market check");
    expect(html).toContain("7shifts alternative");
    expect(html).toContain("61/220");
    expect(html).not.toContain("overall score");
    expect(html).toContain("class=\"rank-fill owned\"");
    expect(html).toContain("class=\"rank-fill external\"");
    expect(() => assertClientReportHasNoSourceLeak(html)).not.toThrow();
    expect(() => assertReportDocumentFingerprint(html)).not.toThrow();
  });

  it("supports a connected-client view without treating observed queries as proven return", () => {
    const connected: ClientLightReportSnapshot = {
      ...snapshot,
      seo: {
        ...snapshot.seo,
        evidenceMode: "first-party-connected",
        firstPartySearchAvailable: true,
        firstPartyAnalyticsAvailable: true,
        gscWindow: "2026-04-25 to 2026-07-23",
        gscImpressions: 5093,
        organicWindow: "2026-04-27 to 2026-07-25",
        organicSessions: 39,
        organicKeyEvents: 0,
        organicOpportunities: 1,
        questionProvenance: {
          websiteDerived: 0,
          researchHypotheses: 0,
          publicMarketResearch: 0,
          privateFirstParty: 37,
          publicOnlyAtSource: false,
        },
        keywordOpportunities: [
          {
            theme: "restaurant employee hours calculator",
            question: "Demand is split across three pages.",
            buyerStage: "Use",
            ownerUrl: "https://sample-studio.example/employee-hours-calculator",
            websiteCoverage: "partial",
            decision: "Repair first",
            decisionNote: "Clarify one page owner before increasing spend.",
            confidence: "Observed",
            impressions: 225,
            clicks: 0,
            averagePosition: 21.5,
            competingPages: 3,
          },
        ],
      },
    };
    const html = renderClientLightReport(connected, "combined");

    expect(html).toContain("5,093");
    expect(html).toContain("restaurant employee hours calculator");
    expect(html).toContain("225 observed impressions");
    expect(html).toContain("Repair first");
    expect(html).toContain('"returnEstablished":false');
    expect(() => assertClientReportHasNoSourceLeak(html)).not.toThrow();
    expect(() => assertReportDocumentFingerprint(html)).not.toThrow();
  });

  it("blocks provider and internal implementation labels in client HTML", () => {
    expect(() => assertClientReportHasNoSourceLeak("<p>Perplexity results</p>")).toThrow(
      /provider name/,
    );
    expect(() => assertClientReportHasNoSourceLeak("<p>parser v2</p>")).toThrow(
      /internal parser/,
    );
    expect(() => assertClientReportHasNoSourceLeak("<p>API source</p>")).toThrow(
      /interface label/,
    );
    expect(() => assertClientReportHasNoSourceLeak("<p>SAMPLE-LITE-GEO-20260815</p>")).toThrow(
      /internal report identifier/,
    );
  });

  it("recomputes client claims and rejects a re-fingerprinted forged numerator", () => {
    const html = renderClientLightReport(snapshot, "combined");
    const verified = verifyClientReportHtml(snapshot, "combined", html);
    expect(verified.checks).toContain("manifest-recomputation");
    expect(verified.checks).toContain("public-source-isolation");

    const forged = finalizeReportDocument(
      html.replace('"numerator":61', '"numerator":62'),
    );
    expect(() => verifyClientReportHtml(snapshot, "combined", forged)).toThrow(
      /do not recompute/,
    );
  });
});
