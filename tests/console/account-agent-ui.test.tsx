import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { AccountChip, googleAuthLink, refreshAccountStatus, type AccountStatus } from '../../apps/console/account-chip.tsx';
import { AgentPanel, type AgentContext } from '../../apps/console/agent-panel.tsx';
import { request } from '../../apps/console/api.ts';
import { setUiLanguage, t } from '../../apps/console/i18n.tsx';

vi.mock('../../apps/console/api.ts', () => ({ request: vi.fn() }));
beforeEach(() => setUiLanguage('en'));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.mocked(request).mockReset(); setUiLanguage('en'); });

async function mount(component: React.ReactNode) {
  const { window, document } = parseHTML('<html><head></head><body><main id="root"></main></body></html>');
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }, clipboard = { writeText: vi.fn(async (_text: string) => {}) };
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('localStorage', storage);
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.stubGlobal('navigator', { clipboard }); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.getElementById('root')! as unknown as HTMLElement);
  await act(async () => root.render(component));
  return { window, document, root, storage, clipboard,
    async click(text: string) { const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes(text)); expect(button, text).toBeTruthy(); await act(async () => button!.dispatchEvent(new window.Event('click', { bubbles: true }))); },
    async close() { await act(async () => root.unmount()); },
  };
}

describe('Google account indicator', () => {
  it('re-reads completed login and configuration changes on focus and the authored refresh event without starting OAuth', async () => {
    let status: AccountStatus = { status: 'setup_required', configured: false };
    vi.mocked(request).mockImplementation(async () => status);
    const ui = await mount(<AccountChip onConnections={vi.fn()}/>);
    try {
      status = { status: 'signed_out', configured: true };
      await act(async () => refreshAccountStatus());
      expect(vi.mocked(request)).toHaveBeenCalledTimes(2);
      status = { status: 'signed_in', configured: true, profile: { subject: 'verified', name: 'Jordan', email: 'jordan@example.test' } };
      await act(async () => ui.window.dispatchEvent(new ui.window.Event('focus')));
      expect(ui.document.body.textContent).toContain('Welcome, Jordan');
      expect(vi.mocked(request).mock.calls.every(([path]) => path === 'account/status')).toBe(true);
    } finally { await ui.close(); }
    const count = vi.mocked(request).mock.calls.length;
    await act(async () => refreshAccountStatus());
    expect(vi.mocked(request)).toHaveBeenCalledTimes(count);
  });

  it('shows Welcome only for a verified signed-in profile and clears it after sign-out', async () => {
    let signedIn = true;
    vi.mocked(request).mockImplementation(async path => { if (path === 'account/sign-out') { signedIn = false; return {}; } return signedIn ? { status: 'signed_in', configured: true, profile: { subject: 'verified-subject', name: 'Casey', email: 'casey@example.test' } } : { status: 'signed_out', configured: true }; });
    const ui = await mount(<AccountChip onConnections={vi.fn()}/>);
    try {
      expect(ui.document.body.textContent).toContain('Welcome, Casey');
      await ui.click('Sign out');
      expect(ui.document.body.textContent).not.toContain('Welcome, Casey');
      expect(ui.document.body.textContent).toContain('Continue with Google');
      expect(vi.mocked(request).mock.calls).toContainEqual(['account/sign-out', {}]);
    } finally { await ui.close(); }
  });

  it('routes setup-required users to configuration without starting OAuth', async () => {
    vi.mocked(request).mockResolvedValue({ status: 'setup_required', configured: false });
    const connections = vi.fn(), ui = await mount(<AccountChip onConnections={connections}/>);
    try { await ui.click('Continue with Google'); expect(connections).toHaveBeenCalledOnce(); expect(vi.mocked(request).mock.calls).toEqual([['account/status']]); }
    finally { await ui.close(); }
  });

  it('starts only on an explicit click and shows the safe browser fallback until login is verified', async () => {
    vi.useFakeTimers();
    let status: AccountStatus = { status: 'signed_out', configured: true };
    vi.mocked(request).mockImplementation(async path => {
      if (path === 'account/data-start') { status = { status: 'pending', configured: true }; return { opened: false, url: 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-only', expiresAt: '2026-10-16T15:00:00Z' }; }
      return status;
    });
    const ui = await mount(<AccountChip onConnections={vi.fn()}/>);
    try {
      expect(vi.mocked(request).mock.calls).toEqual([['account/status']]);
      await ui.click('Continue with Google');
      expect(ui.document.querySelector('a')!.getAttribute('href')).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(ui.document.body.textContent).not.toContain('Welcome,');
      status = { status: 'signed_in', configured: true, profile: { subject: 'verified', name: 'Lee', email: 'lee@example.test' } };
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(ui.document.body.textContent).toContain('Welcome, Lee');
      expect(ui.document.querySelector('a')).toBeNull();
    } finally { await ui.close(); }
  });

  it('stops automatic checks after two minutes and skips hidden windows', async () => {
    vi.useFakeTimers(); vi.mocked(request).mockResolvedValue({ status: 'pending', configured: true });
    const ui = await mount(<AccountChip onConnections={vi.fn()}/>);
    try {
      Object.defineProperty(ui.document, 'hidden', { configurable: true, value: true });
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(vi.mocked(request)).toHaveBeenCalledTimes(1);
      Object.defineProperty(ui.document, 'hidden', { configurable: true, value: false });
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      const count = vi.mocked(request).mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(vi.mocked(request)).toHaveBeenCalledTimes(count);
      await ui.click('Check sign-in');
      expect(vi.mocked(request)).toHaveBeenCalledTimes(count + 1);
    } finally { await ui.close(); }
  });

  it('never renders a supplied profile while storage or verification is incomplete', async () => {
    vi.mocked(request).mockResolvedValue({ status: 'restoring', configured: false, connectionsAccess: { status: 'loading' }, profile: { name: 'Unverified user' } });
    const ui = await mount(<AccountChip onConnections={vi.fn()}/>);
    try { expect(ui.document.body.textContent).not.toContain('Unverified user'); expect(ui.document.querySelector('button')!.hasAttribute('disabled')).toBe(true); }
    finally { await ui.close(); }
  });

  it('leaves a restoring account manually refreshable after the finite polling deadline', async () => {
    vi.useFakeTimers(); vi.mocked(request).mockResolvedValue({ status: 'restoring', configured: false, connectionsAccess: { status: 'loading' } });
    const ui = await mount(<AccountChip onConnections={vi.fn()}/>);
    try {
      expect(ui.document.querySelector('button')!.hasAttribute('disabled')).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(ui.document.querySelector('button')!.hasAttribute('disabled')).toBe(false);
      const before = vi.mocked(request).mock.calls.length;
      await ui.click('Check sign-in');
      expect(vi.mocked(request)).toHaveBeenCalledTimes(before + 1);
    } finally { await ui.close(); }
  });

  it('accepts only the expected Google OAuth URL for explicit fallback navigation', () => {
    expect(googleAuthLink('https://accounts.google.com/o/oauth2/v2/auth?state=test')).toContain('accounts.google.com');
    for (const url of ['javascript:alert(1)', 'https://accounts.google.com.evil.test/o/oauth2/v2/auth', 'https://accounts.google.com/unrelated', 'https://user:password@accounts.google.com/o/oauth2/v2/auth']) expect(googleAuthLink(url)).toBeNull();
  });
});

const brands = [{ id: 'project-a', name: 'Original brand 原文' }, { id: 'project-b', name: 'Second project' }];
const access = { url: 'http://127.0.0.1:41234/mcp', keys: [{ id: 'saved-key', label: 'My existing agent', brandIds: ['project-a'], canSaveAnalysis: false, createdAt: '2026-10-16T12:00:00Z', lastUsedAt: null, revokedAt: null, tokenHint: 'getgeo_…tail' }] };
const context = (brandId = 'project-a'): AgentContext => ({ project: { id: brandId, name: 'Original brand 原文' }, generatedAt: '2026-10-16T12:00:00Z', seo: { evidence: { snapshotId: 'source-id', hash: 'original-evidence-hash', property: 'sc-domain:example.test', country: 'CAN', device: 'ALL', startDate: '2026-07-01', endDate: '2026-10-01' }, summary: { opportunity: 1, stagnant: 2, declining: 0, improving: 1 }, opportunities: { target: 5, qualifying: 1, shortfall: 4, rows: [{ keyword: 'restaurant shift planner 原文', ownerUrl: 'https://example.test/shift', current: { position: 15.3, clicks: 2, impressions: 100 } }] }, limitations: [] }, geo: null, evidenceSelection: { availableGeoPlans: 2 }, actions: [{ priority: 'high', kind: 'stagnant', keyword: 'restaurant shift planner 原文', targetUrl: 'https://example.test/shift', action: 'Authored backend English action', acceptance: 'Authored backend acceptance', measurement: 'Authored backend measurement', evidence: { snapshotId: 'source-id', hash: 'original-evidence-hash' } }], unknowns: ['No competitor audit was selected. Current top-three competitor approaches and specific content gaps are unverified.'], limitations: [] });
function mockAgentReads(extra?: (path: string, input: unknown) => unknown) {
  vi.mocked(request).mockImplementation(async (path, input) => {
    if (path === 'agent/keys') return access;
    if (path.startsWith('agent/context?')) return context(new URLSearchParams(path.split('?')[1]).get('brandId')!);
    if (path.startsWith('agent/analyses?')) return { rows: [] };
    return extra?.(path, input) ?? {};
  });
}
describe('project-scoped Agent desk', () => {
  it('creates a project key with explicit scope, copies settings only on request, and clears the one-time secret on project change', async () => {
    mockAgentReads(path => path === 'agent/key-create' ? { id: 'new-key', key: 'synthetic-once-only-key', shownOnce: true, brandIds: ['project-a'] } : {});
    const ui = await mount(<AgentPanel brands={brands} onGsc={vi.fn()} onConnections={vi.fn()}/>);
    // Linkedom does not implement React's browser text-input change events.
    // Invoke the field's authored handler, then exercise the real button events.
    async function change(element: Element, target: object) {
      const property = Object.keys(element).find(key => key.startsWith('__reactProps$'))!;
      await act(async () => (element as unknown as Record<string, { onChange: (event: { target: object }) => void }>)[property].onChange({ target }));
    }
    try {
      await change(ui.document.querySelector('input[placeholder="For example: My Codex"]')!, { value: 'My Codex' });
      await ui.click('Create project key');
      expect(vi.mocked(request).mock.calls).toContainEqual(['agent/key-create', { label: 'My Codex', brandIds: ['project-a'], canSaveAnalysis: false }]);
      expect((ui.document.querySelector('input[type="password"]') as unknown as HTMLInputElement).value).toBe('synthetic-once-only-key');
      expect(ui.clipboard.writeText).not.toHaveBeenCalled();
      expect(ui.storage.setItem).not.toHaveBeenCalled();
      await ui.click('Copy MCP settings');
      expect(JSON.parse(ui.clipboard.writeText.mock.calls[0][0])).toEqual({ mcpServers: { getaudit: { url: access.url, headers: { Authorization: 'Bearer synthetic-once-only-key' } } } });
      await change(ui.document.querySelector('select')!, { value: 'project-b' });
      expect(ui.document.querySelector('input[type="password"]')).toBeNull();
      expect(ui.document.body.textContent).not.toContain('My existing agent');
    } finally { await ui.close(); }
  });

  it('permits analysis write-back only when the user selects the checkbox before creating the key', async () => {
    mockAgentReads(path => path === 'agent/key-create' ? { id: 'new-key', key: null, shownOnce: false, brandIds: ['project-a'] } : {});
    const ui = await mount(<AgentPanel brands={brands} onGsc={vi.fn()} onConnections={vi.fn()}/>);
    async function change(element: Element, target: object) { const property = Object.keys(element).find(key => key.startsWith('__reactProps$'))!; await act(async () => (element as unknown as Record<string, { onChange: (event: { target: object }) => void }>)[property].onChange({ target })); }
    try {
      await change(ui.document.querySelector('input[placeholder="For example: My Codex"]')!, { value: 'Save findings agent' });
      await change(ui.document.querySelector('input[type="checkbox"]')!, { checked: true });
      await ui.click('Create project key');
      expect(vi.mocked(request).mock.calls).toContainEqual(['agent/key-create', { label: 'Save findings agent', brandIds: ['project-a'], canSaveAnalysis: true }]);
      expect(ui.document.querySelector('input[type="password"]')).toBeNull();
      expect(ui.document.body.textContent).toContain('This key was not returned again');
    } finally { await ui.close(); }
  });

  it('shows saved keyword opportunities, shortfalls and localized next actions while preserving original evidence', async () => {
    mockAgentReads(); const ui = await mount(<AgentPanel brands={brands} onGsc={vi.fn()} onConnections={vi.fn()}/>);
    try {
      expect(ui.document.body.textContent).toContain('1 of 5 qualifying keywords');
      expect(ui.document.body.textContent).toContain('restaurant shift planner 原文');
      expect(ui.document.body.textContent).toContain('15.3');
      expect(ui.document.body.textContent).toContain('original-evidence-hash');
      expect(vi.mocked(request).mock.calls.every(([,input]) => input === undefined)).toBe(true);
      await act(async () => setUiLanguage('zh-CN'));
      expect(ui.document.body.textContent).toContain('平均排名');
      expect(ui.document.body.textContent).toContain('结合查询意图和已保存的竞品证据');
      expect(ui.document.body.textContent).not.toContain('Authored backend English action');
      expect(ui.document.body.textContent).toContain('restaurant shift planner 原文');
      expect(ui.document.body.textContent).toContain('尚未选择竞品审计');
      expect(vi.mocked(request).mock.calls).toHaveLength(3);
    } finally { await ui.close(); }
  });

  it('opens the unified Google connection panel from saved SEO evidence without starting a separate authorization', async () => {
    mockAgentReads(); const connections = vi.fn();
    const ui = await mount(<AgentPanel brands={brands} onGsc={vi.fn()} onConnections={connections}/>);
    try {
      expect(connections).not.toHaveBeenCalled();
      await ui.click(t('agent.reconnectGsc'));
      expect(connections).toHaveBeenCalledOnce();
      expect(vi.mocked(request).mock.calls.map(([path]) => path)).toEqual(['agent/keys','agent/context?brandId=project-a','agent/analyses?brandId=project-a']);
      expect(ui.document.querySelector('.agent-gsc-connect a')).toBeNull();
    } finally { await ui.close(); }
  });

  it('keeps Google connection navigation available without saved SEO or an Agent-side OAuth setup check', async () => {
    mockAgentReads(); const original = vi.mocked(request).getMockImplementation()!;
    vi.mocked(request).mockImplementation(async (path,input) => path.startsWith('agent/context?') ? {...context(),seo:null} : path === 'account/status' ? { status: 'setup_required', configured: false } : original(path,input));
    const connections = vi.fn(), ui = await mount(<AgentPanel brands={brands} onGsc={vi.fn()} onConnections={connections}/>);
    try {
      const connect = ui.document.querySelector('.agent-gsc-connect button')!;
      expect(connect.hasAttribute('disabled')).toBe(false);
      await act(async () => setUiLanguage('zh-CN'));
      await ui.click(t('agent.connectGsc'));
      expect(connections).toHaveBeenCalledOnce();
      expect(vi.mocked(request).mock.calls.some(([path]) => path.startsWith('account/'))).toBe(false);
    } finally { await ui.close(); }
  });

  it('defaults save-back permission off and revokes a key only on an explicit action', async () => {
    mockAgentReads(); const ui = await mount(<AgentPanel brands={brands} onGsc={vi.fn()} onConnections={vi.fn()}/>);
    try {
      expect((ui.document.querySelector('input[type="checkbox"]') as unknown as HTMLInputElement).checked).toBe(false);
      expect(ui.document.body.textContent).toContain('Read evidence only');
      await ui.click('Revoke key');
      expect(vi.mocked(request).mock.calls).toContainEqual(['agent/key-revoke', { id: 'saved-key' }]);
    } finally { await ui.close(); }
  });

  it('keeps saved Agent analysis original across language changes and shows its source references', async () => {
    mockAgentReads(); const original = vi.mocked(request).getMockImplementation()!;
    vi.mocked(request).mockImplementation(async (path,input) => path.startsWith('agent/analyses?') ? { rows: [{ id: 'analysis-id', brandId: 'project-a', title: 'Agent original title 原文', summary: 'Keep my analysis unchanged 原文', actions: [{ priority: 'high', targetUrl: 'https://example.test/shift', action: 'Original recommendation 原文', reason: 'Original reason', acceptance: 'Original acceptance', measurement: 'Original measurement' }], gaps: ['Original gap'], sourceRefs: [{ kind: 'gsc_snapshot', id: 'source-id', hash: 'original-evidence-hash' }], createdAt: '2026-10-16T12:00:00Z', contentHash: 'agent-content-hash', model: 'agent-declared-model' }] } : original(path,input));
    const ui = await mount(<AgentPanel brands={brands} onGsc={vi.fn()} onConnections={vi.fn()}/>);
    try {
      await act(async () => setUiLanguage('zh-CN'));
      expect(ui.document.body.textContent).toContain('Agent 保存的分析');
      expect(ui.document.body.textContent).toContain('Keep my analysis unchanged 原文');
      expect(ui.document.body.textContent).toContain('Original recommendation 原文');
      expect(ui.document.body.textContent).toContain('agent-content-hash');
      expect(ui.document.body.textContent).toContain('original-evidence-hash');
    } finally { await ui.close(); }
  });
});
