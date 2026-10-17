import {gunzipSync} from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LabService } from './service.ts';
import { canonicalJson, sha256 } from '../lib/canonical-json.ts';
import { type PersistSettings } from './settings.ts';
import {GscWorkspace} from './gsc-workspace.ts';
import {gscInput,gscProperty,belongsToGscProperty} from './gsc-contracts.ts';
import {fetchGscSitemap} from './gsc-sitemap-network.ts';
import {resolvePublicHost,type ResolveHost} from './keyword-audit-evidence.ts';
const scope='https://www.googleapis.com/auth/webmasters.readonly';
const base='https://www.googleapis.com/webmasters/v3';
const credentials=z.object({GSC_CLIENT_ID:z.string().min(1),GSC_CLIENT_SECRET:z.string().optional(),GSC_REFRESH_TOKEN:z.string().min(1)});
const metric=z.object({keys:z.array(z.string()).optional(),clicks:z.number().nonnegative(),impressions:z.number().nonnegative(),ctr:z.number().min(0).max(1),position:z.number().nonnegative()});
const response=z.object({rows:z.array(metric).optional(),responseAggregationType:z.string().optional()});
export type GscRow=z.infer<typeof metric>;
export type GscDataset={totals:GscRow|null;queries:GscRow[];pages:GscRow[];daily?:GscRow[];queryDaily?:GscRow[];pageDaily?:GscRow[];queryPages?:GscRow[];countries?:GscRow[];devices?:GscRow[];details?:GscRow[];truncated?:string[]};
export type GscSnapshot=GscDataset & {id:string;property:string;capturedAt:string;startDate:string;endDate:string;country:string;device?:string;query?:string;page?:string;timeZone:string;type:'web'|'image'|'video'|'news'|'discover'|'googleNews';dataState:'final';source:string;requests:unknown[];raw:unknown[];comparison?:(GscDataset & {startDate:string;endDate:string});monthlyPages?:{month:string;rows:GscRow[];truncated:boolean}[];limitations:string[]};
export type GscEvidence={snapshot:GscSnapshot;hash:string};
export {gscInput} from './gsc-contracts.ts';
export function initGsc(service:LabService){
 service.db.exec(`CREATE TABLE IF NOT EXISTS console_gsc_snapshot(id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, property TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS console_gsc_snapshot_immutable_update BEFORE UPDATE ON console_gsc_snapshot BEGIN SELECT RAISE(ABORT,'GSC 快照不可修改'); END;
 CREATE TRIGGER IF NOT EXISTS console_gsc_snapshot_immutable_delete BEFORE DELETE ON console_gsc_snapshot BEGIN SELECT RAISE(ABORT,'GSC 快照不可删除'); END;`);
}
export class GscConnector {
 private service:LabService;
 private fetcher:typeof fetch;
 private resolveHost:ResolveHost;
 constructor(service:LabService,fetcher:typeof fetch=fetch,resolveHost:ResolveHost=resolvePublicHost,private readonly accountToken?: (signal?:AbortSignal)=>Promise<{accessToken:string;scopes:string[]}|null>,private readonly accountContext?:()=>string){this.service=service;this.fetcher=fetcher;this.resolveHost=resolveHost;initGsc(service);new GscWorkspace(service);}
 private async json(url:string,init?:RequestInit,signal?:AbortSignal){
  let r:Response;
  try{signal?.throwIfAborted();r=await this.fetcher(url,{...init,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});signal?.throwIfAborted();}catch{throw new Error(signal?.aborted?'GSC 后台读取已停止；旧快照保留':'GSC 网络连接失败或超时；没有保存零值快照，请重试');}
  if(!r.ok){
   const body=await r.json().catch(()=>({})) as {error?:unknown};
   if(body.error==='invalid_grant')throw new Error('GSC 授权已过期或撤销，请重新授权后更新连接配置');
   throw new Error(`GSC 请求失败（HTTP ${r.status}）；请检查授权和属性权限`);
  }
  return r.json();
 }
 private async token(values:unknown=process.env,signal?:AbortSignal){
  if(values===process.env&&this.accountToken){const managed=await this.accountToken(signal);if(managed){if(!managed.accessToken||!managed.scopes.includes(scope)||managed.scopes.includes('https://www.googleapis.com/auth/webmasters'))throw new Error('Allow read-only Search Console access to continue.');return managed.accessToken;}}
  const c=credentials.safeParse(values);if(!c.success)throw new Error('请先导入已有 GSC 只读授权，或在 API 连接中配置 GSC 凭据');
  const body=new URLSearchParams({client_id:c.data.GSC_CLIENT_ID,refresh_token:c.data.GSC_REFRESH_TOKEN,grant_type:'refresh_token'});if(c.data.GSC_CLIENT_SECRET)body.set('client_secret',c.data.GSC_CLIENT_SECRET);
  const r=await this.json('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body},signal) as {access_token?:string;scope?:string};
  if(!r.access_token)throw new Error('GSC 没有返回有效授权');
  // Never accept an unverified scope or a write-capable grant.
  const scopes=(r.scope??'').split(' ');if(!scopes.includes(scope)||scopes.includes('https://www.googleapis.com/auth/webmasters'))throw new Error('此连接需要已验证的 GSC 只读权限，请使用 webmasters.readonly 重新授权');
  return r.access_token;
 }
 private async sites(token:string,signal?:AbortSignal){
  const r=await this.json(base+'/sites',{headers:{Authorization:'Bearer '+token}},signal) as {siteEntry?:{siteUrl:string;permissionLevel:string}[]};
  if(!Array.isArray(r.siteEntry))return [];
  return r.siteEntry.filter(s=>s&&gscProperty.safeParse(s.siteUrl).success&&['siteOwner','siteFullUser','siteRestrictedUser'].includes(s.permissionLevel));
 }
 async available(){const context=this.accountContext?.();const sites=await this.sites(await this.token());this.assertAccount(context);return sites;}
 private assertAccount(context:string|undefined){if(this.accountContext&&context!==this.accountContext())throw new Error('The Google account changed. Reconnect before reading data.');}
 async importExisting(_persist?:PersistSettings):Promise<{ok:boolean;sites:{siteUrl:string;permissionLevel:string}[]}>{
  // Public builds never search the host filesystem for another application's grant.
  throw new Error('Use Continue with Google to connect your own read-only account. Local grant discovery is disabled.');
 }
 private assertUrl(property:string,value:string){
  gscProperty.parse(property);let u:URL;try{u=new URL(value);}catch{throw new Error('请输入完整 URL');}
  if(!belongsToGscProperty(property,value))throw new Error('URL 必须属于所选网站属性并使用 HTTPS');
  return u.toString();
 }
 async sitemap(input:unknown){
  const context=this.accountContext?.();
  const v=z.object({property:gscProperty,url:z.url()}).strict().parse(input),pending=[this.assertUrl(v.property,v.url)],seen=new Set<string>(),urls=new Set<string>();
  const token=await this.token();if(!(await this.sites(token)).some(site=>site.siteUrl===v.property))throw new Error('当前授权无法读取所选网站');
  const decode=(s:string)=>s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");let limited=false;
  while(pending.length&&seen.size<20){
   let url=pending.shift()!;if(seen.has(url))continue;seen.add(url);let r:Response|undefined;
   for(let redirects=0;redirects<5;redirects++){
    r=await fetchGscSitemap(url,this.fetcher,this.resolveHost);
    if(![301,302,303,307,308].includes(r.status))break;
    const next=r.headers.get('location');if(!next)throw new Error('站点地图跳转缺少目标');url=this.assertUrl(v.property,new URL(next,url).toString());await r.body?.cancel();r=undefined;
   }
   if(!r?.ok)throw new Error('站点地图未能读取；检查网址和网站响应');
   const reader=r.body?.getReader();if(!reader)throw new Error('站点地图没有正文');const chunks:Uint8Array[]=[];let size=0;
   for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>5*1024*1024){await reader.cancel();throw new Error('单个站点地图超过 5 MiB，请使用较小的子站点地图');}chunks.push(part.value);}
   const bytes=Buffer.concat(chunks),xml=(bytes[0]===0x1f&&bytes[1]===0x8b?gunzipSync(bytes,{maxOutputLength:5*1024*1024}):bytes).toString('utf8');if(!/<(?:sitemapindex|urlset)(?:\s|>)/i.test(xml))throw new Error('此地址没有返回 sitemap XML');
   for(const match of xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)){
    let loc=decode(match[1]!.trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/,'$1'));try{loc=this.assertUrl(v.property,loc);}catch{continue;}
    if(/<sitemapindex\b/i.test(xml)){if(!seen.has(loc))pending.push(loc);}else{urls.add(loc);if(urls.size>=20000){limited=true;break;}}
   }
   if(limited)break;
  }
  this.assertAccount(context);
  return {property:v.property,source:v.url,loadedAt:new Date().toISOString(),urls:[...urls],files:seen.size,limited:limited||pending.length>0};
 }
 async inspect(requestId:string,input:unknown){
  const context=this.accountContext?.();
  z.string().uuid().parse(requestId);
  const v=z.object({property:gscProperty,urls:z.array(z.url()).min(1).max(100)}).strict().parse(input);v.urls=[...new Set(v.urls.map(url=>this.assertUrl(v.property,url)))];
  const fingerprint=sha256(canonicalJson({kind:'gsc-inspect',input:v})),old=this.service.db.prepare('SELECT fingerprint,result FROM console_command WHERE id=?').get(requestId) as {fingerprint:string;result:string}|undefined;
  if(old){if(old.fingerprint!==fingerprint)throw new Error('请求标识已被另一操作使用');const saved=this.service.db.prepare('SELECT payload,hash FROM console_gsc_inspection WHERE id=?').get((JSON.parse(old.result) as {id:string}).id) as {payload:string;hash:string};if(sha256(saved.payload)!==saved.hash)throw new Error('索引证据哈希校验失败');return {...JSON.parse(saved.payload),hash:saved.hash};}
  const token=await this.token();if(!(await this.sites(token)).some(s=>s.siteUrl===v.property))throw new Error('当前授权无法读取所选网站');
  const results:{url:string;status:'ok'|'error';raw?:unknown;message?:string}[]=[];
  for(const url of v.urls){try{const raw=await this.json('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({inspectionUrl:url,siteUrl:v.property,languageCode:'zh-CN'})});results.push({url,status:'ok',raw});}catch(error){results.push({url,status:'error',message:error instanceof Error?error.message:'检查失败'});break;}}
  const payload={id:randomUUID(),property:v.property,capturedAt:new Date().toISOString(),source:'Google URL Inspection API / indexed version',requested:v.urls.length,remaining:v.urls.slice(results.length),results},hash=sha256(canonicalJson(payload));
  this.assertAccount(context);
  this.service.command(requestId,'gsc-inspect',v,()=>{this.service.db.prepare('INSERT INTO console_gsc_inspection VALUES(?,?,?,?,?)').run(payload.id,v.property,payload.capturedAt,canonicalJson(payload),hash);return {id:payload.id};});return {...payload,hash};
 }
 history(){return this.service.db.prepare("SELECT id,captured_at,property,hash,json_extract(payload,'$.startDate') startDate,json_extract(payload,'$.endDate') endDate,json_extract(payload,'$.country') country,json_extract(payload,'$.daily') IS NOT NULL dashboard FROM console_gsc_snapshot ORDER BY captured_at DESC,rowid DESC LIMIT 100").all();}
 saved(id:string):GscEvidence{
  z.string().uuid().parse(id);const row=this.service.db.prepare('SELECT payload,hash FROM console_gsc_snapshot WHERE id=?').get(id) as {payload:string;hash:string}|undefined;
  if(!row)throw new Error('找不到 GSC 快照');const snapshot=JSON.parse(row.payload) as GscSnapshot;
  if(sha256(canonicalJson(snapshot))!==row.hash)throw new Error('GSC 快照哈希校验失败');return {snapshot,hash:row.hash};
 }
 async capture(requestId:string,input:unknown,signal?:AbortSignal):Promise<GscEvidence>{
  const context=this.accountContext?.();
  z.string().uuid().parse(requestId);const v=gscInput.parse(input);
  const prev=this.service.db.prepare('SELECT fingerprint,result FROM console_command WHERE id=?').get(requestId) as {fingerprint:string;result:string}|undefined;
  if(prev){if(prev.fingerprint!==sha256(canonicalJson({kind:'gsc',input:v})))throw new Error('请求标识已被另一操作使用');return this.saved((JSON.parse(prev.result) as {id:string}).id);}
  const token=await this.token(process.env,signal);if(!(await this.sites(token,signal)).some(s=>s.siteUrl===v.property))throw new Error('当前授权无法读取所选网站');
  const requests:unknown[]=[],raw:unknown[]=[],filters:{dimension:string;operator:string;expression:string}[]=[];
  if(v.country!=='ALL')filters.push({dimension:'country',operator:'equals',expression:v.country});
  if(v.device&&v.device!=='ALL')filters.push({dimension:'device',operator:'equals',expression:v.device});
  if(v.query)filters.push({dimension:'query',operator:'contains',expression:v.query});
  if(v.page)filters.push({dimension:'page',operator:'contains',expression:v.page});
  const query=async(startDate:string,endDate:string,dimensions:string[],paginate=true)=>{
    const rows:GscRow[]=[];let truncated=false;
    // Bounded pagination is explicit. Raw request/response pairs remain in the frozen evidence.
    for(let startRow=0;startRow<(v.dashboard&&paginate?100000:25000);startRow+=25000){
      const body={startDate,endDate,type:v.type??'web',dataState:'final',dimensions,rowLimit:dimensions.length?25000:1,...(startRow?{startRow}:{}),...(filters.length?{dimensionFilterGroups:[{groupType:'and',filters}]}:{})};
      const value=await this.json(base+'/sites/'+encodeURIComponent(v.property)+'/searchAnalytics/query',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)},signal);
      requests.push(body);raw.push(value);const batch=response.parse(value).rows??[];if(batch.some(r=>(r.keys?.length??0)!==dimensions.length))throw new Error('GSC 返回的维度与请求不一致；没有保存快照');rows.push(...batch);
      if(!dimensions.length||batch.length<25000)break;
      truncated=true;if(!v.dashboard||!paginate||startRow===75000)break;truncated=false;
    }
    return {rows,truncated};
  };
  const specs:[keyof GscDataset,string[]][]=[['totals',[]],['queries',['query']],['pages',['page']]];
  if(v.dashboard)specs.push(['daily',['date']],['queryDaily',['date','query']],['pageDaily',['date','page']],['queryPages',['query','page']],['countries',['country']],['devices',['device']],['details',['query','page','device','country']]);
  const dataset=async(startDate:string,endDate:string)=>{
    const data:GscDataset={totals:null,queries:[],pages:[],truncated:[]};
    for(const [name,dimensions] of specs){const part=await query(startDate,endDate,dimensions);if(name==='totals')data.totals=part.rows[0]??null;else Object.assign(data,{[name]:part.rows});if(part.truncated)data.truncated!.push(name);}
    return data;
  };
  const current=await dataset(v.startDate,v.endDate);
  const previousEnd=new Date(Date.parse(v.startDate)-86400000).toISOString().slice(0,10),days=(Date.parse(v.endDate)-Date.parse(v.startDate))/86400000+1;
  const previousStart=new Date(Date.parse(v.startDate)-days*86400000).toISOString().slice(0,10);
  const comparison=v.compare?{startDate:previousStart,endDate:previousEnd,...await dataset(previousStart,previousEnd)}:undefined;
  let monthlyPages:GscSnapshot['monthlyPages'];
  if(v.includeMonthly){
    monthlyPages=[];const end=new Date(v.endDate+'T00:00:00Z');
    for(let n=11;n>=0;n--){const first=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()-n,1)),last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0));const start=first.toISOString().slice(0,10),stop=last.toISOString().slice(0,10);const r=await query(start,stop>v.endDate?v.endDate:stop,['page']);monthlyPages.push({month:start.slice(0,7),rows:r.rows,truncated:r.truncated});}
  }
  const snapshot:GscSnapshot={id:randomUUID(),property:v.property,country:v.country,startDate:v.startDate,endDate:v.endDate,capturedAt:new Date().toISOString(),timeZone:'America/Los_Angeles',type:v.type??'web',dataState:'final',...(v.device?{device:v.device}:{}),...(v.query?{query:v.query}:{}),...(v.page?{page:v.page}:{}),source:'Google Search Console API / searchAnalytics.query',requests,raw,...current,...(comparison?{comparison}:{}),...(monthlyPages?{monthlyPages}:{}),limitations:[`每组最多 ${v.dashboard?'100,000':'25,000'} 行，达到上限时明确标记；API 只保证部分热门行，不保证穷尽。`,'匿名查询可能省略；查询行、页面行、联合维度行的合计不等于属性总计。','这是搜索表现，不是 AI 回答、引用或生成式 AI 专属报告。','日期以太平洋时间统计；只请求已最终确定的数据。缺失日期和缺失查询不能直接解释为零流量或消失。','上期未返回的页面只能标记为本期出现，不能据此确定发布或首次索引日期。']};
  signal?.throwIfAborted();const hash=sha256(canonicalJson(snapshot));
  this.assertAccount(context);
  const result=this.service.command(requestId,'gsc',v,()=>{this.service.db.prepare('INSERT INTO console_gsc_snapshot VALUES(?,?,?,?,?)').run(snapshot.id,snapshot.capturedAt,snapshot.property,canonicalJson(snapshot),hash);return {id:snapshot.id};});
  return this.saved(result.id);
 }
}
export function gscMarkdown(e:GscEvidence,locale:'en'|'zh-CN'='en'){const s=e.snapshot;
  if(locale!=='zh-CN')return `# GSC search performance snapshot

Source: ${s.source}
Property: ${s.property}
Dates: ${s.startDate} to ${s.endDate} (${s.timeZone})
Region: ${s.country}
Device: ${s.device??'ALL'}; search type: ${s.type}
Query contains: ${s.query??'None'}; page contains: ${s.page??'None'}
Captured: ${s.capturedAt}
SHA-256: ${e.hash}

${s.totals?`Clicks: ${s.totals.clicks}; impressions: ${s.totals.impressions}; CTR: ${(s.totals.ctr*100).toFixed(2)}%; average position: ${s.totals.position.toFixed(2)}`:'The API returned no total row. This does not establish an absence of site traffic.'}

## Queries

|Query|Clicks|Impressions|CTR|Average position|
|---|---:|---:|---:|---:|
${s.queries.map(r=>`|${(r.keys?.[0]??'').replace(/[|\r\n]/g,' ')}|${r.clicks}|${r.impressions}|${(r.ctr*100).toFixed(2)}%|${r.position.toFixed(2)}|`).join('\n')}

## Pages

${s.pages.map(r=>`${r.keys?.[0]} — Clicks ${r.clicks}, impressions ${r.impressions}, average position ${r.position.toFixed(2)}`).join('\n\n')}

## Recorded limitations (original wording)

${s.limitations.map(l=>'- '+l).join('\n')}
`;
return `# GSC 搜索表现快照\n\n来源：${s.source}\n属性：${s.property}\n日期：${s.startDate} 至 ${s.endDate}（${s.timeZone}）\n地区：${s.country}\n设备：${s.device??'ALL'}；搜索类型：${s.type}\n查询词包含：${s.query??'无'}；页面包含：${s.page??'无'}\n采集：${s.capturedAt}\nSHA-256：${e.hash}\n\n${s.totals?`点击：${s.totals.clicks}；展示：${s.totals.impressions}；CTR：${(s.totals.ctr*100).toFixed(2)}%；平均排名：${s.totals.position.toFixed(2)}`:'API 未返回总计行；不据此推断站点没有流量。'}\n\n## 搜索词\n\n|搜索词|点击|展示|CTR|平均排名|\n|---|---:|---:|---:|---:|\n${s.queries.map(r=>`|${(r.keys?.[0]??'').replace(/[|\r\n]/g,' ')}|${r.clicks}|${r.impressions}|${(r.ctr*100).toFixed(2)}%|${r.position.toFixed(2)}|`).join('\n')}\n\n## 页面\n\n${s.pages.map(r=>`${r.keys?.[0]} — 点击 ${r.clicks}，展示 ${r.impressions}，平均排名 ${r.position.toFixed(2)}`).join('\n\n')}\n\n## 数据限制\n\n${s.limitations.map(l=>'- '+l).join('\n')}\n`;}
