import React, {useEffect, useRef, useState} from "react";
import {t,useUiLanguage,uiMessage,LanguageSwitch} from "./i18n.tsx";
import {samplingMessage} from "./sampling-messages.ts";
import {downloadText as save} from "./download.ts";
import {Play, Pause, Square, Globe, Download, ListChecks, X, ArrowUpRight} from "lucide-react";
import {request} from "./api.ts";
import {downloadAnswers} from './answer-download.ts';
import type {BrowserJobs} from "../../src/console/browser-jobs.ts";
import type {LabService} from "../../src/console/service.ts";
import {surfaces} from "../../src/console/contracts.ts";
import {LoadingHelper} from "./loading-helper.tsx";
import {BrowserLoginSetup} from "./browser-login-setup.tsx";
import {GuestReadiness} from "./guest-readiness.tsx";
import "./browser-panel.css";
type Jobs=ReturnType<BrowserJobs["rows"]>;
type Screening=ReturnType<BrowserJobs["screening"]>;
const platforms:Record<string,string>=Object.fromEntries(Object.entries(surfaces).map(([id,s])=>[id,s.name]));
export function BrowserPanel({plan,jobs,sessions,loginReadiness,loginSetupRequest,availability,reload,select,selectPlan,onCreateLoginPlan,onCreatePlan}:{plan?:ReturnType<LabService["plan"]>;jobs:Jobs;sessions:{planId:string;surface:string;verified:boolean}[];loginReadiness?:ReturnType<BrowserJobs["loginReadiness"]>|null;loginSetupRequest?:number;availability:{available:boolean;message:string};reload:()=>Promise<unknown>;select:(slotId:string)=>void;selectPlan:(planId:string)=>void;onCreateLoginPlan?:()=>void;onCreatePlan?:()=>void}){
  const language=useUiLanguage();
  const feedback=(value:string|null|undefined)=>samplingMessage(uiMessage(value),language);
  const states:Record<string,string>={queued:t("sampling.queued"),running:t("sampling.sampling"),pausing:t("sampling.pausing"),paused:t("sampling.paused"),completed:t("sampling.batchComplete"),needs_attention:t("sampling.needsAttention"),interrupted:t("sampling.previousRunInterrupted"),pending:t("sampling.pending"),captured:t("sampling.saved"),blocked:t("sampling.accessPaused"),uncertain:t("sampling.submissionOutcomeUnknown"),failed:t("sampling.failed"),skipped:t("sampling.skipped"),carried_forward:t("sampling.movedToContinuation")};
  const stages:Record<string,string>={opening:t("sampling.openingAnIndependentSession"),preparing:t("sampling.checkingAccessAndSearchMode"),submitting:t("sampling.submittingTheFrozenQuestion"),waiting:t("sampling.waitingForTheCompleteAnswer"),capturing:t("sampling.savingTheAnswerAndSources"),saved:t("sampling.recorded")};
  const categories:Record<string,string>={owned_citation:t("sampling.ownedSiteCitation"),brand_mention:t("sampling.brandMentionOnly"),not_mentioned:t("sampling.noBrandMention"),insufficient:t("sampling.insufficientEvidence")};
  const [launch,setLaunch]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [screening,setScreening]=useState<Screening|null>(null),[screeningId,setScreeningId]=useState(""),[screeningBusy,setScreeningBusy]=useState(false);
  const [filter,setFilter]=useState("all"),[query,setQuery]=useState(""),[page,setPage]=useState(0);
  const setup=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(loginSetupRequest&&setup.current)setup.current.open=true;},[loginSetupRequest]);
  const dialog=useRef<HTMLDialogElement>(null),local=jobs.filter(j=>j.plan_id===plan?.id);
  useEffect(()=>{if(launch)dialog.current?.showModal();},[launch]);
  useEffect(()=>{setScreening(null);setScreeningId("");setError("");},[plan?.id]);
  const reviewRevision=plan?.slots.map(s=>s.latest?.review?.decision??"").join(",");
  const revision=local.map(j=>[j.id,j.status,j.captured,j.attention].join(":")).join("|");
  useEffect(()=>{
    if(!screeningId){setScreeningBusy(false);return;}
    let live=true;setScreeningBusy(true);
    request<Screening>("browser-screening?id="+screeningId).then(s=>{if(live)setScreening(s);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setScreeningBusy(false);});
    return()=>{live=false;};
  },[screeningId,revision,reviewRevision]);
  useEffect(()=>setPage(0),[filter,query,screeningId]);
  async function act(fn:()=>Promise<unknown>){setBusy(true);setError("");try{await fn();await reload();}catch(e){setError(e instanceof Error?e.message:t("sampling.theActionCouldNotBeCompleted"));}finally{setBusy(false);}}
  const rows=screening?.rows.filter(r=>(filter==="all"||r.category===filter)&&r.prompt.toLowerCase().includes(query.toLowerCase()))??[];
  const today=plan?new Intl.DateTimeFormat("en-CA",{timeZone:plan.config.timezone,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()):"";
  const questionCount=new Set(plan?.slots.map(s=>s.prompt_id)??[]).size;
  const emptySlots=plan?.slots.filter(s=>s.window===today&&!s.latest&&!s.continuation&&s.restriction?.action!=='stop').length??0;
  const strictGuest=!!plan&&(!plan.config.accountMode||plan.config.accountMode==="signed_out");
  const privateMode=plan?.config.accountMode==="signed_in_private", running=jobs.some(j=>["running","pausing"].includes(j.status)||j.finalizing);
  const readiness=loginReadiness?.planId===plan?.id?loginReadiness:null;
  const ready=!privateMode||(readiness?.ready??plan!.config.surfaces.every(surface=>sessions.some(s=>s.planId===plan!.id&&s.surface===surface&&s.verified)));
  const prerequisite=!plan?t("sampling.reviewAndFreezeYourQuestionsThenCreateASamplingPlan"):!availability.available?feedback(availability.message):running?t("sampling.aSamplingJobIsAlreadyRunningCheckItsProgressOrPause"):!ready?t("sampling.setUpTheRequiredPlatformLoginsBelowThenStartSamplingManually"):!emptySlots?t("sampling.thereAreNoEmptyPositionsForTodayViewExistingResultsOr"):'';
  const activeJob=local.find(j=>["running","pausing"].includes(j.status))??local.find(j=>["paused","interrupted","needs_attention","queued"].includes(j.status));
  const currentJob=activeJob??local[0];
  function resumeBlocked(j:Jobs[number]){
    if(j.finalizing)return t("sampling.finishingThePauseAndClosingTheBrowserYouCanContinueOnce");
    if(!availability.available)return feedback(availability.message);
    if(running)return t("sampling.anotherBatchIsSamplingPauseItBeforeContinuingThisBatch");
    if(!j.resume.expired&&!ready)return t("sampling.setUpTheRequiredPlatformLoginsBelowThenContinueUnsubmittedTasks");
    if(j.resume.expired||j.resume.current)return "";
    if(j.resume.successor)return t("sampling.unsubmittedTasksHaveMovedToANewPlanOpenTheContinuation");
    return j.remaining>0?t("sampling.noRemainingPositionsCanRunRightNowAccessIsRestrictedOr"):t("sampling.thisBatchHasNoUnsubmittedTasksToContinueSavedResultsAnd");
  }
  const stopping=(j:Jobs[number])=>j.status==="pausing"&&j.message.includes("正在停止");
  function controlHelp(j:Jobs[number]){
    if(j.status==="running")return t("sampling.pauseSavesTheQuestionInProgressOnEachPlatformBeforeStopping");
    if(j.status==="pausing")return stopping(j)?t("sampling.stoppingRequestsThatMayHaveBeenSubmittedButNotSavedAre"):t("sampling.savingTheCurrentQuestionOnEachPlatformThenPausingYouCan");
    const loginHint=!strictGuest&&!privateMode&&readiness?.platforms.some(p=>p.required&&!p.confirmed)?t("sampling.youCanContinueOtherUnrestrictedPlatformsSetUpTheLoginBefore"):"";
    return resumeBlocked(j)||(j.resume.expired?t("sampling.continueExpiredUnsubmittedPositionsOnDateRecordedUnderTheNewDate", { expired: j.resume.expired, date: j.resume.date, loginHint }):t("sampling.continueCurrentUnsubmittedPositionsSavedRequestsAndRequestsWithUnknownOutcomes", { current: j.resume.current, loginHint }));
  }
  const pauseSampling=(id:string)=>act(()=>request("browser-control",{id,action:"pause"}));
  const stopSampling=(id:string)=>act(()=>request("browser-control",{id,action:"stop"}));
  const continueSampling=(id:string)=>act(async()=>{const result=await request<{planId:string}>("browser-control",{id,action:"resume",browserMode:"silent"});await reload();selectPlan(result.planId);});
  return <section className="panel browser-batch sampling-desk">
    <div className="section-head"><div><h2>{t("sampling.samplingQuestionScreening")}</h2>{plan&&<p className="muted">{t("sampling.currentPlanQuestionCountQuestionQuestionsPlatformCountPlatformPlatformsRepeatCountRepeatRepeats", { questionCount, platformCount: plan.config.surfaces.length, repeatCount: plan.config.repetitions??1, dateCount: plan.config.windows.length, positionCount: plan.slots.length })}</p>}</div>
      <div className="button-row">{activeJob?activeJob.status==="running"?<button className="primary" disabled={busy} aria-describedby="sampling-active-help" onClick={()=>pauseSampling(activeJob.id)}><Pause size={16}/>{t("sampling.pauseSampling")}</button>:activeJob.status==="pausing"?<button className="primary" disabled aria-describedby="sampling-active-help"><Pause size={16}/>{stopping(activeJob)?t("sampling.stopping"):t("sampling.pausingContext2")}</button>:<button className="primary" disabled={busy||!!resumeBlocked(activeJob)} aria-describedby="sampling-active-help" onClick={()=>continueSampling(activeJob.id)}><Play size={16}/>{t("sampling.continueSampling")}</button>:emptySlots||!currentJob?<button className="primary" disabled={!!prerequisite||busy} aria-describedby={prerequisite?'sampling-prerequisite':undefined} onClick={()=>setLaunch(true)}><Play size={16}/>{t("sampling.startABatch")}</button>:<button className="primary" onClick={()=>{setScreeningId(currentJob.id);setPage(0);}}><ListChecks size={16}/>{t("sampling.viewAllScreeningResults")}</button>}</div></div>
    {currentJob&&<div className="sampling-current" role="status"><strong>{currentJob.status==='needs_attention'&&currentJob.remaining===0?t("sampling.samplingFinishedRecordsNeedAttention"):states[currentJob.status]??currentJob.status}</strong><span>{t("sampling.recordsSaved", { saved: currentJob.captured, total: currentJob.total })}</span>{currentJob.attention>0&&<span className="tag warning">{t("sampling.needsAttention")} · {currentJob.attention}</span>}<progress max={currentJob.total} value={currentJob.captured} aria-label={t("sampling.recordsSavedInThisBatch")}/></div>}
    {activeJob?<p className="muted" id="sampling-active-help" role="status">{controlHelp(activeJob)}</p>:prerequisite&&<div className="batch-prerequisite" id="sampling-prerequisite"><p>{prerequisite}</p></div>}
    {activeJob&&["running","pausing"].includes(activeJob.status)&&<><LoadingHelper active phase="entry" compact title={activeJob.status==="pausing"?t("sampling.finishingTheCurrentQuestions"):t("sampling.samplingIsActive")} detail={t("sampling.actualProgressIsShownBelowYouCanPauseOrStopThis")}/>{activeJob.currents.map(current=>{const slot=plan?.slots.find(s=>s.id===current.slot_id);return <p className="sampling-current-stage" key={current.id}><strong>{slot&&platforms[slot.surface]}</strong> · {stages[current.stage]??current.stage}</p>;})}</>}
    <details ref={setup} className="sampling-options" open={!ready||!availability.available}><summary>{t("sampling.setupAndOptions")}</summary><div>
      <p className="muted">{feedback(availability.message)} {t("background.taskBehavior")}</p><p className="muted">{t("background.lifecycleHint")}</p>
      {activeJob&&activeJob.config.browserMode!=="silent"&&activeJob.status!=="running"&&activeJob.status!=="pausing"&&<p className="quiet-note">{t("background.continuationHint")}</p>}
      {plan&&<p className="muted">{privateMode?t("sampling.loginIsKeptOnlyInThisBatchSIndependentWindowsPausing"):t("sampling.eachQuestionUsesAnIndependentPrivateSession")}</p>}
      {onCreatePlan&&<div className="button-row"><button disabled={busy} onClick={onCreatePlan}>{t("workflow.createSamplingPlan")}</button></div>}
      {strictGuest?<GuestReadiness key={plan!.id} plan={plan!} samplingActive={running} available={availability.available}/>:<BrowserLoginSetup plan={plan} readiness={readiness} loginSetupRequest={loginSetupRequest} expiredPrivatePlan={privateMode&&local.some(j=>j.resume.expired>0)} sessions={sessions} availability={availability} busy={busy} samplingActive={running} activeJob={jobs.find(j=>["running","pausing"].includes(j.status)||j.finalizing)} act={act} onPause={pauseSampling} onCreateLoginPlan={onCreateLoginPlan}/>}
      {activeJob&&["running","pausing"].includes(activeJob.status)&&<div className="button-row"><button disabled={busy||stopping(activeJob)} aria-describedby="sampling-active-help" onClick={()=>stopSampling(activeJob.id)}><Square size={14}/>{t("sampling.stopNow")}</button></div>}
    </div></details>
    {error&&<div className="alert error" role="alert">{feedback(error)}</div>}
    {plan?.slots.some(s=>s.latest)&&<div className="button-row"><button disabled={busy} onClick={()=>act(()=>downloadAnswers(plan.id))}><Download size={15}/>{t("sampling.exportAnswersSourcesMd")}</button><small className="muted">{t("sampling.theReadableCaptureCopyIncludesExclusionReasonsAndFailureStatesManual")}</small></div>}
    {!local.length&&<div className="batch-placeholder"><Globe size={22}/><span>{plan?t("sampling.thisPlanHasEmptySlotsEmptyPositionsForTodayQueuedPositionsAre", { emptySlots }):t("sampling.selectAFrozenQuestionSetAndCreateASamplingPlan")}</span></div>}
    {!!local.length&&<details className="sampling-history"><summary>{t("sampling.savedBatches", { count: local.length })}</summary>{local.map(j=>{
      const continueBlocked=resumeBlocked(j);
      const controlHelpId=`batch-control-${j.id}`;
      return <div className="batch-run" key={j.id}>
      <div className="batch-run-top">
        <strong>{j.status==='needs_attention'&&j.remaining===0?t("sampling.samplingFinishedRecordsNeedAttention"):states[j.status]??j.status}</strong>
        <span className="mono">{j.id.slice(0,8)}</span>
        <span>{j.config.executionMode==='parallel'?t("sampling.parallelPlatforms"):t("sampling.sequentialQueue")} {t("sampling.interval", { seconds: j.config.intervalSeconds })}</span>
        <span>{j.config.browserMode==='silent'?t("sampling.quietBackground"):t("sampling.visibleWindows")}</span>
        <span>{j.config.captureScreenshot===false?t("sampling.textSources"):t("sampling.textSourcesScreenshotsRequested")}</span>
        <span>{t("sampling.recordsSaved", { saved: j.captured, total: j.total })}</span>
        <span>{t("sampling.pendingPositions", { count: j.counts.pending??0 })}</span>
        {j.failedRecords>0&&<span className="tag warning">{t("sampling.failedRecords", { count: j.failedRecords })}</span>}
        {(j.counts.blocked??0)>0&&<span className="tag warning">{t("sampling.positionsPausedByAccess", { count: j.counts.blocked })}</span>}
        {(j.counts.uncertain??0)>0&&<span className="tag warning">{t("sampling.positionsWithUnknownSubmissionOutcomes", { count: j.counts.uncertain })}</span>}
        {(j.counts.failed??0)>0&&<span className="tag warning">{t("sampling.interruptedPositions", { count: j.counts.failed })}</span>}
      </div>
      <progress max={j.total} value={j.captured} aria-label={t("sampling.recordsSavedInThisBatch")}/>
      <div className="button-row">{[...new Set(j.lanes.map(l=>l.surface))].map(surface=><small className="muted" key={surface}>{platforms[surface]} · {j.lanes.filter(l=>l.surface===surface).map(l=>`${states[l.state]??l.state} ${l.n}`).join(' / ')}</small>)}</div>
      {j.currents.map(current=>{const slot=plan?.slots.find(s=>s.id===current.slot_id);return <p key={current.id}><strong>{slot&&platforms[slot.surface]}</strong> · {stages[current.stage]??current.stage} · {slot?.prompt}</p>;})}
      {j.message&&j.status!=="pausing"&&<p className="muted">{j.status==='needs_attention'&&j.remaining===0?t("sampling.thereAreNoUnsubmittedTasksToContinueInThisBatchView"):feedback(j.message)}</p>}
      <div className="button-row">
        {j.status==="running"?<><button disabled={busy} aria-describedby={controlHelpId} onClick={()=>pauseSampling(j.id)}><Pause size={15}/>{t("sampling.pauseSampling")}</button><button disabled={busy} aria-describedby={controlHelpId} onClick={()=>stopSampling(j.id)}><Square size={14}/>{t("sampling.stopNow")}</button>{j.config.browserMode!=="silent"&&<button onClick={()=>act(()=>request("browser-control",{id:j.id,action:"show"}))}>{t("sampling.viewSamplingWindows")}<ArrowUpRight size={14}/></button>}</>:j.status==="pausing"?<><button disabled aria-describedby={controlHelpId}><Pause size={15}/>{stopping(j)?t("sampling.stopping"):t("sampling.pausingContext2")}</button><button disabled={busy||stopping(j)} aria-describedby={controlHelpId} onClick={()=>stopSampling(j.id)}><Square size={14}/>{t("sampling.stopNow")}</button></>:j.status!=="completed"?<button disabled={busy||!!continueBlocked} aria-describedby={controlHelpId} onClick={()=>continueSampling(j.id)}><Play size={15}/>{t("sampling.continueSampling")}</button>:null}
        {j.resume.successor&&<button disabled={busy} onClick={()=>selectPlan(j.resume.successor!.planId)}>{t("sampling.openContinuationBatch")}</button>}
        {j.resume.parent&&<button disabled={busy} onClick={()=>selectPlan(j.resume.parent!.planId)}>{t("sampling.viewOriginalBatchResults")}</button>}
        <button onClick={()=>{setScreeningId(j.id);setPage(0);}}><ListChecks size={15}/>{t("sampling.viewAllScreeningResults")}</button>
      </div>
      {j.status!=="completed"&&<p className="muted" id={controlHelpId} role="status">{controlHelp(j)}</p>}
    </div>;})}</details>}
    {(busy||screeningBusy)&&!running&&<LoadingHelper active phase="entry" compact title={screeningBusy?t("sampling.readingSavedScreeningResults"):t("sampling.applyingYourAction")} detail={t("sampling.waitingForTheApplicationToRespond")}/>}
    {screening&&<div className="screening">
      <div className="section-head"><div><h3>{t("sampling.screeningDraft", { count: screening.total })}</h3><p className="muted">{t("sampling.checkedAutomatically", { checked: screening.checked, exportable: screening.contentQualified, eligible: screening.eligible })}</p></div>
        <div className="button-row"><button onClick={()=>save(`geo-screening-${screening.jobId.slice(0,8)}.json`,JSON.stringify(screening,null,2),"application/json")}><Download size={14}/>JSON</button><button onClick={()=>{
          const cell=(v:unknown)=>{let s=String(v??"");if(/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
          const csv=[[t("common.question"),t("sampling.platform"),t("sampling.accountCondition"),t("sampling.queueState"),t("sampling.candidateResult"),t("sampling.review"),t("sampling.metricEligible"),t("sampling.conditionIssues"),t("sampling.nextStep"),t("sampling.evidenceHash")],...screening.rows.map(r=>[r.prompt,platforms[r.surface],screening.accountMode,states[r.state],categories[r.category],r.review,r.eligible?t("common.yes"):t("common.no"),r.issues.map(feedback).join(t("sampling.message")),feedback(r.nextAction),r.evidenceHash])].map(row=>row.map(cell).join(",")).join("\r\n");
          save(`geo-screening-${screening.jobId.slice(0,8)}.csv`,"\uFEFF"+csv,"text/csv;charset=utf-8");
        }}><Download size={14}/>CSV</button></div></div>
      <p className="muted">{feedback(screening.scope)}</p>
      <div className="screening-filters"><input aria-label={t("sampling.searchScreeningQuestions")} placeholder={t("sampling.searchOriginalQuestions")} value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label={t("sampling.filterScreeningResults")} value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">{t("sampling.allResults")}</option>{Object.entries(categories).map(([k,v])=><option key={k} value={k}>{v} · {screening.rows.filter(r=>r.category===k).length}</option>)}</select></div>
      <div className="table-scroll"><table><thead><tr><th>{t("sampling.questionPlatform")}</th><th>{t("sampling.state")}</th><th>{t("sampling.candidateResult")}</th><th>{t("sampling.nextStep")}</th><th>{t("sampling.evidence")}</th></tr></thead><tbody>{rows.slice(page*25,(page+1)*25).map(r=><tr key={r.slotId}><td><strong>{r.prompt}</strong><small>{platforms[r.surface]}</small></td><td>{states[r.state]}<small>{(r.quality?.label?feedback(r.quality.label):t("sampling.notSampledYet"))}</small></td><td>{categories[r.category]}{r.citationCount!==null&&<small>{t("sampling.extractedCitations", { count: r.citationCount })}</small>}</td><td>{feedback(r.nextAction)}{r.issues.length>0&&<small className="muted">{r.issues.map(feedback).join(t("sampling.message"))}</small>}</td><td><button onClick={()=>select(r.slotId)}>{t("sampling.view")}</button></td></tr>)}</tbody></table></div>
      <div className="screening-pagination"><span>{t("sampling.rowCountPositionsPagePageNumberPageCount", { rowCount: rows.length, pageNumber: page+1, pageCount: Math.max(1,Math.ceil(rows.length/25)) })}</span><button disabled={!page} onClick={()=>setPage(p=>p-1)}>{t("common.previous")}</button><button disabled={(page+1)*25>=rows.length} onClick={()=>setPage(p=>p+1)}>{t("common.next")}</button></div>
    </div>}
    {launch&&<dialog ref={dialog} className="batch-dialog" onCancel={()=>setLaunch(false)}><header><h2>{t("sampling.startAChromeSamplingBatch")}</h2><LanguageSwitch/><button aria-label={t("sampling.closeBatchSettings")} className="icon" onClick={()=>setLaunch(false)}><X size={20}/></button></header>
      {error&&<div role="alert" className="alert error">{feedback(error)}</div>}
      <form onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);void act(async()=>{await request("browser-jobs",{planId:plan!.id,intervalSeconds:Number(f.get("interval")),executionMode:String(f.get("executionMode")),browserMode:String(f.get("browserMode")),timeoutSeconds:Number(f.get("timeout")),captureScreenshot:f.get("captureScreenshot")==='on',verifiedCountry:f.get("verified")?String(f.get("country")).trim().toUpperCase():null,geoVerificationNote:f.get("verified")?String(f.get("geoNote")):"",transmissionAcknowledged:true});setLaunch(false);});}}>
        <p><strong>{plan?.label}</strong> {t("sampling.today", { count: emptySlots })}</p>
        <input type="hidden" name="browserMode" value="silent"/>
        <p className="quiet-note">{t("background.batchHint")}</p>
        <p className="muted">{t("sampling.inQuietModeViewProgressAnswersAndSourcesHereACAPTCHA")}</p>
        <details className="sampling-run-options"><summary>{t("sampling.runOptions")}</summary><div>
        <label className="field"><span>{t("sampling.queueMode")}</span><select name="executionMode" defaultValue="parallel"><option value="parallel">{t("sampling.parallelPlatformsOneQuestionPerPlatformAtATime")}</option><option value="serial">{t("sampling.sequentialOneQueueAcrossAllPlatforms")}</option></select></label>
        <div className="form-grid"><label className="field"><span>{t("sampling.intervalBetweenQuestionsSeconds")}</span><input name="interval" type="number" min="5" max="300" defaultValue="10" required/></label><label className="field"><span>{t("sampling.timeoutPerQuestionSeconds")}</span><input name="timeout" type="number" min="45" max="300" defaultValue="150" required/></label></div>
        <p className="muted">{t("sampling.parallelModeGivesEachPlatformItsOwnQueueAndIntervalWith")}</p>
        {(plan?.config.egressPolicy==='canada_fixed'||plan?.config.egressPolicy==='country_fixed')?<p className="muted">{t("sampling.targetCountry", { country: plan.config.country, repeatCount: plan.config.repetitions??1 })}</p>:<details><summary>{t("sampling.samplingLocationVerificationOptional")}</summary><p className="muted">{t("sampling.byDefaultLocationIsRecordedAsUnverifiedAnswersCanStillBe")}</p><label><input type="checkbox" name="verified"/> {t("sampling.iHaveVerifiedThisBrowserSExitCountry")}</label><div className="form-grid"><label className="field"><span>{t("sampling.countryCode")}</span><input name="country" maxLength={2} defaultValue={plan?.config.country}/></label><label className="field"><span>{t("sampling.verificationBasis")}</span><input name="geoNote" placeholder={t("sampling.verificationMethodAndTimeNoIPsAccountsOrKeys")} maxLength={500}/></label></div></details>}
        <label className="batch-consent"><input type="checkbox" name="captureScreenshot"/> {t("sampling.alsoSavePageScreenshotsOptionalOffByDefault")}</label>
        <p className="muted">{t("sampling.textModeKeepsOriginalAnswersSourceTitlesAndLinksPlatformAnd")}</p>
        </div></details>
        <label className="batch-consent"><input type="checkbox" required/> {t("sampling.sendThisPlanSOriginalQuestionsToTheSelectedPublicAI")}</label>
        <footer><button type="button" onClick={()=>setLaunch(false)}>{t("common.cancel")}</button><button className="primary" disabled={busy||!emptySlots} type="submit">{busy?t("sampling.creatingTheQueue"):t("sampling.startSampling")}</button></footer>
      </form></dialog>}
  </section>;
}
