import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {GscConnector,type GscSnapshot} from '../../src/console/gsc.ts';
import {LocalQuestions} from '../../src/console/local-questions.ts';
import {extractQuery,extractRecord,questionKey} from '../../src/console/question-extract.ts';
import {canonicalJson,sha256} from '../../src/lib/canonical-json.ts';
import {serveConsole} from '../../src/console/server.ts';
import {GscSync} from '../../src/console/gsc-sync.ts';

let root:string,lab:LabService,questions:LocalQuestions,brandId:string,otherId:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'local-questions-'));lab=new LabService(connectLedger(join(root,'ledger.db')));new GscConnector(lab);questions=new LocalQuestions(lab);brandId=lab.createBrand(randomUUID(),{name:'Sample Studio',aliases:['sampleShift'],ownedDomains:['sample-studio.example']}).id;otherId=lab.createBrand(randomUUID(),{name:'Other',aliases:[],ownedDomains:['other.example']}).id;});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();lab.db.close();rmSync(root,{recursive:true,force:true});});
function snapshot(queries:string[],extra:Partial<GscSnapshot>={}){
 const s:GscSnapshot={id:randomUUID(),property:'sc-domain:sample-studio.example',capturedAt:'2026-10-04T12:00:00Z',startDate:'2026-09-01',endDate:'2026-09-28',country:'CAN',timeZone:'America/Los_Angeles',type:'web',dataState:'final',source:'Synthetic saved GSC fixture',requests:[],raw:[],totals:null,pages:[],queries:queries.map(query=>({keys:[query],clicks:2,impressions:40,ctr:.05,position:6})),limitations:[],...extra};
 const json=canonicalJson(s);lab.db.prepare('INSERT INTO console_gsc_snapshot VALUES(?,?,?,?,?)').run(s.id,s.capturedAt,s.property,json,sha256(json));return s;
}
function collect(){questions.collect(brandId);return questions.list(brandId).questions;}

describe('offline question extraction',()=>{
 it('preserves original question text, labels rewrites, and filters navigation instead of inventing demand',()=>{
  expect(extractQuery('How can I reduce overtime?')).toMatchObject({text:'How can I reduce overtime?',derivation:'verbatim'});
  expect(extractQuery('7shifts vs Homebase')).toMatchObject({text:'How does 7shifts compare with Homebase?',derivation:'keyword_rewrite',stage:'comparison'});
  expect(extractQuery('restaurant scheduling software pricing')?.text).toBe('What does restaurant scheduling software cost, and what is included?');
  expect(extractQuery('tip calculator')).toMatchObject({derivation:'keyword_rewrite',stage:'research'});
  for(const query of ['sampleshift','sampleshift login','https://example.com','user@example.com','=1+2'])expect(extractQuery(query)).toBeNull();
  expect(questionKey(' Which tool？ ')).toBe(questionKey('which tool?'));
  expect(questionKey('C++ software?')).not.toBe(questionKey('C# software?'));
  expect(extractRecord('客户：怎么排班？\n客户：怎么排班？\nThis is a statement.\nHow much does it cost?')).toHaveLength(2);
 });
 it('uses saved GSC evidence without network, preserves linked pages, and is idempotent across restarts',()=>{
  const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network forbidden'));
  const s=snapshot(['How can I reduce overtime?',' how can i reduce overtime？','tip calculator','sampleshift login'],{queryPages:[{keys:['tip calculator','https://sample-studio.example/tip-calculator'],clicks:2,impressions:40,ctr:.05,position:6}]});
  const first=questions.collect(brandId);expect(first).toMatchObject({newCandidates:2,newEvidence:3,skipped:1,errors:[]});
  const items=questions.list(brandId).questions;expect(items.find(q=>!q.verbatim)?.evidence[0]).toMatchObject({sourceId:s.id,country:'CAN',clicks:2,impressions:40,pages:['https://sample-studio.example/tip-calculator']});
  questions=new LocalQuestions(lab);expect(questions.collect(brandId)).toMatchObject({newCandidates:0,newEvidence:0,sources:0});expect(questions.list(brandId).questions).toEqual(items);expect(questions.list(otherId).questions).toEqual([]);expect(network).not.toHaveBeenCalled();
 });
 it('keeps overlapping markets and periods as separate evidence without summing search metrics',()=>{
  const a=snapshot(['tip calculator']),b=snapshot(['tip calculator'],{country:'USA',capturedAt:'2026-10-04T13:00:00Z'});const items=collect();expect(items).toHaveLength(1);expect(items[0]?.evidence[0]?.sourceId).toBe(b.id);expect(items[0]?.evidence.map(e=>e.sourceId).sort()).toEqual([a.id,b.id].sort());expect(items[0]?.evidence.map(e=>e.impressions)).toEqual([40,40]);expect(items[0]).not.toHaveProperty('impressions');
 });
 it('does not create empty-data questions, and reports corrupted source evidence while retaining previous results',()=>{
  snapshot([]);expect(collect()).toEqual([]);snapshot(['Which scheduling tool should I choose?']);const good=collect();
  lab.db.prepare('INSERT INTO console_gsc_snapshot VALUES(?,?,?,?,?)').run(randomUUID(),'2026-10-04','sc-domain:sample-studio.example','{}','invalid');
  expect(questions.collect(brandId).errors.join()).toContain('哈希');expect(questions.list(brandId).questions).toEqual(good);
 });
 it('collects real business records and local documents but never recycles hypothesis sets as source demand',()=>{
  const create=(kind:string)=>lab.createSet(randomUUID(),{brandId,label:kind,source:'Synthetic original intake',locale:'en-CA',kind,prompts:[{text:kind==='business'?'Can I export shifts to payroll?':'Which invented option is best?',intent:'discovery'}]});
  create('business');create('hypothesis');
  const requestId=randomUUID(),input={brandId,label:'Synthetic customer notes',text:'Customer: Does it support multiple locations?\nCustomer: Does it support multiple locations?\nThis is not a question.'};
  questions.importRecord(requestId,input);questions.importRecord(requestId,input);const items=collect();expect(items).toHaveLength(2);expect(questions.list(brandId).stats.documents).toBe(1);expect(items.every(q=>q.verbatim)).toBe(true);
  const set=questions.createSet(randomUUID(),{brandId,label:'Collected draft',locale:'en-CA',ids:items.map(q=>q.id)});lab.freeze(randomUUID(),set.id);expect(questions.collect(brandId).newCandidates).toBe(0);expect(collect()).toHaveLength(2);
 });
 it('creates an atomic source-linked draft, freezes it, preserves its evidence after new sources, and rejects cross-project selection',()=>{
  snapshot(['tip calculator','How can I reduce overtime?']);const items=collect(),input={brandId,label:'Collected questions',locale:'en-CA',ids:items.map(q=>q.id)},requestId=randomUUID();
  const set=questions.createSet(requestId,input);expect(questions.createSet(requestId,input)).toEqual(set);expect(set.count).toBe(2);lab.freeze(randomUUID(),set.id);
  const linked=lab.db.prepare('SELECT cp.payload,cp.hash FROM console_question_candidate_prompt cp JOIN prompt p ON p.id=cp.prompt_id WHERE p.prompt_set_id=?').all(set.id);expect(linked).toHaveLength(2);
  snapshot(['tip calculator'],{country:'USA'});collect();expect(lab.db.prepare('SELECT cp.payload,cp.hash FROM console_question_candidate_prompt cp JOIN prompt p ON p.id=cp.prompt_id WHERE p.prompt_set_id=?').all(set.id)).toEqual(linked);
  for(const row of linked)expect(sha256(String(row.payload))).toBe(row.hash);
  expect(()=>questions.createSet(randomUUID(),{...input,brandId:otherId})).toThrow('不属于当前项目');
  expect(()=>lab.db.prepare('UPDATE console_question_candidate_prompt SET hash=?').run('tampered')).toThrow('不可修改');
  expect(()=>lab.db.prepare('DELETE FROM console_question_evidence').run()).toThrow('不可修改');
  const markdown=questions.markdown({brandId,ids:items.map(q=>q.id)}).text;expect(markdown).toContain('tip calculator');expect(markdown).toContain('关键词改写');expect(markdown).toContain('SHA-256');expect(markdown).toContain('CAN');expect(markdown).toContain('USA');
 });
 it('keeps deleted projects unavailable and reports documents containing no extractable questions',()=>{
  const result=questions.importRecord(randomUUID(),{brandId,label:'Statement',text:'We use spreadsheets.'});expect(result.collection.newCandidates).toBe(0);expect(questions.list(brandId).stats.total).toBe(0);
  const brand=lab.brandProfile(brandId);lab.changeBrand(randomUUID(),'delete',{id:brandId,version:brand.version});expect(()=>questions.collect(brandId)).toThrow('已删除');expect(()=>questions.list(brandId)).toThrow('已删除');
 });
 it('automatically extracts questions when the shared GSC reader saves a new snapshot',async()=>{
  for(const key of ['GSC_CLIENT_ID','GSC_CLIENT_SECRET','GSC_REFRESH_TOKEN'])vi.stubEnv(key,'synthetic-test');
  const fetcher=(async(url:unknown,init?:RequestInit)=>{
   if(String(url).endsWith('/token'))return Response.json({access_token:'synthetic-test',scope:'https://www.googleapis.com/auth/webmasters.readonly'});
   if(String(url).endsWith('/sites'))return Response.json({siteEntry:[{siteUrl:'sc-domain:sample-studio.example',permissionLevel:'siteOwner'}]});
   const body=JSON.parse(String(init?.body));return Response.json({rows:[{keys:body.dimensions.map((d:string)=>d==='query'?'restaurant scheduling software pricing':'https://sample-studio.example/'),clicks:2,impressions:40,ctr:.05,position:6}]});
  }) as typeof fetch;
  const callback=vi.fn(()=>questions.collectAll()),sync=new GscSync(lab,new GscConnector(lab,fetcher),Date.now,callback);
  try{await sync.refresh({property:'sc-domain:sample-studio.example',country:'CAN',startDate:'2026-09-01',endDate:'2026-09-28',dashboard:false,compare:false,includeMonthly:false});expect(callback).toHaveBeenCalledOnce();expect(questions.list(brandId).stats.total).toBe(1);expect(questions.list(brandId).questions[0]?.stage).toBe('price');}finally{await sync.stop();}
 });
 it('runs startup collection and the full authenticated HTTP path without contacting external services',async()=>{
  snapshot(['restaurant software pricing']);let allowed=true;const app=await serveConsole(lab,{canMutate:()=>allowed});const fetchOriginal=globalThis.fetch;let external=0;
  vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{if(!String(input).startsWith(app.origin)){external++;throw new Error('External access forbidden');}return fetchOriginal(input,init);});
  const get=()=>fetch(app.origin+'/api/questions/local?brandId='+brandId,{headers:{Authorization:'Bearer '+app.token}});
  const post=(path:string,input:unknown)=>fetch(app.origin+'/api/questions/'+path,{method:'POST',headers:{Authorization:'Bearer '+app.token,'Content-Type':'application/json',Origin:app.origin},body:JSON.stringify({requestId:randomUUID(),input})});
  try{
   expect((await fetch(app.origin+'/api/questions/local?brandId='+brandId)).status).toBe(401);
   const state=await (await get()).json();expect(state.stats.total).toBe(1);
   expect((await post('record',{brandId,label:'Customer consultation',text:'Can I import my existing schedule?'})).status).toBe(200);
   const refreshed=await(await post('collect',{brandId})).json();expect(refreshed.stats.total).toBe(2);
   const ids=refreshed.questions.map((q:{id:string})=>q.id);expect((await(await post('markdown',{brandId,ids})).json()).text).toContain('Customer consultation');
   const created=await(await post('create-set',{brandId,ids,label:'HTTP collection',locale:'en-CA'})).json();expect(created.count).toBe(2);
   allowed=false;expect((await post('collect',{brandId})).status).toBe(503);expect(external).toBe(0);
  }finally{await app.gscSync.stop();app.server.closeAllConnections();await new Promise<void>(r=>app.server.close(()=>r()));}
 });
});
