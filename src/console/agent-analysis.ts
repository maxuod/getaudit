import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {LabService} from './service.ts';
import {canonicalJson,sha256} from '../lib/canonical-json.ts';
import {normalizeDomain} from '../lib/url.ts';
const short=z.string().trim().min(1).max(1600);
export const agentAnalysisSourceSchema=z.object({kind:z.enum(['gsc_snapshot','geo_plan','keyword_audit']),id:z.string().uuid(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type AgentAnalysisSource=z.infer<typeof agentAnalysisSourceSchema>;
export const agentAnalysisInput=z.object({
 requestId:z.string().uuid(),brandId:z.string().uuid(),title:z.string().trim().min(1).max(160),summary:z.string().trim().min(1).max(16000),
 gaps:z.array(z.string().trim().min(1).max(1200)).min(1).max(20),
 actions:z.array(z.object({priority:z.enum(['high','medium','low']),targetUrl:z.url().max(2000).optional(),action:short,reason:short,acceptance:short,measurement:short}).strict()).max(10),
 sourceRefs:z.array(agentAnalysisSourceSchema).min(1).max(20),provider:z.string().trim().min(1).max(80).optional(),model:z.string().trim().min(1).max(120).optional(),
}).strict();
export type AgentAnalysisInput=z.infer<typeof agentAnalysisInput>;
export type AgentAnalysis=AgentAnalysisInput&{id:string;createdAt:string;contentHash:string;classification:'agent_generated_analysis';sourceVerification:'verified_at_save';providerDisclosure:'agent_declared_not_independently_verified'};
export class AgentAnalysisError extends Error{}
type Row={id:string;brand_id:string;request_id:string;input_hash:string;payload:string;hash:string;created_at:string};
export class AgentAnalysisStore{
 constructor(private readonly lab:LabService,private readonly verifySource:(brandId:string,source:AgentAnalysisSource)=>void){
  lab.db.exec(`CREATE TABLE IF NOT EXISTS console_agent_analysis(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brand(id),request_id TEXT NOT NULL UNIQUE,input_hash TEXT NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS console_agent_analysis_brand ON console_agent_analysis(brand_id,created_at);
   CREATE TRIGGER IF NOT EXISTS console_agent_analysis_no_update BEFORE UPDATE ON console_agent_analysis BEGIN SELECT RAISE(ABORT,'Saved Agent analyses are immutable'); END;
   CREATE TRIGGER IF NOT EXISTS console_agent_analysis_no_delete BEFORE DELETE ON console_agent_analysis BEGIN SELECT RAISE(ABORT,'Saved Agent analyses are immutable'); END;`);
 }
 private fromRow(row:Row):AgentAnalysis{
  if(sha256(row.payload)!==row.hash)throw new AgentAnalysisError('Saved Agent analysis integrity check failed.');
  const payload=JSON.parse(row.payload) as Omit<AgentAnalysis,'contentHash'>;
  if(payload.id!==row.id||payload.brandId!==row.brand_id||payload.requestId!==row.request_id||payload.createdAt!==row.created_at||payload.classification!=='agent_generated_analysis'||payload.sourceVerification!=='verified_at_save')throw new AgentAnalysisError('Saved Agent analysis identity check failed.');
  return {...payload,contentHash:row.hash};
 }
 save(input:unknown):AgentAnalysis{
  const v=agentAnalysisInput.parse(input),inputText=canonicalJson(v),inputHash=sha256(inputText);
  this.lab.assertBrandActive(v.brandId);
  if(Buffer.byteLength(inputText,'utf8')>128*1024)throw new AgentAnalysisError('Agent analysis exceeds 128 KiB.');
  const previous=this.lab.db.prepare('SELECT * FROM console_agent_analysis WHERE request_id=?').get(v.requestId) as Row|undefined;
  if(previous){if(previous.input_hash!==inputHash||previous.brand_id!==v.brandId)throw new AgentAnalysisError('This request ID was already used for another analysis.');return this.fromRow(previous);}
  const serialized=JSON.stringify(v);if(/\b(?:sk|ghp|gho)[-_][A-Za-z0-9_-]{12,}\b|Bearer\s+[A-Za-z0-9._-]{8,}|(?:\/Users\/|\/Volumes\/|\/home\/)[^\s"<>]+/i.test(serialized))throw new AgentAnalysisError('Remove credentials and private local paths before saving an Agent analysis.');
  const brand=this.lab.brandProfile(v.brandId),domains=(JSON.parse(brand.owned_domains) as string[]).map(normalizeDomain);
  for(const action of v.actions)if(action.targetUrl){const url=new URL(action.targetUrl),host=normalizeDomain(url.hostname);if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||[...url.searchParams.keys()].some(key=>/token|key|secret|password|signature|auth|session|credential|code/i.test(key))||!domains.some(domain=>host===domain||host.endsWith('.'+domain)))throw new AgentAnalysisError('Action target URLs must be public HTTPS pages owned by this project, without credentials.');}
  const seen=new Set<string>();for(const source of v.sourceRefs){const key=source.kind+':'+source.id;if(seen.has(key))throw new AgentAnalysisError('Each analysis source must appear once.');seen.add(key);this.verifySource(v.brandId,source);}
  const payload={...v,id:randomUUID(),createdAt:new Date().toISOString(),classification:'agent_generated_analysis' as const,sourceVerification:'verified_at_save' as const,providerDisclosure:'agent_declared_not_independently_verified' as const},text=canonicalJson(payload),hash=sha256(text);
  // Reserve room for provenance and list wrappers so a successful save stays retrievable.
  if(Buffer.byteLength(JSON.stringify({...payload,contentHash:hash}),'utf8')>127*1024)throw new AgentAnalysisError('Agent analysis exceeds 128 KiB including provenance.');
  this.lab.db.prepare('INSERT INTO console_agent_analysis VALUES(?,?,?,?,?,?,?)').run(payload.id,v.brandId,v.requestId,inputHash,text,hash,payload.createdAt);
  return {...payload,contentHash:hash};
 }
 list(brandId:string,offset=0,limit=25){
  z.string().uuid().parse(brandId);z.number().int().min(0).max(100_000).parse(offset);z.number().int().min(1).max(100).parse(limit);this.lab.assertBrandActive(brandId);
  const total=Number((this.lab.db.prepare('SELECT COUNT(*) n FROM console_agent_analysis WHERE brand_id=?').get(brandId) as {n:number}).n),rows=this.lab.db.prepare('SELECT * FROM console_agent_analysis WHERE brand_id=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?').all(brandId,limit,offset) as Row[];
  return {brandId,total,offset,limit,nextOffset:offset+limit<total?offset+limit:null,rows:rows.map(row=>this.fromRow(row)),limitations:['These are Agent-generated analyses, not independently verified facts.','Source hashes and project bindings were verified when each analysis was saved. Later collection can change the current derived GEO report; historical source references are preserved.','Declared provider and model names are supplied by the Agent and are not independently verified. No page edit, collection, paid request or publication is executed by saving.']};
 }
}
