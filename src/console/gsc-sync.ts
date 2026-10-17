import {randomUUID} from 'node:crypto';
import {canonicalJson} from '../lib/canonical-json.ts';
import type {LabService} from './service.ts';
import {GscConnector,gscInput,type GscEvidence} from './gsc.ts';
import {GscWorkspace} from './gsc-workspace.ts';
import {gscProperty} from './gsc-contracts.ts';

const DAY=24*60*60*1000,RETRY=15*60*1000;
const legacyProperties:string[]=[];
export type GscSyncState={property:string;phase:'queued'|'refreshing'|'fresh'|'error';updatedAt:string;message:string;snapshotId?:string;nextRefreshAt?:string;retryAt?:string};
export type GscSyncResult={evidence:GscEvidence;cached:boolean;nextRefreshAt:string};
export type GscSyncOptions={canAutoRead?:()=>boolean;requireExplicitOptIn?:()=>boolean};

/** One shared reader per Console. Frozen evidence is reused, never rewritten. */
export class GscSync {
 private lab:LabService;
 private connector:GscConnector;
 private now:()=>number;
 private inflight=new Map<string,Promise<GscSyncResult>>();
 private states=new Map<string,GscSyncState>();
 private tail:Promise<unknown>=Promise.resolve();
 private timer:ReturnType<typeof setInterval>|undefined;
 private controller:AbortController|undefined;
 private stopped=false;
 private generation=0;
 private pauseLeases=new Set<symbol>();
 private onSnapshot?:()=>void;
 private options:GscSyncOptions;
 constructor(lab:LabService,connector=new GscConnector(lab),now=Date.now,onSnapshot?:()=>void,options:GscSyncOptions={}){this.lab=lab;this.connector=connector;this.now=now;this.onSnapshot=onSnapshot;this.options=options;}
 private enabled(property:string){const preference=new GscWorkspace(this.lab).list(property).find(i=>i.kind==='preferences')?.payload.autoRead;return preference===true;}
 private canAutoRead(){return this.options.canAutoRead?.()??['GSC_CLIENT_ID','GSC_REFRESH_TOKEN'].every(key=>process.env[key]);}
 private properties(){
  const saved=this.lab.db.prepare('SELECT DISTINCT property FROM console_gsc_item WHERE deleted_at IS NULL UNION SELECT DISTINCT property FROM console_gsc_snapshot').all() as {property:string}[];
  return [...new Set([...legacyProperties,...saved.map(row=>row.property),...[...this.states.values()].map(state=>state.property)])].filter(property=>gscProperty.safeParse(property).success);
 }
 private normalize(input:unknown){const v=gscInput.parse(input);return {...v,device:v.device??'ALL',type:v.type??'web',query:v.query??'',page:v.page??'',dashboard:v.dashboard??true,compare:v.compare??true,includeMonthly:v.includeMonthly??true};}
 private latest(v:ReturnType<GscSync['normalize']>){
  const row=this.lab.db.prepare(`SELECT id FROM console_gsc_snapshot WHERE property=?
   AND json_extract(payload,'$.startDate')=? AND json_extract(payload,'$.endDate')=? AND json_extract(payload,'$.country')=?
   AND coalesce(json_extract(payload,'$.device'),'ALL')=? AND json_extract(payload,'$.type')=?
   AND coalesce(json_extract(payload,'$.query'),'')=? AND coalesce(json_extract(payload,'$.page'),'')=?
   AND (?=0 OR json_type(payload,'$.daily')='array')
   AND (json_type(payload,'$.comparison') IS NOT NULL)=?
   AND (?=0 OR json_type(payload,'$.monthlyPages')='array') ORDER BY captured_at DESC,rowid DESC LIMIT 1`)
   .get(v.property,v.startDate,v.endDate,v.country,v.device,v.type,v.query,v.page,Number(v.dashboard),Number(v.compare),Number(v.includeMonthly)) as {id:string}|undefined;
  return row?this.connector.saved(row.id):undefined;
 }
 status(){return {running:!!this.timer&&!this.pauseLeases.size,paused:!!this.pauseLeases.size,intervalHours:24,sites:this.properties().map(property=>({property,enabled:this.enabled(property),state:[...this.states.values()].filter(s=>s.property===property).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0]??null}))};}
 private assertReadable(generation=this.generation){
  if(this.stopped)throw new Error('软件正在退出，自动读取已停止');
  if(this.pauseLeases.size||generation!==this.generation)throw Object.assign(new Error('GSC 后台读取已停止；旧快照保留'),{code:'google_connection_changing'});
 }
 refresh(input:unknown,force=false):Promise<GscSyncResult>{
  try{this.assertReadable();}catch(error){return Promise.reject(error);}
  const generation=this.generation;
  const v=this.normalize(input),key=canonicalJson(v),active=this.inflight.get(key);
  if(active)return active;
  const now=this.now(),saved=this.latest(v),expiry=saved?Date.parse(saved.snapshot.capturedAt)+DAY:0;
  if(!force&&saved&&expiry>now){const nextRefreshAt=new Date(expiry).toISOString();this.states.set(key,{property:v.property,phase:'fresh',message:'已读取本地快照',updatedAt:new Date(now).toISOString(),snapshotId:saved.snapshot.id,nextRefreshAt});return Promise.resolve({evidence:saved,cached:true,nextRefreshAt});}
  const failed=this.states.get(key);
  if(!force&&failed?.phase==='error'&&Date.parse(failed.retryAt??'')>now)return Promise.reject(new Error(failed.message));
  if(this.inflight.size>=8)return Promise.reject(new Error('已有多个读取条件排队，请等当前读取完成'));
  this.states.set(key,{property:v.property,phase:'queued',message:'等待后台读取',updatedAt:new Date(now).toISOString()});
  const work=this.tail.catch(()=>{}).then(async()=>{
   this.assertReadable(generation);
   this.states.set(key,{property:v.property,phase:'refreshing',message:'正在读取 Google Search Console',updatedAt:new Date(this.now()).toISOString()});
   const controller=new AbortController();this.controller=controller;
   try{
    const evidence=await this.connector.capture(randomUUID(),v,controller.signal);this.assertReadable(generation);
    const nextRefreshAt=new Date(Date.parse(evidence.snapshot.capturedAt)+DAY).toISOString();
    this.states.set(key,{property:v.property,phase:'fresh',message:'真实数据已更新',updatedAt:new Date(this.now()).toISOString(),snapshotId:evidence.snapshot.id,nextRefreshAt});
    this.onSnapshot?.();
    return {evidence,cached:false,nextRefreshAt};
   }catch(error){if(!this.stopped&&!this.pauseLeases.size&&generation===this.generation){const message=error instanceof Error?error.message:'GSC 自动读取失败';this.states.set(key,{property:v.property,phase:'error',message,updatedAt:new Date(this.now()).toISOString(),retryAt:new Date(this.now()+RETRY).toISOString()});}throw error;}
   finally{if(this.controller===controller)this.controller=undefined;}
  });
  this.inflight.set(key,work);this.tail=work;
  void work.finally(()=>{if(this.inflight.get(key)===work)this.inflight.delete(key);if(this.states.size>128){for(const old of this.states.keys()){if(old!==key&&!this.inflight.has(old)){this.states.delete(old);break;}}}}).catch(()=>{});
  return work;
 }
 /** Latest complete-day window. Google determines the final available rows. */
 defaultInput(property:string){gscProperty.parse(property);const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(this.now())),date=(days:number)=>new Date(Date.parse(today)-days*86400000).toISOString().slice(0,10);return {property,startDate:date(30),endDate:date(3),country:legacyProperties.includes(property)?'CAN':'ALL',dashboard:true,compare:true,includeMonthly:true};}
 async tick(){
  if(this.stopped||this.pauseLeases.size||!this.canAutoRead())return;
  const generation=this.generation;
  for(const property of this.properties()){if(this.stopped||this.pauseLeases.size||generation!==this.generation||!this.canAutoRead())break;if(!this.enabled(property))continue;try{await this.refresh(this.defaultInput(property));}catch{/* Status retains the reason; never invent an empty snapshot. */}}
 }
 start(){if(this.timer||this.stopped)return;this.timer=setInterval(()=>void this.tick(),30*60*1000);this.timer.unref();if(!this.pauseLeases.size)void this.tick();}
 /** Drain the old account's reads without terminating the service. Each transition owns its release. */
 async pause():Promise<()=>void>{
  const lease=Symbol('google-account-transition');this.pauseLeases.add(lease);this.generation++;this.states.clear();this.controller?.abort();
  await Promise.allSettled([...this.inflight.values()]);
  // Releasing a lease does not start collection; existing opt-ins/timers and explicit reads remain authoritative.
  return ()=>{this.pauseLeases.delete(lease);};
 }
 /** Final application shutdown. Releasing a transition lease can never restart this reader. */
 async stop(){this.stopped=true;this.generation++;if(this.timer)clearInterval(this.timer);this.timer=undefined;this.controller?.abort();await Promise.allSettled([...this.inflight.values()]);}
}
