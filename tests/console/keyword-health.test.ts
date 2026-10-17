import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {GscWorkspace} from '../../src/console/gsc-workspace.ts';
import {analyzeKeywordHealth} from '../../src/console/keyword-health.ts';
import type {GscEvidence,GscRow} from '../../src/console/gsc.ts';

const DAY=86_400_000,property='sc-domain:sample-agency.example',ownerUrl='https://sample-agency.example/guide';
const date=(start:string,days:number)=>new Date(Date.parse(start)+days*DAY).toISOString().slice(0,10);
const metric=(keys:string[],position=35,impressions=5,clicks=0):GscRow=>({keys,position,impressions,clicks,ctr:impressions?clicks/impressions:0});
function fixture(days=120):GscEvidence{return {hash:'frozen-test-hash',snapshot:{id:randomUUID(),property,capturedAt:'2026-10-03T12:00:00Z',startDate:date('2026-09-30',1-days),endDate:'2026-09-30',country:'CAN',device:'MOBILE',type:'web',timeZone:'America/Los_Angeles',dataState:'final',source:'Synthetic GSC query snapshot',totals:null,queries:[],pages:[],queryDaily:[],queryPages:[],raw:[],requests:[],limitations:[]}};}
function add(evidence:GscEvidence,keyword='restaurant scheduling',options:{position?:(day:number)=>number;clicks?:(day:number)=>number;skip?:(day:number)=>boolean;owner?:string}={}){
 const s=evidence.snapshot,days=(Date.parse(s.endDate)-Date.parse(s.startDate))/DAY+1;
 for(let day=0;day<days;day++)if(!options.skip?.(day))s.queryDaily!.push(metric([date(s.startDate,day),keyword],options.position?.(day)??35,5,options.clicks?.(day)??0));
 s.queries.push(metric([keyword],99,days*5));
 s.queryPages!.push(metric([keyword,options.owner??ownerUrl],35,days*5));
 return evidence;
}
function analyze(evidence=add(fixture())){return analyzeKeywordHealth(evidence);}
describe('keyword health classification from one frozen query snapshot',()=>{
 it('uses first28, preceding28 and current28 independent windows without summing gaps',()=>{
  const report=analyze();
  expect(report.windows).toEqual({baseline:{startDate:'2026-06-03',endDate:'2026-06-30'},previous:{startDate:'2026-08-06',endDate:'2026-09-02'},current:{startDate:'2026-09-03',endDate:'2026-09-30'}});
  expect(report.rows[0]?.current).toMatchObject({position:35,impressions:140,returnedDays:28,supported:true});
  expect(report.rows[0]?.baseline.impressions).toBe(140);
  expect(report.rows[0]?.state).toBe('stagnant');
  expect(report.rows[0]?.reasonCodes).toEqual(['stagnant_observed']);
  expect(report.rows[0]?.age).toMatchObject({basis:'observed',days:120,publishedAt:null});
  expect(report.summary.stagnant).toBe(1);
 });
 it('retains original data, query text, scope, hash and explicit full-period URL attribution',()=>{
  const e=add(fixture(),'C++ tips 10%'),before=JSON.stringify(e),r=analyze(e);
  expect(JSON.stringify(e)).toBe(before);
  expect(r.evidence).toMatchObject({snapshotId:e.snapshot.id,hash:e.hash,property,country:'CAN',device:'MOBILE',type:'web'});
  expect(r.rows[0]).toMatchObject({keyword:'C++ tips 10%',ownerUrl});
  expect(r.rows[0]?.flags).toEqual(expect.arrayContaining(['query_level_trajectory','owner_mapping_full_period','publication_unknown']));
  expect(JSON.parse(JSON.stringify(r))).toEqual(r);
 });
 it('uses inclusive current28day opportunity positions, not the whole-period aggregate',()=>{
  const e=fixture();add(e,'eleven',{position:()=>11});add(e,'twenty',{position:()=>20});add(e,'outside',{position:()=>20.01});
  const r=analyze(e);
  expect(r.rows.filter(row=>row.state==='opportunity').map(row=>row.keyword).sort()).toEqual(['eleven','twenty']);
  expect(r.summary.opportunity).toBe(2);
 });
 it('keeps 65→35 gains out of stagnation even with no gain since the previous window',()=>{
  const r=analyze(add(fixture(),'improving',{position:day=>day<28?65:35})).rows[0]!;
  expect(r.state).toBe('improving');expect(r.changes.vsBaseline.positionGain).toBe(30);expect(r.changes.vsPrevious.positionGain).toBe(0);
 });
 it('recognizes meaningful click gains with the absolute and relative floor',()=>{
  const e=add(fixture(),'more clicks',{clicks:day=>day>=92?1:0}),r=analyze(e).rows[0]!;
  expect(r.state).toBe('improving');expect(r.changes.vsBaseline).toMatchObject({clickGain:28,clickThreshold:3,meaningfulGrowth:true});
  const flat=add(fixture(),'small click gain',{clicks:day=>day<28&&day<10?1:day>=92&&day<104?1:0});
  expect(analyze(flat).rows[0]?.state).toBe('improving'); // Previous zero clicks is a separate supported comparator.
 });
 it('compares current to previous decline while preserving an overlapping opportunity flag',()=>{
  const r=analyze(add(fixture(),'dropped',{position:day=>day>=92?15:8})).rows[0]!;
  expect(r.state).toBe('declining');expect(r.flags).toContain('opportunity');expect(r.reasonCodes).toEqual(['ranking_decline','opportunity_band']);
 });
 it('requires30impressions and7returned query days in each stagnation window',()=>{
  const sparse=add(fixture(),'sparse',{skip:day=>day>=92&&day<114});
  const r=analyze(sparse).rows[0]!;
  expect(r.current.returnedDays).toBe(6);expect(r.state).toBe('insufficient_data');expect(r.current.supported).toBe(false);
  const enough=add(fixture(),'enough',{skip:day=>day>=92&&day<113});
  expect(analyze(enough).rows[0]?.state).toBe('stagnant');
 });
 it('does not impute missing queries or missing dates as zero traffic or a rank drop',()=>{
  const e=add(fixture(),'not returned',{skip:day=>day>=92}),r=analyze(e).rows[0]!;
  expect(r.current).toMatchObject({position:null,clicks:null,impressions:null,returnedDays:0,supported:false});
  expect(r.state).toBe('insufficient_data');expect(r.changes.vsPrevious.positionGain).toBeNull();
 });
 it('uses returned impressions for weighted rank rather than a simple mean',()=>{
  const e=fixture(),s=e.snapshot;s.queries=[metric(['weighted'],10,100)];s.queryDaily=[metric(['2026-09-03','weighted'],10,90),metric(['2026-09-04','weighted'],50,10)];
  const r=analyze(e).rows[0]!;expect(r.current.position).toBe(14);expect(r.state).toBe('opportunity');expect(r.current.supported).toBe(false);
 });
 it('labels a28day view as early, and cannot turn it into a90day stagnation verdict',()=>{
  const e=add(fixture(28)),r=analyze(e).rows[0]!;
  expect(r.state).toBe('early');expect(r.age.days).toBe(28);expect(r.flags).toContain('short_history');expect(r.baseline.supported).toBe(false);
  const old=analyzeKeywordHealth(e,[{url:ownerUrl,publishedAt:'2025-01-01',source:'manual'}]).rows[0]!;
  expect(old.state).toBe('insufficient_data');expect(old.reasonCodes).toEqual(['insufficient_history']);
 });
 it('accepts exactly90observed days, and distinguishes a declared90elapsed-day publication age',()=>{
  const e=add(fixture(90)),observed=analyze(e).rows[0]!;
  expect(observed.state).toBe('stagnant');expect(observed.age.days).toBe(90);expect(observed.reasonCodes).toContain('stagnant_observed');
  const published=analyzeKeywordHealth(e,[{url:ownerUrl,publishedAt:'2026-07-02',source:'manual'}]).rows[0]!;
  expect(published.reasonCodes).toEqual(['stagnant_published']);expect(published.age).toMatchObject({basis:'published',days:90,publishedAt:'2026-07-02'});
 });
 it('does not age historical evidence using the current clock, or equate publication with query ownership',()=>{
  const e=add(fixture(120)),r=analyzeKeywordHealth(e,[{url:ownerUrl,publishedAt:'2026-09-20',source:'manual'}]).rows[0]!;
  expect(r.state).toBe('stagnant');expect(r.reasonCodes).toEqual(['stagnant_observed']);expect(r.age.basis).toBe('observed');
  expect(r.publication?.publishedAt).toBe('2026-09-20');
  const future=analyzeKeywordHealth(e,[{url:ownerUrl,publishedAt:'2026-10-01',source:'manual'}]).rows[0]!;
  expect(future.publication).toBeNull();expect(future.age.publishedAt).toBeNull();expect(future.flags).toContain('publication_not_applicable');
 });
 it('never confirms stagnation when daily history is truncated, invalid or duplicated',()=>{
  const truncated=add(fixture());truncated.snapshot.truncated=['queryDaily'];
  const invalid=add(fixture());invalid.snapshot.queryDaily!.push(metric(['2026-06-31','restaurant scheduling']));
  const duplicate=add(fixture());duplicate.snapshot.queryDaily!.push({...duplicate.snapshot.queryDaily![0]!});
  for(const e of [truncated,invalid,duplicate]){const r=analyze(e).rows[0]!;expect(r.state).toBe('insufficient_data');expect(r.current.supported).toBe(false);}
 });
 it('does not promote unreliable daily rank15 into an opportunity',()=>{
  const truncated=add(fixture(),'candidate',{position:()=>15});truncated.snapshot.truncated=['queryDaily'];
  const duplicate=add(fixture(),'candidate',{position:()=>15});duplicate.snapshot.queryDaily!.push({...duplicate.snapshot.queryDaily!.at(-1)!});
  for(const e of [truncated,duplicate]){const r=analyze(e).rows[0]!;expect(r.state).toBe('insufficient_data');expect(r.flags).not.toContain('opportunity');}
 });
 it('recognizes a newly observed query even inside a120day selected period',()=>{
  const e=add(fixture(),'new query',{skip:day=>day<110}),r=analyze(e).rows[0]!;
  expect(r.current.supported).toBe(true);expect(r.state).toBe('early');expect(r.age).toMatchObject({basis:'observed',days:10});
 });
 it('applies exactrank3 and max3or20percent click thresholds without rounding',()=>{
  const growth=add(fixture(),'three ranks',{position:day=>day>=92?32:35});
  expect(analyze(growth).rows[0]?.state).toBe('improving');
  const below=add(fixture(),'not three ranks',{position:day=>day>=92?32.01:35});
  expect(analyze(below).rows[0]?.state).toBe('stagnant');
  const smallClicks=add(fixture(),'below relative floor',{clicks:day=>day>=92&&day<95?2:1});
  expect(analyze(smallClicks).rows[0]?.changes.vsBaseline).toMatchObject({clickGain:3,meaningfulGrowth:false});
  expect(analyze(smallClicks).rows[0]?.state).toBe('stagnant');
  const enoughClicks=add(fixture(),'above relative floor',{clicks:day=>day>=92&&day<98?2:1});
  expect(analyze(enoughClicks).rows[0]?.state).toBe('improving');
 });
 it('blocks trend decisions for future, same-day, unfinished or non-web source periods',()=>{
  for(const override of [{capturedAt:'2026-09-30T12:00:00Z'},{capturedAt:'2026-09-29T12:00:00Z'},{dataState:'all'},{type:'image'}]){
   const e=add(fixture());Object.assign(e.snapshot,override);const r=analyze(e).rows[0]!;
   expect(r.state).toBe('insufficient_data');expect(r.reasonCodes).toEqual(['invalid_period']);
  }
 });
 it('marks whole-period rank fallbacks without synthesizing daily support',()=>{
  const e=fixture();delete e.snapshot.queryDaily;e.snapshot.queries=[metric(['fallback'],15,50)];
  const r=analyze(e).rows[0]!;expect(r.state).toBe('opportunity');expect(r.flags).toContain('aggregate_fallback');expect(r.current).toMatchObject({startDate:e.snapshot.startDate,endDate:e.snapshot.endDate,position:15,supported:false,returnedDays:0});expect(r.age.basis).toBe('unknown');
 });
 it('keeps multiple same-domain owner pages and does not attribute a foreign page or publication',()=>{
  const e=add(fixture());e.snapshot.queryPages!.push(metric(['restaurant scheduling','https://sample-agency.example/other'],35,100),metric(['restaurant scheduling','https://foreign.example/'],1,10000));e.snapshot.truncated=['queryPages'];
  const r=analyzeKeywordHealth(e,[{url:'https://foreign.example/',publishedAt:'2020-01-01',source:'manual'}]).rows[0]!;
  expect(r.ownerUrl).toBe(ownerUrl);expect(r.ownerAlternatives).toEqual(['https://sample-agency.example/other']);expect(r.publication).toBeNull();expect(r.flags).toEqual(expect.arrayContaining(['multiple_owners','truncated_owner_mapping']));expect(r.suggestionCodes).toContain('review_url_overlap');
 });
 it('keeps URL-prefix ownership inside the exact host and path for owners and publication metadata',()=>{
  const e=fixture();e.snapshot.property='https://customer.example.com/research/';
  const owned='https://customer.example.com/research/guide';
  add(e,'customer opportunity',{owner:owned});
  for(const outside of ['https://customer.example.com/other/guide','https://customer.example.com/researchish/guide','https://sub.customer.example.com/research/guide','https://customer.example.com/research/%2e%2e/private'])e.snapshot.queryPages!.push(metric(['customer opportunity',outside],1,10000));
  const report=analyzeKeywordHealth(e,[{url:'https://customer.example.com/other/guide',publishedAt:'2020-01-01',source:'manual'},{url:owned,publishedAt:'2026-01-01',source:'manual'}]);
  expect(report.rows[0]?.ownerUrl).toBe(owned);expect(report.rows[0]?.ownerAlternatives).toEqual([]);
  expect(report.rows[0]?.publication?.url).toBe(owned);expect(report.rows[0]?.flags).not.toContain('multiple_owners');
  const outsideOnly=fixture();outsideOnly.snapshot.property=e.snapshot.property;add(outsideOnly,'outside only',{owner:'https://customer.example.com/other/guide'});
  expect(analyze(outsideOnly).rows[0]?.ownerUrl).toBeNull();expect(analyze(outsideOnly).rows[0]?.publication).toBeNull();
 });
 it('excludes zero/invalid rank rows from rank evidence and leaves unknown metrics null',()=>{
  const e=fixture();e.snapshot.queries=[metric(['zero'],0,0)];e.snapshot.queryDaily=[metric(['2026-06-03','zero'],0,0)];
  const r=analyze(e).rows[0]!;expect(r.current.position).toBeNull();expect(r.age.firstObservedAt).toBeNull();expect(r.state).toBe('insufficient_data');
 });
 it('indexes owner rows once rather than scanning every owner for every query',()=>{
  const e=fixture();delete e.snapshot.queryDaily;let keyReads=0;
  for(let n=0;n<1000;n++){
   const keyword='query '+n;e.snapshot.queries.push(metric([keyword],15,50));
   const row=metric([],15,50);Object.defineProperty(row,'keys',{get(){keyReads++;return [keyword,'https://sample-agency.example/page-'+n];}});e.snapshot.queryPages!.push(row);
  }
  expect(analyze(e).rows).toHaveLength(1000);expect(keyReads).toBeLessThan(20_000);
 });
});

const labs:{lab:LabService;dir:string}[]=[];
function workspace(){const dir=mkdtempSync(join(tmpdir(),'getgeo-publication-')),lab=new LabService(connectLedger(join(dir,'ledger.db')));labs.push({lab,dir});return new GscWorkspace(lab);}
afterEach(()=>{for(const {lab,dir} of labs.splice(0)){lab.db.close();rmSync(dir,{recursive:true,force:true});}});
describe('optional property-scoped publication metadata',()=>{
 it('upserts one publication URL, remembers the latest declaration and preserves unrelated items',()=>{
  const w=workspace(),note=w.save(randomUUID(),{property,kind:'note',payload:{title:'Keep this',date:'2026-01-01',body:'Original note'}});
  const saved=w.save(randomUUID(),{property,kind:'publication',payload:{url:ownerUrl,publishedAt:'2026-01-01',source:'manual'}});
  const requestId=randomUUID(),updated=w.save(requestId,{property,kind:'publication',payload:{url:ownerUrl,publishedAt:'2026-02-01',source:'manual',sourceUrl:'https://sample-agency.example/changes'}});
  expect(updated.id).toBe(saved.id);expect(w.save(requestId,{property,kind:'publication',payload:{url:ownerUrl,publishedAt:'2026-02-01',source:'manual',sourceUrl:'https://sample-agency.example/changes'}})).toEqual(updated);
  expect(w.publications(property)).toEqual([{url:ownerUrl,publishedAt:'2026-02-01',source:'manual',sourceUrl:'https://sample-agency.example/changes'}]);expect(w.list(property).find(item=>item.id===note.id)?.payload.title).toBe('Keep this');
  w.remove(randomUUID(),{property,id:saved.id});expect(w.publications(property)).toEqual([]);expect(w.list(property)).toHaveLength(1);
 });
 it('rejects foreign, suffix-spoofed, insecure, credential-bearing and fragment URLs',()=>{
  const w=workspace();for(const url of ['https://sample-studio.example/a','https://sample-agency.example.evil.example/a','http://sample-agency.example/a','https://u:p@sample-agency.example/a','https://sample-agency.example/a#part'])expect(()=>w.save(randomUUID(),{property,kind:'publication',payload:{url,publishedAt:'2026-01-01',source:'manual'}})).toThrow();
  expect(w.publications(property)).toHaveLength(0);
 });
 it('validates genuine dates, source shape, unsupported automatic sources and future input',()=>{
  const w=workspace();for(const payload of [{url:ownerUrl,publishedAt:'2099-01-01',source:'manual'},{url:ownerUrl,publishedAt:'2026-02-30',source:'manual'},{url:ownerUrl,publishedAt:'2026-01-01',source:'sitemap'},{url:ownerUrl,publishedAt:'2026-01-01',source:'manual',sourceUrl:'javascript:alert(1)'},{url:ownerUrl,publishedAt:'2026-01-01',source:'manual',extra:'no'}])expect(()=>w.save(randomUUID(),{property,kind:'publication',payload})).toThrow();
 });
 it('cannot edit another property or silently merge two explicit publication IDs',()=>{
  const w=workspace(),a=w.save(randomUUID(),{property,kind:'publication',payload:{url:ownerUrl,publishedAt:'2026-01-01',source:'manual'}}),b=w.save(randomUUID(),{property,kind:'publication',payload:{url:'https://sample-agency.example/other',publishedAt:'2026-01-01',source:'manual'}});
  expect(()=>w.save(randomUUID(),{id:a.id,property:'sc-domain:sample-studio.example',kind:'publication',payload:{url:'https://sample-studio.example/a',publishedAt:'2026-01-01',source:'manual'}})).toThrow();
  expect(()=>w.save(randomUUID(),{id:b.id,property,kind:'publication',payload:{url:ownerUrl,publishedAt:'2026-01-02',source:'manual'}})).toThrow('already saved');
  expect(w.publications(property)).toHaveLength(2);expect(w.publications('sc-domain:sample-studio.example')).toHaveLength(0);
 });
});
