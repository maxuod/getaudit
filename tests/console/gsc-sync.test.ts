import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {GscConnector} from '../../src/console/gsc.ts';
import {GscSync,type GscSyncOptions} from '../../src/console/gsc-sync.ts';
import {GscWorkspace} from '../../src/console/gsc-workspace.ts';
import {serveConsole} from '../../src/console/server.ts';

const sites=['sc-domain:sample-studio.example','sc-domain:sample-agency.example'];
const input={property:sites[0],startDate:'2026-09-03',endDate:'2026-09-30',country:'CAN',dashboard:true,compare:true,includeMonthly:true};
const resources:{lab:LabService;dir:string;sync:GscSync}[]=[];
const credentialKeys=['GSC_CLIENT_ID','GSC_CLIENT_SECRET','GSC_REFRESH_TOKEN'];
const original=Object.fromEntries(credentialKeys.map(k=>[k,process.env[k]]));
afterEach(async()=>{for(const r of resources.splice(0)){await r.sync.stop();r.lab.db.close();rmSync(r.dir,{recursive:true,force:true});}for(const k of credentialKeys){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];}});
function setup(fetcher:typeof fetch,now=Date.now,options:GscSyncOptions={}){
 const dir=mkdtempSync(join(tmpdir(),'gsc-sync-')),lab=new LabService(connectLedger(join(dir,'ledger.db'))),connector=new GscConnector(lab,fetcher),sync=new GscSync(lab,connector,now,undefined,options);
 resources.push({lab,dir,sync});for(const k of credentialKeys)process.env[k]='synthetic-test';return {lab,connector,sync};
}
function provider(){let fail=false,calls=0;const fetcher=(async(url:unknown,init?:RequestInit)=>{
 calls++;const u=String(url);if(u.endsWith('/token'))return Response.json({access_token:'synthetic-test',scope:'https://www.googleapis.com/auth/webmasters.readonly'});
 if(u.endsWith('/sites'))return Response.json({siteEntry:sites.map(siteUrl=>({siteUrl,permissionLevel:'siteOwner'}))});
 if(fail)return Response.json({error:'synthetic-failure'},{status:503});
 const body=JSON.parse(String(init?.body));return Response.json({rows:[{keys:body.dimensions.map((d:string)=>d==='date'?body.startDate:d==='page'?'https://sample-studio.example/synthetic':d==='query'?'synthetic query':d==='device'?'DESKTOP':'can'),clicks:3,impressions:100,ctr:.03,position:7}]});
 }) as typeof fetch;return {fetcher,get calls(){return calls;},set fail(value:boolean){fail=value;}};}

describe('automatic GSC reading',()=>{
 it('keeps a new workspace empty without discovering or reading an embedded owner property',async()=>{
  const p=provider(),{connector,sync}=setup(p.fetcher);
  expect(sync.status().sites).toEqual([]);
  await sync.tick();sync.start();await sync.tick();
  expect(p.calls).toBe(0);expect(connector.history()).toEqual([]);expect(sync.status().sites).toEqual([]);
 });
 it('requires explicit opt-in for saved properties even when credentials are available',async()=>{
  const p=provider(),{lab,connector,sync}=setup(p.fetcher),workspace=new GscWorkspace(lab);
  workspace.save(randomUUID(),{property:sites[0],kind:'preferences',payload:{language:'en',metric:'clicks',pageSize:25,hideSuspicious:false}});
  workspace.save(randomUUID(),{property:sites[1],kind:'preferences',payload:{language:'en',metric:'clicks',pageSize:25,hideSuspicious:false,autoRead:false}});
  expect(sync.status().sites).toHaveLength(2);expect(sync.status().sites.every(site=>!site.enabled)).toBe(true);
  expect(sync.defaultInput(sites[0]!)).toMatchObject({property:sites[0],country:'ALL'});
  await sync.tick();expect(p.calls).toBe(0);expect(connector.history()).toEqual([]);
 });
 it('coalesces simultaneous readers and reuses the frozen snapshot across service restarts',async()=>{
  const p=provider(),{lab,connector,sync}=setup(p.fetcher);
  const [a,b]=await Promise.all([sync.refresh(input),sync.refresh(input)]);expect(a.evidence.snapshot.id).toBe(b.evidence.snapshot.id);expect(connector.history()).toHaveLength(1);
  const count=p.calls,again=new GscSync(lab,connector);const cached=await again.refresh(input);expect(cached.cached).toBe(true);expect(cached.evidence).toEqual(a.evidence);expect(p.calls).toBe(count);await again.stop();
 });
 it('does not reuse a different market/filter and adds a fresh snapshot after its one-day expiry',async()=>{
  let now=Date.now();const p=provider(),{connector,sync}=setup(p.fetcher,()=>now),first=await sync.refresh(input);
  const other=await sync.refresh({...input,country:'USA',device:'MOBILE'});expect(other.evidence.snapshot.id).not.toBe(first.evidence.snapshot.id);expect(other.evidence.snapshot.country).toBe('USA');
  now=Date.parse(first.evidence.snapshot.capturedAt)+86400001;const next=await sync.refresh(input);expect(next.cached).toBe(false);expect(next.evidence.snapshot.id).not.toBe(first.evidence.snapshot.id);expect(connector.saved(first.evidence.snapshot.id)).toEqual(first.evidence);expect(connector.history()).toHaveLength(3);
 });
 it('retains good data on error, backs off retries, and allows an explicit manual retry',async()=>{
  let now=Date.now();const p=provider(),{connector,sync}=setup(p.fetcher,()=>now),first=await sync.refresh(input);now=Date.parse(first.evidence.snapshot.capturedAt)+86400001;p.fail=true;
  await expect(sync.refresh(input)).rejects.toThrow('503');const count=p.calls;await expect(sync.refresh(input)).rejects.toThrow('503');expect(p.calls).toBe(count);expect(connector.history()).toHaveLength(1);expect(connector.saved(first.evidence.snapshot.id)).toEqual(first.evidence);
  expect(sync.status().sites[0]?.state).toMatchObject({phase:'error',retryAt:expect.any(String)});p.fail=false;await sync.refresh(input,true);expect(connector.history()).toHaveLength(2);
 });
 it('honors a saved opt-out while continuing the other property and uses Pacific calendar dates',async()=>{
  const p=provider(),{lab,connector,sync}=setup(p.fetcher,()=>Date.parse('2026-10-04T02:30:00Z'));
  const workspace=new GscWorkspace(lab);
  workspace.save(randomUUID(),{property:sites[0],kind:'preferences',payload:{language:'zh',metric:'clicks',pageSize:25,hideSuspicious:false,autoRead:false}});
  workspace.save(randomUUID(),{property:sites[1],kind:'preferences',payload:{language:'en',metric:'clicks',pageSize:25,hideSuspicious:false,autoRead:true}});
  expect(sync.defaultInput(sites[0]!)).toMatchObject({startDate:'2026-09-03',endDate:'2026-09-30',country:'ALL'});await sync.tick();expect(connector.history().map(r=>r.property)).toEqual([sites[1]]);expect(sync.status().sites.find(site=>site.property===sites[0])?.enabled).toBe(false);
 });
 it('requires saved opt-in in managed mode and rechecks account permission between properties',async()=>{
  let allowed=true;const p=provider(),{lab,connector,sync}=setup(p.fetcher,Date.now,{canAutoRead:()=>allowed,requireExplicitOptIn:()=>true}),workspace=new GscWorkspace(lab);
  expect(sync.status().sites.every(site=>!site.enabled)).toBe(true);await sync.tick();expect(p.calls).toBe(0);
  for(const property of sites)workspace.save(randomUUID(),{property,kind:'preferences',payload:{language:'en',metric:'clicks',pageSize:25,hideSuspicious:false,autoRead:true}});
  const firstProperty=sync.status().sites[0]?.property;
  const capture=vi.spyOn(connector,'capture');capture.mockImplementationOnce(async(...args)=>{const evidence=await GscConnector.prototype.capture.apply(connector,args);allowed=false;return evidence;});
  await sync.tick();expect(capture).toHaveBeenCalledTimes(1);expect(connector.history()).toHaveLength(1);expect(connector.history()[0]?.property).toBe(firstProperty);
  await sync.tick();expect(capture).toHaveBeenCalledTimes(1);
 });
 it('serializes different filters and cancels running and queued work cleanly on shutdown',async()=>{
  let entered!:()=>void;const started=new Promise<void>(r=>entered=r);let tokenCalls=0;
  const hanging=(async(_url:unknown,init?:RequestInit)=>{tokenCalls++;entered();return await new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});}) as typeof fetch;
  const {connector,sync}=setup(hanging),a=sync.refresh(input),b=sync.refresh({...input,country:'USA'});const all=Promise.allSettled([a,b]);await started;await sync.stop();expect((await all).map(r=>r.status)).toEqual(['rejected','rejected']);expect(tokenCalls).toBe(1);expect(connector.history()).toHaveLength(0);await expect(sync.refresh(input)).rejects.toThrow('退出');
 });
 it('drains running and queued reads for an account transition, then accepts a new explicit read after release',async()=>{
  const p=provider();let block=true,entered!:()=>void,blockedCalls=0;const started=new Promise<void>(resolve=>{entered=resolve;});
  const fetcher=(async(url:unknown,init?:RequestInit)=>{
   if(block){blockedCalls++;entered();return new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('synthetic aborted old account')),{once:true});});}
   return p.fetcher(url as RequestInfo,init);
  }) as typeof fetch;
  const {connector,sync}=setup(fetcher),first=sync.refresh(input),queued=sync.refresh({...input,country:'USA'}),outcomes=Promise.allSettled([first,queued]);await started;
  const resume=await sync.pause();expect((await outcomes).map(value=>value.status)).toEqual(['rejected','rejected']);expect(blockedCalls).toBe(1);expect(connector.history()).toHaveLength(0);expect(sync.status().paused).toBe(true);expect(sync.status().sites.every(site=>site.state===null)).toBe(true);
  await expect(sync.refresh(input)).rejects.toMatchObject({code:'google_connection_changing'});block=false;resume();
  expect(sync.status().paused).toBe(false);const result=await sync.refresh(input);expect(result.cached).toBe(false);expect(connector.history()).toHaveLength(1);
 });
 it('retains independent pause leases so an older transition cannot resume a newer one',async()=>{
  const p=provider(),{sync}=setup(p.fetcher),releaseFirst=await sync.pause(),releaseSecond=await sync.pause();
  releaseFirst();releaseFirst();expect(sync.status().paused).toBe(true);await sync.tick();expect(p.calls).toBe(0);await expect(sync.refresh(input)).rejects.toMatchObject({code:'google_connection_changing'});
  releaseSecond();expect(sync.status().paused).toBe(false);expect(p.calls).toBe(0);await sync.refresh(input);expect(p.calls).toBeGreaterThan(0);
 });
 it('does not carry an earlier account error backoff into the next account transition',async()=>{
  const p=provider(),{sync}=setup(p.fetcher);p.fail=true;await expect(sync.refresh(input)).rejects.toThrow('503');const calls=p.calls;
  const resume=await sync.pause();p.fail=false;resume();await sync.refresh(input);expect(p.calls).toBeGreaterThan(calls);expect(sync.status().sites[0]?.state?.phase).toBe('fresh');
 });
 it('preserves the existing background timer and opt-outs without starting work merely by resuming',async()=>{
  const p=provider(),{lab,sync}=setup(p.fetcher),workspace=new GscWorkspace(lab);
  for(const property of sites)workspace.save(randomUUID(),{property,kind:'preferences',payload:{language:'en',metric:'clicks',pageSize:25,hideSuspicious:false,autoRead:false}});
  sync.start();expect(sync.status().running).toBe(true);const resume=await sync.pause();expect(sync.status()).toMatchObject({running:false,paused:true});
  await sync.tick();resume();expect(sync.status()).toMatchObject({running:true,paused:false});expect(sync.status().sites.every(site=>!site.enabled)).toBe(true);expect(p.calls).toBe(0);
  await sync.tick();expect(p.calls).toBe(0);
 });
 it('waits for an abort-ignoring provider to settle without accepting its stale result',async()=>{
  const p=provider();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const fetcher=(async(url:unknown,init?:RequestInit)=>{entered();await gate;return p.fetcher(url as RequestInfo,init);}) as typeof fetch;
  const {connector,sync}=setup(fetcher),reading=sync.refresh(input),outcome=Promise.allSettled([reading]);await started;
  let drained=false;const pausing=sync.pause().then(resume=>{drained=true;return resume;});await Promise.resolve();expect(drained).toBe(false);expect(sync.status().paused).toBe(true);
  release();const resume=await pausing;expect((await outcome)[0]?.status).toBe('rejected');expect(connector.history()).toHaveLength(0);expect(sync.status().sites.every(site=>site.state===null)).toBe(true);resume();
 });
 it('keeps true shutdown final even if an old transition releases its lease and calls start',async()=>{
  const p=provider(),{sync}=setup(p.fetcher),resume=await sync.pause();await sync.stop();resume();sync.start();await sync.tick();expect(sync.status().running).toBe(false);expect(p.calls).toBe(0);await expect(sync.refresh(input)).rejects.toThrow('退出');
 });
 it('falls back when a saved port is occupied without starting a second Console reader',async()=>{
  const p=provider(),{lab}=setup(p.fetcher),occupied=createServer();await new Promise<void>(r=>occupied.listen(0,'127.0.0.1',r));const port=(occupied.address() as {port:number}).port;
  const app=await serveConsole(lab,{port,fallbackPort:true});try{expect(new URL(app.origin).port).not.toBe(String(port));expect((await fetch(app.origin+'/api/gsc/sync-status',{headers:{Authorization:'Bearer '+app.token}})).status).toBe(200);}
  finally{await app.gscSync.stop();app.server.closeAllConnections();await new Promise<void>(r=>app.server.close(()=>r()));await new Promise<void>(r=>occupied.close(()=>r()));}
 });
});
