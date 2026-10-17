import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {GscConnector} from '../../src/console/gsc.ts';
import type {GscSnapshot} from '../../src/console/gsc.ts';
import {serveConsole} from '../../src/console/server.ts';
import {canonicalJson,sha256} from '../../src/lib/canonical-json.ts';
type Runtime=Awaited<ReturnType<typeof serveConsole>>;
const open:{runtime:Runtime;lab:LabService}[]=[];
afterEach(async()=>{
 for(const f of open.splice(0)){await f.runtime.keywordAudit.stop();await f.runtime.browserJobs.pauseAll();await f.runtime.gscSync.stop();f.runtime.server.closeAllConnections();await new Promise<void>(done=>f.runtime.server.close(()=>done()));f.lab.db.close();}
 vi.unstubAllEnvs();
});
async function fixture(){
 const lab=new LabService(connectLedger(':memory:'));
 const provider=vi.fn(async()=>{throw new Error('Synthetic Agent HTTP tests must not call external providers');});
 const gsc=new GscConnector(lab,provider as typeof fetch);let mutable=true;
 const runtime=await serveConsole(lab,{gscConnector:gsc,keywordAuditFetcher:provider as typeof fetch,canMutate:()=>mutable});open.push({runtime,lab});
 const brandId=lab.createBrand(randomUUID(),{name:'Synthetic customer A',ownedDomains:['first.example'],aliases:[]}).id;
 const otherId=lab.createBrand(randomUUID(),{name:'Synthetic customer B',ownedDomains:['second.example'],aliases:[]}).id;
 const freeze=(property:string)=>{
  const snapshot:GscSnapshot={id:randomUUID(),property,capturedAt:'2026-10-03T12:00:00Z',startDate:'2026-09-03',endDate:'2026-09-30',country:'CAN',device:'DESKTOP',type:'web',dataState:'final',timeZone:'America/Los_Angeles',source:'Synthetic GSC HTTP fixture',totals:null,queries:[{keys:['synthetic keyword'],position:15,impressions:100,clicks:0,ctr:0}],pages:[],queryPages:[{keys:['synthetic keyword',`https://${property.slice(10)}/guide`],position:15,impressions:100,clicks:0,ctr:0}],raw:[{secret:'raw-provider-data-not-exported'}],requests:[],limitations:[]};
  const hash=sha256(canonicalJson(snapshot));lab.db.prepare('INSERT INTO console_gsc_snapshot VALUES(?,?,?,?,?)').run(snapshot.id,snapshot.capturedAt,property,canonicalJson(snapshot),hash);return {id:snapshot.id,hash};
 };
 const source=freeze('sc-domain:first.example'),foreign=freeze('sc-domain:second.example');
 const key=runtime.agentKeys.create(randomUUID(),{label:'Synthetic read-only Agent',brandIds:[brandId]}).key!;
 const writeKey=runtime.agentKeys.create(randomUUID(),{label:'Synthetic analysis Agent',brandIds:[brandId],canSaveAnalysis:true}).key!;
 const analysis=(extra:Record<string,unknown>={})=>({requestId:randomUUID(),brandId,title:'Investigate an opportunity',summary:'A synthetic Agent recommendation with an explicit evidence boundary.',gaps:['Current competitor pages have not been inspected.'],actions:[{priority:'medium',targetUrl:'https://first.example/guide',action:'Inspect current competitors.',reason:'The dated query average is within11–20.',acceptance:'Record three external organic pages and their real ranks.',measurement:'Compare the next final GSC window under matching source conditions.'}],sourceRefs:[{kind:'gsc_snapshot',id:source.id,hash:source.hash}],provider:'Synthetic Agent declaration',model:'Synthetic declared model',...extra});
 return {lab,runtime,brandId,otherId,source,foreign,key,writeKey,provider,analysis,setMutable:(value:boolean)=>{mutable=value;}};
}
function owner(f:Awaited<ReturnType<typeof fixture>>,path:string,input:unknown={},requestId=randomUUID()){
 return fetch(f.runtime.origin+path,{method:'POST',headers:{Authorization:'Bearer '+f.runtime.token,'Content-Type':'application/json'},body:JSON.stringify({requestId,input})});
}
function rpc(f:Awaited<ReturnType<typeof fixture>>,key:string|undefined,body:unknown,headers:Record<string,string>={}){
 return fetch(f.runtime.origin+'/agent/mcp',{method:'POST',headers:{...(key?{Authorization:'Bearer '+key}:{}),'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
}
const tool=(name:string,args:unknown={})=>({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
const list={jsonrpc:'2.0',id:1,method:'tools/list'};

describe('scoped Agent credentials and audit HTTP integration',()=>{
 it('keeps Console, scoped Agent and legacy GSC credentials separate',async()=>{
  const f=await fixture(),legacy='synthetic-legacy-gsc-credential';vi.stubEnv('GSC_MCP_KEY',legacy);
  expect((await rpc(f,undefined,list)).status).toBe(401);expect((await rpc(f,f.runtime.token,list)).status).toBe(401);expect((await rpc(f,legacy,list)).status).toBe(401);
  const scoped=await rpc(f,f.key,tool('getgeo_projects'));expect(scoped.status).toBe(200);const result=await scoped.json();expect(result.result.structuredContent.rows.map((row:any)=>row.id)).toEqual([f.brandId]);
  for(const path of ['/api/state','/api/agent/keys','/api/agent/context?brandId='+f.brandId,'/api/agent/analyses?brandId='+f.brandId])expect((await fetch(f.runtime.origin+path,{headers:{Authorization:'Bearer '+f.key}})).status).toBe(401);
  expect((await fetch(f.runtime.origin+'/gsc/mcp',{method:'POST',headers:{Authorization:'Bearer '+f.key,'Content-Type':'application/json'},body:JSON.stringify(list)})).status).toBe(401);
  expect((await fetch(f.runtime.origin+'/gsc/mcp',{method:'POST',headers:{Authorization:'Bearer '+legacy,'Content-Type':'application/json'},body:JSON.stringify(list)})).status).toBe(200);
  expect(f.provider).not.toHaveBeenCalled();
 });
 it('requires owner authentication to create or revoke keys and does not expose raw stored keys',async()=>{
  const f=await fixture();
  const invalid=await fetch(f.runtime.origin+'/api/agent/key-create',{method:'POST',headers:{Authorization:'Bearer '+f.key,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),input:{label:'Escalation attempt',brandIds:[f.otherId],canSaveAnalysis:true}})});expect(invalid.status).toBe(401);
  const requestId=randomUUID(),created=await (await owner(f,'/api/agent/key-create',{label:'Owned key',brandIds:[f.brandId]},requestId)).json();expect(created.key).toMatch(/^gg_/);expect(created.canSaveAnalysis).toBe(false);
  const replay=await (await owner(f,'/api/agent/key-create',{label:'Owned key',brandIds:[f.brandId]},requestId)).json();expect(replay).toMatchObject({id:created.id,key:null,shownOnce:true});
  const keys=await (await fetch(f.runtime.origin+'/api/agent/keys',{headers:{Authorization:'Bearer '+f.runtime.token}})).json();expect(keys.url).toBe(f.runtime.origin+'/agent/mcp');expect(JSON.stringify(keys)).not.toContain(created.key);expect(JSON.stringify(keys)).not.toContain(f.key);expect(JSON.stringify(keys)).not.toContain('token_hash');
 });
 it('blocks project B and foreign snapshot IDs even when project A is in the request',async()=>{
  const f=await fixture();for(const args of [{brandId:f.otherId,snapshotId:f.foreign.id},{brandId:f.brandId,snapshotId:f.foreign.id}]){
   const response=await rpc(f,f.key,tool('getgeo_keyword_health',args));expect(response.status).toBe(200);const body=await response.json();expect(body.result.isError).toBe(true);expect(body.result.content[0].text).toContain('outside this key');expect(JSON.stringify(body)).not.toContain('second.example');
  }
  const allowed=await (await rpc(f,f.key,tool('getgeo_keyword_health',{brandId:f.brandId,snapshotId:f.source.id}))).json();expect(allowed.result.isError).toBe(false);expect(allowed.result.structuredContent.evidence.hash).toBe(f.source.hash);expect(JSON.stringify(allowed)).not.toContain('raw-provider-data-not-exported');
 });
 it('advertises no save tool to readonly keys and rejects explicit save calls without an analysis write',async()=>{
  const f=await fixture(),before=Number(f.lab.db.prepare('SELECT COUNT(*) n FROM console_agent_analysis').get()?.n);
  const tools=await (await rpc(f,f.key,list)).json();expect(tools.result.tools.some((item:any)=>item.name==='getgeo_save_analysis')).toBe(false);
  const response=await (await rpc(f,f.key,tool('getgeo_save_analysis',f.analysis()))).json();expect(response.result.isError).toBe(true);expect(response.result.content[0].text).toContain('permission');expect(Number(f.lab.db.prepare('SELECT COUNT(*) n FROM console_agent_analysis').get()?.n)).toBe(before);
  const escalation=await (await rpc(f,f.key,tool('getgeo_save_analysis',{...f.analysis(),canSaveAnalysis:true}))).json();expect(escalation.result.isError).toBe(true);
 });
 it('round-trips an authorized analysis through MCP into the owner interface with hashes and source boundaries',async()=>{
  const f=await fixture(),input=f.analysis(),tools=await (await rpc(f,f.writeKey,list)).json();expect(tools.result.tools.find((item:any)=>item.name==='getgeo_save_analysis').annotations.readOnlyHint).toBe(false);
  const saved=await (await rpc(f,f.writeKey,tool('getgeo_save_analysis',input))).json();expect(saved.result.isError).toBe(false);const analysis=saved.result.structuredContent;expect(analysis).toMatchObject({brandId:f.brandId,title:input.title,classification:'agent_generated_analysis',sourceVerification:'verified_at_save',providerDisclosure:'agent_declared_not_independently_verified'});expect(analysis.contentHash).toMatch(/^[a-f0-9]{64}$/);
  const replay=await (await rpc(f,f.writeKey,tool('getgeo_save_analysis',input))).json();expect(replay.result.structuredContent.id).toBe(analysis.id);
  const ownerRows=await (await fetch(f.runtime.origin+'/api/agent/analyses?brandId='+f.brandId,{headers:{Authorization:'Bearer '+f.runtime.token}})).json();expect(ownerRows.rows[0].id).toBe(analysis.id);expect(ownerRows.rows[0].sourceRefs).toEqual(input.sourceRefs);expect(ownerRows.total).toBe(1);
  const scopedRows=await (await rpc(f,f.key,tool('getgeo_saved_analyses',{brandId:f.brandId}))).json();expect(scopedRows.result.structuredContent.rows[0].id).toBe(analysis.id);expect(f.provider).not.toHaveBeenCalled();
  expect(Number(f.lab.db.prepare('SELECT COUNT(*) n FROM console_attempt').get()?.n)).toBe(0);expect(Number(f.lab.db.prepare('SELECT COUNT(*) n FROM console_plan').get()?.n)).toBe(0);
 });
 it('returns only the newest analysis by default in the owner interface',async()=>{
  const f=await fixture();for(const title of ['Earlier recommendation','Latest recommendation'])expect((await (await rpc(f,f.writeKey,tool('getgeo_save_analysis',f.analysis({title})))).json()).result.isError).toBe(false);
  const rows=await (await fetch(f.runtime.origin+'/api/agent/analyses?brandId='+f.brandId,{headers:{Authorization:'Bearer '+f.runtime.token}})).json();expect(rows.total).toBe(2);expect(rows.rows).toHaveLength(1);expect(rows.rows[0].title).toBe('Latest recommendation');expect(rows.nextOffset).toBe(1);
 });
 it('revokes a key immediately while preserving history and allows no scoped key administration',async()=>{
  const f=await fixture(),info=f.runtime.agentKeys.list().find(row=>row.label==='Synthetic read-only Agent')!;
  expect((await fetch(f.runtime.origin+'/api/agent/key-revoke',{method:'POST',headers:{Authorization:'Bearer '+f.key,'Content-Type':'application/json'},body:JSON.stringify({requestId:randomUUID(),input:{id:info.id}})})).status).toBe(401);
  expect((await owner(f,'/api/agent/key-revoke',{id:info.id})).status).toBe(200);expect((await rpc(f,f.key,list)).status).toBe(401);expect(f.runtime.agentKeys.list().find(row=>row.id===info.id)?.revokedAt).toBeTruthy();expect((await rpc(f,f.writeKey,list)).status).toBe(200);
 });
 it('rejects foreign Origin and Host before authentication usage metadata changes',async()=>{
  const f=await fixture(),before=f.lab.db.prepare('SELECT id,last_used_at FROM console_agent_key ORDER BY id').all();
  expect((await rpc(f,f.key,list,{Origin:'https://foreign.example'})).status).toBe(403);const hostStatus=await new Promise<number>((resolve,reject)=>{const request=httpRequest(f.runtime.origin+'/agent/mcp',{method:'POST',headers:{Host:'foreign.example',Authorization:'Bearer '+f.key,'Content-Type':'application/json'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode??0));});request.on('error',reject);request.end(JSON.stringify(list));});expect(hostStatus).toBe(403);
  expect(f.lab.db.prepare('SELECT id,last_used_at FROM console_agent_key ORDER BY id').all()).toEqual(before);
 });
 it('validates protocol, content type, request size, JSON and MCP request shape',async()=>{
  const f=await fixture();expect((await rpc(f,f.key,list,{'MCP-Protocol-Version':'1999-01-01'})).status).toBe(400);
  expect((await fetch(f.runtime.origin+'/agent/mcp',{method:'POST',headers:{Authorization:'Bearer '+f.key,'Content-Type':'text/plain'},body:'hello'})).status).toBe(415);
  const get=await fetch(f.runtime.origin+'/agent/mcp',{headers:{Authorization:'Bearer '+f.key}});expect(get.status).toBe(405);expect(get.headers.get('allow')).toBe('POST');
  expect((await fetch(f.runtime.origin+'/agent/mcp',{method:'POST',headers:{Authorization:'Bearer '+f.key,'Content-Type':'application/json'},body:'{malformed'})).status).toBe(400);
  expect((await rpc(f,f.key,{...list,params:{oversized:'x'.repeat(66000)}})).status).toBe(413);
  const invalid=await (await rpc(f,f.key,{jsonrpc:'1.0',id:1,method:'tools/list'})).json();expect(invalid.error.code).toBe(-32600);
  const notification=await rpc(f,f.key,{jsonrpc:'2.0',method:'notifications/initialized'});expect(notification.status).toBe(202);expect(await notification.text()).toBe('');
 });
 it('blocks requests during ledger restoration before auth usage writes or analysis appends',async()=>{
  const f=await fixture(),beforeKeys=f.lab.db.prepare('SELECT * FROM console_agent_key ORDER BY id').all(),beforeAnalyses=f.lab.db.prepare('SELECT * FROM console_agent_analysis').all();f.setMutable(false);
  expect((await rpc(f,f.key,list)).status).toBe(503);expect((await rpc(f,f.writeKey,tool('getgeo_save_analysis',f.analysis()))).status).toBe(503);
  expect(f.lab.db.prepare('SELECT * FROM console_agent_key ORDER BY id').all()).toEqual(beforeKeys);expect(f.lab.db.prepare('SELECT * FROM console_agent_analysis').all()).toEqual(beforeAnalyses);expect(f.provider).not.toHaveBeenCalled();
  f.setMutable(true);expect((await rpc(f,f.key,list)).status).toBe(200);
 });
});
