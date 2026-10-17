import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BarChart3, RefreshCw, Settings2 } from 'lucide-react';
import { request } from './api.ts';
import { t, uiMessage, useUiLanguage } from './i18n.tsx';
import { googleSelectionRefreshEvent, type GoogleSelection } from './google-connection-panel.tsx';
import { DotHelper } from './dot-helper.tsx';
import { accountStatusRefreshEvent, type AccountStatus } from './account-chip.tsx';
import './ga4-panel.css';

type Ga4Metrics = { activeUsers: number; sessions: number; screenPageViews: number; keyEvents: number };
export type Ga4Report = {
  id: string; propertyId: string; displayName?: string; startDate: string; endDate: string; capturedAt: string; timeZone: string;
  summary: Ga4Metrics | null; daily: ({ date: string } & Ga4Metrics)[];
  traffic: ({ source: string; medium: string } & Pick<Ga4Metrics, 'activeUsers' | 'sessions' | 'keyEvents'>)[];
  limitations: string[]; hash?: string;
};

function DailySessions({ rows }: { rows: Ga4Report['daily'] }) {
  const format = new Intl.NumberFormat(useUiLanguage());
  const width = 900, height = 210, left = 48, right = 16, top = 18, bottom = 34;
  const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const maximum = Math.max(1, ...ordered.map(row => row.sessions));
  const first = Date.parse(ordered[0]!.date), last = Date.parse(ordered.at(-1)!.date), extent = Math.max(86400000, last - first);
  const x = (date: string) => left + (ordered.length === 1 ? (width - left - right) / 2 : (Date.parse(date) - first) / extent * (width - left - right));
  const y = (value: number) => height - bottom - value / maximum * (height - bottom - top);
  let prior = -Infinity;
  const path = ordered.map(row => { const day = Date.parse(row.date), segment = day - prior === 86400000 ? 'L' : 'M'; prior = day; return segment + x(row.date).toFixed(1) + ',' + y(row.sessions).toFixed(1); }).join(' ');
  return <svg viewBox={`0 0 ${width} ${height}`} className="ga4-daily" role="img" aria-label={t('ga4.chartLabel')}>
    {[0, 1, 2, 3].map(index => { const value = maximum * index / 3; return <g key={index}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="var(--line)" strokeDasharray="3 5"/><text x={left - 9} y={y(value) + 4} textAnchor="end">{format.format(Math.round(value))}</text></g>; })}
    <path d={path} fill="none" stroke="var(--chart-orange)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/>
    {ordered.map((row, index) => <g key={row.date}><circle cx={x(row.date)} cy={y(row.sessions)} r="3" fill="var(--chart-orange)"><title>{row.date + ' · ' + t('ga4.sessions') + ': ' + format.format(row.sessions)}</title></circle>{(index === 0 || index === ordered.length - 1 || index % Math.max(1, Math.ceil(ordered.length / 5)) === 0) && <text x={x(row.date)} y={height - 10} textAnchor="middle">{row.date.slice(5)}</text>}</g>)}
  </svg>;
}

/** Check the current connection before opening local records; a new report requires an explicit click. */
export function Ga4Panel({ brandId, onConnections }: { brandId?: string; onConnections?: () => void }) {
  const language = useUiLanguage(), format = new Intl.NumberFormat(language);
  const [report, setReport] = useState<Ga4Report | null>(null), [propertyId, setPropertyId] = useState('');
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<'saved' | 'read' | ''>('');
  const alive = useRef(true), revision = useRef(0), currentBrand = useRef(brandId);
  currentBrand.current = brandId;
  const localRead = useCallback(async () => {
    const current = ++revision.current;
    setReport(null); setPropertyId(''); setError('');
    if (!brandId) { setLoading(false); return; }
    setLoading(true);
    try {
      const status = await request<AccountStatus>('account/status');
      if (!alive.current || current !== revision.current) return;
      if (status.status !== 'signed_in' || !status.profile?.subject || !status.capabilities?.ga4) { setLoading(false); return; }
    } catch { if (alive.current && current === revision.current) { setError('saved'); setLoading(false); } return; }
    const [selection, saved] = await Promise.allSettled([
      request<GoogleSelection>('google/selection?brandId=' + encodeURIComponent(brandId)),
      request<{ report: Ga4Report | null }>('ga4/report?brandId=' + encodeURIComponent(brandId)),
    ]);
    if (!alive.current || current !== revision.current) return;
    const property = selection.status === 'fulfilled' ? selection.value.ga4PropertyId ?? '' : '';
    setPropertyId(property);
    if (saved.status === 'fulfilled') {
      const next = saved.value.report;
      setReport(next && (!property || next.propertyId === property) ? next : null);
    }
    if (selection.status === 'rejected' || saved.status === 'rejected') setError('saved');
    setLoading(false);
  }, [brandId]);
  useEffect(() => {
    alive.current = true; void localRead();
    const refresh = () => { void localRead(); };
    window.addEventListener(googleSelectionRefreshEvent, refresh);
    window.addEventListener(accountStatusRefreshEvent, refresh);
    return () => { alive.current = false; revision.current++; window.removeEventListener(googleSelectionRefreshEvent, refresh); window.removeEventListener(accountStatusRefreshEvent, refresh); };
  }, [localRead]);
  async function readGoogle() {
    if (busy || !brandId || !propertyId) return;
    const current = revision.current, project = brandId;
    setBusy(true); setError('');
    try {
      const result = await request<{ report: Ga4Report | null }>('ga4/report', { brandId, propertyId });
      if (!alive.current || revision.current !== current || currentBrand.current !== project) return;
      setReport(result.report);
    } catch { if (alive.current && revision.current === current && currentBrand.current === project) setError('read'); }
    finally { if (alive.current) setBusy(false); }
  }
  const metrics = [{ key: 'activeUsers' as const, label: t('ga4.activeUsers') }, { key: 'sessions' as const, label: t('ga4.sessions') }, { key: 'screenPageViews' as const, label: t('ga4.pageViews') }, { key: 'keyEvents' as const, label: t('ga4.keyEvents') }];
  return <section className="ga4-desk" aria-busy={busy || loading}>
    <header className="ga4-desk__header"><div><span className="ga4-desk__label"><BarChart3 size={16} aria-hidden="true"/>Google Analytics</span><h2>{t('ga4.title')}</h2><p>{t('ga4.description')}</p></div></header>
    <div className="ga4-desk__toolbar"><div>{report && <><strong>{report.displayName || report.propertyId}</strong><span>{t('ga4.period', { start: report.startDate, end: report.endDate })}</span></>}</div><button type="button" className="ga4-desk__read" disabled={busy || loading || !propertyId} onClick={() => void readGoogle()}><RefreshCw size={15} aria-hidden="true"/>{busy ? t('ga4.reading') : t('ga4.read28Days')}</button></div>
    <p className="ga4-desk__note">{t('ga4.savedOnly')}</p>
    {loading && <p role="status" className="ga4-desk__note">{t('keywordAudit.loadingSavedMaterial')}</p>}
    {error && <p className="ga4-desk__error" role="alert">{error === 'read' ? t('ga4.readFailed') : t('ga4.savedFailed')}</p>}
    {!loading && !propertyId && <div className="ga4-desk__empty"><p>{t('ga4.chooseFirst')}</p>{onConnections && <button type="button" onClick={onConnections}><Settings2 size={15} aria-hidden="true"/>{t('common.settings')}</button>}</div>}
    {!loading && !report && propertyId && <div className="ga4-desk__empty"><DotHelper compact/><p>{t('ga4.noSavedData')}</p></div>}
    {report && <>
      {report.summary ? <div className="ga4-desk__metrics">{metrics.map(metric => <div key={metric.key}><span>{metric.label}</span><strong>{format.format(report.summary![metric.key])}</strong></div>)}</div> : <p className="ga4-desk__empty">{t('ga4.noTotals')}</p>}
      <section className="ga4-desk__section"><h3>{t('ga4.daily')}</h3>{report.daily.length ? <DailySessions rows={report.daily}/> : <p className="ga4-desk__note">{t('ga4.noDaily')}</p>}</section>
      <section className="ga4-desk__section"><h3>{t('ga4.traffic')}</h3>{report.traffic.length ? <div className="ga4-desk__table-scroll" tabIndex={0} role="region" aria-label={t('ga4.traffic')}><table><thead><tr><th>{t('ga4.source')}</th><th>{t('ga4.medium')}</th><th>{t('ga4.activeUsers')}</th><th>{t('ga4.sessions')}</th><th>{t('ga4.keyEvents')}</th></tr></thead><tbody>{report.traffic.map((row, index) => <tr key={row.source + '\0' + row.medium + '\0' + index}><td>{row.source}</td><td>{row.medium}</td><td>{format.format(row.activeUsers)}</td><td>{format.format(row.sessions)}</td><td>{format.format(row.keyEvents)}</td></tr>)}</tbody></table></div> : <p className="ga4-desk__note">{t('ga4.noTraffic')}</p>}</section>
      <details className="ga4-desk__evidence"><summary>{t('ga4.evidence')}</summary><div><p>Google Analytics Data API · {report.propertyId} · {report.timeZone}</p><p>{t('ga4.captured', { date: report.capturedAt })}</p>{report.hash && <p>SHA-256 <code>{report.hash}</code></p>}<ul>{report.limitations.map((limitation, index) => <li key={index}>{uiMessage(limitation)}</li>)}</ul><p>{t('ga4.notAiEvidence')}</p></div></details>
    </>}
  </section>;
}
