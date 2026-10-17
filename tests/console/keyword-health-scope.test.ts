import {describe,expect,it} from 'vitest';
import type {GscEvidence} from '../../src/console/gsc.ts';
import {keywordHealthReadInput,keywordHealthScope,matchingKeywordHealthEvidence} from '../../apps/console/keyword-health-scope.ts';

function evidence(overrides:Partial<GscEvidence['snapshot']>={}):GscEvidence {
 return {hash:'frozen-source',snapshot:{id:'saved',property:'sc-domain:sample-agency.example',country:'CAN',device:'MOBILE',type:'web',startDate:'2026-09-01',endDate:'2026-09-28',capturedAt:'2026-10-01T12:00:00Z',timeZone:'America/Los_Angeles',dataState:'final',source:'GSC',query:'scheduling',page:'/blog/',totals:null,queries:[],pages:[],queryDaily:[],requests:[],raw:[],limitations:[],...overrides}};
}

describe('dedicated keyword history scope',()=>{
 it('reads 120 inclusive days ending at the saved snapshot date without changing any dashboard condition',()=>{
  const source=evidence(),before=JSON.stringify(source),input=keywordHealthReadInput(source);
  expect(input).toMatchObject({property:'sc-domain:sample-agency.example',country:'CAN',device:'MOBILE',type:'web',query:'scheduling',page:'/blog/',startDate:'2026-06-01',endDate:'2026-09-28',dashboard:true,compare:false,includeMonthly:false});
  expect((Date.parse(input.endDate)-Date.parse(input.startDate))/86400000+1).toBe(120);
  expect(JSON.stringify(source)).toBe(before);
 });
 it('never reuses a history read for another site, country, device, search type, filter or end date',()=>{
  const source=evidence(),history=evidence({startDate:'2026-06-01'});
  expect(matchingKeywordHealthEvidence(history,source)).toBe(history);
  for(const change of [{property:'sc-domain:sample-studio.example'},{country:'USA'},{device:'DESKTOP'},{type:'image' as const},{query:''},{page:''},{endDate:'2026-09-27'}])expect(matchingKeywordHealthEvidence(evidence({...history.snapshot,...change}),source)).toBeNull();
 });
 it('requires daily query evidence and sufficient history while allowing different dashboard start dates',()=>{
  const source=evidence();
  expect(keywordHealthScope(source)).toBe(keywordHealthScope(evidence({startDate:'2026-09-10'})));
  expect(matchingKeywordHealthEvidence(source,source)).toBeNull();
  expect(matchingKeywordHealthEvidence(evidence({startDate:'2025-09-29'}),source)).toBeNull();
  expect(matchingKeywordHealthEvidence(evidence({startDate:'2026-06-01',queryDaily:undefined}),source)).toBeNull();
  expect(matchingKeywordHealthEvidence(null,source)).toBeNull();
 });
});
