import {surfaces} from './contracts.ts';
import {normalizeSourceUrl} from './sources.ts';
import {sha256} from '../lib/canonical-json.ts';
import type {LabService} from './service.ts';
import {reportCopy,reportLocale,type ReportLocale} from './report-language.ts';

const escape=(value:unknown)=>String(value??'').replace(/[\r\n]+/g,' ').replace(/[\\`*_{}\[\]()<>#!|]/g,'\\$&');
function sourceOrigin(source:string|undefined,copy:ReturnType<typeof reportCopy>){
  try{return source?new URL(source).origin:copy.notRecorded;}catch{return copy.invalidOrigin;}
}
function literal(text:string){
  const longest=Math.max(2,...[...text.matchAll(/`+/g)].map(m=>m[0].length));
  const fence='`'.repeat(longest+1);
  return `${fence}text\n${text}\n${fence}`;
}
/** A reading copy of latest captures. It never invents sources or fetches cited pages. */
export function answerMarkdown(plan:ReturnType<LabService['plan']>,ownedDomains:string[],locale:ReportLocale='en'){
  const copy=reportCopy(locale),separator=reportLocale(locale)==='zh-CN'?'：':': ';
  const labels:Record<string,string>={observed:copy.observed,not_triggered:copy.notTriggered,unavailable:copy.unavailable,error:copy.error,cancelled:copy.cancelled};
  const lines=[`# getaudit / ${escape(plan.label)} · ${copy.answersAndSources}`,
    `${copy.planId}${separator}${escape(plan.id)}`,
    `${copy.market}${separator}${escape(plan.config.country)} · ${escape(plan.config.locale)} · ${escape(plan.config.timezone)}`,
    `${copy.plannedAccount}${separator}${plan.config.accountMode==='signed_in_private'?copy.privateSession:plan.config.accountMode==='isolated'?copy.isolatedSession:copy.freshSession} · ${plan.slots.length} ${copy.positions}`,
    copy.readingCopy,copy.answerSourceLimits,copy.literalCopy];
  let exportedAnswers=0,sourceCount=0;
  for(const [index,slot] of plan.slots.entries()){
    const a=slot.latest,c=a?.capture;
    const run=`${((slot.run_idx-1)%(plan.config.repetitions??1))+1}/${plan.config.repetitions??1}`;
    lines.push(`## ${index+1}. ${surfaces[slot.surface].name} · ${escape(slot.window)} · ${reportLocale(locale)==='zh-CN'?`第 ${run} 次`:`${copy.run} ${run}`}`,`${copy.question}${separator}\n\n${literal(slot.prompt)}`);
    if(!a||!c){lines.push(slot.continuation?`${copy.status}${separator}${copy.continuedTo} ${escape(slot.continuation.window)}; ${copy.continuationPlan} ${escape(slot.continuation.planId)}. ${copy.originalPosition}`:`${copy.status}${separator}${copy.noCapture}`);continue;}
    lines.push(`${copy.status}${separator}${labels[c.status]??escape(c.status)} · ${copy.automaticQuality}${separator}${escape(a.quality.label)} · ${copy.formalMetric}${separator}${a.quality.metricEligible?copy.included:copy.excluded}`,
      `${copy.optionalReview}${separator}${a.review?.decision==='accept'?copy.accepted:a.review?.decision==='reject'?copy.rejected:copy.notRequested} · ${copy.evaluatorVersion}${separator}${escape(a.quality.evaluatorVersion)} · ${copy.evaluationHash}${separator}${escape(a.quality.assessmentHash)}`,
      ...(a.quality.reasons.length?[`${copy.recordedQuality}${separator}${a.quality.reasons.map(escape).join('；')}`]:[]),
      `${copy.sampledAt}${separator}${escape(c.observedAt)} · ${copy.modelId}${separator}${escape(c.model)}`,
      `${copy.samplingPage}${separator}${escape(sourceOrigin(c.sourceUrl,copy))} (${copy.originOnly})`,
      `${copy.actualAccount}${separator}${escape(c.account)} · ${copy.region}${separator}${escape(c.exitCountry??copy.unknown)} · ${copy.geography}${separator}${escape(c.geo)}`,
      `${copy.browserMode}${separator}${c.browser?.mode==='silent'?copy.silent:c.browser?.mode==='visible'?copy.visible:copy.historicalUnrecorded}`,
      `${copy.answerCompleteness}${separator}${c.browser?.answerComplete===true?copy.extractorConfirmed:c.browser?.answerComplete===false?copy.notConfirmed:copy.notRecorded}`,
      `${copy.sourceCompleteness}${separator}${c.browser?.citationsComplete===true?copy.extractorConfirmed:c.browser?.citationsComplete===false?copy.incomplete:copy.notRecorded} · ${copy.unresolved}${separator}${c.browser?.unresolvedCitations??copy.notRecorded} · ${copy.overflow}${separator}${c.browser?.citationOverflow??copy.notRecorded}`,
      `${copy.captureRecord}${separator}${escape(a.id)} · SHA-256${separator}${escape(a.hash)}`);
    if(!a.integrity||a.review?.decision==='reject'){
      lines.push(!a.integrity?copy.integrityFailed:copy.rejectedBody);continue;
    }
    if(a.quality.contentIssues.includes("保存的采集记录格式无效")){
      lines.push(copy.malformed);continue;
    }
    if(c.reason)lines.push(`${copy.endReason}${separator}${escape(c.reason)}`);
    if(slot.issues.length)lines.push(`${copy.conditionNotes}${separator}${slot.issues.map(escape).join('；')}`);
    if(c.status!=='observed'){lines.push(copy.noCompleteAnswer);continue;}
    exportedAnswers++;lines.push(`### ${copy.originalAnswer}`,literal(c.answer),`### ${copy.displayedSources}`);
    if(!c.citations.length)lines.push(copy.noExtractedSources);
    for(const [n,link] of c.citations.entries()){
      const normalized=normalizeSourceUrl(link.url);
      if(!normalized){lines.push(`${n+1}. ${copy.unsafeLink}`);continue;}
      const url=normalized.replace(/[<>\s]/g,char=>encodeURIComponent(char));
      const host=new URL(url).hostname.toLowerCase().replace(/^www\./,'');
      const owned=ownedDomains.some(d=>{const domain=d.toLowerCase().replace(/^www\./,'');return host===domain||host.endsWith('.'+domain);});
      const placement=link.placement==='answer_link'?copy.answerLink:link.placement==='source_panel'?copy.sourcePanel:copy.unrecordedPlacement;
      lines.push(`${n+1}. [${escape(link.title||host)}](<${url}>) — ${escape(host)} · ${placement}${owned?' · '+copy.ownedDomain:''}`);sourceCount++;
    }
  }
  const markdown=lines.join('\n\n')+'\n';
  return {filename:`geo-answers-${plan.id.slice(0,8)}.md`,markdown,sha256:sha256(markdown),positions:plan.slots.length,exportedAnswers,sourceCount};
}
