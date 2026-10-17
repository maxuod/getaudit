import { describe,it,expect,afterEach,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { connectLedger } from '../../src/db/index.ts';
import { LabService } from '../../src/console/service.ts';
import { GscConnector } from '../../src/console/gsc.ts';
import type { GscSnapshot } from '../../src/console/gsc.ts';
import { KeywordAudit,keywordAuditMarkdown,keywordAnalysisWireSchema,selectOpportunityKeywords,validateKeywordAnalysis } from '../../src/console/keyword-audit.ts';
import type { KeywordAuditInput,KeywordAuditKeyword,KeywordAuditJob } from '../../src/console/keyword-audit.ts';
import { fetchPageEvidence,isPublicAddress,publicPageUrl,readableHtml } from '../../src/console/keyword-audit-evidence.ts';
import { canonicalJson,sha256 } from '../../src/lib/canonical-json.ts';
const databases:DatabaseSync[]=[],dirs:string[]=[];
afterEach(()=>{for(const db of databases.splice(0))db.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});vi.unstubAllEnvs();});
const resolver=async()=>[{address:'93.184.216.34',family:4}];
const metric=(keys:string[],position=15,impressions=100)=>({keys,position,impressions,clicks:5,ctr:0.05});
function fixture(count=5,override:Partial<GscSnapshot>={}){
  const dir=mkdtempSync(join(tmpdir(),'keyword-audit-test-'));dirs.push(dir);const db=connectLedger(join(dir,'ledger.db'));databases.push(db);const lab=new LabService(db),gsc=new GscConnector(lab);
  const brandId=lab.createBrand(randomUUID(),{name:'Owner',ownedDomains:['sample-agency.example'],aliases:['Owner'],category:'restaurant scheduling'}).id;
  const snapshot:GscSnapshot={id:randomUUID(),property:'sc-domain:sample-agency.example',capturedAt:'2026-10-01T12:00:00Z',startDate:'2026-09-01',endDate:'2026-09-28',country:'CAN',device:'DESKTOP',timeZone:'America/Los_Angeles',type:'web',dataState:'final',source:'fixture',requests:[],raw:[],totals:null,pages:[],queries:Array.from({length:count},(_,i)=>metric(['restaurant scheduling '+i],11+i,1000-i)),queryPages:Array.from({length:count},(_,i)=>metric(['restaurant scheduling '+i,'https://sample-agency.example/guide-'+i],2,50)),limitations:[],...override};
  db.prepare('INSERT INTO console_gsc_snapshot VALUES(?,?,?,?,?)').run(snapshot.id,snapshot.capturedAt,snapshot.property,canonicalJson(snapshot),sha256(canonicalJson(snapshot)));
  const input:KeywordAuditInput={snapshotId:snapshot.id,brandId,countryCode:2124,languageCode:'en',device:'desktop',provider:'openai',model:'gpt-6.1-sol'};
  return {db,lab,gsc,snapshot,input};
}
function credentials(){vi.stubEnv('DATAFORSEO_LOGIN','fixture-login');vi.stubEnv('DATAFORSEO_PASSWORD','fixture-password');vi.stubEnv('OPENAI_API_KEY','private-fixture-openai');vi.stubEnv('ANTHROPIC_API_KEY','private-fixture-anthropic');}
type Prompt={ownerUrl:string;competitors:{url:string;actualRank:number}[];evidence:{sourceId:string;url:string;content:string}[]};
function answer(prompt:Prompt){
  const owner=prompt.evidence.find(p=>p.url===prompt.ownerUrl)!,ownerRef={sourceId:owner.sourceId,quote:owner.content.slice(0,100)};
  return {summary:'根据这次静态页面证据，先完善当前页面的示例并重新测量。',comparisons:prompt.competitors.map(c=>{const page=prompt.evidence.find(p=>p.url===c.url)!,ref={sourceId:page.sourceId,quote:page.content.slice(0,100)};return {competitorUrl:c.url,actualRank:c.actualRank,approach:[{text:'提供了可阅读的排班示例。',evidence:[ref]}],gaps:[{text:'提供的两个摘录例子范围不同；全站情况未知。',evidence:[ref,ownerRef]}],improvements:[{action:'补充一个具体餐厅的排班示例，并验证现有指南能完成任务。',priority:'high',targetUrl:prompt.ownerUrl,reason:'两份保存的摘录提供不同示例，建议补齐用户任务。',acceptance:'改动的例子可阅读，可按步骤制作一周排班。',followUp:'发布后 28 天比较抓取、排名、点击与转化；AI 引用另测，不承诺排名。',evidence:[ref,ownerRef]}],unknowns:['未检查全站内链、反链或真实用户性能。']};}),unknowns:['静态网页摘录不能证明某项功能导致排名。']};
}
function mock(options:{failPage?:string;invalidQuote?:boolean;incomplete?:boolean;taskError?:boolean;corrected?:boolean;wrongMarket?:boolean;privateTop?:boolean;redirectOwner?:boolean;redirectCompetitor?:boolean}={}){
  const calls:{url:string;body:unknown}[]=[];
  const send=(async(url:unknown,init?:RequestInit)=>{
    const u=String(url),body=init?.body?JSON.parse(String(init.body)):null;calls.push({url:u,body});
    if(u.includes('api.dataforseo.com')){const task=body[0],keyword=decodeURIComponent(task.keyword),i=Number(keyword.slice(-1));return Response.json({status_code:20000,tasks:[{status_code:options.taskError?40200:20000,result:[{keyword,location_code:options.wrongMarket?2840:2124,language_code:'en',device:'desktop',...(options.corrected?{spell:{type:'showing_results_for'}}:{}),items:[{type:'paid',url:'https://ads.example.com/',rank_group:1,rank_absolute:1},{type:'organic',url:options.privateTop?'http://127.0.0.1/top':'https://competitor.example.com/first-'+i,title:'First guide',rank_group:1,rank_absolute:2},{type:'organic',url:'https://sample-agency.example/guide-'+i,title:'Our guide',rank_group:2,rank_absolute:3},{type:'organic',url:'https://competitor.example.com/second-'+i,title:'Second guide',rank_group:3,rank_absolute:4},{type:'organic',url:'https://other.example.com/third-'+i,title:'Third guide',rank_group:4,rank_absolute:5},{type:'organic',url:'https://fourth.example.com/lower-'+i,title:'Do not backfill',rank_group:5,rank_absolute:6}]}]}]});}
    if(u.includes('api.openai.com')||u.includes('api.anthropic.com')){const prompt=JSON.parse(body.input??body.messages[0].content) as Prompt,result=answer(prompt);if(options.invalidQuote)result.comparisons[0]!.approach[0]!.evidence[0]!.quote='fabricated unsupported quotation';return u.includes('openai')?Response.json({status:options.incomplete?'incomplete':'completed',output:[{content:[{type:'output_text',text:JSON.stringify(result)}]}]}):Response.json({stop_reason:options.incomplete?'max_tokens':'end_turn',content:[{type:'text',text:JSON.stringify(result)}]});}
    if(options.redirectOwner&&u.startsWith('https://sample-agency.example/'))return new Response(null,{status:302,headers:{location:'https://external.example.com/landing'}});
    if(options.redirectCompetitor&&u.startsWith('https://competitor.example.com/'))return new Response(null,{status:302,headers:{location:'https://sample-agency.example/redirect-target'}});
    if(options.failPage&&u.includes(options.failPage))return new Response('private provider data',{status:403});
    return new Response(`<html><title>Scheduling guide</title><main><header><h1>Restaurant scheduling example</h1></header><p>${('This saved restaurant scheduling guide explains a weekly example and a staff availability checklist with specific instructions. ').repeat(10)}</p></main></html>`,{headers:{'Content-Type':'text/html'}});
  }) as typeof fetch;return {send,calls};
}
async function run(audit:KeywordAudit,input:KeywordAuditInput,requestId=randomUUID()){const started=audit.start(requestId,input);await audit.active.get(started.id);return audit.get(started.id);}
describe('five striking-distance keyword audit',()=>{
  it('defaults new Markdown to English while keeping original keyword, analysis, quotes and job hashes unchanged',()=>{
    const f=fixture(1),audit=new KeywordAudit(f.lab,f.gsc),preview=audit.preview(f.input),quote='Original quotation 原始引文 retained verbatim.',url='https://competitor.example.com/guide';
    const job:KeywordAuditJob={id:randomUUID(),brandId:f.input.brandId,status:'partial',createdAt:'2026-10-12T12:00:00Z',updatedAt:'2026-10-12T12:00:00Z',input:f.input,inputHash:'input-hash-canary',preview,
      keywords:[{...preview.keywords[0]!,reason:'Original selection reason 原始选词理由',serp:{status:'available',observedAt:'2026-10-12T12:00:00Z',source:'synthetic',conditions:{engine:'google',countryCode:2124,languageCode:'en',device:'desktop'},organic:[],competitors:[{url,title:'Original title 原始标题',actualRank:3,rankAbsolute:4}],ownResults:[],raw:null,hash:'serp-hash-canary'},ownerEvidence:null,competitorEvidence:[],analysis:{summary:'Original analysis 原始分析',comparisons:[{competitorUrl:url,actualRank:3,approach:[{text:'Original finding 原始发现',evidence:[{sourceId:'synthetic-source',quote}]}],gaps:[],improvements:[],unknowns:[]}],unknowns:[]}}],warnings:['Original limit 原始限制'],requests:{serp:0,pages:0,llm:0},completion:{keywords:0,competitorSlots:1,comparisons:1,targetKeywords:5,targetComparisons:15},reportHash:'report-hash-canary'};
    const before=canonicalJson(job),en=keywordAuditMarkdown(job),zh=keywordAuditMarkdown(job,'zh-CN');
    expect(en).toContain('Five opportunity keywords audit');expect(en).toContain('Actual organic rank 3');expect(en).toContain('Saved page content and sources');
    expect(zh).toContain('五个机会关键词审计');expect(zh).toContain('真实自然第 3 名');
    for(const text of [en,zh]){expect(text).toContain(job.keywords[0]!.keyword);expect(text).toContain(quote);expect(text).toContain('Original analysis 原始分析');expect(text).toContain('Original selection reason 原始选词理由');expect(text).toContain('Original title 原始标题');expect(text).toContain('Original limit 原始限制');expect(text).toContain('input-hash-canary');expect(text).toContain('report-hash-canary');}
    expect(canonicalJson(job)).toBe(before);
  });
  it('uses query-level inclusive 11–20, deterministic unique strings and observed own query×page URLs',()=>{
    const f=fixture(0);f.snapshot.queries=[metric(['At eleven'],11,50),metric(['At twenty'],20,100),metric(['outside'],20.01,1000),metric(['page only rank'],5,900),metric(['AT TWENTY'],15,90),metric(['missing owner'],14,1)];
    f.snapshot.queryPages=[metric(['At twenty','https://sample-agency.example/lower'],18,20),metric(['At twenty','https://sample-agency.example/higher'],2,100),metric(['At twenty','https://foreign.example.com/'],1,2000),metric(['page only rank','https://sample-agency.example/page'],15,1000)];
    const selected=selectOpportunityKeywords(f.snapshot,['sample-agency.example']);expect(selected.candidateCount).toBe(3);expect(selected.keywords.map(k=>k.keyword)).toEqual(['At twenty','At eleven','missing owner']);expect(selected.keywords[0]?.ownerUrl).toBe('https://sample-agency.example/higher');expect(selected.keywords[0]?.position).toBe(20);expect(selected.keywords[2]?.ownerUrl).toBeNull();expect(selectOpportunityKeywords(f.snapshot,['sample-agency.example'],['at TWENTY']).candidateCount).toBe(2);
  });
  it('rejects mismatched source market, web type, device and brand; discloses aggregate device',()=>{
    for(const override of [{country:'ALL'},{country:'USA'},{device:'MOBILE'},{type:'image'},{page:'/guide'},{requests:[{dimensions:['query']}],raw:[{responseAggregationType:'byPage'}]}] as Partial<GscSnapshot>[]){const f=fixture(1,override),a=new KeywordAudit(f.lab,f.gsc);expect(()=>a.preview(f.input)).toThrow();}
    const f=fixture(1,{device:'ALL'}),a=new KeywordAudit(f.lab,f.gsc);expect(a.preview(f.input).warnings.join(' ')).toContain('ALL 设备');const foreign=f.lab.createBrand(randomUUID(),{name:'Other',ownedDomains:['foreign.com'],aliases:[]}).id;expect(()=>a.preview({...f.input,brandId:foreign})).toThrow('不属于');
  });
  it('completes five queries×three pages, preserves same-domain URLs and actual ranks with 5/20/5 hard caps',async()=>{
    credentials();const f=fixture(),m=mock(),a=new KeywordAudit(f.lab,f.gsc,m.send,{resolveHost:resolver}),requestId=randomUUID();const job=await run(a,f.input,requestId);
    expect(job.status).toBe('complete');expect(job.completion.comparisons).toBe(15);expect(job.requests).toEqual({serp:5,pages:20,llm:5});expect(job.keywords[0]?.serp?.competitors.map(r=>r.actualRank)).toEqual([1,3,4]);expect(new URL(job.keywords[0]!.serp!.competitors[0]!.url).hostname).toBe(new URL(job.keywords[0]!.serp!.competitors[1]!.url).hostname);expect(job.keywords[0]?.serp?.organic).toHaveLength(5);expect(job.keywords[0]?.serp?.ownResults[0]?.actualRank).toBe(2);expect(a.markdown(job.id,'zh-CN')).toContain('真实自然第 3 名');expect(a.markdown(job.id,'zh-CN')).toContain('保存的正文与来源');expect(JSON.stringify(job)).not.toContain('private-fixture');
    const count=m.calls.length;expect(a.start(requestId,f.input).id).toBe(job.id);expect(m.calls.length).toBe(count);expect(()=>a.start(requestId,{...f.input,languageCode:'fr'})).toThrow('请求标识');
    expect(()=>f.db.exec('DELETE FROM console_keyword_audit_job')).toThrow();expect(()=>f.db.exec('UPDATE console_keyword_audit_evidence SET payload=\'bad\'')).toThrow();expect(()=>f.db.exec('UPDATE console_keyword_audit_job SET result_json=\'bad\'')).toThrow();
    const wire=JSON.stringify(keywordAnalysisWireSchema());expect(wire).not.toMatch(/minLength|maxLength|exclusiveMinimum|maxItems|format/);const openai=m.calls.find(c=>c.url.includes('openai'))?.body as {store:boolean;reasoning:{effort:string};text:{format:{schema:unknown}}};expect(openai.store).toBe(false);expect(openai.reasoning.effort).toBe('medium');expect(openai.text.format.schema).toEqual(keywordAnalysisWireSchema());
    expect(job.keywords[0]?.modelEvidence?.requestHash).toMatch(/^[a-f0-9]{64}$/);expect(job.keywords[0]?.modelEvidence?.outputHash).toMatch(/^[a-f0-9]{64}$/);expect(a.markdown(job.id,'zh-CN')).toContain('改善任务总览');expect(a.markdown(job.id,'zh-CN')).toContain('模型请求 SHA-256');
    const request=f.db.prepare("SELECT payload FROM console_keyword_audit_evidence WHERE kind='model-request' LIMIT 1").get() as {payload:string};expect(request.payload).toContain('keyword-audit-v1');expect(request.payload).not.toContain('private-fixture');expect(request.payload).not.toContain('Authorization');
  });
  it('supports Anthropic strict JSON with app-side citation validation and no native citation flags',async()=>{
    credentials();const f=fixture(1),m=mock(),a=new KeywordAudit(f.lab,f.gsc,m.send,{resolveHost:resolver}),job=await run(a,{...f.input,provider:'anthropic',model:'claude-sonnet-5-5'});expect(job.status).toBe('partial');expect(job.completion.comparisons).toBe(3);const body=m.calls.find(c=>c.url.includes('anthropic'))!.body as {output_config:unknown};expect(body.output_config).toBeTruthy();expect(JSON.stringify(body)).not.toContain('"citations"');
  });
  it('keeps unavailable top pages instead of replacing with lower-ranked URLs',async()=>{
    credentials();const f=fixture(1),m=mock({privateTop:true}),a=new KeywordAudit(f.lab,f.gsc,m.send,{resolveHost:resolver}),job=await run(a,f.input);expect(job.keywords[0]!.serp!.competitors.map(c=>c.actualRank)).toEqual([1,3,4]);expect(job.keywords[0]!.competitorEvidence[0]!.status).toBe('unavailable');expect(job.completion.comparisons).toBe(2);expect(m.calls.some(c=>c.url.includes('/lower-'))).toBe(false);expect(m.calls.some(c=>c.url.includes('127.0.0.1'))).toBe(false);
  });
  it('does not fabricate own URLs or analyze without an observed owner page',async()=>{
    credentials();const f=fixture(1,{queryPages:[]}),m=mock(),a=new KeywordAudit(f.lab,f.gsc,m.send,{resolveHost:resolver}),job=await run(a,f.input);expect(job.keywords[0]?.ownerUrl).toBeNull();expect(job.requests.llm).toBe(0);expect(job.completion.comparisons).toBe(0);expect(job.keywords[0]?.error).toContain('自有页面');
  });
  it('rejects fabricated quotes and incomplete model output without repeated paid calls',async()=>{
    credentials();for(const options of [{invalidQuote:true},{incomplete:true}]){const f=fixture(1),m=mock(options),a=new KeywordAudit(f.lab,f.gsc,m.send,{resolveHost:resolver}),job=await run(a,f.input);expect(job.status).toBe('partial');expect(job.keywords[0]?.analysis).toBeNull();expect(job.requests.llm).toBe(1);expect(m.calls.filter(c=>c.url.includes('openai'))).toHaveLength(1);}
  });
  it('preserves failed/corrected/mismatched raw SERP and skips analysis',async()=>{
    credentials();for(const options of [{taskError:true},{corrected:true},{wrongMarket:true}]){const f=fixture(1),m=mock(options),a=new KeywordAudit(f.lab,f.gsc,m.send,{resolveHost:resolver}),job=await run(a,f.input);expect(job.keywords[0]?.serp?.status).toBe('unavailable');expect(job.keywords[0]?.serp?.raw).toBeTruthy();expect(job.requests).toEqual({serp:1,pages:0,llm:0});}
  });
  it('rejects redirected pages crossing brand ownership boundaries',async()=>{
    credentials();for(const options of [{redirectOwner:true},{redirectCompetitor:true}]){const f=fixture(1),m=mock(options),a=new KeywordAudit(f.lab,f.gsc,m.send,{resolveHost:resolver}),job=await run(a,f.input);expect(job.status).toBe('partial');if(options.redirectOwner){expect(job.requests.llm).toBe(0);expect(job.keywords[0]?.ownerEvidence?.status).toBe('unavailable');}else{expect(job.completion.comparisons).toBe(1);expect(job.keywords[0]?.competitorEvidence.filter(p=>p.status==='unavailable')).toHaveLength(2);}}
  });
  it('encodes literal plus/percent queries and keeps the exact original query',async()=>{
    credentials();const f=fixture(0,{queries:[metric(['C++ tips 10%'],15)],queryPages:[metric(['C++ tips 10%','https://sample-agency.example/guide-1'])]}),m=mock(),a=new KeywordAudit(f.lab,f.gsc,m.send,{resolveHost:resolver}),job=await run(a,f.input);expect((m.calls[0]!.body as {keyword:string}[])[0]!.keyword).toBe('C%2B%2B%20tips%2010%25');expect(job.keywords[0]!.keyword).toBe('C++ tips 10%');expect(job.keywords[0]?.serp?.status).toBe('available');expect(job.completion.comparisons).toBe(3);
  });
  it('stops in-flight work and never automatically restarts an interrupted request',async()=>{
    credentials();const f=fixture(1);let calls=0;const send=(async(_url:unknown,init?:RequestInit)=>{calls++;return new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('private secret error')),{once:true});});}) as typeof fetch;const a=new KeywordAudit(f.lab,f.gsc,send,{resolveHost:resolver}),requestId=randomUUID(),started=a.start(requestId,f.input);await Promise.resolve();await a.stop();expect(a.get(started.id).status).toBe('interrupted');const b=new KeywordAudit(f.lab,f.gsc,send,{resolveHost:resolver});expect(b.start(requestId,f.input).status).toBe('interrupted');expect(calls).toBe(1);expect(b.active.size).toBe(0);expect(JSON.stringify(b.get(started.id))).not.toContain('private secret');
  });
  it('refuses overlapping independent starts to limit duplicate cost',async()=>{
    credentials();const f=fixture(1),m=mock(),a=new KeywordAudit(f.lab,f.gsc,m.send,{resolveHost:resolver});const start=a.start(randomUUID(),f.input);expect(()=>a.start(randomUUID(),f.input)).toThrow('已有关键词');await a.active.get(start.id);
  });
});

describe('bounded public page evidence',()=>{
  it('blocks private, local, mapped, metadata and unsafe protocol targets',()=>{
    for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.1.1','192.168.1.1','100.64.1.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','::ffff:7f00:1','2001:db8::1'])expect(isPublicAddress(address)).toBe(false);expect(isPublicAddress('8.8.8.8')).toBe(true);expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    for(const url of ['file:///etc/passwd','http://localhost/','http://metadata.google.internal/','http://127.0.0.1/','http://user:pass@example.com/','https://example.com:8443/','http://foo.test/'])expect(()=>publicPageUrl(url)).toThrow();
  });
  it('checks DNS before each redirect and never fetches private DNS target',async()=>{
    const calls:string[]=[],send=(async(url:unknown)=>{calls.push(String(url));return new Response(null,{status:302,headers:{location:'https://internal.example.com/private'}});}) as typeof fetch;
    const p=await fetchPageEvidence('https://public.example.com/',new AbortController().signal,send,async host=>[{address:host.startsWith('internal')?'10.0.0.1':'8.8.8.8',family:4}]);expect(p.status).toBe('unavailable');expect(calls).toHaveLength(1);expect(p.error).toContain('DNS');
  });
  it('rejects oversized body, short shell, challenge title and no-body status safely',async()=>{
    const bodies=[new Response('x'.repeat(1024*1024+1),{headers:{'Content-Type':'text/html'}}),new Response('<title>Guide</title><body>Loading</body>',{headers:{'Content-Type':'text/html'}}),new Response('<title>Just a moment...</title><body>'+('Verify you are human. ').repeat(20)+'</body>',{headers:{'Content-Type':'text/html'}}),new Response(null,{status:204,headers:{'Content-Type':'text/html'}})];
    for(const response of bodies){const page=await fetchPageEvidence('https://public.example.com/',new AbortController().signal,(async()=>response) as typeof fetch,resolver);expect(page.status).toBe('unavailable');}
  });
  it('extracts focused content without scripts and retains legitimate main/article header titles',()=>{
    const result=readableHtml('<title>Guide &amp; Examples</title><nav>sidebar</nav><main><header><h1>Restaurant schedule</h1></header><script>steal secrets</script><p>Useful &lt;safe&gt; example.</p></main><footer>legal</footer>');expect(result.title).toBe('Guide & Examples');expect(result.headings).toEqual(['Restaurant schedule']);expect(result.body).toContain('Useful <safe> example');expect(result.body).not.toContain('steal secrets');expect(result.body).not.toContain('sidebar');
  });
});
