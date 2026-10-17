import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectLedger } from '../../src/db/index.ts';
import { LabService } from '../../src/console/service.ts';
import { GscConnector } from '../../src/console/gsc.ts';
import { connectionFields } from '../../src/console/settings.ts';

let savedEnv: Record<string, string | undefined>;
const fixtures: { service: LabService; dir: string }[] = [];
beforeEach(() => {
  savedEnv = Object.fromEntries(connectionFields.map(({ key }) => [key, process.env[key]]));
  for (const { key } of connectionFields) delete process.env[key];
});
afterEach(() => {
  for (const { service, dir } of fixtures.splice(0)) { service.db.close(); rmSync(dir, { recursive: true, force: true }); }
  for (const { key } of connectionFields) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});
function connector() {
  const dir = mkdtempSync(join(tmpdir(), 'gsc-settings-'));
  const service = new LabService(connectLedger(join(dir, 'ledger.db')));
  fixtures.push({ service, dir });
  return new GscConnector(service, (async (url: unknown) => String(url).endsWith('/token')
    ? Response.json({ access_token: 'fixture-token', scope: 'https://www.googleapis.com/auth/webmasters.readonly' })
    : Response.json({ siteEntry: [{ siteUrl: 'sc-domain:sample-agency.example', permissionLevel: 'siteOwner' }] })) as typeof fetch);
}

describe('GSC public-source grant isolation', () => {
  it('does not discover or persist another application grant', async () => {
    const persist = vi.fn(async (_values: Record<string,string>) => {});
    await expect(connector().importExisting(persist)).rejects.toThrow('Local grant discovery is disabled');
    expect(persist).not.toHaveBeenCalled();
    expect(process.env.GSC_REFRESH_TOKEN).toBeUndefined();
  });
  it('preserves explicit credentials when local discovery is rejected', async () => {
    process.env.GSC_CLIENT_ID = 'synthetic-old-client';
    process.env.GSC_REFRESH_TOKEN = 'synthetic-old-refresh';
    await expect(connector().importExisting()).rejects.toThrow('Continue with Google');
    expect(process.env.GSC_CLIENT_ID).toBe('synthetic-old-client');
    expect(process.env.GSC_REFRESH_TOKEN).toBe('synthetic-old-refresh');
  });
});
