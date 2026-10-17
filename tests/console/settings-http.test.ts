import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectLedger } from '../../src/db/index.ts';
import { LabService } from '../../src/console/service.ts';
import { serveConsole } from '../../src/console/server.ts';
import { connectionFields } from '../../src/console/settings.ts';

type App = Awaited<ReturnType<typeof serveConsole>>;
let savedEnv: Record<string, string | undefined>;
const fixtures: { app: App; service: LabService; dir: string }[] = [];
beforeEach(() => {
  savedEnv = Object.fromEntries(connectionFields.map(({ key }) => [key, process.env[key]]));
  for (const { key } of connectionFields) delete process.env[key];
});
afterEach(async () => {
  for (const { app, service, dir } of fixtures.splice(0)) {
    await app.keywordAudit.stop(); await app.browserJobs.pauseAll();
    app.server.closeAllConnections(); await new Promise<void>(done => app.server.close(() => done()));
    service.db.close(); rmSync(dir, { recursive: true, force: true });
  }
  for (const { key } of connectionFields) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function app(options: Parameters<typeof serveConsole>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'settings-http-'));
  const service = new LabService(connectLedger(join(dir, 'ledger.db')));
  const runtime = await serveConsole(service, options);
  fixtures.push({ app: runtime, service, dir });
  return runtime;
}
function post(runtime: App, path: string, input: unknown = {}, headers: Record<string, string> = {}) {
  return fetch(runtime.origin + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + runtime.token, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ requestId: randomUUID(), input }),
  });
}

describe('connection unlock HTTP boundary', () => {
  it('exposes only access status/message and rejects writes while loading or locked', async () => {
    let status: 'loading' | 'ready' | 'locked' = 'loading';
    const persist = vi.fn(async () => {});
    const runtime = await app({ persistSettings: persist, connectionAccess: () => ({ status, message: 'Loading connections', secret: 'must not appear' }) });
    const state = await (await fetch(runtime.origin + '/api/state', { headers: { Authorization: 'Bearer ' + runtime.token } })).json();
    expect(state.settings.access).toEqual({ status: 'loading', message: 'Loading connections' });
    expect(JSON.stringify(state)).not.toContain('must not appear');
    for (const next of ['loading', 'locked'] as const) {
      status = next;
      for (const path of ['/api/settings', '/api/gsc/import', '/api/gsc/mcp-access', '/api/gsc/mcp-revoke']) {
        const response = await post(runtime, path, { OPENAI_API_KEY: 'new-key' });
        expect(response.status).toBe(409);
        expect((await response.json()).error).toContain(next === 'loading' ? '加载' : '解锁');
      }
    }
    expect(persist).not.toHaveBeenCalled();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.GSC_MCP_KEY).toBeUndefined();
    status = 'ready';
    expect((await post(runtime, '/api/settings', { OPENAI_API_KEY: 'new-key' })).status).toBe(200);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(process.env.OPENAI_API_KEY).toBe('new-key');
  });

  it('requires local authentication and origin for unlock, awaits it, and keeps failures locked', async () => {
    let status: 'loading' | 'ready' | 'locked' = 'locked';
    let resolve!: () => void;
    const gate = new Promise<void>(done => { resolve = done; });
    let entered!: () => void;
    const began = new Promise<void>(done => { entered = done; });
    const unlock = vi.fn(async () => { status = 'loading'; entered(); await gate; status = 'ready'; });
    const runtime = await app({ connectionAccess: () => ({ status }), unlockConnections: unlock });
    expect((await post(runtime, '/api/connections/unlock', {}, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(runtime, '/api/connections/unlock', {}, { Origin: 'https://foreign.example' })).status).toBe(403);
    expect(unlock).not.toHaveBeenCalled();
    let resolved = false;
    const request = post(runtime, '/api/connections/unlock').then(response => { resolved = true; return response; });
    await began;
    expect(status).toBe('loading');
    expect(resolved).toBe(false);
    resolve();
    const response = await request;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, access: { status: 'ready' } });
    unlock.mockImplementationOnce(async () => { status = 'locked'; throw new Error('Connection unlock cancelled'); });
    expect((await post(runtime, '/api/connections/unlock')).status).toBe(400);
    expect(status).toBe('locked');
  });

  it('does not invoke native unlock from demo mode', async () => {
    const unlock = vi.fn(async () => {});
    const runtime = await app({ demo: true, unlockConnections: unlock });
    const response = await post(runtime, '/api/connections/unlock');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('演示模式');
    expect(unlock).not.toHaveBeenCalled();
  });

  it('awaits encrypted persistence in settings/MCP endpoints and issues one key for concurrent creation', async () => {
    const values: Record<string, string>[] = [];
    const persist = vi.fn(async (next: Record<string, string>) => { await Promise.resolve(); values.push({ ...next }); });
    const runtime = await app({ persistSettings: persist });
    const first = await post(runtime, '/api/settings', { OPENAI_API_KEY: 'stored-key' });
    expect(await first.json()).toEqual({ ok: true });
    expect(values).toEqual([{ OPENAI_API_KEY: 'stored-key' }]);
    expect(process.env.OPENAI_API_KEY).toBe('stored-key');
    const keys = await Promise.all([post(runtime, '/api/gsc/mcp-access'), post(runtime, '/api/gsc/mcp-access')]);
    const responses = await Promise.all(keys.map(response => response.json()));
    expect(responses[0].key).toBe(responses[1].key);
    expect(responses[0].key).toBe(process.env.GSC_MCP_KEY);
    expect(persist).toHaveBeenCalledTimes(2);
    persist.mockRejectedValueOnce(new Error('Encrypted save unavailable'));
    const failed = await post(runtime, '/api/gsc/mcp-revoke');
    expect(failed.status).toBe(400);
    expect(process.env.GSC_MCP_KEY).toBe(responses[0].key);
    expect((await post(runtime, '/api/gsc/mcp-revoke')).status).toBe(200);
    expect(process.env.GSC_MCP_KEY).toBeUndefined();
  });
});
