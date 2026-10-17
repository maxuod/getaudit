import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAttributionReport } from "../analysis/attribution.ts";
import {
  buildReportCredibility,
} from "../analysis/report-credibility.ts";
import {
  renderClientLightReport,
  type ClientGeoSnapshot,
  type ClientKeywordOpportunity,
  type ClientLightReportSnapshot,
  type ClientSearchEvidenceMode,
  type ClientSeoSnapshot,
} from "../analysis/client-light-report.ts";
import { verifyClientReportHtml } from "../analysis/client-report-verifier.ts";
import type { Ledger } from "../db/index.ts";
import { inspectRunIntegrity } from "../ledger/run-integrity.ts";

export interface PreviewConfig {
  schema_version: string;
  client: {
    name: string;
    domain: string;
    market: string;
    prepared_by: string;
  };
  generated_at: string;
  new_external_data_cost_usd: number;
  geo: {
    database: string;
    prompt_set_id: string;
    run_ids: string[];
    parser_version: string;
    market: string;
    allow_legacy_run_without_config?: boolean;
  };
  seo: {
    evidence_mode?: ClientSearchEvidenceMode;
    database: string;
    audit_job_id: string;
    public_question_run_id?: string;
    post_fix_verification_at: string;
    homepage_lab_lcp_ms: number;
    french_homepage_lab_lcp_ms: number;
    performance_evidence: "partial" | "available";
  };
  outputs: {
    combined: string;
    geo_only: string;
  };
}

interface StoredSeoReport {
  generatedAt: string;
  completeness: "complete" | "partial";
  seoHealthScore: number;
  executiveSummary: string[];
  stats: Array<{ label: string; value: string; evidence: string }>;
  dataSources: Array<{ name: string; status: string; detail: string }>;
  qualityGate: { openChallenges: number };
}

interface StoredAuditJob {
  report?: StoredSeoReport;
  aeoRunId?: string;
  organicPerformanceRunId?: string;
}

interface StoredAeoQuestion {
  question: string;
  sources: string[];
  seed: string;
  searchVolume: number | null;
  difficulty: number | null;
  priority: number;
  opportunity: {
    stage: "discover" | "evaluate" | "use" | "trust";
    businessValue: number;
    confidence: number;
  };
  coverage: "missing" | "partial" | "covered";
  targetUrl: string | null;
  citationReady?: boolean;
}

interface StoredAeoRun {
  mode?: string;
  sources?: {
    gsc?: { status?: string; rowCount?: number; questionCount?: number };
    site?: { status?: string; pageCount?: number };
  };
  questions: StoredAeoQuestion[];
}

interface StoredOrganicOpportunity {
  priority: "P1" | "P2" | "P3";
  type: string;
  query: string;
  pageUrl: string;
  detail: string;
}

interface StoredOrganicRun {
  gsc?: {
    queryPages: Array<{
      query: string;
      page: string;
      clicks: number;
      impressions: number;
      position: number;
    }>;
  };
  ga4?: {
    warnings?: string[];
  };
  warnings?: string[];
  opportunities: StoredOrganicOpportunity[];
}

function requireRow<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function numberFrom(value: string): number {
  const parsed = Number(value.replaceAll(",", "").match(/-?[\d.]+/)?.[0]);
  if (!Number.isFinite(parsed)) throw new Error(`Cannot parse numeric value: ${value}`);
  return parsed;
}

function stat(report: StoredSeoReport, label: string): number {
  const row = report.stats.find((item) => item.label === label);
  if (!row) throw new Error(`Saved SEO report is missing stat: ${label}`);
  return numberFrom(row.value);
}

function sourceWindow(report: StoredSeoReport, name: string): string {
  const row = report.dataSources.find((item) => item.name === name);
  if (!row) return "Window not available";
  const match = row.detail.match(/(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);
  return match ? `${match[1]} to ${match[2]}` : row.detail;
}

function questionCoverage(report: StoredSeoReport): {
  evaluated: number;
  missing: number;
  partial: number;
  covered: number;
  citationReady: number;
} {
  const line = report.executiveSummary.find((item) => item.includes("question"));
  const match = line?.match(
    /(\d+) customer questions: (\d+) missing, (\d+) partial, (\d+) covered, and (\d+) citation-ready/,
  );
  if (!match) throw new Error("Saved SEO report question-coverage summary is unavailable");
  return {
    evaluated: Number(match[1]),
    missing: Number(match[2]),
    partial: Number(match[3]),
    covered: Number(match[4]),
    citationReady: Number(match[5]),
  };
}

function buyerStage(value: StoredAeoQuestion["opportunity"]["stage"]): ClientKeywordOpportunity["buyerStage"] {
  if (value === "evaluate") return "Evaluate";
  if (value === "use") return "Use";
  if (value === "trust") return "Trust";
  return "Discover";
}

function prospectQuestionScreen(db: DatabaseSync, runId: string): {
  questions: StoredAeoQuestion[];
  opportunities: ClientKeywordOpportunity[];
  publicDemandEvidenceAvailable: boolean;
  provenance: ClientSeoSnapshot["questionProvenance"];
  sitePagesReviewed: number;
} {
  const row = db
    .prepare("SELECT data FROM aeo_question_audit_runs WHERE id = ?")
    .get(runId) as { data: string } | undefined;
  const run = JSON.parse(requireRow(row, "Saved public question audit was not found").data) as StoredAeoRun;
  const privateSources = /^(gsc|ga4|crm|analytics|first-party)/i;
  const privateQuestions = run.questions.filter((item) =>
    item.sources.some((source) => privateSources.test(source)),
  );
  const gsc = run.sources?.gsc;
  if (
    privateQuestions.length ||
    gsc?.status !== "not-provided" ||
    (gsc.rowCount ?? 0) !== 0 ||
    (gsc.questionCount ?? 0) !== 0
  ) {
    throw new Error(
      "Prospect report requires a question audit collected with first-party search disabled at source",
    );
  }
  const questions = run.questions;
  const category = (item: StoredAeoQuestion): "website" | "research" | "market" => {
    if (item.sources.includes("site")) return "website";
    if (item.sources.some((source) => source === "tracked-prompt" || source === "derived")) {
      return "research";
    }
    return "market";
  };
  const provenance: ClientSeoSnapshot["questionProvenance"] = {
    websiteDerived: questions.filter((item) => category(item) === "website").length,
    researchHypotheses: questions.filter((item) => category(item) === "research").length,
    publicMarketResearch: questions.filter((item) => category(item) === "market").length,
    privateFirstParty: 0,
    publicOnlyAtSource: true,
  };
  const seen = new Set<string>();
  const opportunities = questions
    .filter((item) => item.coverage !== "covered" && item.opportunity.businessValue >= 88)
    .sort((a, b) => b.priority - a.priority || b.opportunity.businessValue - a.opportunity.businessValue)
    .filter((item) => {
      const key = item.seed.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5)
    .map<ClientKeywordOpportunity>((item) => ({
      theme: item.seed,
      question: item.question,
      buyerStage: buyerStage(item.opportunity.stage),
      ownerUrl: item.targetUrl ?? "/",
      websiteCoverage: item.coverage,
      decision: "Validate demand",
      decisionNote:
        item.coverage === "missing"
          ? "Confirm market demand, then add the missing answer to the existing owner before considering a new page."
          : "Confirm market demand, then strengthen the existing owner and test the result before increasing spend.",
      confidence:
        item.searchVolume !== null || item.difficulty !== null
          ? "Moderate"
          : "Early",
      ...(item.searchVolume !== null ? { searchVolume: item.searchVolume } : {}),
      ...(item.difficulty !== null ? { difficulty: item.difficulty } : {}),
    }));
  return {
    questions,
    opportunities,
    publicDemandEvidenceAvailable: provenance.publicMarketResearch > 0 && questions.some(
      (item) => item.searchVolume !== null || item.difficulty !== null,
    ),
    provenance,
    sitePagesReviewed: run.sources?.site?.pageCount ?? 0,
  };
}

function inferredBuyerStage(query: string): ClientKeywordOpportunity["buyerStage"] {
  if (/software|alternative|vs\b|best\b/i.test(query)) return "Evaluate";
  if (/scheduler|maker|calculator|create|make|schedule/i.test(query)) return "Use";
  return "Discover";
}

function connectedKeywordScreen(db: DatabaseSync, runId: string): {
  opportunities: ClientKeywordOpportunity[];
  conversionMeasurementVerified: boolean;
} {
  const row = db
    .prepare("SELECT data FROM organic_performance_runs WHERE id = ?")
    .get(runId) as { data: string } | undefined;
  const run = JSON.parse(requireRow(row, "Saved organic performance run was not found").data) as StoredOrganicRun;
  const queryPages = run.gsc?.queryPages ?? [];
  const opportunities = run.opportunities
    .map<ClientKeywordOpportunity>((item) => {
      const rows = queryPages.filter((row) => row.query === item.query);
      const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
      const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
      const weightedPosition = impressions
        ? rows.reduce((sum, row) => sum + row.position * row.impressions, 0) / impressions
        : undefined;
      const repairFirst = item.type === "query-page-mismatch";
      return {
        theme: item.query,
        question: item.detail,
        buyerStage: inferredBuyerStage(item.query),
        ownerUrl: item.pageUrl,
        websiteCoverage: repairFirst ? "partial" : "covered",
        decision: repairFirst ? "Repair first" : "Priority test",
        decisionNote: repairFirst
          ? "Clarify one page owner before adding content or promotion budget."
          : "Use a dated 14/28-day test; scale only after qualified outcomes are verified.",
        confidence: "Observed",
        impressions,
        clicks,
        ...(weightedPosition !== undefined ? { averagePosition: weightedPosition } : {}),
        competingPages: new Set(rows.map((entry) => entry.page)).size,
      };
    })
    .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))
    .slice(0, 5);
  const warnings = [...(run.warnings ?? []), ...(run.ga4?.warnings ?? [])];
  return {
    opportunities,
    conversionMeasurementVerified: !warnings.some((warning) =>
      /zero registered key events|instrumentation.*unverified|key-event instrumentation/i.test(warning),
    ),
  };
}

export function loadSeoSnapshot(config: PreviewConfig): ClientSeoSnapshot {
  const db = new DatabaseSync(resolve(config.seo.database), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT data FROM full_audit_jobs WHERE id = ?")
      .get(config.seo.audit_job_id) as { data: string } | undefined;
    const job = JSON.parse(requireRow(row, "Saved SEO audit job was not found").data) as StoredAuditJob;
    const report = requireRow(job.report, "Saved SEO audit job has no completed report");
    const evidenceMode = config.seo.evidence_mode ?? "first-party-connected";
    const publicScreen = evidenceMode === "prospect-public"
      ? prospectQuestionScreen(
          db,
          requireRow(
            config.seo.public_question_run_id,
            "Prospect report requires an independently collected public question run",
          ),
        )
      : undefined;
    const connectedScreen =
      evidenceMode === "first-party-connected" && job.organicPerformanceRunId
        ? connectedKeywordScreen(db, job.organicPerformanceRunId)
        : undefined;
    const savedQuestions = questionCoverage(report);
    const publicCoverage = publicScreen
      ? {
          evaluated: publicScreen.questions.length,
          missing: publicScreen.questions.filter((item) => item.coverage === "missing").length,
          partial: publicScreen.questions.filter((item) => item.coverage === "partial").length,
          covered: publicScreen.questions.filter((item) => item.coverage === "covered").length,
          citationReady: publicScreen.questions.filter((item) => item.citationReady).length,
        }
      : undefined;
    const questions = evidenceMode === "prospect-public"
      ? requireRow(publicCoverage, "Public question coverage is unavailable")
      : savedQuestions;
    const pagesChecked = stat(report, "Pages checked");
    return {
      evidenceMode,
      firstPartySearchAvailable: evidenceMode === "first-party-connected",
      firstPartyAnalyticsAvailable: evidenceMode === "first-party-connected",
      conversionMeasurementVerified:
        evidenceMode === "first-party-connected"
          ? (connectedScreen?.conversionMeasurementVerified ?? false)
          : false,
      publicDemandEvidenceAvailable:
        evidenceMode === "prospect-public"
          ? (publicScreen?.publicDemandEvidenceAvailable ?? false)
          : false,
      observedAt: report.generatedAt,
      completeness: report.completeness,
      onPageHealth: stat(report, "On-page audit health"),
      pagesChecked,
      pagesDiscovered: pagesChecked,
      ...(evidenceMode === "first-party-connected"
        ? {
            gscWindow: sourceWindow(report, "Google Search Console"),
            gscImpressions: stat(report, "GSC impressions"),
            organicWindow: sourceWindow(report, "GA4 Organic Search"),
            organicSessions: stat(report, "Organic sessions"),
            organicKeyEvents: stat(report, "Organic key events"),
          }
        : {}),
      organicOpportunities:
        evidenceMode === "prospect-public"
          ? (publicScreen?.opportunities.length ?? 0)
          : stat(report, "Organic opportunities"),
      questionsEvaluated: questions.evaluated,
      questionPagesChecked:
        evidenceMode === "prospect-public"
          ? requireRow(publicScreen, "Public question page scope is unavailable").sitePagesReviewed
          : pagesChecked,
      questionsCovered: questions.covered,
      questionsPartial: questions.partial,
      questionsMissing: questions.missing,
      citationReadyAnswers: questions.citationReady,
      questionProvenance:
        evidenceMode === "prospect-public"
          ? requireRow(publicScreen, "Public question provenance is unavailable").provenance
          : {
              websiteDerived: 0,
              researchHypotheses: 0,
              publicMarketResearch: 0,
              privateFirstParty: questions.evaluated,
              publicOnlyAtSource: false,
            },
      openQualityChallenges: report.qualityGate.openChallenges,
      postFixVerificationAt: config.seo.post_fix_verification_at,
      homepageLabLcpMs: config.seo.homepage_lab_lcp_ms,
      frenchHomepageLabLcpMs: config.seo.french_homepage_lab_lcp_ms,
      performanceEvidence: config.seo.performance_evidence,
      missingResearch: report.dataSources
        .filter((item) => ["partial", "skipped", "not-connected", "invalid"].includes(item.status))
        .map((item) => item.name),
      keywordOpportunities:
        evidenceMode === "prospect-public"
          ? (publicScreen?.opportunities ?? [])
          : (connectedScreen?.opportunities ?? []),
    };
  } finally {
    db.close();
  }
}

export function loadGeoSnapshot(config: PreviewConfig): ClientGeoSnapshot {
  const db = new DatabaseSync(resolve(config.geo.database), { readOnly: true });
  try {
    if (!config.geo.run_ids.length) throw new Error("Client GEO report requires fixed run IDs");
    const options = {
      parserVersion: config.geo.parser_version,
      runIds: config.geo.run_ids,
      topN: 10,
    };
    const report = buildAttributionReport(
      db as unknown as Ledger,
      config.geo.prompt_set_id,
      options,
    );
    const credibility = buildReportCredibility(
      db as unknown as Ledger,
      config.geo.prompt_set_id,
      { runIds: config.geo.run_ids },
    );
    if (credibility.cohorts.length !== 1) {
      throw new Error("Lightweight client preview requires one non-pooled observation surface");
    }
    const cohort = requireRow(credibility.cohorts[0], "GEO observation context is unavailable");
    const integrity = config.geo.run_ids.map((runId) =>
      inspectRunIntegrity(db as unknown as Ledger, runId),
    );
    const invalid = integrity.filter((item) => !item.valid);
    const legacyOnly = invalid.every(
      (item) =>
        item.sealed &&
        item.errors.length === 1 &&
        item.errors[0] === "run 缺少 canonical config/hash",
    );
    if (
      invalid.length &&
      (!config.geo.allow_legacy_run_without_config || !legacyOnly)
    ) {
      throw new Error(
        `Client GEO source integrity failed: ${invalid.flatMap((item) => item.errors).join("; ")}`,
      );
    }
    const rawCoverage = db
      .prepare(
        `SELECT COUNT(*) AS successful,
                SUM(CASE WHEN raw_response IS NOT NULL THEN 1 ELSE 0 END) AS with_raw
           FROM observation
          WHERE fidelity != 'error'
            AND run_id IN (${config.geo.run_ids.map(() => "?").join(",")})`,
      )
      .get(...config.geo.run_ids) as { successful: number; with_raw: number | null };
    const modernCaptureComplete =
      invalid.length === 0 &&
      cohort.contextRows === cohort.observations &&
      cohort.evidenceHashes === cohort.observations &&
      (rawCoverage.with_raw ?? 0) === rawCoverage.successful;
    if (!modernCaptureComplete && invalid.length === 0) {
      throw new Error(
        "Modern client GEO run is missing full surface context, response evidence hashes or raw responses",
      );
    }
    const executionLocationVerified =
      cohort.locationStatus === "matched" &&
      ["ip_observed", "provider_asserted"].includes(cohort.geoVerification);
    const questionRow = db
      .prepare("SELECT COUNT(*) AS n FROM prompt WHERE prompt_set_id = ?")
      .get(config.geo.prompt_set_id) as { n: number };
    const ownedPages = db
      .prepare(
        `SELECT c.url, COUNT(*) AS citations
           FROM citation c
           JOIN observation o ON o.id = c.observation_id
           JOIN prompt p ON p.id = o.prompt_id
          WHERE p.prompt_set_id = ?
            AND o.fidelity != 'error'
            AND c.ownership = 'owned'
            AND o.run_id IN (${config.geo.run_ids.map(() => "?").join(",")})
          GROUP BY c.url
          ORDER BY citations DESC, c.url
          LIMIT 10`,
      )
      .all(config.geo.prompt_set_id, ...config.geo.run_ids) as unknown as Array<{
      url: string;
      citations: number;
    }>;
    const ownedLinkRow = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM citation c
           JOIN observation o ON o.id = c.observation_id
           JOIN prompt p ON p.id = o.prompt_id
          WHERE p.prompt_set_id = ?
            AND o.fidelity != 'error'
            AND c.ownership = 'owned'
            AND o.run_id IN (${config.geo.run_ids.map(() => "?").join(",")})`,
      )
      .get(config.geo.prompt_set_id, ...config.geo.run_ids) as { n: number };
    return {
      observedFrom: cohort.observedFrom,
      observedTo: cohort.observedTo,
      market: config.geo.market,
      questionCount: questionRow.n,
      repeatsPerQuestion: credibility.sampling.maxSuccessfulPerCell,
      totalObservations: report.totalObservations,
      successfulObservations: report.successfulObservations,
      failedObservations: report.errors,
      ownedResponseHits: Math.round(report.ownedCitationRate * report.successfulObservations),
      ownedCitationRate: report.ownedCitationRate,
      brandMentionCount: Math.round(report.brandMentionRate * report.successfulObservations),
      brandMentionRate: report.brandMentionRate,
      ownedLinkCount: ownedLinkRow.n,
      ownedCitationShare: report.ownedCitationShare,
      highRepeatQuestions: credibility.sampling.alwaysOwnedCitationCells,
      mixedQuestions: credibility.sampling.mixedOwnedCitationCells,
      zeroOwnedCitationQuestions: credibility.sampling.neverOwnedCitationCells,
      surfaceCount: credibility.cohorts.length,
      surfaceScopeLabel: "One controlled answer system",
      targetSettingsLabel: `${config.geo.market.replace(/\s+/g, "-")} target settings`,
      executionLocationVerified,
      captureQuality: modernCaptureComplete ? "modern-complete" : "legacy-limited",
      captureLimitations: modernCaptureComplete
        ? []
        : [
            "Exact collection configuration was not sealed for this historical sample.",
            ...(executionLocationVerified
              ? []
              : ["Execution location was not independently verified."]),
          ],
      topOwnedPages: ownedPages,
      topExternalSources: report.topThirdPartyDomains.map((item) => ({
        domain: item.domain,
        observationsWithDomain: item.observationsWithDomain,
        shareOfObservations: item.shareOfObservations,
      })),
    };
  } finally {
    db.close();
  }
}

function output(path: string, html: string): void {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, html, "utf8");
  console.log(resolved);
}

export function loadPreviewConfig(
  path: string,
): PreviewConfig {
  const config = JSON.parse(readFileSync(resolve(path), "utf8")) as PreviewConfig;
  if (
    config.schema_version !== "sample-client-light-preview-v1" &&
    config.schema_version !== "sample-client-light-preview-v2" &&
    config.schema_version !== "sample-client-light-preview-v3"
  ) {
    throw new Error(`Unsupported preview config: ${config.schema_version}`);
  }
  return config;
}

export function loadClientLightSnapshot(config: PreviewConfig): ClientLightReportSnapshot {
  return {
    reportId: "",
    generatedAt: config.generated_at,
    clientName: config.client.name,
    clientDomain: config.client.domain,
    preparedBy: config.client.prepared_by,
    market: config.client.market,
    newExternalDataCostUsd: config.new_external_data_cost_usd,
    seo: loadSeoSnapshot(config),
    geo: loadGeoSnapshot(config),
  };
}

export function generateClientPreviews(config: PreviewConfig): void {
  const reportDate = config.generated_at.slice(0, 10).replaceAll("-", "");
  const source = loadClientLightSnapshot(config);
  const combined = renderClientLightReport(
    { ...source, reportId: `SAMPLE-LITE-FULL-${reportDate}` },
    "combined",
  );
  const geoOnly = renderClientLightReport(
    { ...source, reportId: `SAMPLE-LITE-GEO-${reportDate}` },
    "geo-only",
  );

  // Re-open both evidence stores before writing. The second read is deliberate:
  // a generated claim must still match its sources at the publication gate.
  const verificationSource = loadClientLightSnapshot(config);
  const combinedCheck = verifyClientReportHtml(verificationSource, "combined", combined);
  const geoCheck = verifyClientReportHtml(verificationSource, "geo-only", geoOnly);

  output(config.outputs.combined, combined);
  output(config.outputs.geo_only, geoOnly);
  console.log(`Client report checks: ${combinedCheck.checks.join(", ")}`);
  console.log(`Combined evidence fingerprint: ${combinedCheck.evidenceSha256}`);
  console.log(`GEO-only evidence fingerprint: ${geoCheck.evidenceSha256}`);
  if (geoCheck.limitations.length) {
    console.log(`Disclosed historical limitations: ${geoCheck.limitations.join("; ")}`);
  }
  console.log("External data collection used for this generation: $0.00");
}

function main(): void {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Provide your own report configuration file.");
  generateClientPreviews(loadPreviewConfig(configPath));
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
