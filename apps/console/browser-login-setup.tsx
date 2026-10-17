import React,{useEffect,useId,useRef,useState} from "react";
import {t,useUiLanguage,uiMessage} from "./i18n.tsx";
import {samplingMessage} from "./sampling-messages.ts";
import {ArrowDown,CheckCircle2,ExternalLink,LogIn,Pause} from "lucide-react";
import {request} from "./api.ts";
import {surfaces} from "../../src/console/contracts.ts";
import type {BrowserJobs} from "../../src/console/browser-jobs.ts";
import type {LabService} from "../../src/console/service.ts";
import "./browser-login-setup.css";

type Readiness=ReturnType<BrowserJobs["loginReadiness"]>;
type Platform=Readiness["platforms"][number];
type Session={planId:string;surface:string;verified:boolean};
type Props={
  plan?:ReturnType<LabService["plan"]>;
  readiness?:Readiness|null;
  loginSetupRequest?:number;
  expiredPrivatePlan?:boolean;
  sessions:Session[];
  availability:{available:boolean;message:string};
  busy:boolean;
  samplingActive:boolean;
  activeJob?:{id:string;status:string;finalizing:boolean};
  act:(fn:()=>Promise<unknown>)=>Promise<void>;
  onPause:(jobId:string)=>Promise<void>;
  onCreateLoginPlan?:()=>void;
};

/** Login evidence controls reminders; opening a page or changing a frozen plan always needs a click. */
export function BrowserLoginSetup({plan,readiness,loginSetupRequest,expiredPrivatePlan=false,sessions,availability,busy,samplingActive,activeJob,act,onPause,onCreateLoginPlan}:Props){
  const language=useUiLanguage();
  const feedback=(value:string|null|undefined)=>samplingMessage(uiMessage(value),language);
  const labels:Record<Platform["status"],string>={login_required:t("browserLogin.loginSetupNeeded"),not_configured:t("browserLogin.loginSetupNeeded"),awaiting_confirmation:t("browserLogin.awaitingLoginConfirmation"),confirmed:t("browserLogin.loginConfirmed"),optional:t("browserLogin.optionalCurrentlySignedOut"),restricted:t("browserLogin.otherAccessRestriction")};
  const [expanded,setExpanded]=useState(false),[target,setTarget]=useState(""),[navigation,setNavigation]=useState(0),[message,setMessage]=useState(""),[messageKind,setMessageKind]=useState<"success"|"warning">("success");
  const section=useRef<HTMLDetailsElement>(null),rows=useRef<Record<string,HTMLDivElement|null>>({});
  const currentPlan=useRef(plan?.id);
  currentPlan.current=plan?.id;
  const id=useId();
  const privateMode=plan?.config.accountMode==="signed_in_private";
  const loginAllowed=plan?.config.accountMode==="isolated"||plan?.config.accountMode==="signed_in_private";
  const localSessions=sessions.filter(session=>session.planId===plan?.id);
  const matched=readiness?.planId===plan?.id?readiness:null;
  const platforms:Platform[]=matched?.platforms??plan?.config.surfaces.map(surface=>{
    const session=localSessions.find(s=>s.surface===surface),required=plan.config.accountMode==="signed_in_private";
    return {surface,name:surfaces[surface].name,url:surfaces[surface].url,status:session?.verified?"confirmed":session?"awaiting_confirmation":required?"not_configured":"optional",required,canConfigure:loginAllowed&&!samplingActive&&availability.available,needsNewPlan:false,sessionOpen:!!session,confirmed:session?.verified??false,blockedCount:0,reason:required?t("browserLogin.thisPlanSamplesWhileSignedInLogInToThisPlatform"):t("browserLogin.readingPlatformStatusYouCanPrepareADedicatedLoginWindowManually"),restriction:{active:false,type:null,reason:"",evidence:null},previousLoginEvidence:null};
  })??[];
  const required=expiredPrivatePlan?[]:platforms.filter(platform=>platform.status!=="restricted"&&platform.required&&(!platform.confirmed||platform.restriction.active&&platform.restriction.type==="login"));
  useEffect(()=>{setExpanded(false);setTarget("");setMessage("");setMessageKind("success");},[plan?.id]);
  useEffect(()=>{if(loginSetupRequest){setExpanded(true);setTarget("");setNavigation(n=>n+1);}},[loginSetupRequest]);
  useEffect(()=>{
    if(!navigation||!expanded)return;
    const node=target?rows.current[target]:section.current;
    node?.scrollIntoView?.({behavior:window.matchMedia?.("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"center"});
    node?.focus?.({preventScroll:true});
  },[navigation,expanded,target]);
  function navigate(surface=""){setExpanded(true);setTarget(surface);setNavigation(n=>n+1);}
  function configure(surface:string,action:"open"|"verify"){
    if(!plan||samplingActive||busy||expiredPrivatePlan)return;
    const planId=plan.id;
    const platform=platforms.find(row=>row.surface===surface);
    setMessage("");
    void act(async()=>{
      const result=await request<{opened?:boolean;verified?:boolean;restrictionReleased?:boolean}>("browser-session",{planId,surface,action});
      if(currentPlan.current!==planId)return;
      if(action==="open"){
        const opened=result?.opened===true;
        setMessageKind(opened?"success":"warning");
        setMessage(opened?t("browserLogin.theNameLoginWindowIsOpenFinishSigningInThenReturn", { name: surfaces[surface as keyof typeof surfaces].name }):t("browserLogin.theLoginWindowHasNotBeenConfirmedOpenTryAgainOr"));
      }else if(result?.verified!==true){
        setMessageKind("warning");
        setMessage(t("browserLogin.loginIsNotConfirmedYetFinishSigningInInTheDedicated"));
      }else if(platform?.restriction.active&&(platform.restriction.type!=="login"||result.restrictionReleased!==true)){
        setMessageKind("warning");
        setMessage(privateMode&&platform.restriction.type==="login"?t("browserLogin.theLoginWindowIsConfirmedButTheOriginalRestrictionRemainsReview"):t("browserLogin.loginIsConfirmedButThisPlatformSRestrictionIsStillActive"));
      }else{
        setMessageKind("success");
        setMessage(t("browserLogin.loginIsConfirmedContinueUnsubmittedTasksManuallySavedAnswersWillNot"));
      }
    });
  }
  return <div className="browser-login-config">
    <div className="browser-login-entry"><div><strong>{t("browserLogin.aIPlatformLoginSetup")}</strong><span className="muted">{t("browserLogin.signInInADedicatedBrowserWindowThenReturnToConfirm")}</span></div><button aria-expanded={expanded} aria-controls={id} onClick={()=>navigate()}><LogIn size={16}/>{t("browserLogin.aIPlatformLoginSetup")}<ArrowDown size={14}/></button></div>
    {expiredPrivatePlan&&<div className="browser-login-notice" role="status"><strong>{t("browserLogin.continueUnsubmittedTasksThenSetUpLoginsForTheNewDate")}</strong><p>{t("browserLogin.thisSignedInPlanIsFromAnEarlierDateClickContinue")}</p></div>}
    {required.length>0&&<div className="browser-login-notice" role="status"><strong><LogIn size={18}/>{t("browserLogin.thesePlatformsNeedLoginSetup")}</strong>{required.map(platform=><div className="browser-login-needed" key={platform.surface}><div><b>{platform.name}</b><span>{platform.confirmed?privateMode?t("browserLogin.loginWindowConfirmedOriginalRestrictionRetained"):t("browserLogin.loginConfirmedConfirmAgain"):labels[platform.status]}{platform.blockedCount>0?t("browserLogin.blockedCountPositionsPaused", { blockedCount: platform.blockedCount }):""}</span><small>{feedback(platform.reason)}</small></div><button onClick={()=>navigate(platform.surface)}>{t("browserLogin.setUpLogin")}<ArrowDown size={14}/></button></div>)}</div>}
    <details ref={section} className="session-setup browser-login-setup" id={id} open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)} tabIndex={-1}>
      <summary>{t("browserLogin.platformSetupLoginStatus")}{platforms.length>0?t("browserLogin.platformCountPlatforms", { platformCount: platforms.length }):""}</summary>
      {!plan?<p className="muted">{t("browserLogin.selectASamplingPlanThenSetUpItsPlatformsHere")}</p>:<>
        {samplingActive&&<div className="browser-login-pause" role="status"><div><strong>{t("browserLogin.pauseThisBatchFirst")}</strong><span>{activeJob?.status==="running"?t("browserLogin.youCanOpenALoginWindowOnceThePauseIsComplete"):t("browserLogin.savingAnswersOrClosingTheBrowserSetupBecomesAvailableOnceThat")}</span></div>{activeJob?.status==="running"&&<button disabled={busy} onClick={()=>void onPause(activeJob.id)}><Pause size={15}/>{t("browserLogin.pauseSampling")}</button>}</div>}
        {!availability.available&&<p className="muted" role="status">{feedback(availability.message)}</p>}
        <p className="browser-login-steps">{expiredPrivatePlan?t("browserLogin.loginStatusForTheOldPlanIsViewOnlyContinueSampling"):t("browserLogin.loginWindowSteps")}</p>
        {platforms.map(platform=>{
          const canAct=!busy&&!samplingActive&&!expiredPrivatePlan&&availability.available&&platform.canConfigure;
          const needsIndependentPlan=privateMode&&platform.confirmed&&platform.restriction.active&&platform.restriction.type==="login";
          const needsConfirmation=!platform.confirmed||!privateMode&&platform.restriction.active&&platform.restriction.type==="login";
          return <div ref={node=>{rows.current[platform.surface]=node;}} className="browser-login-row" key={platform.surface} tabIndex={-1} data-highlighted={target===platform.surface||undefined}>
            <div className="browser-login-platform"><strong>{platform.name}</strong><span className={`tag ${expiredPrivatePlan?"":platform.confirmed?"success":platform.required||platform.status==="restricted"?"warning":""}`}>{!expiredPrivatePlan&&platform.confirmed&&<CheckCircle2 size={13}/>} {expiredPrivatePlan?t("browserLogin.historicalPlanViewOnlyStatus"):!matched&&platform.status==="optional"?t("browserLogin.optionalNotCheckedYet"):labels[platform.status]}</span><small>{platform.url}</small></div>
            <div className="browser-login-reason"><p>{expiredPrivatePlan?t("browserLogin.thisIsTheOriginalPlanFromAnEarlierDateContinueUnsubmitted"):feedback(platform.reason)}</p>{platform.status==="restricted"&&<small className="muted">{t("browserLogin.loginSetupDoesNotRemoveCAPTCHARateOrLocationRestrictions")}</small>}{platform.needsNewPlan&&<small className="muted">{t("browserLogin.thisPlanIsFrozenUnderSignedOutConditionsCreateANew")}</small>}</div>
            <div className="button-row browser-login-actions">{platform.needsNewPlan?<button disabled={busy||samplingActive||expiredPrivatePlan||!onCreateLoginPlan} onClick={()=>onCreateLoginPlan?.()}>{t("browserLogin.createASignedInPlan")}</button>:loginAllowed?<><button disabled={!canAct} onClick={()=>configure(platform.surface,"open")}><ExternalLink size={14}/>{platform.sessionOpen?t("browserLogin.reopenLoginWindow"):t("browserLogin.openLoginWindow")}</button><button disabled={!canAct||!platform.sessionOpen||!needsConfirmation} onClick={()=>configure(platform.surface,"verify")}>{needsConfirmation?t("browserLogin.confirmLogin"):t("browserLogin.confirmed")}</button>{needsIndependentPlan&&<button disabled={busy||samplingActive||expiredPrivatePlan||!onCreateLoginPlan} onClick={()=>onCreateLoginPlan?.()}>{t("browserLogin.createAnIndependentSignedInPlan")}</button>}</>:<span className="muted">{t("browserLogin.samplingUnderTheCurrentSignedOutConditions")}</span>}</div>
          </div>;
        })}
        {message&&<p className={`browser-login-message ${messageKind}`} role="status">{feedback(message)}</p>}
        {localSessions.length>0&&<button disabled={busy||samplingActive} onClick={()=>void act(async()=>{const planId=plan.id;await request("browser-session",{planId,surface:plan.config.surfaces[0],action:"close"});if(currentPlan.current===planId){setMessageKind("success");setMessage(t("browserLogin.thisPlanSLoginSessionsHaveEndedSetThemUpAgain"));}})}>{t("browserLogin.endThisPlanSLoginSessions")}</button>}
        <small className="muted browser-login-footnote">{t("browserLogin.thisOnlySetsUpWebAccountsDedicatedLoginSessionsAreCleared")}</small>
      </>}
    </details>
  </div>;
}
