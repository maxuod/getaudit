import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {serveConsole} from '../../src/console/server.ts';
import {GscConnector,type GscEvidence} from '../../src/console/gsc.ts';
import {GscWorkspace} from '../../src/console/gsc-workspace.ts';
import {Ga4Connector,ga4Metrics,type Ga4Snapshot} from '../../src/console/ga4.ts';
import type {GoogleAccountStatus} from '../../src/console/google-account.ts';

const httpFetch=globalThis.fetch;
const runtimes:{runtime:Awaited<ReturnType<typeof serveConsole>>;lab:LabService}[]=[];
const keys=['GETGEO_GOOGLE_ACCOUNT_SESSION','GETGEO_GOOGLE_CLIENT_SECRET','GETAUDIT_GOOGLE_DATA_SUBJECT','GETAUDIT_GOOGLE_DATA_MODE','GSC_CLIENT_ID','GSC_CLIENT_SECRET','GSC_REFRESH_TOKEN'];
const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
afterEach(async()=>{
 for(const {runtime,lab} of runtimes.splice(0)){
  await runtime.browserJobs.pauseAll();await runtime.keywordAudit.stop();await runtime.gscSync.stop();
  runtime.server.closeAllConnections();await new Promise<void>(done=>runtime.server.close(()=>done()));lab.db.close();
 }
 vi.unstubAllGlobals();
 for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}
});
const googleUrl='https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic.apps.googleusercontent.com&scope=openid%20email%20profile&state=synthetic-state';
const gscScope='https://www.googleapis.com/auth/webmasters.readonly',ga4Scope='https://www.googleapis.com/auth/analytics.readonly';
const sites=[{siteUrl:'sc-domain:example.com',permissionLevel:'siteOwner'}];
const properties=[{property:'properties/100',displayName:'Example GA4',account:'accounts/10',accountDisplayName:'Example account'}];
const values={activeUsers:120,sessions:200,screenPageViews:300,keyEvents:4};
function snapshot():Ga4Snapshot{return {id:randomUUID(),...properties[0]!,capturedAt:'2026-10-16T12:00:00.000Z',startDate:'2026-09-18',endDate:'2026-10-15',timeZone:'America/Los_Angeles',source:'Google Analytics Data API / properties.runReport',access:'read_only',metrics:ga4Metrics,requestedDateRange:{startDate:'28daysAgo',endDate:'yesterday'},totals:values,daily:[{date:'2026-09-18',...values}],sources:[{source:'google',medium:'organic',...values}],reports:[],truncated:[],limitations:['Synthetic fixture only.']};}
async function fixture(options:{access?:'ready'|'loading'|'locked';capabilities?:GoogleAccountStatus['capabilities']|null;defaultGsc?:boolean;opener?:boolean;demo?:boolean}={}){
 let status:GoogleAccountStatus={configured:true,status:'signed_in',sessionRevision:1,profile:{subject:'synthetic-subject-a',name:'Reader Example',email:'reader@example.test'},expiresAt:'2030-01-01T00:00:00.000Z',...(options.capabilities===null?{}:{capabilities:options.capabilities??{gsc:true,ga4:true}})};
 const expiresAt=new Date(Date.now()+300_000).toISOString();
 const provider={
  status:vi.fn(()=>structuredClone(status)),ensureFresh:vi.fn(async()=>structuredClone(status)),restore:vi.fn(async()=>structuredClone(status)),
  start:vi.fn(async()=>({url:googleUrl,expiresAt})),startGsc:vi.fn(async()=>({url:googleUrl,expiresAt})),
  startData:vi.fn(async()=>{status={configured:true,status:'pending',sessionRevision:(status.sessionRevision??0)+1};return {url:googleUrl,expiresAt};}),
  dataToken:vi.fn(async(service:'gsc'|'ga4')=>{if(status.status!=='signed_in'||!status.capabilities?.[service])throw new Error('access_denied');return {accessToken:'synthetic-memory-access',scopes:[gscScope,ga4Scope]};}),
  signOut:vi.fn(async()=>{status={configured:true,status:'signed_out',sessionRevision:(status.sessionRevision??0)+1};}),dispose:vi.fn(),
 };
 const lab=new LabService(connectLedger(':memory:'));
 const brandId=lab.createBrand(randomUUID(),{name:'Example',ownedDomains:['example.com'],aliases:[]}).id;
 const neverNetwork=vi.fn(async()=>{throw new Error('Unexpected external network request');});
 const gsc=new GscConnector(lab,neverNetwork as typeof fetch),ga4=new Ga4Connector({tokenProvider:async()=>{throw new Error('Unexpected token read');},fetcher:neverNetwork as typeof fetch});
 const gscAvailable=vi.spyOn(gsc,'available').mockResolvedValue(sites),ga4Available=vi.spyOn(ga4,'available').mockResolvedValue(properties),ga4Overview=vi.spyOn(ga4,'overview').mockImplementation(async()=>snapshot());
 const opener=vi.fn(async(_url:string)=>{});
 const runtime=await serveConsole(lab,{autoGsc:false,accountProvider:provider,...(options.defaultGsc?{}:{gscConnector:gsc}),ga4Connector:ga4,...(options.opener===false?{}:{openExternal:opener}),...(options.access?{connectionAccess:()=>({status:options.access!})}:{}),...(options.demo?{demo:true}:{})});
 runtimes.push({runtime,lab});
 const headers={Authorization:'Bearer '+runtime.token};
 const get=(path:string,extra:Record<string,string>={})=>httpFetch(runtime.origin+path,{headers:{...headers,...extra}});
 const post=(path:string,input:unknown={},requestId:string|undefined=randomUUID(),extra:Record<string,string>={})=>httpFetch(runtime.origin+path,{method:'POST',headers:{...headers,'Content-Type':'application/json',...extra},body:JSON.stringify({requestId,input})});
 return {runtime,lab,brandId,provider,opener,get,post,headers,expiresAt,gsc,gscAvailable,ga4Available,ga4Overview,neverNetwork,set:(value:Partial<GoogleAccountStatus>)=>{status={...status,...value};}};
}
function gscEvidence():GscEvidence{return {snapshot:{id:randomUUID(),property:'sc-domain:example.com',capturedAt:new Date().toISOString(),startDate:'2026-09-01',endDate:'2026-09-28',country:'ALL',timeZone:'America/Los_Angeles',type:'web',dataState:'final',source:'Synthetic account-transition test',requests:[],raw:[],totals:null,queries:[],pages:[],daily:[],limitations:['Synthetic test fixture only.']},hash:'0'.repeat(64)};}
const syncFilters={property:'sc-domain:example.com',startDate:'2026-09-01',endDate:'2026-09-28',country:'ALL'};

describe('Google one-click data connection HTTP boundary',()=>{
 it('starts no OAuth work from GET, status polling, missing local authorization or a foreign origin',async()=>{
  const f=await fixture();
  expect((await f.get('/api/account/data-start')).status).toBe(404);
  expect((await httpFetch(f.runtime.origin+'/api/account/data-start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),input:{}})})).status).toBe(401);
  expect((await f.post('/api/account/data-start',{},randomUUID(),{Origin:'https://foreign.example.test'})).status).toBe(403);
  expect((await f.get('/api/account/status')).status).toBe(200);
  expect(f.provider.startData).not.toHaveBeenCalled();expect(f.opener).not.toHaveBeenCalled();expect(f.neverNetwork).not.toHaveBeenCalled();
 });
 it('uses only the unified provider for an explicit authorized data-start POST',async()=>{
  const f=await fixture();const response=await f.post('/api/account/data-start');
  expect(response.status).toBe(200);expect(await response.json()).toEqual({url:googleUrl,expiresAt:f.expiresAt,opened:true});
  expect(f.provider.startData).toHaveBeenCalledTimes(1);expect(f.provider.start).not.toHaveBeenCalled();expect(f.provider.startGsc).not.toHaveBeenCalled();
  expect(f.opener).toHaveBeenCalledWith(googleUrl);expect(f.provider.dataToken).not.toHaveBeenCalled();expect(f.gscAvailable).not.toHaveBeenCalled();expect(f.ga4Available).not.toHaveBeenCalled();
 });
 it('requires the local bearer and matching origin on resources, selections and GA4 report reads',async()=>{
  const f=await fixture();
  for(const path of ['/api/google/resources','/api/google/selection','/api/ga4/report']){
   expect((await httpFetch(f.runtime.origin+path+'?brandId='+f.brandId)).status).toBe(401);
   expect((await f.get(path+'?brandId='+f.brandId,{Origin:'https://foreign.example.test'})).status).toBe(403);
  }
  expect((await f.post('/api/google/selection',{brandId:f.brandId,ga4PropertyId:'properties/100'},randomUUID(),{Origin:'https://foreign.example.test'})).status).toBe(403);
  expect((await f.post('/api/ga4/report',{brandId:f.brandId,propertyId:'properties/100'},randomUUID(),{Origin:'https://foreign.example.test'})).status).toBe(403);
  expect(f.provider.ensureFresh).not.toHaveBeenCalled();expect(f.gscAvailable).not.toHaveBeenCalled();expect(f.ga4Available).not.toHaveBeenCalled();expect(f.ga4Overview).not.toHaveBeenCalled();
 });
 it('validates the unified browser destination and offers a safe direct link if opening the browser fails',async()=>{
  const f=await fixture();f.provider.startData.mockResolvedValue({url:'https://accounts.google.com.evil.example/o/oauth2/v2/auth',expiresAt:f.expiresAt});
  expect((await f.post('/api/account/data-start')).status).toBe(400);expect(f.opener).not.toHaveBeenCalled();
  f.provider.startData.mockResolvedValue({url:googleUrl,expiresAt:f.expiresAt});f.opener.mockRejectedValue(new Error('private native failure'));
  const response=await f.post('/api/account/data-start');expect(response.status).toBe(200);
  const value=await response.json();expect(value).toEqual({url:googleUrl,expiresAt:f.expiresAt,opened:false});expect(JSON.stringify(value)).not.toContain('private native failure');
 });
 it.each(['loading','locked'] as const)('does not launch consent or read resources while the connection vault is %s',async access=>{
  const f=await fixture({access});
  expect((await f.post('/api/account/data-start')).status).toBe(409);expect((await f.get('/api/google/resources?brandId='+f.brandId)).status).toBe(409);
  expect(f.provider.startData).not.toHaveBeenCalled();expect(f.provider.ensureFresh).not.toHaveBeenCalled();expect(f.opener).not.toHaveBeenCalled();expect(f.gscAvailable).not.toHaveBeenCalled();expect(f.ga4Available).not.toHaveBeenCalled();
 });
 it('returns the same OAuth launch for sequential retries with the same request ID',async()=>{
  const f=await fixture(),request=randomUUID();
  const first=await (await f.post('/api/account/data-start',{},request)).json();
  const second=await (await f.post('/api/account/data-start',{},request)).json();
  expect(second).toEqual(first);expect(f.provider.startData).toHaveBeenCalledTimes(1);expect(f.opener).toHaveBeenCalledTimes(1);
 });
 it('shares an in-flight OAuth launch for simultaneous retries with the same request ID',async()=>{
  const f=await fixture(),request=randomUUID();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  f.provider.startData.mockImplementation(async()=>{await gate;return {url:googleUrl,expiresAt:f.expiresAt};});
  const first=f.post('/api/account/data-start',{},request),second=f.post('/api/account/data-start',{},request);
  await vi.waitFor(()=>expect(f.provider.startData).toHaveBeenCalled());await new Promise(resolve=>setTimeout(resolve,20));release();
  const responses=await Promise.all([first,second]);const payloads=await Promise.all(responses.map(response=>response.json()));
  expect(responses.map(response=>response.status)).toEqual([200,200]);expect(payloads[1]).toEqual(payloads[0]);
  expect(f.provider.startData).toHaveBeenCalledTimes(1);expect(f.opener).toHaveBeenCalledTimes(1);
 });
 it.each(['','not-a-request-id','undefined'])('rejects invalid or absent request IDs before starting a browser: %s',async request=>{
  const f=await fixture();const response=request==='undefined'?await httpFetch(f.runtime.origin+'/api/account/data-start',{method:'POST',headers:{...f.headers,'Content-Type':'application/json'},body:JSON.stringify({input:{}})}):await f.post('/api/account/data-start',{},request);
  expect(response.status).toBe(400);expect(f.provider.startData).not.toHaveBeenCalled();expect(f.opener).not.toHaveBeenCalled();
 });
 it.each([null,{gsc:false,ga4:false}] as const)('does not read any provider resources without explicit granted capabilities %j',async capabilities=>{
  const f=await fixture({capabilities});const response=await f.get('/api/google/resources?brandId='+f.brandId);expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({gsc:{status:'missing_scope',sites:[]},ga4:{status:'missing_scope',properties:[]},selection:{brandId:f.brandId}});
  expect(f.gscAvailable).not.toHaveBeenCalled();expect(f.ga4Available).not.toHaveBeenCalled();expect(f.provider.dataToken).not.toHaveBeenCalled();
 });
 it('reads only the service the current Google account granted',async()=>{
  const f=await fixture({capabilities:{gsc:false,ga4:true}});const value=await (await f.get('/api/google/resources?brandId='+f.brandId)).json();
  expect(value.gsc.status).toBe('missing_scope');expect(value.ga4.properties).toEqual([{propertyId:'properties/100',displayName:'Example GA4',accountName:'Example account'}]);
  expect(f.gscAvailable).not.toHaveBeenCalled();expect(f.ga4Available).toHaveBeenCalledTimes(1);
 });
 it('keeps session, client secrets, owner IDs and access tokens out of settings and data HTTP responses',async()=>{
  process.env.GETGEO_GOOGLE_ACCOUNT_SESSION='synthetic-private-id-token-refresh-session';process.env.GETGEO_GOOGLE_CLIENT_SECRET='synthetic-private-client-secret';process.env.GETAUDIT_GOOGLE_DATA_SUBJECT='synthetic-private-owner-id';
  const f=await fixture();
  const responses=await Promise.all(['/api/state','/api/account/status','/api/google/resources?brandId='+f.brandId,'/api/google/selection?brandId='+f.brandId].map(path=>f.get(path).then(response=>response.json())));
  const text=JSON.stringify(responses);expect(text).not.toContain('synthetic-private');expect(text).not.toContain('synthetic-memory-access');
  for(const key of ['GETGEO_GOOGLE_ACCOUNT_SESSION','GETAUDIT_GOOGLE_DATA_SUBJECT','GETAUDIT_GOOGLE_DATA_MODE']){
   expect((await f.post('/api/settings',{[key]:'user-edited-private-field'})).status).toBe(400);
  }
  expect(f.provider.dataToken).not.toHaveBeenCalled();
 });
 it('disconnects explicitly, forgets cached launches and reads no data while signed out',async()=>{
  const f=await fixture(),request=randomUUID();await f.post('/api/account/data-start',{},request);
  expect((await f.post('/api/account/sign-out')).status).toBe(200);expect(f.provider.signOut).toHaveBeenCalledTimes(1);
  expect((await f.get('/api/google/resources?brandId='+f.brandId)).status).toBe(400);expect(f.gscAvailable).not.toHaveBeenCalled();expect(f.ga4Available).not.toHaveBeenCalled();
  await f.post('/api/account/data-start',{},request);expect(f.provider.startData).toHaveBeenCalledTimes(2);
 });
 it('cancels a data-start waiting for GSC sync to pause when sign-out wins the race',async()=>{
  const f=await fixture();let release!:()=>void;
  const pausing=new Promise<()=>void>(resolve=>{release=()=>resolve(()=>{});});
  const pause=vi.spyOn(f.runtime.gscSync,'pause').mockImplementationOnce(()=>pausing).mockResolvedValue(()=>{});
  const waiting=f.post('/api/account/data-start');
  await vi.waitFor(()=>expect(pause).toHaveBeenCalledTimes(1));
  const signedOut=await f.post('/api/account/sign-out');expect(signedOut.status).toBe(200);expect(f.provider.signOut).toHaveBeenCalledTimes(1);
  release();const response=await waiting;expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'Google sign-in was cancelled.'});
  expect(f.provider.startData).not.toHaveBeenCalled();expect(f.opener).not.toHaveBeenCalled();expect(f.provider.status()).toMatchObject({status:'signed_out'});
 });
 it('accepts a new GSC read after unified sign-in instead of permanently marking the reader as closing',async()=>{
  const f=await fixture(),captured=gscEvidence(),capture=vi.spyOn(f.gsc,'capture').mockResolvedValue(captured),stop=vi.spyOn(f.runtime.gscSync,'stop');
  expect((await f.post('/api/account/data-start')).status).toBe(200);expect(f.runtime.gscSync.status().paused).toBe(false);expect(stop).not.toHaveBeenCalled();expect(capture).not.toHaveBeenCalled();
  f.set({status:'signed_in',sessionRevision:2,profile:{subject:'synthetic-subject-b',name:'Other',email:'other@example.test'},capabilities:{gsc:true,ga4:true}});
  const response=await f.post('/api/gsc/sync',{filters:syncFilters,force:true});expect(response.status).toBe(200);expect(await response.json()).toMatchObject({evidence:captured,cached:false});expect(capture).toHaveBeenCalledTimes(1);expect(f.neverNetwork).not.toHaveBeenCalled();
  await f.runtime.gscSync.stop();const closing=await f.post('/api/gsc/sync',{filters:syncFilters,force:true});expect(closing.status).toBe(400);expect((await closing.json()).error).toContain('退出');expect(capture).toHaveBeenCalledTimes(1);
 });
 it('allows sign-out then reconnect without starting any sampling or GSC read until explicitly requested',async()=>{
  const f=await fixture(),capture=vi.spyOn(f.gsc,'capture').mockResolvedValue(gscEvidence()),stop=vi.spyOn(f.runtime.gscSync,'stop');
  const jobsBefore=f.lab.db.prepare('SELECT * FROM console_browser_job').all();
  expect((await f.post('/api/account/sign-out')).status).toBe(200);expect(f.runtime.gscSync.status().paused).toBe(false);
  expect((await f.post('/api/account/data-start')).status).toBe(200);expect(stop).not.toHaveBeenCalled();expect(capture).not.toHaveBeenCalled();expect(f.neverNetwork).not.toHaveBeenCalled();
  f.set({status:'signed_in',sessionRevision:3,profile:{subject:'synthetic-subject-b',name:'Other',email:'other@example.test'},capabilities:{gsc:true,ga4:true}});
  expect((await f.post('/api/gsc/sync',{filters:syncFilters,force:true})).status).toBe(200);expect(capture).toHaveBeenCalledTimes(1);expect(f.lab.db.prepare('SELECT * FROM console_browser_job').all()).toEqual(jobsBefore);
 });
 it('releases the temporary pause after a failed sign-in or sign-out so a later verified connection can read',async()=>{
  const f=await fixture(),capture=vi.spyOn(f.gsc,'capture').mockResolvedValue(gscEvidence());f.provider.startData.mockRejectedValueOnce(new Error('synthetic connection failure'));
  expect((await f.post('/api/account/data-start')).status).toBe(400);expect(f.runtime.gscSync.status().paused).toBe(false);
  expect((await f.post('/api/gsc/sync',{filters:syncFilters,force:true})).status).toBe(200);
  f.provider.signOut.mockRejectedValueOnce(new Error('synthetic encrypted save failure'));expect((await f.post('/api/account/sign-out')).status).toBe(400);expect(f.runtime.gscSync.status().paused).toBe(false);
  expect((await f.post('/api/gsc/sync',{filters:syncFilters,force:true})).status).toBe(200);expect(capture).toHaveBeenCalledTimes(2);
 });
 it('does not open a late data-start result after sign-out has cancelled that launch',async()=>{
  const f=await fixture();let release!:()=>void;
  const starting=new Promise<void>(resolve=>{release=resolve;});
  f.provider.startData.mockImplementationOnce(async()=>{await starting;return {url:googleUrl,expiresAt:f.expiresAt};});
  const waiting=f.post('/api/account/data-start');await vi.waitFor(()=>expect(f.provider.startData).toHaveBeenCalledTimes(1));
  expect((await f.post('/api/account/sign-out')).status).toBe(200);release();
  const response=await waiting;expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'Google sign-in was cancelled.'});expect(f.opener).not.toHaveBeenCalled();
 });
 it('does not fall back to a legacy GSC credential after entering unified consent or after sign-out',async()=>{
  process.env.GSC_CLIENT_ID='synthetic-legacy.apps.googleusercontent.com';process.env.GSC_CLIENT_SECRET='synthetic-legacy-secret';process.env.GSC_REFRESH_TOKEN='synthetic-legacy-refresh';
  const external=vi.fn(async()=>{throw new Error('Unexpected legacy credential use');});vi.stubGlobal('fetch',external);
  const f=await fixture({defaultGsc:true});await f.post('/api/account/data-start');
  expect((await f.get('/api/gsc/sites')).status).toBe(400);expect(f.provider.dataToken).toHaveBeenCalledWith('gsc',undefined);expect(external).not.toHaveBeenCalled();
  await f.post('/api/account/sign-out');expect((await f.get('/api/gsc/sites')).status).toBe(400);expect(external).not.toHaveBeenCalled();expect(process.env.GSC_REFRESH_TOKEN).toBe('synthetic-legacy-refresh');
 });
 it('reads in the background with managed consent and explicit opt-in, preserving opt-outs across reconnects',async()=>{
  process.env.GETAUDIT_GOOGLE_DATA_MODE='managed';delete process.env.GSC_CLIENT_ID;delete process.env.GSC_REFRESH_TOKEN;
  const external=vi.fn(async(url:unknown,init?:RequestInit)=>{
   const target=String(url);if(target.endsWith('/sites'))return Response.json({siteEntry:sites});
   if(target.endsWith('/searchAnalytics/query')){const request=JSON.parse(String(init?.body)) as {dimensions:string[];startDate:string};return Response.json({rows:[{keys:request.dimensions.map(dimension=>dimension==='date'?request.startDate:dimension==='page'?'https://example.com/':dimension==='query'?'synthetic query':dimension==='device'?'DESKTOP':'usa'),clicks:2,impressions:10,ctr:0.2,position:3}]});}
   throw new Error('Unexpected external destination');
  });vi.stubGlobal('fetch',external);
  const f=await fixture({defaultGsc:true}),workspace=new GscWorkspace(f.lab),property='sc-domain:example.com';
  const save=(autoRead:boolean)=>workspace.save(randomUUID(),{property,kind:'preferences',payload:{language:'en',metric:'clicks',pageSize:25,hideSuspicious:false,autoRead}});
  await f.runtime.gscSync.tick();expect(external).not.toHaveBeenCalled();save(true);
  f.set({status:'pending'});await f.runtime.gscSync.tick();f.set({status:'signed_out'});await f.runtime.gscSync.tick();f.set({status:'signed_in',capabilities:{gsc:false,ga4:true}});await f.runtime.gscSync.tick();expect(external).not.toHaveBeenCalled();expect(f.provider.dataToken).not.toHaveBeenCalled();
  f.set({status:'signed_in',capabilities:{gsc:true,ga4:true}});await f.runtime.gscSync.tick();expect(f.lab.db.prepare('SELECT property FROM console_gsc_snapshot').all()).toEqual([{property}]);expect(f.provider.dataToken).toHaveBeenCalledWith('gsc',expect.any(AbortSignal));expect(external.mock.calls.every(([url])=>!String(url).includes('oauth2.googleapis.com/token'))).toBe(true);
  save(false);const count=external.mock.calls.length;
  await f.post('/api/account/sign-out');await f.runtime.gscSync.tick();await f.post('/api/account/data-start');f.set({status:'signed_in',sessionRevision:3,profile:{subject:'synthetic-subject-b',name:'Other',email:'other@example.test'},capabilities:{gsc:true,ga4:true}});
  await f.runtime.gscSync.tick();expect(external).toHaveBeenCalledTimes(count);expect(workspace.list(property).find(item=>item.kind==='preferences')?.payload.autoRead).toBe(false);expect(f.runtime.gscSync.status().sites.every(site=>!site.enabled)).toBe(true);
 });
 it('saves GA4 selection and returns only account-scoped report projections with no raw identity or credentials',async()=>{
  const f=await fixture();
  expect((await f.post('/api/google/selection',{brandId:f.brandId,ga4PropertyId:'properties/100'})).status).toBe(200);
  const response=await f.post('/api/ga4/report',{brandId:f.brandId,propertyId:'properties/100'});expect(response.status).toBe(200);
  const value=await response.json();expect(value.report).toMatchObject({propertyId:'properties/100',summary:values});expect(value.report.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(value.report.subject).toBeUndefined();expect(value.report.reports).toBeUndefined();expect(JSON.stringify(value)).not.toContain('synthetic-subject-a');
  expect(f.ga4Overview).toHaveBeenCalledTimes(1);expect(f.neverNetwork).not.toHaveBeenCalled();
  f.set({profile:{subject:'synthetic-subject-b',name:'Other',email:'other@example.test'},sessionRevision:2});
  expect(await (await f.get('/api/ga4/report?brandId='+f.brandId)).json()).toEqual({report:null});expect(await (await f.get('/api/google/selection?brandId='+f.brandId)).json()).toEqual({brandId:f.brandId});
 });
 it.each([
  ['capture','scope'],['capture','account'],['inspect','scope'],['inspect','account'],
 ] as const)('discards a late managed GSC %s after %s changes while preserving the earlier immutable evidence',async(kind,change)=>{
  process.env.GETAUDIT_GOOGLE_DATA_MODE='managed';
  let block=false,blocked=false,release!:()=>void,started!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),requested=new Promise<void>(resolve=>{started=resolve;});
  const external=vi.fn(async(url:unknown,init?:RequestInit)=>{
   const target=String(url);
   if(target.endsWith('/sites'))return Response.json({siteEntry:sites});
   if(target.endsWith('/searchAnalytics/query')){
    if(block&&!blocked){blocked=true;started();await held;}
    const request=JSON.parse(String(init?.body)) as {dimensions:string[]};
    return Response.json({rows:[{keys:request.dimensions.length?[request.dimensions[0]==='query'?'old-account-private-query':'https://example.com/']:[],clicks:2,impressions:10,ctr:0.2,position:3}],responseAggregationType:'byProperty'});
   }
   if(target==='https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'){
    if(block&&!blocked){blocked=true;started();await held;}
    return Response.json({inspectionResult:{inspectionResultLink:'https://search.google.com/search-console/inspect',indexStatusResult:{verdict:'PASS',coverageState:'old-account-private-index-detail'}}});
   }
   throw new Error('Unexpected external destination');
  });
  vi.stubGlobal('fetch',external);
  const f=await fixture({defaultGsc:true});
  const path=kind==='capture'?'/api/gsc/capture':'/api/gsc/inspect';
  const input=kind==='capture'?{property:'sc-domain:example.com',startDate:'2026-09-01',endDate:'2026-09-28',country:'ALL'}:{property:'sc-domain:example.com',urls:['https://example.com/']};
  const earlier=await f.post(path,input);expect(earlier.status).toBe(200);const original=await earlier.json();
  const table=kind==='capture'?'console_gsc_snapshot':'console_gsc_inspection';
  const before=f.lab.db.prepare(`SELECT id,payload,hash FROM ${table}`).all();expect(before).toHaveLength(1);
  block=true;const requestId=randomUUID(),waiting=f.post(path,input,requestId);await requested;
  if(change==='scope')f.set({capabilities:{gsc:false,ga4:true}});
  else f.set({profile:{subject:'synthetic-subject-b',name:'Other',email:'other@example.test'},sessionRevision:2});
  release();const response=await waiting;expect(response.status).toBe(400);
  const value=await response.json();expect(value.error).toContain('Google account changed');expect(JSON.stringify(value)).not.toContain('old-account-private');expect(JSON.stringify(value)).not.toContain('synthetic-memory-access');
  expect(f.lab.db.prepare(`SELECT id,payload,hash FROM ${table}`).all()).toEqual(before);
  expect(f.lab.db.prepare('SELECT id FROM console_command WHERE id=?').get(requestId)).toBeUndefined();
  expect(original.hash).toMatch(/^[a-f0-9]{64}$/);expect(external.mock.calls.some(([url])=>String(url)==='https://oauth2.googleapis.com/token')).toBe(false);
 });
});
