import React,{useEffect,useState} from "react";
import {t,useUiLanguage,uiMessage} from "./i18n.tsx";
import {samplingMessage} from "./sampling-messages.ts";
import {LoadingHelper} from "./loading-helper.tsx";
import {downloadText as download} from "./download.ts";
import {request} from "./api.ts";
import {downloadAnswers} from './answer-download.ts';
import type {identifySources} from "../../src/console/sources.ts";
import type {LabService} from "../../src/console/service.ts";
import {surfaces} from "../../src/console/contracts.ts";
type Sources=ReturnType<typeof identifySources>;
const names:Record<string,string>=Object.fromEntries(Object.entries(surfaces).map(([id,s])=>[id,s.name]));
export function SourcesPanel({plan}:{plan:ReturnType<LabService["plan"]>}){
  const language=useUiLanguage();
  const feedback=(value:string|null|undefined)=>samplingMessage(uiMessage(value),language);
  const [loaded,setData]=useState<Sources|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(""),[query,setQuery]=useState(""),[page,setPage]=useState(0);
  const revision=plan.slots.map(s=>`${s.latest?.hash}:${s.latest?.review?.decision}:${s.latest?.integrity}`).join("|");
  useEffect(()=>{let live=true;setError("");setLoading(true);request<Sources>("plan-sources?id="+plan.id).then(d=>{if(live)setData(d);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[plan.id,revision]);
  useEffect(()=>{setPage(0);},[query,plan.id]);
  const data=loaded?.planId===plan.id?loaded:null;
  useEffect(()=>{setPage(0);},[data?.hash]);
  if(!plan.slots.some(s=>s.latest))return null;
  const rows=data?.pages.filter(p=>[p.host,p.title,p.url,...p.occurrences.map(o=>o.prompt)].join(" ").toLowerCase().includes(query.toLowerCase()))??[];
  return <section className="panel source-inventory">
    <div className="section-head"><div><h2>{t("sources.visibleSearchSources")}</h2><p className="muted">{t("sources.updatesAfterEachSavedCapture")}{plan.config.accountMode==="signed_in_private"?t("sources.platformTemporaryMode"):plan.config.accountMode==="isolated"?t("sources.independentPrivateSession"):t("sources.signedOutBaseline")}</p></div>
      {data&&<div className="button-row"><button onClick={()=>downloadAnswers(plan.id).catch(e=>setError(e.message))}>{t("sources.answersSourcesMd")}</button><button onClick={()=>download("geo-sources.json",JSON.stringify(data,null,2),"application/json")}>{t("sources.sourcesJSON")}</button><button onClick={()=>{
        const cell=(v:unknown)=>{let t=String(v??"");if(/^\s*[=+@-]/.test(t))t="'"+t;return '"'+t.replaceAll('"','""')+'"';};
        const rows=[[t("common.question"),t("sources.platform"),t("sources.accountCondition"),t("sources.observedAccountState"),t("sources.locationVerification"),t("sources.exitCountry"),t("sources.observedAt"),t("sources.sourceTitle"),t("sources.sourceSite"),t("sources.pageURL"),t("sources.ownedSite"),t("sources.linkPlacement"),t("sources.completeSourceCoverage"),t("sources.review"),t("sources.metricEligible"),t("sources.evidenceHash")],...data.pages.flatMap(p=>p.occurrences.map(o=>[o.prompt,names[o.surface],data.accountMode,o.account,o.geo,o.exitCountry,o.observedAt,o.title,o.host,o.url,o.owned?t("common.yes"):t("common.no"),o.placement,o.rangeComplete?t("common.yes"):t("common.unknown"),o.review,o.eligible?t("common.yes"):t("common.no"),o.evidenceHash]))];
        download("geo-sources.csv","\uFEFF"+rows.map(r=>r.map(cell).join(",")).join("\r\n"),"text/csv;charset=utf-8");
      }}>{t("sources.sourcesCSV")}</button></div>}
    </div>
    {loading&&<LoadingHelper active phase="entry" compact title={t("sources.readingSavedSources")} detail={t("sources.thisReadsTheLocalRecordsItDoesNotCollectNewAnswers")}/>}
    {error&&<p className="alert error" role="alert">{feedback(error)}</p>}
    {data&&<><p>{t("sources.sourceSites", { siteCount: data.sites.length, pageCount: data.pages.length, complete: data.completeSourcePositions, total: data.totalPositions })}</p><p className="muted">{feedback(data.scope)}</p>
      {!!data.unresolved&&<p className="warning">{t("sources.linksCouldNotBeResolvedTargetURLsWereNotGuessed", { count: data.unresolved })}</p>}
      <div className="table-scroll"><table><thead><tr><th>{t("sources.sourceSite")}</th><th>{t("sources.pages")}</th><th>{t("sources.questionsCovered")}</th><th>{t("sources.observations")}</th><th>{t("sources.platform")}</th></tr></thead><tbody>{data.sites.slice(0,10).map(s=><tr key={s.host}><td>{s.host} {s.owned&&<span className="tag">{t("sources.ownedSite")}</span>}</td><td>{s.pageCount}</td><td>{s.questionCount}</td><td>{s.observationCount}<small>{t("sources.metricEligibleObservations", { count: s.eligibleObservations })}</small></td><td>{s.surfaces.map(s=>names[s]).join(" / ")}</td></tr>)}</tbody></table></div>
      {data.sites.length>10&&<p className="muted">{t("sources.theSiteSummaryShowsTheFirst10TheCompleteSourceList")}</p>}
      <input aria-label={t("sources.searchSourcesOrRelatedQuestions")} placeholder={t("sources.searchSourceTitlesDomainsURLsOrQuestions")} value={query} onChange={e=>setQuery(e.target.value)}/>
      <div className="source-pages">{rows.slice(page*20,(page+1)*20).map(p=><details key={p.url}><summary><strong>{p.title}</strong><span>{p.host} · {t("sources.questions", { questionCount: p.questionCount, observationCount: p.observationCount })}</span></summary><p><a href={p.url} target="_blank" rel="noreferrer">{p.url}</a></p>{p.occurrences.map(o=><p key={o.slotId}><strong>{names[o.surface]}</strong> · {o.prompt}<br/><small>{(o.quality?.label?feedback(o.quality.label):t("sources.sourceCandidate"))} · {o.rangeComplete?t("sources.sourceExtractionComplete"):t("sources.sourceCompletenessUnconfirmed")} · {o.evidenceHash.slice(0,12)}</small></p>)}</details>)}</div>
      {!rows.length&&<p className="muted">{t("sources.noSourceLinksAreAvailableToShowMissingCapturedLinksDo")}</p>}
      <div className="screening-pagination"><span>{t("sources.rowCountPagesPagePageNumberPageCount", { rowCount: rows.length, pageNumber: page+1, pageCount: Math.max(1,Math.ceil(rows.length/20)) })}</span><button disabled={!page} onClick={()=>setPage(p=>p-1)}>{t("common.previous")}</button><button disabled={(page+1)*20>=rows.length} onClick={()=>setPage(p=>p+1)}>{t("common.next")}</button></div>
    </>}
  </section>;
}
