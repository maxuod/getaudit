import {t, useUiLanguage} from './i18n.tsx';
import React,{createContext,useContext,useEffect,useMemo,useState} from 'react';
import {Download,ChevronLeft,ChevronRight,ArrowDown,ArrowUp} from 'lucide-react';
import {csv} from '../../src/console/gsc-analysis.ts';
import {downloadText} from './download.ts';
export const GscExportContext=createContext<{source:string;id:string;hash:string;startDate:string;endDate:string;country:string}|null>(null);
export type Column={id:string;label:string;numeric?:boolean;export?:boolean};
export type TableRow={id:string;values:Record<string,string|number|null>;cells?:Record<string,React.ReactNode>};
export function DataTable({columns,rows,filename,pageSize=25,resetKey,initialSort='impressions',empty=t("table.noRowsWereReturnedForTheseFilters")}:{columns:Column[];rows:TableRow[];filename:string;pageSize?:number;resetKey:string;initialSort?:string;empty?:string}){
 useUiLanguage();
 const provenance=useContext(GscExportContext);
 const metadata=provenance?[t("common.source"),t("table.snapshotID"),'SHA-256',t("table.startDate"),t("table.endDate"),t("common.region")]:[],metaValues=provenance?[provenance.source,provenance.id,provenance.hash,provenance.startDate,provenance.endDate,provenance.country]:[];
 const [sort,setSort]=useState(initialSort),[asc,setAsc]=useState(initialSort==='position'||initialSort.endsWith('Delta')),[page,setPage]=useState(0);
 useEffect(()=>{setPage(0);setSort(initialSort);setAsc(initialSort==='position'||initialSort.endsWith('Delta'));},[resetKey,initialSort]);
 const sorted=useMemo(()=>[...rows].sort((a,b)=>{const x=a.values[sort],y=b.values[sort];if(x==null)return y==null?0:1;if(y==null)return -1;const order=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y));return asc?order:-order;}),[rows,sort,asc]);
 const pages=Math.max(1,Math.ceil(sorted.length/pageSize)),current=Math.min(page,pages-1);
 const exported=columns.filter(c=>c.export!==false);
 return <div className="gsc-data-table"><div className="gsc-table-top"><span>{rows.length.toLocaleString()} {t("table.rowsChooseAColumnHeaderToSort")}</span><button disabled={!rows.length} onClick={()=>downloadText(filename+'.csv',csv([...exported.map(c=>c.label),...metadata],sorted.map(r=>[...exported.map(c=>r.values[c.id]),...metaValues])),'text/csv;charset=utf-8')}><Download size={14}/>{t("table.exportTheseResultsAsCSV")}</button></div>
 <div className="gsc-table-scroll"><table><thead><tr>{columns.map(c=><th key={c.id} className={c.numeric?'gsc-number':''} aria-sort={sort===c.id?(asc?'ascending':'descending'):'none'}><button onClick={()=>{if(sort===c.id)setAsc(!asc);else{setSort(c.id);setAsc(c.id==='position');}setPage(0);}}>{c.label}{sort===c.id&&(asc?<ArrowUp size={12}/>:<ArrowDown size={12}/>)}</button></th>)}</tr></thead><tbody>{sorted.slice(current*pageSize,(current+1)*pageSize).map(r=><tr key={r.id}>{columns.map(c=><td key={c.id} className={c.numeric?'gsc-number':''}>{r.cells?.[c.id]??r.values[c.id]??'—'}</td>)}</tr>)}</tbody></table>{!rows.length&&<p className="gsc-table-empty">{empty}</p>}</div>
 <div className="gsc-pagination"><span>{rows.length?current*pageSize+1:0}–{Math.min((current+1)*pageSize,rows.length)} / {rows.length.toLocaleString()}</span><div><button aria-label={t("table.previousPage")} disabled={!current} onClick={()=>setPage(current-1)}><ChevronLeft size={15}/></button><span>{current+1} / {pages}</span><button aria-label={t("table.nextPage")} disabled={current>=pages-1} onClick={()=>setPage(current+1)}><ChevronRight size={15}/></button></div></div></div>;
}
