import React, {useEffect, useRef} from 'react';
import {t,useUiLanguage,uiMessage} from "./i18n.tsx";
import {LockKeyhole, RefreshCw} from 'lucide-react';
import './connection-access.css';

export type ConnectionAccess = {
  status: 'loading' | 'ready' | 'locked';
  message?: string;
};
type ConnectionField = {key:string;label:string;configured:boolean;secret:boolean};

export function useConnectionAccessPolling(access:ConnectionAccess|undefined, reload:()=>Promise<unknown>, selection:string) {
  const reloadRef=useRef(reload);
  reloadRef.current=reload;
  useEffect(()=>{
    if(access?.status!=='loading')return;
    let pending=false;
    const timer=setInterval(()=>{
      if(pending)return;
      pending=true;
      void reloadRef.current().catch(()=>{}).finally(()=>{pending=false;});
    },2000);
    return()=>clearInterval(timer);
  },[access?.status,selection]);
}

export function ConnectionAccessNotice({access,busy=false,onUnlock}:{access?:ConnectionAccess;busy?:boolean;onUnlock:()=>void}) {
  useUiLanguage();
  if(!access || access.status==='ready')return null;
  const loading=access.status==='loading';
  return <div className="connection-access-notice" role="status" aria-live="polite">
    {loading?<RefreshCw size={17} aria-hidden="true"/>:<LockKeyhole size={17} aria-hidden="true"/>}
    <div>
      <strong>{loading?t("connections.readingSavedConnections"):t("connections.systemConnectionsAreLocked")}</strong>
      <p>{loading?t("connections.theHistoricalLedgerIsReadyToBrowseConnectionsWillUpdateOnce"):t("connections.youCanStillBrowseTheHistoricalLedgerAndReportsToCollect")}</p>
    </div>
    {!loading && <button type="button" disabled={busy} aria-busy={busy} onClick={onUnlock}><RefreshCw size={14} aria-hidden="true"/>{t("connections.retryUnlockingConnections")}</button>}
  </div>;
}

export function ConnectionSettingsEditor({access,fields,persisted,busy,onUnlock,onSave}:{
  access?:ConnectionAccess;
  fields:ConnectionField[];
  persisted:boolean;
  busy:boolean;
  onUnlock:()=>void;
  onSave:(fields:Record<string,FormDataEntryValue>)=>void;
}) {
  useUiLanguage();
  const ready=!access || access.status==='ready';
  const editableFields=fields.filter(field=>!field.key.startsWith('GETGEO_GOOGLE_')&&!field.key.startsWith('GSC_'));
  const groups=[
    {id:'google',title:t('simple.googleAccount'),fields:editableFields.filter(field=>field.key.startsWith('GETGEO_GOOGLE_'))},
    {id:'search',title:t('simple.searchCredentials'),fields:editableFields.filter(field=>field.key.startsWith('GSC_')&&field.key!=='GSC_MCP_KEY')},
    {id:'ai',title:t('simple.aiProviders'),fields:editableFields.filter(field=>!field.key.startsWith('GETGEO_GOOGLE_')&&!field.key.startsWith('GSC_')&&!field.key.startsWith('DATAFORSEO_'))},
    {id:'serp',title:t('simple.searchProviders'),fields:editableFields.filter(field=>field.key.startsWith('DATAFORSEO_'))},
    {id:'integrations',title:t('simple.integrationKeys'),fields:editableFields.filter(field=>field.key==='GSC_MCP_KEY')},
  ].filter(group=>group.fields.length);
  return <>
    <p>{persisted?t("connections.macEncryptsTheKeysBeforeSavingThemInTheAppS"):t("connections.browserModeKeepsConnectionsOnlyForThisProcessSetThemUp")}</p>
    <ConnectionAccessNotice access={access} busy={busy} onUnlock={onUnlock}/>
    <form onSubmit={e=>{
      e.preventDefault();
      if(!ready || busy)return;
      const f=new FormData(e.currentTarget);
      onSave(Object.fromEntries([...f.entries()].filter(([,value])=>String(value).trim())));
    }}>
      <p className="connection-form-note">{t("connections.leaveBlankToKeepTheCurrentValueEnterDELETEToClear")}</p>
      {groups.map(group=><details className="connection-group" key={group.id}><summary>{group.title}<small className="connection-group-status">{t('simple.savedCredentials',{count:group.fields.filter(field=>field.configured).length})}</small></summary><div>{group.fields.map(field=><label className="field" key={field.key}>
        <span>{uiMessage(field.label)+(field.configured?t("connections.configured"):'')}</span>
        <input name={field.key} type={field.secret?'password':'text'} autoComplete="off" disabled={!ready || busy}/>
      </label>)}</div></details>)}
      {!ready && <p className="quiet-note">{t("connections.connectionsAreStillLoadingSoChangesCannotBeSavedYetExisting")}</p>}
      <button className="primary wide" disabled={busy || !ready}>{t("connections.saveConnections")}</button>
    </form>
  </>;
}
