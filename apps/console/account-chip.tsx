import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, CircleUserRound, RefreshCw } from 'lucide-react';
import { request } from './api.ts';
import { t, useUiLanguage } from './i18n.tsx';
import './agent-panel.css';
import './google-connection-panel.css';
import googleMark from './assets/google-g.png';
import { GoogleAccountFeedback, googleAccountFeedback, type GoogleAccountErrorDetail, type GoogleAccountErrorPhase } from './google-account-feedback.tsx';

export const accountStatusRefreshEvent = 'getgeo:account-status-refresh';
/** Call after an explicit connection change; this only re-reads account status. */
export function refreshAccountStatus() {
  if (typeof window !== 'undefined') window.dispatchEvent(new window.Event(accountStatusRefreshEvent));
}

export type AccountStatus = {
  status: 'setup_required' | 'signed_out' | 'pending' | 'restoring' | 'signed_in' | 'error';
  configured: boolean;
  profile?: { subject: string; name: string; email: string };
  errorCode?: string;
  errorDetail?: GoogleAccountErrorDetail;
  errorPhase?: GoogleAccountErrorPhase;
  storage?: 'loading' | 'locked' | 'ready';
  connectionsAccess?: { status: 'loading' | 'locked' | 'ready' };
  capabilities?: { gsc: boolean; ga4: boolean };
};

/** The unmodified Google mark is bundled locally; sign-in never loads a remote asset. */
export function GoogleMark() { return <img className="google-mark" src={googleMark} width="20" height="20" alt="" aria-hidden="true"/>; }

export function googleAuthLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.origin === 'https://accounts.google.com' && url.pathname === '/o/oauth2/v2/auth' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

export function AccountChip({ onConnections }: { onConnections: () => void }) {
  useUiLanguage();
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false), [authUrl, setAuthUrl] = useState<string | null>(null);
  const [pollStopped, setPollStopped] = useState(false);
  const alive = useRef(true), reading = useRef(false), revision = useRef(0), observedStatus = useRef<string | null>(null);
  const read = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const current = revision.current;
    try {
      const status = await request<AccountStatus>('account/status');
      if (!alive.current || current !== revision.current) return;
      setAccount(status); setFailed(false);
      if (status.status !== 'pending') setAuthUrl(null);
      const fingerprint = JSON.stringify([status.status, status.profile?.subject, status.capabilities?.gsc, status.capabilities?.ga4, status.storage, status.connectionsAccess?.status, status.errorCode, status.errorDetail, status.errorPhase]);
      const changed = observedStatus.current !== null && observedStatus.current !== fingerprint;
      observedStatus.current = fingerprint;
      // Only real account transitions notify data panels; unchanged polling cannot loop.
      if (changed) refreshAccountStatus();
      return status;
    } catch { if (alive.current && current === revision.current) setFailed(true); }
    finally { reading.current = false; }
  }, []);
  useEffect(() => {
    alive.current = true; void read();
    const refresh = () => { if (!document.hidden) void read(); };
    window.addEventListener('focus', refresh);
    window.addEventListener(accountStatusRefreshEvent, refresh);
    return () => { alive.current = false; window.removeEventListener('focus', refresh); window.removeEventListener(accountStatusRefreshEvent, refresh); };
  }, [read]);
  const waiting = account?.status === 'pending' || account?.status === 'restoring' || account?.storage === 'loading' || account?.connectionsAccess?.status === 'loading';
  useEffect(() => {
    setPollStopped(false);
    if (!waiting) return;
    const deadline = Date.now() + 120_000;
    const timer = setInterval(() => { if (Date.now() >= deadline) { clearInterval(timer); setPollStopped(true); return; } if (!document.hidden) void read(); }, 2500);
    return () => clearInterval(timer);
  }, [waiting, read]);
  async function start() {
    if (busy) return;
    if (!account || failed) { await read(); return; }
    if (account.status === 'setup_required' || account.storage === 'locked' || account.connectionsAccess?.status === 'locked' || account.errorCode === 'storage_unavailable') { onConnections(); return; }
    if (waiting) { await read(); return; }
    setBusy(true); setFailed(false);
    revision.current++;
    try {
      const result = await request<{ opened: boolean; url?: string; expiresAt: string }>('account/data-start', {});
      if (!alive.current) return;
      setAuthUrl(result.opened ? null : googleAuthLink(result.url));
      setAccount(previous => ({ ...previous, configured: true, status: 'pending', errorCode: undefined, errorDetail: undefined, errorPhase: undefined }));
      await read(); refreshAccountStatus();
    } catch { if (alive.current) { setFailed(true); const status = await read(); if (alive.current && status?.status !== 'error' && status?.status !== 'setup_required') setFailed(true); } }
    finally { if (alive.current) setBusy(false); }
  }
  async function signOut() {
    if (busy) return;
    setBusy(true);
    revision.current++;
    try {
      await request('account/sign-out', {});
      if (!alive.current) return;
      setAccount(previous => ({ status: 'signed_out', configured: previous?.configured ?? true }));
      setAuthUrl(null); setFailed(false);
      await read(); refreshAccountStatus();
    } catch { if (alive.current) { setFailed(true); const status = await read(); if (alive.current && status?.status !== 'error' && status?.status !== 'setup_required') setFailed(true); } }
    finally { if (alive.current) setBusy(false); }
  }
  if (account?.status === 'signed_in' && account.profile) return <details className="account-chip">
    <summary title={account.profile.email}><CircleUserRound size={17} aria-hidden="true"/><span>{t('account.welcome', { name: account.profile.name || account.profile.email })}</span><ChevronDown size={13} aria-hidden="true"/></summary>
    <div className="account-menu"><p>{account.profile.email}</p><small>{account.capabilities?.gsc && account.capabilities.ga4 ? t('google.dataConnected') : t('google.dataPartial')}</small><button type="button" onClick={onConnections}>{t('google.manageConnection')}</button>{failed && <p role="alert">{t('account.actionFailed')}</p>}<button type="button" disabled={busy} onClick={() => void signOut()}>{t('account.signOut')}</button></div>
  </details>;
  return <div className="account-control">
    <button type="button" className={'account-login' + (!waiting ? ' google-signin' : '')} disabled={busy || (!account && !failed) || waiting && account?.status !== 'pending' && !pollStopped} onClick={() => void start()} title={account?.status === 'setup_required' ? t('google.ownerSetupRequired') : undefined}>
      {waiting ? <RefreshCw size={15} aria-hidden="true"/> : <GoogleMark/>}
      {failed ? t('account.retry') : waiting ? pollStopped ? t('account.checkAgain') : t('account.checkSignIn') : t('account.continueGoogle')}
    </button>
    {(account?.status === 'pending' || failed) && <div className="account-menu" role={failed ? 'alert' : 'status'}><p>{failed ? t('account.actionFailed') : t('account.finishGoogle')}</p>{authUrl && <a href={authUrl} target="_blank" rel="noopener noreferrer">{t('account.openGoogle')}</a>}</div>}
    {!failed && !waiting && account && googleAccountFeedback(account) && <GoogleAccountFeedback account={account} className="account-menu"/>}
  </div>;
}
