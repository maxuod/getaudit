import { finalizeReportDocument } from "./report-credibility.ts";

export type ClientLightReportMode = "combined" | "geo-only";

export type ClientSearchEvidenceMode = "prospect-public" | "first-party-connected";

export interface ClientKeywordOpportunity {
  theme: string;
  question: string;
  buyerStage: "Discover" | "Evaluate" | "Use" | "Trust";
  ownerUrl: string;
  websiteCoverage: "missing" | "partial" | "covered";
  decision: "Validate demand" | "Priority test" | "Repair first" | "Hold";
  decisionNote: string;
  confidence: "Early" | "Moderate" | "Observed";
  searchVolume?: number;
  difficulty?: number;
  impressions?: number;
  clicks?: number;
  averagePosition?: number;
  competingPages?: number;
}

export interface ClientSeoSnapshot {
  evidenceMode: ClientSearchEvidenceMode;
  firstPartySearchAvailable: boolean;
  firstPartyAnalyticsAvailable: boolean;
  conversionMeasurementVerified: boolean;
  publicDemandEvidenceAvailable: boolean;
  observedAt: string;
  completeness: "complete" | "partial";
  onPageHealth: number;
  pagesChecked: number;
  pagesDiscovered: number;
  gscWindow?: string;
  gscImpressions?: number;
  organicWindow?: string;
  organicSessions?: number;
  organicKeyEvents?: number;
  organicOpportunities: number;
  questionsEvaluated: number;
  questionPagesChecked: number;
  questionsCovered: number;
  questionsPartial: number;
  questionsMissing: number;
  citationReadyAnswers: number;
  questionProvenance: {
    websiteDerived: number;
    researchHypotheses: number;
    publicMarketResearch: number;
    privateFirstParty: number;
    publicOnlyAtSource: boolean;
  };
  openQualityChallenges: number;
  postFixVerificationAt: string;
  homepageLabLcpMs: number;
  frenchHomepageLabLcpMs: number;
  performanceEvidence: "partial" | "available";
  missingResearch: string[];
  keywordOpportunities: ClientKeywordOpportunity[];
}

export interface ClientGeoSnapshot {
  observedFrom: string;
  observedTo: string;
  market: string;
  questionCount: number;
  repeatsPerQuestion: number;
  totalObservations: number;
  successfulObservations: number;
  failedObservations: number;
  ownedResponseHits: number;
  ownedCitationRate: number;
  brandMentionCount: number;
  brandMentionRate: number;
  ownedLinkCount: number;
  ownedCitationShare: number;
  highRepeatQuestions: number;
  mixedQuestions: number;
  zeroOwnedCitationQuestions: number;
  surfaceCount: number;
  surfaceScopeLabel: string;
  targetSettingsLabel: string;
  executionLocationVerified: boolean;
  captureQuality: "modern-complete" | "legacy-limited";
  captureLimitations: string[];
  topOwnedPages: Array<{ url: string; citations: number }>;
  topExternalSources: Array<{
    domain: string;
    observationsWithDomain: number;
    shareOfObservations: number;
  }>;
}

export interface ClientLightReportSnapshot {
  reportId: string;
  generatedAt: string;
  clientName: string;
  clientDomain: string;
  preparedBy: string;
  market: string;
  newExternalDataCostUsd: number;
  seo: ClientSeoSnapshot;
  geo: ClientGeoSnapshot;
}

const number = new Intl.NumberFormat("en-CA");
const percent = new Intl.NumberFormat("en-CA", {
  style: "percent",
  maximumFractionDigits: 1,
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function claim(id: string): string {
  return `<span class="claim">${escapeHtml(id)}</span>`;
}

function metricCard(input: {
  value: string;
  label: string;
  note: string;
  tone?: "positive" | "attention" | "neutral";
  claimId: string;
}): string {
  return `<article class="metric ${input.tone ?? "neutral"}">
    <div class="metric-top">${claim(input.claimId)}<span class="metric-value">${escapeHtml(input.value)}</span></div>
    <h3>${escapeHtml(input.label)}</h3>
    <p>${escapeHtml(input.note)}</p>
  </article>`;
}

function sourceCategory(domain: string): string {
  if (domain.includes("reddit")) return "Community discussion";
  if (domain.includes("youtube")) return "Video";
  if (domain.endsWith(".ca") || domain.includes("gov")) return "Official / Canadian web";
  return "Industry website";
}

function pathFromUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname || "/";
  } catch {
    return value;
  }
}

function boundedPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function rankBar(input: {
  label: string;
  detail?: string;
  value: string;
  width: number;
  tone?: "owned" | "external";
}): string {
  const width = boundedPercent(input.width);
  return `<div class="rank-row">
    <div class="rank-meta"><span class="rank-copy"><span class="rank-label">${escapeHtml(input.label)}</span>${input.detail ? `<small class="rank-detail">${escapeHtml(input.detail)}</small>` : ""}</span><b class="rank-value">${escapeHtml(input.value)}</b></div>
    <div class="rank-track" role="img" aria-label="${escapeHtml(`${input.label}: ${input.value}`)}"><i class="rank-fill ${input.tone ?? "owned"}" style="width:${width.toFixed(2)}%" aria-hidden="true"></i></div>
  </div>`;
}

function logo(): string {
  return `<span class="logo" aria-label="getaudit">getaudit</span>`;
}

export function buildClientEvidenceManifest(
  snapshot: ClientLightReportSnapshot,
  mode: ClientLightReportMode,
) {
  const geo = snapshot.geo;
  const seo = snapshot.seo;
  const prospect = seo.evidenceMode === "prospect-public";
  return {
    schema: "sample-client-light-report-v3",
    mode,
    client: snapshot.clientName,
    targetMarket: snapshot.market,
    claims: {
      "GP-01": {
        evidenceClass: "controlled-answer-system-sample",
        surfaceScope: geo.surfaceScopeLabel,
        targetSetting: geo.targetSettingsLabel,
        executionLocationVerification: geo.executionLocationVerified
          ? "independently-verified"
          : "not-independently-verified",
        numerator: geo.ownedResponseHits,
        denominator: geo.successfulObservations,
      },
      "GP-02": {
        evidenceClass: "controlled-answer-system-sample",
        numerator: geo.brandMentionCount,
        denominator: geo.successfulObservations,
      },
      "GP-03": {
        evidenceClass: "question-level-repeat-profile",
        stable: geo.highRepeatQuestions,
        mixed: geo.mixedQuestions,
        absent: geo.zeroOwnedCitationQuestions,
        totalQuestions: geo.questionCount,
      },
      "KW-01": {
        evidenceClass: prospect
          ? "public-opportunity-screen"
          : "first-party-opportunity-screen",
        itemCount: seo.keywordOpportunities.length,
        firstPartySearchAvailable: seo.firstPartySearchAvailable,
        publicDemandEvidenceAvailable: seo.publicDemandEvidenceAvailable,
        conversionMeasurementVerified: seo.conversionMeasurementVerified,
        returnEstablished: false,
      },
      ...(mode === "combined"
        ? {
            "SEO-01": {
              evidenceClass: "saved-site-audit",
              audited: seo.pagesChecked,
              discovered: seo.pagesDiscovered,
              performanceEvidence: seo.performanceEvidence,
            },
            ...(prospect
              ? {
                  "SEO-02": {
                    evidenceClass: "public-prospect-screen",
                    firstPartySearchAvailable: false,
                    firstPartyAnalyticsAvailable: false,
                    publicOnlyAtSource: seo.questionProvenance.publicOnlyAtSource,
                    missingIsNotZero: true,
                  },
                }
              : {
                  "SEO-02": {
                    evidenceClass: "first-party-search-and-analytics",
                    searchWindow: seo.gscWindow,
                    analyticsWindow: seo.organicWindow,
                    missingIsNotZero: true,
                  },
                }),
            "SEO-03": {
              evidenceClass: prospect
                ? "website-and-research-question-review"
                : "question-coverage-review",
              evaluated: seo.questionsEvaluated,
              sitePagesReviewed: seo.questionPagesChecked,
              websiteDerived: seo.questionProvenance.websiteDerived,
              researchHypotheses: seo.questionProvenance.researchHypotheses,
              publicMarketResearch: seo.questionProvenance.publicMarketResearch,
              privateFirstParty: seo.questionProvenance.privateFirstParty,
            },
          }
        : {}),
    },
    boundaries: [
      "Historical descriptive observations, not current all-platform coverage.",
      "The controlled answer sample represents one measured system, not independent market users.",
      "Citation, mention, referral, conversion and qualified enquiry are separate outcomes.",
      "Integrity and recomputation do not establish representativeness or causality.",
    ],
  };
}

const style = `<style>
  :root {
    --bg-deep:#050914; --background:#0a1120; --surface:#111b2d;
    --surface-subtle:#0e1829; --surface-elevated:#18243a;
    --border:#33445f; --border-light:#223149;
    --text:#f8fafc; --text-muted:#cbd5e1; --text-soft:#94a3b8;
    --accent:#b98f68; --accent-rgb:185,143,104; --accent-hover:#d9bc93;
    --accent-deep:#8a6348; --accent-subtle:rgba(var(--accent-rgb),.15);
    --accent-text:#f0d7b4; --success:#65cc8c; --warning:#edb34f;
    --danger:#f07f73; --info:#73a8ed;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth;background:var(--bg-deep);color-scheme:dark}
  body{margin:0;background:linear-gradient(180deg,#0d1628 0%,var(--bg-deep) 100%);color:var(--text);font:16px/1.65 Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  a{color:var(--accent-text);text-decoration:none}
  a:focus-visible{outline:2px solid var(--accent-hover);outline-offset:2px}
  .report{width:min(1080px,calc(100% - 32px));margin:24px auto 64px;background:var(--background);border:1px solid var(--border-light);border-radius:24px;overflow:hidden;box-shadow:0 28px 80px rgba(0,0,0,.48)}
  .hero{padding:34px 42px 38px;background:linear-gradient(135deg,#121e31 0%,#0d1728 62%,var(--background) 100%);border-top:3px solid var(--accent);border-bottom:1px solid var(--border-light)}
  .brand-row,.hero-meta,.metric-top,.section-head,.evidence-row,.footer-row{display:flex;align-items:center}
  .brand-row{justify-content:space-between;gap:24px}
  .brand-lockup{display:flex;align-items:center;gap:12px}
  .logo{display:block;width:46px;height:46px;flex:none;border-radius:12px;box-shadow:0 0 0 1px rgba(255,255,255,.13),0 8px 24px rgba(0,0,0,.24)}
  .brand-copy{display:grid;gap:1px}
  .brand-copy strong{color:var(--text);font-size:14px;line-height:1.2;letter-spacing:.06em;text-transform:uppercase}
  .brand-copy span{color:var(--text-soft);font-size:11px;font-weight:600;letter-spacing:.04em}
  .prepared{color:var(--text-soft);font-size:12px;text-align:right}
  .prepared strong{color:var(--text)}
  .eyebrow{margin:32px 0 8px;color:var(--accent-text);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
  h1{max-width:780px;margin:0;font-size:clamp(34px,5vw,58px);line-height:1.04;letter-spacing:-.04em}
  .lede{max-width:760px;margin:18px 0 0;color:var(--text-muted);font-size:18px;line-height:1.55}
  .hero-meta{flex-wrap:wrap;gap:8px;margin-top:26px}
  .chip{padding:7px 11px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--text-muted);font-size:12px;font-weight:700}
  .nav{display:flex;gap:8px;flex-wrap:wrap;padding:16px 42px;border-bottom:1px solid var(--border-light);background:rgba(10,17,32,.94);position:sticky;top:0;z-index:3;backdrop-filter:blur(18px)}
  .nav a{padding:7px 10px;border-radius:8px;color:var(--text-muted);font-size:12px;font-weight:700}
  .nav a:hover{background:var(--accent-subtle);color:var(--accent-text)}
  main{padding:0 42px 42px}
  section{padding:42px 0;border-bottom:1px solid var(--border-light)}
  section:last-child{border-bottom:0}
  .section-head{justify-content:space-between;gap:24px;align-items:flex-end;margin-bottom:20px}
  .section-kicker{margin:0 0 5px;color:var(--accent-text);font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
  h2{margin:0;font-size:28px;line-height:1.15;letter-spacing:-.035em}
  h3{margin:0;font-size:16px;line-height:1.3}
  .section-note{max-width:440px;margin:0;color:var(--text-soft);font-size:13px;text-align:right}
  .decision-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .decision{padding:20px;border:1px solid var(--border-light);border-radius:18px;background:var(--surface)}
  .decision .num{display:grid;place-items:center;width:28px;height:28px;margin-bottom:30px;border-radius:50%;background:var(--accent);color:var(--bg-deep);font-size:12px;font-weight:800}
  .decision p,.metric p,.action p,.boundary p{margin:7px 0 0;color:var(--text-muted);font-size:14px}
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
  .metric{min-height:168px;padding:18px;border:1px solid var(--border-light);border-radius:18px;background:var(--surface)}
  .metric.positive{border-color:rgba(101,204,140,.38);box-shadow:inset 0 2px 0 rgba(101,204,140,.68)}
  .metric.attention{border-color:rgba(237,179,79,.38);box-shadow:inset 0 2px 0 rgba(237,179,79,.7)}
  .metric-top{justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:24px}
  .metric-value{font-size:32px;line-height:1;font-weight:800;letter-spacing:-.05em}
  .claim{display:inline-flex;padding:3px 7px;border:1px solid rgba(var(--accent-rgb),.42);border-radius:999px;color:var(--accent-text);font:700 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
  .split{display:grid;grid-template-columns:1.08fr .92fr;gap:18px}
  .panel{padding:22px;border:1px solid var(--border-light);border-radius:20px;background:var(--surface)}
  .panel.soft{background:var(--surface-subtle)}
  .panel h3{margin-bottom:14px}
  .coverage{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:16px}
  .coverage div{padding:13px 10px;border-radius:12px;background:var(--surface-elevated);text-align:center}
  .coverage b{display:block;font-size:22px;letter-spacing:-.04em}
  .coverage span{color:var(--text-soft);font-size:11px}
  .bar{display:flex;height:12px;margin:16px 0 10px;overflow:hidden;border-radius:999px;background:var(--surface-elevated);box-shadow:inset 0 0 0 1px var(--border-light)}
  .bar i{height:100%}
  .bar .good,.legend .good{background:var(--success)}.bar .partial,.legend .partial{background:var(--warning)}.bar .missing,.legend .missing{background:var(--danger)}
  .bar .stable,.legend .stable{background:var(--success)}.bar .mixed,.legend .mixed{background:var(--warning)}.bar .absent,.legend .absent{background:var(--surface-elevated);box-shadow:inset 0 0 0 1px var(--border)}
  .legend{display:flex;gap:16px;flex-wrap:wrap;color:var(--text-muted);font-size:11px}
  .legend i{display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%}
  .rank-list{display:grid;gap:15px}
  .rank-row{display:grid;gap:7px}
  .rank-meta{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:12px;font-size:12px}
  .rank-copy{display:block;min-width:0}
  .rank-label{display:block;color:var(--text-muted);font-weight:650;line-height:1.35;overflow-wrap:anywhere}
  .rank-detail{display:block;margin-top:3px;color:var(--text-soft);font-size:10px;line-height:1.4}
  .rank-value{align-self:start;color:var(--text);font-size:11px;line-height:1.4;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .rank-track{height:9px;overflow:hidden;border-radius:999px;background:var(--surface-elevated);box-shadow:inset 0 0 0 1px var(--border-light)}
  .rank-fill{display:block;height:100%;min-width:2px;border-radius:inherit;background:var(--accent-hover)}
  .rank-fill.external{background:var(--info)}
  .chart-note{margin:14px 0 0;color:var(--text-soft);font-size:11px}
  .callout{padding:18px 20px;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:16px;background:var(--surface-elevated);color:var(--text)}
  .callout strong{display:block;margin-bottom:5px;font-size:17px}
  .callout p{margin:0;color:var(--text-muted);font-size:13px}
  .callout.amber{border-left-color:var(--warning);background:var(--surface-elevated)}.callout.amber p{color:var(--text-muted)}
  .opportunity-list{display:grid;gap:12px;margin-top:16px}
  .opportunity{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(180px,.65fr);gap:22px;padding:20px;border:1px solid var(--border-light);border-radius:18px;background:var(--surface)}
  .opportunity-main{min-width:0}
  .opportunity-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}
  .opportunity h3{font-size:18px;overflow-wrap:anywhere}
  .opportunity-question{margin:7px 0 0;color:var(--text-muted);font-size:13px}
  .opportunity-owner{margin:12px 0 0;color:var(--text-soft);font-size:11px;overflow-wrap:anywhere}
  .opportunity-side{display:grid;align-content:start;gap:8px;padding-left:20px;border-left:1px solid var(--border-light)}
  .opportunity-side span{color:var(--text-soft);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .opportunity-side strong{font-size:15px}
  .opportunity-side p{margin:0;color:var(--text-muted);font-size:12px}
  .badge{display:inline-flex;flex:none;padding:4px 8px;border:1px solid var(--border);border-radius:999px;background:var(--surface-elevated);color:var(--text-muted);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
  .badge.attention{border-color:rgba(237,179,79,.42);color:#f6cf83}
  .badge.positive{border-color:rgba(101,204,140,.42);color:#9ae7b5}
  .signal-row{display:flex;flex-wrap:wrap;gap:7px;margin-top:13px}
  .signal{padding:5px 8px;border-radius:8px;background:var(--surface-elevated);color:var(--text-muted);font-size:11px}
  .table-wrap{overflow:auto;border:1px solid var(--border-light);border-radius:18px}
  table{width:100%;border-collapse:collapse;min-width:680px}
  th{padding:11px 14px;background:var(--surface-elevated);color:var(--text-soft);font-size:11px;text-align:left;text-transform:uppercase;letter-spacing:.06em}
  td{padding:14px;border-top:1px solid var(--border-light);vertical-align:top;font-size:13px}
  td strong{display:block;color:var(--text)}
  td small{color:var(--text-soft)}
  .right{text-align:right;font-variant-numeric:tabular-nums}
  .evidence-list{display:grid;gap:10px}
  .evidence-row{justify-content:space-between;gap:18px;padding:13px 0;border-bottom:1px solid var(--border-light)}
  .evidence-row:last-child{border-bottom:0}
  .evidence-row span{color:var(--text-muted);font-size:13px}
  .evidence-row b{font-size:13px;text-align:right}
  .actions{display:grid;gap:12px;counter-reset:actions}
  .action{display:grid;grid-template-columns:44px 1.3fr .9fr;gap:18px;padding:20px;border:1px solid var(--border-light);border-radius:18px;background:var(--surface)}
  .action::before{counter-increment:actions;content:counter(actions);display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--accent);color:var(--bg-deep);font-weight:800}
  .action .test{padding-left:18px;border-left:1px solid var(--border-light)}
  .action .test b{display:block;margin-bottom:4px;color:var(--accent-text);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
  .boundaries{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .boundary{padding:20px;border-radius:18px;border:1px solid var(--border-light)}
  .boundary.can{border-color:rgba(101,204,140,.38);background:rgba(101,204,140,.07)}.boundary.cannot{border-color:rgba(237,179,79,.38);background:rgba(237,179,79,.07)}
  .boundary ul{margin:12px 0 0;padding-left:18px;color:var(--text-muted);font-size:13px}
  .footer{padding:28px 42px;background:var(--bg-deep);color:var(--text-muted);border-top:1px solid var(--border-light)}
  .footer-row{justify-content:space-between;gap:24px}
  .footer p{margin:0;color:var(--text-soft);font-size:12px}
  .footer strong{color:var(--text)}
  .tiny{margin-top:14px!important;max-width:760px}
  @media(max-width:820px){
    .report{width:min(100% - 16px,1080px);margin:8px auto 32px;border-radius:18px}
    .hero,.footer{padding:26px 22px}.nav{padding:12px 22px;position:static}main{padding:0 22px 28px}
    .decision-grid,.metrics,.split,.boundaries{grid-template-columns:1fr 1fr}.metrics{grid-template-columns:1fr 1fr}
    .action{grid-template-columns:38px 1fr}.action .test{grid-column:2;padding:12px 0 0;border-left:0;border-top:1px solid var(--border-light)}
    .opportunity{grid-template-columns:1fr}.opportunity-side{padding:14px 0 0;border-left:0;border-top:1px solid var(--border-light)}
  }
  @media(max-width:560px){
    .decision-grid,.metrics,.split,.boundaries{grid-template-columns:1fr}.section-head{display:block}.section-note{text-align:left;margin-top:8px}.prepared{display:none}.coverage{grid-template-columns:1fr 1fr}h1{font-size:38px}
    .panel{padding:18px}.rank-list{gap:19px}.rank-meta{grid-template-columns:1fr;gap:5px}.rank-label{font-size:13px}.rank-detail{font-size:11px}.rank-value{text-align:left;color:var(--accent-text)}.rank-track{height:10px}
  }
  @media print{
    :root{--bg-deep:#fff;--background:#fff;--surface:#fff;--surface-subtle:#f8fafc;--surface-elevated:#f1f5f9;--border:#64748b;--border-light:#cbd5e1;--text:#0f172a;--text-muted:#334155;--text-soft:#64748b;--accent:#8a6348;--accent-rgb:138,99,72;--accent-hover:#6e4b34;--accent-deep:#6e4b34;--accent-subtle:#f3e7da;--accent-text:#6e4b34;--success:#32734b;--warning:#8a5b08;--danger:#a33e35;--info:#2f65a7}
    html{background:#fff;color-scheme:light}body{background:#fff}.report{width:100%;margin:0;border:0;border-radius:0;box-shadow:none}.nav{display:none}.hero{background:#f8fafc;border-top-color:var(--accent)}.metric,.panel,.decision,.action,.boundary,.rank-row{break-inside:avoid}section{break-inside:auto}.footer{background:#fff;color:var(--text);border-top:1px solid var(--border-light)}.footer p,.footer strong{color:var(--text)}
  }
</style>`;

function opportunitySection(
  snapshot: ClientLightReportSnapshot,
  mode: ClientLightReportMode,
): string {
  const seo = snapshot.seo;
  const prospect = seo.evidenceMode === "prospect-public";
  const combined = mode === "combined";
  const opportunities = seo.keywordOpportunities.slice(0, 5);
  const title = prospect
    ? combined
      ? "Opportunity themes worth validating before a larger investment"
      : "Question themes worth a deeper market check"
    : "Keyword opportunities to test before scaling";
  const note = prospect
    ? "No private search or analytics account was used. These are candidate themes, not traffic forecasts or promised returns."
    : "Observed search demand improves the screen, but a keyword is not marked for scale until qualified outcomes are verified.";
  const evidenceCopy = prospect
    ? seo.publicDemandEvidenceAvailable
      ? "Public market-demand evidence is available for this screen; company-specific conversion evidence is not."
      : "The website and buyer-question review identify plausible commercial themes. Location-specific demand and competition still need validation."
    : "This screen combines observed query performance with page ownership. Revenue and payback remain separate approval gates.";

  const cards = opportunities
    .map((item) => {
      const signals: string[] = [
        `${item.buyerStage} stage`,
        `Website: ${item.websiteCoverage} answer`,
      ];
      if (item.searchVolume !== undefined) {
        signals.push(`${number.format(item.searchVolume)} monthly searches`);
      } else if (prospect) {
        signals.push("Market demand check required");
      }
      if (item.difficulty !== undefined) signals.push(`Competition ${number.format(item.difficulty)}/100`);
      if (item.impressions !== undefined) signals.push(`${number.format(item.impressions)} observed impressions`);
      if (item.averagePosition !== undefined) signals.push(`Average position ${item.averagePosition.toFixed(1)}`);
      if (item.competingPages !== undefined && item.competingPages > 1) {
        signals.push(`${item.competingPages} pages sharing the query`);
      }
      const badgeClass = item.decision === "Priority test" ? "positive" : "attention";
      return `<article class="opportunity">
        <div class="opportunity-main">
          <div class="opportunity-top"><h3>${escapeHtml(item.theme)}</h3><span class="badge">${escapeHtml(item.buyerStage)}</span></div>
          <p class="opportunity-question">${escapeHtml(item.question)}</p>
          <div class="signal-row">${signals.map((signal) => `<span class="signal">${escapeHtml(signal)}</span>`).join("")}</div>
          <p class="opportunity-owner">Current owner: ${escapeHtml(pathFromUrl(item.ownerUrl))}</p>
        </div>
        <div class="opportunity-side"><span>Investment decision</span><strong><span class="badge ${badgeClass}">${escapeHtml(item.decision)}</span></strong><p>${escapeHtml(item.decisionNote)}</p><p>Confidence: ${escapeHtml(item.confidence)}</p></div>
      </article>`;
    })
    .join("");

  return `<section id="opportunities">
    <div class="section-head">
      <div><p class="section-kicker">Investment screen</p><h2>${escapeHtml(title)}</h2></div>
      <p class="section-note">${escapeHtml(note)}</p>
    </div>
    <div class="callout amber">${claim("KW-01")}<strong style="margin-top:10px">What this shortlist means</strong><p>${escapeHtml(evidenceCopy)}</p></div>
    <div class="opportunity-list">${cards || '<div class="panel"><p style="margin:0;color:var(--text-muted)">No opportunity themes passed the evidence screen.</p></div>'}</div>
    <p class="chart-note">First-contact reports stop at “validate” or “repair first.” After onboarding, private search, analytics and qualified-enquiry evidence can promote a tested theme to “scale.”</p>
  </section>`;
}

function geoSection(snapshot: ClientLightReportSnapshot): string {
  const geo = snapshot.geo;
  const topPages = geo.topOwnedPages.slice(0, 6);
  const external = geo.topExternalSources.slice(0, 5);
  const topOwnedCitationCount = Math.max(...topPages.map((page) => page.citations), 1);
  const questionDenominator = Math.max(geo.questionCount, 1);
  const stableWidth = (geo.highRepeatQuestions / questionDenominator) * 100;
  const mixedWidth = (geo.mixedQuestions / questionDenominator) * 100;
  const absentWidth = (geo.zeroOwnedCitationQuestions / questionDenominator) * 100;
  const captureNote = geo.captureQuality === "legacy-limited"
    ? "This historical sample predates the current full capture checks. Its counts were recomputed from saved responses, while exact collection settings and execution location remain unverified."
    : "The saved capture passed the current configuration and response-evidence checks.";
  return `<section id="ai-visibility">
    <div class="section-head">
      <div><p class="section-kicker">Controlled answer sample</p><h2>Useful pages are being cited. The brand is not yet carrying the credit.</h2></div>
      <p class="section-note">${escapeHtml(geo.surfaceScopeLabel)} · ${escapeHtml(geo.targetSettingsLabel)} · execution location ${geo.executionLocationVerified ? "verified" : "not independently verified"} · ${number.format(geo.questionCount)} customer questions.</p>
    </div>
    <div class="metrics">
      ${metricCard({ value: `${geo.ownedResponseHits}/${geo.successfulObservations}`, label: "Answers citing the website", note: `${percent.format(geo.ownedCitationRate)} of this sample contained at least one page from the audited website.`, tone: "positive", claimId: "GP-01" })}
      ${metricCard({ value: `${geo.brandMentionCount}/${geo.successfulObservations}`, label: "Answers naming the brand", note: "A citation is not the same as a brand mention or recommendation.", tone: "attention", claimId: "GP-02" })}
      ${metricCard({ value: `${geo.highRepeatQuestions}/${geo.questionCount}`, label: "Consistent question wins", note: "These questions cited an owned page in every repeated observation in this one collection window.", tone: "positive", claimId: "GP-03" })}
      ${metricCard({ value: `${geo.zeroOwnedCitationQuestions}/${geo.questionCount}`, label: "Questions with no owned citation", note: "These are opportunity areas, not proof that a new page is automatically required.", tone: "attention", claimId: "GP-04" })}
    </div>
    <div class="panel" style="margin-top:18px">
      <h3>Question-level repeat profile</h3>
      <p style="margin:0;color:var(--text-muted)">The primary unit is ${number.format(geo.questionCount)} questions—not ${number.format(geo.successfulObservations)} independent market users. Repeats show answer stability inside this one collection window.</p>
      <div class="bar" role="img" aria-label="Question-level repeat profile: ${geo.highRepeatQuestions} consistently cited, ${geo.mixedQuestions} mixed, ${geo.zeroOwnedCitationQuestions} never cited">
        <i class="stable" style="width:${stableWidth.toFixed(2)}%" aria-hidden="true"></i><i class="mixed" style="width:${mixedWidth.toFixed(2)}%" aria-hidden="true"></i><i class="absent" style="width:${absentWidth.toFixed(2)}%" aria-hidden="true"></i>
      </div>
      <div class="legend"><span><i class="stable"></i>${geo.highRepeatQuestions} consistently cited</span><span><i class="mixed"></i>${geo.mixedQuestions} mixed</span><span><i class="absent"></i>${geo.zeroOwnedCitationQuestions} never cited</span></div>
      <p class="chart-note">${escapeHtml(captureNote)}</p>
    </div>
    <div class="split" style="margin-top:18px">
      <div class="panel">
        <h3>Pages already earning citations</h3>
        <div class="rank-list">
          ${topPages.map((page) => rankBar({ label: pathFromUrl(page.url), value: `${number.format(page.citations)} extracted links`, width: (page.citations / topOwnedCitationCount) * 100 })).join("")}
        </div>
        <p class="chart-note">Bar length is relative to the most-cited owned page shown; labels carry the exact extracted-link count.</p>
      </div>
      <div class="panel soft">
        <h3>Where the sampled answers also looked</h3>
        <div class="rank-list">
          ${external.map((item) => rankBar({ label: item.domain, detail: sourceCategory(item.domain), value: `${percent.format(item.shareOfObservations)} of answers`, width: item.shareOfObservations * 100, tone: "external" })).join("")}
        </div>
        <p class="chart-note">Bar length uses the answer-level appearance rate. Frequency suggests where corroboration exists; it does not show that publishing there will cause a citation.</p>
      </div>
    </div>
  </section>`;
}

function seoSection(snapshot: ClientLightReportSnapshot): string {
  const seo = snapshot.seo;
  const prospect = seo.evidenceMode === "prospect-public";
  const questionDenominator = Math.max(seo.questionsEvaluated, 1);
  const coveredWidth = (seo.questionsCovered / questionDenominator) * 100;
  const partialWidth = (seo.questionsPartial / questionDenominator) * 100;
  const missingWidth = (seo.questionsMissing / questionDenominator) * 100;
  return `<section id="search">
    <div class="section-head">
      <div><p class="section-kicker">Search foundation</p><h2>${prospect ? "The public website is enough to find opportunity areas—not to claim traffic or return." : "The site is well covered technically, but measurement and answer gaps limit the business read."}</h2></div>
      <p class="section-note">${prospect ? "First-contact view using public website evidence. No private search or analytics account was used." : `Saved audit snapshot from ${escapeHtml(seo.observedAt)}. Dated observations are kept separate from the current recommendation.`}</p>
    </div>
    <div class="metrics">
      ${metricCard({ value: `${seo.onPageHealth}/100`, label: "On-page audit health", note: "This score excludes unavailable field performance evidence; it is not an overall growth score.", tone: "positive", claimId: "SEO-01" })}
      ${metricCard({ value: `${seo.pagesChecked}/${seo.pagesDiscovered}`, label: "Discovered pages checked", note: "The saved crawl was not truncated.", tone: "positive", claimId: "SEO-02" })}
      ${prospect
        ? metricCard({ value: number.format(seo.questionsEvaluated), label: "Website-derived and research questions reviewed", note: `${number.format(seo.questionProvenance.websiteDerived)} website-derived; ${number.format(seo.questionProvenance.researchHypotheses)} research hypotheses. These counts are not search demand.`, tone: "neutral", claimId: "SEO-03" })
        : metricCard({ value: number.format(seo.gscImpressions ?? 0), label: "Search impressions", note: `${seo.gscWindow ?? "Window unavailable"}; private search observation.`, tone: "neutral", claimId: "SEO-03" })}
      ${prospect
        ? metricCard({ value: seo.publicDemandEvidenceAvailable ? "Available" : "Not yet", label: "Market demand validation", note: "Location-specific search demand and competition are required before a larger investment decision.", tone: "attention", claimId: "SEO-04" })
        : metricCard({ value: number.format(seo.organicSessions ?? 0), label: "Organic sessions", note: `${seo.organicWindow ?? "Window unavailable"}; ${seo.organicKeyEvents ?? 0} registered key events observed.`, tone: seo.conversionMeasurementVerified ? "positive" : "attention", claimId: "SEO-04" })}
    </div>
    <div class="split" style="margin-top:18px">
      <div class="panel">
        <h3>Customer-question coverage</h3>
        <p style="margin:0;color:var(--text-muted)">${number.format(seo.questionsEvaluated)} website-derived and research questions were checked against ${number.format(seo.questionPagesChecked)} selected public pages. ${number.format(seo.citationReadyAnswers)} answers met the saved structural readiness checks; readiness is neither measured search demand nor an observed AI citation.</p>
        <div class="bar" role="img" aria-label="Question coverage: ${seo.questionsCovered} covered, ${seo.questionsPartial} partial, ${seo.questionsMissing} missing">
          <i class="good" style="width:${coveredWidth}%" aria-hidden="true"></i><i class="partial" style="width:${partialWidth}%" aria-hidden="true"></i><i class="missing" style="width:${missingWidth}%" aria-hidden="true"></i>
        </div>
        <div class="legend"><span><i class="good"></i>${seo.questionsCovered} covered</span><span><i class="partial"></i>${seo.questionsPartial} partial</span><span><i class="missing"></i>${seo.questionsMissing} missing</span></div>
      </div>
      <div class="panel soft">
        <h3>${prospect ? "Public page-performance spot check" : "Focused post-fix performance check"}</h3>
        <div class="evidence-list">
          <div class="evidence-row"><span>English homepage lab LCP</span><b>≈ ${number.format(seo.homepageLabLcpMs / 1000)} s</b></div>
          <div class="evidence-row"><span>French homepage lab LCP</span><b>≈ ${number.format(seo.frenchHomepageLabLcpMs / 1000)} s</b></div>
          <div class="evidence-row"><span>Evidence status</span><b>Diagnostic lab check</b></div>
        </div>
        <p style="margin:14px 0 0;color:var(--text-soft);font-size:12px">${prospect ? "These are diagnostic lab values from public pages, not field user experience or proof of lost revenue." : "The earlier regressions were not reproduced after remediation. Homepage performance remains a retest candidate; these lab values are not field user experience."}</p>
      </div>
    </div>
  </section>`;
}

function combinedActions(snapshot: ClientLightReportSnapshot): string {
  if (snapshot.seo.evidenceMode === "prospect-public") {
    return `<div class="actions">
      <article class="action"><div><h3>Validate demand for the shortlisted themes</h3><p>Check location-specific search demand, trend, result-page competition and commercial intent. Do not treat a plausible buyer question as proven demand.</p></div><div class="test"><b>Low-cost acceptance check</b><p>Each theme has a dated demand signal, a competition read and one clearly owned page—or is deliberately removed from the shortlist.</p></div></article>
      <article class="action"><div><h3>Strengthen three existing page owners before adding URLs</h3><p>Start with evaluation and product-use themes that already have a relevant page. Clarify the direct answer, evidence, product boundary and next step.</p></div><div class="test"><b>Acceptance check</b><p>One theme maps to one owner; the answer is visible, specific and usable without unsupported outcome claims.</p></div></article>
      <article class="action"><div><h3>Connect business measurement after onboarding</h3><p>With permission, connect search performance, consented analytics and qualified-enquiry records. Keep impressions, visits, enquiries and revenue as separate stages.</p></div><div class="test"><b>Scale gate</b><p>No keyword is promoted from “validate” to “scale” until a comparable test produces qualified outcomes at an acceptable cost.</p></div></article>
      <article class="action"><div><h3>Repeat the same AI question panel after the page batch</h3><p>Keep the market, wording, sample and repeat count comparable. Measure website citation and brand mention separately.</p></div><div class="test"><b>Measurement</b><p>A change in citation is reported as visibility evidence—not as a visit, enquiry or return.</p></div></article>
    </div>`;
  }
  return `<div class="actions">
    <article class="action"><div><h3>Verify conversion measurement before judging performance</h3><p>Confirm the consented journey and key-event registration. Zero registered events cannot yet distinguish an instrumentation gap from a conversion gap.</p></div><div class="test"><b>Low-cost acceptance check</b><p>One real internal journey appears with the intended source and event, or the report keeps conversion as not verified.</p></div></article>
    <article class="action"><div><h3>Test the highest-readiness keyword owners</h3><p>Repair split ownership first, then improve existing pages that already have observed search visibility. Create a new page only when the current owner cannot satisfy the intent.</p></div><div class="test"><b>Acceptance check</b><p>Each test has one owner, a dated baseline and a 14/28-day review using the same outcome definitions.</p></div></article>
    <article class="action"><div><h3>Turn citations into recognizable brand evidence</h3><p>Add concise, factual identity and workflow blocks to the pages already being cited. Link them to stable product, pricing, help and company evidence.</p></div><div class="test"><b>Measurement</b><p>Repeat the same question panel later; report citation and brand mention separately. Do not treat either as referral or conversion.</p></div></article>
    <article class="action"><div><h3>Retest the two homepages after one performance pass</h3><p>Inspect the largest above-the-fold resource, font delivery and render path, then repeat the same lab check and compare field data when available.</p></div><div class="test"><b>Acceptance check</b><p>A repeated result, not a single run, shows whether the diagnostic is still present.</p></div></article>
  </div>`;
}

function geoActions(): string {
  return `<div class="actions">
    <article class="action"><div><h3>Add a clear brand answer to the pages already winning</h3><p>Keep the useful answer first, then state who the audited brand is, who it serves, what the workflow covers and where it stops. Avoid promotional superlatives.</p></div><div class="test"><b>Low-cost acceptance check</b><p>The top cited pages contain one self-contained brand answer with stable product evidence and no unsupported outcome claim.</p></div></article>
    <article class="action"><div><h3>Use the 15 zero-citation questions as a review queue, not a page quota</h3><p>Map each question to an existing owner. Regulatory questions should use current official sources; product and comparison questions need factual workflow evidence.</p></div><div class="test"><b>Acceptance check</b><p>Every selected question has one owner, one evidence requirement and a reason to refresh or deliberately take no action.</p></div></article>
    <article class="action"><div><h3>Run one comparable follow-up only after the page batch is fixed</h3><p>Keep the market, wording, sample and repeat count comparable. Compare website citation and brand mention separately.</p></div><div class="test"><b>Measurement</b><p>No success claim unless the follow-up is complete; referral, conversion and qualified enquiry remain outside this sample.</p></div></article>
  </div>`;
}

export function assertClientReportHasNoSourceLeak(html: string): void {
  const forbidden: Array<[RegExp, string]> = [
    [/\bperplexity\b/i, "provider name"],
    [/\bsonar\b/i, "product name"],
    [/\bdataforseo\b/i, "supplier name"],
    [/\bapi\b/i, "interface label"],
    [/chat\/completions/i, "interface path"],
    [/\bparser\b/i, "internal parser"],
    [/\bprompt[- ]set\b/i, "internal set identifier"],
    [/\bendpoint\b/i, "interface endpoint"],
    [/collection[_ -]run/i, "internal run identifier"],
    [/\breportId\b/i, "internal report identifier field"],
    [/\bgeneratedAt\b/i, "internal generation timestamp field"],
    [/\bSAMPLE-LITE-[A-Z0-9-]+\b/i, "internal report identifier"],
  ];
  const leak = forbidden.find(([pattern]) => pattern.test(html));
  if (leak) throw new Error(`Client report leaks ${leak[1]}`);
}

export function renderClientLightReport(
  snapshot: ClientLightReportSnapshot,
  mode: ClientLightReportMode,
): string {
  const geo = snapshot.geo;
  const seo = snapshot.seo;
  const combined = mode === "combined";
  const prospect = seo.evidenceMode === "prospect-public";
  const title = combined
    ? "Search & AI Answer Sample Baseline"
    : "AI Answer Sample Baseline";
  const description = combined
    ? prospect
      ? "A lightweight first-contact review using public website, search-opportunity and controlled answer-system evidence. It identifies where to investigate further without including private analytics or promising return."
      : "A lightweight client baseline combining the saved SEO audit with GEO Proof observations. It prioritizes the next decisions without blending different outcome types into one score."
    : "A focused controlled answer-system review showing where the website was cited, where the brand was absent, and which buyer-question themes merit a deeper market check.";
  const manifest = JSON.stringify(buildClientEvidenceManifest(snapshot, mode)).replace(/</g, "\\u003c");

  const html = `<!doctype html>
<html lang="en-CA">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="sample-report-kind" content="${mode}">
  <script type="application/json" id="client-evidence-manifest">${manifest}</script>
  <title>${escapeHtml(title)} — ${escapeHtml(snapshot.clientName)}</title>
  ${style}
</head>
<body>
<article class="report">
  <header class="hero">
    <div class="brand-row">
      <div class="brand-lockup">${logo()}<span class="brand-copy"><strong>${escapeHtml(snapshot.preparedBy)}</strong><span>Evidence-led client report</span></span></div>
      <div class="prepared">Prepared for <strong>${escapeHtml(snapshot.clientName)}</strong></div>
    </div>
    <p class="eyebrow">Lightweight client baseline</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="lede">${escapeHtml(description)}</p>
    <div class="hero-meta">
      <span class="chip">Target market: ${escapeHtml(snapshot.market)}</span>
    </div>
  </header>
  <nav class="nav" aria-label="Report sections">
    <a href="#decisions">Decisions</a>${combined ? '<a href="#search">Search</a>' : ""}<a href="#opportunities">Opportunities</a><a href="#ai-visibility">AI sample</a><a href="#actions">Actions</a><a href="#measurement">Measurement</a>
  </nav>
  <main>
    <section id="decisions">
      <div class="section-head"><div><p class="section-kicker">Executive read</p><h2>Three decisions from the available evidence</h2></div><p class="section-note">This is a prioritization report, not a certification of rankings, platform-wide visibility or business lift.</p></div>
      <div class="decision-grid">
        <article class="decision"><span class="num">1</span><h3>${combined ? prospect ? "Validate opportunity before scaling" : "Protect the search foundation" : "Protect the reliable question wins"}</h3><p>${combined ? prospect ? `${seo.pagesChecked} public pages were checked. The site shows plausible commercial themes, but private performance and company conversion data were not used.` : `${seo.pagesChecked} pages were checked and the on-page foundation is strong, but performance and some external research remain incomplete.` : "The winning pages answer concrete scheduling, café and tip-policy questions. Keep their intent focused and their evidence current."}</p></article>
        <article class="decision"><span class="num">2</span><h3>Make the brand explicit where the site is already cited</h3><p>${geo.highRepeatQuestions} of ${geo.questionCount} questions cited the website consistently, ${geo.mixedQuestions} produced mixed results and ${geo.zeroOwnedCitationQuestions} never cited it. Useful content is not yet translating into brand recognition.</p></article>
        <article class="decision"><span class="num">3</span><h3>${combined ? prospect ? "Earn the right to make a return claim" : "Fix measurement before claiming growth" : "Test gaps without turning them into a content quota"}</h3><p>${combined ? prospect ? "First-contact evidence can prioritize research. Search visibility, visits, enquiries and return require permissioned measurement after onboarding." : "Search visibility, website sessions, AI citations and qualified enquiries are different outcomes. Conversion instrumentation must be verified before diagnosing commercial performance." : `${geo.zeroOwnedCitationQuestions} of ${geo.questionCount} questions had no owned citation in this sample. Review owners and evidence needs before creating anything new.`}</p></article>
      </div>
    </section>
    ${combined ? seoSection(snapshot) : ""}
    ${opportunitySection(snapshot, mode)}
    ${geoSection(snapshot)}
    <section id="actions">
      <div class="section-head"><div><p class="section-kicker">Recommended next work</p><h2>${combined ? "A practical 30–60 day sequence" : "A focused, low-cost GEO sequence"}</h2></div><p class="section-note">Each action has a visible acceptance check. Predicted gains remain hypotheses until observed.</p></div>
      ${combined ? combinedActions(snapshot) : geoActions()}
    </section>
    <section id="measurement">
      <div class="section-head"><div><p class="section-kicker">Measurement contract</p><h2>Keep the outcome stages separate</h2></div><p class="section-note">A single blended score would hide where progress actually occurs.</p></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Stage</th><th>Question answered</th><th>Current status</th><th>Next evidence</th></tr></thead>
        <tbody>
          ${prospect ? `<tr><td><strong>Public demand</strong></td><td>Does this theme appear worth deeper research?</td><td>${seo.publicDemandEvidenceAvailable ? "Public demand evidence available" : "Candidate themes only; market size not yet validated"}</td><td>Location-specific demand, trend and competition</td></tr>` : ""}
          ${combined
            ? prospect
              ? `<tr><td><strong>Search visibility</strong></td><td>Is the company already being shown for the theme?</td><td>No private search data used</td><td>Permissioned search-performance connection</td></tr>
          <tr><td><strong>Organic visit</strong></td><td>Did someone reach the website from search?</td><td>No private analytics used</td><td>Consented, hostname-scoped analytics</td></tr>`
              : `<tr><td><strong>Search visibility</strong></td><td>Are pages being shown in search?</td><td>${number.format(seo.gscImpressions ?? 0)} impressions in the saved window</td><td>Comparable page/query window</td></tr>
          <tr><td><strong>Organic visit</strong></td><td>Did someone reach the website from search?</td><td>${number.format(seo.organicSessions ?? 0)} sessions in the saved window</td><td>Hostname-scoped analytics</td></tr>`
            : ""}
          <tr><td><strong>Website citation</strong></td><td>Was a page from the audited website used as a source?</td><td>${geo.highRepeatQuestions} consistent, ${geo.mixedQuestions} mixed and ${geo.zeroOwnedCitationQuestions} absent across ${geo.questionCount} questions</td><td>Comparable repeated sample</td></tr>
          <tr><td><strong>Brand mention</strong></td><td>Was the audited brand named in the answer?</td><td>${geo.brandMentionCount}/${geo.successfulObservations} repeated observations in one controlled answer system</td><td>Comparable repeated sample</td></tr>
          <tr><td><strong>Referral</strong></td><td>Did an AI answer send a website visit?</td><td>${combined && !prospect ? "Reported separately in private analytics" : "Not measured in this report"}</td><td>Source/session evidence</td></tr>
          <tr><td><strong>Conversion / enquiry</strong></td><td>Did the visit create a meaningful business outcome?</td><td>${combined && seo.conversionMeasurementVerified ? "Measurement verified; outcome still reported separately" : "Not verified in this report"}</td><td>Registered event or qualified-enquiry record</td></tr>
        </tbody>
      </table></div>
    </section>
    <section id="boundaries">
      <div class="section-head"><div><p class="section-kicker">Evidence boundary</p><h2>What this preview can and cannot support</h2></div><p class="section-note">Exact collection and calculation records remain in the internal verification ledger; implementation details are intentionally omitted here.</p></div>
      <div class="boundaries">
        <article class="boundary can"><h3>Supported by this preview</h3><ul>
          ${combined ? `<li>The saved public crawl checked ${seo.pagesChecked} of ${seo.pagesDiscovered} discovered pages.</li>${prospect ? "<li>The opportunity shortlist was built without private search, analytics or customer records.</li>" : "<li>Search and analytics values are dated observations, not forecasts.</li>"}` : ""}
          <li>The shortlist identifies themes for validation; it does not label them as proven-return investments.</li>
          <li>${geo.highRepeatQuestions} of ${geo.questionCount} questions consistently cited an owned page; ${geo.mixedQuestions} ${geo.mixedQuestions === 1 ? "was" : "were"} mixed and ${geo.zeroOwnedCitationQuestions} never did.</li>
          <li>Brand mention, website citation and source frequency are separately calculated.</li>
        </ul></article>
        <article class="boundary cannot"><h3>Not established by this preview</h3><ul>
          <li>Current coverage across every consumer AI product or every geography; this is one controlled answer system using target-market settings.</li>
          ${geo.executionLocationVerified ? "" : "<li>The execution location was not independently verified.</li>"}
          <li>That a source, page edit or third-party mention caused the observed result.</li>
          <li>That citation or mention generated traffic, conversion or qualified enquiries.</li>
          ${combined ? prospect ? "<li>Actual rankings, traffic, enquiries, revenue or keyword-level return.</li>" : "<li>Complete competitor, keyword or field performance coverage.</li>" : "<li>Search demand, ranking position or keyword-level return.</li>"}
        </ul></article>
      </div>
    </section>
  </main>
  <footer class="footer">
    <div class="footer-row"><div><strong>${escapeHtml(snapshot.clientName)}</strong><p>${escapeHtml(snapshot.clientDomain)} · ${escapeHtml(snapshot.market)}</p></div><p>Prepared by ${escapeHtml(snapshot.preparedBy)}</p></div>
    <p class="tiny">Sample Studio is described here as scheduling and payroll-preparation support for Canadian small restaurants and cafés. It is not represented as payroll processing, legal advice, compliance automation, demand forecasting or a complete restaurant-management system.</p>
  </footer>
</article>
</body>
</html>`;

  const finalized = finalizeReportDocument(html);
  assertClientReportHasNoSourceLeak(finalized);
  return finalized;
}
