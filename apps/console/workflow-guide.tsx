import {t, useUiLanguage} from "./i18n.tsx";
import React from 'react';
import {ArrowRight, Check, AlertCircle, LoaderCircle} from 'lucide-react';

export type WorkflowFacts = {
  brand?: string; set?: string; questions: number; frozen: boolean;
  planned: number; recorded: number; answers: number; checked: number;
  qualified: number; eligible: number; attention: number; transferred: number;
  running: boolean;
};
export type WorkflowAction = 'brand'|'questions'|'freeze'|'plan'|'sampling'|'quality'|'report';
export function nextWorkflowAction(f: WorkflowFacts): WorkflowAction {
  if (!f.brand) return 'brand';
  if (!f.set || !f.questions) return 'questions';
  if (!f.frozen) return 'freeze';
  if (!f.planned) return 'plan';
  if (f.running) return 'sampling';
  if (f.recorded) return 'report';
  return 'sampling';
}
export function WorkflowGuide({facts:f,page,onNavigate,onAction}:{facts:WorkflowFacts;page:string;onNavigate:(page:string)=>void;onAction:(action:WorkflowAction)=>void}) {
  useUiLanguage();
const actions: Record<WorkflowAction,{title:string;body:string;button:string}> = {
  brand:{title:t("workflow.createAProjectFirst"),body:t("workflow.addABrandAndWebsiteToKeepQuestionsAnswersAndSources"),button:t("common.createProject")},
  questions:{title:t("workflow.aNotebookForYourQuestions"),body:t("workflow.collectCandidatesFromLocalDataOrBringYourOwnInquiryRecords"),button:t("workflow.collectQuestions")},
  freeze:{title:t("workflow.reviewQuestionsThenFreezeTheScope"),body:t("workflow.checkTheTextSourcesAndLanguageAFrozenSetIsReady"),button:t("workflow.reviewFreeze")},
  plan:{title:t("workflow.chooseTheSamplingConditions"),body:t("workflow.chooseAIPlatformsDatesTargetMarketAndRepetitionsThenSaveThe"),button:t("workflow.createSamplingPlan")},
  sampling:{title:t("workflow.checkSamplingProgress"),body:t("workflow.startOrContinueTasksHereRestrictedAccessAndUnknownSubmissionResults"),button:t("workflow.viewSamplingTasks")},
  quality:{title:t("workflow.automaticQualityChecksCompleted"),body:t("workflow.theProgramChecksTextSourcesAndSamplingConditionsExceptionsKeepTheir"),button:t("workflow.viewQualityExceptions")},
  report:{title:t("workflow.resultsGeneratedAutomatically"),body:t("workflow.seeAnswersSourcesAndAutomaticScreeningOrDownloadAReportExceptions"),button:t("workflow.viewResultsExports")},
};
const stages=[
  {id:'brands',name:t("workflow.project"),action:'brand'},
  {id:'questions',name:t("common.question"),action:'questions'},
  {id:'workspace',name:t("workflow.sampling"),action:'sampling'},
  {id:'evidence',name:t("workflow.qualityChecks"),action:'quality'},
  {id:'reports',name:t("workflow.reports"),action:'report'},
] as const;
  const next=nextWorkflowAction(f),copy=actions[next];
  const labels=[f.brand?t("workflow.created"):t("workflow.toCreate"),f.frozen?t("workflow.questionsFrozenQuestions", { questions: f.questions }):f.questions?t("workflow.questionsQuestionsToReview", { questions: f.questions }):t("workflow.toPrepare"),
    f.running?t("workflow.samplingContext2"):f.planned?t("workflow.recordedPlannedRecorded", { recorded: f.recorded, planned: f.planned }):t("workflow.planNeeded"),
    f.checked?t("workflow.checkedChecked", { checked: f.checked }):t("workflow.checkedAfterCollection"),
    f.recorded?t("workflow.generatedDownloadable"):f.planned?t("workflow.generatedAfterCollection"):t("workflow.planNeeded")];
  const done=[!!f.brand,f.frozen,f.planned>0&&f.recorded===f.planned&&f.attention===0,f.checked>0&&f.checked===f.recorded,f.recorded>0];
  return <section className="workflow-guide workflow-guide-simple" aria-label={t("workflow.gEOObservationSteps")}>
    <div className="workflow-next"><div><strong>{f.running?t("workflow.samplingInProgress"):copy.title}</strong><p>{copy.body}</p></div><button className="primary" aria-busy={f.running} onClick={()=>onAction(next)}>{f.running?<LoaderCircle size={16} className="busy-indicator"/>:null}{copy.button}<ArrowRight size={16}/></button></div>
    {f.attention>0&&<p className="workflow-current-attention"><AlertCircle size={13}/>{t("workflow.attentionRestrictedErroredOrWithConditionNotes", { attention: f.attention })}</p>}
    <details className="workflow-detail"><summary>{t("workflow.setupAndProgress")}</summary>
    <div className="workflow-context"><strong>{t("workflow.thisObservation")}</strong><span>{f.set??f.brand??t("workflow.startWithAProject")}</span></div>
    <ol className="workflow-steps">{stages.map((s,i)=><li key={s.id}><button className={'workflow-step'+(done[i]?' is-done':'')+(i===2&&f.attention?' has-attention':'')} aria-current={page===s.id?'step':undefined} onClick={()=>onNavigate(s.id)}><span className="workflow-number">{done[i]?<Check size={15}/>:i+1}</span><span><strong>{s.name}</strong><small>{labels[i]}</small></span></button></li>)}</ol>
    {!!f.planned&&<p className="workflow-coverage"><span>{t("workflow.checkedAutomaticallyChecked", { checked: f.checked })}</span><span>{t("workflow.qualifiedExportableAnswers", { qualified: f.qualified })}</span><span>{t("workflow.eligibleEligibleForFormalMetrics", { eligible: f.eligible })}</span>{f.attention>0&&<span><AlertCircle size={13}/>{t("workflow.attentionRestrictedErroredOrWithConditionNotes", { attention: f.attention })}</span>}{f.transferred>0&&<span>{t("workflow.transferredContinuedSlots", { transferred: f.transferred })}</span>}</p>}
    </details>
  </section>;
}
