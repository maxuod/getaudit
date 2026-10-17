import {t, useUiLanguage} from './i18n.tsx';
import React,{useEffect,useState} from 'react';
import type {GscEvidence} from '../../src/console/gsc.ts';
import {shareReport,encryptedReport} from './gsc-report.ts';
import {request} from './api.ts';
import {downloadText} from './download.ts';
type Share={id:string;snapshot_id:string;created_at:string;url:string};
export function ShareTools({evidence,act,busy,notify}:{evidence:GscEvidence;act:(fn:()=>Promise<void>)=>Promise<void>;busy:boolean;notify:(v:string)=>void}){
 useUiLanguage();
 const [password,setPassword]=useState(''),[links,setLinks]=useState<Share[]>([]);
 async function load(){setLinks(await request('gsc/shares?property='+encodeURIComponent(evidence.snapshot.property)));}
 useEffect(()=>{load().catch(e=>notify(e.message));},[evidence.snapshot.property]);
 return <div className="gsc-form"><p>{t("share.theReportIncludesThisSnapshotSDatesRegionQueriesPagesAnd")}</p><button onClick={()=>downloadText('gsc-report-'+evidence.snapshot.endDate+'.html',shareReport(evidence),'text/html')}>{t("share.exportReadableHTMLReport")}</button><label>{t("share.passwordForEncryptedFile")}<input type="password" minLength={8} value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password"/></label><button disabled={busy||password.length<8} onClick={()=>act(async()=>{downloadText('gsc-encrypted-'+evidence.snapshot.endDate+'.html',await encryptedReport(evidence,password),'text/html');setPassword('');notify(t("share.aESGCMEncryptedReportExportedThePasswordWasNotSaved"));})}>{t("share.exportPasswordEncryptedReport")}</button><p className="gsc-footnote">{t("share.clientsCanOpenTheHTMLFileDirectlySendThePasswordSeparately")}</p><button disabled={busy} onClick={()=>act(async()=>{await request('gsc/share-create',{snapshotId:evidence.snapshot.id});await load();})}>{t("share.createLocalReadOnlySnapshotLink")}</button><p className="gsc-footnote">{t("share.localLinksWorkOnThisComputerWhileTheAppRunsUse")}</p>{links.map(l=><div className="gsc-preset" key={l.id}><input aria-label={t("share.localSnapshotLink")} readOnly value={l.url}/><button disabled={busy} onClick={()=>act(async()=>{await request('gsc/share-revoke',{id:l.id});await load();})}>{t("share.revoke")}</button></div>)}</div>;
}
