import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import { request } from './api.ts';
import { t, useUiLanguage } from './i18n.tsx';
import { accountStatusRefreshEvent, GoogleMark, googleAuthLink, refreshAccountStatus, type AccountStatus } from './account-chip.tsx';
import { DotHelper } from './dot-helper.tsx';
import { GoogleAccountFeedback, googleAccountFeedback } from './google-account-feedback.tsx';
import './google-connection-panel.css';

export type GoogleSelection = { brandId: string; gscProperty?: string; ga4PropertyId?: string };
export const googleSelectionRefreshEvent = 'getaudit:google-selection-refresh';
export type GoogleResources = {
  gsc: { status: 'ready' | 'missing_scope' | 'error'; sites: { siteUrl: string; permissionLevel: string }[]; errorCode?: string };
  ga4: { status: 'ready' | 'missing_scope' | 'error'; properties: { propertyId: string; displayName: string; accountName?: string; timeZone?: string }[]; errorCode?: string };
  selection: GoogleSelection;
};

/** Google authorization and per-project mapping; it never asks an end user for credentials. */
export function GoogleConnectionPanel({ brandId, onSelectionChange }: { brandId?: string; onSelectionChange?: (selection: GoogleSelection) => void }) {
  useUiLanguage();
  const [account, setAccount] = useState<AccountStatus | null>(null), [resources, setResources] = useState<GoogleResources | null>(null);
  const [gscProperty, setGscProperty] = useState(''), [ga4PropertyId, setGa4PropertyId] = useState('');
  const [reading, setReading] = useState(false), [busy, setBusy] = useState(false), [pollStopped, setPollStopped] = useState(false);
  const [error, setError] = useState<'account' | 'resources' | 'save' | ''>(''), [saved, setSaved] = useState(false), [authUrl, setAuthUrl] = useState<string | null>(null);
  const alive = useRef(true), statusReading = useRef(false), statusRevision = useRef(0), resourceRevision = useRef(0);
  const readAccount = useCallback(async () => {
    if (statusReading.current) return;
    statusReading.current = true;
    const current = statusRevision.current;
    try { const next = await request<AccountStatus>('account/status'); if (alive.current && current === statusRevision.current) { setAccount(next); setError(previous => previous === 'account' ? '' : previous); if (next.status !== 'pending') setAuthUrl(null); return next; } }
    catch { if (alive.current && current === statusRevision.current) setError('account'); }
    finally { statusReading.current = false; }
  }, []);
  useEffect(() => {
    alive.current = true; void readAccount();
    const refresh = () => { if (!document.hidden) void readAccount(); };
    window.addEventListener('focus', refresh); window.addEventListener(accountStatusRefreshEvent, refresh);
    return () => { alive.current = false; resourceRevision.current++; window.removeEventListener('focus', refresh); window.removeEventListener(accountStatusRefreshEvent, refresh); };
  }, [readAccount]);
  const waiting = account?.status === 'pending' || account?.status === 'restoring' || account?.storage === 'loading' || account?.connectionsAccess?.status === 'loading';
  useEffect(() => {
    setPollStopped(false); if (!waiting) return;
    const deadline = Date.now() + 120_000;
    const timer = setInterval(() => { if (Date.now() >= deadline) { clearInterval(timer); setPollStopped(true); return; } if (!document.hidden) void readAccount(); }, 2500);
    return () => clearInterval(timer);
  }, [waiting, readAccount]);
  const readResources = useCallback(async () => {
    const revision = ++resourceRevision.current;
    if (!brandId) { setResources(null); setReading(false); return; }
    setReading(true); setError(''); setSaved(false);
    try {
      const next = await request<GoogleResources>('google/resources?brandId=' + encodeURIComponent(brandId));
      if (!alive.current || revision !== resourceRevision.current) return;
      setResources(next); setGscProperty(next.selection.gscProperty ?? ''); setGa4PropertyId(next.selection.ga4PropertyId ?? '');
    } catch { if (alive.current && revision === resourceRevision.current) setError('resources'); }
    finally { if (alive.current && revision === resourceRevision.current) setReading(false); }
  }, [brandId]);
  const signedIn = account?.status === 'signed_in';
  const subject = account?.profile?.subject;
  const gscGranted = account?.capabilities?.gsc === true, ga4Granted = account?.capabilities?.ga4 === true;
  useEffect(() => {
    setResources(null); setGscProperty(''); setGa4PropertyId(''); setSaved(false);
    if (signedIn) void readResources(); else { resourceRevision.current++; setReading(false); }
    return () => { resourceRevision.current++; };
  }, [signedIn, subject, gscGranted, ga4Granted, readResources]);
  const setupRequired = account?.status === 'setup_required';
  const locked = account?.storage === 'locked' || account?.connectionsAccess?.status === 'locked' || account?.errorCode === 'storage_unavailable';
  async function connect() {
    if (busy || setupRequired || locked) return;
    if (!account) { await readAccount(); return; }
    if (waiting) { await readAccount(); return; }
    statusRevision.current++;
    resourceRevision.current++; setResources(null); setGscProperty(''); setGa4PropertyId(''); setReading(false);
    setBusy(true); setError(''); setSaved(false);
    try {
      const result = await request<{ opened: boolean; url?: string }>('account/data-start', {});
      if (!alive.current) return;
      setAuthUrl(result.opened ? null : googleAuthLink(result.url)); setAccount(previous => ({ ...previous, configured: true, status: 'pending', errorCode: undefined, errorDetail: undefined, errorPhase: undefined }));
      await readAccount(); refreshAccountStatus();
    } catch { if (alive.current) { setError('account'); const status = await readAccount(); if (alive.current && status?.status !== 'error' && status?.status !== 'setup_required') setError('account'); } }
    finally { if (alive.current) setBusy(false); }
  }
  async function signOut() {
    if (busy) return; setBusy(true); setError('');
    statusRevision.current++;
    resourceRevision.current++; setResources(null); setGscProperty(''); setGa4PropertyId(''); setReading(false);
    try { await request('account/sign-out', {}); if (!alive.current) return; setResources(null); setAccount(previous => ({ configured: previous?.configured ?? true, status: 'signed_out' })); setAuthUrl(null); refreshAccountStatus(); }
    catch { if (alive.current) setError('account'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function save() {
    if (!brandId || !resources || busy) return;
    const revision = resourceRevision.current;
    setBusy(true); setError(''); setSaved(false);
    try {
      const selection = await request<GoogleSelection>('google/selection', { brandId, ...(resources.gsc.status === 'ready' ? { gscProperty } : {}), ...(resources.ga4.status === 'ready' ? { ga4PropertyId } : {}) });
      if (!alive.current || revision !== resourceRevision.current || selection.brandId !== brandId) return;
      setResources(previous => previous ? { ...previous, selection } : previous); setSaved(true); onSelectionChange?.(selection);
      window.dispatchEvent(new window.Event(googleSelectionRefreshEvent));
    } catch { if (alive.current && revision === resourceRevision.current) setError('save'); }
    finally { if (alive.current) setBusy(false); }
  }
  const gscReady = resources?.gsc.status === 'ready', ga4Ready = resources?.ga4.status === 'ready';
  const gscValid = !gscProperty || resources?.gsc.sites.some(site => site.siteUrl === gscProperty);
  const ga4Valid = !ga4PropertyId || resources?.ga4.properties.some(property => property.propertyId === ga4PropertyId);
  const changed = gscProperty !== (resources?.selection.gscProperty ?? '') || ga4PropertyId !== (resources?.selection.ga4PropertyId ?? '');
  const accountFeedback = googleAccountFeedback(account);
  return <section className="google-connection" aria-busy={busy || reading}>
    <header className="google-connection__intro"><div><h2>{t('google.connectionTitle')}</h2><p>{t('google.connectionDescription')}</p></div><DotHelper compact/></header>
    <div className="google-connection__permission"><ShieldCheck size={20} aria-hidden="true"/><div><strong>{t('google.readOnly')}</strong><ul><li>{t('google.gscPurpose')}</li><li>{t('google.ga4Purpose')}</li></ul><p>{t('google.permissionNote')}</p></div></div>
    {setupRequired ? <p className="google-connection__notice" role="status">{t('google.ownerSetupRequired')}</p> : locked && !accountFeedback ? <p className="google-connection__notice" role="status">{t('google.storageLocked')}</p> : null}
    {account?.profile && signedIn && <div className="google-connection__identity"><span className="google-connection__check"><Check size={18} aria-hidden="true"/></span><span><strong>{account.profile.name || account.profile.email}</strong><small>{account.profile.email}</small></span><button type="button" className="google-connection__text" disabled={busy} onClick={() => void signOut()}><LogOut size={14} aria-hidden="true"/>{t('account.signOut')}</button></div>}
    <div className="google-connection__actions">{signedIn && gscGranted && ga4Granted ? <button type="button" disabled={busy} onClick={() => void connect()}>{t('google.connectAgain')}</button> : <button type="button" className="google-signin" disabled={busy || !account && error !== 'account' || setupRequired || locked || waiting && !pollStopped} onClick={() => void connect()}><GoogleMark/>{waiting ? pollStopped ? t('account.checkAgain') : t('account.checkSignIn') : t('account.continueGoogle')}</button>}{signedIn && <button type="button" disabled={busy || reading} onClick={() => void readResources()}><RefreshCw size={15} aria-hidden="true"/>{t('google.checkResources')}</button>}</div>
    {waiting && <p role="status" className="google-connection__notice">{t('google.browserWaiting')}{authUrl && <> <a href={authUrl} target="_blank" rel="noopener noreferrer">{t('account.openGoogle')}</a></>}</p>}
    {!waiting && error !== 'account' && account && accountFeedback && <GoogleAccountFeedback account={account} className={locked ? 'google-connection__notice' : 'google-connection__error'}/>}
    {error && <p role="alert" className="google-connection__error">{error === 'save' ? t('google.saveFailed') : error === 'resources' ? t('google.resourcesFailed') : t('google.connectionFailed')}</p>}
    {!brandId && signedIn && <p>{t('google.projectRequired')}</p>}
    {reading && <p role="status">{t('google.resourcesLoading')}</p>}
    {resources && signedIn && <div className="google-connection__properties"><header><h3>{t('google.projectProperties')}</h3><p>{t('google.propertiesRemembered')}</p></header>
      <div className="google-connection__fields"><div><label htmlFor="google-gsc-property">{t('google.searchProperty')}</label>{gscReady ? <><select id="google-gsc-property" value={gscProperty} disabled={busy} onChange={event => { setGscProperty(event.target.value); setSaved(false); }}><option value="">{t('google.notConnected')}</option>{!gscValid && <option value={gscProperty} disabled>{gscProperty}</option>}{resources.gsc.sites.map(site => <option key={site.siteUrl} value={site.siteUrl}>{site.siteUrl}</option>)}</select>{!gscValid && <p className="google-connection__error">{t('google.unavailableSelection')}</p>}{!resources.gsc.sites.length && <p>{t('google.noSearchProperties')}</p>}</> : <p>{resources.gsc.status === 'missing_scope' ? t('google.resourcePermissionMissing') : t('google.resourcesFailed')}</p>}</div>
      <div><label htmlFor="google-ga4-property">{t('google.analyticsProperty')}</label>{ga4Ready ? <><select id="google-ga4-property" value={ga4PropertyId} disabled={busy} onChange={event => { setGa4PropertyId(event.target.value); setSaved(false); }}><option value="">{t('google.notConnected')}</option>{!ga4Valid && <option value={ga4PropertyId} disabled>{ga4PropertyId}</option>}{resources.ga4.properties.map(property => <option key={property.propertyId} value={property.propertyId}>{property.displayName}{property.accountName ? ' · ' + property.accountName : ''}</option>)}</select>{!ga4Valid && <p className="google-connection__error">{t('google.unavailableSelection')}</p>}{!resources.ga4.properties.length && <p>{t('google.noAnalyticsProperties')}</p>}</> : <p>{resources.ga4.status === 'missing_scope' ? t('google.resourcePermissionMissing') : t('google.resourcesFailed')}</p>}</div></div>
      {(gscReady || ga4Ready) && <button type="button" className="google-connection__save" disabled={busy || !changed || gscReady && !gscValid || ga4Ready && !ga4Valid} onClick={() => void save()}>{t('google.saveProperties')}</button>}
      {saved && <p className="google-connection__saved" role="status"><CheckCircle2 size={16} aria-hidden="true"/>{t('google.propertiesSaved')}</p>}
    </div>}
  </section>;
}
