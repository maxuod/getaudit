import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { GoogleConnectionPanel, type GoogleResources } from '../../apps/console/google-connection-panel.tsx';
import { Ga4Panel, type Ga4Report } from '../../apps/console/ga4-panel.tsx';
import { WorkspaceSettings } from '../../apps/console/workspace-settings.tsx';
import { request } from '../../apps/console/api.ts';
import { setUiLanguage } from '../../apps/console/i18n.tsx';
import { AccountChip, refreshAccountStatus } from '../../apps/console/account-chip.tsx';
import { googleAccountFeedback } from '../../apps/console/google-account-feedback.tsx';

vi.mock('../../apps/console/api.ts', () => ({ request: vi.fn() }));
beforeEach(() => setUiLanguage('en'));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.mocked(request).mockReset(); setUiLanguage('en'); });

async function mount(component: React.ReactNode) {
  const { window, document } = parseHTML('<html><head></head><body><main id="root"></main></body></html>');
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('localStorage', storage);
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.getElementById('root')! as unknown as HTMLElement);
  await act(async () => root.render(component));
  return { window, document, root,
    async click(text: string) { const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes(text)); expect(button, text).toBeTruthy(); await act(async () => button!.dispatchEvent(new window.Event('click', { bubbles: true }))); },
    async select(selector: string, value: string) { const field = document.querySelector(selector)!; const key = Object.keys(field).find(name => name.startsWith('__reactProps$'))!; await act(async () => (field as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key].onChange({ target: { value } })); },
    async render(next: React.ReactNode) { await act(async () => root.render(next)); },
    async close() { await act(async () => root.unmount()); },
  };
}
const signedIn = { status: 'signed_in', configured: true, profile: { subject: 'verified-user', name: 'Jordan', email: 'jordan@example.test' }, capabilities: { gsc: true, ga4: true } };
function resources(brandId = 'project-a'): GoogleResources {
  return {
    gsc: { status: 'ready', sites: [{ siteUrl: 'sc-domain:example.test', permissionLevel: 'siteOwner' }] },
    ga4: { status: 'ready', properties: [{ propertyId: 'properties/123', displayName: 'Original GA4 原文', accountName: 'Company' }] },
    selection: { brandId },
  };
}
const metrics = { activeUsers: 1200, sessions: 1600, screenPageViews: 3100, keyEvents: 12 };
const report: Ga4Report = {
  id: 'snapshot-one', propertyId: 'properties/123', displayName: 'Original GA4 原文', startDate: '2026-09-17', endDate: '2026-10-14', capturedAt: '2026-10-16T12:00:00Z', timeZone: 'America/Halifax', summary: metrics,
  daily: [{ date: '2026-09-17', ...metrics }, { date: '2026-09-19', ...metrics }],
  traffic: [{ source: 'google', medium: 'organic', ...metrics }], limitations: ['Original upstream evidence 原文'], hash: 'original-hash',
};

describe('Google read-only connection', () => {
  it.each(['en', 'zh-CN'] as const)('opens the privacy policy independently of Google authorization and Settings actions in %s', async language => {
    setUiLanguage(language);
    vi.mocked(request).mockResolvedValue({ status: 'setup_required', configured: false });
    const onNavigate = vi.fn(), onConnections = vi.fn(), onSearchSetup = vi.fn();
    const ui = await mount(<GoogleConnectionPanel brandId="project-a"/>);
    const checkLink = async () => {
      const link = ui.document.querySelector('a[href="https://getaudit.si/privacy/"]');
      expect(link?.textContent).toBe(language === 'en' ? 'Privacy policy' : '隐私政策');
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
      await act(async () => link!.dispatchEvent(new ui.window.Event('click', { bubbles: true })));
      expect(vi.mocked(request).mock.calls).toEqual([['account/status']]);
      expect(onNavigate).not.toHaveBeenCalled();
      expect(onConnections).not.toHaveBeenCalled();
      expect(onSearchSetup).not.toHaveBeenCalled();
    };
    try {
      await checkLink();
      await ui.render(<WorkspaceSettings projectCount={1} onNavigate={onNavigate} onConnections={onConnections} onSearchSetup={onSearchSetup}/>);
      await checkLink();
    } finally { await ui.close(); }
  });

  it('starts the unified browser authorization only after a click, never asking an end user for technical fields', async () => {
    let pending = false;
    vi.mocked(request).mockImplementation(async path => {
      if (path === 'account/data-start') { pending = true; return { opened: false, url: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' }; }
      return { status: pending ? 'pending' : 'signed_out', configured: true };
    });
    const ui = await mount(<GoogleConnectionPanel brandId="project-a"/>);
    try {
      expect(vi.mocked(request).mock.calls).toEqual([['account/status']]);
      expect(ui.document.querySelector('input')).toBeNull();
      expect(ui.document.body.textContent).toContain('Read-only access');
      await ui.click('Continue with Google');
      expect(vi.mocked(request).mock.calls).toContainEqual(['account/data-start', {}]);
      expect(ui.document.querySelector('a[href^="https://accounts.google.com/o/oauth2/v2/auth"]')?.getAttribute('href')).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(ui.document.body.textContent).toContain('Your browser has the next step');
    } finally { await ui.close(); }
  });

  it('explains app-owner setup without offering code entry or beginning OAuth', async () => {
    vi.mocked(request).mockResolvedValue({ status: 'setup_required', configured: false });
    const ui = await mount(<GoogleConnectionPanel brandId="project-a"/>);
    try {
      expect(ui.document.body.textContent).toContain('The app owner needs to finish setup.');
      expect(ui.document.querySelector('button')?.hasAttribute('disabled')).toBe(true);
      expect(ui.document.querySelector('input')).toBeNull();
      expect(vi.mocked(request).mock.calls).toEqual([['account/status']]);
    } finally { await ui.close(); }
  });

  it('preserves draft resource choices across language switching and saves only this project after confirmation', async () => {
    const onSelectionChange = vi.fn();
    vi.mocked(request).mockImplementation(async (path, input) => {
      if (path === 'account/status') return signedIn;
      if (path.startsWith('google/resources?')) return resources();
      if (path === 'google/selection') return input;
      return {};
    });
    const ui = await mount(<GoogleConnectionPanel brandId="project-a" onSelectionChange={onSelectionChange}/>);
    try {
      await ui.select('#google-gsc-property', 'sc-domain:example.test');
      await ui.select('#google-ga4-property', 'properties/123');
      const reads = vi.mocked(request).mock.calls.length;
      await act(async () => setUiLanguage('zh-CN'));
      expect(vi.mocked(request)).toHaveBeenCalledTimes(reads);
      expect(ui.document.querySelector('#google-ga4-property')?.getAttribute('value') ?? (ui.document.querySelector('#google-ga4-property') as unknown as HTMLSelectElement).value).toBe('properties/123');
      await ui.click('保存网站资源');
      expect(vi.mocked(request).mock.calls).toContainEqual(['google/selection', { brandId: 'project-a', gscProperty: 'sc-domain:example.test', ga4PropertyId: 'properties/123' }]);
      expect(onSelectionChange).toHaveBeenCalledWith({ brandId: 'project-a', gscProperty: 'sc-domain:example.test', ga4PropertyId: 'properties/123' });
      expect(ui.document.body.textContent).toContain('已保存，下次打开项目就用这些资源');
      expect(ui.document.body.textContent).toContain('Original GA4 原文');
    } finally { await ui.close(); }
  });

  it('distinguishes a missing permission from an account with no properties and does not save a missing-scope field', async () => {
    vi.mocked(request).mockImplementation(async (path, input) => {
      if (path === 'account/status') return { ...signedIn, capabilities: { gsc: false, ga4: true } };
      if (path.startsWith('google/resources?')) return { ...resources(), gsc: { status: 'missing_scope', sites: [] } };
      return input;
    });
    const ui = await mount(<GoogleConnectionPanel brandId="project-a"/>);
    try {
      expect(ui.document.body.textContent).toContain('This data needs your read-only permission');
      expect(ui.document.body.textContent).not.toContain('No Search Console properties');
      expect(ui.document.querySelector('#google-gsc-property')).toBeNull();
      await ui.select('#google-ga4-property', 'properties/123'); await ui.click('Save properties');
      expect(vi.mocked(request).mock.calls).toContainEqual(['google/selection', { brandId: 'project-a', ga4PropertyId: 'properties/123' }]);
    } finally { await ui.close(); }
  });

  it('discards a late resource response from a previous project', async () => {
    let finish!: (value: GoogleResources) => void;
    vi.mocked(request).mockImplementation(async path => {
      if (path === 'account/status') return signedIn;
      if (path.endsWith('project-a')) return new Promise<GoogleResources>(resolve => { finish = resolve; });
      return { ...resources('project-b'), ga4: { status: 'ready', properties: [] } };
    });
    const ui = await mount(<GoogleConnectionPanel brandId="project-a"/>);
    try {
      await ui.render(<GoogleConnectionPanel brandId="project-b"/>);
      await act(async () => finish(resources()));
      expect(ui.document.body.textContent).not.toContain('Original GA4 原文');
      expect(ui.document.body.textContent).toContain('No Google Analytics properties');
    } finally { await ui.close(); }
  });

  it('removes the previous account resources as soon as reconnection starts', async () => {
    let finish!: (value: { opened: boolean }) => void, pending = false;
    vi.mocked(request).mockImplementation(async path => {
      if (path === 'account/status') return pending ? { configured: true, status: 'pending' } : signedIn;
      if (path === 'account/data-start') { pending = true; return new Promise<{ opened: boolean }>(resolve => { finish = resolve; }); }
      return resources();
    });
    const ui = await mount(<GoogleConnectionPanel brandId="project-a"/>);
    try {
      expect(ui.document.body.textContent).toContain('Original GA4 原文');
      await ui.click('Reconnect Google');
      expect(ui.document.body.textContent).not.toContain('Original GA4 原文');
      expect(ui.document.querySelector('#google-gsc-property')).toBeNull();
      await act(async () => finish({ opened: true }));
      expect(ui.document.body.textContent).not.toContain('Original GA4 原文');
    } finally { await ui.close(); }
  });

  it('refreshes a stable locked account and Google panel after the explicit access-change event without polling or authorizing', async () => {
    vi.useFakeTimers();
    let account: unknown = { status: 'error', configured: false, errorCode: 'storage_unavailable', connectionsAccess: { status: 'locked' } };
    vi.mocked(request).mockImplementation(async () => account);
    const ui = await mount(<><AccountChip onConnections={vi.fn()}/><GoogleConnectionPanel brandId="project-a"/></>);
    try {
      expect(ui.document.querySelector('.google-connection .google-signin')?.hasAttribute('disabled')).toBe(true);
      expect(ui.document.body.textContent).toContain('Saved Google connections are waiting for macOS access.');
      const lockedReads = vi.mocked(request).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(vi.mocked(request)).toHaveBeenCalledTimes(lockedReads);
      account = { status: 'signed_out', configured: true, connectionsAccess: { status: 'ready' } };
      await act(async () => refreshAccountStatus());
      expect(ui.document.querySelector('.google-connection .google-signin')?.hasAttribute('disabled')).toBe(false);
      expect(ui.document.body.textContent).not.toContain('Saved Google connections are waiting for macOS access.');
      const updatedReads = vi.mocked(request).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
      expect(vi.mocked(request)).toHaveBeenCalledTimes(updatedReads);
      expect(vi.mocked(request).mock.calls.every(([path]) => path === 'account/status')).toBe(true);
    } finally { await ui.close(); }
  });

  it('shows an identity-check failure with a fixed diagnostic code in both languages without revealing an unverified profile', async () => {
    vi.mocked(request).mockResolvedValue({ status: 'error', configured: true, errorCode: 'verification_failed', errorPhase: 'identity_verification', errorDetail: 'id_token_signature_invalid', profile: { subject: 'PRIVATE_SUBJECT_CANARY', name: 'PRIVATE_NAME_CANARY', email: 'PRIVATE_EMAIL_CANARY@example.test' }, rawResponse: 'PRIVATE_RESPONSE_CANARY' });
    const ui = await mount(<GoogleConnectionPanel brandId="project-a"/>);
    try {
      expect(ui.document.querySelector('[role="alert"]')?.textContent).toContain("could not verify Google's identity signature");
      expect(ui.document.body.textContent).toContain('Confirm Google identity');
      expect(ui.document.body.textContent).toContain('id_token_signature_invalid');
      expect(ui.document.body.innerHTML).not.toMatch(/PRIVATE_|Welcome,/);
      const reads = vi.mocked(request).mock.calls.length;
      await act(async () => setUiLanguage('zh-CN'));
      expect(ui.document.body.textContent).toContain('无法确认 Google 身份签名的有效性');
      expect(ui.document.body.textContent).toContain('确认 Google 身份');
      expect(ui.document.body.textContent).toContain('id_token_signature_invalid');
      expect(ui.document.body.textContent).not.toContain('应用验证');
      expect(vi.mocked(request)).toHaveBeenCalledTimes(reads);
    } finally { await ui.close(); }
  });

  it('never echoes unknown diagnostics, URLs, raw replies or credential-like values', async () => {
    vi.mocked(request).mockResolvedValue({ status: 'error', configured: true, errorCode: 'PRIVATE_CODE_CANARY', errorPhase: 'https://private.example.test/callback?token=PRIVATE_TOKEN_CANARY', errorDetail: 'PRIVATE_RESPONSE_CANARY', token: 'PRIVATE_TOKEN_CANARY', email: 'PRIVATE_EMAIL_CANARY@example.test' });
    const ui = await mount(<GoogleConnectionPanel brandId="project-a"/>);
    try {
      expect(ui.document.querySelector('[role="alert"]')?.textContent).toContain('Google connection could not be completed');
      expect(ui.document.querySelector('.google-account-feedback code')).toBeNull();
      expect(ui.document.body.innerHTML).not.toMatch(/PRIVATE_|private\.example/);
      expect(ui.document.querySelector('input')).toBeNull();
    } finally { await ui.close(); }
  });

  it.each(['chip', 'panel'])('reads one safe status after a failed start on the %s, keeping raw HTTP failures private', async surface => {
    let failed = false;
    vi.mocked(request).mockImplementation(async path => {
      if (path === 'account/data-start') { failed = true; throw new Error('PRIVATE_PROVIDER_RESPONSE_CANARY with token=PRIVATE_TOKEN_CANARY'); }
      return failed ? { status: 'error', configured: true, errorCode: 'verification_failed', errorPhase: 'token_exchange', errorDetail: 'client_secret_missing' } : { status: 'signed_out', configured: true };
    });
    const ui = await mount(surface === 'chip' ? <AccountChip onConnections={vi.fn()}/> : <GoogleConnectionPanel brandId="project-a"/>);
    try {
      await ui.click('Continue with Google');
      expect(ui.document.body.textContent).toContain('missing an app credential');
      expect(ui.document.body.textContent).toContain('client_secret_missing');
      expect(ui.document.body.innerHTML).not.toContain('PRIVATE_');
      expect(vi.mocked(request).mock.calls.filter(([, input]) => input !== undefined)).toEqual([['account/data-start', {}]]);
      expect(vi.mocked(request).mock.calls.filter(([path]) => path === 'account/status')).toHaveLength(2);
    } finally { await ui.close(); }
  });

  it('shows a callback failure in the account chip after polling, without rendering Welcome or starting another authorization', async () => {
    vi.useFakeTimers();
    let account: unknown = { status: 'pending', configured: true };
    vi.mocked(request).mockImplementation(async () => account);
    const ui = await mount(<AccountChip onConnections={vi.fn()}/>);
    try {
      account = { status: 'error', configured: true, errorCode: 'verification_failed', errorPhase: 'identity_verification', errorDetail: 'id_token_claims_invalid', profile: { name: 'PRIVATE_UNVERIFIED_CANARY' } };
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(ui.document.querySelector('[role="alert"]')?.textContent).toContain('required account or time checks');
      expect(ui.document.body.textContent).toContain('id_token_claims_invalid');
      expect(ui.document.body.textContent).not.toMatch(/Welcome|PRIVATE_UNVERIFIED/);
      expect(vi.mocked(request).mock.calls.every(([path]) => path === 'account/status')).toBe(true);
    } finally { await ui.close(); }
  });
});

describe('safe Google account diagnostic mapping', () => {
  it.each([
    ['client_secret_missing', 'app credential'], ['invalid_client', "app's sign-in settings"],
    ['invalid_grant', 'sign-in approval'], ['invalid_request', "app's sign-in request"],
    ['unauthorized_client', 'sign-in method'], ['redirect_uri_mismatch', 'return address'],
    ['invalid_scope', 'read-only permissions'], ['access_denied', 'not approved'],
    ['temporarily_unavailable', 'temporarily unavailable'], ['provider_request_failed', 'could not complete'],
    ['provider_response_invalid', 'could not be validated'], ['id_token_missing', 'identity confirmation'],
    ['id_token_signature_invalid', 'identity signature'], ['id_token_claims_invalid', 'account or time checks'],
    ['id_token_nonce_mismatch', 'does not match'], ['provider_keys_unavailable', 'verification keys'],
    ['encrypted_storage_write_failed', 'save the Google connection securely'], ['callback_expired', 'expired'],
    ['callback_invalid', 'did not match'], ['configuration_missing', 'app owner'],
  ])('maps the fixed %s detail to actionable authored copy', (errorDetail, message) => {
    const result = googleAccountFeedback({ status: 'error', errorCode: 'verification_failed', errorDetail });
    expect(result?.message).toContain(message);
    expect(result?.code).toBe(errorDetail);
  });

  it.each(['pending', 'restoring', 'signed_in', 'signed_out', 'setup_required'])('does not display stale diagnostics while %s', status => {
    expect(googleAccountFeedback({ status, errorCode: 'verification_failed', errorPhase: 'identity_verification', errorDetail: 'id_token_claims_invalid' })).toBeNull();
  });
});

describe('Google Analytics overview', () => {
  it('opens only local data, preserves original source labels, and requires a click before reading Google', async () => {
    vi.mocked(request).mockImplementation(async (path, input) => {
      if (path === 'account/status') return signedIn;
      if (path.startsWith('google/selection?')) return { brandId: 'project-a', ga4PropertyId: 'properties/123' };
      if (path === 'ga4/report') return { report: { ...report, summary: { ...metrics, sessions: 1700 } } };
      return { report };
    });
    const ui = await mount(<Ga4Panel brandId="project-a"/>);
    try {
      expect(vi.mocked(request).mock.calls.every(([, input]) => input === undefined)).toBe(true);
      expect(ui.document.body.textContent).toContain('1,600');
      expect(ui.document.body.textContent).toContain('organic');
      expect(ui.document.body.textContent).toContain('Original upstream evidence 原文');
      const count = vi.mocked(request).mock.calls.length;
      await act(async () => setUiLanguage('zh-CN'));
      expect(vi.mocked(request)).toHaveBeenCalledTimes(count);
      expect(ui.document.body.textContent).toContain('流量来源');
      expect(ui.document.body.textContent).toContain('Original GA4 原文');
      await ui.click('读取最近 28 天');
      expect(vi.mocked(request).mock.calls).toContainEqual(['ga4/report', { brandId: 'project-a', propertyId: 'properties/123' }]);
      expect(ui.document.body.textContent).toContain('1,700');
    } finally { await ui.close(); }
  });

  it('keeps missing totals and empty returned rows explicit instead of fabricating zeros', async () => {
    vi.mocked(request).mockImplementation(async path => path === 'account/status' ? signedIn : path.startsWith('google/selection?') ? { brandId: 'project-a', ga4PropertyId: 'properties/123' } : { report: { ...report, summary: null, daily: [], traffic: [] } });
    const ui = await mount(<Ga4Panel brandId="project-a"/>);
    try {
      expect(ui.document.body.textContent).toContain('A missing value is not a zero.');
      expect(ui.document.querySelector('.ga4-desk__metrics')).toBeNull();
      expect(ui.document.body.textContent).toContain('No daily rows were returned');
      expect(ui.document.body.textContent).toContain('No traffic-source rows were returned');
    } finally { await ui.close(); }
  });

  it('keeps a previous saved record visible after a new read fails', async () => {
    vi.mocked(request).mockImplementation(async path => {
      if (path === 'account/status') return signedIn;
      if (path.startsWith('google/selection?')) return { brandId: 'project-a', ga4PropertyId: 'properties/123' };
      if (path === 'ga4/report') throw new Error('private upstream detail is not rendered');
      return { report };
    });
    const ui = await mount(<Ga4Panel brandId="project-a"/>);
    try {
      await ui.click('Read the last 28 days');
      expect(ui.document.body.textContent).toContain('Google Analytics could not be read');
      expect(ui.document.body.textContent).toContain('1,600');
      expect(ui.document.body.textContent).not.toContain('private upstream detail');
    } finally { await ui.close(); }
  });

  it('routes a project without an analytics property to Settings and never starts a Google read', async () => {
    vi.mocked(request).mockImplementation(async path => path === 'account/status' ? signedIn : path.startsWith('google/selection?') ? { brandId: 'project-a' } : { report: null });
    const onConnections = vi.fn(), ui = await mount(<Ga4Panel brandId="project-a" onConnections={onConnections}/>);
    try {
      expect(ui.document.querySelector('.ga4-desk__read')?.hasAttribute('disabled')).toBe(true);
      await ui.click('Settings'); expect(onConnections).toHaveBeenCalledOnce();
      expect(vi.mocked(request).mock.calls.every(([, input]) => input === undefined)).toBe(true);
    } finally { await ui.close(); }
  });

  it('clears visible analytics on sign-out and discards a previous account read that finishes late', async () => {
    let finish!: (value: { report: Ga4Report }) => void;
    let account: unknown = signedIn;
    vi.mocked(request).mockImplementation(async path => {
      if (path === 'account/status') return account;
      if (path.startsWith('google/selection?')) return { brandId: 'project-a', ga4PropertyId: 'properties/123' };
      if (path === 'ga4/report') return new Promise<{ report: Ga4Report }>(resolve => { finish = resolve; });
      return { report };
    });
    const ui = await mount(<Ga4Panel brandId="project-a"/>);
    try {
      expect(ui.document.body.textContent).toContain('Original GA4 原文');
      await ui.click('Read the last 28 days');
      account = { status: 'signed_out', configured: true };
      await act(async () => refreshAccountStatus());
      expect(ui.document.body.textContent).not.toContain('Original GA4 原文');
      await act(async () => finish({ report }));
      expect(ui.document.body.textContent).not.toContain('Original GA4 原文');
      expect(ui.document.querySelector('.ga4-desk__read')?.hasAttribute('disabled')).toBe(true);
    } finally { await ui.close(); }
  });

  it.each([
    ['signed out', { status: 'signed_out', configured: true }],
    ['locked', { status: 'error', configured: false, errorCode: 'storage_unavailable', connectionsAccess: { status: 'locked' } }],
    ['restoring', { status: 'restoring', configured: false, connectionsAccess: { status: 'loading' } }],
    ['missing permission', { ...signedIn, capabilities: { gsc: true, ga4: false } }],
  ])('shows the connection invitation without an error or saved/live reads when %s on mount', async (_name, account) => {
    vi.mocked(request).mockResolvedValue(account);
    const ui = await mount(<Ga4Panel brandId="project-a" onConnections={vi.fn()}/>);
    try {
      expect(ui.document.querySelector('[role="alert"]')).toBeNull();
      expect(ui.document.body.textContent).toContain('Pick a Google Analytics property in Settings');
      expect(ui.document.querySelector('.ga4-desk__read')?.hasAttribute('disabled')).toBe(true);
      expect(vi.mocked(request).mock.calls).toEqual([['account/status']]);
    } finally { await ui.close(); }
  });

  it('reports a failed account-status request without opening saved or live analytics', async () => {
    vi.mocked(request).mockRejectedValue(new Error('private connection diagnostic'));
    const ui = await mount(<Ga4Panel brandId="project-a"/>);
    try {
      expect(ui.document.querySelector('[role="alert"]')?.textContent).toContain('Saved Google Analytics data could not be opened');
      expect(ui.document.body.textContent).not.toContain('private connection diagnostic');
      expect(vi.mocked(request).mock.calls).toEqual([['account/status']]);
    } finally { await ui.close(); }
  });

  it('discards an earlier account-status result after sign-out instead of opening the previous account records', async () => {
    let finish!: (value: unknown) => void, first = true;
    vi.mocked(request).mockImplementation(async () => {
      if (first) { first = false; return new Promise(resolve => { finish = resolve; }); }
      return { status: 'signed_out', configured: true };
    });
    const ui = await mount(<Ga4Panel brandId="project-a"/>);
    try {
      await act(async () => refreshAccountStatus());
      await act(async () => finish(signedIn));
      expect(vi.mocked(request).mock.calls).toEqual([['account/status'], ['account/status']]);
      expect(ui.document.querySelector('[role="alert"]')).toBeNull();
      expect(ui.document.querySelector('.ga4-desk__metrics')).toBeNull();
    } finally { await ui.close(); }
  });
});
