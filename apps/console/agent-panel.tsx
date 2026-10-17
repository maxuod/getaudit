import React, { useEffect, useRef, useState } from 'react';
import { Copy, ExternalLink, KeyRound, RefreshCw, Unplug } from 'lucide-react';
import { request } from './api.ts';
import { t, uiMessage, useUiLanguage } from './i18n.tsx';
import './agent-panel.css';

type AgentKey = { id: string; label: string; brandIds: string[]; canSaveAnalysis?: boolean; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; tokenHint: string };
type AgentAccess = { url: string; keys: AgentKey[] };
type AgentAction = { priority: string; kind: string; keyword: string | null; targetUrl: string | null; action: string; acceptance: string; measurement: string; evidence: { hash?: string; snapshotId?: string; planId?: string; reportHash?: string } };
export type AgentContext = {
  project: { id: string; name: string };
  generatedAt: string;
  seo: null | { evidence: { snapshotId: string; hash: string; property: string; country: string; device: string; startDate: string; endDate: string }; summary: Record<string, number>; opportunities: { target: number; qualifying: number; shortfall: number; rows: { keyword: string; ownerUrl: string | null; current: { position: number | null; clicks: number; impressions: number } }[] }; limitations: string[] };
  geo: unknown | null;
  evidenceSelection: { availableGeoPlans: number };
  actions: AgentAction[];
  unknowns: string[];
  limitations: string[];
};
type SavedAnalysis = { id: string; brandId: string; title: string; summary: string; actions: { priority: string; targetUrl?: string | null; action: string; reason: string; acceptance: string; measurement: string }[]; gaps: string[]; sourceRefs: { kind: string; id: string; hash: string }[]; createdAt: string; contentHash: string; provider?: string | null; model?: string | null };
const actionCopy = {
  opportunity: ['agent.actionOpportunity', 'agent.acceptOpportunity', 'agent.measureOpportunity'],
  stagnant: ['agent.actionStagnant', 'agent.acceptStagnant', 'agent.measureStagnant'],
  declining: ['agent.actionDeclining', 'agent.acceptDeclining', 'agent.measureDeclining'],
  geo_coverage: ['agent.actionGeo', 'agent.acceptGeo', 'agent.measureGeo'],
} as const;

export function AgentPanel({ brands, currentBrandId, onGsc, onConnections }: { brands: { id: string; name: string }[]; currentBrandId?: string; onGsc: () => void; onConnections: () => void }) {
  const language = useUiLanguage();
  const [brandId, setBrandId] = useState(currentBrandId ?? brands[0]?.id ?? '');
  const [access, setAccess] = useState<AgentAccess | null>(null), [context, setContext] = useState<AgentContext | null>(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [label, setLabel] = useState('');
  const [keyError, setKeyError] = useState(''), [contextError, setContextError] = useState(''), [notice, setNotice] = useState('');
  const [created, setCreated] = useState<{ id: string; key: string } | null>(null);
  const [canSaveAnalysis, setCanSaveAnalysis] = useState(false), [analyses, setAnalyses] = useState<SavedAnalysis[]>([]), [analysesError, setAnalysesError] = useState('');
  const generation = useRef(0), currentBrand = useRef(brandId); currentBrand.current = brandId;
  useEffect(() => { if (currentBrandId && brands.some(brand => brand.id === currentBrandId)) setBrandId(currentBrandId); }, [currentBrandId, brands]);
  useEffect(() => { if (!brands.some(brand => brand.id === brandId)) setBrandId(brands[0]?.id ?? ''); }, [brandId, brands]);
  async function read(id: string, seq: number) {
    setLoading(true); setKeyError(''); setContextError(''); setAnalysesError('');
    await Promise.all([
      request<AgentAccess>('agent/keys').then(result => { if (generation.current === seq && currentBrand.current === id) setAccess(result); }).catch(() => { if (generation.current === seq && currentBrand.current === id) setKeyError(t('agent.keysFailed')); }),
      request<AgentContext>('agent/context?brandId=' + encodeURIComponent(id)).then(result => { if (generation.current === seq && currentBrand.current === id && result.project.id === id) setContext(result); }).catch(() => { if (generation.current === seq && currentBrand.current === id) setContextError(t('agent.contextFailed')); }),
      request<{ rows: SavedAnalysis[] }>('agent/analyses?brandId=' + encodeURIComponent(id)).then(result => { if (generation.current === seq && currentBrand.current === id) setAnalyses(result.rows.filter(row => row.brandId === id)); }).catch(() => { if (generation.current === seq && currentBrand.current === id) setAnalysesError(t('agent.analysesFailed')); }),
    ]);
    if (generation.current === seq && currentBrand.current === id) setLoading(false);
  }
  useEffect(() => { const seq = ++generation.current; setContext(null); setAccess(null); setCreated(null); setAnalyses([]); setNotice(''); setCanSaveAnalysis(false); if (brandId) void read(brandId, seq); return () => { generation.current++; }; }, [brandId]);
  const visibleKeys = access?.keys.filter(key => key.brandIds.includes(brandId)) ?? [];
  async function createKey() {
    if (busy || !brandId || !label.trim()) return;
    const id = brandId, seq = generation.current;
    setBusy(true); setKeyError(''); setCreated(null); setNotice('');
    try {
      const result = await request<{ id: string; key: string | null; shownOnce: boolean; brandIds: string[] }>('agent/key-create', { label: label.trim(), brandIds: [id], canSaveAnalysis });
      if (generation.current !== seq || currentBrand.current !== id) return;
      if (result.key && result.shownOnce && result.brandIds.includes(id)) { setCreated({ id: result.id, key: result.key }); setNotice(t('agent.keyReady')); }
      else setNotice(t('agent.keyNotReturned'));
      setLabel('');
      await read(id, seq);
    } catch { if (generation.current === seq) setKeyError(t('agent.createFailed')); }
    finally { setBusy(false); }
  }
  async function revokeKey(keyId: string) {
    if (busy) return;
    const seq = generation.current, id = brandId; setBusy(true); setKeyError('');
    try {
      await request('agent/key-revoke', { id: keyId });
      if (generation.current !== seq || currentBrand.current !== id) return;
      if (created?.id === keyId) setCreated(null);
      setNotice(t('agent.revoked')); await read(id, seq);
    } catch { if (generation.current === seq) setKeyError(t('agent.revokeFailed')); }
    finally { setBusy(false); }
  }
  async function copy(kind: 'key' | 'config') {
    if (!created || !access) return;
    try {
      const value = kind === 'key' ? created.key : JSON.stringify({ mcpServers: { getaudit: { url: access.url, headers: { Authorization: 'Bearer ' + created.key } } } }, null, 2);
      await navigator.clipboard.writeText(value); setNotice(t(kind === 'key' ? 'agent.keyCopied' : 'agent.configCopied'));
    } catch { setKeyError(t('agent.copyFailed')); }
  }
  const date = (value: string) => { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(language) : value; };
  return <div className="agent-desk">
    <section className="panel agent-overview"><div className="section-head"><div><h2>{t('agent.title')}</h2><p className="muted">{t('agent.description')}</p></div><KeyRound size={22} aria-hidden="true"/></div>
      <div className="agent-toolbar"><label className="field"><span>{t('agent.project')}</span><select value={brandId} disabled={busy} onChange={event => setBrandId(event.target.value)}>{brands.map(brand => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label><button type="button" disabled={!brandId || loading || busy} onClick={() => void read(brandId, generation.current)}><RefreshCw size={14} aria-hidden="true"/>{t('agent.refresh')}</button></div>
      <p className="quiet-note">{t('agent.localOnly')}</p>
      {!brandId && <p>{t('agent.noProject')}</p>}
    </section>
    {brandId && <>
      <section className="panel agent-access"><div className="section-head"><div><h2>{t('agent.accessTitle')}</h2><p className="muted">{t('agent.accessDescription')}</p></div></div>
        {keyError && <p className="alert error" role="alert">{uiMessage(keyError)}</p>}{notice && <p className="agent-notice" role="status">{uiMessage(notice)}</p>}
        <div className="agent-key-form"><label className="field"><span>{t('agent.keyName')}</span><input value={label} maxLength={80} disabled={busy} onChange={event => setLabel(event.target.value)} placeholder={t('agent.keyPlaceholder')}/></label><button type="button" className="primary" disabled={busy || loading || !access || !label.trim()} onClick={() => void createKey()}><KeyRound size={14} aria-hidden="true"/>{t('agent.createKey')}</button></div>
        <label className="agent-write-access"><input type="checkbox" checked={canSaveAnalysis} disabled={busy} onChange={event => setCanSaveAnalysis(event.target.checked)}/><span>{t('agent.allowSave')}</span></label><p className="quiet-note">{t('agent.saveScope')}</p>
        {access && <label className="field agent-endpoint"><span>{t('agent.endpoint')}</span><input readOnly value={access.url}/></label>}
        {created && <div className="agent-key-reveal"><label className="field"><span>{t('agent.newKey')}</span><input readOnly type="password" value={created.key} autoComplete="off"/></label><p>{t('agent.onceOnly')}</p><div className="agent-actions"><button type="button" onClick={() => void copy('config')}><Copy size={14} aria-hidden="true"/>{t('agent.copyConfig')}</button><button type="button" onClick={() => void copy('key')}><Copy size={14} aria-hidden="true"/>{t('agent.copyKey')}</button><button type="button" onClick={() => setCreated(null)}>{t('agent.dismissKey')}</button></div></div>}
        <div className="agent-key-list">{visibleKeys.map(key => <div className="agent-key-row" key={key.id}><div><strong>{key.label}</strong><small>{key.tokenHint} · {t('agent.createdAt', { date: date(key.createdAt) })}</small><small>{key.canSaveAnalysis ? t('agent.canSave') : t('agent.readOnly')}</small><small>{key.revokedAt ? t('agent.revokedAt', { date: date(key.revokedAt) }) : key.lastUsedAt ? t('agent.lastUsedAt', { date: date(key.lastUsedAt) }) : t('agent.notUsed')}</small></div>{!key.revokedAt && <button type="button" disabled={busy} onClick={() => void revokeKey(key.id)}><Unplug size={14} aria-hidden="true"/>{t('agent.revoke')}</button>}</div>)}</div>
        {!visibleKeys.length && !loading && <p className="muted">{t('agent.noKeys')}</p>}
        <p className="quiet-note">{t('agent.credentialSeparation')}</p><button type="button" onClick={onConnections}>{t('agent.manageSources')}</button>
      </section>
      <section className="panel agent-context"><div className="section-head"><div><h2>{t('agent.contextTitle')}</h2><p className="muted">{t('agent.contextDescription')}</p></div><button type="button" onClick={onGsc}>{t('agent.openGsc')}</button></div>
        {loading && <p role="status">{t('agent.loading')}</p>}{contextError && <p className="alert error" role="alert">{uiMessage(contextError)}</p>}
        {context?.seo ? <><p className="agent-source-line">{context.seo.evidence.property} · {context.seo.evidence.startDate} — {context.seo.evidence.endDate} · {context.seo.evidence.country} / {context.seo.evidence.device}</p><div className="agent-findings"><span>{t('health.status.opportunity')}<strong>{context.seo.summary.opportunity ?? 0}</strong></span><span>{t('health.status.stagnant')}<strong>{context.seo.summary.stagnant ?? 0}</strong></span><span>{t('health.status.declining')}<strong>{context.seo.summary.declining ?? 0}</strong></span><span>{t('health.status.improving')}<strong>{context.seo.summary.improving ?? 0}</strong></span></div>
          <h3>{t('agent.fiveOpportunities')}</h3>{context.seo.opportunities.shortfall > 0 && <p>{t('agent.shortfall', { qualifying: context.seo.opportunities.qualifying, target: context.seo.opportunities.target })}</p>}
          <div className="table-scroll"><table className="plain-table"><thead><tr><th>{t('agent.keyword')}</th><th>{t('agent.position')}</th><th>{t('agent.page')}</th></tr></thead><tbody>{context.seo.opportunities.rows.map(row => <tr key={row.keyword}><td>{row.keyword}</td><td>{row.current.position?.toFixed(1) ?? '—'}</td><td>{row.ownerUrl ? <a href={/^https?:\/\//.test(row.ownerUrl) ? row.ownerUrl : undefined} target="_blank" rel="noreferrer">{row.ownerUrl}<ExternalLink size={12} aria-hidden="true"/></a> : t('agent.pageUnknown')}</td></tr>)}</tbody></table></div><p className="quiet-note">{t('agent.positionNote')}</p>
          <details className="agent-provenance"><summary>{t('agent.evidence')}</summary><p>{context.seo.evidence.snapshotId}<br/>SHA-256 {context.seo.evidence.hash}</p></details>
        </> : !loading && <p>{t('agent.noGsc')}</p>}
        {!!context?.actions.length && <div className="agent-action-list"><h3>{t('agent.nextActions')}</h3>{context.actions.slice(0,8).map((action, index) => { const copy = actionCopy[action.kind as keyof typeof actionCopy]; return <article key={index}><h4>{action.keyword ?? t('agent.coverageAction')}</h4>{action.targetUrl && <p><a href={/^https?:\/\//.test(action.targetUrl) ? action.targetUrl : undefined} target="_blank" rel="noreferrer">{action.targetUrl}</a></p>}<p>{copy ? t(copy[0]) : action.action}</p><dl><div><dt>{t('agent.acceptance')}</dt><dd>{copy ? t(copy[1]) : action.acceptance}</dd></div><div><dt>{t('agent.measurement')}</dt><dd>{copy ? t(copy[2]) : action.measurement}</dd></div></dl></article>; })}</div>}
        <p className="quiet-note">{t('agent.geoSeparate')}</p>
        {!!context && <details className="agent-unknowns"><summary>{t('agent.unknowns')}</summary>{[...context.unknowns,...context.limitations].map((item,index) => <p key={index}>{uiMessage(item)}</p>)}</details>}
        <div className="agent-gsc-connect"><div className="agent-actions"><button type="button" disabled={busy} onClick={onConnections}>{context?.seo ? t('agent.reconnectGsc') : t('agent.connectGsc')}</button></div></div>
        <div className="agent-prompt"><h3>{t('agent.tryPrompt')}</h3><p>{t('agent.promptExample')}</p></div>
      </section>
      <section className="panel agent-saved-analysis"><div className="section-head"><div><h2>{t('agent.savedTitle')}</h2><p className="muted">{t('agent.savedDescription')}</p></div></div>{analysesError && <p className="alert error" role="alert">{uiMessage(analysesError)}</p>}{!analyses.length && !loading && !analysesError && <p>{t('agent.noAnalysis')}</p>}{analyses.slice(0,3).map(analysis => <article key={analysis.id} className="agent-analysis"><h3>{analysis.title}</h3><p className="agent-source-line">{date(analysis.createdAt)}{analysis.provider ? ' · ' + analysis.provider : ''}{analysis.model ? ' / ' + analysis.model : ''}</p><p>{analysis.summary}</p>{analysis.actions.map((action,index) => <div className="agent-saved-action" key={index}>{action.targetUrl && <p><a href={/^https?:\/\//.test(action.targetUrl) ? action.targetUrl : undefined} target="_blank" rel="noreferrer">{action.targetUrl}</a></p>}<h3>{action.action}</h3><p>{action.reason}</p><dl><div><dt>{t('agent.acceptance')}</dt><dd>{action.acceptance}</dd></div><div><dt>{t('agent.measurement')}</dt><dd>{action.measurement}</dd></div></dl></div>)}{!!analysis.gaps.length && <details><summary>{t('agent.unknowns')}</summary>{analysis.gaps.map((gap,index) => <p key={index}>{gap}</p>)}</details>}<details className="agent-provenance"><summary>{t('agent.evidence')}</summary><p>SHA-256 {analysis.contentHash}</p>{analysis.sourceRefs.map(source => <p key={source.kind + source.id}>{source.kind} · {source.id}<br/>SHA-256 {source.hash}</p>)}</details><p className="quiet-note">{t('agent.analysisMetadata')}</p></article>)}</section>
    </>}
  </div>;
}
