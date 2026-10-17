import {t, useUiLanguage, uiMessage, getUiLanguage} from './i18n.tsx';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ArrowRight, CheckCircle2, Download, ExternalLink, FileSearch, LoaderCircle, RefreshCw, Settings2} from 'lucide-react';
import {request} from './api.ts';
import {downloadText} from './download.ts';
import type {KeywordAuditInput, KeywordAuditJob, KeywordAuditPreview, PageEvidence, KeywordAnalysis} from '../../src/console/keyword-audit.ts';
import {LoadingHelper} from './loading-helper.tsx';
import './keyword-audit.css';

type History = {id:string; property:string; startDate:string; endDate:string; country:string; captured_at:string; hash:string; dashboard:number};
type Brand = {id:string; name:string; owned_domains:string};
type Config = {
  providers:{id:'openai'|'anthropic'; label:string; available:boolean; model:string}[];
  locations:{code:number; country:string; label:string}[];
  dataForSeoConfigured:boolean;
  limits?:{serp:number; pages:number; llm:number};
};
type Props = {brandId:string; brand?:Brand; connectionsReady?:boolean; onGsc?:()=>void; onConnections?:()=>void};
type Comparison = KeywordAnalysis['comparisons'][number];
type Reference = Comparison['approach'][number]['evidence'][number];

type AuditPreferences = Pick<KeywordAuditInput,'countryCode'|'languageCode'|'device'|'provider'|'model'>;
function readAuditPreferences(brandId:string):Partial<AuditPreferences> {
  try {
    if(typeof localStorage==='undefined')return {};
    const value:unknown=JSON.parse(localStorage.getItem('getaudit.keywordAudit.settings:'+brandId)??'{}');
    if(!value||typeof value!=='object'||Array.isArray(value))return {};
    const v=value as Record<string,unknown>,saved:Partial<AuditPreferences>={};
    if(typeof v.countryCode==='number'&&Number.isInteger(v.countryCode))saved.countryCode=v.countryCode;
    if(typeof v.languageCode==='string'&&['en','fr','de','es','ja'].includes(v.languageCode))saved.languageCode=v.languageCode;
    if(v.device==='desktop'||v.device==='mobile')saved.device=v.device;
    if(v.provider==='openai'||v.provider==='anthropic')saved.provider=v.provider;
    if(typeof v.model==='string'&&v.model.trim()&&v.model.length<=120)saved.model=v.model;
    return saved;
  } catch{return {};}
}


export function auditLink(value:string):string|undefined {
  try {const u=new URL(value); return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.toString():undefined;} catch {return undefined;}
}
function host(value:string):string {
  try {return new URL(value.includes('://')?value:'https://'+value).hostname.toLowerCase().replace(/^www\./,'');} catch {return '';}
}
export function matchingAuditSnapshots(history:History[], domains:string[]):History[] {
  const owned=domains.map(host).filter(Boolean);
  return history.filter(s=>{
    const propertyHost=host(s.property.replace(/^sc-domain:/,''));
    return !!propertyHost&&owned.some(d=>propertyHost===d||propertyHost.endsWith('.'+d));
  }).sort((a,b)=>b.captured_at.localeCompare(a.captured_at));
}
function domains(value:string):string[] {try {const v:unknown=JSON.parse(value); return Array.isArray(v)?v.filter((s):s is string=>typeof s==='string'):[];} catch {return [];}}
function date(value:string):string {const d=new Date(value.includes('T')?value:value.replace(' ','T')+'Z');return Number.isNaN(d.getTime())?value:d.toLocaleString(t("keywordAudit.enUS"));}
function number(value:number):string {return new Intl.NumberFormat(t("keywordAudit.enUS"),{maximumFractionDigits:0}).format(value);}
function errorMessage(value:unknown):string {return value instanceof Error?value.message:t("keywordAudit.thisStepCouldNotBeCompletedTryAgain");}
const isRunning=(status:KeywordAuditJob['status'])=>status==='queued'||status==='running';
function auditStatusNames():Record<KeywordAuditJob['status'],string>{return {queued:t("keywordAudit.queued"),running:t("keywordAudit.analyzing"),complete:t("keywordAudit.analysisComplete"),partial:t("keywordAudit.partiallyComplete"),interrupted:t("keywordAudit.interrupted")};}
function priorityLabels(){return {high:t("keywordAudit.highPriority"),medium:t("keywordAudit.mediumPriority"),low:t("keywordAudit.lowPriority")};}
const priorityOrder={high:0,medium:1,low:2};
type ActionOverview={action:string;targetUrl:string;priority:Comparison['improvements'][number]['priority'];keywords:string[];competitorUrls:string[]};
export function summarizeKeywordAuditActions(keywords:KeywordAuditJob['keywords']):ActionOverview[] {
  const groups=new Map<string,ActionOverview>();
  for(const keyword of keywords)for(const comparison of keyword.analysis?.comparisons??[])for(const improvement of comparison.improvements){
    const normalized=improvement.action.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');
    const key=JSON.stringify([improvement.targetUrl,normalized]);
    const current=groups.get(key);
    if(!current){groups.set(key,{action:improvement.action,targetUrl:improvement.targetUrl,priority:improvement.priority,keywords:[keyword.keyword],competitorUrls:[comparison.competitorUrl]});continue;}
    if(!current.keywords.includes(keyword.keyword))current.keywords.push(keyword.keyword);
    if(!current.competitorUrls.includes(comparison.competitorUrl))current.competitorUrls.push(comparison.competitorUrl);
    if(priorityOrder[improvement.priority]<priorityOrder[current.priority])current.priority=improvement.priority;
  }
  return [...groups.values()].sort((a,b)=>priorityOrder[a.priority]-priorityOrder[b.priority]);
}
function SourceLink({url,children}:{url:string;children?:React.ReactNode}) {
  const href=auditLink(url);
  return href?<a href={href} target="_blank" rel="noreferrer">{children??url}<ExternalLink size={12} aria-hidden="true"/></a>:<span>{children??url}</span>;
}
function EvidenceQuotes({references,sources}:{references:Reference[];sources:PageEvidence[]}) {
  if(!references.length)return null;
  return <details className="keyword-audit-quotes"><summary>{t("keywordAudit.viewEvidence", { count: references.length })}</summary>{references.map((ref,i)=>{
    const source=sources.find(s=>s.id===ref.sourceId);
    return <div key={ref.sourceId+':'+i}><blockquote>{ref.quote}</blockquote>{source?<><SourceLink url={source.resolvedUrl||source.url}/><small>{t("keywordAudit.pageReadAt")} {date(source.observedAt)} {t("keywordAudit.source")} {source.id}</small></>:<small>{t("common.source")} {ref.sourceId} {t("keywordAudit.pageEvidenceNotReturned")}</small>}</div>;
  })}</details>;
}
function Findings({items,sources,empty}:{items:Comparison['approach'];sources:PageEvidence[];empty:string}) {
  return items.length?<ul className="keyword-audit-findings">{items.map((item,i)=><li key={i}><p>{item.text}</p><EvidenceQuotes references={item.evidence} sources={sources}/></li>)}</ul>:<p className="muted">{empty}</p>;
}
function ComparisonView({comparison,sources}:{comparison:Comparison;sources:PageEvidence[]}) {
  return <article className="keyword-audit-comparison">
    <header><span className="keyword-audit-rank">{t("keywordAudit.organicPositionActualRank", { actualRank: comparison.actualRank })}</span><SourceLink url={comparison.competitorUrl}/></header>
    <div className="keyword-audit-comparison-grid"><section><h4>{t("keywordAudit.whatTheCompetingPageDoes")}</h4><Findings items={comparison.approach} sources={sources} empty={t("keywordAudit.thereIsNotEnoughPageEvidenceToAssessItsApproach")}/></section><section><h4>{t("keywordAudit.gapsInOurPage")}</h4><Findings items={comparison.gaps} sources={sources} empty={t("keywordAudit.noComparableGapHasBeenConfirmed")}/></section></div>
    <section className="keyword-audit-actions"><h4>{t("keywordAudit.specificImprovements")}</h4>{comparison.improvements.length?comparison.improvements.map((action,i)=><article key={i}>
      <div className="keyword-audit-action-title"><span className={'keyword-audit-priority '+action.priority}>{priorityLabels()[action.priority]}</span><h5>{action.action}</h5></div>
      <p><strong>{t("keywordAudit.pageToUpdate")}</strong><SourceLink url={action.targetUrl}/></p><p><strong>{t("keywordAudit.evidenceAndPurpose")}</strong>{action.reason}</p><p><strong>{t("keywordAudit.acceptanceChecks")}</strong>{action.acceptance}</p><p><strong>{t("keywordAudit.followUpMeasurement")}</strong>{action.followUp}</p><EvidenceQuotes references={action.evidence} sources={sources}/>
    </article>):<p className="muted">{t("keywordAudit.evidenceIsInsufficientNoSpecificImprovementHasBeenGenerated")}</p>}</section>
    {!!comparison.unknowns.length&&<div className="keyword-audit-warning"><strong>{t("keywordAudit.stillToVerify")}</strong><ul>{comparison.unknowns.map((text,i)=><li key={i}>{text}</li>)}</ul></div>}
  </article>;
}
function PageProof({page}:{page:PageEvidence}) {
  return <div className="keyword-audit-page-proof"><div><span className={page.status==='available'?'keyword-audit-ok':'keyword-audit-missing'}>{page.status==='available'?t("keywordAudit.pageRead"):t("keywordAudit.pageNotRead")}</span><SourceLink url={page.url}/></div>{page.status==='unavailable'?<p>{page.error?uiMessage(page.error):t("keywordAudit.thisPageCouldNotBeAccessedASearchSnippetCannotEstablish")}</p>:<p>{page.title||t("keywordAudit.noPageTitleReturned")}</p>}{page.resolvedUrl!==page.url&&page.resolvedUrl&&<p>{t("keywordAudit.finalURL")} <SourceLink url={page.resolvedUrl}/></p>}<small>{t("keywordAudit.readAt")} {date(page.observedAt)} {t("keywordAudit.source")} {page.id}</small><small className="keyword-audit-hash">SHA-256 {page.hash}</small></div>;
}
export function KeywordAuditResult({item,index}:{item:KeywordAuditJob['keywords'][number];index:number}) {
  useUiLanguage();
  const sources=[...(item.ownerEvidence?[item.ownerEvidence]:[]),...item.competitorEvidence];
  return <article className="keyword-audit-result">
    <header className="keyword-audit-result-head"><div><span>{t("keywordAudit.opportunityKeyword")} {index+1}</span><h3>{item.keyword}</h3><p>{t("keywordAudit.gSCAveragePosition")} <strong>{item.position.toFixed(2)}</strong>  {t("keywordAudit.impressions")} {number(item.impressions)} {t("keywordAudit.clicks")} {number(item.clicks)}</p></div><span className={item.analysis?'keyword-audit-ok':'keyword-audit-missing'}>{item.analysis?t("keywordAudit.pageComparisonGenerated"):item.error?t("keywordAudit.analysisIncomplete"):t("keywordAudit.awaitingAnalysis")}</span></header>
    <div className="keyword-audit-owner"><strong>{t("keywordAudit.priorityPageToImprove")}</strong>{item.ownerUrl?<SourceLink url={item.ownerUrl}/>:<span>{t("keywordAudit.theSnapshotHasNoMatchingPageAddQueryAndPageDetails")}</span>}</div>
    {item.error&&<p className="keyword-audit-warning">{uiMessage(item.error)}</p>}
    <details className="keyword-audit-result-details"><summary>{t("keywordAudit.keywordEvidence")}</summary>
    <div className="keyword-audit-serp"><h4>{t("keywordAudit.topThreeCompetingPages")}</h4><p className="muted">{t("keywordAudit.selectsThreeExternalPagesByOrganicPositionAfterExcludingOwnedDomains")}</p>{item.serp?.competitors?.length?<ol>{item.serp.competitors.map((row,i)=><li key={row.url+':'+i}><span>{t("keywordAudit.sampleValueOrganicPositionActualRank", { value: i+1, actualRank: row.actualRank })}</span><div><SourceLink url={row.url}>{row.title||row.url}</SourceLink><small>{row.url}</small><small>{item.competitorEvidence.find(page=>page.url===row.url)?.status==='available'?t("keywordAudit.pageBodyRead"):item.competitorEvidence.find(page=>page.url===row.url)?.status==='unavailable'?t("keywordAudit.pageAccessLimitedNoUnsupportedConclusions"):t("keywordAudit.waitingToReadThePageBody")}</small></div></li>)}</ol>:<p className="keyword-audit-warning">{item.serp?.error?uiMessage(item.serp.error):t("keywordAudit.organicPositionsHaveNotBeenReadYet")}</p>}{item.serp?.status==='available'&&item.serp.competitors.length<3&&<p className="keyword-audit-warning">{t("keywordAudit.onlyCompetitorCount3ExternalOrganicResultsWereRetrievedForThisKeyword", { competitorCount: item.serp.competitors.length })}</p>}{item.serp&&<p className="keyword-audit-caption">{item.serp.source} {t("keywordAudit.googleLocationCode")} {item.serp.conditions.countryCode} · {item.serp.conditions.languageCode} · {item.serp.conditions.device==='mobile'?t("common.mobile"):t("common.desktop")}{item.serp.observedAt?' · '+date(item.serp.observedAt):''}</p>}</div>
    {item.analysis&&<><p className="keyword-audit-analysis-summary">{item.analysis.summary}</p>{item.analysis.comparisons.map((comparison,i)=><ComparisonView key={comparison.competitorUrl+':'+i} comparison={comparison} sources={sources}/>)}{!!item.analysis.unknowns.length&&<div className="keyword-audit-warning"><strong>{t("keywordAudit.evidenceGapsForThisKeyword")}</strong><ul>{item.analysis.unknowns.map((text,i)=><li key={i}>{text}</li>)}</ul></div>}</>}
    <details className="keyword-audit-page-evidence"><summary>{t("keywordAudit.pageTextSourcesAndReadStatus", { count: sources.length })}</summary>{sources.map(page=><PageProof key={page.id} page={page}/>)}<p className="muted">{t("keywordAudit.theJSONExportContainsSavedSourceTextAndFullOrganicResults")}</p></details>
    </details>
  </article>;
}

export function KeywordAuditPanel({brandId,brand:providedBrand,connectionsReady=true,onGsc,onConnections}:Props) {
  useUiLanguage();
  const statusNames=auditStatusNames();
  const [history,setHistory]=useState<History[]>([]),[brand,setBrand]=useState<Brand|null>(null),[config,setConfig]=useState<Config|null>(null);
  const [snapshotId,setSnapshotId]=useState(''),[countryCode,setCountryCode]=useState(2124),[languageCode,setLanguageCode]=useState('en'),[device,setDevice]=useState<'desktop'|'mobile'>('desktop'),[provider,setProvider]=useState<'openai'|'anthropic'>('openai'),[model,setModel]=useState('');
  const [preview,setPreview]=useState<KeywordAuditPreview|null>(null),[jobs,setJobs]=useState<KeywordAuditJob[]>([]),[selectedId,setSelectedId]=useState(''),[selectedJob,setSelectedJob]=useState<KeywordAuditJob|null>(null);
  const [loading,setLoading]=useState(true),[previewing,setPreviewing]=useState(false),[starting,setStarting]=useState(false),[exporting,setExporting]=useState(false),[error,setError]=useState(''),[previewError,setPreviewError]=useState(''),[pollError,setPollError]=useState(''),[notice,setNotice]=useState('');
  const mounted=useRef(true),loadSequence=useRef(0),configSequence=useRef(0),wasConnectionsReady=useRef(connectionsReady),currentBrand=useRef(brandId),startingLock=useRef(false);currentBrand.current=brandId;
  const brandKey=providedBrand?.id===brandId?[providedBrand.id,providedBrand.name,providedBrand.owned_domains].join('|'):'';
  const snapshots=useMemo(()=>matchingAuditSnapshots(history,brand?domains(brand.owned_domains):[]),[history,brand]);
  const chosenSnapshot=snapshots.find(s=>s.id===snapshotId),chosenProvider=config?.providers.find(p=>p.id===provider),location=config?.locations.find(l=>l.code===countryCode);
  const input=useMemo<KeywordAuditInput>(()=>({brandId,snapshotId,countryCode,languageCode,device,provider,model:model.trim()}),[brandId,snapshotId,countryCode,languageCode,device,provider,model]);
  const inputKey=JSON.stringify(input);
  const snapshotMatches=!!chosenSnapshot&&chosenSnapshot.country!=='ALL'&&chosenSnapshot.country===location?.country;
  const runningJob=jobs.find(j=>isRunning(j.status));
  const extraRunningId=runningJob&&runningJob.id!==selectedId?runningJob.id:undefined;
  const jobForBrand=selectedJob?.brandId===brandId?selectedJob:null;
  const actions=useMemo(()=>jobForBrand?summarizeKeywordAuditActions(jobForBrand.keywords):[],[jobForBrand]);
  const previewMatches=!!preview&&(['brandId','snapshotId','countryCode','languageCode','device','provider','model'] as const).every(key=>preview.input[key]===input[key]);
  const canStart=connectionsReady&&!!preview?.keywords.length&&previewMatches&&config?.dataForSeoConfigured&&chosenProvider?.available&&snapshotMatches&&!loading&&!previewing&&!starting&&!runningJob&&(!selectedId||!!jobForBrand);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;loadSequence.current++;};},[]);

  async function load() {
    if(!brandId){setLoading(false);return;}
    const id=brandId,seq=++loadSequence.current,configSeq=++configSequence.current;setLoading(true);setError('');
    try {
      const [nextHistory,nextConfig,state,nextJobs]=await Promise.all([request<History[]>('gsc/history'),request<Config>('keyword-audit/config'),brandKey&&providedBrand?Promise.resolve({brands:[providedBrand]}):request<{brands:Brand[]}>('state'),request<KeywordAuditJob[]>('keyword-audit/jobs?brandId='+encodeURIComponent(id))]);
      if(!mounted.current||seq!==loadSequence.current||currentBrand.current!==id)return;
      const nextBrand=state.brands.find(b=>b.id===id)??null,matched=matchingAuditSnapshots(nextHistory,nextBrand?domains(nextBrand.owned_domains):[]);
      setHistory(nextHistory);if(configSeq===configSequence.current)setConfig(nextConfig);setBrand(nextBrand);setJobs(nextJobs);
      const savedPreferences=readAuditPreferences(id);
      const preferredLocation=nextConfig.locations.find(l=>l.code===savedPreferences.countryCode);
      const latest=(preferredLocation?matched.find(s=>s.country===preferredLocation.country):undefined)??matched.find(s=>nextConfig.locations.some(l=>l.country===s.country))??matched[0];
      setSnapshotId(old=>matched.some(s=>s.id===old)?old:latest?.id??'');
      const nextLocation=preferredLocation??nextConfig.locations.find(l=>l.country===latest?.country);if(nextLocation)setCountryCode(nextLocation.code);
      setLanguageCode(savedPreferences.languageCode??'en');setDevice(savedPreferences.device??'desktop');
      const available=nextConfig.providers.find(p=>p.id===savedPreferences.provider)??nextConfig.providers.find(p=>p.available)??nextConfig.providers[0];
      if(available){setProvider(available.id);setModel(savedPreferences.provider===available.id&&savedPreferences.model?savedPreferences.model:available.model);}
      const saved=sessionStorage.getItem('keyword-audit-selected:'+id),preferred=nextJobs.find(j=>j.id===saved)??nextJobs.find(j=>isRunning(j.status))??nextJobs[0];
      setSelectedId(preferred?.id??'');setSelectedJob(preferred??null);
    } catch(e){if(mounted.current&&seq===loadSequence.current&&currentBrand.current===id)setError(errorMessage(e));}
    finally {if(mounted.current&&seq===loadSequence.current&&currentBrand.current===id)setLoading(false);}
  }
  useEffect(()=>{
    setHistory([]);setBrand(null);setPreview(null);setJobs([]);setSelectedId('');setSelectedJob(null);setPreviewError('');setPollError('');setNotice('');
    void load();return()=>{loadSequence.current++;};
  },[brandId,brandKey]);
  useEffect(()=>{
    const becameReady=connectionsReady&&!wasConnectionsReady.current;wasConnectionsReady.current=connectionsReady;
    if(!becameReady||!brandId)return;
    let live=true;const id=brandId,sequence=++configSequence.current;
    // Refresh availability without resetting the chosen snapshot, model, market or report.
    request<Config>('keyword-audit/config').then(next=>{
      if(live&&mounted.current&&currentBrand.current===id&&sequence===configSequence.current)setConfig(next);
    }).catch(e=>{if(live&&mounted.current&&currentBrand.current===id)setError(errorMessage(e));});
    return()=>{live=false;};
  },[connectionsReady,brandId]);
  useEffect(()=>{if(selectedId&&brandId)sessionStorage.setItem('keyword-audit-selected:'+brandId,selectedId);},[selectedId,brandId]);

  useEffect(()=>{
    let live=true;setPreview(null);setPreviewError('');
    if(!chosenSnapshot||!model.trim()||!snapshotMatches){setPreviewing(false);return;}
    setPreviewing(true);
    const timer=setTimeout(()=>{
      request<KeywordAuditPreview>('keyword-audit/preview',input).then(value=>{if(live)setPreview(value);}).catch(e=>{if(live)setPreviewError(errorMessage(e));}).finally(()=>{if(live)setPreviewing(false);});
    },180);
    return()=>{live=false;clearTimeout(timer);};
  },[inputKey,snapshotMatches,chosenSnapshot?.id]);

  useEffect(()=>{
    if(!selectedId||!brandId)return;
    let live=true,reading=false,timer:ReturnType<typeof setTimeout>|undefined;
    const read=async()=>{
      if(!live||reading||document.hidden)return;
      reading=true;
      try {
        const ids=[selectedId,...(extraRunningId?[extraRunningId]:[])];
        const results=await Promise.all(ids.map(id=>request<KeywordAuditJob>('keyword-audit/job?id='+encodeURIComponent(id))));
        if(!live)return;
        const valid=results.filter(job=>job.brandId===brandId),selected=valid.find(job=>job.id===selectedId);
        if(selected)setSelectedJob(selected);setPollError('');
        setJobs(old=>[...valid,...old.filter(job=>!valid.some(v=>v.id===job.id))].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
        if(valid.some(job=>isRunning(job.status)))timer=setTimeout(()=>void read(),2500);
      } catch(e){if(live){setPollError(errorMessage(e));timer=setTimeout(()=>void read(),5000);}}
      finally {reading=false;}
    };
    const visible=()=>{if(!document.hidden){if(timer)clearTimeout(timer);void read();}};
    void read();document.addEventListener('visibilitychange',visible);
    return()=>{live=false;if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
  },[selectedId,brandId,extraRunningId]);

  function rememberSettings(patch:Partial<AuditPreferences>) {
    if(!brandId)return;
    try {if(typeof localStorage!=='undefined')localStorage.setItem('getaudit.keywordAudit.settings:'+brandId,JSON.stringify({countryCode,languageCode,device,provider,model,...patch}));}catch{/* Storage may be unavailable; the current run remains usable. */}
  }
  function chooseSnapshot(id:string) {
    setSnapshotId(id);const s=snapshots.find(s=>s.id===id),matched=config?.locations.find(l=>l.country===s?.country);if(matched){setCountryCode(matched.code);rememberSettings({countryCode:matched.code});}
  }
  function chooseProvider(id:'openai'|'anthropic') {setProvider(id);const p=config?.providers.find(p=>p.id===id);if(p){setModel(p.model);rememberSettings({provider:id,model:p.model});}}
  async function start() {
    if(!canStart||startingLock.current)return;startingLock.current=true;setStarting(true);setError('');setNotice('');const id=brandId;
    try {
      const job=await request<{id:string;status:KeywordAuditJob['status']}>('keyword-audit/start',input);
      if(!mounted.current||currentBrand.current!==id)return;
      setSelectedId(job.id);setSelectedJob(null);setNotice(t("keywordAudit.taskCreatedPageComparisonsAndImprovementPlansWillBeGeneratedAutomatically"));
    } catch(e){if(mounted.current&&currentBrand.current===id)setError(errorMessage(e));}
    finally{startingLock.current=false;if(mounted.current)setStarting(false);}
  }
  async function exportMarkdown() {
    if(!jobForBrand||exporting)return;setExporting(true);setError('');const id=jobForBrand.id,current=brandId;
    try{const result=await request<{text:string}>('keyword-audit/markdown?id='+encodeURIComponent(id)+'&uiLocale='+getUiLanguage());if(!mounted.current||currentBrand.current!==current)return;downloadText('keyword-opportunity-audit-'+id.slice(0,8)+'.md',result.text,'text/markdown;charset=utf-8');}
    catch(e){if(mounted.current&&currentBrand.current===current)setError(errorMessage(e));}finally{if(mounted.current)setExporting(false);}
  }

  return <section className="panel keyword-audit seo-audit-desk" aria-labelledby="keyword-audit-title">
    <header className="keyword-audit-head"><div><h2 id="keyword-audit-title">{t("keywordAudit.fiveKeywordOpportunities")}</h2><p>{t("keywordAudit.quickIntro")}</p></div><button disabled={loading||starting} onClick={()=>void load()}><RefreshCw size={15} className={loading?'keyword-audit-spin':''}/>{loading?t("keywordAudit.reading"):t("keywordAudit.refreshLocalMaterial")}</button></header>
    {(loading||starting||previewing||(selectedId&&!jobForBrand))&&<LoadingHelper compact active phase={loading?'entry':'records'} title={loading?t("keywordAudit.loadingSavedMaterial"):starting?t("keywordAudit.creatingTheAnalysisTask"):previewing?t("keywordAudit.selectingOpportunityKeywords"):t("keywordAudit.readingTaskProgress")} detail={t("keywordAudit.theCurrentRequestIsInProgressYourSelectionsStayInPlace")}/>}

    {error&&<p className="keyword-audit-warning" role="alert">{uiMessage(error)}</p>}{notice&&<p className="keyword-audit-notice" role="status">{uiMessage(notice)}</p>}
    {!brandId?<div className="keyword-audit-empty"><FileSearch size={26}/><h3>{t("keywordAudit.chooseABrandToAnalyze")}</h3><p>{t("keywordAudit.createTheSiteInBrandsProjectsOpportunityKeywordsWillUseThat")}</p></div>:!loading&&!snapshots.length?<div className="keyword-audit-empty"><FileSearch size={26}/><h3>{t("keywordAudit.noGSCSnapshotForBrandNameYet", { brandName: brand?.name??t("common.thisBrand") })}</h3><p>{t("keywordAudit.saveWebSearchDataForTheTargetCountryInGSCIncluding")}</p>{onGsc&&<button className="primary" onClick={onGsc}>{t("keywordAudit.goToGSCToReadData")}<ArrowRight size={14}/></button>}</div>:<details className="keyword-audit-setup" open={!jobForBrand}><summary>{t(jobForBrand?"keywordAudit.newAnalysis":"keywordAudit.chooseOpportunityKeywords")}</summary>
      <form className="keyword-audit-form" onSubmit={e=>{e.preventDefault();void start();}}>
        <label className="field keyword-audit-snapshot"><span>{t("keywordAudit.gSCSnapshotToUse")}</span><select value={snapshotId} disabled={loading||starting} onChange={e=>chooseSnapshot(e.target.value)}>{!snapshotId&&<option value="">{t("keywordAudit.chooseASavedSnapshot")}</option>}{snapshots.map(s=><option key={s.id} value={s.id}>{s.property.replace('sc-domain:','')} · {s.startDate} {t("keywordAudit.to")} {s.endDate} · {s.country} · {date(s.captured_at)}</option>)}</select></label>
        <details className="keyword-audit-options keyword-audit-full"><summary>{t("keywordAudit.analysisSettings")}<span>{location?uiMessage(location.label):''} · {languageCode} · {device==='mobile'?t("common.mobile"):t("common.desktop")}</span></summary><div>
        <label className="field"><span>{t("keywordAudit.targetMarketForOrganicResults")}</span><select value={countryCode} disabled={starting} onChange={e=>{setCountryCode(Number(e.target.value));rememberSettings({countryCode:Number(e.target.value)});}}>{config?.locations.map(l=><option key={l.code} value={l.code}>{uiMessage(l.label)}</option>)}</select></label>
        <label className="field"><span>{t("keywordAudit.searchLanguage")}</span><select value={languageCode} disabled={starting} onChange={e=>{setLanguageCode(e.target.value);rememberSettings({languageCode:e.target.value});}}><option value="en">{t("common.english")}</option><option value="fr">{t("keywordAudit.french")}</option><option value="de">{t("keywordAudit.german")}</option><option value="es">{t("keywordAudit.spanish")}</option><option value="ja">{t("keywordAudit.japanese")}</option></select></label>
        <label className="field"><span>{t("keywordAudit.deviceForOrganicResults")}</span><select value={device} disabled={starting} onChange={e=>{const next=e.target.value as 'desktop'|'mobile';setDevice(next);rememberSettings({device:next});}}><option value="desktop">{t("common.desktop")}</option><option value="mobile">{t("common.mobile")}</option></select></label>
        <label className="field"><span>{t("keywordAudit.analysisProvider")}</span><select value={provider} disabled={starting} onChange={e=>chooseProvider(e.target.value as 'openai'|'anthropic')}>{config?.providers.map(p=><option key={p.id} value={p.id}>{p.label}{p.available?'':t("keywordAudit.notConfigured")}</option>)}</select></label>
        <label className="field keyword-audit-model"><span>{t("keywordAudit.analysisModel")}</span><input value={model} maxLength={120} disabled={starting} onChange={e=>{setModel(e.target.value);rememberSettings({model:e.target.value});}} placeholder={t("keywordAudit.connectToViewASuggestedModel")}/></label>
        </div></details>
        <p className="keyword-audit-caption keyword-audit-full">{t("keywordAudit.gSCPositionsAreAveragesOverTheSelectedDatesCompetingPagesUse")}</p>
        {!!chosenSnapshot&&!snapshotMatches&&<p className="keyword-audit-warning keyword-audit-full">{chosenSnapshot.country==='ALL'?t("keywordAudit.thisSnapshotCombinesAllCountriesReadTheTargetCountrySGSC"):t("keywordAudit.theGSCCountryDiffersFromTheTargetMarketChooseTheSame")}</p>}
        {(!config?.dataForSeoConfigured||!chosenProvider?.available)&&!loading&&<div className="keyword-audit-connection keyword-audit-full"><div><strong>{t("keywordAudit.connectTheAnalysisServicesToBegin")}</strong><p>{!config?.dataForSeoConfigured?t("keywordAudit.dataForSEOIsNeededToReadOrganicPositions"):''}{!chosenProvider?.available?t("keywordAudit.theSelectedAnalysisProviderNeedsAnAPIKey"):''}{t("keywordAudit.savedSnapshotsCanStillBePreviewedLocallyPreviewingDoesNotTrigger")}</p></div>{onConnections&&<button type="button" onClick={onConnections}><Settings2 size={14}/>{t("keywordAudit.openAPIConnections")}</button>}</div>}
        {!!preview?.shortfall&&<p className="keyword-audit-warning keyword-audit-full">{t("keywordAudit.fewerThanFiveKeywordsQualifyThisRunAnalyzes", { count: preview.keywords.length })}</p>}
        <div className="keyword-audit-start keyword-audit-full"><div><strong>{t("keywordAudit.upTo5KeywordsAnd15CompetingPages")}</strong><p>{t("keywordAudit.startingSendsSelectedKeywordsToDataForSEOReadsPublicPagesAndSends", { searches: config?.limits?.serp??5, pages: config?.limits?.pages??20, analyses: config?.limits?.llm??5 })}</p></div><button className="primary" type="submit" disabled={!canStart}>{starting?<LoaderCircle size={15} className="keyword-audit-spin"/>:<FileSearch size={15}/>} {starting?t("keywordAudit.creatingTask"):runningJob?t("keywordAudit.aTaskIsAlreadyRunning"):t("keywordAudit.analyzeAndGenerateReport")}</button></div>
      </form>
      {previewing&&<p className="keyword-audit-local-status" role="status"><LoaderCircle size={14} className="keyword-audit-spin"/>{t("keywordAudit.selectingOpportunityKeywordsFromTheSavedSnapshot")}</p>}{previewError&&<p className="keyword-audit-warning" role="alert">{uiMessage(previewError)}</p>}
      {preview&&<details className="keyword-audit-preview"><summary><strong>{t("keywordAudit.savedMaterial")}</strong><span>{t("keywordAudit.fiveKeywordCandidatePool", { selected: preview.keywords.length, candidateCount: preview.candidateCount })}</span></summary><p className="keyword-audit-caption">{preview.snapshot.property} · {preview.snapshot.startDate} {t("keywordAudit.to")} {preview.snapshot.endDate} · {preview.snapshot.country} · {preview.snapshot.device} {t("keywordAudit.gSCAveragePositionContext2")}</p><div className="keyword-audit-table-scroll"><table><thead><tr><th>{t("keywordAudit.keywords")}</th><th>{t("common.averagePosition")}</th><th>{t("keywordAudit.impressionsClicks")}</th><th>{t("keywordAudit.priorityPageAndSelectionEvidence")}</th></tr></thead><tbody>{preview.keywords.map(k=><tr key={k.keyword}><td><strong>{k.keyword}</strong></td><td>{k.position.toFixed(2)}</td><td>{number(k.impressions)} / {number(k.clicks)}<small>CTR {(k.ctr*100).toFixed(2)}%</small></td><td>{k.ownerUrl?<SourceLink url={k.ownerUrl}/>:<span>{t("keywordAudit.noQueryAndPageDetails")}</span>}<p>{uiMessage(k.reason)}</p>{k.ownerAlternatives.length>0&&<small>{t("keywordAudit.thisQueryAlsoMatches", { count: k.ownerAlternatives.length })}</small>}</td></tr>)}</tbody></table></div>{!preview.keywords.length&&<p className="keyword-audit-empty-inline">{t("keywordAudit.thisSnapshotHasNoEligibleQueriesAtPositions1120Try")}</p>}{!!preview.warnings.length&&<details className="keyword-audit-warning-details"><summary>{t("keywordAudit.selectionScopeAndEvidenceLimits")}</summary><ul>{preview.warnings.map((w,i)=><li key={i}>{uiMessage(w)}</li>)}</ul></details>}</details>}
    </details>}
    {!!jobs.length&&<details className="keyword-audit-history-disclosure"><summary>{t("keywordAudit.history")}</summary><div className="keyword-audit-history"><label className="field"><span>{t("keywordAudit.savedAnalysisTasks")}</span><select value={selectedId} onChange={e=>{setSelectedId(e.target.value);setSelectedJob(jobs.find(j=>j.id===e.target.value)??null);}}>{jobs.map(j=><option key={j.id} value={j.id}>{date(j.createdAt)} · {statusNames[j.status]} · {t("keywordAudit.keywordsContext2", { count: j.preview.keywords.length })} · {j.input.provider} / {j.input.model}</option>)}</select></label>{runningJob&&runningJob.id!==selectedId&&<button onClick={()=>{setSelectedId(runningJob.id);setSelectedJob(runningJob);}}>{t("keywordAudit.viewTheRunningTask")}</button>}</div></details>}
    {pollError&&<p role="alert" className="keyword-audit-warning">{t("keywordAudit.couldNotReadProgressTheTaskWasNotResubmitted")} {uiMessage(pollError)}</p>}
    {selectedId&&!jobForBrand&&<p className="keyword-audit-local-status" role="status"><LoaderCircle size={14} className="keyword-audit-spin"/>{t("keywordAudit.taskSubmittedReadingItsSavedProgress")}</p>}
    {jobForBrand&&<section className="keyword-audit-report" aria-labelledby="keyword-audit-report-title"><header className="keyword-audit-report-head"><div><h3 id="keyword-audit-report-title">{statusNames[jobForBrand.status]}</h3><p>{jobForBrand.preview.snapshot.property} · GSC {jobForBrand.preview.snapshot.startDate} {t("keywordAudit.to")} {jobForBrand.preview.snapshot.endDate} · {jobForBrand.preview.snapshot.country}</p><p>{jobForBrand.input.provider} / {jobForBrand.input.model} {t("keywordAudit.updatedAt")} {date(jobForBrand.updatedAt)}</p></div><div className="keyword-audit-export"><button disabled={exporting} onClick={()=>void exportMarkdown()}><Download size={14}/>{t("keywordAudit.downloadMarkdown")}</button><button onClick={()=>downloadText('keyword-opportunity-audit-'+jobForBrand.id.slice(0,8)+'.json',JSON.stringify(jobForBrand,null,2),'application/json;charset=utf-8')}><Download size={14}/>{t("keywordAudit.downloadFullEvidenceJSON")}</button></div></header>
      <div className="keyword-audit-progress" aria-live="polite"><span>{isRunning(jobForBrand.status)?<LoaderCircle size={15} className="keyword-audit-spin"/>:<CheckCircle2 size={15}/>} {t("keywordAudit.keywords")} {jobForBrand.completion.keywords} / {jobForBrand.preview.keywords.length}</span><span>{t("keywordAudit.competingPages")} {jobForBrand.completion.competitorSlots} / 15</span><span>{t("keywordAudit.completedComparisons")} {jobForBrand.completion.comparisons} / 15</span></div>
      {isRunning(jobForBrand.status)&&<LoadingHelper compact active phase="citations" title={jobForBrand.status==='queued'?t("keywordAudit.analysisQueued"):t("keywordAudit.readingAndAnalyzingCompetingPages")} detail={t("keywordAudit.youCanSwitchPagesWhileThisTaskContinuesTheCountersAbove")}/>}{jobForBrand.status!=='complete'&&!isRunning(jobForBrand.status)&&<p className="keyword-audit-warning">{t("keywordAudit.theseArePartialResultsMissingKeywordsPositionsOrPageEvidenceRetain")}</p>}
      {!!jobForBrand.warnings.length&&<details className="keyword-audit-warning-details" open={jobForBrand.status==='partial'||jobForBrand.status==='interrupted'}><summary>{t("keywordAudit.evidenceAndCompletionDetails")}</summary><ul>{jobForBrand.warnings.map((w,i)=><li key={i}>{uiMessage(w)}</li>)}</ul></details>}
      {!!actions.length&&<section className="keyword-audit-action-overview" aria-labelledby="keyword-audit-actions-title"><header><h4 id="keyword-audit-actions-title">{t("keywordAudit.improvementTaskOverview")}</h4><span>{t("keywordAudit.specificTasks", { count: actions.length })}</span></header><p className="keyword-audit-caption">{t("keywordAudit.identicalActionsForTheSamePageAreCombinedAtTheirHighest")}</p><ol>{actions.map((action,i)=><li key={action.targetUrl+':'+i}><div><span className={'keyword-audit-priority '+action.priority}>{priorityLabels()[action.priority]}</span><strong>{action.action}</strong></div><p>{t("keywordAudit.pageToUpdate")} <SourceLink url={action.targetUrl}/></p><p>{t("keywordAudit.supportingKeywords")} <span>{action.keywords.join(', ')}</span></p><details><summary>{t("keywordAudit.evidenceForThisActionFrom", { count: action.competitorUrls.length })}</summary>{action.competitorUrls.map(url=><p key={url}><SourceLink url={url}/></p>)}</details></li>)}</ol></section>}
      {jobForBrand.keywords.map((item,i)=><KeywordAuditResult key={item.keyword} item={item} index={i}/>)}
      <details className="keyword-audit-provenance"><summary>{t("keywordAudit.sourcesCollectionConditionsAndFrozenRecords")}</summary><dl><dt>{t("keywordAudit.task")}</dt><dd>{jobForBrand.id}</dd><dt>{t("keywordAudit.snapshot")}</dt><dd>{jobForBrand.preview.snapshot.id}</dd><dt>{t("keywordAudit.gSCSource")}</dt><dd>{jobForBrand.preview.snapshot.property} · {jobForBrand.preview.snapshot.startDate} {t("keywordAudit.to")} {jobForBrand.preview.snapshot.endDate} · {jobForBrand.preview.snapshot.country} · {jobForBrand.preview.snapshot.device} · {jobForBrand.preview.snapshot.type}</dd><dt>{t("keywordAudit.organicObservationConditions")}</dt><dd>Google · {config?.locations.find(l=>l.code===jobForBrand.input.countryCode)?.label?uiMessage(config!.locations.find(l=>l.code===jobForBrand.input.countryCode)!.label):jobForBrand.input.countryCode} · {jobForBrand.input.languageCode} · {jobForBrand.input.device==='mobile'?t("common.mobile"):t("common.desktop")}</dd><dt>{t("keywordAudit.gSCSnapshotSHA256")}</dt><dd>{jobForBrand.preview.snapshot.hash}</dd><dt>{t("keywordAudit.inputSHA256")}</dt><dd>{jobForBrand.inputHash}</dd>{jobForBrand.reportHash&&<><dt>{t("keywordAudit.reportSHA256")}</dt><dd>{jobForBrand.reportHash}</dd></>}<dt>{t("keywordAudit.requestCounts")}</dt><dd>{t("keywordAudit.searchesContext2", { searches: jobForBrand.requests.serp, pages: jobForBrand.requests.pages, modelCalls: jobForBrand.requests.llm })}</dd></dl><p>{t("keywordAudit.aHighPositionDoesNotEstablishWhyAPageRanksReview")}</p></details>
    </section>}
  </section>;
}
