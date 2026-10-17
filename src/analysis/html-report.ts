import type { Ledger } from "../db/index.ts";
import { buildAttributionReport, type AttributionOptions } from "./attribution.ts";
import {
  buildReportCredibility,
  createReportEvidenceEnvelope,
  engineSurfaceLabel,
  finalizeReportDocument,
  reportEvidenceHead,
} from "./report-credibility.ts";

/**
 * 人类可读的 HTML 报告。
 *
 * 定位：给不看终端的人（客户、投资人、你自己三个月后）看的那一份。
 * 原则和文本报告一致：主引用率以全部成功调用为分母，检索和 AIO 展示另列条件指标。
 * 自包含单文件，无外部依赖，双击即可打开。
 */

interface PromptWin {
  text: string;
  engine: string;
  hits: number;
  runs: number;
}

interface OwnedUrl {
  url: string;
  citations: number;
}

interface RetrievalByEngine {
  engine: string;
  label: string;
  total: number;
  retrieved: number;
  unknownOrNotRetrieved: number;
  errors: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export interface HtmlReportOptions extends AttributionOptions {
  /** 报告标题下方的副标题，通常写实验阶段和日期 */
  subtitle?: string;
  promptSetHash?: string | null;
}

export function buildHtmlReport(
  db: Ledger,
  promptSetId: string,
  options: HtmlReportOptions,
): string {
  const report = buildAttributionReport(db, promptSetId, options);

  const runIds = options.runIds?.filter(Boolean) ?? [];
  const excluded = options.excludeEngines?.filter(Boolean) ?? [];
  const scopeSql =
    (runIds.length ? ` AND o.run_id IN (${runIds.map(() => "?").join(",")})` : "") +
    (excluded.length ? ` AND o.engine NOT IN (${excluded.map(() => "?").join(",")})` : "");
  const scopeArgs = [...runIds, ...excluded];

  // 每条 prompt 在每个引擎上的重复命中次数：描述该轮重复性，不作稳定承诺。
  const wins = db
    .prepare(
      `SELECT p.text, o.engine,
              COUNT(DISTINCT o.id) AS hits,
              (SELECT COUNT(DISTINCT o2.id) FROM observation o2
                WHERE o2.prompt_id = p.id AND o2.engine = o.engine
                  AND o2.fidelity != 'error'
                  ${runIds.length ? `AND o2.run_id IN (${runIds.map(() => "?").join(",")})` : ""}
              ) AS runs
         FROM observation o
         JOIN prompt p ON p.id = o.prompt_id
         JOIN citation c ON c.observation_id = o.id
        WHERE p.prompt_set_id = ? AND o.fidelity != 'error'
          AND c.ownership = 'owned'${scopeSql}
        GROUP BY p.text, o.engine
        ORDER BY hits DESC`,
    )
    .all(...runIds, promptSetId, ...scopeArgs) as unknown as PromptWin[];

  const ownedUrls = db
    .prepare(
      `SELECT c.url, COUNT(*) AS citations
         FROM citation c
         JOIN observation o ON o.id = c.observation_id
         JOIN prompt p ON p.id = o.prompt_id
        WHERE p.prompt_set_id = ? AND o.fidelity != 'error'
          AND c.ownership = 'owned'${scopeSql}
        GROUP BY c.url ORDER BY citations DESC LIMIT 15`,
    )
    .all(promptSetId, ...scopeArgs) as unknown as OwnedUrl[];

  const credibility = buildReportCredibility(db, promptSetId, {
    runIds: [...runIds],
    excludeEngines: [...excluded],
  });
  const labelForEngine = (engine: string): string => {
    const labels = [
      ...new Set(
        credibility.cohorts
          .filter((cohort) => cohort.engine === engine)
          .map((cohort) => cohort.label),
      ),
    ];
    return labels.length ? labels.join(" / ") : engineSurfaceLabel(engine);
  };

  const fidelity: RetrievalByEngine[] = report.perEngine.map((engine) => ({
    engine: engine.engine,
    label: labelForEngine(engine.engine),
    total: engine.observations,
    retrieved: engine.retrievalUsed,
    unknownOrNotRetrieved: engine.successful - engine.retrievalUsed,
    errors: engine.errors,
  }));

  const maxDomainCitations = Math.max(1, ...report.topThirdPartyDomains.map((d) => d.citations));
  const strongWins = wins.filter((w) => w.runs > 0 && w.hits / w.runs >= 0.8);
  const evidence = createReportEvidenceEnvelope({
    reportKind: "attribution",
    promptSetId,
    promptSetHash: options.promptSetHash,
    parserVersion: report.parserVersion,
    scope: report.scope,
    metrics: {
      totalObservations: report.totalObservations,
      successfulObservations: report.successfulObservations,
      errors: report.errors,
      ownedCitationRate: report.ownedCitationRate,
      brandMentionRate: report.brandMentionRate,
      ownedCitationShare: report.ownedCitationShare,
    },
    credibility,
  });

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${reportEvidenceHead(evidence)}
<title>AI 引用面报告 — ${escapeHtml(report.brandName)}</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b35;
    --text: #e6e9ef; --muted: #9aa4b5; --accent: #4ade80;
    --warn: #fbbf24; --bad: #f87171; --bar: #3b82f6;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px;
    background: var(--bg); color: var(--text);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 40px 0 12px; padding-top: 20px; border-top: 1px solid var(--line); }
  h2:first-of-type { border-top: none; }
  .sub { color: var(--muted); font-size: 14px; margin-bottom: 24px; }
  .meta { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
          padding: 14px 16px; font-size: 13px; color: var(--muted); margin-bottom: 28px; }
  .meta code { color: var(--text); font-size: 12px; word-break: break-all; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
  .card .n { font-size: 28px; font-weight: 600; letter-spacing: -0.5px; }
  .card .l { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .good { color: var(--accent); } .warn { color: var(--warn); } .bad { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-weight: 500; color: var(--muted); font-size: 12px;
       padding: 8px 10px; border-bottom: 1px solid var(--line); }
  td { padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  .barwrap { background: #20242e; border-radius: 3px; height: 8px; overflow: hidden; min-width: 60px; }
  .bar { background: var(--bar); height: 100%; border-radius: 3px; }
  .fid { display: flex; height: 10px; border-radius: 3px; overflow: hidden; min-width: 100px; }
  .fid i { display: block; height: 100%; }
  .note { background: var(--panel); border-left: 3px solid var(--warn);
          padding: 12px 16px; border-radius: 0 8px 8px 0; margin: 14px 0; font-size: 14px; }
  .note.ok { border-left-color: var(--accent); }
  .note.bad { border-left-color: var(--bad); }
  .note b { color: var(--text); }
  .legend { font-size: 12px; color: var(--muted); margin-top: 8px; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px;
              margin: 0 4px 0 12px; vertical-align: middle; }
  .u { font-size: 13px; color: var(--muted); word-break: break-all; }
  .status { display:inline-block; padding:3px 8px; border-radius:999px; font-size:12px;
            font-weight:600; color:var(--warn); border:1px solid #854d0e; }
  .evidence td { vertical-align:top; }
  .mono { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--muted);
          word-break:break-all; }
</style>
</head>
<body><div class="wrap">

<h1>AI 引用面报告 — ${escapeHtml(report.brandName)}</h1>
<div class="sub">${escapeHtml(options.subtitle ?? "")}</div>
<p><span class="status">${escapeHtml(evidence.envelope.publicationStatus)}</span></p>

<div class="meta">
  ${options.promptSetHash ? `prompt 集 hash（未事后筛选的凭证）<br><code>${escapeHtml(options.promptSetHash)}</code><br><br>` : ""}
  ${runIds.length ? `采集轮次 <code>${runIds.map(escapeHtml).join(", ")}</code><br>` : ""}
  ${excluded.length ? `已排除引擎 <code>${excluded.map(escapeHtml).join(", ")}</code>（覆盖不全或配额失效，纳入会污染分布）<br>` : ""}
  parser <code>${escapeHtml(report.parserVersion)}</code><br>
  观测总数 ${report.totalObservations} 条，其中 <b style="color:var(--text)">${report.successfulObservations} 条成功调用</b>（主引用率分母）
  <br>证据边界：${escapeHtml(credibility.claimBoundary)}
</div>

<h2>核心指标</h2>
<div class="cards">
  <div class="card">
    <div class="n ${report.ownedCitationRate >= 0.1 ? "good" : "warn"}">${pct(report.ownedCitationRate)}</div>
    <div class="l">自有域名被引用率<br>（多少次回答引用了你的站）</div>
  </div>
  <div class="card">
    <div class="n ${report.brandMentionRate >= 0.05 ? "good" : "bad"}">${pct(report.brandMentionRate)}</div>
    <div class="l">品牌被提及率<br>（多少次回答提到你的名字）</div>
  </div>
  <div class="card">
    <div class="n">${pct(report.ownedCitationShare)}</div>
    <div class="l">你的链接占全部引用的比例</div>
  </div>
  <div class="card">
    <div class="n">${strongWins.length}</div>
    <div class="l">本轮高重复命中<br>（本轮 ≥80%，非稳定承诺）</div>
  </div>
</div>

${
  report.brandMentionRate < report.ownedCitationRate / 2
    ? `<div class="note"><b>引用 ≠ 推荐。</b>AI 引用了你的页面当资料源，却很少在正文里提你的品牌名。
       这是两个独立观测指标。本轮数据不能判定差异由内容质量、第三方提及、产品表面、检索行为或其他因素造成。</div>`
    : ""
}

<h2>证据表面与采集上下文</h2>
<p class="sub" style="margin:0 0 12px">
产品表面必须按实际端点命名。API、模型代理、SERP 功能和消费级网页不是可互换的证据。
</p>
<table class="evidence">
<tr><th>实际表面</th><th>类别 / 方式</th><th>地域</th><th>账号 / 个性化</th><th class="num">成功</th><th>证据层</th></tr>
${credibility.cohorts
  .map(
    (cohort) => `<tr>
  <td><b>${escapeHtml(cohort.label)}</b><br><span class="mono">${escapeHtml(cohort.provenance)}</span></td>
  <td>${escapeHtml(cohort.surfaceClass)}<br>${escapeHtml(cohort.collectionMode)}</td>
  <td>target ${escapeHtml(cohort.targetCountry)}<br>exit ${escapeHtml(cohort.exitCountry)}<br>${escapeHtml(cohort.geoVerification)}</td>
  <td>${escapeHtml(cohort.accountState)}<br>${escapeHtml(cohort.personalizationState)}</td>
  <td class="num">${cohort.successful}/${cohort.observations}</td>
  <td>${escapeHtml(cohort.evidenceTier)}</td>
</tr>`,
  )
  .join("\n")}
</table>
<div class="note">
<b>证据等级不是“真实性分数”。</b>消费级网页的 artifact 层表示引用文件已通过逐文件 SHA 校验；整份报告还会对照台账复算。它们仍不能证明上游网页、账号或供应商没有变化或伪造。
</div>

<h2>各引擎实际检索了吗</h2>
<p class="sub" style="margin:0 0 12px">
模型有搜索工具不代表它会用。绿色是上游明确报告发生检索；灰色包含未检索和上游未提供状态，两者不能混为一谈。
</p>
<table>
<tr><th>引擎</th><th style="width:38%">检索状态</th><th class="num">明确检索</th><th class="num">未检索/未知</th><th class="num">失败</th></tr>
${fidelity
  .map((f) => {
    const g = (f.retrieved / f.total) * 100;
    const w = (f.unknownOrNotRetrieved / f.total) * 100;
    const e = (f.errors / f.total) * 100;
    return `<tr>
      <td>${escapeHtml(f.label)}</td>
      <td><div class="fid">
        <i style="width:${g}%;background:var(--accent)"></i>
        <i style="width:${w}%;background:#4b5563"></i>
        <i style="width:${e}%;background:var(--bad)"></i>
      </div></td>
      <td class="num good">${f.retrieved}</td>
      <td class="num" style="color:var(--muted)">${f.unknownOrNotRetrieved}</td>
      <td class="num ${f.errors ? "bad" : ""}">${f.errors || "—"}</td>
    </tr>`;
  })
  .join("\n")}
</table>
<div class="legend"><i style="background:var(--accent)"></i>明确检索<i style="background:#4b5563"></i>未检索或上游未知<i style="background:var(--bad)"></i>失败</div>

${
  strongWins.length
    ? `<h2>本轮高重复自有引用的问题</h2>
<p class="sub" style="margin:0 0 12px">这些问题在本轮重复采样中的自有引用率达到 80% 以上；单轮结果不能证明跨轮稳定，更不能作为因果承诺。</p>
<table>
<tr><th>用户问题</th><th>引擎</th><th class="num">命中</th></tr>
${strongWins
  .slice(0, 15)
  .map(
    (w) => `<tr>
  <td>${escapeHtml(w.text)}</td>
  <td style="color:var(--muted);font-size:13px">${escapeHtml(labelForEngine(w.engine))}</td>
  <td class="num good">${w.hits}/${w.runs}</td>
</tr>`,
  )
  .join("\n")}
</table>`
    : `<div class="note bad"><b>本轮没有高重复命中。</b>没有问题达到 80% 以上；这是描述性基线，不推断原因。</div>`
}

${
  ownedUrls.length
    ? `<h2>本轮被引用的自有页面</h2>
<table>
<tr><th>页面</th><th class="num">被引用次数</th></tr>
${ownedUrls
  .map(
    (u) =>
      `<tr><td class="u">${escapeHtml(u.url)}</td><td class="num">${u.citations}</td></tr>`,
  )
  .join("\n")}
</table>`
    : ""
}

<h2>本轮提取到的第三方引用域名</h2>
<p class="sub" style="margin:0 0 12px">
「出现率」= 每 100 次成功回答里有多少次引用了该域名。排在前面的不一定是竞品；
本表可用于提出渠道或内容假设，但不能说明模型为何引用，也不能证明进入该域名就会提升引用。
</p>
<table>
<tr><th>域名</th><th style="width:32%"></th><th class="num">引用数</th><th class="num">出现率</th></tr>
${report.topThirdPartyDomains
  .map(
    (d) => `<tr>
  <td>${escapeHtml(d.domain)}</td>
  <td><div class="barwrap"><div class="bar" style="width:${(d.citations / maxDomainCitations) * 100}%"></div></div></td>
  <td class="num">${d.citations}</td>
  <td class="num">${pct(d.shareOfObservations)}</td>
</tr>`,
  )
  .join("\n")}
</table>

<h2>该怎么读这份报告</h2>
<div class="note ${report.ownedCitationShare < 0.1 ? "" : "ok"}">
${
  report.ownedCitationShare < 0.1
    ? `<b>本轮自有链接占全部提取引用不足 10%。</b>这可以形成一个待验证假设：
       评估上表高频第三方域名是否存在合规、真实且与买家相关的参与机会。
       本轮分布本身不能决定渠道优先级或预估提升。`
    : `<b>本轮自有链接在全部提取引用中占据可观份额。</b>这可以形成一个待验证假设：
       对已被引用页面的结构、主题和来源质量做人工复核，再预注册一项自有站干预。
       当前数据不能证明继续扩产同类页面一定有效。`
}
</div>
<h2>重复采样与缺失披露</h2>
<div class="note">
共 ${credibility.sampling.promptEngineCells} 个 prompt/表面单元；成功样本数范围为
${credibility.sampling.minSuccessfulPerCell}–${credibility.sampling.maxSuccessfulPerCell}。
${credibility.sampling.cellsWithErrors} 个单元至少有一次错误。仅看成功样本不少于 2 的单元：
${credibility.sampling.alwaysOwnedCitationCells} 个始终出现自有引用，
${credibility.sampling.mixedOwnedCitationCells} 个结果混合，
${credibility.sampling.neverOwnedCitationCells} 个从未出现。
这只是本轮重复性描述；未把调用当作独立用户，也未声称跨时间稳定或给出因果区间。
</div>
<div class="note">
<b>这份报告不能证明因果。</b>它是干预前的基线快照 ——
只有在冻结 prompt 集、预注册假设、完成干预后再次采集，
对比同一批问题的引用率变化，才谈得上「我做的事带来了提升」。
</div>

<div class="meta">
  报告证据指纹 <code>${evidence.fingerprint}</code><br>
  只用于校验机器可读封套与本报告是否一致，不证明上游响应真实性。
  ${evidence.envelope.blockers.length ? `<br><b style="color:var(--bad)">发布门禁：blocked</b> — ${evidence.envelope.blockers.map(escapeHtml).join("；")}` : `<br><b style="color:var(--accent)">发布门禁：pass</b>（仅限按上述边界作为描述性报告）`}
</div>

</div></body></html>`;
  return finalizeReportDocument(html);
}
