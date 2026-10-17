import {canonicalJson, sha256} from "../lib/canonical-json.ts";
import type {LabService} from "./service.ts";

export function normalizeSourceUrl(raw: string) {
  try {
    let url=new URL(raw);
    if(/^https?:$/.test(url.protocol)===false||url.username||url.password)return null;
    if(/^(www\.)?google\.[a-z.]+$/.test(url.hostname)&&/^\/(url|goto)$/.test(url.pathname)){
      const target=url.searchParams.get("url")||url.searchParams.get("q")||url.searchParams.get("u");
      if(!target)return null;url=new URL(target);
    }
    if(!["https:","http:"].includes(url.protocol)||url.username||url.password)return null;
    url.hash="";for(const key of [...url.searchParams.keys()])if(/^(utm_|gclid$|fbclid$|ved$|ei$|sxsrf$)/i.test(key))url.searchParams.delete(key);
    return url.toString();
  } catch { return null; }
}
export function identifySources(plan: ReturnType<LabService["plan"]>, ownedDomains: string[]) {
  type Quality=NonNullable<ReturnType<LabService["plan"]>["slots"][number]["latest"]>["quality"];
  const occurrences: {slotId:string;prompt:string;surface:string;account:string;geo:string;exitCountry:string|null;observedAt:string;attemptId:string;evidenceHash:string;url:string;title:string;host:string;owned:boolean;placement:string;review:string;eligible:boolean;rangeComplete:boolean;contentQualified:boolean;collectionMode:string;fixture:boolean;quality:Quality}[]=[];
  let unresolved=0;
  const promptIds=new Map(plan.slots.map(slot=>[slot.id,slot.prompt_id]));
  const coverage=plan.slots.map(slot=>{
    const a=slot.latest,c=a?.capture;
    const quality=a?.quality??null;
    const readable=!!a?.integrity&&c?.status==="observed"&&a.review?.decision!=="reject"&&!quality?.contentIssues.includes("保存的采集记录格式无效");
    // Raw visible links remain diagnostic even when extraction is incomplete.
    // Only the central quality evaluator supplies complete/metric-qualified counts.
    const rangeComplete=quality?.contentQualified===true;
    const eligible=quality?.metricEligible===true;
    const before=occurrences.length;
    if(readable){unresolved+=c!.browser?.unresolvedCitations??0;const seen=new Set<string>();for(const link of c!.citations){
      const url=normalizeSourceUrl(link.url);if(!url){unresolved++;continue;}if(seen.has(url))continue;seen.add(url);
      const host=new URL(url).hostname.toLowerCase().replace(/^www\./,"");
      const owned=ownedDomains.some(d=>host===d.toLowerCase().replace(/^www\./,"")||host.endsWith("."+d.toLowerCase().replace(/^www\./,"")));
      occurrences.push({slotId:slot.id,prompt:slot.prompt,surface:slot.surface,account:c!.account,geo:c!.geo,exitCountry:c!.exitCountry??null,observedAt:c!.observedAt,attemptId:a!.id,evidenceHash:a!.hash,url,title:link.title||host,host,owned,placement:link.placement??"unspecified",review:a!.review?.decision??"not_requested",eligible,rangeComplete,contentQualified:quality!.contentQualified,collectionMode:c!.collectionMode,fixture:c!.collectionMode==="fixture",quality:quality!});
    }}
    return {slotId:slot.id,prompt:slot.prompt,surface:slot.surface,status:c?.status??"pending",review:a?.review?.decision??"not_requested",integrity:a?.integrity??null,sourceCount:occurrences.length-before,readable,rangeComplete:readable&&rangeComplete,eligible,contentQualified:quality?.contentQualified??false,fixture:c?.collectionMode==="fixture",quality};
  });
  const byPage=new Map<string,typeof occurrences>(),byHost=new Map<string,typeof occurrences>();
  for(const occurrence of occurrences){
    const page=byPage.get(occurrence.url)??[];page.push(occurrence);byPage.set(occurrence.url,page);
    const site=byHost.get(occurrence.host)??[];site.push(occurrence);byHost.set(occurrence.host,site);
  }
  const pages=[...byPage.entries()].map(([url,matched])=>{
    const first=matched[0]!;
    return {url,title:first.title,host:first.host,owned:first.owned,observationCount:matched.length,questionCount:new Set(matched.map(o=>promptIds.get(o.slotId))).size,
      eligibleObservations:matched.filter(o=>o.eligible).length,surfaces:[...new Set(matched.map(o=>o.surface))],occurrences:matched};
  }).sort((a,b)=>b.observationCount-a.observationCount||a.url.localeCompare(b.url));
  const sites=[...byHost.entries()].map(([host,matched])=>{
    return {host,owned:matched.some(p=>p.owned),pageCount:new Set(matched.map(o=>o.url)).size,observationCount:new Set(matched.map(o=>o.slotId)).size,
      questionCount:new Set(matched.map(o=>promptIds.get(o.slotId))).size,
      eligibleObservations:new Set(matched.filter(o=>o.eligible).map(o=>o.slotId)).size,surfaces:[...new Set(matched.map(o=>o.surface))]};
  }).sort((a,b)=>b.observationCount-a.observationCount||a.host.localeCompare(b.host));
  const result={schema:"visible-sources-v1",planId:plan.id,accountMode:plan.config.accountMode??"signed_out",totalPositions:coverage.length,observedPositions:coverage.filter(c=>c.readable).length,
    completeSourcePositions:coverage.filter(c=>c.rangeComplete).length,eligiblePositions:coverage.filter(c=>c.eligible).length,
    fixturePositions:coverage.filter(c=>c.fixture).length,unresolved,pages,sites,coverage,
    scope:"仅识别采集页面实际展示的链接与来源面板，不代表模型后台全部搜索记录，也不证明每条来源均被正文引用。原始可读链接包含未通过质检的诊断候选；合成演示单独标注，不构成消费者答案证据。正式计数只纳入自动质检通过且条件匹配的记录，无须人工逐条确认。"};
  return {...result,hash:sha256(canonicalJson(result))};
}
