import type { Ledger } from "../db/index.ts";
import { buildAttributionReport } from "./attribution.ts";
import {
  buildReportCredibility,
  createReportEvidenceEnvelope,
  finalizeReportDocument,
  reportEvidenceHead,
  type ReportCredibility,
} from "./report-credibility.ts";

/**
 * 品类榜单 —— 同一批观测里所有玩家的引用份额。
 *
 * 成本结构的关键：观测本身是品牌无关的。
 * 一次采集（$30）已经包含了品类里每个玩家被引用多少次，
 * 归属判断只发生在分析层。所以这份榜单的边际成本是零。
 *
 * 三重用途：可发布的内容素材 / 精准 leads（榜上每家都是潜客）/ 权威建立。
 *
 * 方法论上的两条红线，渲染时不能省：
 * 1. 主分母包含全部成功调用；检索、答案展示和引用是三个独立状态
 * 2. 榜单是「AI 引用份额」，不是市场份额、不是产品质量排名。
 *    混淆这两者会让整份材料失去可信度，也会招来被测厂商的正当质疑。
 */

export interface VendorRow {
  rank: number;
  domain: string;
  citations: number;
  observations: number;
  shareOfAnswers: number;
  /** 该域名被引用的观测中，占全部引用条目的比例 */
  shareOfCitations: number;
  isTarget: boolean;
}

export interface LandscapeReport {
  promptSetId: string;
  parserVersion: string;
  category: string;
  totalObservations: number;
  usableObservations: number;
  totalCitations: number;
  engines: string[];
  vendors: VendorRow[];
  /** 非厂商类高频来源（社区、评测站、政府站）——干预目标 */
  otherSources: VendorRow[];
  promptCount: number;
  runIds: string[];
  excludedEngines: string[];
  credibility: ReportCredibility;
}

export interface LandscapeOptions {
  parserVersion: string;
  /** 视为「厂商」的域名白名单。不在名单里的进 otherSources。 */
  vendorDomains: readonly string[];
  /** 高亮的目标品牌域名 */
  targetDomains?: readonly string[];
  category: string;
  runIds?: readonly string[];
  excludeEngines?: readonly string[];
  topOther?: number;
}

export function buildLandscape(
  db: Ledger,
  promptSetId: string,
  options: LandscapeOptions,
): LandscapeReport {
  const runIds = options.runIds?.filter(Boolean) ?? [];
  const excluded = options.excludeEngines?.filter(Boolean) ?? [];
  const scopeSql =
    (runIds.length ? ` AND o.run_id IN (${runIds.map(() => "?").join(",")})` : "") +
    (excluded.length ? ` AND o.engine NOT IN (${excluded.map(() => "?").join(",")})` : "");
  const scopeArgs = [...runIds, ...excluded];

  const attribution = buildAttributionReport(db, promptSetId, {
    parserVersion: options.parserVersion,
    runIds: [...runIds],
    excludeEngines: [...excluded],
  });

  const usable = { n: attribution.successfulObservations };
  const total = { n: attribution.totalObservations };

  const promptCount = db
    .prepare(`SELECT COUNT(*) AS n FROM prompt WHERE prompt_set_id = ?`)
    .get(promptSetId) as { n: number };

  const engines = (
    db
      .prepare(
        `SELECT DISTINCT o.engine FROM observation o
           JOIN prompt p ON p.id = o.prompt_id
          WHERE p.prompt_set_id = ?${scopeSql} ORDER BY o.engine`,
      )
      .all(promptSetId, ...scopeArgs) as Array<{ engine: string }>
  ).map((row) => row.engine);

  // 注意：这里 JOIN citation 是有意的（要按域名聚合引用），
  // 但 observations 必须用 COUNT(DISTINCT o.id)，否则行数膨胀。
  const rows = db
    .prepare(
      `SELECT c.domain,
              COUNT(*) AS citations,
              COUNT(DISTINCT o.id) AS observations
         FROM citation c
         JOIN observation o ON o.id = c.observation_id
         JOIN prompt p ON p.id = o.prompt_id
        WHERE p.prompt_set_id = ? AND o.fidelity != 'error'${scopeSql}
        GROUP BY c.domain
        ORDER BY citations DESC`,
    )
    .all(promptSetId, ...scopeArgs) as Array<{
    domain: string;
    citations: number;
    observations: number;
  }>;

  const totalCitations = rows.reduce((sum, row) => sum + row.citations, 0);
  const vendorSet = new Set(options.vendorDomains.map((d) => d.toLowerCase()));
  const targetSet = new Set((options.targetDomains ?? []).map((d) => d.toLowerCase()));

  const toRow = (
    row: { domain: string; citations: number; observations: number },
    rank: number,
  ): VendorRow => ({
    rank,
    domain: row.domain,
    citations: row.citations,
    observations: row.observations,
    shareOfAnswers: usable.n > 0 ? row.observations / usable.n : 0,
    shareOfCitations: totalCitations > 0 ? row.citations / totalCitations : 0,
    isTarget: targetSet.has(row.domain.toLowerCase()),
  });

  const vendors = rows
    .filter((row) => vendorSet.has(row.domain.toLowerCase()))
    .map((row, index) => toRow(row, index + 1));

  const otherSources = rows
    .filter((row) => !vendorSet.has(row.domain.toLowerCase()))
    .slice(0, options.topOther ?? 15)
    .map((row, index) => toRow(row, index + 1));

  return {
    promptSetId,
    parserVersion: options.parserVersion,
    category: options.category,
    totalObservations: total.n,
    usableObservations: usable.n,
    totalCitations,
    engines,
    vendors,
    otherSources,
    promptCount: promptCount.n,
    runIds,
    excludedEngines: excluded,
    credibility: buildReportCredibility(db, promptSetId, {
      runIds: [...runIds],
      excludeEngines: [...excluded],
    }),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 面向公开发布的榜单页。措辞刻意保守——被测厂商会来看。 */
export function renderLandscapeHtml(
  report: LandscapeReport,
  meta: { promptSetHash?: string | null; date: string; publisher?: string },
): string {
  const maxCites = Math.max(1, ...report.vendors.map((v) => v.citations));
  const engineNames = [...new Set(report.credibility.cohorts.map((cohort) => cohort.label))];
  const evidence = createReportEvidenceEnvelope({
    reportKind: "landscape",
    promptSetId: report.promptSetId,
    promptSetHash: meta.promptSetHash,
    parserVersion: report.parserVersion,
    scope: {
      runIds: report.runIds.length ? report.runIds : undefined,
      excludedEngines: report.excludedEngines.length ? report.excludedEngines : undefined,
    },
    metrics: {
      totalObservations: report.totalObservations,
      successfulObservations: report.usableObservations,
      totalCitations: report.totalCitations,
      promptCount: report.promptCount,
    },
    credibility: report.credibility,
  });

  const row = (v: VendorRow, highlight: boolean): string => `
    <tr${v.isTarget && highlight ? ' class="me"' : ""}>
      <td class="rk">${v.rank}</td>
      <td>${escapeHtml(v.domain)}</td>
      <td><div class="barwrap"><div class="bar" style="width:${(v.citations / maxCites) * 100}%"></div></div></td>
      <td class="num">${(v.shareOfAnswers * 100).toFixed(1)}%</td>
      <td class="num dim">${v.citations}</td>
    </tr>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${reportEvidenceHead(evidence)}
<title>${escapeHtml(report.category)} — AI Citation Share</title>
<style>
  :root { --ink:#14171c; --muted:#6b7280; --line:#e5e7eb; --bar:#2563eb; --me:#15803d; }
  *{box-sizing:border-box}
  body{margin:0;padding:48px 22px 72px;color:var(--ink);background:#fff;
       font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:30px;line-height:1.2;margin:0 0 8px;letter-spacing:-0.6px}
  .sub{color:var(--muted);font-size:15px;margin-bottom:30px}
  h2{font-size:19px;margin:44px 0 10px}
  p{margin:0 0 14px}
  table{width:100%;border-collapse:collapse;font-size:15px;margin:14px 0}
  th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.02em;
     text-transform:uppercase;padding:9px 10px;border-bottom:2px solid var(--line)}
  td{padding:11px 10px;border-bottom:1px solid var(--line)}
  td.rk{color:var(--muted);width:38px;font-variant-numeric:tabular-nums}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
  td.dim{font-weight:400;color:var(--muted)}
  tr.me{background:#f0fdf4}
  tr.me td{font-weight:600}
  tr.me td.rk::after{content:" ●";color:var(--me)}
  .barwrap{background:#eef1f5;border-radius:3px;height:9px;width:100%;min-width:80px}
  .bar{background:var(--bar);height:100%;border-radius:3px}
  tr.me .bar{background:var(--me)}
  .method{background:#f9fafb;border:1px solid var(--line);border-radius:12px;
          padding:20px 22px;margin:30px 0;font-size:14.5px}
  .method h3{margin:0 0 10px;font-size:15px}
  .method ul{margin:0;padding-left:20px}
  .method li{margin-bottom:6px;color:#374151}
  .caveat{border-left:3px solid #b45309;padding:12px 16px;background:#fffbeb;
          border-radius:0 8px 8px 0;margin:20px 0;font-size:14.5px}
  .hash{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted);
        word-break:break-all;margin-top:6px}
  .status{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;
          font-weight:600;background:#fffbeb;color:#92400e;border:1px solid #fcd34d}
  .surface{font-size:13px}
  .surface td{vertical-align:top}
  footer{margin-top:50px;padding-top:18px;border-top:1px solid var(--line);
         font-size:13px;color:var(--muted)}
  @media print{body{padding:0}}
</style>
</head>
<body><div class="wrap">

<h1>${escapeHtml(report.category)}</h1>
<div class="sub">
Citation frequency on the measured AI surfaces ·
${escapeHtml(meta.date)}${meta.publisher ? ` · ${escapeHtml(meta.publisher)}` : ""}
</div>

<p><span class="status">${escapeHtml(evidence.envelope.publicationStatus)}</span></p>

<p>
We submitted ${report.promptCount} recommendation-oriented questions to
${engineNames.length} explicitly identified product surfaces and recorded the cited domains.
There were ${report.totalObservations.toLocaleString()} recorded responses;
${report.usableObservations.toLocaleString()} successful responses form the denominator below.
Retrieval status is a separate field and is not used to silently remove successful answers.
</p>

<h2>Vendor citation share</h2>
<table>
<tr><th></th><th>Domain</th><th style="width:30%"></th><th class="num">Share of answers</th><th class="num">Citations</th></tr>
${report.vendors.map((v) => row(v, true)).join("")}
</table>
<p style="font-size:14px;color:var(--muted)">
"Share of answers" = the percentage of all successful responses that cited this domain
at least once. Domains can appear in the same answer, so shares do not sum to 100%.
</p>

<h2>Where else AI gets its answers</h2>
<p>
Vendor sites are not the whole picture. These non-vendor sources appear across the same
questions — communities, review directories and official sources extracted as citations.
This distribution suggests hypotheses; it does not show why a source was selected.
</p>
<table>
<tr><th></th><th>Domain</th><th style="width:30%"></th><th class="num">Share of answers</th><th class="num">Citations</th></tr>
${report.otherSources.map((v) => row(v, false)).join("")}
</table>

<div class="caveat">
<b>What this is not.</b> This measures how often each domain is cited in AI answers.
It is not market share, revenue, customer count, or a judgement of product quality.
It also does not establish consumer-product ranking, recommendation, traffic, conversion,
or the cause of any citation. ${escapeHtml(report.credibility.claimBoundary)}
</div>

<h2>Evidence surface and context</h2>
<table class="surface">
<tr><th>Measured surface</th><th>Class / collection</th><th>Geography</th><th class="num">Success</th><th>Evidence tier</th></tr>
${report.credibility.cohorts
  .map(
    (cohort) => `<tr>
  <td><b>${escapeHtml(cohort.label)}</b><br><span class="hash">${escapeHtml(cohort.provenance)}</span></td>
  <td>${escapeHtml(cohort.surfaceClass)} / ${escapeHtml(cohort.collectionMode)}</td>
  <td>target ${escapeHtml(cohort.targetCountry)}<br>exit ${escapeHtml(cohort.exitCountry)}<br>${escapeHtml(cohort.geoVerification)}</td>
  <td class="num">${cohort.successful}/${cohort.observations}</td>
  <td>${escapeHtml(cohort.evidenceTier)}</td>
</tr>`,
  )
  .join("\n")}
</table>
<p style="font-size:14px;color:var(--muted)">
Account and personalization are recorded for consumer-web cohorts; file-SHA verification proves
referenced artifact bytes existed at check time, not upstream authenticity. Unknown context remains explicit.
</p>

<div class="method">
<h3>Method</h3>
<ul>
  <li><b>${report.promptCount} questions</b>, phrased the way buyers actually ask
      an AI assistant — not search keywords.</li>
  <li><b>Sampling density:</b> ${report.credibility.sampling.minSuccessfulPerCell}–${report.credibility.sampling.maxSuccessfulPerCell}
      successful observations per prompt/surface cell; ${report.credibility.sampling.cellsWithErrors}
      of ${report.credibility.sampling.promptEngineCells} cells contained at least one error.</li>
  <li><b>Measured surfaces:</b> ${engineNames.map(escapeHtml).join(", ")}.</li>
  <li><b>All successful responses count.</b> Retrieval known/used is reported separately;
      failure rows are disclosed but excluded from the successful-response denominator.</li>
  <li><b>Observed repeatability, not stability:</b> among cells with at least two successful
      samples, ${report.credibility.sampling.alwaysOwnedCitationCells} always cited an owned domain,
      ${report.credibility.sampling.mixedOwnedCitationCells} were mixed, and
      ${report.credibility.sampling.neverOwnedCitationCells} never did. No confidence interval
      or cross-window stability claim is implied.</li>
  <li><b>Question list sealed before measurement.</b> Every recorded response is retained
      in the local append-only ledger; any external evidence export needs a separate privacy review.</li>
</ul>
${meta.promptSetHash ? `<div class="hash">Question set fingerprint: ${escapeHtml(meta.promptSetHash)}</div>` : ""}
<div class="hash">Report evidence fingerprint: ${evidence.fingerprint} (internal consistency only; not upstream authenticity)</div>
${evidence.envelope.blockers.length ? `<div class="caveat"><b>Publication gate blocked:</b> ${evidence.envelope.blockers.map(escapeHtml).join("; ")}</div>` : ""}
</div>

<footer>
Measured ${escapeHtml(meta.date)}. Figures reflect that period only — AI answers shift as
models, product surfaces, accounts, location signals and the web change.
</footer>

</div></body></html>`;
  return finalizeReportDocument(html);
}
