import {t, useUiLanguage, uiMessage, LanguageSwitch} from "./i18n.tsx";
import { displayQuestionSetLabel } from "./question-set-labels.ts";
import { GscPanel } from "./gsc-panel.tsx";
import {AccountChip,refreshAccountStatus} from "./account-chip.tsx";
import {AgentPanel} from "./agent-panel.tsx";
import { KeywordAuditPanel } from "./keyword-audit-panel.tsx";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  Settings2,
  ArrowLeft,
  Building2,
  ListChecks,
  Layers,
  FileText,
  FlaskConical,
  Plus,
  ArrowUpRight,
  ChevronRight,
  Search,
  ShieldCheck,
  Check,
  AlertTriangle,
  Clock,
  PanelRightClose,
  Copy,
  Upload,
  Download,
  LockKeyhole,
  RefreshCw,
  Globe,
  CheckCircle2,
  Circle,
  Link2,
  X,
} from "lucide-react";
import type { ApiJobs } from "../../src/console/api-jobs.ts";
import type { LabService } from "../../src/console/service.ts";
import type { Capture } from "../../src/console/contracts.ts";
import {surfaces as surfaceRegistry} from "../../src/console/contracts.ts";
import "./style.css";
import {LoadingHelper} from "./loading-helper.tsx";
import {DotHelper} from "./dot-helper.tsx";
import { request, authHeaders as auth } from "./api.ts";
import { AiPanel } from "./ai-panel.tsx";
import { downloadBlob } from "./download.ts";
import { SourcesPanel } from "./sources-panel.tsx";
import { QuestionInput } from "./question-input.tsx";
import {LocalQuestionsPanel} from './local-questions-panel.tsx';
import './local-questions.css';
import {WorkflowGuide,type WorkflowAction,type WorkflowFacts} from './workflow-guide.tsx';
import './workflow.css';
import './interaction.css';
import { BrandsPanel } from "./brands-panel.tsx";
import { BrowserPanel } from "./browser-panel.tsx";
import { ConsoleBoundary } from "./console-boundary.tsx";
import {ConnectionAccessNotice, ConnectionSettingsEditor, useConnectionAccessPolling, type ConnectionAccess} from './connection-access.tsx';
import type {BrowserJobs} from "../../src/console/browser-jobs.ts";
import "./playful.css";
import "./simple-shell.css";
import {WorkspaceSettings} from "./workspace-settings.tsx";
import {brandForProperty,preferredBrandProperty} from "./brand-property.ts";
import {GoogleConnectionPanel,type GoogleSelection} from "./google-connection-panel.tsx";
import {Ga4Panel} from "./ga4-panel.tsx";
type State = ReturnType<LabService["state"]> & {
  demo: boolean;
  isolatedSampling: boolean;
  apiJobs: ReturnType<ApiJobs["rows"]>;
  browserJobs: ReturnType<BrowserJobs["rows"]>;
  browserSessions: {planId:string;surface:string;verified:boolean}[];
  browserAvailability: {available:boolean;message:string};
  settings: {
    persisted: boolean;
    access?: ConnectionAccess;
    fields: {
      key: string;
      label: string;
      configured: boolean;
      secret: boolean;
    }[];
  };
};
type SamplingDraft = {
  artifact: Capture["artifact"];
  observedAt: string;
  context: { locale: string; timezone: string };
  url: string;
  sessionRef: string;
};
type Plan = ReturnType<LabService["plan"]>;
type Slot = Plan["slots"][number];
type Report = ReturnType<LabService["report"]>;
type Brand = {
  id: string;
  name: string;
  owned_domains: string;
  aliases: string;
  category: string | null;
};
type SetRow = {
  id: string;
  brand_id: string;
  label: string;
  frozen_at: string | null;
  frozen_hash: string | null;
  prompt_count: number;
};
const names:Record<string,string>=Object.fromEntries(Object.entries(surfaceRegistry).map(([id,s])=>[id,s.name]));
function statusLabel(value: string) {
const statuses: Record<string, string> = {
  observed: t("workspace.completeAnswer"),
  not_triggered: t("workspace.overviewNotTriggered"),
  unavailable: t("workspace.unavailable"),
  error: t("workspace.executionError"),
  cancelled: t("workspace.cancelled"),
  pending: t("workspace.awaitingSampling"),
  continued: t("workspace.movedToContinuation"),
};
return statuses[value] ?? value;
}
const tokenParams = new URLSearchParams(location.hash.slice(1));
if (tokenParams.has("token")) {
  sessionStorage.setItem("lab-token", tokenParams.get("token")!);
  history.replaceState(null, "", location.pathname);
}
const FeedbackContext = React.createContext("");
const day = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Halifax",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const str = (f: FormData, k: string) => String(f.get(k) ?? "");
const split = (text: string) =>
  text
    .split(/[,，\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
function Tag({
  kind = "neutral",
  children,
}: {
  kind?: string;
  children: React.ReactNode;
}) {
  return <span className={"tag " + kind}>{children}</span>;
}
function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <DotHelper phase="entry" moving={false} />
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  useUiLanguage();
  const error = React.useContext(FeedbackContext);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog ref={ref} onCancel={close}>
      <header>
        <h2>{title}</h2>
        <div className="dialog-actions"><LanguageSwitch/><button className="icon" onClick={close} aria-label={t("common.close")}>
          <X size={20} />
        </button></div>
      </header>
      {error && (
        <div className="alert error" role="alert">
          {uiMessage(error)}
        </div>
      )}
      {children}
    </dialog>
  );
}
function Artifact({ hash }: { hash: string | null }) {
  useUiLanguage();
  const [view, setView] = useState<{
    url?: string;
    text?: string;
    error?: string;
  }>({});
  useEffect(() => {
    let dead = false,
      url = "";
    setView({});
    if (hash)
      fetch("/api/artifact?id=" + hash, { headers: auth() })
        .then(async (r) => {
          if (!r.ok) throw new Error(t("workspace.evidenceIntegrityCheckFailed"));
          const b = await r.blob();
          if (b.type.startsWith("image/")) {
            url = URL.createObjectURL(b);
            if (!dead) setView({ url });
          } else {
            const text = await b.text();
            if (!dead) setView({ text });
          }
        })
        .catch((e) => setView({ error: e.message }));
    return () => {
      dead = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [hash]);
  return !hash ? (
    <p className="muted">{t("workspace.noAttachment")}</p>
  ) : view.url ? (
    <img className="artifact" src={view.url} alt={t("workspace.originalSamplingEvidence")} />
  ) : view.text ? (
    <pre className="raw">{view.text}</pre>
  ) : (
    <p className="muted">{view.error ? uiMessage(view.error) : t("workspace.checkingEvidence")}</p>
  );
}
export function App() {
  const uiLocale = useUiLanguage();
  const [data, setData] = useState<State | null>(null),
    [setId, setSetId] = useState(localStorage.getItem("lab-set") ?? ""),
    [brandId, setBrandId] = useState(""),
    [page, setPage] = useState("gsc"),
    [homeSource,setHomeSource] = useState<"search"|"analytics">("search"),
    [gscInitialSection,setGscInitialSection] = useState<"overview"|"settings">("overview"),
    [gscSelectedProperty,setGscSelectedProperty] = useState(""),
    [gscSectionRequest,setGscSectionRequest] = useState<{section:"overview"|"settings";revision:number}>({section:"overview",revision:0}),
    [questionView,setQuestionView] = useState<'collect'|'review'>('collect'),
    [planAccountMode,setPlanAccountMode] = useState('signed_out'),
    [loginPlanPreset,setLoginPlanPreset] = useState<{promptSetId:string;label:string;config:Plan['config'];surfaces:Plan['config']['surfaces']}|null>(null),
    [loginSetupRequest,setLoginSetupRequest] = useState(0),
    [browserLoginReadiness,setBrowserLoginReadiness] = useState<ReturnType<BrowserJobs['loginReadiness']>>(),
    [planId, setPlanId] = useState(""),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [modal, setModal] = useState<string | null>(null),
    [samplingDraft, setSamplingDraft] = useState<SamplingDraft | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [refreshing,setRefreshing] = useState(false),
    [report, setReport] = useState<Report | null>(null),
    [reportLoading,setReportLoading] = useState(false),
    [qualityFilter,setQualityFilter] = useState("issues"),
    [historyRun, setHistoryRun] = useState<ReturnType<
      LabService["observations"]
    > | null>(null);
  const initialSelection = useRef(!setId),
    selectionRef = useRef(setId),
    reloadSequence = useRef(0);
  const pageHeading = useRef<HTMLHeadingElement>(null), firstPage = useRef(true);
  useEffect(()=>{if(firstPage.current){firstPage.current=false;return;}const heading=page==='gsc'?document.querySelector<HTMLElement>('.page-gsc .gsc-heading-copy h2,.page-gsc .empty h3'):pageHeading.current;if(heading){heading.setAttribute('tabindex','-1');heading.focus();}window.scrollTo({top:0});},[page]);
  useEffect(()=>{if(modal==='plan')setPlanAccountMode(loginPlanPreset?'isolated':'signed_out');},[modal,loginPlanPreset]);
  useEffect(()=>{if(modal!=='plan')setLoginPlanPreset(null);},[modal]);
  selectionRef.current = setId;
  useEffect(() => setError(""), [modal]);
  useEffect(() => setSamplingDraft(null), [selectedId]);
  async function reload(selection = setId) {
    const sequence = ++reloadSequence.current;
    const s = await request<State>(
      "state" + (selection ? "?set=" + encodeURIComponent(selection) : ""),
    );
    if (sequence === reloadSequence.current && selection === selectionRef.current) {setData(s);if(selection && !s.selectedSetId)selectSet("");}
    return s;
  }
  useConnectionAccessPolling(data?.settings?.access,()=>reload(),setId);
  useEffect(() => {
    reload().catch((e) => {
      setError(e.message);
      if (setId) {
        setSetId("");
        localStorage.removeItem("lab-set");
      }
    });
  }, [setId]);
  const brands = (data?.brands ?? []) as unknown as Brand[],
    sets = (data?.sets ?? []) as unknown as SetRow[];
  const connectionsReady=!data?.settings?.access || data.settings.access.status==='ready';
  const currentSet = sets.find((s) => s.id === setId),
    currentBrand =
      brands.find((b) => b.id === (currentSet?.brand_id ?? brandId)) ??
      brands[0];
  useEffect(() => {
    if (data && initialSelection.current) {
      initialSelection.current = false;
      if (!setId && sets.length) {
        setSetId(sets[0].id);
        localStorage.setItem("lab-set", sets[0].id);
      }
    }
  }, [data, setId]);
  useEffect(() => {
    if (!data?.apiJobs?.some((j) => j.status === "running") && !data?.browserJobs?.some(j=>j.status === "running" || j.status === "pausing" || j.finalizing)) return;
    const timer = setInterval(() => reload().catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, [data?.apiJobs?.some((j) => j.status === "running"), data?.browserJobs?.some(j=>j.status === "running" || j.status === "pausing" || j.finalizing), setId]);
  useEffect(() => {
    // macOS can throttle background window timers while a provider is in front.
    // Refresh when returning so a finished pause exposes Continue immediately.
    const refresh = () => { void reload().catch(() => {}); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [setId]);
  const currentPlan =
      data?.selectedSetId===setId ? (data.plans.find((p) => p.id === planId) ?? data.plans[0]) : undefined,
    slot = currentPlan?.slots.find((s) => s.id === selectedId) ?? null;
  const planSlots = currentPlan?.slots??[],
    qualitySlots = planSlots.filter(s=>s.latest||s.restriction?.action==='stop'),
    issueSlots = qualitySlots.filter(s=>s.restriction?.action==='stop'||s.latest&&!s.latest.quality.metricEligible),
    pendingCount = planSlots.filter(s=>!s.latest&&!s.continuation).length;
  const shownQuality = qualityFilter==='issues'?issueSlots:qualityFilter==='qualified'?qualitySlots.filter(s=>s.latest?.quality.contentQualified):qualitySlots;
  const loginReadinessPlanId=currentPlan?.id??'';
  const loginReadinessRevision=[
    ...(data?.browserJobs??[]).filter(job=>job.plan_id===loginReadinessPlanId).map(job=>[job.id,job.status,job.captured,job.attention,job.finalizing].join(':')),
    ...(data?.browserSessions??[]).filter(session=>session.planId===loginReadinessPlanId).map(session=>[session.surface,session.verified].join(':')),
    ...new Set(planSlots.filter(item=>item.restriction).map(item=>[item.surface,item.restriction!.action,item.restriction!.reason].join(':'))),
  ].join('|');
  const watchLoginReadiness=page==='workspace'||page==='lab'||!!data?.browserJobs.some(job=>['running','pausing'].includes(job.status)||job.finalizing);
  useEffect(()=>{
    if(!loginReadinessPlanId){setBrowserLoginReadiness(undefined);return;}
    if(!watchLoginReadiness)return;
    let live=true;
    request<ReturnType<BrowserJobs['loginReadiness']>>('browser-login-readiness?id='+loginReadinessPlanId)
      .then(value=>{if(live)setBrowserLoginReadiness(value);})
      .catch(()=>{if(live)setBrowserLoginReadiness(undefined);});
    return()=>{live=false;};
  },[loginReadinessPlanId,loginReadinessRevision,watchLoginReadiness]);
  const currentLoginReadiness=browserLoginReadiness?.planId===currentPlan?.id?browserLoginReadiness:undefined;
  const expiredPrivateLoginPlan=currentPlan?.config.accountMode==='signed_in_private'&&!!data?.browserJobs.some(job=>job.plan_id===currentPlan.id&&job.resume.expired>0);
  const loginAttentionCount=expiredPrivateLoginPlan?0:(currentLoginReadiness?.platforms.filter(platform=>platform.status!=='restricted'&&platform.required&&(!platform.confirmed||platform.restriction.active&&platform.restriction.type==='login')).length??0);
  function openPlatformLoginSetup(){setLoginSetupRequest(value=>value+1);setPage('workspace');}
  function createLoginPlan(){
    if(!currentPlan||!currentSet||data?.selectedSetId!==setId||currentPlan.prompt_set_id!==setId||currentSet.id!==setId)return;
    const required=currentLoginReadiness?.platforms.filter(platform=>platform.required&&(platform.needsNewPlan||currentPlan.config.accountMode!=='isolated'&&platform.restriction.active&&platform.restriction.type==='login')).map(platform=>platform.surface)??[];
    setLoginPlanPreset({promptSetId:setId,label:currentPlan.label.slice(0,140)+t("workspace.signedInSampling"),config:currentPlan.config,surfaces:required.length?required:currentPlan.config.surfaces});
    setModal('plan');
  }
  const facts:WorkflowFacts={brand:currentBrand?.name,set:currentSet?displayQuestionSetLabel(currentSet.label,uiLocale):undefined,questions:currentSet?.prompt_count??0,frozen:!!currentSet?.frozen_at,
    planned:planSlots.length,recorded:planSlots.filter(s=>!!s.latest).length,answers:planSlots.filter(s=>s.latest?.capture.status==='observed').length,
    checked:planSlots.filter(s=>s.latest?.quality).length,qualified:planSlots.filter(s=>s.latest?.quality.contentQualified).length,
    eligible:planSlots.filter(s=>s.latest?.quality.metricEligible).length,attention:issueSlots.length,
    transferred:planSlots.filter(s=>!!s.continuation).length,running:!!data?.browserJobs.some(j=>j.plan_id===currentPlan?.id&&['running','pausing'].includes(j.status))};
  const reportRevision=currentPlan?[currentPlan.id,...planSlots.map(s=>[s.id,s.latest?.hash,s.latest?.quality.assessmentHash,s.continuation?.slotId,s.restriction?.action].join(':'))].join('|'):'';
  useEffect(()=>{
    if(!currentPlan){setReport(null);setReportLoading(false);return;}
    let live=true;setReportLoading(true);
    request<Report>('report?id='+currentPlan.id).then(r=>{if(live)setReport(r);}).catch(e=>{if(live)setError(t("workspace.couldNotUpdateResultsMessage", { message: e.message }));}).finally(()=>{if(live)setReportLoading(false);});
    return()=>{live=false;};
  },[reportRevision]);
  function navigate(next:string){if(next==='gsc'){setHomeSource('search');setGscInitialSection('overview');setGscSectionRequest(old=>({section:'overview',revision:old.revision+1}));}setPage(next);setSelectedId(next==='evidence'?(issueSlots[0]?.id??qualitySlots[0]?.id??null):null);}
  function workflowAction(action:WorkflowAction){
    if(action==='brand'){navigate('brands');if(!currentBrand)setModal('brand');}
    else if(action==='questions'){setQuestionView('collect');navigate('questions');}
    else if(action==='freeze'){setQuestionView('review');navigate('questions');}
    else if(action==='plan'){navigate('workspace');setModal('plan');}
    else if(action==='sampling')navigate('workspace');
    else if(action==='quality')navigate('evidence');
    else navigate('reports');
  }
  function selectSet(id: string) {
    selectionRef.current=id;
    setSetId(id);
    localStorage.setItem("lab-set", id);
    setPlanId("");
    setSelectedId(null);
    setReport(null);
    setHistoryRun(null);
  }
  async function act(fn: () => Promise<unknown>, message?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
      if (message) setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("workspace.actionFailed"));
    } finally {
      setBusy(false);
    }
  }
  function unlockConnections() {void act(async()=>{try{await request('connections/unlock',{});}finally{refreshAccountStatus();}});}
  const geoPages=['workspace','questions','evidence'];
  const setupPages=['settings','brands','agents','lab','google'];
  const settingsActive=setupPages.includes(page)||page==='gsc'&&gscInitialSection==='settings';
  const nav = [
    { id: "gsc", label: t("simple.home"), icon: LayoutDashboard, active:page==='keyword-audit'||page==='gsc'&&gscInitialSection==='overview' },
    { id: "workspace", label: t("simple.aiVisibility"), icon: Search, active:geoPages.includes(page) },
    { id: "reports", label: t("simple.reports"), icon: FileText, active:page==='reports' },
  ];
  function openSearchSettings(){navigate('google');}
  function googleSelectionSaved(selection:GoogleSelection){if(selection.gscProperty)selectProperty(selection.gscProperty);setHomeSource(selection.gscProperty?'search':'analytics');setGscInitialSection('overview');setPage('gsc');}
  function selectProperty(property:string){
    const owner=brandForProperty(brands,property);
    setGscSelectedProperty(property);
    if(owner){try{localStorage.setItem('getaudit.search.property:'+owner.id,property);}catch{/* Keep this visit usable if preference storage is unavailable. */}}
    if(owner&&owner.id!==currentBrand?.id){setBrandId(owner.id);selectSet(sets.find(set=>set.brand_id===owner.id)?.id??'');}
    return owner;
  }
  function openKeywordAudit(property:string){
    const owner=selectProperty(property);
    if(owner){setPage('keyword-audit');return;}
    setNotice(t('simple.projectForProperty'));
    setPage('brands');
  }
  function PlanPicker() {
    return (
      <select
        className="plan-select"
        aria-label={t("workspace.samplingPlan")}
        value={currentPlan?.id ?? ""}
        onChange={(e) => {
          setPlanId(e.target.value);
          setSelectedId(null);
          setReport(null);
        }}
      >
        {data?.plans.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    );
  }
  async function download(format = "html") {
    if (!currentPlan) return;
    const r = await fetch(
      "/api/export?id=" +
        currentPlan.id +
        (format !== "html" ? "&format="+encodeURIComponent(format) : "") + '&uiLocale=' + uiLocale,
      {
        headers: auth(),
      },
    );
    if (!r.ok) throw new Error(t("workspace.reportExportFailed"));
    downloadBlob(format === "json" ? "geo-evidence-snapshot.json" : format === "md" ? "geo-results.md" : "geo-evidence-report.html", await r.blob());
    setNotice(t("workspace.resultsDownloadedWithQualityChecksAndSourceEvidence"));
  }
  function Matrix() {
    if (!currentPlan)
      return (
        <Empty
          title={t("workspace.makeRoomForYourFirstSamplingPlan")}
          body={t("workspace.freezeYourQuestionsThenChooseThePlatformsAndDatesEveryPlanned")}
          action={
            <button
              className="primary"
              disabled={!currentSet?.frozen_at}
              onClick={() => setModal("plan")}
            >
              <Plus size={16} />{t("workspace.newPlan")}</button>
          }
        />
      );
    const questions = Array.from(
      new Set(currentPlan.slots.map((s) => s.prompt_id)),
    );
    return (
      <>
        <div className="section-head">
          <div>
            
            <h2>{t("workspace.oneQuestionSeparateObservations")}</h2>
          </div>
          {PlanPicker()}
        </div>
        <div className="matrix-wrap">
          <table className="matrix" style={{minWidth:300+currentPlan.config.surfaces.length*165}} data-platforms={currentPlan.config.surfaces.length}>
            <thead>
              <tr>
                <th>{t("workspace.frozenQuestionDateWindow")}</th>
                {currentPlan.config.surfaces.map((s) => (
                  <th key={s}>
                    <span className={"surface-dot " + s} />
                    {names[s]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {currentPlan.config.windows.flatMap((w) =>
                [...new Set(currentPlan.slots.filter(s=>s.window===w).map(s=>s.run_idx))].sort((a,b)=>a-b).flatMap(runIdx=>questions.map((qid, index) => {
                  const first = currentPlan.slots.find(
                    (s) => s.prompt_id === qid,
                  )!;
                  return (
                    <tr key={w + qid + runIdx}>
                      <td><div className="matrix-question"><span className="row-id">
                          Q{String(index + 1).padStart(2, "0")}
                        </span><span className="question">
                          {first.prompt}
                          <small>{t("workspace.run", { date: w, runNumber: ((runIdx-1)%(currentPlan.config.repetitions??1))+1, runCount: currentPlan.config.repetitions??1 })}</small>
                        </span></div></td>
                      {currentPlan.config.surfaces.map((surface) => {
                        const s = currentPlan.slots.find(
                            (s) =>
                              s.prompt_id === qid &&
                              s.surface === surface &&
                              s.window === w && s.run_idx === runIdx,
                          );
                        if(!s)return <td key={surface}><span className="muted">{t("workspace.notNeededInThisRound")}</span></td>;
                        const a = s.latest;
                        const state = s.continuation ? "continued" : !a
                          ? "pending"
                          : !a.quality.contentQualified
                            ? "excluded"
                            : a.capture.status;
                        return (
                          <td key={surface}>
                            <button
                              className={
                                "sample-cell " +
                                state +
                                (selectedId === s.id ? " selected" : "")
                              }
                              onClick={() => {if(s.continuation){setPlanId(s.continuation.planId);setSelectedId(s.continuation.slotId);}else setSelectedId(s.id);}}
                            >
                              <span className="cell-title">
                                {state === "excluded" ? (
                                  <Circle size={13} />
                                ) : state === "observed" ? (
                                  <CheckCircle2 size={13} />
                                ) : state === "pending" ? (
                                  <Clock size={13} />
                                ) : (
                                  <AlertTriangle size={13} />
                                )}{" "}
                                {state === "excluded" ? uiMessage(a?.quality.label ?? "") : statusLabel(state)}
                              </span>
                              <small>
                                {s.continuation?t("workspace.viewContinuationResultsForWindow", { window: s.continuation.window }):a
                                  ? t("workspace.citationCountCitationsSequenceAttempts", { citationCount: a.capture.citations.length, sequence: a.sequence })
                                  : t("workspace.openTaskAndRecordEvidence")}{" "}
                                <ChevronRight size={12} />
                              </small>
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })),
              )}
            </tbody>
          </table>
        </div>
        <div className="matrix-footer">
          <LockKeyhole size={13} />
          <span>{t("workspace.questionSetFrozen")}{currentSet?.frozen_hash?.slice(0, 12)}</span><span>{currentPlan.config.accountMode==="signed_in_private"?t("workspace.platformTemporaryMode"):currentPlan.config.accountMode==="isolated"?t("workspace.separateIncognitoSession"):t("workspace.signedOutIncognito")}</span>
          <span>
            {currentPlan.config.country} / {currentPlan.config.locale} /{" "}
            {currentPlan.config.timezone}
          </span>
        </div>
      </>
    );
  }
  function Inspector() {
    if (!slot)
      return (
        <aside className="inspector idle">
          <div className="inspector-heading">
            
            <ShieldCheck size={18} />
          </div>
          <div className="idle-graphic">
            <div>
              <Search size={25} />
            </div>
            <span />
            <div>
              <Link2 size={23} />
            </div>
            <span />
            <div>
              <Check size={25} />
            </div>
          </div>
          <h3>{t("workspace.aLittleSpaceForYourFirstAnswer")}</h3>
          <p>{t("workspace.chooseASlotInTheMatrixToSeeItsOriginalText")}</p>
          <div className="quiet-note">{t("workspace.notTriggeredUnavailableAndExecutionErrorsAreAlsoResultsToKeep")}</div>
        </aside>
      );
    const a = slot.latest;
    return (
      <aside className="inspector">
        <div className="inspector-heading">
          
          <button
            className="icon"
            aria-label={t("workspace.collapseEvidence")}
            onClick={() => setSelectedId(null)}
          >
            <PanelRightClose size={19} />
          </button>
        </div>
        <Tag>{names[slot.surface]}</Tag>
        <h3>{slot.prompt}</h3>
        <p className="muted mono">
          {slot.window} · {slot.id.slice(0, 8)}
        </p>
        {slot.restriction?.action === "stop" && (
          <div className="warning">
            <strong>{t("workspace.samplingPaused")}</strong>
            <p>{slot.restriction.reason}</p>
            <button onClick={() => setModal("release")}>{t("workspace.recordAChangeInAccessConditions")}</button>
          </div>
        )}
        {data?.isolatedSampling && (!currentPlan?.config.accountMode||currentPlan.config.accountMode==="signed_out") && (
          <div className="sampling-tools">
            <button
              className="primary wide"
              disabled={busy || slot.restriction?.action === "stop"}
              onClick={() =>
                act(
                  () => request("open-sampling", { slotId: slot.id }),
                  t("workspace.separateTemporarySessionOpenedConfirmItIsSignedOutAndStop"),
                )
              }
            >{t("workspace.openIsolatedSamplingWindow")}</button>
            <button
              className="wide"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  setSamplingDraft(
                    await request<SamplingDraft>("capture-sampling", {
                      slotId: slot.id,
                    }),
                  );
                  setModal("capture");
                })
              }
            >{t("workspace.retrieveScreenshotAndRecord")}</button>
            <small>{t("workspace.closingTheWindowEndsTheSessionDoNotSignIntoA")}</small>
          </div>
        )}
        {!a ? (
          <>
            <p className="muted">
              {currentPlan?.config.accountMode!=="signed_out"&&currentPlan?.config.accountMode?t("workspace.forPlatformsThatNeedAnAccountPrepareADedicatedIncognitoLogin"):t("workspace.visitThePlatformInAFreshSignedOutSessionThenRecord")}
            </p>
            <div className="button-row">
              <button
                onClick={() =>
                  navigator.clipboard
                    .writeText(slot.prompt)
                    .then(() => setNotice(t("workspace.frozenQuestionCopied")))
                }
              >
                <Copy size={15} />{t("workspace.copyQuestion")}</button>
              <a
                className="button"
                href={['google_aio','duckduckgo_search_assist'].includes(slot.surface)?surfaceRegistry[slot.surface].url+'?q='+encodeURIComponent(slot.prompt):surfaceRegistry[slot.surface].url}
                target="_blank"
                rel="noreferrer"
              >{t("workspace.openPlatform")}<ArrowUpRight size={14} />
              </a>
            </div>
            <button
              className="primary wide"
              onClick={() => setModal("capture")}
              disabled={slot.restriction?.action === "stop"}
            >
              <Upload size={16} />{t("workspace.recordSamplingEvidence")}</button>
          </>
        ) : (
          <>
            <div className="evidence-status">
              <Tag kind={a.integrity ? "good" : "bad"}>
                {a.integrity ? t("workspace.fileHashMatches") : t("workspace.integrityFailed")}
              </Tag>
              <Tag kind={a.quality.contentQualified ? "good" : "warn"}>{uiMessage(a.quality.label)}</Tag>
            </div>
            <div className="quality-assessment"><strong>{a.quality.metricEligible?t("workspace.eligibleForConditionMatchedMetrics"):a.quality.contentQualified?t("workspace.textCanBeExportedExcludedFromConditionMatchedMetrics"):t("workspace.automaticallyExcluded")} </strong><p>{a.quality.reasons.map(uiMessage).join(t("workspace.messageContext2"))||t("workspace.textSourcesAndSamplingConditionsPassedTheChecks")}</p><small>{a.quality.evaluatorVersion} · {a.quality.assessmentHash.slice(0,12)}</small></div>
            <dl className="facts">
              <div>
                <dt>{t("workspace.result")}</dt>
                <dd>{statusLabel(a.capture.status)}</dd>
              </div>
              <div>
                <dt>{t("workspace.observedAt")}</dt>
                <dd>{new Date(a.capture.observedAt).toLocaleString(uiLocale)}</dd>
              </div>
              <div>
                <dt>{t("workspace.collectionMethod")}</dt>
                <dd>
                  {a.capture.collectionMode === "fixture"
                    ? t("workspace.syntheticDemo")
                    : a.capture.collectionMode === "browser_capture" ? t("workspace.automatedChromeSampling") : t("workspace.manualSampling")}
                </dd>
              </div>
              <div>
                <dt>{t("workspace.model")}</dt>
                <dd>
                  {a.capture.model === "unknown"
                    ? t("workspace.notShownUnknown")
                    : a.capture.model}
                </dd>
              </div>
            </dl>
            {a.capture.browser && <p className="muted">Chrome {a.capture.browser.version} · {a.capture.browser.extractorVersion}<br/>{a.capture.browser.notes.join("；")}</p>}
            {slot.issues.length > 0 && (
              <div className="warning">
                <strong>{t("workspace.conditionNotes")}</strong>
                <p>{slot.issues.map(uiMessage).join(t("workspace.messageContext2"))}</p>
              </div>
            )}
            {a.capture.reason && <p>{a.capture.reason}</p>}
            {a.capture.answer && (
              <section>
                <h4>{t("workspace.originalAnswer")}</h4>
                <pre className="answer">{a.capture.answer}</pre>
              </section>
            )}
            <section>
              <h4>{t("workspace.citations", { count: a.capture.citations.length })}</h4>
              {a.capture.citations.map((c, i) => (
                <a
                  className="citation"
                  key={i}
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Link2 size={14} />
                  <span>
                    {c.title ?? c.url}
                    <small>{new URL(c.url).hostname}</small>
                  </span>
                  <ArrowUpRight size={13} />
                </a>
              ))}
            </section>
            <details>
              <summary>{t("workspace.viewOriginalAttachment")}</summary>
              <Artifact hash={a.capture.artifactHash} />
            </details>
            <details>
              <summary>{t("workspace.allAttempts", { count: slot.attempts.length })}</summary>
              {slot.attempts.map((attempt) => (
                <div className="attempt" key={attempt.id}>{t("workspace.attempt", { sequence: attempt.sequence, status: statusLabel(attempt.capture.status) })}
                  <small>
                    {attempt.capture.observedAt} · {uiMessage(attempt.quality.label)}
                  </small>
                  <p>{attempt.capture.reason}</p>
                  <Artifact hash={attempt.capture.artifactHash} />
                </div>
              ))}
            </details>
            <details className="optional-review"><summary>{t("workspace.optionalManualNotesOrExclusion")}</summary><p className="muted">{t("workspace.useThisForYourOwnInvestigationItDoesNotAffectNormal")}</p>{a.review ? (
              <>
                <p className="review-note">{t("workspace.reviewNote")}{a.review.note}</p>
                {(a.review.decision === "reject" ||
                  ["error", "unavailable"].includes(a.capture.status)) && (
                  <button
                    className="primary wide"
                    disabled={slot.restriction?.action === "stop"}
                    onClick={() => setModal("capture")}
                  >{t("workspace.recordAnotherAttempt")}</button>
                )}
              </>
            ) : (
              <button
                className="primary wide"
                onClick={() => setModal("review")}
              >
                <ShieldCheck size={16} />{t("workspace.addManualJudgment")}</button>
            )}</details>
          </>
        )}
      </aside>
    );
  }
  const titles: Record<string, [string, string]> = {
    settings: [t("simple.settings"),t("simple.settingsHint")],
    google: [t("google.navigation"),t("google.settingsHint")],
    agents: [t("agent.navigation"),t("agent.description")],
    'keyword-audit': [t("workspace.keywordOpportunities"), t("workspace.startWithQueriesRanking1120CompareTheTopThreeCompeting")],
    gsc: [t(gscInitialSection==='settings'?"simple.searchConnection":"simple.home"), t("simple.homeHint")],
    workspace: [t("simple.aiVisibility"), t("simple.aiVisibilityHint")],
    brands: [t("workspace.brandsProjects"), t("workspace.brandsWebsitesAndQuestionSetsShareOneLocalLedger")],
    questions: [t("workspace.questionLibrary"), t("workspace.chooseWhatToAskThenFreezeTheScopeForReproducibleSampling")],
    evidence: [t("workspace.automaticQualityChecksExceptions"), t("workspace.theProgramChecksQualityValidAnswersAreAvailableAutomaticallyExceptionsKeep")],
    reports: [t("workspace.reportsExports"), t("workspace.resultsAreGeneratedAfterCollectionExploreAnswersAndSourcesOrDownload")],
    lab: [t("workspace.connectionsLab"), t("workspace.configureCollectionConnectionsAndCheckThePrerequisitesForFormalExperiments")],
  };
  return (
    <FeedbackContext.Provider value={error}>
      <div className="app audit-app" data-page={page} onInvalidCapture={event=>{
        let parent=(event.target as HTMLElement).parentElement;
        while(parent){if(parent.tagName==='DETAILS')(parent as HTMLDetailsElement).open=true;parent=parent.parentElement;}
      }}>
        <aside className="sidebar research-sidebar">
          <div className="wordmark" aria-label="getaudit.si">
            <span className="brand-mark brand-dot" aria-hidden="true">
              <span className="brand-dot-eye" />
              <span className="brand-dot-eye" />
            </span>
            <div className="wordmark-copy">
              <span className="wordmark-name">getaudit<span className="wordmark-domain">.si</span></span>
              <small>{t("workspace.researchDesk")}</small>
            </div>
          </div>
          <div className="project-switch">
            <span className="project-avatar">
              {currentBrand?.name?.[0] ?? "a"}
            </span>
            <select
              aria-label={t("workspace.currentBrand")}
              value={currentBrand?.id ?? ""}
              onChange={(e) => {
                setGscSelectedProperty("");
                setBrandId(e.target.value);
                selectSet(
                  sets.find((s) => s.brand_id === e.target.value)?.id ?? "",
                );
              }}
            >
              {brands.map((b) => (
                <option value={b.id} key={b.id}>
                  {b.name}
                </option>
              ))}
              {!brands.length && <option>{t("workspace.noBrandsYet")}</option>}
            </select>
          </div>
          <nav className="daily-navigation" aria-label={t("workspace.workspaceNavigation")}>
            {nav.map(n => <button key={n.id} data-nav={n.id} className={n.active?'active':''} aria-current={n.active?'page':undefined} onClick={()=>navigate(n.id)}>
              <span className="nav-icon" aria-hidden="true"><n.icon size={18}/></span><span className="nav-label">{n.label}</span>
            </button>)}
          </nav>
          <button data-nav="settings" className={'sidebar-settings'+(settingsActive?' active':'')} aria-current={settingsActive?'page':undefined} onClick={()=>navigate('settings')}><Settings2 size={18}/><span>{t("simple.settings")}</span></button>
          <div className="sidebar-bottom">
            <p className="sidebar-signoff">{t("shell.brandTagline")}</p>
            <div className="local-status">
              <span />{t("workspace.localLedger")}</div>
            <p>{t("workspace.evidenceStaysOnYourDevice")}</p>
            <small className="app-version">getaudit · 0.4.22</small>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumb"><strong>{titles[page][0]}</strong>
            </div>
            <div className="topbar-right">
              <LanguageSwitch/>
              <AccountChip onConnections={()=>navigate('google')}/>
              {data?.demo && <Tag kind="warn">{t("workspace.syntheticDemo")}</Tag>}
              <span className="private">
                <LockKeyhole size={13} />{t("workspace.privateWorkspace")}</span>
              <button
                className={'icon'+(refreshing?' is-busy':'')}
                aria-label={t("workspace.refreshData")}
                aria-busy={refreshing}
                disabled={busy}
                onClick={() => {setRefreshing(true);void act(() => reload()).finally(()=>setRefreshing(false));}}
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </header>
          <main key={page} className={"page-view page-"+page}>
            <div className={"page-head"+(['gsc','google'].includes(page)?' home-heading':'')}>
              <div className="page-heading-copy">
                <p className="page-location">{currentBrand?.name??'getaudit'}</p>
                <div className="page-title-row"><h1 ref={pageHeading} tabIndex={-1}>{titles[page][0]}</h1></div>
                <p>{titles[page][1]}</p>
              </div>
              {!['gsc','google','lab','agents','settings','keyword-audit'].includes(page)&&<div className="page-actions">
                {sets.length > 0 && (
                  <select
                    aria-label={t("workspace.currentQuestionSet")}
                    title={currentSet?.label}
                    value={setId}
                    onChange={(e) => selectSet(e.target.value)}
                  >
                    {sets
                      .filter((s) => s.brand_id === currentBrand?.id)
                      .map((s) => (
                        <option value={s.id} key={s.id} title={s.label}>
                          {displayQuestionSetLabel(s.label,uiLocale)}
                        </option>
                      ))}
                  </select>
                )}
                {['brands','questions'].includes(page)&&<button
                  className={page==='brands'||!currentSet?'primary':''}
                  onClick={() =>
                    setModal(
                      page === "brands"
                        ? "brand"
                        : page === "questions"
                          ? "set"
                          : "plan",
                    )
                  }
                  disabled={
                    page !== "brands" &&
                    page !== "questions" &&
                    !currentSet?.frozen_at || page==='questions'&&!currentBrand
                  }
                >
                  <Plus size={16} />
                  {page === "brands"
                    ? t("workspace.newBrand")
                    : page === "questions"
                      ? t("workspace.newQuestionSet")
                      : t("workspace.newSamplingPlan")}
                </button>}
              </div>}
            </div>
            {page==='gsc'&&currentBrand&&<nav className="home-data-switch" aria-label={t('google.openData')}><button aria-pressed={homeSource==='search'} onClick={()=>setHomeSource('search')}>{t('google.homeSearch')}</button><button aria-pressed={homeSource==='analytics'} onClick={()=>setHomeSource('analytics')}>{t('google.homeAnalytics')}</button></nav>}
            <ConnectionAccessNotice access={data?.settings?.access} busy={busy} onUnlock={unlockConnections}/>
            {['questions','evidence'].includes(page)&&loginAttentionCount>0&&<div className="alert warning" role="alert"><AlertTriangle size={17}/><span>{t("workspace.aIPlatformsNeedLoginSetup", { count: loginAttentionCount })}</span><button onClick={openPlatformLoginSetup}>{t("workspace.goToPlatformLoginSetup")}</button></div>}
            {error && (
              <div className="alert error" role="alert">
                <AlertTriangle size={17} />
                <span>{uiMessage(error)}</span>
                <button
                  className="icon"
                  aria-label={t("workspace.dismissError")}
                  onClick={() => setError("")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {notice && (
              <div className="alert success" role="status">
                <Check size={17} />
                <span>{uiMessage(notice)}</span>
                <button
                  className="icon"
                  aria-label={t("workspace.dismissNotice")}
                  onClick={() => setNotice("")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {!data ? (
              <LoadingHelper phase="entry" active={!error} title={error ? t("workspace.workspaceCouldNotBeOpened") : t("workspace.openingYourWorkspace")} detail={error ? uiMessage(error) : t("workspace.readingLocalProjectsAndObservationProgress")} />
            ) : (
              <>
                {geoPages.includes(page)&&<nav className="context-navigation" aria-label={t('simple.aiSections')}>{[['workspace','simple.overview'],['questions','simple.questions'],['evidence','simple.evidence']].map(([id,key])=><button key={id} data-nav={id} aria-current={page===id?'page':undefined} onClick={()=>navigate(id!)}>{t(key as 'simple.overview'|'simple.questions'|'simple.evidence')}</button>)}</nav>}
                {['brands','agents','lab','keyword-audit','google'].includes(page)&&<div className="context-navigation"><button className="context-back" data-nav={page==='keyword-audit'?'gsc':'settings'} onClick={()=>navigate(page==='keyword-audit'?'gsc':'settings')}><ArrowLeft size={14}/>{t(page==='keyword-audit'?'simple.home':'simple.settings')}</button></div>}
                {(page==='questions'||page==='workspace'&&!currentPlan)&&<WorkflowGuide facts={facts} page={page} onNavigate={next=>{if(next==='questions')setQuestionView(currentSet?'review':'collect');navigate(next);}} onAction={workflowAction}/>}
                {(page === "workspace" || page === "evidence") && (
                  <>
                    {page==='workspace'&&currentPlan&&<div className="work-strip">
                      <div>
                        <span className="strip-icon">
                          <ListChecks size={18} />
                        </span>
                        <strong>{data.prompts.length}</strong>
                        <span>{currentSet?.frozen_at?t("workspace.frozenQuestions"):t("workspace.questionsToReview")}</span>
                      </div>
                      <div>
                        <span className="strip-icon amber">
                          <Clock size={18} />
                        </span>
                        <strong>{pendingCount}</strong>
                        <span>{t("workspace.slotsWithNoRecordYet")}</span>
                      </div>
                      <button onClick={() => navigate("reports")}>
                        <span className="strip-icon cyan">
                          <ShieldCheck size={18} />
                        </span>
                        <strong>{facts.qualified}</strong>
                        <span>{t("workspace.exportableAnswersAutomaticallyChecked")}</span>
                        <ChevronRight size={16} />
                      </button>
                    </div>}
                    {page==='workspace'&&currentPlan&&<BrowserPanel onCreatePlan={()=>setModal('plan')} selectPlan={setPlanId} plan={currentPlan} jobs={data.browserJobs??[]} sessions={data.browserSessions??[]} loginReadiness={currentLoginReadiness} loginSetupRequest={loginSetupRequest} onCreateLoginPlan={createLoginPlan} availability={data.browserAvailability??{available:false,message:t("workspace.browserCollectorIsNotConnected")}} reload={()=>reload()} select={id=>{setSelectedId(id);setPage("evidence");}}/>}
                    {page==='evidence'&&<div className="review-layout"><section className="panel review-queue" aria-label={t("workspace.automaticQualityRecords")}><div className="section-head"><div><h2>{t("workspace.automaticallyChecked", { count: facts.checked })}</h2><p className="muted">{currentPlan?.label??t("workspace.createASamplingPlanFirst")}{t("workspace.resultsAreReadyWithoutAcceptanceUseThisViewForExceptionsAnd")}</p></div>{currentPlan&&PlanPicker()}</div><div className="quality-filters"><button aria-pressed={qualityFilter==='issues'} onClick={()=>setQualityFilter('issues')}>{t("workspace.exceptionsConditionNotes")}{issueSlots.length}</button><button aria-pressed={qualityFilter==='qualified'} onClick={()=>setQualityFilter('qualified')}>{t("workspace.exportable")}{facts.qualified}</button><button aria-pressed={qualityFilter==='all'} onClick={()=>setQualityFilter('all')}>{t("workspace.allRecords")}</button></div>{shownQuality.length?<><div className="review-queue-list">{shownQuality.slice(0,30).map(s=><button key={s.id} title={s.prompt} className={selectedId===s.id?'selected':''} onClick={()=>setSelectedId(s.id)}><span><strong>{s.prompt}</strong><small>{names[s.surface]} · {s.window} · {s.latest?.quality.label?uiMessage(s.latest.quality.label):t("workspace.platformRestrictedNotSubmitted")}</small></span><ChevronRight size={15}/></button>)}</div>{shownQuality.length>30&&<p className="queue-more">{t("workspace.showingTheFirst30RecordsTheMatrixBelowKeepsEverySlot")}</p>}</>:<Empty title={facts.recorded?t("workspace.noExceptionsInThisView"):t("workspace.noSamplingRecordsYet")} body={facts.recorded?t("workspace.resultsAreGeneratedAutomaticallyAndCanBeViewedOrDownloaded"):t("workspace.savedCapturesAreCheckedAutomaticallyManualReviewIsNotRequired")} action={<button onClick={()=>navigate(facts.recorded?'reports':'workspace')}>{facts.recorded?t("workspace.viewResults"):t("workspace.goToSampling")}</button>}/>}</section>{Inspector()}</div>}
                    {page==='workspace'&&<details className="advanced-section"><summary>{t("workspace.questionProgressManualRecords")}<small>{t("workspace.seeEverySlotOrAddEvidenceForOneQuestion")}</small></summary><div><div className="work-layout">
                      <section className="panel matrix-panel">
                        {Matrix()}
                      </section>
                      {Inspector()}
                    </div></div></details>}
                    {page==='evidence'&&<details className="advanced-section"><summary>{t("workspace.allSlotsQualityRecords")}<small>{t("workspace.seeEachPlatformSStatusAndHistoryQuestionByQuestion")}</small></summary><div><section className="panel matrix-panel">{Matrix()}</section></div></details>}
                    {currentPlan && <details className="advanced-section"><summary>{t("workspace.sourceWebsitesCitations")}<small>{t("workspace.exploreLinksActuallyShownOnTheSampledPages")}</small></summary><div><SourcesPanel plan={currentPlan}/></div></details>}
                    <details className="advanced-section"><summary>{t("workspace.aPIBaselinePastRuns")}<small>{t("workspace.openForModelAPIsOrLegacyLabHistory")}</small></summary><div>
                    <ApiPanel
                      data={data}
                      busy={busy}
                      launch={() => setModal("api")}
                      control={(id, action) =>
                        act(() => request("api-control", { id, action }))
                      }
                    />
                    <section className="panel history">
                      <div className="section-head">
                        <div>
                          
                          <h2>{t("workspace.legacyLabCollectionRuns")}</h2>
                        </div>
                        <span className="muted">{t("workspace.runs", { count: data.runs.length })}</span>
                      </div>
                      {data.runs.length ? (
                        <div className="run-list">
                          {data.runs.map((r) => (
                            <button
                              key={r.id}
                              onClick={() =>
                                act(async () => {
                                  setHistoryRun(
                                    await request("run?id=" + r.id),
                                  );
                                  setModal("history");
                                })
                              }
                            >
                              <span className="run-icon">
                                <Layers size={17} />
                              </span>
                              <span>
                                <strong>{r.id.slice(0, 8)}</strong>
                                <small>
                                  {r.phase} · {r.started_at}
                                </small>
                              </span>
                              <span>{r.observations}{t("workspace.observations")}</span>
                              <Tag>{r.finished_at ? t("workspace.sealed") : t("workspace.notSealed")}</Tag>
                              <ChevronRight size={16} />
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="inset muted">{t("workspace.importedAPIOrWebEvidenceKeepsItsOriginalRunIdentityHere")}</p>
                      )}
                    </section></div></details>
                  </>
                )}
                {page === 'settings' && <WorkspaceSettings projectCount={brands.length} onNavigate={navigate} onConnections={()=>setModal('settings')} onSearchSetup={openSearchSettings}/>}
                {page==='google'&&<GoogleConnectionPanel brandId={currentBrand?.id} onSelectionChange={googleSelectionSaved}/>}
                {page==='gsc'&&currentBrand&&homeSource==='analytics'&&<Ga4Panel brandId={currentBrand.id} onConnections={()=>navigate('google')}/>}
                {page === "brands" && <BrandsPanel brands={data.brands} deletedBrands={data.deletedBrands??[]} onCreate={()=>setModal("brand")} onChanged={async(id,action)=>{
                  if(action==="delete"&&currentBrand?.id===id){
                    setGscSelectedProperty("");
                    const nextBrand=brands.find(b=>b.id!==id);setBrandId(nextBrand?.id??"");
                    const nextSet=sets.find(s=>s.brand_id===nextBrand?.id)?.id??"";selectSet(nextSet);await reload(nextSet);
                  }else await reload();
                  setNotice(action==="edit"?t("workspace.brandUpdatedExistingPlansKeepTheirOriginalDefinition"):action==="delete"?t("workspace.projectMovedToDeletedProjectsAndCanBeRestored"):t("workspace.projectRestored"));
                }}/>}
                {page === 'agents' && <AgentPanel brands={brands} currentBrandId={currentBrand?.id} onGsc={()=>navigate('gsc')} onConnections={()=>navigate('google')}/>}
                {page === "gsc" && homeSource==='search' && (!currentBrand ? <Empty title={t('simple.welcome')} body={t('simple.welcomeHint')} action={<button className="primary" onClick={()=>setModal('brand')}><Plus size={16}/>{t('simple.addWebsite')}</button>}/> : <GscPanel key={currentBrand?.id??'none'} initialSection={gscInitialSection} sectionRequest={gscSectionRequest} onSectionChange={section=>setGscInitialSection(section==='settings'?'settings':'overview')} onPropertyChange={selectProperty} preferredProperty={gscSelectedProperty||preferredBrandProperty(currentBrand)} brands={brands} connectionsReady={connectionsReady} onAudit={openKeywordAudit} onConnections={()=>navigate('google')} onCandidates={(brandId,setId)=>{setBrandId(brandId);selectSet(setId);setQuestionView('review');setPage("questions");void reload(setId);}}/>)}
                {page === 'keyword-audit' && (currentBrand ? <KeywordAuditPanel key={currentBrand.id} brandId={currentBrand.id} brand={currentBrand} connectionsReady={connectionsReady} onGsc={()=>setPage('gsc')} onConnections={()=>setModal('settings')} /> : <Empty title={t("workspace.addABrandAndWebsiteFirst")} body={t("workspace.afterYouSelectABrandItsGSCDataAndOwnedPages")} action={<button className="primary" onClick={()=>setModal('brand')}>{t("workspace.createBrand")}</button>} />)}
                {page === "questions" && (
                  <><div className="question-tabs" role="group" aria-label={t("workspace.questionPreparationSteps")}><button aria-pressed={questionView==='collect'} onClick={()=>setQuestionView('collect')}>{t("workspace.collectCandidatesStep")}</button><button aria-pressed={questionView==='review'} onClick={()=>setQuestionView('review')}>{t("workspace.reviewAndFreezeStep")}{currentSet?t("workspace.promptCountQuestions", { prompt_count: currentSet.prompt_count }):''}</button></div>
                  <div hidden={questionView!=='collect'} className="question-view" key={'collect-'+currentBrand?.id}><p className="stage-note">{t("workspace.selectTheQuestionsYouWantToSampleThenChoose")}<strong>{t("workspace.createQuestionSet")}</strong>{t("workspace.reviewAndFreezingComeNext")}</p><LocalQuestionsPanel brands={brands} initialBrandId={currentBrand?.id} onCreated={async(brandId,setId)=>{setBrandId(brandId);selectSet(setId);await reload(setId);setQuestionView('review');setNotice(t("workspace.questionSetCreatedCheckEachQuestionAndSourceThenFreezeThe"));window.scrollTo({top:0});}}/></div>
                  <div hidden={questionView!=='review'} className="question-view"><section className="panel">
                    <div className="section-head">
                      <div>
                        <h2 title={currentSet?.label}>{currentSet ? displayQuestionSetLabel(currentSet.label,uiLocale) : t("workspace.noQuestionSetYet")}</h2>
                        <p className="muted">
                          {currentSet?.frozen_at
                            ? t("workspace.frozenCreateANewVersionToAddQuestions")
                            : t("workspace.reviewEveryQuestionAndFreezeTheSetBeforeCreatingASampling")}
                        </p>
                      </div>
                      {currentSet &&
                        (currentSet.frozen_at ? (
                          <Tag kind="good">
                            <LockKeyhole size={12} />{t("workspace.frozen")}</Tag>
                        ) : (
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() =>
                              act(
                                () => request("freeze", { setId }),
                                t("workspace.questionSetFrozenContext2"),
                              )
                            }
                          >{t("workspace.freezeQuestionSet")}</button>
                        ))}
                    </div>
                    <div className="question-review-table"><table className="plain-table">
                      <thead>
                        <tr>
                          <th>{t("common.question")}</th>
                          <th>{t("workspace.intent")}</th>
                          <th>{t("workspace.language")}</th>
                          <th>{t("common.source")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.prompts.map((p) => (
                          <tr key={String(p.id)}>
                            <td>{String(p.text)}</td>
                            <td>
                              {p.intent === "branded" ? t("workspace.branded") : t("workspace.discovery")}
                            </td>
                            <td>{String(p.locale)}</td>
                            <td>
                              <small>
                                {String(p.source ?? t("workspace.historicalRecordUnspecified"))}
                              </small>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table></div>
                    {currentSet&&<div className="stage-actions">{currentSet.frozen_at?<><CheckCircle2 size={17}/><span>{t("workspace.scopeIsFixedChoosePlatformsAndSamplingConditionsNext")}</span><button className="primary" onClick={()=>workflowAction('plan')}>{t("workspace.createSamplingPlan")}<ChevronRight size={16}/></button></>:<p className="muted">{t("workspace.checkTheQuestionTextLanguageAndSourcesThenChooseFreezeQuestion")}</p>}</div>}
                    {!data.prompts.length && (
                      <Empty
                        title={t("workspace.bringYourBuyerQuestions")}
                        body={t("workspace.useOneNaturalLanguageQuestionPerLineAndRecordItsSource")}
                        action={
                          <button
                            onClick={() => setModal("set")}
                            disabled={!currentBrand}
                          >{t("workspace.newQuestionSet")}</button>
                        }
                      />
                    )}
                  </section></div></>
                )}
                {page === "reports" && (
                  <section className="panel">
                    <div className="section-head">
                      <div>
                        <h2>{t("workspace.automaticResultsReport")}</h2>
                        <p className="muted">{t("workspace.generatedAfterCollectionAutomaticScreeningAndConditionMatchedMetricsAreShown")}</p>
                      </div>
                      <div className="button-row">
                        {PlanPicker()}
                        <button
                          className="primary"
                          disabled={!currentPlan || busy || reportLoading}
                          onClick={() =>
                            act(async () => {
                              setReportLoading(true);
                              try { setReport(await request("report?id=" + currentPlan!.id)); }
                              finally { setReportLoading(false); }
                            })
                          }
                        >{t("workspace.refreshResults")}</button>
                      </div>
                    </div>
                    {reportLoading && <LoadingHelper phase="records" active title={t("workspace.refreshingYourResults")} detail={t("workspace.readingSavedEvidenceAndQualityChecks")} compact/>}
                    {report ? (
                      <>
                        <div className="report-note">
                          <ShieldCheck size={20} />
                          <p>{uiMessage(report.scope)}</p>
                        </div>
                        <div className="automatic-result-summary" aria-live="polite" aria-busy={reportLoading}><strong>{reportLoading?t("workspace.updatingAutomaticResults"):t("workspace.resultsGeneratedAutomatically")}</strong><p>{t("workspace.valueCheckedValue2ExportableAnswersValue3WithoutAValidAnswerValue4", { value: report.groups.reduce((n,g)=>n+g.autoChecked,0), value2: report.groups.reduce((n,g)=>n+g.contentQualified,0), value3: report.groups.reduce((n,g)=>n+g.autoChecked-g.contentQualified,0), value4: report.groups.reduce((n,g)=>n+g.pending,0) })}</p><button className="primary" disabled={busy||!facts.recorded} onClick={()=>void act(()=>download('md'))}><Download size={16}/>{t("workspace.downloadResultsMD")}</button></div>
                        <div className="matrix-wrap"><table className="plain-table automatic-result-table"><thead><tr><th>{t("workspace.platform")}</th><th>{t("workspace.readableSamples")}</th><th>{t("workspace.brandMentionsAutomaticScreening")}</th><th>{t("workspace.ownedSiteCitationsAutomaticScreening")}</th><th>{t("workspace.textSourceExclusions")}</th><th>{t("workspace.restrictedErrors")}</th></tr></thead><tbody>{report.groups.map(g=><tr key={g.surface}><td>{g.label}</td><td>{g.candidateDenominator}</td><td>{g.candidateBrandMentions} / {g.candidateDenominator}</td><td>{g.candidateOwnedCitations} / {g.candidateDenominator}</td><td>{g.contentExcluded}</td><td>{g.unavailable} / {g.errors}</td></tr>)}</tbody></table></div><p className="result-method-note">{t("workspace.theseResultsDescribeReadableSamplesInThisRunNotMarketUser")}</p>
                        <details className="advanced-section"><summary>{t("workspace.conditionMatchedMetricsCoverage")}<small>{t("workspace.samplesMatchingAllPlannedConditionsIncludingRegionAccountLanguageDateAnd")}</small></summary><div>
                        <div className="matrix-wrap">
                          <table className="plain-table">
                            <thead>
                              <tr>
                                <th>{t("workspace.platform")}</th>
                                <th>{t("workspace.planned")}</th>
                                <th>{t("workspace.completeAnswer")}</th>
                                <th>{t("workspace.conditionMatched")}</th>
                                <th>{t("workspace.brandMentions")}</th>
                                <th>{t("workspace.ownedCitations")}</th>
                                <th>{t("workspace.notTriggered")}</th>
                                <th>{t("workspace.restrictedErrors")}</th>
                                <th>{t("workspace.pending")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {report.groups.map((g) => (
                                <tr key={g.surface}>
                                  <td>{g.label}</td>
                                  <td>{g.planned}</td>
                                  <td>{g.observed}</td>
                                  <td>{g.eligible}</td>
                                  <td>
                                    {g.brandMentions} / {g.eligible}
                                  </td>
                                  <td>
                                    {g.ownedCitations} / {g.eligible}
                                  </td>
                                  <td>{g.notTriggered}</td>
                                  <td>
                                    {g.unavailable} / {g.errors}
                                  </td>
                                  <td>{g.pending}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        </div></details><details className="advanced-section"><summary>{t("workspace.resultsTextSourcesByQuestion")}<small>{t("workspace.everySlotIsKeptExcludedRecordsIncludeReasons")}</small></summary><div>
                        <div className="report-evidence">
                          {report.records.map((r) => (
                            <button
                              key={r.slotId}
                              onClick={() => {
                                setPage("evidence");
                                setSelectedId(r.slotId);
                              }}
                            >
                              <span>{r.prompt}</span>
                              <Tag>{statusLabel(r.status)}</Tag>
                              <small>{r.quality?.label?uiMessage(r.quality.label):t("workspace.notSampledYet")} · {r.exclusionReasons.map(uiMessage).join(t("workspace.messageContext2"))}</small>
                              <ChevronRight size={16} />
                            </button>
                          ))}
                        </div>
                        </div></details>
                        <details className="advanced-section"><summary>{t("workspace.optionalAIInterpretationDraft")}<small>{t("workspace.additionalModelCallsRequireConfirmationOfTheSendingScopeAndBudget")}</small></summary><div><AiPanel
                          planId={currentPlan!.id}
                          openEvidence={(id) => {
                            setPage("evidence");
                            setSelectedId(id);
                          }}
                        /></div></details>
                        <div className="export-bar">
                          <div>
                            <strong>{t("workspace.privateLocalExport")}</strong>
                            <p>{t("workspace.completeAnswersWithClearSourceExtractionAreExportedAutomaticallyWithCitations")}</p>
                          </div>
                          <button
                            className="primary"
                            disabled={busy}
                            onClick={() => act(() => download())}
                          >
                            <Download size={16} />{t("workspace.exportHTMLReport")}</button>
                          <button
                            disabled={busy}
                            onClick={() => act(() => download("json"))}
                          >{t("workspace.exportJSONSnapshot")}</button>
                        </div>
                      </>
                    ) : (
                      <Empty title={reportLoading?t("workspace.generatingResults"):t("workspace.createASamplingPlanFirst")} body={t("workspace.savedRecordsAreCheckedAndReportedAutomaticallyItemByItemAcceptance")}/>
                    )}
                  </section>
                )}
                {page === "lab" && (
                  <>
                    <section className="panel">
                      <div className="section-head"><div><h2>{t("workspace.aIPlatformWebLogin")}</h2><p className="muted">{t("workspace.openASeparatePlatformLoginWindowForTheCurrentPlanThen")}</p></div>
                        <button className="primary" disabled={!currentPlan} onClick={openPlatformLoginSetup}>{t("workspace.setUpPlatformLogin")}{loginAttentionCount>0?t("workspace.loginAttentionCountToSetUp", { loginAttentionCount }):''}</button>
                      </div>
                      <p className="muted panel-note">{currentPlan?t("workspace.currentPlanLabelLoginSetupPauseAndContinuationAreOnThe", { label: currentPlan.label }):t("workspace.selectAFrozenQuestionSetAndCreateAPlanFirstPlatform")}</p>
                    </section>
                    <section className="panel">
                      <div className="section-head">
                        <div>
                          <h2>{t("workspace.formalExperimentReadiness")}</h2>
                          <p className="muted">{t("workspace.usesTheLegacyLabPrerequisiteChecksDescriptiveObservationsCannotReplaceCausal")}</p>
                        </div>
                        <Tag>{t("workspace.readOnlyCheck")}</Tag>
                      </div>
                      {data.readiness ? (
                        data.readiness.checks.map((c) => (
                          <div className="readiness-row" key={c.id}>
                            {c.status === "pass" ? (
                              <CheckCircle2 size={17} />
                            ) : (
                              <Circle size={17} />
                            )}
                            <p>{uiMessage(c.detail)}</p>
                            <Tag
                              kind={c.status === "pass" ? "good" : "neutral"}
                            >
                              {c.status === "pass"
                                ? t("workspace.ready")
                                : c.status === "warning"
                                  ? t("workspace.note")
                                  : t("workspace.stillNeeded")}
                            </Tag>
                          </div>
                        ))
                      ) : (
                        <Empty
                          title={t("workspace.chooseAQuestionSetFirst")}
                          body={t("workspace.checkTheFrozenScopeBaselinePreregistrationAndInterventionConditions")}
                        />
                      )}
                    </section>
                    <section className="panel provider-panel">
                      <div className="section-head">
                        <h2>{t("workspace.aPIConnections")}</h2>
                        <button onClick={() => setModal("settings")}>{t("workspace.configureKeysModels")}</button>
                      </div>
                      {data.engines.map((e) => (
                        <div className="provider" key={e.name}>
                          <span>
                            <Globe size={17} />
                            {e.name}
                          </span>
                          <Tag kind={e.configured ? "good" : "neutral"}>
                            {e.configured ? t("workspace.configured") : t("workspace.notConfigured")}
                          </Tag>
                        </div>
                      ))}
                    </section>
                  </>
                )}
              </>
            )}
          </main>
          <footer className="app-footer">
            <ShieldCheck size={13} />{t("workspace.originalTextQualityChecksAndResultsAreKeptSeparately")}<span>{t("workspace.getgeoTraceableObservations")}</span>
          </footer>
        </div>
        {modal === "api" && data && (
          <Dialog title={t("workspace.startAPIBaselineCollection")} close={() => setModal(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                act(async () => {
                  await request("api-jobs", {
                    promptSetId: setId,
                    engines: f.getAll("engines"),
                    runsPerPrompt: Number(str(f, "runs")),
                    maxCostUsd: Number(str(f, "budget")),
                    costAcknowledged: true,
                  });
                  setModal(null);
                }, t("workspace.aPITaskCreated"));
              }}
            >
              <fieldset>
                <legend>{t("workspace.chooseConfiguredPlatforms")}</legend>
                {data.engines.map((e) => (
                  <label className="check" key={e.name}>
                    <input
                      type="checkbox"
                      name="engines"
                      value={e.name}
                      disabled={!e.configured}
                    />
                    {e.name} · {e.configured ? t("workspace.configured") : t("workspace.notConfigured")}
                  </label>
                ))}
              </fieldset>
              <div className="form-grid">
                <Field label={t("workspace.runsPerQuestionPerPlatform")}>
                  <input
                    name="runs"
                    type="number"
                    min="1"
                    max="10"
                    defaultValue="1"
                    required
                  />
                </Field>
                <Field label={t("workspace.totalRunBudgetUSD")}>
                  <input
                    name="budget"
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.01"
                    defaultValue="1.00"
                    required
                  />
                </Field>
              </div>
              <p className="quiet-note">{t("workspace.callsRunInSequenceDispatchStopsAtTheBudgetButThe")}</p>
              <label className="check">
                <input type="checkbox" required />{t("workspace.iConfirmSendingTheseQuestionsAndPayingTheProviderCallCosts")}</label>
              <button
                className="primary wide"
                disabled={busy || !currentSet?.frozen_at}
              >{t("workspace.startCollection")}</button>
            </form>
          </Dialog>
        )}
        {modal === "settings" && data && (
          <Dialog title={t("workspace.configureAPIConnections")} close={() => setModal(null)}>
            <ConnectionSettingsEditor access={data.settings?.access} fields={data.settings?.fields??[]} persisted={!!data.settings?.persisted} busy={busy} onUnlock={unlockConnections} onSave={fields=>{
              void act(async()=>{await request('settings',fields);refreshAccountStatus();setModal(null);},t("workspace.connectionSettingsUpdated"));
            }}/>
          </Dialog>
        )}
        {modal === "brand" && (
          <Dialog title={t("workspace.newBrand")} close={() => setModal(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                act(async () => {
                  const b = await request<{ id: string }>("brands", {
                    name: str(f, "name"),
                    ownedDomains: split(str(f, "domains")),
                    aliases: split(str(f, "aliases")),
                    category: str(f, "category"),
                  });
                  setGscSelectedProperty("");
                  setBrandId(b.id);
                  selectSet("");
                  setModal(null);
                  setGscInitialSection("overview");
                  setPage("gsc");
                }, t("workspace.brandSaved"));
              }}
            >
              <Field label={t("workspace.brandName")}>
                <input name="name" required maxLength={120} />
              </Field>
              <Field
                label={t("workspace.ownedDomains")}
                hint={t("workspace.enterDomainsOnlyWithoutHttpsSeparateMultipleDomainsWithCommas")}
              >
                <input name="domains" placeholder="example.com" required />
              </Field>
              <details className="new-project-options"><summary>{t("simple.optionalDetails")}</summary>
              <Field label={t("workspace.brandAliases")}>
                <input name="aliases" placeholder={t("workspace.separateAliasesWithCommas")} />
              </Field>
              <Field label={t("workspace.businessCategory")}>
                <input name="category" />
              </Field>
              </details>
              <button className="primary wide" disabled={busy}>{t("workspace.saveBrand")}</button>
            </form>
          </Dialog>
        )}
        {modal === "set" && (
          <Dialog title={t("workspace.newQuestionSet")} close={() => setModal(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                act(async () => {
                  const imported = JSON.parse(str(f, "importedQuestions"));
                  if (imported.errors.length) throw new Error(imported.errors.join("；"));
                  const s = await request<{ id: string }>("sets", {
                    brandId: str(f, "brandId"),
                    label: str(f, "label"),
                    locale: str(f, "locale"),
                    source: str(f, "source"),
                    kind: str(f, "kind"),
                    prompts: imported.prompts,
                  });
                  selectSet(s.id);
                  setQuestionView('review');
                  setModal(null);
                }, t("workspace.questionsSavedAsADraftVersion"));
              }}
            >
              <Field label={t("workspace.brand")}>
                <select name="brandId" defaultValue={currentBrand?.id}>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="form-grid">
                <Field label={t("workspace.versionName")}>
                  <input
                    name="label"
                    required
                    placeholder={t("workspace.buyerQuestionsVersion1")}
                  />
                </Field>
                <Field label={t("workspace.questionLanguage")}>
                  <input
                    name="locale"
                    defaultValue="en-CA"
                    required
                    pattern="[a-z]{2,3}(-[A-Z]{2})?"
                  />
                </Field>
              </div>
              <QuestionInput />
              <div className="form-grid">
                <Field label={t("workspace.sourceCategory")}>
                  <select name="kind">
                    <option value="hypothesis">{t("workspace.hypothesisToValidate")}</option>
                    <option value="business">{t("workspace.actualBusinessRecords")}</option>
                    <option value="ai_draft">{t("workspace.aIDraftManuallyReviewed")}</option>
                  </select>
                </Field>
              </div>
              <Field label={t("workspace.sourceDescription")}>
                <input
                  name="source"
                  required
                  placeholder={t("workspace.forExampleCommonQuestionsFromThisMonthSCustomerInquiries")}
                />
              </Field>
              <button
                className="primary wide"
                disabled={busy || !brands.length}
              >{t("workspace.saveQuestionSet")}</button>
            </form>
          </Dialog>
        )}
        {modal === "plan" && currentSet && (
          <Dialog title={t("workspace.newSamplingPlan")} close={() => setModal(null)}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                act(async () => {
                  if(loginPlanPreset&&loginPlanPreset.promptSetId!==setId)throw new Error(t("workspace.theQuestionSetChangedReopenTheSignedInPlanSetup"));
                  const p = await request<{ id: string }>("plans", {
                    promptSetId: setId,
                    label: str(f, "label"),
                    surfaces: f.getAll("surfaces"),
                    accountMode: str(f, "accountMode"),
                    ...(str(f, "accountMode")==="signed_out"?{guestPolicy:"no_login_v1"}:{}),
                    windows: split(str(f, "windows")),
                    repetitions: Number(str(f,"repetitions")),
                    egressPolicy: loginPlanPreset ? (loginPlanPreset.config.egressPolicy??'unverified') : "country_fixed",
                    country: str(f, "country"),
                    locale: str(f, "locale"),
                    timezone: str(f, "timezone"),
                    device: str(f, "device"),
                  });
                  setPlanId(p.id);
                  setModal(null);
                  setPage("workspace");
                }, t("workspace.samplingPlanFixed"));
              }}
            >
              <Field label={t("workspace.sessionMode")} hint={t("workspace.preferSignedOutOrAnonymousModeIfAnAccountIsNeeded")}>
                <select name="accountMode" value={planAccountMode} onChange={e=>setPlanAccountMode(e.target.value)}><option value="signed_out">{t("workspace.signedOutOnlySeparateIncognito")}</option><option value="isolated">{t("workspace.separateIncognitoLoginAsNeeded")}</option><option value="signed_in_private">{t("workspace.strictPlatformTemporaryModeChatGPTGoogle")}</option></select>
              </Field>
              <fieldset>
                <legend>{t("workspace.consumerWebPlatforms")}</legend>
                {Object.entries(names).map(([key, name]) => (
                  <label className="check" key={key}>
                    <input
                      type="checkbox"
                      name="surfaces"
                      value={key}
                      key={key+planAccountMode}
                      defaultChecked={(loginPlanPreset?loginPlanPreset.surfaces.includes(key as keyof typeof surfaceRegistry):true)&&(planAccountMode==='signed_out'||(planAccountMode==='isolated'?surfaceRegistry[key as keyof typeof surfaceRegistry].independentLoginSupported:surfaceRegistry[key as keyof typeof surfaceRegistry].privateSupported))}
                      disabled={planAccountMode==='isolated'&&!surfaceRegistry[key as keyof typeof surfaceRegistry].independentLoginSupported||planAccountMode==='signed_in_private'&&!surfaceRegistry[key as keyof typeof surfaceRegistry].privateSupported}
                    />
                    {name}{key==='duckduckgo_search_assist'&&<small className="new-platform-label">{t("guest.guestOnly")}</small>}
                  </label>
                ))}
              </fieldset>
              {planAccountMode==='signed_out'&&<p className="quiet-note">{t("guest.strictModeHint")}</p>}
              {planAccountMode==='signed_in_private'&&<p className="quiet-note">{t("workspace.thisModeIncludesOnlyChatGPTAndGoogleWhereTemporaryConditionsCan")}</p>}
              <details className="new-project-options"><summary>{t("simple.samplingConditions")}</summary>
              <Field label={t("workspace.planName")}>
                <input name="label" required defaultValue={loginPlanPreset?.label??t("workspace.multiPlatformWebSampling")} />
              </Field>
              <Field
                label={t("workspace.samplingDateWindows")}
                hint={t("workspace.useDatesInThePlannedTimezoneAndSeparateDaysWithCommas")}
              >
                <input name="windows" defaultValue={loginPlanPreset?new Intl.DateTimeFormat('en-CA',{timeZone:loginPlanPreset.config.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()):day()} required />
              </Field>
              <Field label={t("workspace.independentSamplesPerQuestionPerPlatform")} hint={t("workspace.eachSampleStartsANewSessionAndRunsInRoundsRepeated")}><input name="repetitions" type="number" min="1" max="10" defaultValue={loginPlanPreset?(loginPlanPreset.config.repetitions??1):3} required/></Field>
              {loginPlanPreset&&<p className="quiet-note">{t("workspace.signedInSamplingCreatesASeparatePlanTheOriginalPlanAnd")}</p>}
              <p className="quiet-note">{loginPlanPreset&&(!loginPlanPreset.config.egressPolicy||loginPlanPreset.config.egressPolicy==='unverified')?t("workspace.keepsTheOriginalEgressVerificationConditionsUnverifiedRegionsAreExcludedFrom"):t("workspace.automaticallyChecksTheActualNetworkExitCountryBeforeSubmissionAndSaving")}</p>
              <div className="form-grid">
                <Field label={t("workspace.targetCountryNetworkExitMustMatch")}>
                  <input
                    name="country"
                    defaultValue={loginPlanPreset?.config.country??"CA"}
                    onChange={e=>{e.currentTarget.value=e.currentTarget.value.toUpperCase();}}
                    maxLength={2}
                    pattern="[A-Z]{2}"
                    required
                  />
                </Field>
                <Field label={t("workspace.language")}>
                  <input
                    name="locale"
                    defaultValue={loginPlanPreset?.config.locale??String(data?.prompts[0]?.locale ?? "en-CA")}
                    required
                  />
                </Field>
                <Field label={t("workspace.timezone")}>
                  <input
                    name="timezone"
                    defaultValue={loginPlanPreset?.config.timezone??"America/Halifax"}
                    required
                  />
                </Field>
                <Field label={t("workspace.device")}>
                  <select name="device" defaultValue={loginPlanPreset?.config.device??'desktop'}>
                    <option value="desktop">{t("workspace.desktop")}</option>
                    <option value="mobile">{t("workspace.mobile")}</option>
                    <option value="tablet">{t("workspace.tablet")}</option>
                  </select>
                </Field>
              </div>
              </details>
              <p className="quiet-note">{t("workspace.afterFixingThePlanStartChromeBatchSamplingOrRecordQuestions")}</p>
              <button className="primary wide" disabled={busy}>{t("workspace.fixPlanPromptCountQuestions", { promptCount: data?.prompts.length })}</button>
            </form>
          </Dialog>
        )}
        {modal === "capture" && slot && currentPlan && (
          <CaptureDialog
            slot={slot}
            draft={samplingDraft}
            plan={currentPlan}
            busy={busy}
            close={() => setModal(null)}
            save={(c) =>
              act(async () => {
                await request("captures", c);
                setModal(null);
              }, t("workspace.evidenceSavedForReview"))
            }
          />
        )}
        {modal === "review" && slot?.latest && (
          <Dialog title={t("workspace.reviewEvidence")} close={() => setModal(null)}>
            <p>{slot.prompt}</p>
            <Artifact hash={slot.latest.capture.artifactHash} />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                act(async () => {
                  await request("reviews", {
                    attemptId: slot.latest!.id,
                    decision: str(f, "decision"),
                    note: str(f, "note"),
                    privacyReviewed: true,
                  });
                  setModal(null);
                }, t("workspace.reviewDecisionSaved"));
              }}
            >
              <Field label={t("workspace.reviewDecision")}>
                <select name="decision">
                  <option value="accept">{t("workspace.acceptTextMatchesTheAttachmentAndStatusIsAccurate")}</option>
                  <option value="reject">{t("workspace.returnEvidenceIsIncompleteOrInconsistent")}</option>
                </select>
              </Field>
              <Field label={t("workspace.reviewNotes")}>
                <textarea name="note" required rows={3} />
              </Field>
              <label className="check">
                <input type="checkbox" required />{t("workspace.iCheckedTheTextCitationsAndAttachmentsForSensitiveInformation")}</label>
              <p className="muted">{t("workspace.acceptingARecordDoesNotQualifyItsSamplingConditionsConditionNotes")}</p>
              <button className="primary wide" disabled={busy}>{t("workspace.saveReviewDecision")}</button>
            </form>
          </Dialog>
        )}
        {modal === "release" && slot && (
          <Dialog title={t("workspace.recordChangedAccessConditions")} close={() => setModal(null)}>
            <p>{t("workspace.thisAffectsAllPlansForTheSamePlatformAndCountryRestarting")}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                act(async () => {
                  await request("release", {
                    scope: slot.scope,
                    reason: str(f, "reason"),
                  });
                  setModal(null);
                }, t("workspace.changeRecordedSamplingPlatformRestored"));
              }}
            >
              <Field label={t("workspace.actualChangeAndEvidencePermittingContinuation")}>
                <textarea name="reason" required minLength={15} rows={4} />
              </Field>
              <button className="primary wide" disabled={busy}>{t("workspace.recordChangeRestorePlatform")}</button>
            </form>
          </Dialog>
        )}
        {modal === "history" && historyRun && (
          <Dialog title={t("workspace.legacyLabRunEvidence")} close={() => setModal(null)}>
            <p className="muted">{t("workspace.total", { total: historyRun.total, shown: historyRun.rows.length })}</p>
            {historyRun.rows.map((o) => (
              <article className="history-observation" key={String(o.id)}>
                <h3>{String(o.prompt)}</h3>
                <Tag>{String(o.product_surface ?? o.engine)}</Tag>
                <small className="mono">{String(o.id)}</small>
                <pre className="answer">
                  {String(o.answer_text || o.error_message || t("workspace.noAnswerText"))}
                </pre>
                {o.citations.map((c, i) => (
                  <p key={i}>
                    <a
                      href={
                        /^https?:\/\//i.test(String(c.url))
                          ? String(c.url)
                          : undefined
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      {String(c.title ?? c.url)}
                    </a>
                  </p>
                ))}
              </article>
            ))}
          </Dialog>
        )}
      </div>
    </FeedbackContext.Provider>
  );
}
function ApiPanel({
  data,
  busy,
  launch,
  control,
}: {
  data: State;
  busy: boolean;
  launch: () => void;
  control: (id: string, action: string) => Promise<void>;
}) {
  useUiLanguage();
  const labels: Record<string, string> = {
    running: t("workspace.collecting"),
    queued: t("workspace.waitingToStart"),
    paused: t("workspace.paused"),
    interrupted: t("workspace.interrupted"),
    complete: t("workspace.complete"),
    discarded: t("workspace.keptEnded"),
  };
  return (
    <section className="panel history">
      <div className="section-head">
        <div>
          
          <h2>{t("workspace.aPICollectionTasks")}</h2>
        </div>
        <button onClick={launch} disabled={!data.selectedSetId}>
          <Plus size={15} />{t("workspace.startAPICollection")}</button>
      </div>
      {data.apiJobs?.length ? (
        data.apiJobs.map((j) => (
          <div className="api-job" key={j.id}>
            <div>
              <strong>{j.config.engines.join(" / ")}</strong>
              <p>
                {t("workspace.recordedTotal", { completed: j.completed, spent: Number(j.spent_usd ?? 0).toFixed(4), budget: j.config.maxCostUsd.toFixed(2) })}
                {j.uncertain > 0 && t("workspace.uncertainUnconfirmedCallResults", { uncertain: j.uncertain })}
              </p>
              {j.message && <small>{uiMessage(j.message)}</small>}
            </div>
            <Tag
              kind={
                j.status === "complete"
                  ? "good"
                  : j.uncertain
                    ? "warn"
                    : "neutral"
              }
            >
              {labels[j.status]}
            </Tag>
            {j.status === "running" ? (
              <button disabled={busy} onClick={() => control(j.id, "pause")}>{t("common.pause")}</button>
            ) : (
              !["complete", "discarded"].includes(j.status) && (
                <>
                  <button
                    disabled={busy || !!j.uncertain}
                    onClick={() => control(j.id, "resume")}
                  >{t("common.continue")}</button>
                  <button
                    disabled={busy}
                    onClick={() => control(j.id, "discard")}
                  >{t("workspace.keepEnd")}</button>
                </>
              )
            )}
          </div>
        ))
      ) : (
        <p className="inset muted">{t("workspace.usesTheLegacyLabAPIConnectionsEveryRunHasABudget")}</p>
      )}
    </section>
  );
}
function CaptureDialog({
  slot,
  draft,
  plan,
  busy,
  close,
  save,
}: {
  slot: Slot;
  draft: SamplingDraft | null;
  plan: Plan;
  busy: boolean;
  close: () => void;
  save: (c: Capture) => Promise<void>;
}) {
  useUiLanguage();
  const [status, setStatus] = useState("observed"),
    [file, setFile] = useState<Capture["artifact"]>(draft?.artifact ?? null),
    [fileError, setFileError] = useState("");
  async function attach(f: File | undefined) {
    if (!f) {
      setFile(null);
      return;
    }
    if (f.size > 4 * 1024 * 1024) {
      setFileError(t("workspace.fileExceeds4MB"));
      return;
    }
    const allowed = ["image/png", "image/jpeg", "image/webp", "text/plain"];
    if (!allowed.includes(f.type)) {
      setFileError(t("workspace.onlyPNGJPEGWebPOrTXTFilesAreSupported"));
      return;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    setFile({
      mime: f.type as NonNullable<Capture["artifact"]>["mime"],
      base64: btoa(binary),
    });
    setFileError("");
  }
  return (
    <Dialog title={t("workspace.recordSamplingEvidenceContext2")} close={close}>
      <p className="frozen-question">{slot.prompt}</p>
      {draft && (
        <p className="quiet-note">{t("workspace.screenshotRetrievedFromTheIsolatedWindowSourcePage", { url: draft.url })}</p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          save({
            slotId: slot.id,
            prompt: slot.prompt,
            status: status as Capture["status"],
            reason: str(f, "reason"),
            restriction:
              (str(f, "restriction") as Capture["restriction"]) || "none",
            observedAt: str(f, "observedAt"),
            answer: status === "observed" ? str(f, "answer") : "",
            citations:
              status === "observed"
                ? str(f, "citations")
                    .split("\n")
                    .filter((x) => x.trim())
                    .map((url) => ({ url: url.trim() }))
                : [],
            model: str(f, "model") || "unknown",
            ...(draft
              ? { sourceUrl: draft.url, sessionRef: draft.sessionRef }
              : {}),
            account: str(f, "account") as Capture["account"],
            session: str(f, "session") as Capture["session"],
            exitCountry: str(f, "exitCountry") || null,
            geo: str(f, "geo") as Capture["geo"],
            locale: str(f, "locale"),
            timezone: str(f, "timezone"),
            device: str(f, "device") as Capture["device"],
            geolocation: str(f, "geolocation") as Capture["geolocation"],
            searchMode: str(f, "searchMode") as Capture["searchMode"],
            retrievalUsed:
              str(f, "retrieval") === "unknown"
                ? null
                : str(f, "retrieval") === "yes",
            collectionMode: "manual_capture",
            artifact: file,
          });
        }}
      >
        <div className="form-grid">
          <Field label={t("workspace.actualResult")}>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="observed">{t("workspace.completeAnswer")}</option>
              {["google_aio", "duckduckgo_search_assist"].includes(slot.surface) && (
                <option value="not_triggered">{t("workspace.searchCompletedOverviewNotTriggered")}</option>
              )}
              <option value="unavailable">{t("workspace.unavailable")}</option>
              <option value="error">{t("workspace.executionError")}</option>
              <option value="cancelled">{t("workspace.cancelThisSamplingSlot")}</option>
            </select>
          </Field>
          <Field label={t("workspace.actualObservationTimeIncludingTimezone")}>
            <input
              name="observedAt"
              defaultValue={draft?.observedAt ?? new Date().toISOString()}
              required
            />
          </Field>
        </div>
        {status === "observed" ? (
          <>
            <Field label={t("workspace.originalAnswer")}>
              <textarea name="answer" rows={6} required />
            </Field>
            <Field
              label={t("workspace.citationURLs")}
              hint={t("workspace.onePerLineInDisplayedOrderLeaveBlankIfThereAre")}
            >
              <textarea name="citations" rows={3} />
            </Field>
            <Field label={t("workspace.modelShownInTheInterface")}>
              <input name="model" placeholder={t("workspace.leaveBlankIfNotShown")} />
            </Field>
          </>
        ) : (
          <Field label={t("workspace.reasonForEnding")}>
            <textarea name="reason" rows={3} required />
          </Field>
        )}
        {status === "unavailable" && (
          <Field label={t("workspace.accessRestriction")}>
            <select name="restriction">
              <option value="login">{t("workspace.loginRequired")}</option>
              <option value="captcha">{t("workspace.cAPTCHA")}</option>
              <option value="rate_limit">{t("workspace.rateLimited")}</option>
              <option value="region">{t("workspace.regionUnavailable")}</option>
            </select>
          </Field>
        )}
        <Field label={t("workspace.screenshotOrTextEvidenceUpTo4MB")}>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,text/plain"
            required={status !== "cancelled" && !file}
            onChange={(e) => attach(e.target.files?.[0])}
          />
        </Field>
        {fileError && <p className="error-text">{uiMessage(fileError)}</p>}
        <details open>
          <summary>{t("workspace.actualSessionRegionConditions")}</summary>
          <div className="form-grid">
            <Field label={t("workspace.accountState")}>
              <select name="account">
                <option value="unknown">{t("workspace.unconfirmed")}</option>
                <option value="logged_out">{t("workspace.confirmedSignedOut")}</option>
                <option value="logged_in">{t("workspace.signedIn")}</option>
              </select>
            </Field>
            <Field label={t("workspace.sessionHistory")}>
              <select name="session" defaultValue={draft ? "fresh" : "unknown"}>
                <option value="unknown">{t("workspace.unconfirmed")}</option>
                <option value="fresh">{t("workspace.confirmedFreshSession")}</option>
                <option value="active">{t("workspace.existingHistory")}</option>
              </select>
            </Field>
            <Field label={t("workspace.networkExitVerification")}>
              <select name="geo">
                <option value="unverified">{t("workspace.unverified")}</option>
                <option value="ip_observed">{t("workspace.exitCountryChecked")}</option>
              </select>
            </Field>
            <Field label={t("workspace.exitCountry")} hint={t("workspace.recordOnlyTheCountryNotTheIPAddress")}>
              <input name="exitCountry" placeholder="CA" pattern="[A-Z]{2}" />
            </Field>
            <Field label={t("workspace.browserLanguage")}>
              <input
                name="locale"
                defaultValue={draft?.context.locale ?? plan.config.locale}
                required
              />
            </Field>
            <Field label={t("workspace.timezone")}>
              <input
                name="timezone"
                defaultValue={draft?.context.timezone ?? plan.config.timezone}
                required
              />
            </Field>
            <Field label={t("workspace.device")}>
              <select name="device" defaultValue={plan.config.device}>
                <option value="desktop">{t("workspace.desktop")}</option>
                <option value="mobile">{t("workspace.mobile")}</option>
                <option value="tablet">{t("workspace.tablet")}</option>
                <option value="unknown">{t("workspace.unconfirmed")}</option>
              </select>
            </Field>
            <Field label={t("workspace.locationPermission")}>
              <select
                name="geolocation"
                defaultValue={draft ? "denied" : "unknown"}
              >
                <option value="unknown">{t("workspace.unconfirmed")}</option>
                <option value="denied">{t("workspace.disabled")}</option>
                <option value="real">{t("workspace.actualLocation")}</option>
              </select>
            </Field>
            <Field label={t("workspace.searchMode")}>
              <select name="searchMode">
                <option value="unknown">{t("workspace.unconfirmed")}</option>
                <option value="explicit_search">{t("workspace.explicitSearch")}</option>
                <option value="natural">{t("workspace.naturalQuestionAnswering")}</option>
              </select>
            </Field>
            <Field label={t("workspace.retrievalBehavior")}>
              <select name="retrieval">
                <option value="unknown">{t("workspace.notVerifiableFromTheInterface")}</option>
                <option value="yes">{t("workspace.retrievalExplicitlyShown")}</option>
                <option value="no">{t("workspace.explicitlyNoRetrieval")}</option>
              </select>
            </Field>
          </div>
        </details>
        <button
          className="primary wide"
          disabled={busy || !!fileError || (status !== "cancelled" && !file)}
        >{t("workspace.saveEvidenceAwaitingReview")}</button>
      </form>
    </Dialog>
  );
}
const appRoot=document.getElementById("root");
if(appRoot)createRoot(appRoot).render(
  <React.StrictMode>
    <ConsoleBoundary><App /></ConsoleBoundary>
  </React.StrictMode>,
);
