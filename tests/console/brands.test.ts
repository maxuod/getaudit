import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {connectLedger} from '../../src/db/index.ts';
import {getBrand} from '../../src/ledger/repo.ts';
import {LabService} from '../../src/console/service.ts';
import {BrowserJobs,type BrowserCollector} from '../../src/console/browser-jobs.ts';
import {ApiJobs} from '../../src/console/api-jobs.ts';
import {AiAnalysis} from '../../src/console/ai-analysis.ts';
import {serveConsole} from '../../src/console/server.ts';
import {backupLedger,historicalFingerprint,validateLedger} from '../../src/console/backup.ts';
let lab:LabService,root:string,brandId:string,setId:string,planId:string;
const key=()=>randomUUID();
const fields={name:'Renamed Northstar',ownedDomains:['NEW.EXAMPLE'],aliases:['Renamed'],category:'Updated category'};
const identity=()=>({id:brandId,version:lab.brandProfile(brandId).version});
const planInput=()=>{const {brandSnapshot,...config}=JSON.parse(lab.planRow(planId).config_json);return config;};
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),'brand-management-'));lab=new LabService(connectLedger(join(root,'ledger.db')));
  brandId=lab.createBrand(key(),{name:'Northstar',ownedDomains:['northstar.example'],aliases:['Northstar'],category:'Scheduling'}).id;
  setId=lab.createSet(key(),{brandId,label:'Synthetic brand lifecycle',locale:'en-CA',source:'Synthetic test fixture',kind:'hypothesis',prompts:[{text:'Synthetic scheduling question?',intent:'discovery'}]}).id;
  lab.freeze(key(),setId);planId=lab.createPlan(key(),{promptSetId:setId,label:'Original definition',surfaces:['chatgpt_search'],windows:[new Date().toISOString().slice(0,10)],country:'CA',locale:'en-CA',timezone:'UTC',device:'desktop'}).id;
});
afterEach(()=>{lab.db.close();rmSync(root,{force:true,recursive:true});});
describe('reversible brand management',()=>{
  it('edits every profile field while preserving existing plans and report hashes',()=>{
    const before=lab.report(planId),old=identity(),requestId=key();const result=lab.changeBrand(requestId,'edit',{...old,...fields});
    expect(getBrand(lab.db,brandId)).toMatchObject({name:fields.name,owned_domains:'["new.example"]',aliases:'["Renamed"]',category:'Updated category'});
    expect(lab.report(planId)).toEqual(before);
    expect(lab.changeBrand(requestId,'edit',{...old,...fields})).toEqual(result);
    expect(()=>lab.changeBrand(key(),'edit',{...old,...fields,name:'Stale'})).toThrow(/刷新/);
    const next=lab.createPlan(key(),{...planInput(),label:'New definition'}).id;
    expect(lab.report(next).brand).toBe('Renamed Northstar');
    expect(lab.db.prepare('SELECT COUNT(*) n FROM console_brand_change').get()).toEqual({n:1});
  });
  it('validates edits without partially changing the profile or change history',()=>{
    const before=lab.brandProfile(brandId);
    for(const bad of [{...fields,name:' '},{...fields,ownedDomains:['https://example.com']},{...fields,aliases:['']},{...fields,extra:'not allowed'}])expect(()=>lab.changeBrand(key(),'edit',{...identity(),...bad})).toThrow();
    expect(lab.brandProfile(brandId)).toEqual(before);
    expect(lab.db.prepare('SELECT COUNT(*) n FROM console_brand_change').get()).toEqual({n:0});
  });
  it('deletes from active lists, clears stale selection, and restores all linked identities',()=>{
    const before=historicalFingerprint(lab.db),report=lab.report(planId),input=identity(),rid=key();const result=lab.changeBrand(rid,'delete',input);
    expect(lab.changeBrand(rid,'delete',input)).toEqual(result);
    const state=lab.state(setId);expect(state.brands).toHaveLength(0);expect(state.sets).toHaveLength(0);expect(state.selectedSetId).toBeNull();expect(state.plans).toHaveLength(0);
    expect(state.deletedBrands[0]).toMatchObject({id:brandId,setCount:1,planCount:1});
    expect(historicalFingerprint(lab.db)).toEqual(before);expect(lab.report(planId)).toEqual(report);
    expect(()=>lab.createPlan(key(),{...planInput(),label:'Cannot create'})).toThrow(/已删除/);
    expect(()=>lab.freeze(key(),setId)).toThrow(/已删除/);
    expect(()=>lab.changeBrand(key(),'edit',{...identity(),...fields})).toThrow(/已删除/);
    lab.changeBrand(key(),'restore',identity());expect(lab.state(setId).brands[0]!.id).toBe(brandId);expect(lab.state(setId).selectedSetId).toBe(setId);expect(lab.state(setId).plans[0]!.id).toBe(planId);
    expect(historicalFingerprint(lab.db)).toEqual(before);
    expect(()=>lab.db.prepare("UPDATE console_brand_change SET action='edit'").run()).toThrow(/不可修改/);
    expect(()=>lab.db.prepare('DELETE FROM console_brand_change').run()).toThrow(/不可修改/);
  });
  it('blocks edits and deletion while a browser task is in flight, then blocks stale resumes after deletion',async()=>{
    let entered!:()=>void;const running=new Promise<void>(r=>{entered=r;});
    const collector:BrowserCollector={available:()=>({available:true,message:'Synthetic'}),show:async()=>{},close:async()=>{},collect:async(_task,signal,stage)=>{stage('submitting');entered();return new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('Synthetic stop')),{once:true}));}};
    const jobs=new BrowserJobs(lab,collector,async()=>{});
    const j=jobs.create(key(),{planId,transmissionAcknowledged:true});await running;
    expect(()=>lab.changeBrand(key(),'edit',{...identity(),...fields})).toThrow(/仍有任务运行/);
    expect(()=>lab.changeBrand(key(),'delete',identity())).toThrow(/仍有任务运行/);
    await jobs.pauseAll();lab.changeBrand(key(),'delete',identity());expect(()=>jobs.start(j.id)).toThrow(/已删除/);
    const api=new ApiJobs(lab,[]);expect(()=>api.create(key(),{promptSetId:setId,engines:['synthetic'],runsPerPrompt:1,maxCostUsd:1,costAcknowledged:true})).toThrow(/已删除/);
    await expect(jobs.sessionControl({planId,surface:'chatgpt_search',action:'open'})).rejects.toThrow(/已删除/);
  });
  it('blocks active API and AI changes without blocking a different project',()=>{
    new ApiJobs(lab,[]);new AiAnalysis(lab);
    const apiId=key();lab.db.prepare("INSERT INTO console_api_job(id,prompt_set_id,config_json,status) VALUES(?,?,?,'running')").run(apiId,setId,'{}');
    expect(()=>lab.changeBrand(key(),'edit',{...identity(),...fields})).toThrow(/仍有任务运行/);
    lab.db.prepare("UPDATE console_api_job SET status='paused' WHERE id=?").run(apiId);
    const aiId=key();lab.db.prepare("INSERT INTO console_ai_job(id,plan_id,model,input_json,input_hash,status) VALUES(?,?,?,?,?,'running')").run(aiId,planId,'synthetic','{}','fixture');
    expect(()=>lab.changeBrand(key(),'delete',identity())).toThrow(/仍有任务运行/);
    const other=lab.createBrand(key(),{name:'Other',ownedDomains:['other.example'],aliases:[]}).id;
    expect(()=>lab.changeBrand(key(),'delete',{id:other,version:lab.brandProfile(other).version})).not.toThrow();
  });
  it('identifies an unrelated SQLite file with the current English product name',()=>{
    const unrelated=new DatabaseSync(':memory:');
    try { expect(()=>validateLedger(unrelated)).toThrow('This file is not a getaudit ledger.'); }
    finally { unrelated.close(); }
  });
  it('preserves deleted status and immutable history through backup and reload',async()=>{
    lab.changeBrand(key(),'delete',identity());const file=join(root,'backup.db');await backupLedger(lab.db,file);
    const copy=new LabService(connectLedger(file));try{validateLedger(copy.db);expect(copy.state().deletedBrands[0]!.id).toBe(brandId);copy.changeBrand(key(),'restore',{id:brandId,version:copy.brandProfile(brandId).version});expect(copy.state().brands).toHaveLength(1);}finally{copy.db.close();}
  });
  it('exposes authenticated update/delete/restore endpoints and rejects stale versions',async()=>{
    const closed:string[]=[];
    const app=await serveConsole(lab,{browserCollector:{available:()=>({available:true,message:'Synthetic'}),show:async()=>{},close:async()=>{closed.push('all');},collect:async()=>{throw new Error('Unused synthetic collector');},sessions:()=>[{planId,surface:'chatgpt_search',verified:false}],closePlanSessions:async id=>{closed.push(id);}}});const post=(path:string,input:object,token=app.token)=>fetch(app.origin+'/api/brands/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({requestId:key(),input})});
    try{
      const initial=identity();expect((await post('update',{...initial,...fields},'bad-token')).status).toBe(401);
      expect((await post('update',{...initial,...fields})).status).toBe(200);
      expect((await post('delete',initial)).status).toBe(400);
      expect((await post('delete',identity())).status).toBe(200);
      expect(closed).toEqual([planId]);
      const state=await (await fetch(app.origin+'/api/state?set='+setId,{headers:{Authorization:'Bearer '+app.token}})).json();
      expect(state).toMatchObject({selectedSetId:null,brands:[],sets:[],apiJobs:[],browserJobs:[]});
      expect((await post('restore',identity())).status).toBe(200);expect(lab.state(setId).brands[0]!.name).toBe(fields.name);
    }finally{await app.browserJobs.pauseAll();await new Promise<void>(r=>app.server.close(()=>r()));}
  });
});
