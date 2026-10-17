import {RE2JS} from 're2js';
import type {GscRow,GscSnapshot,GscDataset} from './gsc.ts';
export type Metric='clicks'|'impressions'|'ctr'|'position';
export const metricNames:Record<Metric,string>={clicks:'点击',impressions:'展示',ctr:'CTR',position:'平均排名'};
export const dayMs=86400000;
export function dateRange(start:string,end:string){const out:string[]=[];for(let t=Date.parse(start);t<=Date.parse(end)&&out.length<366;t+=dayMs)out.push(new Date(t).toISOString().slice(0,10));return out;}
export function sumRows(rows:GscRow[]):GscRow|null{if(!rows.length)return null;const clicks=rows.reduce((n,r)=>n+r.clicks,0),impressions=rows.reduce((n,r)=>n+r.impressions,0);return {clicks,impressions,ctr:impressions?clicks/impressions:0,position:impressions?rows.reduce((n,r)=>n+r.position*r.impressions,0)/impressions:0};}
export function series(rows:GscRow[]|undefined,start:string,end:string){const byDate=new Map((rows??[]).map(r=>[r.keys?.[0],r]));return dateRange(start,end).map(date=>({date,row:byDate.get(date)??null}));}
export function changes(current:GscRow[],previous:GscRow[]|undefined){
 const now=new Map(current.map(r=>[r.keys?.[0]??'',r])),old=new Map((previous??[]).map(r=>[r.keys?.[0]??'',r]));
 return [...new Set([...now.keys(),...old.keys()])].map(key=>({key,current:now.get(key)??null,previous:old.get(key)??null,status:!previous?'unknown':!old.has(key)?'appeared':!now.has(key)?'not_returned':(now.get(key)!.clicks-old.get(key)!.clicks)>0?'up':(now.get(key)!.clicks-old.get(key)!.clicks)<0?'down':'stable'}));
}
export function delta(now:number|null|undefined,before:number|null|undefined,metric:Metric){
 if(now==null||before==null)return null;const absolute=now-before;return {absolute,percent:before===0?null:absolute/Math.abs(before)*100,better:metric==='position'?absolute<0:absolute>0};
}
export function suspiciousQuery(query:string){return /https?:\/\/|(?:[a-z0-9-]+\.){2,}[a-z]{2,}|,(?:[^,]*,){3}/i.test(query);}
export type GroupRule={name:string;field:'query'|'page';match:'contains'|'prefix'|'equals'|'regex'|'not_regex';expression:string};
const patterns=new Map<string,RE2JS>();
export function validatePattern(expression:string){return RE2JS.compile(expression,RE2JS.CASE_INSENSITIVE);}
export function matches(text:string,rule:Pick<GroupRule,'match'|'expression'>){if(rule.match==='regex'||rule.match==='not_regex'){let p=patterns.get(rule.expression);if(!p){p=validatePattern(rule.expression);if(patterns.size>=100)patterns.delete(patterns.keys().next().value!);patterns.set(rule.expression,p);}const matched=p.test(text);return rule.match==='regex'?matched:!matched;}const hay=text.toLowerCase(),needle=rule.expression.toLowerCase();return rule.match==='equals'?hay===needle:rule.match==='prefix'?hay.startsWith(needle):hay.includes(needle);}
export function groupData(s:GscSnapshot,rule:GroupRule){
 const rows=(rule.field==='query'?s.queries:s.pages).filter(r=>matches(r.keys?.[0]??'',rule));
 const raw=(rule.field==='query'?s.queryDaily:s.pageDaily)?.filter(r=>matches(r.keys?.[1]??'',rule));
 const days=new Map<string,GscRow[]>();for(const r of raw??[]){const date=r.keys?.[0]??'';if(!days.has(date))days.set(date,[]);days.get(date)!.push(r);}
 return {rows,totals:sumRows(rows),daily:raw?dateRange(s.startDate,s.endDate).map(date=>({date,row:sumRows(days.get(date)??[])})):undefined};
}
export function rankBand(position:number){return position<=0?-1:position<=3?0:position<=10?1:position<=20?2:3;}
export const bandNames=['1–3','4–10','11–20','21+'];
export function rankCounts(rows:GscRow[]){return bandNames.map((_n,i)=>rows.filter(r=>r.impressions>0&&rankBand(r.position)===i).length);}
export function rankDaily(s:GscSnapshot){if(!s.queryDaily)return undefined;const byDate=new Map<string,GscRow[]>();for(const r of s.queryDaily){const d=r.keys?.[0]??'';if(!byDate.has(d))byDate.set(d,[]);byDate.get(d)!.push(r);}return dateRange(s.startDate,s.endDate).map(date=>({date,counts:byDate.has(date)?rankCounts(byDate.get(date)!):null}));}
export function landingPages(s:GscDataset,query:string){return (s.queryPages??[]).filter(r=>r.keys?.[0]===query).sort((a,b)=>b.impressions-a.impressions);}
export function cannibalization(s:GscSnapshot,minImpressions=10){
 const queries=new Map<string,GscRow[]>();for(const r of s.queryPages??[]){if(r.impressions<minImpressions)continue;const q=r.keys?.[0]??'';if(!queries.has(q))queries.set(q,[]);queries.get(q)!.push(r);}
 return [...queries].filter(([,rows])=>new Set(rows.map(r=>r.keys?.[1])).size>1).map(([query,pages])=>({query,pages:pages.sort((a,b)=>b.impressions-a.impressions),totals:s.queries.find(r=>r.keys?.[0]===query)??null})).sort((a,b)=>(b.totals?.impressions??0)-(a.totals?.impressions??0));
}
export function emergingPages(s:GscSnapshot){
 if(!s.comparison||!s.pageDaily)return undefined;const old=new Set(s.comparison.pages.map(r=>r.keys?.[0]));
 return s.pages.filter(r=>r.impressions>0&&!old.has(r.keys?.[0])).map(row=>{const days=s.pageDaily!.filter(r=>r.keys?.[1]===row.keys?.[0]&&r.impressions>0).sort((a,b)=>(a.keys?.[0]??'').localeCompare(b.keys?.[0]??''));const first=days[0]?.keys?.[0]??null,click=days.find(r=>r.clicks>0)?.keys?.[0]??null;return {row,first,click,elapsed:first&&click?(Date.parse(click)-Date.parse(first))/dayMs:null,days};}).sort((a,b)=>b.row.impressions-a.row.impressions);
}
export function languageOfPage(page:string){let path='';try{const url=new URL(page);path=url.pathname.toLowerCase();const sub=url.hostname.split('.')[0];if(['en','fr','zh','es','de','ja','ko','pt','it'].includes(sub??''))return sub!;}catch{return '无法识别';}const prefix=/^\/(?:blog\/)?(en|fr|zh|es|de|ja|ko|pt|it)(?:[-_/]|$)/.exec(path)?.[1];if(prefix)return prefix;return '默认路径';}
export function languageGroups(s:GscSnapshot){
 const names=[...new Set(s.pages.map(r=>languageOfPage(r.keys?.[0]??'')))];
 return names.map(name=>{const pages=s.pages.filter(r=>languageOfPage(r.keys?.[0]??'')===name),raw=s.pageDaily?.filter(r=>languageOfPage(r.keys?.[1]??'')===name);const map=new Map<string,GscRow[]>();for(const r of raw??[]){const d=r.keys?.[0]??'';if(!map.has(d))map.set(d,[]);map.get(d)!.push(r);}return {name,pages,totals:sumRows(pages),daily:raw?dateRange(s.startDate,s.endDate).map(date=>({date,row:sumRows(map.get(date)??[])})):undefined};}).sort((a,b)=>(b.totals?.impressions??0)-(a.totals?.impressions??0));
}
export function monthlyHeatmap(s:GscSnapshot,metric:'clicks'|'impressions'){
 if(!s.monthlyPages)return undefined;const maps=s.monthlyPages.map(m=>new Map(m.rows.map(r=>[r.keys?.[0]??'',r[metric]]))),urls=[...new Set(maps.flatMap(m=>[...m.keys()]))];return urls.map(url=>({url,values:maps.map(m=>m.get(url)??null)})).sort((a,b)=>b.values.reduce<number>((n,v)=>n+(v??0),0)-a.values.reduce<number>((n,v)=>n+(v??0),0));
}
export function csv(headers:string[],rows:unknown[][]){const escape=(v:unknown)=>{let s=String(v??'');if(typeof v==='string'&&/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};return '\uFEFF'+[headers,...rows].map(row=>row.map(escape).join(',')).join('\r\n');}
export function rowCsv(rows:GscRow[],dimensions:string[]){return csv([...dimensions,'点击','展示','CTR','平均排名'],rows.map(r=>[...(r.keys??[]),r.clicks,r.impressions,r.ctr,r.position]));}

export function formatGscMetric(value:number|null|undefined,metric:Metric,short=false){if(value==null)return '—';return metric==='ctr'?(value*100).toFixed(2)+'%':metric==='position'?value.toFixed(1):new Intl.NumberFormat('en',{notation:short?'compact':'standard',maximumFractionDigits:short?1:0}).format(value);}

export const groupTemplates:GroupRule[]=[{name:'问答与内容选题',field:'query',match:'regex',expression:'^(who|what|where|when|why|how|do|does|is|are|can|could|should)\\b'},{name:'长尾查询（4 个词以上）',field:'query',match:'regex',expression:'^(\\S+\\s+){3,}\\S+'},{name:'比较与替代品',field:'query',match:'regex',expression:'\\b(vs|versus|comparison|alternative|best|top|review|difference)\\b'},{name:'故障与痛点',field:'query',match:'regex',expression:'error|issue|problem|fix|not working|failed|solve|unable'},{name:'教程与模板',field:'query',match:'regex',expression:'guide|tutorial|example|template|case study|ideas|strategy'}];
