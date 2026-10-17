import { describe,it,expect,afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { GscConnector,gscInput,gscMarkdown } from '../../src/console/gsc.ts';
import { LabService } from '../../src/console/service.ts';
import { connectLedger } from '../../src/db/index.ts';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const dirs:string[]=[],dbs:DatabaseSync[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function lab(){const dir=mkdtempSync(join(tmpdir(),'gsc-test-'));dirs.push(dir);const db=connectLedger(join(dir,'ledger.db'));dbs.push(db);return new LabService(db);}
const input={property:'sc-domain:sample-agency.example',startDate:'2026-09-01',endDate:'2026-09-28',country:'CAN'};
function env(){process.env.GSC_CLIENT_ID='client';process.env.GSC_CLIENT_SECRET='secret';process.env.GSC_REFRESH_TOKEN='refresh';}
function mock(options:{write?:boolean;error?:boolean}={}){const calls:{url:string;body:unknown}[]=[];const fn=(async(url:unknown,init?:RequestInit)=>{const u=String(url);calls.push({url:u,body:init?.body});if(u.endsWith('/token'))return Response.json(options.error?{error:'invalid_grant',secret:'do not leak'}:{access_token:'token',scope:'https://www.googleapis.com/auth/webmasters'+(options.write?'':'.readonly')},{status:options.error?400:200});if(u.endsWith('/sites'))return Response.json({siteEntry:[{siteUrl:'sc-domain:sample-agency.example',permissionLevel:'siteOwner'},{siteUrl:'sc-domain:other.example',permissionLevel:'siteOwner'}]});const b=JSON.parse(String(init?.body));return Response.json({rows:[{keys:b.dimensions.length?[b.dimensions[0]==='query'?'restaurant scheduling':'https://sample-agency.example/']:[],clicks:2,impressions:10,ctr:0.2,position:3}],responseAggregationType:'byProperty'});}) as typeof fetch;return {fn,calls};}
describe('GSC read-only evidence',()=>{
 it('captures separate aggregates, validates scope, records Canada and immutable evidence, retries idempotently',async()=>{env();const s=lab(),m=mock(),c=new GscConnector(s,m.fn),id=randomUUID();const r=await c.capture(id,input);expect(r.snapshot.totals?.clicks).toBe(2);expect(r.snapshot.timeZone).toBe('America/Los_Angeles');expect(r.snapshot.queries[0]?.keys).toEqual(['restaurant scheduling']);const calls=m.calls.length;expect(await c.capture(id,input)).toEqual(r);expect(m.calls.length).toBe(calls);expect(JSON.stringify(r)).not.toContain('refresh');const b=JSON.parse(String(m.calls[2]?.body));expect(b.dimensionFilterGroups[0].filters[0].expression).toBe('CAN');expect(()=>s.db.prepare('UPDATE console_gsc_snapshot SET hash=?').run('bad')).toThrow();expect(()=>s.db.exec('DELETE FROM console_gsc_snapshot')).toThrow();expect(gscMarkdown(r)).toContain(r.hash);await expect(c.capture(id,{...input,country:'ALL'})).rejects.toThrow('请求标识');});
 it('rejects broader grants and never saves failures as zero',async()=>{env();const s=lab();await expect(new GscConnector(s,mock({write:true}).fn).capture(randomUUID(),input)).rejects.toThrow('只读');await expect(new GscConnector(s,mock({error:true}).fn).capture(randomUUID(),input)).rejects.toThrow('过期');expect(new GscConnector(s).history()).toEqual([]);});
 it('accepts customer property syntax but rejects unsafe properties and invalid dates',()=>{expect(gscInput.safeParse({...input,property:'sc-domain:other.example'}).success).toBe(true);expect(gscInput.safeParse({...input,property:'sc-domain:localhost'}).success).toBe(false);expect(gscInput.safeParse({...input,startDate:'2026-09-30'}).success).toBe(false);expect(gscInput.safeParse({...input,startDate:'2026-02-30'}).success).toBe(false);});
});
