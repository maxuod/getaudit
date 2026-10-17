import { canonicalJson, sha256 } from "../lib/canonical-json.ts";
import type { LabService } from "./service.ts";
import { reportCopies, reportCopy, reportLocale, type ReportCopyKey, type ReportLocale } from "./report-language.ts";
const escape = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
/** Exports are a separate, redacted derivative. Raw artifacts stay in the local ledger. */
export function redact(text: string) {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[已隐去邮箱]")
    .replace(/\b(?:sk|ghp|gho)[-_][a-zA-Z0-9_-]{12,}\b/g, "[已隐去密钥]")
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]{8,}/gi, "[已隐去令牌]")
    .replace(
      /([?&](?:token|key|api_key|access_token|secret|password|signature)=)[^&\s"<>]+/gi,
      "$1REDACTED",
    );
}
export function exportReport(service: LabService, planId: string, locale: ReportLocale = "en") {
  const base = service.report(planId),
    baseHash = sha256(canonicalJson(base));
  type Draft = {
    summary: string;
    findings: {
      kind: string;
      claim: string;
      nextAction: string;
      sources: { slotId: string; quote: string }[];
    }[];
  };
  let analyses: {
    id: string;
    model: string;
    inputHash: string;
    result: Draft;
  }[] = [];
  if (
    service.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='console_ai_review'")
      .get()
  ) {
    const rows = service.db
      .prepare(
        "SELECT j.id,j.model,j.input_json,j.input_hash,j.result_json FROM console_ai_job j JOIN console_ai_review r ON r.job_id=j.id WHERE j.plan_id=? AND r.decision='accept' AND j.status='draft' ORDER BY j.created_at",
      )
      .all(planId) as {
      id: string;
      model: string;
      input_json: string;
      input_hash: string;
      result_json: string;
    }[];
    analyses = rows
      .filter((r) => JSON.parse(r.input_json).reportHash === baseHash)
      .map((r) => ({
        id: r.id,
        model: r.model,
        inputHash: r.input_hash,
        result: JSON.parse(r.result_json) as Draft,
      }));
  }
  const report = JSON.parse(
    redact(JSON.stringify({ ...base, analyses })),
  ) as typeof base & { analyses: typeof analyses };
  const hash = sha256(canonicalJson(report));
  const initialLocale = reportLocale(locale), copy = reportCopy(initialLocale);
  const t = (key: ReportCopyKey) => `<span data-report-label="${key}">${escape(copy[key])}</span>`;
  // Only the static authored dictionary enters this script. Captured content never becomes code.
  const script = `(() => {
    const copies = ${JSON.stringify(reportCopies).replace(/</g, "\\u003c")};
    const button = document.getElementById('report-language');
    const title = document.querySelector('title');
    const storageKey = 'getgeo-report-ui-locale';
    let locale = '${initialLocale}';
    const valid = value => value === 'en' || value === 'zh-CN';
    const apply = () => {
      const copy = copies[locale];
      document.documentElement.lang = locale;
      document.querySelectorAll('[data-report-label]').forEach(node => {
        const key = node.dataset.reportLabel;
        if (Object.prototype.hasOwnProperty.call(copy, key)) node.textContent = copy[key];
      });
      document.querySelectorAll('[data-report-region]').forEach(node => {
        const key = node.dataset.reportRegion;
        if (Object.prototype.hasOwnProperty.call(copy, key)) node.setAttribute('aria-label', copy[key]);
      });
      button.textContent = locale === 'en' ? '简体中文' : 'English';
      button.lang = locale === 'en' ? 'zh-CN' : 'en';
      button.setAttribute('aria-label', locale === 'en' ? 'Switch to Simplified Chinese' : '切换为英文');
      document.title = title.dataset.reportBrand + ' · ' + copy.evidenceReport + ' · getaudit';
    };
    try { const saved = localStorage.getItem(storageKey); if (valid(saved)) locale = saved; } catch {}
    apply();
    button.addEventListener('click', () => {
      locale = locale === 'en' ? 'zh-CN' : 'en';
      apply();
      try { localStorage.setItem(storageKey, locale); } catch {}
    });
  })();`;
  const scriptHash = Buffer.from(sha256(script), "hex").toString("base64");
  const html = `<!doctype html>
<html lang="${initialLocale}"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'">
<title data-report-brand="${escape(report.brand)}">${escape(report.brand)} · ${escape(copy.evidenceReport)} · getaudit</title>
<style>
:root{--paper:#fff;--surface:#fff3e9;--ink:#29251f;--muted:#72695f;--line:#eadfd7;--orange:#c7460b;--orange-bright:#f36b24}
*{box-sizing:border-box}html{background:#fff7f0;color:var(--ink)}body{margin:0;padding:32px 24px 64px;font:15px/1.65 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.notebook{max-width:1120px;margin:auto;background:var(--paper);border:1px solid var(--line);border-radius:24px;padding:32px 40px;box-shadow:0 12px 42px #9a461008}header{border-bottom:1px solid var(--line);padding-bottom:26px}.brand-row{display:flex;justify-content:space-between;gap:16px;align-items:center}.brand{display:inline-flex;align-items:center;gap:11px;font-size:27px;font-weight:800;letter-spacing:-1.3px}.brand::before{content:"";display:block;width:30px;height:30px;border-radius:13px 13px 10px 11px;background:radial-gradient(ellipse 2px 4px at 12px 15px,var(--ink) 95%,transparent),radial-gradient(ellipse 2px 4px at 20px 15px,var(--ink) 95%,transparent),var(--orange-bright);transform:rotate(-8deg)}.report-language{background:var(--paper);border:1px solid var(--line);border-radius:999px;color:var(--ink);padding:10px 16px;min-height:44px;cursor:pointer;font:inherit;white-space:nowrap;transition:background 160ms ease,border-color 160ms ease}.report-language:hover{background:var(--surface);border-color:var(--orange)}button:focus-visible,summary:focus-visible,a:focus-visible,.table-scroll:focus-visible{outline:3px solid var(--orange);outline-offset:4px}.kind{display:inline-block;color:var(--orange);background:var(--surface);border-radius:8px;padding:4px 9px;font-size:12px;font-weight:650;margin:22px 0 12px}h1{font-size:clamp(26px,4vw,40px);line-height:1.2;letter-spacing:-1.2px;margin:0 0 12px;overflow-wrap:anywhere}h2{font-size:24px;line-height:1.3;margin:32px 0 14px;letter-spacing:-.55px}h3{font-size:18px;line-height:1.4}p{max-width:78ch}small{display:block;color:var(--muted);overflow-wrap:anywhere;font-size:12px}.scope{padding:19px 0 0}.scope p{margin:6px 0 14px}.table-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:14px}table{width:100%;min-width:810px;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:14px 12px;border-bottom:1px solid var(--line);vertical-align:top}th{background:var(--surface);font-weight:650}tbody tr:last-child td{border-bottom:0}.metric-label{color:var(--muted);font-size:11px;display:block}.metric-value{white-space:nowrap}.limits{font-size:13px;color:var(--muted);margin:16px 0 24px}article{padding:24px 0;border-top:1px solid var(--line)}article h2{margin:0 0 14px;font-size:22px;overflow-wrap:anywhere}.record-meta{font-size:13px;color:var(--muted)}.notes{background:var(--surface);border-left:3px solid var(--orange-bright);padding:12px 16px;border-radius:0 10px 10px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:#fffaf6;border:1px solid var(--line);border-radius:12px;padding:18px;margin:12px 0 18px}.original-answer{line-height:1.8}ul{padding-left:24px}li{margin:8px 0}a{color:var(--orange);text-decoration-thickness:1px;text-underline-offset:3px;overflow-wrap:anywhere}a:hover{color:var(--ink)}details{margin:18px 0}summary{cursor:pointer;padding:10px 0;color:var(--orange)}details[open] pre{animation:unfold 160ms ease-out}blockquote{margin:16px 0;padding:12px 20px;border-left:3px solid var(--orange-bright);background:var(--surface)}footer{border-top:1px solid var(--line);padding-top:20px;margin-top:10px;color:var(--muted);font-size:13px}footer p{margin-top:8px}.report-maker{font-size:16px;font-weight:750;letter-spacing:-.6px;color:var(--orange)}@keyframes unfold{from{opacity:.6}to{opacity:1}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}@media(max-width:600px){body{padding:12px 10px 32px}.notebook{padding:22px 18px;border-radius:18px}.brand-row{gap:8px}.brand{font-size:24px}.report-language{font-size:13px;padding:9px 12px}h2{font-size:21px}pre{padding:14px}article h2{font-size:20px}}@media print{html{background:white}body{padding:0}.notebook{border:0;border-radius:0;box-shadow:none;padding:0}.report-language{display:none}.table-scroll{overflow:visible}table{min-width:0;font-size:10px}th,td{padding:6px}.original-answer,blockquote{break-inside:avoid}details pre{animation:none}}
</style></head><body><main class="notebook">
<header><div class="brand-row"><span class="brand">getaudit</span><button type="button" id="report-language" class="report-language" lang="${initialLocale === "en" ? "zh-CN" : "en"}" aria-label="${initialLocale === "en" ? "Switch to Simplified Chinese" : "切换为英文"}">${initialLocale === "en" ? "简体中文" : "English"}</button></div><p class="kind">${t("notebook")} · ${t("localReport")}</p><h1>${escape(report.brand)} / ${escape(report.label)}</h1><p>${t("welcome")}</p></header>
<section class="scope"><small>${t("scope")}</small><p data-report-evidence="scope">${escape(report.scope)}</p><small>${t("promptSet")} ${escape(report.promptSetId)} · ${t("frozenHash")} ${escape(report.frozenHash)}</small></section>
<h2>${t("summary")}</h2><div class="table-scroll" tabindex="0" role="region" aria-label="${escape(copy.summary)}" data-report-region="summary"><table><thead><tr>${(["platform", "planned", "checked", "completeContent", "matchingConditions", "brandMentions", "ownedCitations", "unexecuted"] as ReportCopyKey[]).map(key => `<th scope="col">${t(key)}</th>`).join("")}</tr></thead><tbody>${report.groups.map(g => `<tr><td>${escape(g.label)}</td><td>${g.planned}</td><td>${g.autoChecked}</td><td>${g.contentQualified}</td><td>${g.eligible}</td><td><span class="metric-label">${t("contentScreen")}</span><span class="metric-value">${g.candidateBrandMentions} / ${g.candidateDenominator}</span><span class="metric-label">${t("conditionMatch")}</span><span class="metric-value">${g.brandMentions} / ${g.eligible}</span></td><td><span class="metric-label">${t("contentScreen")}</span><span class="metric-value">${g.candidateOwnedCitations} / ${g.candidateDenominator}</span><span class="metric-label">${t("conditionMatch")}</span><span class="metric-value">${g.ownedCitations} / ${g.eligible}</span></td><td>${g.pending}</td></tr>`).join("")}</tbody></table></div><p class="limits">${t("retainedStates")}</p>
<h2>${t("records")}</h2>${report.records.map(r => `<article><h2 data-report-evidence="prompt">${escape(r.prompt)}</h2><p class="record-meta">${escape(r.surface)} · ${escape(r.window)} · ${t("status")}: ${escape(r.status)} · ${t("decision")}: ${escape(r.decision)} · ${r.attemptCount} ${t(r.attemptCount === 1 ? "attempt" : "attempts")}</p>${r.exclusionReasons.length ? `<div class="notes"><small>${t("originalNotes")}</small><p data-report-evidence="notes">${escape(r.exclusionReasons.join("；"))}</p></div>` : ""}${r.answer !== null ? `<h3>${t("originalAnswer")}</h3><pre class="original-answer" data-report-evidence="answer">${escape(r.answer)}</pre>` : ""}${r.citations.length ? `<h3>${t("displayedSources")}</h3><ul>${r.citations.map(c => `<li><a href="${escape(c.url)}" rel="noreferrer noopener" data-report-evidence="source">${escape(c.title ?? c.url)}</a></li>`).join("")}</ul>` : ""}<details><summary>${t("completeAttempts")}</summary><pre data-report-evidence="conditions">${escape(JSON.stringify({ conditions: r.conditions, attempts: r.attempts, quality: r.quality, manualDecision: r.manualDecision, reviewNote: r.reviewNote }, null, 2))}</pre></details><small>${t("slot")} ${escape(r.slotId)} · ${t("evidence")} ${escape(r.evidenceHash)} · ${t("observation")} ${escape(r.observationId)}</small></article>`).join("")}
${report.analyses.map(a => `<article><h2>${t("reviewedAi")} · ${escape(a.model)}</h2><p data-report-evidence="analysis">${escape(a.result.summary)}</p>${a.result.findings.map(f => `<h3>${escape(f.kind)} · ${escape(f.claim)}</h3><p>${t("actionToValidate")}: ${escape(f.nextAction)}</p>${f.sources.map(q => `<blockquote data-report-evidence="quote">${escape(q.quote)}<br><small>${t("samplePosition")} ${escape(q.slotId)}</small></blockquote>`).join("")}`).join("")}<small>${t("aiInput")} ${escape(a.inputHash)} · ${t("acceptedAi")}</small></article>`).join("")}
<footer><span class="report-maker">getaudit</span><p>${t("footer")}</p><small>${t("dataHash")}: ${hash}</small></footer></main><script>${script}</script></body></html>`;
  return { html, json: { report, dataHash: hash }, htmlHash: sha256(html) };
}

const markdownEscape = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ").replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&");
function answerBlock(text: string) {
  const fence = "`".repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length)) + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/** Same redacted evidence and quality rules as HTML; no extra collection. */
export function exportReportMarkdown(service: LabService, planId: string, locale: ReportLocale = "en") {
  const rendered = exportReport(service, planId, locale), report = rendered.json.report;
  const c = reportCopy(locale), separator = reportLocale(locale) === "zh-CN" ? "：" : ": ";
  const e = markdownEscape;
  const platformLabels = new Map(report.groups.map(group => [group.surface, group.label]));
  const statusLabels: Record<string, string> = { observed: c.observed, not_triggered: c.notTriggered, unavailable: c.unavailable, error: c.error, cancelled: c.cancelled, pending: c.pending };
  const accountLabels: Record<string, string> = { logged_out: c.loggedOut, logged_in: c.loggedIn, unknown: c.unknown };
  const modeLabels: Record<string, string> = { browser_capture: c.browserCapture, manual_capture: c.manualCapture, fixture: c.fixture };
  const lines = [
    `# getaudit / ${e(report.brand)} · ${e(report.label)} · ${c.automaticResults}`,
    `${c.scope}:\n\n${report.scope}`,
    `${c.plan}${separator}${e(report.planId)} · ${c.frozenHash}${separator}${e(report.frozenHash)}`,
    `${c.qualityVersion}${separator}${e(report.qualityPolicy.evaluatorVersion)} · ${c.qualityLimits}`,
    `${c.dataHash}${separator}${rendered.json.dataHash}`,
    `## ${c.summary}`,
    c.denominator,
    `| ${c.platform} | ${c.planned} | ${c.checked} | ${c.completeContent} | ${c.matchingConditions} | ${c.contentMentions} | ${c.contentCitations} | ${c.matchingMentions} | ${c.matchingCitations} | ${c.unexecuted} |`,
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.groups.map(g => `| ${e(g.label)} | ${g.planned} | ${g.autoChecked} | ${g.contentQualified} | ${g.eligible} | ${g.candidateBrandMentions} / ${g.candidateDenominator} | ${g.candidateOwnedCitations} / ${g.candidateDenominator} | ${g.brandMentions} / ${g.eligible} | ${g.ownedCitations} / ${g.eligible} | ${g.pending} |`),
    c.sourceLimits,
    `## ${c.eachPosition}`,
  ];
  for (const [index, record] of report.records.entries()) {
    lines.push(`### ${index + 1}. ${e(platformLabels.get(record.surface) ?? record.surface)} · ${e(record.window)}`, `${c.question}${separator}${e(record.prompt)}`,
      `${c.status}${separator}${e(statusLabels[record.status] ?? record.status)} · ${c.recordedQuality}${separator}${e(record.quality?.label ?? c.pending)}`,
      `${c.contentQualified}${separator}${record.quality?.contentQualified ? c.yes : c.no} · ${c.metric}${separator}${record.quality?.metricEligible ? c.included : c.excluded}${record.manualDecision ? " · " + c.historicalDecision + separator + (record.manualDecision === "accept" ? c.accepted : c.rejected) : ""}`);
    if (record.exclusionReasons.length) lines.push(`${c.originalNotes}${separator}${record.exclusionReasons.map(e).join("；")}`);
    if (record.quality) lines.push(`${c.qualityVersion}${separator}${e(record.quality.evaluatorVersion)} · ${c.assessmentHash}${separator}${record.quality.assessmentHash}`);
    lines.push(`${c.slot}${separator}${e(record.slotId)} · ${c.evidence} SHA-256${separator}${e(record.evidenceHash ?? c.none)} · ${record.attemptCount} ${record.attemptCount === 1 ? c.attempt : c.attempts}`);
    if (record.conditions) {
      const conditions = record.conditions;
      const exitNote = conditions.geo === "ip_observed" ? c.verifiedExit : c.unverifiedExit;
      const wrappedExit = reportLocale(locale) === "zh-CN" ? `（${exitNote}）` : ` (${exitNote})`;
      lines.push(`${c.sampledAt}${separator}${e(conditions.observedAt)} · ${c.region}${separator}${e(conditions.exitCountry ?? c.unknown)}${wrappedExit} · ${c.account}${separator}${e(accountLabels[conditions.account] ?? conditions.account)} · ${c.capture}${separator}${e(modeLabels[conditions.collectionMode] ?? conditions.collectionMode)}`,
        `${c.language}${separator}${e(conditions.locale)} · ${c.timezone}${separator}${e(conditions.timezone)} · ${c.model}${separator}${e(conditions.model)}${conditions.sourceUrl ? " · " + c.entry + separator + e(conditions.sourceUrl) : ""}`);
    }
    if (record.answer !== null) {
      lines.push(`#### ${c.originalAnswer}`, answerBlock(record.answer), `#### ${c.displayedSources}`);
      if (!record.citations.length) lines.push(c.noSources);
      for (const [n, citation] of record.citations.entries()) {
        const target = citation.url.replace(/[<>\s]/g, char => encodeURIComponent(char));
        const placement = citation.placement === "answer_link" ? c.answerLink : citation.placement === "source_panel" ? c.sourcePanel : c.unrecordedPlacement;
        lines.push(`${n + 1}. [${e(citation.title ?? citation.url)}](<${target}>) · ${placement}`);
      }
    }
  }
  for (const analysis of report.analyses) {
    lines.push(`## ${c.optionalAi} · ${e(analysis.model)}`, e(analysis.result.summary));
    for (const finding of analysis.result.findings) {
      lines.push(`### ${e(finding.kind)} · ${e(finding.claim)}`, `${c.actionToValidate}${separator}${e(finding.nextAction)}`);
      for (const source of finding.sources) lines.push(`${c.sourceQuote}${separator}${answerBlock(source.quote)}\n\n${c.samplePosition}${separator}${e(source.slotId)}`);
    }
    lines.push(`${c.inputHash}${separator}${analysis.inputHash}`);
  }
  const markdown = lines.join("\n\n") + "\n";
  return { filename: `geo-result-${planId.slice(0, 8)}.md`, markdown, text: markdown, sha256: sha256(markdown), dataHash: rendered.json.dataHash };
}
