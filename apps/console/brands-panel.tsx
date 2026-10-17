import {t, useUiLanguage, uiMessage, LanguageSwitch} from "./i18n.tsx";
import React,{useEffect,useRef,useState} from 'react';
import {Pencil,Trash2,RotateCcw,X} from 'lucide-react';
import {request} from './api.ts';
import type {LabService} from '../../src/console/service.ts';
type Brand=ReturnType<LabService['brandProfile']>;
const split=(text:string)=>text.split(/[\n,，]/).map(s=>s.trim()).filter(Boolean);
export function BrandsPanel({brands,deletedBrands,onChanged,onCreate}:{brands:Brand[];deletedBrands:Brand[];onChanged:(id:string,action:'edit'|'delete'|'restore')=>Promise<unknown>;onCreate:()=>void}){
  useUiLanguage();
  const [showDeleted,setShowDeleted]=useState(false),[target,setTarget]=useState<Brand|null>(null),[mode,setMode]=useState<'edit'|'delete'|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const dialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(mode&&target)dialog.current?.showModal();},[mode,target?.id]);
  const rows=showDeleted?deletedBrands:brands;
  const close=()=>{if(!busy){setTarget(null);setMode(null);setError('');}};
  const open=(brand:Brand,action:'edit'|'delete')=>{setTarget(brand);setMode(action);setError('');};
  async function change(brand:Brand,action:'edit'|'delete'|'restore',fields?:object){
    if(busy)return;setBusy(true);setError('');
    try{await request('brands/'+(action==='edit'?'update':action),{id:brand.id,version:brand.version,...fields});await onChanged(brand.id,action);setTarget(null);setMode(null);}
    catch(e){setError(e instanceof Error?e.message:t("projects.actionIncomplete"));}finally{setBusy(false);}
  }
  return <section className="panel brands-panel">
    <div className="section-head"><h2>{showDeleted?t("projects.deletedProjects"):t("projects.brandDirectory")}</h2><div className="button-row"><button aria-pressed={!showDeleted} onClick={()=>{setShowDeleted(false);setError('');}}>{t("projects.currentProjects")}{brands.length}</button><button aria-pressed={showDeleted} onClick={()=>{setShowDeleted(true);setError('');}}>{t("projects.deleted")}{deletedBrands.length}</button></div></div>
    {!mode&&error&&<p className="alert error" role="alert">{uiMessage(error)}</p>}
    {rows.map(b=><div className="brand-row" key={b.id}><span className="project-avatar">{b.name[0]}</span><div className="brand-details"><h3>{b.name}</h3><p>{b.category||t("projects.noBusinessCategoryYet")}</p><small>{JSON.parse(b.owned_domains).join(' · ')}</small><p>{t("projects.setCountQuestionSetsPlanCountSamplingPlans", { setCount: b.setCount, planCount: b.planCount })}{b.deletedAt&&t("projects.deletedDeletedAtUTC", { deletedAt: b.deletedAt })}</p></div>
      <div className="button-row brand-actions">{showDeleted?<button disabled={busy} aria-label={t("projects.restoreName", { name: b.name })} onClick={()=>change(b,'restore')}><RotateCcw size={15}/>{t("projects.restore")}</button>:<><button disabled={busy} aria-label={t("projects.editName", { name: b.name })} onClick={()=>open(b,'edit')}><Pencil size={15}/>{t("projects.edit")}</button><button className="danger" disabled={busy} aria-label={t("projects.deleteName", { name: b.name })} onClick={()=>open(b,'delete')}><Trash2 size={15}/>{t("projects.delete")}</button></>}</div>
    </div>)}
    {!rows.length&&<div className="brand-empty"><h3>{showDeleted?t("projects.noDeletedProjects"):t("projects.aFreshDeskForYourFirstProject")}</h3><p className="muted">{showDeleted?t("projects.deletedProjectsStayHereAndCanBeRestoredAtAnyTime"):t("projects.addYourBrandAndOwnedDomainsSoFutureMentionsAndCitations")}</p>{!showDeleted&&<button className="primary" onClick={onCreate}>{t("projects.newBrand")}</button>}</div>}
    {mode&&target&&<dialog ref={dialog} className="brand-dialog" aria-labelledby="brand-dialog-title" onCancel={e=>{if(busy)e.preventDefault();else close();}}><header><h2 id="brand-dialog-title">{mode==='edit'?t("projects.editBrandProject"):t("common.deleteProject")}</h2><LanguageSwitch/><button className="icon" aria-label={t("projects.closeProjectAction")} disabled={busy} onClick={close}><X size={20}/></button></header>
      {error&&<p className="alert error" role="alert">{uiMessage(error)}</p>}
      {mode==='edit'?<form onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);void change(target,'edit',{name:String(form.get('name')),ownedDomains:split(String(form.get('domains'))),aliases:split(String(form.get('aliases'))),category:String(form.get('category'))});}}>
        <label className="field"><span>{t("projects.brandName")}</span><input name="name" defaultValue={target.name} maxLength={120} required/></label>
        <label className="field"><span>{t("projects.ownedDomains")}</span><input name="domains" defaultValue={JSON.parse(target.owned_domains).join(', ')} required/><small>{t("projects.enterDomainsOnlyWithoutHttpsSeparateMultipleDomainsWithCommas")}</small></label>
        <label className="field"><span>{t("projects.brandAliases")}</span><input name="aliases" defaultValue={JSON.parse(target.aliases).join(', ')}/></label>
        <label className="field"><span>{t("projects.businessCategory")}</span><input name="category" defaultValue={target.category??''} maxLength={200}/></label>
        <p className="quiet-note">{t("projects.newPlansUseTheUpdatedDefinitionExistingPlansAndReportsKeep")}</p><footer><button type="button" disabled={busy} onClick={close}>{t("common.cancel")}</button><button className="primary" disabled={busy} type="submit">{busy?t("common.saving"):t("common.saveChanges")}</button></footer>
      </form>:<><p>{t("projects.move", { name: target.name })}</p><p className="muted">{t("projects.theLinked", { setCount: target.setCount, planCount: target.planCount, observationCount: target.observationCount })}</p><footer><button disabled={busy} onClick={close}>{t("common.cancel")}</button><button className="danger" disabled={busy} onClick={()=>change(target,'delete')}>{busy?t("projects.deleting"):t("common.deleteProject")}</button></footer></>}
    </dialog>}
  </section>;
}
