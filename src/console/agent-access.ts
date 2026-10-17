import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {LabService} from './service.ts';

export type AgentKeyInfo={id:string;label:string;brandIds:string[];createdAt:string;lastUsedAt:string|null;revokedAt:string|null;tokenHint:string;canSaveAnalysis:boolean};
type KeyRow={id:string;label:string;brand_ids:string;created_at:string;last_used_at:string|null;revoked_at:string|null;token_hint:string;can_save_analysis:number};
const hash=(key:string)=>createHash('sha256').update(key).digest('hex');
const publicInfo=(row:KeyRow):AgentKeyInfo=>({id:row.id,label:row.label,brandIds:JSON.parse(row.brand_ids),createdAt:row.created_at,lastUsedAt:row.last_used_at,revokedAt:row.revoked_at,tokenHint:row.token_hint,canSaveAnalysis:row.can_save_analysis===1});

/** Independent local read-only credentials. Raw keys are returned once, never stored. */
export class AgentAccessKeys {
 constructor(private lab:LabService,private now=()=>new Date().toISOString()){
  lab.db.exec(`CREATE TABLE IF NOT EXISTS console_agent_key(
   id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,label TEXT NOT NULL,brand_ids TEXT NOT NULL,
   token_hash TEXT NOT NULL UNIQUE,token_hint TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT,revoked_at TEXT,can_save_analysis INTEGER NOT NULL DEFAULT 0
  )`);
  if(!(lab.db.prepare('PRAGMA table_info(console_agent_key)').all() as {name:string}[]).some(row=>row.name==='can_save_analysis'))lab.db.exec('ALTER TABLE console_agent_key ADD COLUMN can_save_analysis INTEGER NOT NULL DEFAULT 0');
 }
 list(){return (this.lab.db.prepare('SELECT id,label,brand_ids,token_hint,created_at,last_used_at,revoked_at,can_save_analysis FROM console_agent_key ORDER BY created_at DESC,rowid DESC LIMIT 200').all() as unknown as KeyRow[]).map(publicInfo);}
 create(requestId:string,input:unknown){
  z.string().uuid().parse(requestId);
  const value=z.object({label:z.string().trim().min(1).max(80),brandIds:z.array(z.string().uuid()).min(1).max(50),canSaveAnalysis:z.boolean().default(false)}).strict().parse(input);
  const brandIds=[...new Set(value.brandIds)].sort();
  for(const id of brandIds)this.lab.assertBrandActive(id);
  const old=this.lab.db.prepare('SELECT id,label,brand_ids,token_hint,created_at,last_used_at,revoked_at,can_save_analysis FROM console_agent_key WHERE request_id=?').get(requestId) as KeyRow|undefined;
  if(old){if(old.label!==value.label||old.brand_ids!==JSON.stringify(brandIds)||Boolean(old.can_save_analysis)!==value.canSaveAnalysis)throw new Error('This key request was already used for different access.');return {...publicInfo(old),key:null,shownOnce:true};}
  const id=randomUUID(),key='gg_'+randomBytes(32).toString('base64url'),createdAt=this.now(),tokenHint=key.slice(-6);
  this.lab.db.prepare('INSERT INTO console_agent_key(id,request_id,label,brand_ids,token_hash,token_hint,created_at,can_save_analysis) VALUES(?,?,?,?,?,?,?,?)').run(id,requestId,value.label,JSON.stringify(brandIds),hash(key),tokenHint,createdAt,Number(value.canSaveAnalysis));
  return {id,label:value.label,brandIds,createdAt,lastUsedAt:null,revokedAt:null,tokenHint,canSaveAnalysis:value.canSaveAnalysis,key,shownOnce:true};
 }
 authenticate(key:string):{allowedBrandIds:string[];keyId:string;canSaveAnalysis:boolean}|null{
  if(!/^gg_[A-Za-z0-9_-]{43}$/.test(key))return null;
  const row=this.lab.db.prepare('SELECT id,brand_ids,can_save_analysis FROM console_agent_key WHERE token_hash=? AND revoked_at IS NULL').get(hash(key)) as {id:string;brand_ids:string;can_save_analysis:number}|undefined;
  if(!row)return null;
  const brandIds=z.array(z.string().uuid()).min(1).max(50).parse(JSON.parse(row.brand_ids));
  this.lab.db.prepare('UPDATE console_agent_key SET last_used_at=? WHERE id=?').run(this.now(),row.id);
  return {allowedBrandIds:brandIds,keyId:row.id,canSaveAnalysis:row.can_save_analysis===1};
 }
 revoke(input:unknown){const {id}=z.object({id:z.string().uuid()}).strict().parse(input);const exists=this.lab.db.prepare('SELECT id FROM console_agent_key WHERE id=?').get(id);if(!exists)throw new Error('Agent key not found.');this.lab.db.prepare('UPDATE console_agent_key SET revoked_at=coalesce(revoked_at,?) WHERE id=?').run(this.now(),id);return {ok:true};}
}
