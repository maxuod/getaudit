import {sha256} from '../lib/canonical-json.ts';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {LabService} from './service.ts';
import {validatePattern} from './gsc-analysis.ts';
import {gscInput,gscProperty as property,belongsToGscProperty} from './gsc-contracts.ts';
import type {PublicationRecord} from './keyword-health.ts';
const note=z.object({title:z.string().trim().min(1).max(160),date:z.iso.date(),body:z.string().max(3000),url:z.string().max(2000).optional()}).strict();
const group=z.object({name:z.string().trim().min(1).max(80),field:z.enum(['query','page']),match:z.enum(['contains','prefix','equals','regex','not_regex']),expression:z.string().min(1).max(300)}).strict();
const watch=z.object({query:z.string().trim().min(1).max(1000)}).strict();
const preset=z.object({name:z.string().trim().min(1).max(80),filters:gscInput}).strict();
const preferences=z.object({language:z.enum(['zh','en']),metric:z.enum(['clicks','impressions','ctr','position']),pageSize:z.union([z.literal(25),z.literal(50),z.literal(100)]),hideSuspicious:z.boolean(),autoRead:z.boolean().optional()}).strict();
const publication=z.object({url:z.url().max(2000).transform(value=>new URL(value).toString()),publishedAt:z.iso.date(),source:z.literal('manual'),sourceUrl:z.url().max(2000).optional()}).strict().superRefine((value,context)=>{
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 if(value.publishedAt>today)context.addIssue({code:'custom',path:['publishedAt'],message:'Publication date cannot be in the future.'});
 if(value.sourceUrl){const url=new URL(value.sourceUrl);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)context.addIssue({code:'custom',path:['sourceUrl'],message:'Use an HTTP or HTTPS source URL without credentials.'});}
});
export type GscItem={id:string;property:string;kind:'note'|'group'|'watch'|'preset'|'preferences'|'publication';payload:Record<string,unknown>;created_at:string;updated_at:string};
const schemas={note,group,watch,preset,preferences,publication};
export class GscWorkspace{
 private lab:LabService;
 constructor(lab:LabService){this.lab=lab;lab.db.exec(`CREATE TABLE IF NOT EXISTS console_gsc_item(id TEXT PRIMARY KEY,property TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),deleted_at TEXT);
 CREATE INDEX IF NOT EXISTS console_gsc_item_scope ON console_gsc_item(property,kind,deleted_at);
 CREATE TABLE IF NOT EXISTS console_gsc_inspection(id TEXT PRIMARY KEY,property TEXT NOT NULL,captured_at TEXT NOT NULL,payload TEXT NOT NULL,hash TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS console_gsc_inspection_no_update BEFORE UPDATE ON console_gsc_inspection BEGIN SELECT RAISE(ABORT,'索引证据不可修改'); END;
 CREATE TRIGGER IF NOT EXISTS console_gsc_inspection_no_delete BEFORE DELETE ON console_gsc_inspection BEGIN SELECT RAISE(ABORT,'索引证据不可删除'); END;`);}
 list(site:string){property.parse(site);return (this.lab.db.prepare('SELECT id,property,kind,payload,created_at,updated_at FROM console_gsc_item WHERE property=? AND deleted_at IS NULL ORDER BY created_at DESC,rowid DESC').all(site) as unknown as (Omit<GscItem,'payload'>&{payload:string})[]).map(r=>({...r,payload:JSON.parse(r.payload)}));}
 publications(site:string):PublicationRecord[]{return this.list(site).filter(item=>item.kind==='publication').map(item=>publication.parse(item.payload));}
 save(requestId:string,input:unknown){
  const v=z.object({id:z.string().uuid().optional(),property,kind:z.enum(['note','group','watch','preset','preferences','publication']),payload:z.unknown()}).strict().parse(input);
  const payload=schemas[v.kind].parse(v.payload);
  if(v.kind==='group'&&['regex','not_regex'].includes(String((payload as {match?:string}).match)))validatePattern((payload as {expression:string}).expression);
  if(v.kind==='preset'&&(payload as z.infer<typeof preset>).filters.property!==v.property)throw new Error('预设的网站与当前项目不一致');
  if(v.kind==='publication'){
   if(!belongsToGscProperty(v.property,(payload as PublicationRecord).url))throw new Error('Publication URL must be an HTTPS URL belonging to the selected property.');
  }
  return this.lab.command(requestId,'gsc-item-save',{...v,payload},()=>{
   const duplicate=v.kind==='publication'?this.lab.db.prepare("SELECT id FROM console_gsc_item WHERE property=? AND kind='publication' AND deleted_at IS NULL AND json_extract(payload,'$.url')=? ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(v.property,(payload as PublicationRecord).url) as {id:string}|undefined:undefined;
   if(v.id&&duplicate&&duplicate.id!==v.id)throw new Error('A publication date is already saved for this URL; update that record instead.');
   const id=v.id??duplicate?.id??randomUUID();
   if(v.id||duplicate){const old=this.lab.db.prepare('SELECT property,kind FROM console_gsc_item WHERE id=? AND deleted_at IS NULL').get(id) as {property:string;kind:string}|undefined;if(!old||old.property!==v.property||old.kind!==v.kind)throw new Error('找不到当前项目的条目');this.lab.db.prepare("UPDATE console_gsc_item SET payload=?,updated_at=datetime('now') WHERE id=?").run(JSON.stringify(payload),id);}
   else this.lab.db.prepare('INSERT INTO console_gsc_item(id,property,kind,payload) VALUES(?,?,?,?)').run(id,v.property,v.kind,JSON.stringify(payload));
   return {id};
  });
 }
 remove(requestId:string,input:unknown){const v=z.object({id:z.string().uuid(),property}).strict().parse(input);return this.lab.command(requestId,'gsc-item-remove',v,()=>{const r=this.lab.db.prepare("UPDATE console_gsc_item SET deleted_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND property=? AND deleted_at IS NULL").run(v.id,v.property);if(!r.changes)throw new Error('条目不存在或已移除');return {ok:true};});}
 importNotes(requestId:string,input:unknown){const v=z.object({property,notes:z.array(note).min(1).max(500)}).strict().parse(input);return this.lab.command(requestId,'gsc-note-import',v,()=>{for(const payload of v.notes)this.lab.db.prepare("INSERT INTO console_gsc_item(id,property,kind,payload) VALUES(?,?,'note',?)").run(randomUUID(),v.property,JSON.stringify(payload));return {count:v.notes.length};});}
 inspections(site:string){property.parse(site);return this.lab.db.prepare('SELECT id,captured_at,hash,payload FROM console_gsc_inspection WHERE property=? ORDER BY captured_at DESC LIMIT 100').all(site).map(r=>{if(sha256(String(r.payload))!==r.hash)throw new Error('索引证据哈希校验失败');return {...r,payload:JSON.parse(String(r.payload))};});}
}
