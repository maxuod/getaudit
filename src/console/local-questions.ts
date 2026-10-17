import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalJson,sha256} from '../lib/canonical-json.ts';
import {inTransaction} from '../db/index.ts';
import {createPromptSet,addPrompts,listPrompts} from '../ledger/repo.ts';
import type {LabService} from './service.ts';
import type {GscSnapshot} from './gsc.ts';
import {extractQuery,extractRecord,questionKey,questionExtractorVersion,type ExtractedQuestion,type QuestionStage} from './question-extract.ts';

type SourceKind='gsc'|'business_set'|'local_record';
export type QuestionEvidence={id:string;sourceKind:SourceKind;sourceId:string;label:string;original:string;derivation:ExtractedQuestion['derivation'];sourceHash:string;extractor:string;capturedAt:string;property?:string;country?:string;startDate?:string;endDate?:string;clicks?:number;impressions?:number;ctr?:number;position?:number;pages?:string[];sourceNote?:string};
export type LocalQuestion={id:string;brandId:string;text:string;stage:QuestionStage;createdAt:string;verbatim:boolean;sourceKinds:SourceKind[];evidence:QuestionEvidence[];hash:string};
export type CollectionResult={newCandidates:number;newEvidence:number;sources:number;skipped:number;limitedSources:number;errors:string[]};
const uuid=z.string().uuid(),candidateId=z.string().regex(/^[a-f0-9]{64}$/);
const selection=z.object({brandId:uuid,ids:z.array(candidateId).min(1).max(500)}).strict();
const empty=():CollectionResult=>({newCandidates:0,newEvidence:0,sources:0,skipped:0,limitedSources:0,errors:[]});
const domain=(s:string)=>s.toLowerCase().replace(/^www\./,'').replace(/\.$/,'');

/** Reads only this ledger. No browser, model, API, credentials or network dependency. */
export class LocalQuestions {
 private lab:LabService;
 private last=new Map<string,CollectionResult>();
 constructor(lab:LabService){this.lab=lab;}
 private scan(brandId:string,sourceKey:string,sourceHash:string,items:{question:ExtractedQuestion;evidence:Omit<QuestionEvidence,'id'|'original'|'derivation'|'sourceHash'|'extractor'>}[],skipped=0,limited=false):CollectionResult {
  const previous=this.lab.db.prepare('SELECT source_hash FROM console_question_scan WHERE source_key=?').get(sourceKey) as {source_hash:string}|undefined;
  if(previous){if(previous.source_hash!==sourceHash)throw new Error('本地来源内容已改变，停止提取以保留证据');return empty();}
  return inTransaction(this.lab.db,()=>{
   const result=empty();result.sources=1;result.skipped=skipped;result.limitedSources=Number(limited);
   for(const {question,evidence:source} of items){
    const normalized=questionKey(question.text);if(!normalized)continue;
    const id=sha256(canonicalJson({brandId,normalized}));
    const candidate=this.lab.db.prepare('INSERT OR IGNORE INTO console_question_candidate(id,brand_id,normalized,text,stage) VALUES(?,?,?,?,?)').run(id,brandId,normalized,question.text,question.stage);
    result.newCandidates+=Number(candidate.changes);
    const evidenceKey=sourceKey+':'+sha256(question.original),evidenceId=sha256(canonicalJson({id,evidenceKey}));
    const payload:QuestionEvidence={...source,id:evidenceId,original:question.original,derivation:question.derivation,sourceHash,extractor:questionExtractorVersion};
    const json=canonicalJson(payload);
    const saved=this.lab.db.prepare('INSERT OR IGNORE INTO console_question_evidence VALUES(?,?,?,?,?)').run(evidenceId,id,evidenceKey,json,sha256(json));result.newEvidence+=Number(saved.changes);
   }
   this.lab.db.prepare('INSERT INTO console_question_scan(source_key,brand_id,source_hash,payload) VALUES(?,?,?,?)').run(sourceKey,brandId,sourceHash,canonicalJson(result));
   return result;
  });
 }
 collect(brandId:string):CollectionResult {
  uuid.parse(brandId);this.lab.assertBrandActive(brandId);
  const result=empty(),brand=this.lab.brandProfile(brandId),domains=(JSON.parse(brand.owned_domains) as string[]).map(domain);
  const add=(fn:()=>CollectionResult,label:string)=>{try{const r=fn();for(const k of ['newCandidates','newEvidence','sources','skipped','limitedSources'] as const)result[k]+=r[k];}catch(e){result.errors.push(label+'：'+(e instanceof Error?e.message:'读取失败'));}};
  const hasGsc=this.lab.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='console_gsc_snapshot'").get();
  const snapshots=hasGsc?this.lab.db.prepare(`SELECT id,property,payload,hash FROM console_gsc_snapshot ORDER BY captured_at DESC,rowid DESC`).all() as {id:string;property:string;payload:string;hash:string}[]:[];
  for(const row of snapshots){
   if(!domains.includes(domain(row.property.replace(/^sc-domain:/,''))))continue;
   add(()=>{
    const key=`${questionExtractorVersion}:${brandId}:gsc:${row.id}`;
    const checkpoint=this.lab.db.prepare('SELECT source_hash FROM console_question_scan WHERE source_key=?').get(key) as {source_hash:string}|undefined;
    // Frozen GSC JSON is canonical. Verify every source before it can produce questions.
    if(sha256(row.payload)!==row.hash)throw new Error('GSC 快照哈希校验失败');
    if(checkpoint){if(checkpoint.source_hash!==row.hash)throw new Error('GSC 来源哈希已改变');return empty();}
    const s=JSON.parse(row.payload) as GscSnapshot;
    const rows=s.queries.slice(0,2000),pages=new Map<string,string[]>();
    for(const r of s.queryPages??[]){const query=r.keys?.[0],page=r.keys?.[1];if(query&&page){const list=pages.get(query)??[];if(list.length<10&&!list.includes(page))list.push(page);pages.set(query,list);}}
    let skipped=0;
    const items=rows.flatMap(r=>{const q=extractQuery(r.keys?.[0]??'');if(!q){skipped++;return [];}
     return [{question:q,evidence:{sourceKind:'gsc' as const,sourceId:s.id,label:'GSC 搜索词',capturedAt:s.capturedAt,property:s.property,country:s.country,startDate:s.startDate,endDate:s.endDate,clicks:r.clicks,impressions:r.impressions,ctr:r.ctr,position:r.position,pages:pages.get(r.keys?.[0]??'')??[]}}];
    });
    return this.scan(brandId,key,row.hash,items,skipped,s.queries.length>2000);
   },'GSC '+row.id);
  }
  const prompts=this.lab.db.prepare(`SELECT p.id,p.text,p.created_at,q.source,s.label FROM prompt p JOIN prompt_set s ON s.id=p.prompt_set_id JOIN console_question_source q ON q.prompt_id=p.id WHERE s.brand_id=? AND q.kind='business' AND NOT EXISTS(SELECT 1 FROM console_question_candidate_prompt cp WHERE cp.prompt_id=p.id)`).all(brandId) as {id:string;text:string;created_at:string;source:string;label:string}[];
  for(const p of prompts)add(()=>{const q=extractRecord(p.text),hash=sha256(canonicalJson(p));return this.scan(brandId,`${questionExtractorVersion}:${brandId}:business:${p.id}`,hash,q.map(question=>({question,evidence:{sourceKind:'business_set',sourceId:p.id,label:p.label,sourceNote:p.source,capturedAt:p.created_at}})),Number(!q.length));},'业务问题 '+p.id);
  const docs=this.lab.db.prepare('SELECT id,label,text,hash,created_at FROM console_question_document WHERE brand_id=? ORDER BY rowid').all(brandId) as {id:string;label:string;text:string;hash:string;created_at:string}[];
  for(const d of docs)add(()=>{if(sha256(d.text)!==d.hash)throw new Error('本地记录哈希校验失败');const q=extractRecord(d.text);return this.scan(brandId,`${questionExtractorVersion}:${brandId}:record:${d.id}`,d.hash,q.map(question=>({question,evidence:{sourceKind:'local_record',sourceId:d.id,label:d.label,capturedAt:d.created_at}})),Number(!q.length));},'本地记录 '+d.id);
  this.last.set(brandId,result);return result;
 }
 collectAll(){for(const b of this.lab.db.prepare('SELECT id FROM brand').all()){const id=String(b.id);if(!this.lab.brandProfile(id).deletedAt)this.collect(id);}}
 list(brandId:string){
  uuid.parse(brandId);this.lab.assertBrandActive(brandId);
  const rows=this.lab.db.prepare('SELECT id,text,stage,created_at FROM console_question_candidate WHERE brand_id=? ORDER BY rowid DESC').all(brandId) as {id:string;text:string;stage:QuestionStage;created_at:string}[];
  const sources=new Map<string,QuestionEvidence[]>();
  for(const r of this.lab.db.prepare('SELECT e.candidate_id,e.payload,e.hash FROM console_question_evidence e JOIN console_question_candidate c ON c.id=e.candidate_id WHERE c.brand_id=? ORDER BY e.rowid DESC').all(brandId) as {candidate_id:string;payload:string;hash:string}[]){
   if(sha256(r.payload)!==r.hash)throw new Error('问题来源证据哈希校验失败');
    const list=sources.get(r.candidate_id)??[];list.push(JSON.parse(r.payload));sources.set(r.candidate_id,list);
  }
  const questions:LocalQuestion[]=rows.map(r=>{const evidence=(sources.get(r.id)??[]).sort((a,b)=>b.capturedAt.localeCompare(a.capturedAt)||a.id.localeCompare(b.id));const q={id:r.id,brandId,text:r.text,stage:r.stage,createdAt:r.created_at,verbatim:evidence.some(e=>e.derivation==='verbatim'),sourceKinds:[...new Set(evidence.map(e=>e.sourceKind))],evidence};return {...q,hash:sha256(canonicalJson(q))};});
  questions.sort((a,b)=>Number(b.verbatim)-Number(a.verbatim)||Number(b.stage!=='research')-Number(a.stage!=='research')||b.createdAt.localeCompare(a.createdAt)||a.text.localeCompare(b.text));
  return {questions,lastScan:this.last.get(brandId)??null,stats:{total:questions.length,verbatim:questions.filter(q=>q.verbatim).length,rewritten:questions.filter(q=>!q.verbatim).length,documents:this.lab.db.prepare('SELECT count(*) n FROM console_question_document WHERE brand_id=?').get(brandId)?.n??0},limitations:['原文问句不等于已确认买家身份。','关键词改写由本地规则生成，需审核；没有调用外部模型。','不同快照可能覆盖相同日期，搜索指标不跨快照相加。','每个快照最多提取前 2,000 个查询词；不会把已有假设问题集循环当作真实需求来源。']};
 }
 importRecord(requestId:string,input:unknown){
  const v=z.object({brandId:uuid,label:z.string().trim().min(1).max(160),text:z.string().trim().min(1).max(50000)}).strict().parse(input);this.lab.assertBrandActive(v.brandId);
  const result=this.lab.command(requestId,'local-question-record',v,()=>{const id=randomUUID();this.lab.db.prepare('INSERT INTO console_question_document(id,brand_id,label,text,hash) VALUES(?,?,?,?,?)').run(id,v.brandId,v.label,v.text,sha256(v.text));return {id};});
  return {...result,collection:this.collect(v.brandId)};
 }
 private selected(input:unknown){const v=selection.parse(input);this.lab.assertBrandActive(v.brandId);const ids=new Set(v.ids),questions=this.list(v.brandId).questions.filter(q=>ids.has(q.id));if(questions.length!==ids.size)throw new Error('所选问题不属于当前项目或已不可读取');return {v,questions};}
 createSet(requestId:string,input:unknown){
  const v=selection.extend({label:z.string().trim().min(1).max(160),locale:z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/)}).parse(input);
  const {questions}=this.selected({brandId:v.brandId,ids:v.ids});
  return this.lab.command(requestId,'local-question-set',v,()=>{
   const setId=createPromptSet(this.lab.db,{brandId:v.brandId,label:v.label,note:'本机问题自动采集；来源见逐题证据。需审核后冻结。'}),brand=this.lab.brandProfile(v.brandId),names=[brand.name,...JSON.parse(brand.aliases) as string[]];
   addPrompts(this.lab.db,setId,questions.map(q=>({text:q.text,locale:v.locale,intent:names.some(n=>q.text.toLowerCase().includes(n.toLowerCase()))?'branded':'discovery'})));
   for(const prompt of listPrompts(this.lab.db,setId)){
    const q=questions.find(q=>q.text===prompt.text)!;
    const payload=canonicalJson(q);
    this.lab.db.prepare('INSERT INTO console_question_candidate_prompt VALUES(?,?,?,?)').run(prompt.id,q.id,payload,sha256(payload));
    const source=`本地采集 · ${q.verbatim?'来源原文问句':'关键词改写，待审核'} · ${q.evidence[0]?.label??'本地记录'} · 证据 ${q.id}`;
    this.lab.db.prepare('INSERT INTO console_question_source VALUES(?,?,?)').run(prompt.id,source,q.verbatim&&q.sourceKinds.every(k=>k!=='gsc')?'business':'hypothesis');
   }
   return {id:setId,count:questions.length};
  });
 }
 markdown(input:unknown){
  const {v,questions}=this.selected(input),brand=this.lab.brandProfile(v.brandId);
  const lines=[`# ${brand.name} · 本地采集问题`, '', '来源范围：本机台账中的 GSC 快照、实际业务问题集和导入记录。关键词改写是待验证建议，原文问句也不保证提问者是买家。', ''];
  questions.forEach((q,i)=>{lines.push(`## ${i+1}. ${q.text}`,'',`类型：${q.verbatim?'来源原文问句':'本地规则改写'}；阶段：${q.stage}`,`问题证据 SHA-256：${q.hash}`,'');for(const e of q.evidence){lines.push(`来源：${e.label}；记录 ${e.sourceId}`,`原文：${e.original}`,`读取时间：${e.capturedAt}`,`来源 SHA-256：${e.sourceHash}`);if(e.property)lines.push(`GSC：${e.property}；${e.startDate}—${e.endDate}；${e.country}`,`该快照指标：点击 ${e.clicks}，展示 ${e.impressions}，CTR ${e.ctr}，平均排名 ${e.position}`,`关联页面：${e.pages?.join('，')||'此快照未提供联合维度页面'}`);if(e.sourceNote)lines.push(`原有来源说明：${e.sourceNote}`);lines.push('');}});
  return {text:lines.join('\n'),count:questions.length};
 }
}
