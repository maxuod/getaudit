import {randomUUID} from 'node:crypto';
import {z} from 'zod';

export const GA4_READ_SCOPE='https://www.googleapis.com/auth/analytics.readonly';
const ADMIN='https://analyticsadmin.googleapis.com/v1beta';
const DATA='https://analyticsdata.googleapis.com/v1beta';
const PAGE_SIZE=1000;
const MAX_ROWS=10000;
export const ga4Metrics=['activeUsers','sessions','screenPageViews','keyEvents'] as const;
export const ga4Property=z.string().regex(/^properties\/[1-9]\d{0,29}$/);
export const ga4Input=z.object({property:ga4Property,startDate:z.iso.date().optional(),endDate:z.iso.date().optional()}).strict().superRefine((value,context)=>{
 if(Boolean(value.startDate)!==Boolean(value.endDate))context.addIssue({code:'custom',message:'Provide both the start and end date.'});
 if(value.startDate&&value.endDate&&(value.startDate>value.endDate||(Date.parse(value.endDate)-Date.parse(value.startDate))/86400000>365))context.addIssue({code:'custom',message:'Choose a valid date range of no more than 366 days.'});
});

export type Ga4ErrorCode='scope_required'|'reconnect_required'|'access_denied'|'api_disabled'|'rate_limited'|'unavailable'|'invalid_response'|'aborted'|'property_unavailable'|'pagination_limit';
const messages:Record<Ga4ErrorCode,string>={
 scope_required:'Allow read-only Google Analytics access to view GA4 data.',
 reconnect_required:'Reconnect Google to restore GA4 access.',
 access_denied:'This Google account cannot read the selected GA4 property.',
 api_disabled:'Google Analytics Admin API and Data API must be enabled for the application.',
 rate_limited:'Google Analytics is temporarily limiting requests. Try again later.',
 unavailable:'Google Analytics could not be reached. Your saved data has been kept.',
 invalid_response:'Google Analytics returned an incomplete or unexpected response. No new snapshot was saved.',
 aborted:'The GA4 read was stopped. Your saved data has been kept.',
 property_unavailable:'Choose a GA4 property available to this Google account.',
 pagination_limit:'The GA4 property list exceeds this request limit. No partial list was returned.',
};
export class Ga4Error extends Error {
 constructor(readonly code:Ga4ErrorCode,readonly httpStatus?:number){super(messages[code]);this.name='Ga4Error';}
}
export type Ga4Token={accessToken:string;scopes:string[]|string};
export type Ga4Options={tokenProvider:(signal?:AbortSignal)=>Promise<Ga4Token>;fetcher?:typeof fetch;now?:()=>Date};
export type Ga4Property={property:string;displayName:string;account:string;accountDisplayName:string};
export type Ga4Values=Record<(typeof ga4Metrics)[number],number>;
export type Ga4DailyRow=Ga4Values & {date:string};
export type Ga4SourceRow=Ga4Values & {source:string;medium:string};
export type Ga4ReportReceipt={kind:'totals'|'daily'|'sources';request:Record<string,unknown>;response:Record<string,unknown>};
export type Ga4Snapshot={
 id:string;property:string;displayName:string;account:string;accountDisplayName:string;
 capturedAt:string;startDate:string;endDate:string;timeZone:string;
 source:'Google Analytics Data API / properties.runReport';access:'read_only';
 requestedDateRange:{startDate:string;endDate:string};metrics:readonly (typeof ga4Metrics)[number][];
 totals:Ga4Values|null;daily:Ga4DailyRow[];sources:Ga4SourceRow[];
 reports:Ga4ReportReceipt[];truncated:('daily'|'sources')[];limitations:string[];
};

const summaries=z.object({accountSummaries:z.array(z.object({account:z.string(),displayName:z.string().optional(),propertySummaries:z.array(z.object({property:ga4Property,displayName:z.string().optional()})).optional()})).optional(),nextPageToken:z.string().optional()});
const value=z.object({value:z.string()});
const reportSchema=z.object({dimensionHeaders:z.array(z.object({name:z.string()})).optional(),metricHeaders:z.array(z.object({name:z.string()})),rows:z.array(z.object({dimensionValues:z.array(value).optional(),metricValues:z.array(value)})).optional(),rowCount:z.number().int().nonnegative().optional(),metadata:z.record(z.string(),z.unknown()).optional()});
const properties=z.object({name:ga4Property,timeZone:z.string().min(1),displayName:z.string().optional(),deleteTime:z.string().optional()});

function parsed<T>(schema:z.ZodType<T>,input:unknown):T {
 const result=schema.safeParse(input);if(!result.success)throw new Ga4Error('invalid_response');return result.data;
}
function dateInZone(date:Date,timeZone:string){
 try{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  return ['year','month','day'].map(type=>parts.find(part=>part.type===type)!.value).join('-');
 }catch{throw new Ga4Error('invalid_response');}
}
function offsetDate(day:string,offset:number){return new Date(Date.parse(day+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);}
function metricValues(row:z.infer<typeof reportSchema>['rows'] extends (infer T)[]|undefined?T:never):Ga4Values {
 if(row.metricValues.length!==ga4Metrics.length)throw new Ga4Error('invalid_response');
 const values=row.metricValues.map(metric=>{
  if(!/^(?:\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?$/.test(metric.value))throw new Ga4Error('invalid_response');
  const number=Number(metric.value);if(!Number.isFinite(number)||number<0)throw new Ga4Error('invalid_response');return number;
 });
 return Object.fromEntries(ga4Metrics.map((name,index)=>[name,values[index]!])) as Ga4Values;
}

/** Only Admin GETs and Data runReport reads; credentials are supplied by the encrypted account session. */
export class Ga4Connector {
 private readonly fetcher:typeof fetch;
 private readonly now:()=>Date;
 constructor(private readonly options:Ga4Options){this.fetcher=options.fetcher??fetch;this.now=options.now??(()=>new Date());}

 private async token(signal?:AbortSignal){
  if(signal?.aborted)throw new Ga4Error('aborted');
  let token:Ga4Token;
  try{token=await this.options.tokenProvider(signal);}catch(error){
   if(signal?.aborted)throw new Ga4Error('aborted');
   if(error instanceof Ga4Error)throw error;
   const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
   throw new Ga4Error(code==='unavailable'?'unavailable':'reconnect_required');
  }
  const scopes=new Set(typeof token.scopes==='string'?token.scopes.split(/\s+/):token.scopes);
  if(!scopes.has(GA4_READ_SCOPE)||['https://www.googleapis.com/auth/analytics','https://www.googleapis.com/auth/analytics.edit','https://www.googleapis.com/auth/analytics.manage.users','https://www.googleapis.com/auth/analytics.provision'].some(scope=>scopes.has(scope)))throw new Ga4Error('scope_required');
  if(!token.accessToken||/[\r\n]/.test(token.accessToken))throw new Ga4Error('reconnect_required');
  return token.accessToken;
 }

 private async json(url:string,token:string,init?:RequestInit,signal?:AbortSignal):Promise<Record<string,unknown>> {
  let response:Response;
  try{
   signal?.throwIfAborted();
   response=await this.fetcher(url,{...init,redirect:'error',headers:{...init?.headers,Authorization:'Bearer '+token},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
   signal?.throwIfAborted();
  }catch{throw new Ga4Error(signal?.aborted?'aborted':'unavailable');}
  let body:unknown;
  try{body=await response.json();}catch{if(response.ok)throw new Ga4Error('invalid_response');body={};}
  if(!response.ok){
   const error=body&&typeof body==='object'&&'error' in body?body.error:undefined;
   const code=error&&typeof error==='object'&&'status' in error?String(error.status):'';
   const details=error&&typeof error==='object'&&'details' in error&&Array.isArray(error.details)?error.details:[];
   const reasons=details.flatMap(detail=>detail&&typeof detail==='object'&&'reason' in detail?[String(detail.reason)]:[]);
   if(response.status===401||error==='invalid_grant'||code==='UNAUTHENTICATED')throw new Ga4Error('reconnect_required',response.status);
   if(reasons.includes('SERVICE_DISABLED'))throw new Ga4Error('api_disabled',response.status);
   if(response.status===429||code==='RESOURCE_EXHAUSTED')throw new Ga4Error('rate_limited',response.status);
   if(response.status===403)throw new Ga4Error(reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')?'scope_required':'access_denied',response.status);
   if(response.status===404)throw new Ga4Error('property_unavailable',response.status);
   throw new Ga4Error('unavailable',response.status);
  }
  if(!body||typeof body!=='object'||Array.isArray(body))throw new Ga4Error('invalid_response');
  return body as Record<string,unknown>;
 }

 private async list(token:string,signal?:AbortSignal):Promise<Ga4Property[]> {
  const result=new Map<string,Ga4Property>(),seen=new Set<string>();let pageToken='';
  for(let page=0;page<100;page++){
   const url=new URL(ADMIN+'/accountSummaries');url.searchParams.set('pageSize','200');if(pageToken)url.searchParams.set('pageToken',pageToken);
   const response=parsed(summaries,await this.json(url.toString(),token,undefined,signal));
   for(const account of response.accountSummaries??[])for(const property of account.propertySummaries??[])result.set(property.property,{property:property.property,displayName:property.displayName??property.property,account:account.account,accountDisplayName:account.displayName??account.account});
   if(!response.nextPageToken)return [...result.values()];
   if(seen.has(response.nextPageToken))throw new Ga4Error('invalid_response');seen.add(response.nextPageToken);pageToken=response.nextPageToken;
  }
  throw new Ga4Error('pagination_limit');
 }

 async available(signal?:AbortSignal){return this.list(await this.token(signal),signal);}

 async overview(input:unknown,signal?:AbortSignal):Promise<Ga4Snapshot> {
  const v=ga4Input.parse(input),token=await this.token(signal);
  const property=(await this.list(token,signal)).find(entry=>entry.property===v.property);
  if(!property)throw new Ga4Error('property_unavailable');
  const metadata=parsed(properties,await this.json(ADMIN+'/'+v.property,token,undefined,signal));
  if(metadata.name!==v.property||metadata.deleteTime)throw new Ga4Error('property_unavailable');
  const captured=this.now(),today=dateInZone(captured,metadata.timeZone);
  const dates={startDate:v.startDate??offsetDate(today,-28),endDate:v.endDate??offsetDate(today,-1)};
  if(dates.endDate>=today)throw new Error('Choose dates before today in the GA4 property time zone.');
  const reports:Ga4ReportReceipt[]=[],truncated:Ga4Snapshot['truncated']=[],limitations=[
   'GA4 reports describe tracked website and app activity. They are separate from Google Search Console clicks, impressions, rankings and AI citations.',
   'Dates use the GA4 property time zone. Recent data may still be processing; consent, filtering, reporting identity and collection setup affect coverage.',
   'Active users are distinct within each report. Daily and traffic-source rows must not be added to reconstruct the total.',
   'Traffic source and medium describe session acquisition; they do not prove an AI citation, a particular answer or a conversion caused by that answer.',
  ];
  const query=async(kind:Ga4ReportReceipt['kind'],dimensions:string[])=>{
   const rows:NonNullable<z.infer<typeof reportSchema>['rows']>=[];let offset=0;
   while(offset<MAX_ROWS){
    const request:Record<string,unknown>={dateRanges:[dates],metrics:ga4Metrics.map(name=>({name})),dimensions:dimensions.map(name=>({name})),limit:String(dimensions.length?PAGE_SIZE:1),offset:String(offset),keepEmptyRows:false,returnPropertyQuota:true,...(dimensions.length?{orderBys:dimensions.map(dimensionName=>({dimension:{dimensionName}}))}:{})};
    const raw=await this.json(DATA+'/'+v.property+':runReport',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)},signal);
    const part=parsed(reportSchema,raw);
    if(JSON.stringify(part.metricHeaders.map(header=>header.name))!==JSON.stringify(ga4Metrics)||JSON.stringify((part.dimensionHeaders??[]).map(header=>header.name))!==JSON.stringify(dimensions))throw new Ga4Error('invalid_response');
    if(part.metadata?.timeZone&&part.metadata.timeZone!==metadata.timeZone)throw new Ga4Error('invalid_response');
    const batch=part.rows??[];
    if(batch.some(row=>(row.dimensionValues?.length??0)!==dimensions.length)||batch.length>(dimensions.length?PAGE_SIZE:1))throw new Ga4Error('invalid_response');
    if(part.rowCount!==undefined&&part.rowCount<offset+batch.length)throw new Ga4Error('invalid_response');
    reports.push({kind,request,response:raw});
    for(const row of batch)metricValues(row);
    rows.push(...batch);
    const more=part.rowCount===undefined?batch.length===PAGE_SIZE:offset+batch.length<part.rowCount;
    if(!dimensions.length){if(more)throw new Ga4Error('invalid_response');break;}
    if(!more)break;
    if(!batch.length)throw new Ga4Error('invalid_response');
    offset+=batch.length;
    if(offset>=MAX_ROWS){truncated.push(kind as 'daily'|'sources');limitations.push(`${kind}: Only the first ${MAX_ROWS.toLocaleString('en-US')} rows were read. This breakdown is incomplete.`);}
   }
   return rows;
  };
  const totalRows=await query('totals',[]),dailyRows=await query('daily',['date']),sourceRows=await query('sources',['sessionSource','sessionMedium']);
  const daily=dailyRows.map(row=>{
   const rawDate=row.dimensionValues![0]!.value;if(!/^\d{8}$/.test(rawDate))throw new Ga4Error('invalid_response');
   const date=rawDate.slice(0,4)+'-'+rawDate.slice(4,6)+'-'+rawDate.slice(6,8);
   if(!z.iso.date().safeParse(date).success||date<dates.startDate||date>dates.endDate)throw new Ga4Error('invalid_response');
   return {date,...metricValues(row)};
  });
  if(!totalRows.length)limitations.push('The API returned no total row. Missing data is not treated as zero activity.');
  if(reports.some(report=>(report.response.metadata as Record<string,unknown>|undefined)?.subjectToThresholding===true))limitations.push('Google marked at least one report as subject to data thresholds; some rows may be withheld.');
  if(reports.some(report=>(report.response.metadata as Record<string,unknown>|undefined)?.dataLossFromOtherRow===true))limitations.push('Google reported high-cardinality aggregation into an (other) row.');
  if(reports.some(report=>Array.isArray((report.response.metadata as Record<string,unknown>|undefined)?.samplingMetadatas)))limitations.push('Google supplied sampling metadata. The original sample sizes remain attached to each report.');
  if(reports.some(report=>Array.isArray((report.response.metadata as Record<string,unknown>|undefined)?.dataTruncationReasons)))limitations.push('Google reported data truncation. Its original reasons remain attached to each report.');
  if(signal?.aborted)throw new Ga4Error('aborted');
  return {id:randomUUID(),...property,displayName:metadata.displayName??property.displayName,capturedAt:captured.toISOString(),...dates,requestedDateRange:{startDate:v.startDate??'28daysAgo',endDate:v.endDate??'yesterday'},timeZone:metadata.timeZone,source:'Google Analytics Data API / properties.runReport',access:'read_only',metrics:ga4Metrics,totals:totalRows[0]?metricValues(totalRows[0]):null,daily,sources:sourceRows.map(row=>({source:row.dimensionValues![0]!.value,medium:row.dimensionValues![1]!.value,...metricValues(row)})),reports,truncated,limitations};
 }
}
