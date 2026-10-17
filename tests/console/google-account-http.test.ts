import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectLedger } from '../../src/db/index.ts';
import { LabService } from '../../src/console/service.ts';
import { serveConsole } from '../../src/console/server.ts';
import type { GoogleAccountStatus } from '../../src/console/google-account.ts';

const runtimes: { runtime: Awaited<ReturnType<typeof serveConsole>>; lab: LabService }[] = [];
const privateKeys = ['GETGEO_GOOGLE_CLIENT_ID', 'GETGEO_GOOGLE_CLIENT_SECRET', 'GETGEO_GOOGLE_ACCOUNT_SESSION'];
const original = Object.fromEntries(privateKeys.map(key => [key, process.env[key]]));
afterEach(async () => {
  for (const { runtime, lab } of runtimes.splice(0)) {
    await runtime.browserJobs.pauseAll(); await runtime.keywordAudit.stop(); await runtime.gscSync.stop();
    runtime.server.closeAllConnections(); await new Promise<void>(done => runtime.server.close(() => done())); lab.db.close();
  }
  for (const key of privateKeys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
});
const googleUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic.apps.googleusercontent.com&state=synthetic-state';
async function fixture(options: { provider?: boolean; access?: 'ready' | 'loading' | 'locked'; opener?: boolean; demo?: boolean } = {}) {
  let status: GoogleAccountStatus = { configured: true, status: 'signed_in', profile: { subject: 'synthetic-user-id', name: 'Reader Example', email: 'reader@example.test' }, expiresAt: '2026-10-16T22:00:00.000Z' };
  const provider = {
    status: vi.fn(() => status), ensureFresh: vi.fn(async () => status), restore: vi.fn(async () => status),
    start: vi.fn(async () => ({ url: googleUrl, expiresAt: '2026-10-16T21:00:00.000Z' })),
    startGsc: vi.fn(async () => ({ url: googleUrl + '&scope=webmasters.readonly', expiresAt: '2026-10-16T21:00:00.000Z' })),
    signOut: vi.fn(async () => { status = { configured: true, status: 'signed_out' }; }), dispose: vi.fn(() => {}),
  };
  const opener = vi.fn(async (_url: string) => {}), lab = new LabService(connectLedger(':memory:'));
  const runtime = await serveConsole(lab, { autoGsc: false, ...(options.provider === false ? {} : { accountProvider: provider }), ...(options.opener === false ? {} : { openExternal: opener }), ...(options.access ? { connectionAccess: () => ({ status: options.access! }) } : {}), ...(options.demo ? { demo: true } : {}) });
  runtimes.push({ runtime, lab });
  const headers = { Authorization: 'Bearer ' + runtime.token };
  const get = (path: string, extra?: Record<string, string>) => fetch(runtime.origin + path, { headers: { ...headers, ...extra } });
  const post = (path: string, input: unknown = {}, extra?: Record<string, string>) => fetch(runtime.origin + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ requestId: randomUUID(), input }) });
  return { runtime, lab, provider, opener, headers, get, post };
}

describe('Google account HTTP boundary', () => {
  it('requires local authorization, rejects foreign origins and exposes verified identity without stored tokens', async () => {
    process.env.GETGEO_GOOGLE_ACCOUNT_SESSION = 'synthetic-private-session-not-for-http';
    process.env.GETGEO_GOOGLE_CLIENT_SECRET = 'synthetic-private-client-secret';
    const f = await fixture();
    expect((await fetch(f.runtime.origin + '/api/account/status')).status).toBe(401);
    expect((await f.get('/api/account/status', { Origin: 'https://foreign.example.com' })).status).toBe(403);
    const response = await f.get('/api/account/status'); expect(response.status).toBe(200);
    const value = await response.json(); expect(value).toMatchObject({ status: 'signed_in', profile: { name: 'Reader Example' } });
    expect(JSON.stringify(value)).not.toContain('synthetic-private');
    expect(value.idToken).toBeUndefined(); expect(value.refreshToken).toBeUndefined(); expect(value.session).toBeUndefined();
    expect(f.provider.start).not.toHaveBeenCalled(); expect(f.provider.startGsc).not.toHaveBeenCalled(); expect(f.opener).not.toHaveBeenCalled();
  });
  it('starts and opens Google only through an explicit authenticated POST', async () => {
    const f = await fixture();
    expect((await f.get('/api/account/google-start')).status).toBe(404);
    await f.get('/api/account/status'); expect(f.provider.start).not.toHaveBeenCalled();
    const response = await f.post('/api/account/google-start'); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: googleUrl, expiresAt: '2026-10-16T21:00:00.000Z', opened: true });
    expect(f.provider.start).toHaveBeenCalledTimes(1); expect(f.provider.startGsc).not.toHaveBeenCalled(); expect(f.opener).toHaveBeenCalledWith(googleUrl);
  });
  it('routes Search Console consent through its separate explicit action', async () => {
    const f = await fixture(); const response = await f.post('/api/account/gsc-start');
    expect(response.status).toBe(200); expect(f.provider.startGsc).toHaveBeenCalledTimes(1); expect(f.provider.start).not.toHaveBeenCalled();
    expect(f.opener).toHaveBeenCalledWith(googleUrl + '&scope=webmasters.readonly');
  });
  it.each(['http://accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com.evil.example/o/oauth2/v2/auth', 'https://user:pass@accounts.google.com/o/oauth2/v2/auth', 'https://accounts.google.com:8443/o/oauth2/v2/auth', 'https://accounts.google.com/unexpected', 'file:///tmp/sign-in.html'])('rejects an unapproved browser destination before opening %s', async url => {
    const f = await fixture(); f.provider.start.mockResolvedValue({ url, expiresAt: '2026-10-16T21:00:00.000Z' });
    const response = await f.post('/api/account/google-start'); expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Invalid Google sign-in destination'); expect(f.opener).not.toHaveBeenCalled();
  });
  it('returns an explicit fallback link when no desktop opener is available', async () => {
    const f = await fixture({ opener: false });
    expect(await (await f.post('/api/account/google-start')).json()).toMatchObject({ opened: false, url: googleUrl });
    expect(f.opener).not.toHaveBeenCalled();
  });
  it('returns the same safe fallback if the native browser opener fails', async () => {
    const f = await fixture(); f.opener.mockRejectedValue(new Error('private system details'));
    const response = await f.post('/api/account/google-start'); const value = await response.json();
    expect(response.status).toBe(200); expect(value).toMatchObject({ opened: false, url: googleUrl }); expect(JSON.stringify(value)).not.toContain('private system details');
  });
  it('signs out explicitly without opening Google or starting another authorization', async () => {
    const f = await fixture(); expect((await f.post('/api/account/sign-out')).status).toBe(200);
    expect(f.provider.signOut).toHaveBeenCalledTimes(1); expect(await (await f.get('/api/account/status')).json()).toMatchObject({ status: 'signed_out' });
    expect(f.provider.start).not.toHaveBeenCalled(); expect(f.provider.startGsc).not.toHaveBeenCalled(); expect(f.opener).not.toHaveBeenCalled();
  });
  it.each(['loading', 'locked'] as const)('does not read identity or start consent while encrypted storage is %s', async access => {
    const f = await fixture({ access }); const value = await (await f.get('/api/account/status')).json();
    expect(value).toMatchObject(access === 'loading' ? { status: 'restoring' } : { status: 'error', errorCode: 'storage_unavailable' });
    expect(value.profile).toBeUndefined(); expect(f.provider.ensureFresh).not.toHaveBeenCalled();
    expect((await f.post('/api/account/google-start')).status).toBe(409); expect((await f.post('/api/account/gsc-start')).status).toBe(409);
    expect(f.provider.start).not.toHaveBeenCalled(); expect(f.provider.startGsc).not.toHaveBeenCalled(); expect(f.opener).not.toHaveBeenCalled();
  });
  it('requires encrypted desktop persistence before creating a real identity or GSC consent listener', async () => {
    process.env.GETGEO_GOOGLE_CLIENT_ID = '123456789-synthetic.apps.googleusercontent.com';
    delete process.env.GETGEO_GOOGLE_ACCOUNT_SESSION;
    const f = await fixture({ provider: false });
    for (const path of ['/api/account/google-start', '/api/account/gsc-start']) {
      const response = await f.post(path); expect(response.status).toBe(400); expect((await response.json()).error).toContain('encrypted desktop storage');
    }
    expect(f.runtime.account.status().status).toBe('signed_out'); expect(f.opener).not.toHaveBeenCalled();
  });
  it('hides the internal session from settings discovery and rejects form attempts to edit it', async () => {
    process.env.GETGEO_GOOGLE_ACCOUNT_SESSION = 'synthetic-private-session-not-for-http';
    const f = await fixture(); const state = await (await f.get('/api/state')).json();
    expect(state.settings.fields.some((field: { key: string }) => field.key === 'GETGEO_GOOGLE_ACCOUNT_SESSION')).toBe(false);
    expect(JSON.stringify(state)).not.toContain('synthetic-private-session-not-for-http');
    const rejected = await f.post('/api/settings', { GETGEO_GOOGLE_ACCOUNT_SESSION: 'user-edited-session' });
    expect(rejected.status).toBe(400); expect(process.env.GETGEO_GOOGLE_ACCOUNT_SESSION).toBe('synthetic-private-session-not-for-http');
  });
});
