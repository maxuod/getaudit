import {describe,it,expect} from 'vitest';
import {GA4_READ_SCOPE,Ga4Connector,Ga4Error,ga4Input,ga4Metrics} from '../../src/console/ga4.ts';

type Call={url:string;init?:RequestInit;body?:Record<string,unknown>};
const grant={accessToken:'private-access-token',scopes:['openid','email','https://www.googleapis.com/auth/webmasters.readonly',GA4_READ_SCOPE]};
const listing={accountSummaries:[{account:'accounts/10',displayName:'Example account',propertySummaries:[{property:'properties/100',displayName:'Example GA4'}]}]};
const now=()=>new Date('2026-10-16T00:30:00.000Z');
const metrics=(values=['120','200','300','4'])=>values.map(value=>({value}));
function report(body:Record<string,unknown>,options:{values?:string[];rows?:{dimensionValues:{value:string}[];metricValues:{value:string}[]}[];rowCount?:number;metadata?:Record<string,unknown>}={}){
 const dimensions=(body.dimensions as {name:string}[]).map(dimension=>dimension.name);
 const dates=(body.dateRanges as {startDate:string}[])[0]!;
 const row={dimensionValues:dimensions.map(dimension=>({value:dimension==='date'?dates.startDate.replaceAll('-',''):dimension==='sessionSource'?'google':'organic'})),metricValues:metrics(options.values)};
 return {dimensionHeaders:dimensions.map(name=>({name})),metricHeaders:ga4Metrics.map(name=>({name,type:'TYPE_INTEGER'})),rows:options.rows??[row],rowCount:options.rowCount??options.rows?.length??1,metadata:{timeZone:'America/Los_Angeles',...options.metadata}};
}
function mock(handler?:(call:Call)=>Response|undefined){
 const calls:Call[]=[];
 const fetcher=(async(url:unknown,init?:RequestInit)=>{
  const call:Call={url:String(url),init,...(init?.body?{body:JSON.parse(String(init.body)) as Record<string,unknown>}:{})};calls.push(call);
  const response=handler?.(call);if(response)return response;
  if(call.url.includes('/accountSummaries'))return Response.json(listing);
  if(call.url==='https://analyticsadmin.googleapis.com/v1beta/properties/100')return Response.json({name:'properties/100',displayName:'Example GA4',timeZone:'America/Los_Angeles'});
  if(call.url==='https://analyticsdata.googleapis.com/v1beta/properties/100:runReport')return Response.json(report(call.body!));
  throw new Error('Unexpected URL');
 }) as typeof fetch;
 return {calls,fetcher,connector:new Ga4Connector({tokenProvider:async()=>grant,fetcher,now})};
}
const input={property:'properties/100'};

describe('GA4 read-only connector',()=>{
 it('lists account properties through all Admin API pages, including empty intermediate pages',async()=>{
  const m=mock(call=>{
   if(!call.url.includes('/accountSummaries'))return;
   const page=new URL(call.url).searchParams.get('pageToken');
   if(!page)return Response.json({nextPageToken:'page two / +?'});
   if(page==='page two / +?')return Response.json({...listing,nextPageToken:'page three'});
   return Response.json({accountSummaries:[{account:'accounts/20',propertySummaries:[{property:'properties/200'}]}]});
  });
  expect(await m.connector.available()).toEqual([{property:'properties/100',displayName:'Example GA4',account:'accounts/10',accountDisplayName:'Example account'},{property:'properties/200',displayName:'properties/200',account:'accounts/20',accountDisplayName:'accounts/20'}]);
  expect(m.calls).toHaveLength(3);
  for(const call of m.calls){expect(new URL(call.url).searchParams.get('pageSize')).toBe('200');expect(call.init?.body).toBeUndefined();expect(call.init?.redirect).toBe('error');}
 });

 it('returns an empty list when this account has no GA4 resources and prevents a fabricated report',async()=>{
  const m=mock(call=>call.url.includes('/accountSummaries')?Response.json({}):undefined);
  expect(await m.connector.available()).toEqual([]);
  await expect(m.connector.overview(input)).rejects.toMatchObject({code:'property_unavailable'});
  expect(m.calls.every(call=>call.url.includes('/accountSummaries'))).toBe(true);
 });

 it('rejects looping property pagination instead of labeling a partial list complete',async()=>{
  const m=mock(()=>Response.json({...listing,nextPageToken:'same'}));
  await expect(m.connector.available()).rejects.toMatchObject({code:'invalid_response'});
  expect(m.calls).toHaveLength(2);
 });

 it.each([[],['openid'],['https://www.googleapis.com/auth/webmasters.readonly'],[GA4_READ_SCOPE,'https://www.googleapis.com/auth/analytics.edit'],[GA4_READ_SCOPE,'https://www.googleapis.com/auth/analytics']].map(scopes=>[scopes]))('requires a verified read-only Analytics grant before sending a request: %j',async scopes=>{
  const m=mock();const connector=new Ga4Connector({tokenProvider:async()=>({...grant,scopes}),fetcher:m.fetcher});
  await expect(connector.overview(input)).rejects.toMatchObject({code:'scope_required'});expect(m.calls).toHaveLength(0);
 });

 it('reads independent totals, daily and session source reports, with dates based on the property time zone',async()=>{
  const m=mock(call=>call.body?Response.json(report(call.body,{values:(call.body.dimensions as unknown[]).length?['20','30','40','1']:undefined})):undefined);
  const result=await m.connector.overview(input);
  expect(result).toMatchObject({property:'properties/100',displayName:'Example GA4',account:'accounts/10',startDate:'2026-09-17',endDate:'2026-10-14',timeZone:'America/Los_Angeles',capturedAt:'2026-10-16T00:30:00.000Z',requestedDateRange:{startDate:'28daysAgo',endDate:'yesterday'},source:'Google Analytics Data API / properties.runReport',access:'read_only',totals:{activeUsers:120,sessions:200,screenPageViews:300,keyEvents:4},daily:[{date:'2026-09-17',activeUsers:20,sessions:30,screenPageViews:40,keyEvents:1}],sources:[{source:'google',medium:'organic',activeUsers:20,sessions:30,screenPageViews:40,keyEvents:1}],truncated:[]});
  expect(result.reports.map(value=>value.kind)).toEqual(['totals','daily','sources']);
  expect(result.limitations.join(' ')).toContain('distinct');
  expect(JSON.stringify(result)).not.toContain(grant.accessToken);
  expect(m.calls).toHaveLength(5);
  for(const call of m.calls){expect(call.init?.headers).toMatchObject({Authorization:'Bearer '+grant.accessToken});if(call.body){expect(call.init?.method).toBe('POST');expect(call.url.endsWith(':runReport')).toBe(true);expect(call.body.metrics).toEqual(ga4Metrics.map(name=>({name})));expect(call.body.dateRanges).toEqual([{startDate:'2026-09-17',endDate:'2026-10-14'}]);}else expect(call.init?.method).toBeUndefined();}
 });

 it('preserves the explicit range, threshold/sampling/truncation metadata and original read responses',async()=>{
  const metadata={timeZone:'America/Los_Angeles',subjectToThresholding:true,dataLossFromOtherRow:true,samplingMetadatas:[{samplesReadCount:'100',samplingSpaceSize:'1000'}],dataTruncationReasons:[{dataTruncationType:'DATA_TRUNCATION_TYPE_UNSPECIFIED'}],emptyReason:'original diagnostic'};
  const m=mock(call=>call.body?Response.json(report(call.body,{metadata})):undefined);
  const result=await m.connector.overview({...input,startDate:'2026-09-01',endDate:'2026-09-28'});
  expect(result.startDate).toBe('2026-09-01');expect(result.endDate).toBe('2026-09-28');
  expect(result.reports.every(receipt=>JSON.stringify(receipt.response.metadata)===JSON.stringify(metadata))).toBe(true);
  const notes=result.limitations.join(' ');expect(notes).toContain('thresholds');expect(notes).toContain('aggregation');expect(notes).toContain('sampling');expect(notes).toContain('truncation');
 });

 it('keeps an empty total distinct from zero metrics and does not synthesize missing days',async()=>{
  const m=mock(call=>call.body?Response.json(report(call.body,{rows:[],rowCount:0})):undefined);
  const result=await m.connector.overview(input);expect(result.totals).toBeNull();expect(result.daily).toEqual([]);expect(result.sources).toEqual([]);expect(result.limitations.join(' ')).toContain('Missing data is not treated as zero');
 });

 it('paginates source rows using their actual count and retains every request/response pair',async()=>{
  const m=mock(call=>{
   if(!call.body||(call.body.dimensions as unknown[]).length!==2)return;
   const offset=Number(call.body.offset),count=offset===0?1000:1;
   return Response.json(report(call.body,{rows:Array.from({length:count},(_,index)=>({dimensionValues:[{value:'source-'+(offset+index)},{value:'referral'}],metricValues:metrics(['1','1','2','0'])})),rowCount:1001}));
  });
  const result=await m.connector.overview(input);expect(result.sources).toHaveLength(1001);expect(result.sources.at(-1)?.source).toBe('source-1000');expect(result.reports.filter(receipt=>receipt.kind==='sources').map(receipt=>receipt.request.offset)).toEqual(['0','1000']);expect(result.truncated).toEqual([]);
 });

 it('marks the bounded source read incomplete at 10,000 rows',async()=>{
  const m=mock(call=>{
   if(!call.body||(call.body.dimensions as unknown[]).length!==2)return;
   const offset=Number(call.body.offset);
   return Response.json(report(call.body,{rows:Array.from({length:1000},(_,index)=>({dimensionValues:[{value:'source-'+(offset+index)},{value:'referral'}],metricValues:metrics(['1','1','2','0'])})),rowCount:10001}));
  });
  const result=await m.connector.overview(input);expect(result.sources).toHaveLength(10000);expect(result.truncated).toEqual(['sources']);expect(result.limitations.join(' ')).toContain('first 10,000 rows');expect(result.reports.filter(receipt=>receipt.kind==='sources')).toHaveLength(10);
 });

 it.each([
  [401,{error:{status:'UNAUTHENTICATED',message:grant.accessToken}},'reconnect_required'],
  [400,{error:'invalid_grant'},'reconnect_required'],
  [403,{error:{status:'PERMISSION_DENIED',message:grant.accessToken}},'access_denied'],
  [403,{error:{details:[{reason:'SERVICE_DISABLED'}]}},'api_disabled'],
  [403,{error:{details:[{reason:'ACCESS_TOKEN_SCOPE_INSUFFICIENT'}]}},'scope_required'],
  [429,{error:{status:'RESOURCE_EXHAUSTED'}},'rate_limited'],
  [404,{error:{status:'NOT_FOUND'}},'property_unavailable'],
  [500,{error:{message:grant.accessToken}},'unavailable'],
 ])('maps failed reads without exposing server diagnostic secrets: HTTP %s',async(status,body,code)=>{
  const m=mock(()=>Response.json(body,{status}));
  try{await m.connector.available();throw new Error('Expected failure');}catch(error){expect(error).toBeInstanceOf(Ga4Error);expect(error).toMatchObject({code,httpStatus:status});expect(String(error)).not.toContain(grant.accessToken);}
  expect(m.calls).toHaveLength(1);
 });

 it('does not return a snapshot when any later report fails',async()=>{
  const m=mock(call=>call.body&&(call.body.dimensions as unknown[]).length===2?Response.json({error:{status:'PERMISSION_DENIED'}},{status:403}):undefined);
  await expect(m.connector.overview(input)).rejects.toMatchObject({code:'access_denied'});
  expect(m.calls.filter(call=>call.body)).toHaveLength(3);
 });

 it('rejects wrong headers, invalid metrics, impossible dates and inconsistent page counts',async()=>{
  const mutations=[
   (body:Record<string,unknown>)=>({...report(body),metricHeaders:[{name:'clicks'}]}),
   (body:Record<string,unknown>)=>report(body,{values:['NaN','1','1','1']}),
   (body:Record<string,unknown>)=>report(body,{rows:[{dimensionValues:[],metricValues:metrics(['-1','1','1','1'])}]}),
   (body:Record<string,unknown>)=>({...report(body),rowCount:0}),
   (body:Record<string,unknown>)=>(body.dimensions as unknown[]).length===1?report(body,{rows:[{dimensionValues:[{value:'20260230'}],metricValues:metrics()}]}):report(body),
   (body:Record<string,unknown>)=>report(body,{metadata:{timeZone:'Asia/Tokyo'}}),
  ];
  for(const mutation of mutations){const m=mock(call=>call.body?Response.json(mutation(call.body)):undefined);await expect(m.connector.overview(input)).rejects.toMatchObject({code:'invalid_response'});}
 });

 it('rejects unsafe property IDs and invalid or incomplete date ranges before authorization',async()=>{
  const m=mock();
  for(const data of [{property:'https://example.com/'},{property:'properties/100:delete'}, {...input,startDate:'2026-02-30',endDate:'2026-03-01'}, {...input,startDate:'2026-09-20'}, {...input,startDate:'2026-09-20',endDate:'2026-09-01'}, {...input,startDate:'2024-01-01',endDate:'2026-09-01'}]){expect(ga4Input.safeParse(data).success).toBe(false);await expect(m.connector.overview(data)).rejects.toThrow();}
  expect(m.calls).toHaveLength(0);
 });

 it('rejects today and future dates using the property time zone before runReport',async()=>{
  const m=mock();await expect(m.connector.overview({...input,startDate:'2026-10-14',endDate:'2026-10-15'})).rejects.toThrow('before today');expect(m.calls.filter(call=>call.body)).toHaveLength(0);
 });

 it('stops aborted reads and never includes tokens in provider/network errors',async()=>{
  const controller=new AbortController();controller.abort();const m=mock();await expect(m.connector.available(controller.signal)).rejects.toMatchObject({code:'aborted'});expect(m.calls).toHaveLength(0);
  await expect(new Ga4Connector({tokenProvider:async()=>{throw new Error(grant.accessToken);},fetcher:m.fetcher}).available()).rejects.toMatchObject({code:'reconnect_required',message:'Reconnect Google to restore GA4 access.'});
  await expect(new Ga4Connector({tokenProvider:async()=>grant,fetcher:(async()=>{throw new Error(grant.accessToken);}) as typeof fetch}).available()).rejects.toMatchObject({code:'unavailable'});
 });
});
