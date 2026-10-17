import type {GscEvidence} from '../../src/console/gsc.ts';

/** A separate history read keeps the dashboard's chosen period intact. */
export function keywordHealthReadInput(evidence:GscEvidence) {
  const s=evidence.snapshot;
  return {
    property:s.property,
    startDate:new Date(Date.parse(s.endDate)-119*86400000).toISOString().slice(0,10),
    endDate:s.endDate,country:s.country,device:s.device??'ALL',type:s.type,
    query:s.query??'',page:s.page??'',dashboard:true,compare:false,includeMonthly:false,
  };
}

export function keywordHealthScope(evidence:GscEvidence) {
  return JSON.stringify(keywordHealthReadInput(evidence));
}

export function matchingKeywordHealthEvidence(candidate:GscEvidence|null,source:GscEvidence|null) {
  if(!candidate||!source||keywordHealthScope(candidate)!==keywordHealthScope(source))return null;
  const s=candidate.snapshot;
  if(!s.queryDaily||s.startDate!==keywordHealthReadInput(source).startDate)return null;
  return candidate;
}
