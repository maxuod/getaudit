import type {GscEvidence,GscRow} from './gsc.ts';
import {belongsToGscProperty} from './gsc-contracts.ts';

export type PublicationRecord={url:string;publishedAt:string;source:'manual';sourceUrl?:string};
export type KeywordHealthState='opportunity'|'stagnant'|'declining'|'improving'|'early'|'stable'|'insufficient_data';
export type KeywordHealthReason='opportunity_band'|'ranking_decline'|'meaningful_growth'|'stagnant_published'|'stagnant_observed'|'still_early'|'no_classified_change'|'insufficient_current'|'insufficient_history'|'insufficient_windows'|'invalid_period'|'truncated_history';
export type KeywordHealthSuggestion='compare_top_pages'|'review_content'|'inspect_decline'|'keep_monitoring'|'read_history'|'add_publication_date'|'review_url_overlap';
export type KeywordHealthFlag='opportunity'|'aggregate_fallback'|'low_data'|'short_history'|'truncated_query_daily'|'truncated_queries'|'truncated_owner_mapping'|'missing_owner'|'multiple_owners'|'invalid_daily_rows'|'invalid_period'|'publication_unknown'|'publication_not_applicable'|'query_level_trajectory'|'owner_mapping_full_period'|'non_web_search';
export type HealthWindow={startDate:string;endDate:string};
export type HealthWindowMetrics=HealthWindow&{position:number|null;impressions:number|null;clicks:number|null;ctr:number|null;returnedDays:number;supported:boolean};
export type HealthChange={positionGain:number|null;clickGain:number|null;clickThreshold:number|null;meaningfulGrowth:boolean};
export type KeywordHealthRow={
 keyword:string;state:KeywordHealthState;current:HealthWindowMetrics;previous:HealthWindowMetrics;baseline:HealthWindowMetrics;
 changes:{vsBaseline:HealthChange;vsPrevious:HealthChange};
 ownerUrl:string|null;ownerAlternatives:string[];publication:PublicationRecord|null;
 age:{basis:'published'|'observed'|'unknown';days:number|null;firstObservedAt:string|null;publishedAt:string|null};
 flags:KeywordHealthFlag[];reasonCodes:KeywordHealthReason[];suggestionCodes:KeywordHealthSuggestion[];
};
export type KeywordHealthReport={
 evidence:{snapshotId:string;hash:string;source:string;property:string;country:string;device:string;type:string;startDate:string;endDate:string;capturedAt:string;timeZone:string;queryFilter:string|null;pageFilter:string|null};
 rules:{windowDays:28;minimumAgeDays:90;minimumImpressions:30;minimumReturnedDays:7;meaningfulRankGain:3;meaningfulClickGain:3;meaningfulClickGrowth:0.2;decliningRankLoss:5;opportunityMin:11;opportunityMax:20;stagnantMin:21;stagnantMax:50};
 windows:{baseline:HealthWindow;previous:HealthWindow;current:HealthWindow};
 rows:KeywordHealthRow[];summary:Record<KeywordHealthState,number>;limitations:string[];
};

const DAY=86_400_000;
const rules:KeywordHealthReport['rules']={windowDays:28,minimumAgeDays:90,minimumImpressions:30,minimumReturnedDays:7,meaningfulRankGain:3,meaningfulClickGain:3,meaningfulClickGrowth:0.2,decliningRankLoss:5,opportunityMin:11,opportunityMax:20,stagnantMin:21,stagnantMax:50};
const states:KeywordHealthState[]=['opportunity','stagnant','declining','improving','early','stable','insufficient_data'];
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const offset=(date:string,days:number)=>new Date(Date.parse(date)+days*DAY).toISOString().slice(0,10);
const elapsed=(start:string,end:string)=>Math.floor((Date.parse(end)-Date.parse(start))/DAY);
const validMetric=(row:GscRow)=>[row.position,row.impressions,row.clicks,row.ctr].every(Number.isFinite)&&row.position>0&&row.impressions>0&&row.clicks>=0&&row.ctr>=0&&row.ctr<=1;
const queryOf=(row:GscRow,index:number,dimensions:number)=>row.keys?.length===dimensions&&typeof row.keys[index]==='string'&&row.keys[index]!.trim()?row.keys[index]!:null;

/** URL ownership is an exact property boundary; URL paths and query strings are not merged. */
function ownedUrl(value:string,property:string):string|null{
 try{
  const url=new URL(value);
  if(!belongsToGscProperty(property,value))return null;
  return url.toString();
 }catch{return null;}
}

function windowMetrics(window:HealthWindow,rows:GscRow[],supported=true):HealthWindowMetrics{
 const selected=rows.filter(row=>row.keys?.[0]&&row.keys[0]>=window.startDate&&row.keys[0]<=window.endDate&&validMetric(row));
 const returnedDays=new Set(selected.map(row=>row.keys![0]!)).size;
 if(!selected.length)return {...window,position:null,impressions:null,clicks:null,ctr:null,returnedDays:0,supported:false};
 const impressions=selected.reduce((sum,row)=>sum+row.impressions,0),clicks=selected.reduce((sum,row)=>sum+row.clicks,0);
 return {...window,impressions,clicks,position:selected.reduce((sum,row)=>sum+row.position*row.impressions,0)/impressions,ctr:clicks/impressions,returnedDays,supported:supported&&impressions>=rules.minimumImpressions&&returnedDays>=rules.minimumReturnedDays};
}

function change(current:HealthWindowMetrics,previous:HealthWindowMetrics):HealthChange{
 const valid=current.supported&&previous.supported;
 const positionGain=current.position!==null&&previous.position!==null?previous.position-current.position:null;
 const clickGain=current.clicks!==null&&previous.clicks!==null?current.clicks-previous.clicks:null;
 const clickThreshold=previous.clicks===null?null:Math.max(rules.meaningfulClickGain,previous.clicks*rules.meaningfulClickGrowth);
 return {positionGain,clickGain,clickThreshold,meaningfulGrowth:valid&&((positionGain!==null&&positionGain>=rules.meaningfulRankGain)||(clickGain!==null&&clickThreshold!==null&&clickGain>=clickThreshold))};
}

/**
 * A deterministic triage of one frozen GSC snapshot. It never combines snapshots,
 * fetches pages, invents missing days or attributes a query trajectory to a page.
 */
export function analyzeKeywordHealth(evidence:GscEvidence,publications:PublicationRecord[]=[]):KeywordHealthReport{
 const s=evidence.snapshot;
 const datesValid=validDate(s.startDate)&&validDate(s.endDate)&&s.startDate<=s.endDate;
 const captured=Date.parse(s.capturedAt);
 let capturedDay='';
 if(Number.isFinite(captured)){
  try{capturedDay=new Intl.DateTimeFormat('en-CA',{timeZone:s.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(captured));}catch{/* Invalid source timezone makes the period unsupported. */}
 }
 const periodValid=datesValid&&validDate(capturedDay)&&s.endDate<capturedDay&&s.dataState==='final';
 const span=datesValid?elapsed(s.startDate,s.endDate)+1:0;
 // Malformed evidence remains inspectable with an unsupported deterministic range.
 const end=datesValid?s.endDate:'1970-01-01';
 const windows:KeywordHealthReport['windows']={
  baseline:span>=90?{startDate:s.startDate,endDate:offset(s.startDate,27)}:{startDate:offset(end,-83),endDate:offset(end,-56)},
  previous:{startDate:offset(end,-55),endDate:offset(end,-28)},
  current:{startDate:offset(end,-27),endDate:end},
 };
 const hasDaily=Array.isArray(s.queryDaily);
 const truncatedDaily=s.truncated?.includes('queryDaily')??false;
 const truncatedQueries=s.truncated?.includes('queries')??false;
 const truncatedOwners=s.truncated?.includes('queryPages')??false;
 const byQuery=new Map<string,GscRow[]>(),aggregate=new Map<string,GscRow>(),invalidQueries=new Set<string>();
 for(const row of s.queries){const q=queryOf(row,0,1);if(q&&!aggregate.has(q))aggregate.set(q,row);}
 const seenDays=new Map<string,Set<string>>();
 for(const row of s.queryDaily??[]){
  const q=queryOf(row,1,2);if(!q)continue;
  const day=row.keys![0]!;
  if(!validDate(day)||!datesValid||day<s.startDate||day>s.endDate){invalidQueries.add(q);continue;}
  if(![row.position,row.impressions,row.clicks,row.ctr].every(Number.isFinite)||row.impressions<0||row.clicks<0||row.position<0||row.ctr<0||row.ctr>1){invalidQueries.add(q);continue;}
  // Returned zero-impression rows supply no rank or observed-day evidence.
  if(!validMetric(row))continue;
  const dates=seenDays.get(q)??new Set<string>();
  if(dates.has(day)){invalidQueries.add(q);continue;}
  dates.add(day);seenDays.set(q,dates);
  const rows=byQuery.get(q)??[];rows.push(row);byQuery.set(q,rows);
 }
 const ownersByQuery=new Map<string,GscRow[]>();
 for(const row of s.queryPages??[]){
  const keyword=queryOf(row,0,2);
  if(!keyword||!validMetric(row)||!ownedUrl(row.keys![1]!,s.property))continue;
  const owners=ownersByQuery.get(keyword)??[];owners.push(row);ownersByQuery.set(keyword,owners);
 }
 const publicationsByUrl=new Map<string,PublicationRecord>(),declaredUrls=new Set<string>();
 for(const record of publications){
  const url=ownedUrl(record.url,s.property);if(!url)continue;declaredUrls.add(url);
  if(record.source==='manual'&&validDate(record.publishedAt)&&record.publishedAt<=end)publicationsByUrl.set(url,record);
 }
 const rows:KeywordHealthRow[]=[];
 for(const keyword of new Set([...aggregate.keys(),...byQuery.keys(),...invalidQueries])){
  const daily=byQuery.get(keyword)??[];
  const trendReliable=periodValid&&s.type==='web'&&!truncatedDaily&&!invalidQueries.has(keyword);
  const contained=(window:HealthWindow)=>datesValid&&window.startDate>=s.startDate&&window.endDate<=s.endDate;
  const current=windowMetrics(windows.current,daily,trendReliable&&contained(windows.current));
  const previous=windowMetrics(windows.previous,daily,trendReliable&&contained(windows.previous));
  const baseline=windowMetrics(windows.baseline,daily,trendReliable&&contained(windows.baseline));
  const flags:KeywordHealthFlag[]=['query_level_trajectory','owner_mapping_full_period'];
  if(!hasDaily){
   const row=aggregate.get(keyword);
   Object.assign(current,{startDate:s.startDate,endDate:s.endDate,...(row&&validMetric(row)?{position:row.position,impressions:row.impressions,clicks:row.clicks,ctr:row.ctr}:{}),supported:false});
   flags.push('aggregate_fallback');
  }
  if(!current.supported)flags.push('low_data');
  if(span<rules.minimumAgeDays)flags.push('short_history');
  if(!periodValid)flags.push('invalid_period');
  if(s.type!=='web')flags.push('non_web_search');
  if(truncatedDaily)flags.push('truncated_query_daily');
  if(truncatedQueries)flags.push('truncated_queries');
  if(truncatedOwners)flags.push('truncated_owner_mapping');
  if(invalidQueries.has(keyword))flags.push('invalid_daily_rows');
  const ownerRows=(ownersByQuery.get(keyword)??[]).sort((a,b)=>b.impressions-a.impressions||b.clicks-a.clicks||a.keys![1]!.localeCompare(b.keys![1]!,'en'));
  const owners=[...new Set(ownerRows.map(row=>ownedUrl(row.keys![1]!,s.property)!))];
  const ownerUrl=owners[0]??null;
  if(!ownerUrl)flags.push('missing_owner');
  if(owners.length>1)flags.push('multiple_owners');
  // Metadata is supplied independently of immutable GSC evidence and never changes a rank.
  const publication=ownerUrl?publicationsByUrl.get(ownerUrl)??null:null;
  const firstObservedAt=daily.map(row=>row.keys![0]!).sort()[0]??null;
  const observedDays=firstObservedAt?elapsed(firstObservedAt,end)+1:null;
  const publishedDays=publication?elapsed(publication.publishedAt,end):null;
  const age:KeywordHealthRow['age']=publication&&((publishedDays??0)>=90||(observedDays??0)<90)?{basis:'published',days:publishedDays,firstObservedAt,publishedAt:publication.publishedAt}:{basis:firstObservedAt?'observed':'unknown',days:observedDays,firstObservedAt,publishedAt:publication?.publishedAt??null};
  if(!publication)flags.push('publication_unknown');
  if(ownerUrl&&declaredUrls.has(ownerUrl)&&!publication)flags.push('publication_not_applicable');
  const mature=publishedDays!==null&&publishedDays>=90||observedDays!==null&&observedDays>=90;
  const comparisons={vsBaseline:change(current,baseline),vsPrevious:change(current,previous)};
  const opportunity=periodValid&&s.type==='web'&&(!hasDaily||trendReliable)&&current.position!==null&&current.impressions!==null&&current.impressions>0&&current.position>=11&&current.position<=20;
  if(opportunity)flags.push('opportunity');
  const decline=current.supported&&previous.supported&&comparisons.vsPrevious.positionGain!==null&&comparisons.vsPrevious.positionGain<=-rules.decliningRankLoss;
  const growth=comparisons.vsBaseline.meaningfulGrowth||comparisons.vsPrevious.meaningfulGrowth;
  const stalled=span>=90&&mature&&current.supported&&previous.supported&&baseline.supported&&current.position!==null&&current.position>=21&&current.position<=50&&!growth;
  let state:KeywordHealthState,reasonCodes:KeywordHealthReason[];
  if(!periodValid||s.type!=='web'){state='insufficient_data';reasonCodes=['invalid_period'];}
  else if(decline){state='declining';reasonCodes=['ranking_decline'];}
  else if(opportunity){state='opportunity';reasonCodes=['opportunity_band'];}
  else if(growth){state='improving';reasonCodes=['meaningful_growth'];}
  else if(stalled){state='stagnant';reasonCodes=[publishedDays!==null&&publishedDays>=90?'stagnant_published':'stagnant_observed'];}
  else if(!current.supported){state='insufficient_data';reasonCodes=[truncatedDaily?'truncated_history':'insufficient_current'];}
  else if(age.days!==null&&age.days<90){state='early';reasonCodes=['still_early'];}
  else if(span<90){state='insufficient_data';reasonCodes=['insufficient_history'];}
  else if(!previous.supported||!baseline.supported){state='insufficient_data';reasonCodes=['insufficient_windows'];}
  else{state='stable';reasonCodes=['no_classified_change'];}
  if(opportunity&&state!=='opportunity')reasonCodes.push('opportunity_band');
  const suggestionCodes:KeywordHealthSuggestion[]=state==='opportunity'?['compare_top_pages']:state==='stagnant'?['review_content']:state==='declining'?['inspect_decline']:state==='insufficient_data'?['read_history']:['keep_monitoring'];
  if(!publication)suggestionCodes.push('add_publication_date');
  if(owners.length>1)suggestionCodes.push('review_url_overlap');
  rows.push({keyword,state,current,previous,baseline,changes:comparisons,ownerUrl,ownerAlternatives:owners.slice(1),publication,age,flags,reasonCodes,suggestionCodes});
 }
 const priority:Record<KeywordHealthState,number>={stagnant:0,declining:1,opportunity:2,improving:3,early:4,stable:5,insufficient_data:6};
 rows.sort((a,b)=>priority[a.state]-priority[b.state]||(b.current.impressions??-1)-(a.current.impressions??-1)||a.keyword.localeCompare(b.keyword,'en'));
 const summary=Object.fromEntries(states.map(state=>[state,0])) as KeywordHealthReport['summary'];
 for(const row of rows)summary[row.state]++;
 return {evidence:{snapshotId:s.id,hash:evidence.hash,source:s.source,property:s.property,country:s.country,device:s.device??'ALL',type:s.type,startDate:s.startDate,endDate:s.endDate,capturedAt:s.capturedAt,timeZone:s.timeZone,queryFilter:s.query??null,pageFilter:s.page??null},rules:{...rules},windows,rows,summary,limitations:[
  'Classification uses transparent triage thresholds, not statistical significance or a guarantee that editing will improve rankings.',
  'Positions are impression-weighted GSC query averages, not current organic SERP ranks. Missing query rows and dates remain unknown.',
  'All trajectories are query-level within this one frozen snapshot. The associated URL comes from query × page rows for the full selected period; its publication date does not prove that page owned the query throughout the trajectory.',
  'Observed age is a lower bound from the earliest returned query date within this snapshot. Publication dates are optional user-supplied evidence, not independently verified publication or indexation dates.',
  'The baseline is the first 28 days when at least 90 days are selected. The previous and current windows are the final two non-overlapping 28-day periods; gaps are not counted twice.',
  'GSC can omit anonymous and less frequent queries even below the row limit. Multiple associated URLs are a review signal, not confirmed keyword cannibalization.',
 ]};
}
