import React, {Fragment, useEffect, useId, useMemo, useRef, useState} from 'react';
import {ChevronDown, ChevronLeft, ChevronRight, Download, ExternalLink, RefreshCw, Search} from 'lucide-react';
import type {GscEvidence} from '../../src/console/gsc.ts';
import type {GscItem} from '../../src/console/gsc-workspace.ts';
import {analyzeKeywordHealth, type HealthWindowMetrics, type KeywordHealthReport, type KeywordHealthRow, type KeywordHealthState, type PublicationRecord} from '../../src/console/keyword-health.ts';
import {csv} from '../../src/console/gsc-analysis.ts';
import {downloadText} from './download.ts';
import {t, uiMessage, useUiLanguage, type SimpleMessageKey} from './i18n.tsx';
import './keyword-health.css';

export type KeywordHealthPanelProps = {
  evidence: GscEvidence | null;
  items: GscItem[];
  connected: boolean;
  stale?: boolean;
  busy?: boolean;
  onReadHistory: () => Promise<void>;
  onSavePublication: (record: PublicationRecord) => Promise<void>;
  onOpenQuery?: (query: string) => void;
  onAudit?: () => void;
};
const states: KeywordHealthState[] = ['opportunity', 'stagnant', 'declining', 'improving', 'early', 'stable', 'insufficient_data'];
type Filter = 'all' | KeywordHealthState;
const pageSize = 20;
const stateMessages = {
  all: 'health.status.all',
  opportunity: 'health.status.opportunity',
  stagnant: 'health.status.stagnant',
  declining: 'health.status.declining',
  improving: 'health.status.improving',
  early: 'health.status.early',
  stable: 'health.status.stable',
  insufficient_data: 'health.status.insufficient_data'
} as const;
const reasonMessages = {
  opportunity_band: 'health.reason.opportunity_band',
  ranking_decline: 'health.reason.ranking_decline',
  meaningful_growth: 'health.reason.meaningful_growth',
  stagnant_published: 'health.reason.stagnant_published',
  stagnant_observed: 'health.reason.stagnant_observed',
  still_early: 'health.reason.still_early',
  no_classified_change: 'health.reason.no_classified_change',
  insufficient_current: 'health.reason.insufficient_current',
  insufficient_history: 'health.reason.insufficient_history',
  insufficient_windows: 'health.reason.insufficient_windows',
  invalid_period: 'health.reason.invalid_period',
  truncated_history: 'health.reason.truncated_history'
} as const;
const reasonShortMessages = {
  opportunity_band: 'health.reasonShort.opportunity_band',
  ranking_decline: 'health.reasonShort.ranking_decline',
  meaningful_growth: 'health.reasonShort.meaningful_growth',
  stagnant_published: 'health.reasonShort.stagnant_published',
  stagnant_observed: 'health.reasonShort.stagnant_observed',
  still_early: 'health.reasonShort.still_early',
  no_classified_change: 'health.reasonShort.no_classified_change',
  insufficient_current: 'health.reasonShort.insufficient_current',
  insufficient_history: 'health.reasonShort.insufficient_history',
  insufficient_windows: 'health.reasonShort.insufficient_windows',
  invalid_period: 'health.reasonShort.invalid_period',
  truncated_history: 'health.reasonShort.truncated_history'
} as const;
const suggestionMessages = {
  compare_top_pages: 'health.suggestion.compare_top_pages',
  review_content: 'health.suggestion.review_content',
  inspect_decline: 'health.suggestion.inspect_decline',
  keep_monitoring: 'health.suggestion.keep_monitoring',
  read_history: 'health.suggestion.read_history',
  add_publication_date: 'health.suggestion.add_publication_date',
  review_url_overlap: 'health.suggestion.review_url_overlap'
} as const;
const flagMessages = {
  opportunity: 'health.flag.opportunity',
  aggregate_fallback: 'health.flag.aggregate_fallback',
  low_data: 'health.flag.low_data',
  short_history: 'health.flag.short_history',
  truncated_query_daily: 'health.flag.truncated_query_daily',
  truncated_queries: 'health.flag.truncated_queries',
  truncated_owner_mapping: 'health.flag.truncated_owner_mapping',
  missing_owner: 'health.flag.missing_owner',
  multiple_owners: 'health.flag.multiple_owners',
  invalid_daily_rows: 'health.flag.invalid_daily_rows',
  invalid_period: 'health.flag.invalid_period',
  publication_unknown: 'health.flag.publication_unknown',
  publication_not_applicable: 'health.flag.publication_not_applicable',
  query_level_trajectory: 'health.flag.query_level_trajectory',
  owner_mapping_full_period: 'health.flag.owner_mapping_full_period',
  non_web_search: 'health.flag.non_web_search'
} as const;
const windowMessages = {current: 'health.current', previous: 'health.previous', baseline: 'health.baseline'} as const;
const knownLimits: Record<string, SimpleMessageKey> = {
  "Classification uses transparent triage thresholds, not statistical significance or a guarantee that editing will improve rankings.": "health.limitation.triage",
  "Positions are impression-weighted GSC query averages, not current organic SERP ranks. Missing query rows and dates remain unknown.": "health.limitation.positions",
  "All trajectories are query-level within this one frozen snapshot. The associated URL comes from query \u00d7 page rows for the full selected period; its publication date does not prove that page owned the query throughout the trajectory.": "health.limitation.scope",
  "Observed age is a lower bound from the earliest returned query date within this snapshot. Publication dates are optional user-supplied evidence, not independently verified publication or indexation dates.": "health.limitation.age",
  "The baseline is the first 28 days when at least 90 days are selected. The previous and current windows are the final two non-overlapping 28-day periods; gaps are not counted twice.": "health.limitation.windows",
  "GSC can omit anonymous and less frequent queries even below the row limit. Multiple associated URLs are a review signal, not confirmed keyword cannibalization.": "health.limitation.omissions"
};
const limitation = (text: string) => Object.hasOwn(knownLimits, text) ? t(knownLimits[text]) : text;
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
function publicUrl(value: string): boolean {
  try {const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;}
  catch {return false;}
}
/** Publication declarations stay scoped to the snapshot property; notes and first-seen dates are never promoted into publication evidence. */
export function publicationRecords(items: GscItem[], property: string): PublicationRecord[] {
  return items.filter(item => item.property === property && String(item.kind) === 'publication').flatMap(item => {
    const value = item.payload;
    if (typeof value.url !== 'string' || !publicUrl(value.url) || typeof value.publishedAt !== 'string' || !validDate(value.publishedAt) || value.source !== 'manual') return [];
    if (value.sourceUrl !== undefined && (typeof value.sourceUrl !== 'string' || !publicUrl(value.sourceUrl))) return [];
    return [{url: value.url, publishedAt: value.publishedAt, source: 'manual' as const, ...(typeof value.sourceUrl === 'string' ? {sourceUrl: value.sourceUrl} : {})}];
  });
}
const number = (value: number | null, digits = 0) => value === null ? t('health.missingMetric') : value.toLocaleString(undefined, {minimumFractionDigits: digits, maximumFractionDigits: digits});
const rank = (value: number | null) => number(value, 1);
const period = (window: {startDate: string; endDate: string}) => t('health.window', {start: window.startDate, end: window.endDate});
const reason = (row: KeywordHealthRow) => row.reasonCodes.map(code => t(reasonMessages[code])).join(' ');
const shortReason = (row: KeywordHealthRow) => row.reasonCodes.map(code => t(reasonShortMessages[code])).join(' ');
const suggestions = (row: KeywordHealthRow) => row.suggestionCodes.map(code => t(suggestionMessages[code]));
function PageLink({url}: {url: string}) {
  return publicUrl(url) ? <a href={url} target="_blank" rel="noreferrer">{url}<ExternalLink size={12} aria-hidden="true"/></a> : <span>{url}</span>;
}

/** Exports use the selected UI language for labels and preserve original queries, URLs, dates and source identifiers. */
export function keywordHealthMarkdown(report: KeywordHealthReport, rows: KeywordHealthRow[] = report.rows): string {
  const e = report.evidence;
  const lines = [
    `# ${t('health.exportTitle')}`, '', t('health.exportScope'), '',
    `${t('health.property')}: ${e.property}`,
    `${t('common.source')}: ${e.source}`,
    `${t('health.window', {start: e.startDate, end: e.endDate})} (${e.timeZone})`,
    `${t('health.market')}: ${e.country}; ${t('health.device')}: ${e.device}; ${t('health.searchType')}: ${e.type}`,
    `${t('health.queryFilter')}: ${e.queryFilter || t('health.none')}; ${t('health.pageFilter')}: ${e.pageFilter || t('health.none')}`,
    `${t('health.captured')}: ${e.capturedAt}`, `${t('health.snapshot')}: ${e.snapshotId}`, `SHA-256: ${e.hash}`, '',
    t('health.queryScope'), '', t('health.noKeywordUniverse'), '',
    `## ${t('health.rulesHeading')}`, '', t('health.rulesBody'), '',
  ];
  for (const row of rows) {
    lines.push(`## ${row.keyword.replace(/[\r\n]/g, ' ')}`, '', `${t('health.diagnosisColumn')}: ${t(stateMessages[row.state])}`, '', reason(row), '', `${t('health.queryColumn')}: ${row.ownerUrl ?? t('health.ownerUnknown')}`, '');
    for (const name of ['baseline', 'previous', 'current'] as const) {
      const window = row[name];
      lines.push(`${t(windowMessages[name])}: ${period(window)}; ${t('health.position')}: ${rank(window.position)}; ${t('health.clicks')}: ${number(window.clicks)}; ${t('health.impressions')}: ${number(window.impressions)}; ${t('health.ctr')}: ${window.ctr === null ? t('health.missingMetric') : number(window.ctr * 100, 2) + '%'}; ${t('health.returnedDays')}: ${window.returnedDays}`, '');
    }
    if (row.publication) lines.push(`${t('health.publicationDate')}: ${row.publication.publishedAt} (${t('health.publicationHelp')})`, ...(row.publication.sourceUrl ? [row.publication.sourceUrl] : []), '');
    else if (row.age.firstObservedAt) lines.push(t('health.firstObserved', {date: row.age.firstObservedAt}), '');
    lines.push(...suggestions(row).map(text => `- ${text}`), '', t('health.measurement'), '');
    if (row.ownerAlternatives.length) lines.push(...row.ownerAlternatives.map(url => `- ${url}`), '');
    lines.push(...row.flags.map(code => `- ${t(flagMessages[code])}`), '');
  }
  if (report.limitations.length) lines.push(`## ${t('health.limitationsHeading')}`, '', ...report.limitations.map(text => `- ${limitation(text)}`), '');
  return lines.join('\n');
}
export function keywordHealthCsv(report: KeywordHealthReport, rows: KeywordHealthRow[] = report.rows): string {
  const e = report.evidence;
  return csv([
    t('health.searchLabel'), t('health.diagnosisColumn'), t('health.queryColumn'),
    ...(['current', 'previous', 'baseline'] as const).flatMap(name => [t(windowMessages[name]) + ' · ' + t('health.period'), t(windowMessages[name]) + ' · ' + t('health.position'), t(windowMessages[name]) + ' · ' + t('health.clicks'), t(windowMessages[name]) + ' · ' + t('health.impressions'), t(windowMessages[name]) + ' · ' + t('health.ctr'), t(windowMessages[name]) + ' · ' + t('health.returnedDays')]),
    t('health.publicationDate'), t('health.publicationBasis'), t('health.firstObservedLabel'), t('health.reason'), t('health.actionColumn'), t('health.flags'),
    t('common.source'), t('health.property'), t('health.market'), t('health.device'), t('health.searchType'), t('health.queryFilter'), t('health.pageFilter'), t('health.captured'), t('health.snapshot'), 'SHA-256',
  ], rows.map(row => [row.keyword, t(stateMessages[row.state]), row.ownerUrl,
    ...(['current', 'previous', 'baseline'] as const).flatMap(name => [period(row[name]), row[name].position, row[name].clicks, row[name].impressions, row[name].ctr, row[name].returnedDays]),
    row.publication?.publishedAt, row.publication ? t('health.manualDate') : null, row.age.firstObservedAt, reason(row), suggestions(row).join(' '), row.flags.map(code => t(flagMessages[code])).join(' '), e.source, e.property, e.country, e.device, e.type, e.queryFilter, e.pageFilter, e.capturedAt, e.snapshotId, e.hash,
  ]));
}

function WindowEvidence({name, value}: {name: 'current' | 'previous' | 'baseline'; value: HealthWindowMetrics}) {
  return <div className="health-window">
    <h4>{t(windowMessages[name])}</h4><p>{period(value)}</p>
    <dl><div><dt>{t('health.position')}</dt><dd>{rank(value.position)}</dd></div><div><dt>{t('health.clicks')}</dt><dd>{number(value.clicks)}</dd></div><div><dt>{t('health.impressions')}</dt><dd>{number(value.impressions)}</dd></div><div><dt>{t('health.ctr')}</dt><dd>{value.ctr === null ? t('health.missingMetric') : number(value.ctr * 100, 2) + '%'}</dd></div><div><dt>{t('health.returnedDays')}</dt><dd>{value.returnedDays}</dd></div></dl>
    <small className={value.supported ? 'health-supported' : 'health-limited'}>{t(value.supported ? 'health.windowSupported' : 'health.windowUnsupported')}</small>
  </div>;
}
function PublicationForm({row, report, disabled, scopeRef, onSave}: {row: KeywordHealthRow; report: KeywordHealthReport; disabled: boolean; scopeRef: React.MutableRefObject<string>; onSave: KeywordHealthPanelProps['onSavePublication']}) {
  const scope = `${report.evidence.property}:${report.evidence.hash}`;
  const [date, setDate] = useState(row.publication?.publishedAt ?? ''), [source, setSource] = useState(row.publication?.sourceUrl ?? ''), [saving, setSaving] = useState(false), [feedback, setFeedback] = useState<{error: boolean; message: string} | null>(null);
  const submitting = useRef(false), mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  if (!row.ownerUrl || !publicUrl(row.ownerUrl)) return null;
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submitting.current || !row.ownerUrl) return;
    if (scopeRef.current !== scope) {setFeedback({error: true, message: t('health.scopeChanged')}); return;}
    if (!validDate(date) || date > report.evidence.endDate) {setFeedback({error: true, message: t('health.invalidPublication', {date: report.evidence.endDate})}); return;}
    if (source.trim() && !publicUrl(source.trim())) {setFeedback({error: true, message: t('health.invalidSource')}); return;}
    submitting.current = true; setSaving(true); setFeedback(null);
    try {
      await onSave({url: row.ownerUrl, publishedAt: date, source: 'manual', ...(source.trim() ? {sourceUrl: source.trim()} : {})});
      if (mounted.current && scopeRef.current === scope) setFeedback({error: false, message: t('health.publicationSaved')});
    } catch (error) {
      if (mounted.current && scopeRef.current === scope) setFeedback({error: true, message: error instanceof Error ? error.message : t('health.saveFailed')});
    } finally {submitting.current = false; if (mounted.current) setSaving(false);}
  }
  return <details className="health-publication"><summary>{t('health.publicationHeading')}</summary><p>{t('health.publicationHelp')}</p>
    <form onSubmit={save} aria-label={t('health.publicationHeading')}>
      <label>{t('health.publicationDate')}<input type="date" value={date} max={report.evidence.endDate} required disabled={disabled || saving} onChange={event => setDate(event.target.value)}/></label>
      <label className="health-source-input">{t('health.publicationSource')}<input type="url" value={source} disabled={disabled || saving} placeholder="https://" onChange={event => setSource(event.target.value)}/><small>{t('health.publicationSourceHelp')}</small></label>
      <button type="submit" disabled={disabled || saving}>{t(saving ? 'health.savingPublication' : 'health.savePublication')}</button>
    </form>
    {feedback && <p className={feedback.error ? 'health-feedback health-error' : 'health-feedback'} role={feedback.error ? 'alert' : 'status'}>{uiMessage(feedback.message)}</p>}
  </details>;
}

export function KeywordHealthPanel({evidence, items, connected, stale = false, busy = false, onReadHistory, onSavePublication, onOpenQuery, onAudit}: KeywordHealthPanelProps) {
  useUiLanguage();
  const report = useMemo(() => evidence ? analyzeKeywordHealth(evidence, publicationRecords(items, evidence.snapshot.property)) : null, [evidence, items]);
  const [filter, setFilter] = useState<Filter>('all'), [search, setSearch] = useState(''), [expanded, setExpanded] = useState<string | null>(null), [page, setPage] = useState(0), [reading, setReading] = useState(false), [error, setError] = useState('');
  const prefix = useId(), readingRef = useRef(false), scopeRef = useRef(''), mounted = useRef(true);
  const scope = report ? `${report.evidence.property}:${report.evidence.hash}` : '';
  scopeRef.current = scope;
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => {setExpanded(null); setPage(0); setError('');}, [scope]);
  const rows = useMemo(() => report?.rows.filter(row => (filter === 'all' || row.state === filter || (filter === 'opportunity' && row.flags.includes('opportunity'))) && row.keyword.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [], [report, filter, search]);
  const opportunityCount = report?.rows.filter(row => row.flags.includes('opportunity')).length ?? 0;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize)), currentPage = Math.min(page, pages - 1), visible = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const currentMeasurement = report && evidence?.snapshot.queryDaily ? report.windows.current : report?.evidence;
  const writable = connected && !stale && !busy && !reading;
  async function readHistory() {
    if (!evidence || stale || !connected || busy || readingRef.current) return;
    const originalScope = scopeRef.current;
    readingRef.current = true; setReading(true); setError('');
    try {await onReadHistory();}
    catch (problem) {if (mounted.current && scopeRef.current === originalScope) setError(problem instanceof Error ? problem.message : t('health.readFailed'));}
    finally {readingRef.current = false; if (mounted.current) setReading(false);}
  }
  const showRead = !report || report.rows.some(row => row.flags.some(flag => ['short_history', 'aggregate_fallback', 'truncated_query_daily', 'low_data'].includes(flag)) || row.reasonCodes.includes('insufficient_history'));
  return <section className="keyword-health seo-field-notes" aria-labelledby={prefix + '-title'}>
    <header className="health-heading"><div><p className="health-eyebrow">{t("seo.design.healthEyebrow")}</p><h2 id={prefix + '-title'}>{t('health.focusHeading')}</h2><p>{t('health.intro')}</p></div>
      <div className="health-exports"><button type="button" disabled={!rows.length} onClick={() => report && downloadText(`getaudit-keyword-health-${report.evidence.endDate}.md`, keywordHealthMarkdown(report, rows), 'text/markdown;charset=utf-8')}><Download size={14} aria-hidden="true"/>{t('health.exportMarkdown')}</button><button type="button" disabled={!rows.length} onClick={() => report && downloadText(`getaudit-keyword-health-${report.evidence.endDate}.csv`, keywordHealthCsv(report, rows), 'text/csv;charset=utf-8')}><Download size={14} aria-hidden="true"/>{t('health.exportCsv')}</button></div>
    </header>
    <p className="health-local">{t('health.localAnalysis')}</p>
    {report && currentMeasurement && <p className="health-period">{t('health.scopePeriod', {start: report.evidence.startDate, end: report.evidence.endDate, currentStart: currentMeasurement.startDate, currentEnd: currentMeasurement.endDate})}</p>}
    {onAudit && <div className="health-audit-link"><button type="button" onClick={onAudit}>{t('health.audit')}</button><p>{t('health.auditHelp')}</p></div>}
    {stale && <p className="health-notice" role="status">{t('health.stale')}</p>}
    {!connected && <p className="health-notice">{t('health.connectFirst')}</p>}
    {!evidence && <p className="health-notice">{t('health.firstSnapshotNeeded')}</p>}
    {showRead && <div className="health-read"><div><strong>{t('health.readHistory')}</strong><p>{t('health.readHelp')}</p></div><button className="primary" type="button" disabled={!evidence || stale || !connected || busy || reading} onClick={() => void readHistory()}><RefreshCw size={14} aria-hidden="true"/>{t(reading ? 'health.readingHistory' : 'health.readHistory')}</button></div>}
    {error && <p className="health-feedback health-error" role="alert">{uiMessage(error)}</p>}
    {!report ? <div className="health-empty"><h3>{t('health.emptyTitle')}</h3><p>{t('health.emptyBody')}</p></div> : <>
      <p className="health-summary sr-only">{t('health.summary', {total: report.rows.length, opportunities: opportunityCount, stagnant: report.summary.stagnant, declining: report.summary.declining})}</p>
      <dl className="health-scoreboard"><div><dt>{t(stateMessages.all)}</dt><dd>{number(report.rows.length)}</dd></div><div data-tone="opportunity"><dt>{t(stateMessages.opportunity)}</dt><dd>{number(opportunityCount)}</dd></div><div data-tone="stagnant"><dt>{t(stateMessages.stagnant)}</dt><dd>{number(report.summary.stagnant)}</dd></div><div data-tone="declining"><dt>{t(stateMessages.declining)}</dt><dd>{number(report.summary.declining)}</dd></div></dl>
      <div className="health-filters"><div role="group" aria-label={t('health.filterLabel')}>{(['all', ...states] as Filter[]).map(state => <button type="button" key={state} aria-pressed={filter === state} onClick={() => {setFilter(state); setPage(0);}}>{t(stateMessages[state])}<span>{state === 'all' ? report.rows.length : state === 'opportunity' ? opportunityCount : report.summary[state]}</span></button>)}</div><label className="health-search"><Search size={15} aria-hidden="true"/><span className="sr-only">{t('health.searchLabel')}</span><input type="search" value={search} placeholder={t('health.searchLabel')} onChange={event => {setSearch(event.target.value); setPage(0);}}/></label></div>
      <div className="health-table-wrap"><table className="health-table"><thead><tr><th>{t('health.queryColumn')}</th><th>{t('health.rankColumn')}</th><th>{t('health.growthColumn')}</th><th>{t('health.diagnosisColumn')}</th><th>{t('health.actionColumn')}</th></tr></thead><tbody>
        {visible.map((row, index) => {
          const open = expanded === row.keyword, detailId = prefix + '-row-' + index, gain = row.current.supported && row.previous.supported ? row.changes.vsPrevious.positionGain : null;
          const cautions = row.flags.filter(flag => ['low_data', 'aggregate_fallback', 'truncated_query_daily', 'invalid_daily_rows', 'truncated_owner_mapping'].includes(flag));
          return <Fragment key={row.keyword}><tr className="health-query-row" data-state={row.state}>
            <td data-label={t('health.queryColumn')}><strong className="health-keyword">{row.keyword}</strong><div className="health-owner">{row.ownerUrl ? <PageLink url={row.ownerUrl}/> : <span>{t('health.ownerUnknown')}</span>}</div>{row.ownerAlternatives.length > 0 && <small>{t('health.ownerAmbiguous', {count: row.ownerAlternatives.length})}</small>}</td>
            <td data-label={t('health.rankColumn')}><strong className="health-current-rank">{rank(row.current.position)}</strong><small>{t('health.current')} · {period(row.current)}</small><p className="health-rank-history">{t('health.previous')}: {rank(row.previous.position)}<br/>{t('health.baseline')}: {rank(row.baseline.position)}</p></td>
            <td data-label={t('health.growthColumn')}><strong className="health-traffic">{t('health.clickImpressions', {clicks: number(row.current.clicks), impressions: number(row.current.impressions)})}</strong><small>{t('health.previous')}: {t('health.clickImpressions', {clicks: number(row.previous.clicks), impressions: number(row.previous.impressions)})}</small><p className={gain !== null && gain > 0 ? 'health-gain' : gain !== null && gain < 0 ? 'health-loss' : 'health-muted'}>{gain === null ? t('health.notComparable') : gain > 0 ? t('health.rankGain', {count: number(gain, 1)}) : gain < 0 ? t('health.rankLoss', {count: number(-gain, 1)}) : t('health.rankUnchanged')}</p></td>
            <td data-label={t('health.diagnosisColumn')}><span className={'health-state health-state-' + row.state}>{t(stateMessages[row.state])}</span><p className="health-reason">{shortReason(row)}</p>{cautions.length > 0 && <ul className="health-inline-cautions">{cautions.map(flag => <li key={flag}>{t(flagMessages[flag])}</li>)}</ul>}</td>
            <td data-label={t('health.actionColumn')}><button className="health-detail-toggle" type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setExpanded(open ? null : row.keyword)}>{t(open ? 'health.hideDetails' : 'health.viewDetails')}<ChevronDown size={14} aria-hidden="true"/></button>{onOpenQuery && <button className="health-query-open" type="button" onClick={() => onOpenQuery(row.keyword)}>{t('health.viewQuery')}</button>}</td>
          </tr>{open && <tr className="health-detail-row"><td colSpan={5}><div className="health-detail" id={detailId}>
            <h3>{row.keyword}</h3><p className="health-full-reason">{reason(row)}</p><h4>{t('health.evidenceHeading')}</h4><div className="health-windows">{(['baseline', 'previous', 'current'] as const).map(name => <WindowEvidence key={name} name={name} value={row[name]}/>)}</div>
            <div className="health-detail-bottom"><div><h4>{t('health.ageHeading')}</h4><p>{row.age.basis === 'published' && row.age.publishedAt && row.age.days !== null ? t('health.publishedAge', {date: row.age.publishedAt, days: row.age.days}) : row.age.basis === 'observed' && row.age.firstObservedAt && row.age.days !== null ? t('health.observedAge', {date: row.age.firstObservedAt, days: row.age.days}) : t('health.ageUnknown')}</p>{row.age.basis === 'published' && row.age.firstObservedAt && <p>{t('health.firstObserved', {date: row.age.firstObservedAt})}</p>}
            {row.ownerAlternatives.length > 0 && <ul className="health-url-list">{row.ownerAlternatives.map(url => <li key={url}><PageLink url={url}/></li>)}</ul>}
            <PublicationForm key={scope + ':' + row.ownerUrl} row={row} report={report} disabled={!writable} scopeRef={scopeRef} onSave={onSavePublication}/></div>
            <div><h4>{t('health.actionsHeading')}</h4><ul>{suggestions(row).map((text, i) => <li key={row.suggestionCodes[i]}>{text}</li>)}</ul><p className="health-measurement">{t('health.measurement')}</p></div></div>
            <ul className="health-flags">{row.flags.filter(flag => !['query_level_trajectory', 'owner_mapping_full_period'].includes(flag)).map(flag => <li key={flag}>{t(flagMessages[flag])}</li>)}</ul>
          </div></td></tr>}</Fragment>;
        })}
      </tbody></table>{!rows.length && <p className="health-empty-inline">{t(report.rows.length ? 'health.noMatching' : 'health.noQueries')}</p>}</div>
      <div className="health-pagination"><span>{t('health.pageCount', {page: currentPage + 1, pages, count: rows.length})}</span><div><button type="button" aria-label={t('health.previousPage')} disabled={currentPage === 0} onClick={() => {setPage(currentPage - 1); setExpanded(null);}}><ChevronLeft size={15} aria-hidden="true"/></button><button type="button" aria-label={t('health.nextPage')} disabled={currentPage >= pages - 1} onClick={() => {setPage(currentPage + 1); setExpanded(null);}}><ChevronRight size={15} aria-hidden="true"/></button></div></div>
      <p className="health-scope">{t('health.queryScope')}</p><p className="health-scope">{t('health.noKeywordUniverse')}</p>
      <details className="health-method"><summary>{t('health.rulesHeading')}</summary><p>{t('health.rulesBody')}</p></details>
      <details className="health-provenance"><summary>{t('health.sourceHeading')}</summary><dl><div><dt>{t('common.source')}</dt><dd>{report.evidence.source}</dd></div><div><dt>{t('health.property')}</dt><dd>{report.evidence.property}</dd></div><div><dt>{t('health.current')}</dt><dd>{period(report.evidence)} ({report.evidence.timeZone})</dd></div><div><dt>{t('health.market')}</dt><dd>{report.evidence.country}</dd></div><div><dt>{t('health.device')}</dt><dd>{report.evidence.device}</dd></div><div><dt>{t('health.searchType')}</dt><dd>{report.evidence.type}</dd></div><div><dt>{t('health.queryFilter')}</dt><dd>{report.evidence.queryFilter || t('health.none')}</dd></div><div><dt>{t('health.pageFilter')}</dt><dd>{report.evidence.pageFilter || t('health.none')}</dd></div><div><dt>{t('health.captured')}</dt><dd>{report.evidence.capturedAt}</dd></div><div><dt>{t('health.snapshot')}</dt><dd>{report.evidence.snapshotId}</dd></div><div><dt>SHA-256</dt><dd className="health-hash">{report.evidence.hash}</dd></div></dl></details>
      {report.limitations.length > 0 && <details className="health-limitations"><summary>{t('health.limitationsHeading')}</summary><ul>{report.limitations.map((text, index) => <li key={index}>{limitation(text)}</li>)}</ul></details>}
    </>}
  </section>;
}
