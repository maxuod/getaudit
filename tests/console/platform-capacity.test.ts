import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {BrowserJobs} from '../../src/console/browser-jobs.ts';
import {surfaceIds} from '../../src/console/contracts.ts';

describe('multi-platform batch capacity and guest isolation',()=>{
 it.each([{mode:'isolated',platforms:surfaceIds.filter(s=>s!=='duckduckgo_search_assist')},{mode:'signed_out',platforms:surfaceIds}])('queues 100 questions × platforms × 3 repeats in $mode without dispatch or fake reviews',async({mode,platforms})=>{
  const root=mkdtempSync(join(tmpdir(),'geo-six-platform-capacity-')),lab=new LabService(connectLedger(join(root,'ledger.db'))),key=()=>randomUUID();
  const collect=vi.fn(async()=>{throw new Error('Synthetic capacity test must not dispatch');});
  const jobs=new BrowserJobs(lab,{available:()=>({available:true,message:'SYNTHETIC capacity verification'}),collect,show:async()=>{},close:async()=>{},ready:()=>false});
  jobs.active.set('synthetic-dispatch-gate',{pause:false,controller:new AbortController(),promise:Promise.resolve(),intervals:new Set()});
  try{
   const brandId=lab.createBrand(key(),{name:'Capacity fixture',aliases:[],ownedDomains:['capacity.example']}).id;
   const setId=lab.createSet(key(),{brandId,label:'SYNTHETIC 100 questions',locale:'en-CA',source:'Synthetic capacity only',kind:'hypothesis',prompts:Array.from({length:100},(_,i)=>({text:`Synthetic platform question ${i+1}?`,intent:'discovery'}))}).id;lab.freeze(key(),setId);
   const planId=lab.createPlan(key(),{promptSetId:setId,label:'SYNTHETIC six platforms',surfaces:platforms,repetitions:3,accountMode:mode,...(mode==='signed_out'?{guestPolicy:'no_login_v1'}:{}),windows:[new Date().toISOString().slice(0,10)],country:'CA',locale:'en-CA',timezone:'UTC',device:'desktop'}).id;
   const requestId=key(),input={planId,transmissionAcknowledged:true,intervalSeconds:5};const job=jobs.create(requestId,input);
   expect(jobs.items(job.id)).toHaveLength(platforms.length*300);expect(new Set(jobs.items(job.id).map(item=>item.slot_id)).size).toBe(platforms.length*300);
   expect(jobs.rows()[0]).toMatchObject({total:platforms.length*300,captured:0,status:'queued'});expect(jobs.create(requestId,input)).toEqual(job);
   expect(collect).not.toHaveBeenCalled();expect(lab.db.prepare('SELECT count(*) n FROM console_review').get()).toMatchObject({n:0});expect(lab.db.prepare('SELECT count(*) n FROM observation').get()).toMatchObject({n:0});
  }finally{jobs.active.clear();lab.db.close();rmSync(root,{recursive:true,force:true});}
 });
});
