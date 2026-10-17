import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {GscConnector} from '../../src/console/gsc.ts';
import type {GscSnapshot,GscRow} from '../../src/console/gsc.ts';
import {GscWorkspace} from '../../src/console/gsc-workspace.ts';
import {KeywordAudit} from '../../src/console/keyword-audit.ts';
import type {KeywordAuditJob} from '../../src/console/keyword-audit.ts';
import {AgentMcp,agentMcpTools} from '../../src/console/agent-mcp.ts';
import {canonicalJson,sha256} from '../../src/lib/canonical-json.ts';
import {surfaces} from '../../src/console/contracts.ts';
const open:LabService[]=[];
afterEach(()=>{for(const lab of open.splice(0))lab.db.close();});
const day=(n:number)=>new Date(Date.parse('2026-06-03')+n*86400000).toISOString().slice(0,10);
const metric=(keys:string[],position=35):GscRow=>({keys,position,impressions:10,clicks:0,ctr:0});
function setup(){
 const lab=new LabService(connectLedger(':memory:'));open.push(lab);
 const send=vi.fn(async()=>{throw new Error('Readonly Agent tools must never use a provider');});
 const gsc=new GscConnector(lab,send as typeof fetch),workspace=new GscWorkspace(lab),audit=new KeywordAudit(lab,gsc,send as typeof fetch),mcp=new AgentMcp(lab,gsc,workspace,audit);
 const brandId=lab.createBrand(randomUUID(),{name:'Synthetic brand',aliases:[],ownedDomains:['sample-agency.example']}).id;
 const otherId=lab.createBrand(randomUUID(),{name:'Other private customer',aliases:[],ownedDomains:['sample-studio.example']}).id;
 const save=(property='sc-domain:sample-agency.example',positions:Record<string,number>={'stalled query':35,'opportunity query':15},overrides:Partial<GscSnapshot>={})=>{
  const snapshot:GscSnapshot={id:randomUUID(),property,capturedAt:'2026-10-03T12:00:00Z',startDate:day(0),endDate:day(119),country:'CAN',device:'DESKTOP',type:'web',dataState:'final',timeZone:'America/Los_Angeles',source:'Synthetic frozen GSC',totals:null,queries:Object.entries(positions).map(([q,p])=>metric([q],p)),pages:[],queryPages:Object.entries(positions).map(([q,p])=>metric([q,`https://${property.slice(10)}/guide`],p)),queryDaily:Object.entries(positions).flatMap(([q,p])=>Array.from({length:120},(_,n)=>metric([day(n),q],p))),requests:[{dimensions:['query'],private:'do-not-export-raw'}],raw:[{private:'do-not-export-raw'}],limitations:[],...overrides};
  const hash=sha256(canonicalJson(snapshot));lab.db.prepare('INSERT INTO console_gsc_snapshot VALUES(?,?,?,?,?)').run(snapshot.id,snapshot.capturedAt,property,canonicalJson(snapshot),hash);return {snapshot,hash};
 };
 const evidence=save(),foreign=save('sc-domain:sample-studio.example');
 const makePlan=(id=brandId)=>{
  const setId=lab.createSet(randomUUID(),{brandId:id,label:'Original prompt label 原始',source:'Synthetic questions',locale:'en-CA',kind:'hypothesis',prompts:[{text:'Which restaurant scheduling tool?',intent:'discovery'}]}).id;lab.freeze(randomUUID(),setId);
  return lab.createPlan(randomUUID(),{promptSetId:setId,label:'Saved GEO',surfaces:['bing_copilot','grok'],accountMode:'isolated',country:'CA',locale:'en-CA',timezone:'UTC',device:'desktop',windows:[new Date().toISOString().slice(0,10)]}).id;
 };
 const savedAudit=()=>{
  const input={snapshotId:evidence.snapshot.id,brandId,countryCode:2124,languageCode:'en',device:'desktop' as const,provider:'openai' as const,model:'synthetic-model'},preview=audit.preview(input),frozen={input,preview},id=randomUUID(),now=new Date().toISOString();
  const payload:Omit<KeywordAuditJob,'reportHash'>={id,brandId,status:'partial',createdAt:now,updatedAt:now,input,inputHash:sha256(canonicalJson(frozen)),preview,keywords:preview.keywords.map(k=>({...k,serp:null,ownerEvidence:null,competitorEvidence:[],analysis:null})),warnings:preview.warnings,requests:{serp:0,pages:0,llm:0},completion:{keywords:0,competitorSlots:0,comparisons:0,targetKeywords:5,targetComparisons:15}};
  const job={...payload,reportHash:sha256(canonicalJson(payload))};lab.db.prepare('INSERT INTO console_keyword_audit_job VALUES(?,?,?,?,?,?,?,?)').run(id,brandId,canonicalJson(frozen),payload.inputHash,'partial',now,now,canonicalJson(job));return job;
 };
 return {lab,gsc,workspace,audit,mcp,brandId,otherId,evidence,foreign,save,makePlan,savedAudit,send,access:{allowedBrandIds:[brandId]}};
}
const call=(mcp:AgentMcp,name:string,args:unknown,access:Parameters<AgentMcp['respond']>[1]={})=>mcp.respond({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},access) as any;
describe('read-only Agent audit MCP',()=>{
 it('supports MCP initialization, structured data and only readonly tools',()=>{
  const f=setup(),init=f.mcp.respond({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'Synthetic Agent',version:'1'},capabilities:{}}}) as any;
  expect(init.result.serverInfo.name).toBe('getaudit-agent');expect(init.result.instructions).toContain('untrusted');expect(init.result.instructions).toContain('This key is read-only.');
  const writeInit=f.mcp.respond({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'Synthetic Agent',version:'1'},capabilities:{}}},{canSaveAnalysis:true}) as any;expect(writeInit.result.instructions).toContain('This key may append generated analyses');
  expect(agentMcpTools.map(t=>t.name)).toEqual(expect.arrayContaining(['getgeo_projects','getgeo_gsc_snapshots','getgeo_keyword_health','getgeo_geo_evidence','getgeo_competitor_audits','getgeo_audit_context','getgeo_saved_analyses','getgeo_save_analysis']));
  for(const tool of agentMcpTools)expect(tool.annotations).toEqual({readOnlyHint:tool.name!=='getgeo_save_analysis',destructiveHint:false,idempotentHint:true,openWorldHint:false});
  const result=call(f.mcp,'getgeo_projects',{},f.access);expect(result.result.isError).toBe(false);expect(JSON.parse(result.result.content[0].text)).toEqual(result.result.structuredContent);
 });
 it('filters project inventory by key binding and an empty binding denies everything',()=>{
  const f=setup(),result=f.mcp.read('getgeo_projects',{},f.access) as any;
  expect(result.rows.map((row:any)=>row.id)).toEqual([f.brandId]);expect(JSON.stringify(result)).not.toContain('Other private customer');
  expect((f.mcp.read('getgeo_projects',{}, {allowedBrandIds:[]}) as any).rows).toEqual([]);
 });
 it('rejects cross-project IDs before reading data and does not reveal whether they exist',()=>{
  const f=setup();for(const args of [{brandId:f.otherId,snapshotId:f.foreign.snapshot.id},{brandId:f.brandId,snapshotId:f.foreign.snapshot.id}]){
   const response=call(f.mcp,'getgeo_keyword_health',args,f.access);expect(response.result.isError).toBe(true);expect(response.result.content[0].text).toContain('outside this key');expect(JSON.stringify(response)).not.toContain('sampleshift');
  }
  expect(()=>f.mcp.read('getgeo_gsc_snapshots',{brandId:f.brandId,property:'sc-domain:sample-studio.example'},f.access)).toThrow('outside this key');
 });
 it('rejects domain suffix tricks and does not infer ownership from brand display names',()=>{
  const f=setup(),evil=f.save('sc-domain:sample-agency.example.evil.example');expect(()=>f.mcp.read('getgeo_keyword_health',{brandId:f.brandId,snapshotId:evil.snapshot.id},f.access)).toThrow('outside this key');
 });
 it('returns bounded health rows with frozen hashes, three-window evidence and opportunity shortfall',()=>{
  const f=setup(),r=f.mcp.read('getgeo_keyword_health',{brandId:f.brandId,snapshotId:f.evidence.snapshot.id,state:'stagnant',limit:1},f.access) as any;
  expect(r.evidence).toMatchObject({hash:f.evidence.hash,country:'CAN',device:'DESKTOP',property:'sc-domain:sample-agency.example'});expect(r.rows[0]).toMatchObject({keyword:'stalled query',state:'stagnant',current:{position:35},age:{basis:'observed',days:120,publishedAt:null}});expect(r.opportunityShortfall).toBe(4);expect(r.summary.opportunity).toBe(1);
  expect(JSON.stringify(r)).not.toContain('do-not-export-raw');expect(r.limitations.join(' ')).toContain('not current organic SERP');
 });
 it('requires exact requested source country and device instead of simulating them',()=>{
  const f=setup();for(const filters of [{country:'USA'},{device:'MOBILE'}])expect(()=>f.mcp.read('getgeo_keyword_health',{brandId:f.brandId,snapshotId:f.evidence.snapshot.id,...filters},f.access)).toThrow('does not match');
  expect((f.mcp.read('getgeo_gsc_snapshots',{brandId:f.brandId,country:'USA'},f.access) as any).rows).toHaveLength(0);
 });
 it('retains missing-history uncertainty rather than calling a new query stagnant',()=>{
  const f=setup(),e=f.save('sc-domain:sample-agency.example',{'new query':35},{startDate:day(92),queryDaily:Array.from({length:28},(_,n)=>metric([day(n+92),'new query']))}),r=f.mcp.read('getgeo_keyword_health',{brandId:f.brandId,snapshotId:e.snapshot.id},f.access) as any;
  expect(r.rows[0].state).toBe('early');expect(r.rows[0].age.days).toBe(28);expect(r.summary.stagnant).toBe(0);
 });
 it('verifies frozen GSC content before returning any analysis',()=>{
  const f=setup();f.lab.db.exec('DROP TRIGGER console_gsc_snapshot_immutable_update');f.lab.db.prepare('UPDATE console_gsc_snapshot SET hash=? WHERE id=?').run('0'.repeat(64),f.evidence.snapshot.id);
  const r=call(f.mcp,'getgeo_keyword_health',{brandId:f.brandId,snapshotId:f.evidence.snapshot.id},f.access);expect(r.result.isError).toBe(true);expect(r.result.content[0].text).toContain('could not be verified');expect(JSON.stringify(r)).not.toContain('stalled query');
 });
 it('keeps GEO login and CAPTCHA coverage separate from absence and never opens a provider',()=>{
  const f=setup(),planId=f.makePlan();for(const slot of f.lab.plan(planId).slots)f.lab.capture(randomUUID(),{slotId:slot.id,prompt:slot.prompt,observedAt:new Date().toISOString(),status:'unavailable',restriction:slot.surface==='grok'?'captcha':'login',reason:'Synthetic access restriction',answer:'',citations:[],sourceUrl:surfaces[slot.surface].url,model:'unknown',account:'unknown',session:'unknown',exitCountry:null,geo:'unverified',locale:'en-CA',timezone:'UTC',device:'desktop',geolocation:'denied',searchMode:surfaces[slot.surface].mode,collectionMode:'browser_capture',retrievalUsed:null,artifact:{mime:'text/plain',base64:Buffer.from('Synthetic access evidence').toString('base64')}});
  const r=f.mcp.read('getgeo_geo_evidence',{brandId:f.brandId,planId},f.access) as any;
  expect(r.complete).toBe(false);expect(r.integrity.verified).toBe(true);expect(r.coverage).toHaveLength(2);expect(r.coverage.every((g:any)=>g.eligible===0&&g.unavailable===1)).toBe(true);expect(r.records.rows.map((r:any)=>r.brandMentioned)).toEqual([null,null]);expect(r.records.rows.every((r:any)=>r.evidenceHash.length===64)).toBe(true);expect(JSON.stringify(r)).not.toContain('base64');expect(f.send).not.toHaveBeenCalled();
 });
 it('denies a foreign plan even if a permitted project ID is supplied',()=>{
  const f=setup(),planId=f.makePlan(f.otherId);expect(()=>f.mcp.read('getgeo_geo_evidence',{brandId:f.brandId,planId},f.access)).toThrow('outside this key');
 });
 it('checks plan and frozen-question hashes even before any capture exists',()=>{
  const f=setup(),planId=f.makePlan();f.lab.db.exec('DROP TRIGGER console_plan_immutable_UPDATE');f.lab.db.prepare('UPDATE console_plan SET config_hash=? WHERE id=?').run('0'.repeat(64),planId);
  expect(()=>f.mcp.read('getgeo_geo_evidence',{brandId:f.brandId,planId},f.access)).toThrow('could not be verified');
 });
 it('does not pool GEO plans when preparing Agent context and gives actionable evidence-bound triage',()=>{
  const f=setup();f.makePlan();const r=f.mcp.read('getgeo_audit_context',{brandId:f.brandId},f.access) as any;
  expect(r.mode).toBe('read_only_agent_context');expect(r.evidenceSelection).toMatchObject({snapshotId:f.evidence.snapshot.id,snapshotSelection:'latest_matching_frozen_snapshot',availableGeoPlans:1,geoPlanId:null});expect(r.geo).toBeNull();expect(r.complete).toBe(false);expect(r.seo.opportunities.shortfall).toBe(4);expect(r.actions[0]).toMatchObject({kind:'stagnant',targetUrl:'https://sample-agency.example/guide',evidence:{hash:f.evidence.hash}});for(const action of r.actions){expect(action.acceptance).toBeTruthy();expect(action.measurement).toContain('GSC');}expect(r.unknowns.join(' ')).toContain('unverified');
 });
 it('reports no evidence honestly when a permitted project has no matching data',()=>{
  const f=setup(),r=f.mcp.read('getgeo_audit_context',{brandId:f.brandId,country:'USA'},f.access) as any;expect(r.seo).toBeNull();expect(r.actions).toEqual([]);expect(r.complete).toBe(false);expect(r.unknowns.join(' ')).toContain('No matching verified GSC');
 });
 it('reads saved partial competitor jobs without dispatching paid work and keeps missing slots',()=>{
  const f=setup(),job=f.savedAudit(),r=f.mcp.read('getgeo_competitor_audits',{brandId:f.brandId,auditId:job.id},f.access) as any;
  expect(r.status).toBe('partial');expect(r.completion.comparisons).toBe(0);expect(r.shortfall).toBe(4);expect(r.reportHash).toBe(job.reportHash);expect(r.keywords.rows[0].gscAveragePosition).toBe(15);expect(r.keywords.rows[0].analysis).toBeNull();expect(f.send).not.toHaveBeenCalled();
 });
 it('denies saved audit IDs belonging to another project and rejects corrupted reports',()=>{
  const f=setup(),job=f.savedAudit();expect(()=>f.mcp.read('getgeo_competitor_audits',{brandId:f.otherId,auditId:job.id},{allowedBrandIds:[f.otherId]})).toThrow('outside this key');
  f.lab.db.exec('DROP TRIGGER console_keyword_audit_inputs_immutable');f.lab.db.prepare('UPDATE console_keyword_audit_job SET result_json=? WHERE id=?').run(JSON.stringify({...job,reportHash:'0'.repeat(64)}),job.id);expect(()=>f.mcp.read('getgeo_competitor_audits',{brandId:f.brandId,auditId:job.id},f.access)).toThrow('could not be verified');
 });
 it('does not accept client-supplied access scopes or unbounded pagination',()=>{
  const f=setup();for(const args of [{brandId:f.brandId,snapshotId:f.evidence.snapshot.id,limit:101},{brandId:f.brandId,snapshotId:f.evidence.snapshot.id,offset:-1},{brandId:f.brandId,snapshotId:f.evidence.snapshot.id,allowedBrandIds:[f.otherId]}])expect(call(f.mcp,'getgeo_keyword_health',args,f.access).result.isError).toBe(true);
 });
 it('handles malformed JSON-RPC and unsupported methods without leaking internal exceptions',()=>{
  const f=setup();expect((f.mcp.respond({jsonrpc:'2.0',method:'tools/list',unexpected:true}) as any).error.code).toBe(-32600);expect((f.mcp.respond({jsonrpc:'2.0',id:2,method:'resources/write'}) as any).error.code).toBe(-32601);expect(f.mcp.respond({jsonrpc:'2.0',method:'notifications/initialized'})).toBeNull();expect(call(f.mcp,'provider_resume',{},f.access).result.isError).toBe(true);
 });
 it('redacts private filesystem paths and recognizable credentials from exported derivative text',()=>{
  const f=setup(),e=f.save('sc-domain:sample-agency.example',{'/Users/synthetic-user/notes sk-secretcredential1234567':15});const r=f.mcp.read('getgeo_keyword_health',{brandId:f.brandId,snapshotId:e.snapshot.id},f.access);expect(JSON.stringify(r)).not.toContain('/Users/synthetic-user');expect(JSON.stringify(r)).not.toContain('sk-secretcredential');expect(JSON.stringify(r)).toContain('[redacted credential]');
 });
 it('rejects oversized payloads and lets callers retrieve a smaller page',()=>{
  const f=setup(),positions=Object.fromEntries(Array.from({length:100},(_,n)=>['query '+n+' '+('x'.repeat(2200)),15])),e=f.save('sc-domain:sample-agency.example',positions);
  expect(()=>f.mcp.read('getgeo_keyword_health',{brandId:f.brandId,snapshotId:e.snapshot.id,limit:100},f.access)).toThrow('128 KiB');expect((f.mcp.read('getgeo_keyword_health',{brandId:f.brandId,snapshotId:e.snapshot.id,limit:1},f.access) as any).rows).toHaveLength(1);
 });
 it('verifies only the requested GSC page and the selected context snapshot, not unrelated history',()=>{
  const f=setup();for(let n=0;n<30;n++)f.save();const saved=vi.spyOn(f.gsc,'saved');
  const page=f.mcp.read('getgeo_gsc_snapshots',{brandId:f.brandId,offset:3,limit:2},f.access) as any;
  expect(page.rows).toHaveLength(2);expect(page.total).toBe(31);expect(page.scan.verifiedSnapshots).toBe(2);expect(saved).toHaveBeenCalledTimes(2);
  saved.mockClear();const context=f.mcp.read('getgeo_audit_context',{brandId:f.brandId},f.access) as any;
  expect(context.evidenceSelection.snapshotScan.verifiedSnapshots).toBe(1);expect(saved).toHaveBeenCalledTimes(2); // Selected metadata + health, no full-history parsing.
 });
 it('rejects model comparisons whose page content hashes or paired quotations cannot be verified',()=>{
  const f=setup(),job=f.savedAudit(),payload=JSON.parse(JSON.stringify(job));delete payload.reportHash;
  payload.keywords[0].ownerEvidence={id:'owner-source',url:'https://sample-agency.example/guide',resolvedUrl:'https://sample-agency.example/guide',observedAt:job.createdAt,status:'available',title:'Saved title',headings:[],body:'Saved source body',excerpt:'Saved source excerpt',limitations:[],hash:'0'.repeat(64)};
  const tampered={...payload,reportHash:sha256(canonicalJson(payload))};f.lab.db.exec('DROP TRIGGER console_keyword_audit_inputs_immutable');f.lab.db.prepare('UPDATE console_keyword_audit_job SET result_json=? WHERE id=?').run(canonicalJson(tampered),job.id);
  expect(()=>f.mcp.read('getgeo_competitor_audits',{brandId:f.brandId,auditId:job.id},f.access)).toThrow('could not be verified');
 });
 it('advertises analysis saving only for explicitly enabled keys and rejects client permission escalation',()=>{
  const f=setup(),list=(access:any)=>(f.mcp.respond({jsonrpc:'2.0',id:1,method:'tools/list'},access) as any).result.tools;
  expect(list(f.access).some((tool:any)=>tool.name==='getgeo_save_analysis')).toBe(false);
  expect(list({...f.access,canSaveAnalysis:true}).find((tool:any)=>tool.name==='getgeo_save_analysis').annotations.readOnlyHint).toBe(false);
  const save=call(f.mcp,'getgeo_save_analysis',{canSaveAnalysis:true},f.access);expect(save.result.isError).toBe(true);expect(save.result.content[0].text).toContain('permission');
  expect((f.lab.db.prepare('SELECT COUNT(*) n FROM console_agent_analysis').get() as any).n).toBe(0);
 });
 it('appends a scoped Agent analysis only after verifying the source hash, with idempotent retry and no provider call',()=>{
  const f=setup(),input={requestId:randomUUID(),brandId:f.brandId,title:'Review a stalled page',summary:'The saved query trajectory supports investigation; the cause is unknown.',gaps:['No current competitor comparison is available.'],actions:[{priority:'high',targetUrl:'https://sample-agency.example/guide',action:'Review the guide',reason:'Saved query history is flat.',acceptance:'Record supported edits.',measurement:'Compare the next final28day GSC window.'}],sourceRefs:[{kind:'gsc_snapshot',id:f.evidence.snapshot.id,hash:f.evidence.hash}],model:'Agent-declared-model',provider:'Agent-declared-provider'},access={...f.access,canSaveAnalysis:true};
  const first=f.mcp.read('getgeo_save_analysis',input,access) as any,second=f.mcp.read('getgeo_save_analysis',input,access) as any;
  expect(first.id).toBe(second.id);expect(first).toMatchObject({classification:'agent_generated_analysis',sourceVerification:'verified_at_save',providerDisclosure:'agent_declared_not_independently_verified'});
  expect((f.mcp.read('getgeo_saved_analyses',{brandId:f.brandId},f.access) as any).rows[0].id).toBe(first.id);expect(f.send).not.toHaveBeenCalled();
  expect(()=>f.mcp.read('getgeo_save_analysis',{...input,requestId:randomUUID(),sourceRefs:[{...input.sourceRefs[0],hash:'0'.repeat(64)}]},access)).toThrow('does not match');
  expect(()=>f.mcp.read('getgeo_save_analysis',{...input,requestId:randomUUID(),sourceRefs:[{kind:'gsc_snapshot',id:f.foreign.snapshot.id,hash:f.foreign.hash}]},access)).toThrow('outside this key');
  expect(()=>f.mcp.read('getgeo_saved_analyses',{brandId:f.otherId},f.access)).toThrow('outside this key');
 });
 it('validates GEO report and saved competitor report refs, preserving historical source hashes on later reads',()=>{
  const f=setup(),planId=f.makePlan(),geo=f.mcp.read('getgeo_geo_evidence',{brandId:f.brandId,planId},f.access) as any,job=f.savedAudit();
  const input={requestId:randomUUID(),brandId:f.brandId,title:'Incomplete source coverage',summary:'Evidence is incomplete; collect comparable observations before conclusions.',gaps:['The GEO slots are pending.','Only one11–20 keyword qualifies.'],actions:[],sourceRefs:[{kind:'geo_plan',id:planId,hash:geo.reportHash},{kind:'keyword_audit',id:job.id,hash:job.reportHash}]},access={...f.access,canSaveAnalysis:true};
  const r=f.mcp.read('getgeo_save_analysis',input,access) as any;expect(r.sourceRefs).toHaveLength(2);expect(r.classification).toBe('agent_generated_analysis');
  expect(()=>f.mcp.read('getgeo_save_analysis',{...input,requestId:randomUUID(),sourceRefs:[{kind:'geo_plan',id:planId,hash:'0'.repeat(64)}]},access)).toThrow('does not match');
 });
 it('all inventory and context tools leave every table unchanged and never call external services',()=>{
  const f=setup(),planId=f.makePlan(),job=f.savedAudit(),counts=()=>f.lab.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>[row.name,(f.lab.db.prepare('SELECT COUNT(*) n FROM "'+row.name+'"').get() as any).n]),before=counts();
  for(const [name,args] of [['getgeo_projects',{}],['getgeo_saved_analyses',{brandId:f.brandId}],['getgeo_gsc_snapshots',{brandId:f.brandId}],['getgeo_keyword_health',{brandId:f.brandId,snapshotId:f.evidence.snapshot.id}],['getgeo_geo_evidence',{brandId:f.brandId,planId}],['getgeo_competitor_audits',{brandId:f.brandId,auditId:job.id}],['getgeo_audit_context',{brandId:f.brandId,planId,auditId:job.id}]] as const)f.mcp.read(name,args,f.access);
  expect(counts()).toEqual(before);expect(f.send).not.toHaveBeenCalled();expect(f.audit.active.size).toBe(0);
 });
});
