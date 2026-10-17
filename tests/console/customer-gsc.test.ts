import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectLedger } from '../../src/db/index.ts';
import { LabService } from '../../src/console/service.ts';
import { GscConnector } from '../../src/console/gsc.ts';
import { GscWorkspace } from '../../src/console/gsc-workspace.ts';
import { GscSharing } from '../../src/console/gsc-sharing.ts';
import { GscMcp } from '../../src/console/gsc-mcp.ts';
import { GscSync } from '../../src/console/gsc-sync.ts';
import { belongsToGscProperty, gscProperty } from '../../src/console/gsc-contracts.ts';

const customer = 'sc-domain:customer.example.com', prefix = 'https://customer.example.com/research/';
const credentialKeys = ['GSC_CLIENT_ID', 'GSC_CLIENT_SECRET', 'GSC_REFRESH_TOKEN'];
const original = Object.fromEntries(credentialKeys.map(key => [key, process.env[key]]));
const resources: { lab: LabService; directory: string; syncs: GscSync[] }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await Promise.all(resource.syncs.map(sync => sync.stop()));
    resource.lab.db.close(); rmSync(resource.directory, { recursive: true, force: true });
  }
  for (const key of credentialKeys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
});
function fixture(entries: { siteUrl: string; permissionLevel: string }[] = [{ siteUrl: customer, permissionLevel: 'siteOwner' }, { siteUrl: prefix, permissionLevel: 'siteFullUser' }]) {
  const directory = mkdtempSync(join(tmpdir(), 'getgeo-customer-gsc-')), lab = new LabService(connectLedger(join(directory, 'ledger.db')));
  const resource = { lab, directory, syncs: [] as GscSync[] }; resources.push(resource);
  process.env.GSC_CLIENT_ID = 'synthetic-customer-desktop'; process.env.GSC_REFRESH_TOKEN = 'synthetic-customer-grant'; delete process.env.GSC_CLIENT_SECRET;
  const calls: { url: string; init?: RequestInit }[] = [];
  let sitemap = '<urlset><url><loc>https://customer.example.com/research/guide</loc></url></urlset>';
  let redirect: string | undefined;
  let addresses = [{ address: '8.8.8.8', family: 4 }];
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    const target = String(url); calls.push({ url: target, init });
    if (target === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'synthetic-access', scope: 'https://www.googleapis.com/auth/webmasters.readonly' });
    if (target === 'https://www.googleapis.com/webmasters/v3/sites') return Response.json({ siteEntry: entries });
    if (target === 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect') return Response.json({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } });
    if (target.startsWith('https://customer.example.com/')) return redirect ? new Response(null, { status: 302, headers: { location: redirect } }) : new Response(sitemap);
    if (target.includes('/searchAnalytics/query')) {
      const body = JSON.parse(String(init?.body)), dimensions = body.dimensions as string[];
      return Response.json({ rows: [{ keys: dimensions.map(name => name === 'query' ? 'customer opportunity' : name === 'page' ? 'https://customer.example.com/research/guide' : name === 'date' ? body.startDate : name === 'device' ? 'DESKTOP' : 'usa'), clicks: 3, impressions: 100, ctr: .03, position: 15 }] });
    }
    throw new Error('Unexpected external request');
  }) as typeof fetch;
  const gsc = new GscConnector(lab, fetcher, async () => addresses);
  return { lab, gsc, calls, resource, fetcher, setSitemap: (value: string) => { sitemap = value; }, setRedirect: (value: string) => { redirect = value; }, setAddresses: (value: typeof addresses) => { addresses = value; } };
}
const input = { property: customer, startDate: '2026-09-01', endDate: '2026-09-28', country: 'ALL' };

describe('customer-owned Search Console properties', () => {
  it('supports public domain and exact HTTPS URL-prefix properties', () => {
    expect(gscProperty.parse(customer)).toBe(customer); expect(gscProperty.parse(prefix)).toBe(prefix);
    expect(belongsToGscProperty(customer, 'https://help.customer.example.com/guide')).toBe(true);
    expect(belongsToGscProperty(prefix, 'https://customer.example.com/research/guide?q=one')).toBe(true);
    expect(belongsToGscProperty(prefix, 'https://customer.example.com/researchish/guide')).toBe(false);
    expect(belongsToGscProperty(prefix, 'https://sub.customer.example.com/research/guide')).toBe(false);
    expect(belongsToGscProperty(prefix, 'https://customer.example.com/research/%2e%2e/private')).toBe(false);
  });
  it.each(['sc-domain:localhost', 'sc-domain:127.0.0.1', 'sc-domain:service.internal', 'https://127.0.0.1/', 'https://user:password@customer.example.com/', 'https://customer.example.com:8443/', 'https://customer.example.com/path', 'http://customer.example.com/', 'https://customer.example.com/?token=secret'])('rejects unsafe or noncanonical property %s', property => {
    expect(gscProperty.safeParse(property).success).toBe(false);
  });
  it('lists only validated properties with explicit supported permission levels', async () => {
    const f = fixture([{ siteUrl: customer, permissionLevel: 'siteOwner' }, { siteUrl: prefix, permissionLevel: 'siteRestrictedUser' }, { siteUrl: 'sc-domain:unverified.example.com', permissionLevel: 'siteUnverifiedUser' }, { siteUrl: 'sc-domain:unknown.example.com', permissionLevel: 'unknownFutureRole' }, { siteUrl: 'sc-domain:localhost', permissionLevel: 'siteOwner' }]);
    expect(await f.gsc.available()).toEqual([{ siteUrl: customer, permissionLevel: 'siteOwner' }, { siteUrl: prefix, permissionLevel: 'siteRestrictedUser' }]);
    const body = new URLSearchParams(String(f.calls[0]!.init!.body));
    expect(body.get('refresh_token')).toBe('synthetic-customer-grant'); expect(body.has('client_secret')).toBe(false);
    expect(f.calls[0]!.init!.redirect).toBe('error');
  });
  it('captures and freezes customer query evidence with its exact property and request provenance', async () => {
    const f = fixture(), result = await f.gsc.capture(randomUUID(), input);
    expect(result.snapshot.property).toBe(customer); expect(result.snapshot.queries[0]!.keys).toEqual(['customer opportunity']);
    expect(f.calls.filter(call => call.url.includes('/searchAnalytics/query'))).toHaveLength(3);
    expect(f.calls.filter(call => call.url.includes('/searchAnalytics/query')).every(call => call.url.includes(encodeURIComponent(customer)))).toBe(true);
    expect(f.gsc.saved(result.snapshot.id)).toEqual(result);
    expect(() => f.lab.db.exec('DELETE FROM console_gsc_snapshot')).toThrow();
  });
  it('does not read a property that is syntactically valid but absent from the verified Google sites list', async () => {
    const f = fixture();
    await expect(f.gsc.capture(randomUUID(), { ...input, property: 'sc-domain:unrelated.example.com' })).rejects.toThrow('当前授权');
    expect(f.calls.some(call => call.url.includes('/searchAnalytics/query'))).toBe(false); expect(f.gsc.history()).toEqual([]);
  });
  it('inspects only URLs inside the selected verified URL prefix', async () => {
    const f = fixture();
    const result = await f.gsc.inspect(randomUUID(), { property: prefix, urls: ['https://customer.example.com/research/guide'] });
    expect(result.results[0]!.status).toBe('ok');
    const inspection = f.calls.find(call => call.url.includes('urlInspection'))!;
    expect(JSON.parse(String(inspection.init!.body)).siteUrl).toBe(prefix);
    const count = f.calls.length;
    await expect(f.gsc.inspect(randomUUID(), { property: prefix, urls: ['https://customer.example.com/other/guide'] })).rejects.toThrow('属于');
    expect(f.calls).toHaveLength(count);
  });
  it('requires verified property access before fetching a customer sitemap', async () => {
    const f = fixture([]);
    await expect(f.gsc.sitemap({ property: customer, url: 'https://customer.example.com/sitemap.xml' })).rejects.toThrow('当前授权');
    expect(f.calls.some(call => call.url.startsWith('https://customer.example.com/'))).toBe(false);
  });
  it('rejects a verified domain resolving to private or mixed public/private DNS before any page request', async () => {
    const f = fixture(); f.setAddresses([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(f.gsc.sitemap({ property: customer, url: 'https://customer.example.com/sitemap.xml' })).rejects.toThrow('public network');
    expect(f.calls.some(call => call.url.startsWith('https://customer.example.com/'))).toBe(false);
  });
  it('keeps sitemap redirects and discovered URLs within the exact URL-prefix property', async () => {
    const f = fixture(); f.setSitemap('<urlset><url><loc>https://customer.example.com/research/guide</loc></url><url><loc>https://customer.example.com/other/private</loc></url><url><loc>https://different.example.com/</loc></url></urlset>');
    const result = await f.gsc.sitemap({ property: prefix, url: prefix + 'sitemap.xml' });
    expect(result.urls).toEqual([prefix + 'guide']);
    f.setRedirect('https://customer.example.com/other/sitemap.xml');
    await expect(f.gsc.sitemap({ property: prefix, url: prefix + 'sitemap.xml' })).rejects.toThrow('属于');
    expect(f.calls.some(call => call.url.includes('/other/'))).toBe(false);
  });
  it('supports customer publication records, scoped shares and MCP without a two-brand enum', async () => {
    const f = fixture(), workspace = new GscWorkspace(f.lab);
    workspace.save(randomUUID(), { property: prefix, kind: 'publication', payload: { url: prefix + 'guide', publishedAt: '2026-06-01', source: 'manual' } });
    expect(workspace.publications(prefix)[0]!.url).toBe(prefix + 'guide');
    expect(() => workspace.save(randomUUID(), { property: prefix, kind: 'publication', payload: { url: 'https://customer.example.com/elsewhere', publishedAt: '2026-06-01', source: 'manual' } })).toThrow('belonging');
    const frozen = await f.gsc.capture(randomUUID(), input), sharing = new GscSharing(f.lab, f.gsc);
    sharing.create(randomUUID(), { snapshotId: frozen.snapshot.id }); expect(sharing.list(customer, 'http://127.0.0.1:1234')).toHaveLength(1);
    const mcp = new GscMcp(f.gsc, workspace);
    const response = mcp.respond({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gsc_snapshots', arguments: { property: customer } } }) as { result: { isError: boolean; content: { text: string }[] } };
    expect(response.result.isError).toBe(false); expect(JSON.parse(response.result.content[0]!.text)[0].property).toBe(customer);
  });
  it('requires explicit background-reading opt-in with no preloaded owner properties', async () => {
    const f = fixture(); await f.gsc.capture(randomUUID(), input);
    const sync = new GscSync(f.lab, f.gsc); f.resource.syncs.push(sync);
    expect(sync.status().sites.find(site => site.property === customer)?.enabled).toBe(false);
    expect(sync.status().sites.find(site => site.property === 'sc-domain:sample-agency.example')).toBeUndefined();
    expect(sync.defaultInput(customer).country).toBe('ALL');
    await sync.tick(); expect(f.gsc.history()).toHaveLength(1);
    new GscWorkspace(f.lab).save(randomUUID(), { property: customer, kind: 'preferences', payload: { language: 'en', metric: 'clicks', pageSize: 25, hideSuspicious: false, autoRead: true } });
    expect(sync.status().sites.find(site => site.property === customer)?.enabled).toBe(true);
    await sync.tick(); expect(f.gsc.history().filter(row => row.property === customer)).toHaveLength(2);
  });
});
