import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connectLedger } from "../../src/db/index.ts";
import { LabService } from "../../src/console/service.ts";
import { BrowserJobs, type BrowserCollector, type BrowserTask } from "../../src/console/browser-jobs.ts";
import type { Capture } from "../../src/console/contracts.ts";
let root: string, lab: LabService, jobs: BrowserJobs;
const key = () => randomUUID();
function plan(count = 100, surfaces = ["chatgpt_search"], accountMode = "signed_out") {
  const brandId = lab.createBrand(key(), { name: "Northstar", aliases: [], ownedDomains: ["northstar.example"] }).id;
  const promptSetId = lab.createSet(key(), { brandId, label: "Bulk fixture", locale: "en-CA", source: "Synthetic queue verification", kind: "hypothesis",
    prompts: Array.from({ length: count }, (_, i) => ({ text: `Synthetic question ${i + 1}?`, intent: "discovery" })) }).id;
  lab.freeze(key(), promptSetId);
  return lab.createPlan(key(), { promptSetId, label: "100-question verification", surfaces, accountMode,
    windows: [new Date().toISOString().slice(0, 10)], country: "CA", locale: "en-CA", timezone: "UTC", device: "desktop" }).id;
}
function capture(task: BrowserTask, extra: Partial<Capture> = {}): Capture {
  return { slotId: task.slotId, prompt: task.prompt, observedAt: new Date().toISOString(), status: "observed", restriction: "none", reason: "",
    answer: "Compare Northstar scheduling for weekly shifts.", citations: [{ url: "https://northstar.example/features" }], model: "synthetic-fixture",
    account: "logged_out", session: "fresh", exitCountry: "CA", geo: "ip_observed", locale: "en-CA", timezone: "UTC", device: "desktop", geolocation: "denied",
    searchMode: task.surface === "gemini" ? "natural" : "explicit_search", collectionMode: "browser_capture", retrievalUsed: true,
    sourceUrl:task.surface === "google_aio" ? "https://www.google.com/search?q=synthetic" : task.surface === "gemini" ? "https://gemini.google.com/app" : "https://chatgpt.com/",
    browser: { name: "Google Chrome", version: "synthetic", extractorVersion: "test", answerComplete: true, citationsComplete: true, notes: ["SYNTHETIC TEST"] },
    artifact: { mime: "text/plain", base64: Buffer.from("SYNTHETIC TEST evidence " + task.prompt).toString("base64") }, ...extra };
}
function collector(collect: BrowserCollector["collect"]): BrowserCollector {
  return { available: () => ({ available: true, message: "SYNTHETIC" }), collect, show: async () => {}, close: async () => {} };
}
const input = (planId: string) => ({ planId, transmissionAcknowledged: true, intervalSeconds: 5 });
const drain = async (id: string) => { await jobs.active.get(id)?.promise; };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "browser-queue-test-")); lab = new LabService(connectLedger(join(root, "ledger.db"))); });
afterEach(async () => { await jobs?.pauseAll(); lab.db.close(); rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });

describe('continuing unfinished work across date windows',()=>{
  const day=(value:string)=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(value));};
  const queued=(planId:string,options={})=>{
    jobs.active.set('fixture',{pause:false,controller:new AbortController(),promise:Promise.resolve(),intervals:new Set()});
    const j=jobs.create(key(),{...input(planId),...options});jobs.active.clear();return j;
  };
  it('carries only unsent unrestricted positions, preserves evidence and deduplicates repeated clicks',async()=>{
    day('2026-09-26T12:00:00Z');let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const calls:BrowserTask[]=[];
    jobs=new BrowserJobs(lab,collector(async task=>{calls.push(task);await gate;return capture(task);}),async()=>{});
    const sourcePlan=plan(3,['chatgpt_search','gemini','google_aio']),j=queued(sourcePlan,{verifiedCountry:'CA',geoVerificationNote:'Synthetic prior-day verification'});
    const original=lab.plan(sourcePlan),items=jobs.items(j.id);
    const itemFor=(surface:string,n:number)=>items.filter(i=>lab.slot(i.slot_id).surface===surface)[n]!;
    const save=(surface:string,extra:Partial<Capture>)=>{
      const item=itemFor(surface,0),slot=original.slots.find(s=>s.id===item.slot_id)!;
      const c=capture({slotId:slot.id,prompt:slot.prompt,surface:slot.surface,config:original.config,timeoutSeconds:150,verifiedCountry:null,geoVerificationNote:''},extra);
      const a=lab.capture(key(),c);lab.db.prepare("UPDATE console_browser_item SET state='captured',stage='saved',attempt_id=? WHERE id=?").run(a.id,item.id);
    };
    save('chatgpt_search',{});save('gemini',{status:'error',answer:'',citations:[],reason:'Synthetic timeout'});
    save('google_aio',{status:'unavailable',answer:'',citations:[],restriction:'captcha',reason:'Synthetic CAPTCHA'});
    lab.db.prepare("UPDATE console_browser_item SET state='uncertain',stage='waiting' WHERE id=?").run(itemFor('gemini',1).id);
    for(const n of [1,2])lab.db.prepare("UPDATE console_browser_item SET state='blocked' WHERE id=?").run(itemFor('google_aio',n).id);
    const saved=lab.db.prepare('SELECT * FROM console_attempt ORDER BY rowid').all(),frozen=lab.planRow(sourcePlan).config_json;
    jobs.setStatus(j.id,'paused');day('2026-09-27T12:00:00Z');
    expect(jobs.rows()[0]!.resume.expired).toBe(3);
    const next=jobs.resume(j.id);expect(next.continued).toBe(3);expect(next.id).not.toBe(j.id);
    expect(jobs.resume(j.id)).toMatchObject({id:next.id});expect(lab.db.prepare('SELECT COUNT(*) n FROM console_plan').get()).toMatchObject({n:2});
    expect(lab.plan(next.planId).slots).toHaveLength(3);expect(lab.plan(next.planId).slots.every(s=>s.window==='2026-09-27')).toBe(true);
    expect(jobs.job(next.id).config.verifiedCountry).toBeNull();expect(jobs.job(next.id).config.geoVerificationNote).toBe('');
    expect(lab.planRow(sourcePlan).config_json).toBe(frozen);expect(lab.db.prepare('SELECT * FROM console_attempt ORDER BY rowid').all()).toEqual(saved);
    expect(jobs.items(j.id).filter(i=>i.state==='carried_forward')).toHaveLength(3);
    expect(jobs.items(j.id).filter(i=>i.state==='blocked')).toHaveLength(2);
    expect(jobs.items(j.id).filter(i=>i.state==='uncertain')).toHaveLength(1);
    release();await drain(next.id);expect(calls).toHaveLength(3);expect(calls.every(c=>c.surface!=='google_aio')).toBe(true);
    expect(lab.report(next.planId).groups.reduce((n,g)=>n+g.planned,0)).toBe(3);
    expect(jobs.resume(j.id)).toMatchObject({id:next.id});expect(calls).toHaveLength(3);
    expect(jobs.rows().find(r=>r.id===j.id)!.resume.successor?.planId).toBe(next.planId);
  });
  it('follows persisted continuation links across another day without replaying saved answers',async()=>{
    day('2026-09-26T12:00:00Z');const calls:string[]=[];
    const adapter=collector(async task=>{calls.push(task.slotId);jobs.control({id:[...jobs.active.keys()][0],action:'pause'});return capture(task);});
    jobs=new BrowserJobs(lab,adapter,async()=>{});const j=queued(plan(2));
    day('2026-09-27T12:00:00Z');const first=jobs.resume(j.id);await drain(first.id);expect(calls).toHaveLength(1);
    jobs=new BrowserJobs(lab,adapter,async()=>{});day('2026-09-28T12:00:00Z');
    const next=jobs.resume(j.id);await drain(next.id);expect(next.continued).toBe(1);
    expect(lab.plan(next.planId).slots[0]!.window).toBe('2026-09-28');expect(calls).toHaveLength(2);expect(new Set(calls).size).toBe(2);
  });
  it('rolls back every continuation row if linking fails',()=>{
    day('2026-09-26T12:00:00Z');jobs=new BrowserJobs(lab,collector(async task=>capture(task)),async()=>{});
    const j=queued(plan(2)),old=jobs.items(j.id);day('2026-09-27T12:00:00Z');
    lab.db.exec("CREATE TRIGGER synthetic_link_failure BEFORE INSERT ON console_browser_continuation BEGIN SELECT RAISE(ABORT,'Synthetic link write failure'); END;");
    expect(()=>jobs.resume(j.id)).toThrow(/Synthetic link/);
    expect(jobs.items(j.id)).toEqual(old);expect(lab.db.prepare('SELECT COUNT(*) n FROM console_plan').get()).toMatchObject({n:1});
    expect(lab.db.prepare('SELECT COUNT(*) n FROM collection_run').get()).toMatchObject({n:1});expect(jobs.active.size).toBe(0);
  });
  it('keeps evidence obtained outside the queue out of a continuation',()=>{
    day('2026-09-26T12:00:00Z');jobs=new BrowserJobs(lab,collector(async task=>capture(task)),async()=>{});
    const planId=plan(1),j=queued(planId),p=lab.plan(planId),s=p.slots[0]!;
    lab.capture(key(),capture({slotId:s.id,prompt:s.prompt,surface:s.surface,config:p.config,timeoutSeconds:150,verifiedCountry:null,geoVerificationNote:''}));
    day('2026-09-27T12:00:00Z');expect(()=>jobs.resume(j.id)).toThrow(/没有可继续/);
    expect(lab.db.prepare('SELECT COUNT(*) n FROM console_plan').get()).toMatchObject({n:1});
  });
  it('requires fresh login preparation for a new private-mode plan',()=>{
    day('2026-09-26T12:00:00Z');let calls=0;const original=plan(1,['chatgpt_search'],'signed_in_private');
    jobs=new BrowserJobs(lab,{...collector(async task=>{calls++;return capture(task);}),ready:id=>id===original},async()=>{});
    const j=queued(original);day('2026-09-27T12:00:00Z');const next=jobs.resume(j.id);
    expect(next.needsLogin).toBe(true);expect(calls).toBe(0);expect(jobs.job(next.id).status).toBe('queued');
    expect(()=>jobs.resume(j.id)).toThrow(/登录窗口/);expect(lab.db.prepare('SELECT COUNT(*) n FROM console_plan').get()).toMatchObject({n:2});
  });
  it('uses the plan timezone at UTC midnight',async()=>{
    day('2026-09-26T12:00:00Z');jobs=new BrowserJobs(lab,collector(async task=>capture(task)),async()=>{});
    const original=lab.plan(plan(1));const planId=lab.createPlan(key(),{promptSetId:original.prompt_set_id,label:'Timezone fixture',timezone:'America/Halifax',surfaces:['chatgpt_search'],windows:['2026-09-26'],country:'CA',locale:'en-CA',device:'desktop'}).id;
    const j=queued(planId);day('2026-09-27T01:00:00Z');expect(jobs.rows()[0]!.resume).toMatchObject({expired:0,current:1,date:'2026-09-26'});
    const result=jobs.resume(j.id);await drain(result.id);expect(result.id).toBe(j.id);
  });
  it('retains an in-flight answer arriving after midnight as out-of-window evidence without resending it',async()=>{
    day('2026-09-26T23:59:59Z');const calls:string[]=[];
    jobs=new BrowserJobs(lab,collector(async(task,_signal,stage)=>{
      calls.push(task.slotId);
      // SQLite's clock is independent of the fake Date used for this boundary.
      lab.db.prepare('UPDATE console_browser_item SET started_at=? WHERE slot_id=?').run(new Date().toISOString(),task.slotId);
      stage('submitting');
      if(calls.length===1)day('2026-09-27T00:00:01Z');
      stage('capturing');return capture(task);
    }),async()=>{});
    const planId=plan(2),j=jobs.create(key(),input(planId));await drain(j.id);
    expect(jobs.rows()[0]).toMatchObject({status:'paused',captured:1,remaining:1});
    const first=lab.plan(planId).slots.find(slot=>slot.latest)!;
    expect(first.window).toBe('2026-09-26');
    expect(first.latest!.capture.observedAt).toBe('2026-09-27T00:00:01.000Z');
    expect(first.latest!.capture.answer).toContain('Northstar');
    expect(first.latest!.quality).toMatchObject({contentQualified:true,metricEligible:false});
    expect(first.latest!.quality.conditionIssues).toContain('观测时间不在计划窗口内');
    expect(jobs.items(j.id).some(item=>item.state==='uncertain')).toBe(false);
    expect(calls).toHaveLength(1);
    const saved=lab.db.prepare('SELECT * FROM console_attempt ORDER BY rowid').all();
    const next=jobs.resume(j.id);await drain(next.id);
    expect(next.continued).toBe(1);expect(calls).toHaveLength(2);expect(new Set(calls).size).toBe(2);
    expect(lab.db.prepare('SELECT * FROM console_attempt ORDER BY rowid').all().slice(0,saved.length)).toEqual(saved);
    expect(lab.plan(next.planId).slots[0]!.window).toBe('2026-09-27');
    expect(lab.report(planId).groups[0]).toMatchObject({observed:1,eligible:0});
  });
  it.each(['silent','visible','legacy'])('preserves %s browser conditions across a dated continuation',async mode=>{
    day('2026-09-26T12:00:00Z');const calls:BrowserTask[]=[];
    jobs=new BrowserJobs(lab,collector(async task=>{calls.push(task);return capture(task);}),async()=>{});
    const planId=plan(1);let id:string;
    if(mode==='legacy'){
      id=key();lab.db.prepare("INSERT INTO console_browser_job(id,plan_id,config_json,status) VALUES(?,?,?,'paused')").run(id,planId,JSON.stringify({...input(planId),timeoutSeconds:150}));
      const s=lab.plan(planId).slots[0]!;lab.db.prepare("INSERT INTO console_browser_item(id,job_id,slot_id,ordinal,state) VALUES(?,?,?,0,'pending')").run(key(),id,s.id);
    }else id=queued(planId,{browserMode:mode}).id;
    const frozen=jobs.job(id).config_json;day('2026-09-27T12:00:00Z');const next=jobs.resume(id);await drain(next.id);
    expect(jobs.job(next.id).config.browserMode).toBe(mode==='legacy'?'visible':mode);expect(calls[0]!.browserMode).toBe(mode==='legacy'?'visible':mode);expect(jobs.job(id).config_json).toBe(frozen);
  });
});

describe("durable browser queue with synthetic collectors", () => {
  it('collects three independent rounds for every question and platform',async()=>{
    const base=lab.plan(plan(2,['chatgpt_search','gemini']));
    const repeated=lab.createPlan(key(),{promptSetId:base.prompt_set_id,label:'Three rounds',surfaces:base.config.surfaces,windows:base.config.windows,
      country:'CA',locale:'en-CA',timezone:'UTC',device:'desktop',repetitions:3,egressPolicy:'canada_fixed'}).id;
    const calls:BrowserTask[]=[];jobs=new BrowserJobs(lab,collector(async task=>{calls.push(task);return capture(task);}),async()=>{});
    const j=jobs.create(key(),input(repeated));await drain(j.id);
    expect(calls).toHaveLength(12);expect(new Set(calls.map(t=>t.slotId)).size).toBe(12);
    const p=lab.plan(repeated);expect(p.slots.map(s=>s.run_idx)).toEqual([1,1,1,1,2,2,2,2,3,3,3,3]);
    expect(lab.report(repeated).groups.reduce((n,g)=>n+g.planned,0)).toBe(12);
    expect(jobs.resume(j.id).id).toBe(j.id);expect(calls).toHaveLength(12);
  });
  it('keeps unsubmitted work pending when the pinned Canada exit changes',async()=>{
    const p=plan(2);const proof={country:'CA',fingerprint:'a'.repeat(64),verifiedAt:new Date().toISOString(),provider:'cloudflare_trace' as const};
    jobs=new BrowserJobs(lab,collector(async(task,_signal,stage)=>{stage('preparing');task.confirmEgress?.({...proof,fingerprint:'b'.repeat(64)});return capture(task);}),async()=>{});
    jobs.confirmEgress(p,proof);const j=jobs.create(key(),input(p));await drain(j.id);
    expect(jobs.job(j.id).status).toBe('paused');expect(jobs.items(j.id).every(i=>i.state==='pending')).toBe(true);
    expect(lab.db.prepare('SELECT count(*) n FROM console_attempt').get()).toMatchObject({n:0});
    expect(()=>jobs.confirmEgress(p,proof)).not.toThrow();expect(()=>jobs.confirmEgress(p,{...proof,country:'US'})).toThrow(/出口/);
  });
  it('runs three provider lanes concurrently but never overlaps questions within a provider',async()=>{
    const inflight=new Set<string>(),peak:number[]=[],waits:number[]=[];let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});let first=0;
    jobs=new BrowserJobs(lab,collector(async task=>{
      expect(inflight.has(task.surface)).toBe(false);inflight.add(task.surface);peak.push(inflight.size);
      if(++first<=3){if(first===3)release();await gate;}
      inflight.delete(task.surface);return capture(task);
    }),async ms=>{waits.push(ms);});
    const j=jobs.create(key(),{planId:plan(3,['chatgpt_search','google_aio','gemini']),transmissionAcknowledged:true});
    expect(jobs.rows()[0]!.currents).toHaveLength(3);await drain(j.id);
    expect(Math.max(...peak)).toBe(3);expect(waits).toEqual(Array(6).fill(10000));
    expect(jobs.job(j.id).config.executionMode).toBe('parallel');expect(jobs.rows()[0]!.captured).toBe(9);
  });
  it.each(['capture','throw'])('isolates a provider %s failure and resumes only its unsubmitted questions',async failure=>{
    let gemini=0,chatgpt=0;
    jobs=new BrowserJobs(lab,collector(async(task,_signal,stage)=>{
      stage('waiting');if(task.surface==='gemini'&&++gemini===1){
        if(failure==='throw')throw new Error('Synthetic adapter failure');
        return capture(task,{status:'error',answer:'',citations:[],reason:'Synthetic timeout'});
      }
      if(task.surface==='chatgpt_search')chatgpt++;return capture(task);
    }),async()=>{});
    const j=jobs.create(key(),input(plan(3,['gemini','chatgpt_search'])));await drain(j.id);
    expect(gemini).toBe(1);expect(chatgpt).toBe(3);expect(jobs.job(j.id).status).toBe('needs_attention');
    expect(jobs.items(j.id).filter(i=>i.state==='pending')).toHaveLength(2);
    expect(jobs.rows()[0]!.failedRecords).toBe(failure==='capture'?1:0);
    if(failure==='throw')expect(jobs.items(j.id).filter(i=>i.state==='uncertain')).toHaveLength(1);
    jobs.start(j.id);await drain(j.id);expect(gemini).toBe(3);expect(chatgpt).toBe(3);
  });
  it('saves every in-flight lane before pausing and resumes without duplicates',async()=>{
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const calls:string[]=[];
    jobs=new BrowserJobs(lab,collector(async(task,_signal,stage)=>{calls.push(task.slotId);stage('waiting');await gate;return capture(task);}),async()=>{});
    const j=jobs.create(key(),input(plan(2,['chatgpt_search','google_aio','gemini'])));
    jobs.control({id:j.id,action:'pause'});release();await drain(j.id);
    expect(jobs.rows()[0]).toMatchObject({status:'paused',captured:3,remaining:3});
    jobs.start(j.id);await drain(j.id);expect(calls).toHaveLength(6);expect(new Set(calls).size).toBe(6);
  });
  it('cancels all lane intervals immediately without submitting another question',async()=>{
    let notify!:()=>void;const waiting=new Promise<void>(r=>{notify=r;});let count=0;
    jobs=new BrowserJobs(lab,collector(async task=>capture(task)),async(_ms,signal)=>{
      if(++count===3)notify();await new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    });
    const j=jobs.create(key(),input(plan(2,['chatgpt_search','google_aio','gemini'])));await waiting;
    jobs.control({id:j.id,action:'pause'});await drain(j.id);
    expect(jobs.rows()[0]).toMatchObject({status:'paused',captured:3,remaining:3});
  });
  it('quarantines all submitted lanes on stop and never automatically resends them',async()=>{
    let stopped=false;const calls:string[]=[];
    jobs=new BrowserJobs(lab,collector(async(task,signal,stage)=>{
      calls.push(task.slotId);if(stopped)return capture(task);stage('submitting');
      return await new Promise<Capture>((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('closed')),{once:true}));
    }),async()=>{});
    const j=jobs.create(key(),input(plan(2,['chatgpt_search','google_aio','gemini'])));
    stopped=true;jobs.control({id:j.id,action:'stop'});await drain(j.id);
    expect(jobs.items(j.id).filter(i=>i.state==='uncertain')).toHaveLength(3);
    jobs.start(j.id);await drain(j.id);expect(calls).toHaveLength(6);expect(new Set(calls).size).toBe(6);
    expect(jobs.rows()[0]).toMatchObject({captured:3,attention:3,status:'needs_attention'});
  });
  it('drains every lane before closing the browser when evidence identity is wrong',async()=>{
    let release!:()=>void;const ready=new Promise<void>(r=>{release=r;});let exited=false,closed=false;
    jobs=new BrowserJobs(lab,{...collector(async(task,signal,stage)=>{
      stage('waiting');
      if(task.surface==='chatgpt_search'){await ready;return capture(task,{slotId:'wrong-slot'});}
      release();try{return await new Promise<Capture>((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}finally{exited=true;}
    }),close:async()=>{expect(exited).toBe(true);closed=true;}},async()=>{});
    const j=jobs.create(key(),input(plan(2,['chatgpt_search','gemini'])));await drain(j.id);
    expect(closed).toBe(true);expect(jobs.job(j.id).status).toBe('needs_attention');expect(jobs.items(j.id).some(i=>i.state==='running')).toBe(false);
  });
  it.each(['serial','legacy'])('keeps %s jobs sequential without rewriting their frozen config',async mode=>{
    let active=0,peak=0;const waits:number[]=[];
    jobs=new BrowserJobs(lab,collector(async task=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;return capture(task);}),async ms=>{waits.push(ms);});
    const planId=plan(2,['chatgpt_search','gemini']);let id:string;
    if(mode==='legacy'){
      id=key();lab.db.prepare("INSERT INTO console_browser_job(id,plan_id,config_json,status) VALUES(?,?,?,'queued')").run(id,planId,JSON.stringify({...input(planId),timeoutSeconds:150}));
      for(const [ordinal,s] of lab.plan(planId).slots.entries())lab.db.prepare("INSERT INTO console_browser_item(id,job_id,slot_id,ordinal,state) VALUES(?,?,?,?,'pending')").run(key(),id,s.id,ordinal);
      jobs.start(id);
    }else id=jobs.create(key(),{...input(planId),executionMode:'serial'}).id;
    await drain(id);expect(peak).toBe(1);expect(waits).toEqual([5000,5000,5000]);
    if(mode==='legacy')expect(jobs.job(id).config.executionMode).toBeUndefined();
  });
  it('treats a failed durable checkpoint as global even when a collector catches it',async()=>{
    let release!:()=>void;const ready=new Promise<void>(r=>{release=r;});let drained=false;
    jobs=new BrowserJobs(lab,collector(async(task,signal,stage)=>{
      if(task.surface==='chatgpt_search'){
        await ready;try{stage('submitting');}catch{/* Simulate a collector retaining an error artifact. */}
        return capture(task,{status:'error',answer:'',citations:[],reason:'Checkpoint failed'});
      }
      stage('waiting');release();try{return await new Promise<Capture>((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('closed')),{once:true}));}finally{drained=true;}
    }),async()=>{});
    lab.db.exec(`CREATE TRIGGER synthetic_checkpoint_failure BEFORE UPDATE OF stage ON console_browser_item
      WHEN NEW.stage='submitting' BEGIN SELECT RAISE(ABORT,'Synthetic checkpoint write failure'); END;`);
    const j=jobs.create(key(),input(plan(2,['chatgpt_search','gemini'])));await drain(j.id);
    expect(drained).toBe(true);expect(jobs.rows()[0]).toMatchObject({status:'needs_attention',captured:0});
    expect(jobs.items(j.id).some(i=>i.state==='running')).toBe(false);
  });
  it('persists text-only defaults and explicit screenshot choices through queue dispatch',async()=>{
    const tasks:BrowserTask[]=[];jobs=new BrowserJobs(lab,collector(async task=>{tasks.push(task);return capture(task);}),async()=>{});
    const first=jobs.create(key(),input(plan(2)));await drain(first.id);expect(jobs.job(first.id).config.captureScreenshot).toBe(false);expect(tasks.every(t=>t.captureScreenshot===false)).toBe(true);
    tasks.length=0;const next=jobs.create(key(),{...input(plan(2)),captureScreenshot:true});await drain(next.id);expect(jobs.job(next.id).config.captureScreenshot).toBe(true);expect(tasks.every(t=>t.captureScreenshot===true)).toBe(true);
  });
  it('defaults new batches to silent and dispatches explicit visible choices without changing config',async()=>{
    const tasks:BrowserTask[]=[];jobs=new BrowserJobs(lab,collector(async task=>{tasks.push(task);return capture(task);}),async()=>{});
    const first=jobs.create(key(),input(plan(2)));await drain(first.id);expect(jobs.job(first.id).config.browserMode).toBe('silent');expect(tasks.every(t=>t.browserMode==='silent')).toBe(true);
    tasks.length=0;const next=jobs.create(key(),{...input(plan(2)),browserMode:'visible'});const frozen=jobs.job(next.id).config_json;await drain(next.id);
    expect(tasks.every(t=>t.browserMode==='visible')).toBe(true);expect(jobs.job(next.id).config_json).toBe(frozen);
  });
  it("covers 100 questions across three surfaces as 300 independent positions", async () => {
    const calls: string[] = [];
    jobs = new BrowserJobs(lab, collector(async task => { calls.push(task.surface + ':' + task.prompt); return capture(task); }), async () => {});
    const j = jobs.create(key(), input(plan(100, ["chatgpt_search", "google_aio", "gemini"]))); await drain(j.id);
    expect(calls).toHaveLength(300); expect(new Set(calls).size).toBe(300);
    expect(jobs.screening(j.id)).toMatchObject({ total: 300, captured: 300, eligible: 300 });
  });
  it("processes 100 questions exactly once and outputs qualified results without human review", async () => {
    const planId = plan(), calls: string[] = [];
    jobs = new BrowserJobs(lab, collector(async (task, _signal, stage) => { calls.push(task.prompt); stage("submitting"); stage("capturing"); return capture(task); }), async () => {});
    const requestId = key(), j = jobs.create(requestId, input(planId)); await drain(j.id);
    expect(calls).toHaveLength(100); expect(new Set(calls).size).toBe(100);
    expect(jobs.rows()[0]).toMatchObject({ total: 100, captured: 100, status: "completed", attention: 0 });
    expect(jobs.create(requestId, input(planId))).toEqual(j); expect(calls).toHaveLength(100);
    expect(() => jobs.create(key(), input(planId))).toThrow(/没有尚未入队/);
    expect(jobs.screening(j.id)).toMatchObject({ total: 100, captured: 100, reviewed: 0, eligible: 100 });
    expect(jobs.screening(j.id).rows.every(r => r.category === "owned_citation")).toBe(true);
    const attemptId = jobs.items(j.id)[0]!.attempt_id!;
    lab.review(key(), { attemptId, decision: "accept", note: "Synthetic reviewer verification", privacyReviewed: true });
    expect(jobs.screening(j.id).eligible).toBe(100);
    expect(lab.db.prepare("SELECT collection_mode FROM observation_surface_context").get()).toMatchObject({ collection_mode: "browser_automation" });
    lab.review(key(), { attemptId: jobs.items(j.id)[1]!.attempt_id!, decision: "reject", note: "Incomplete source range", privacyReviewed: true });
    expect(jobs.screening(j.id).rows[1]).toMatchObject({ category: "insufficient", ownedCitation: null, eligible: false });
  });
  it("pauses after saving the current response and resumes without sending it again", async () => {
    let release!: () => void; const blocked = new Promise<void>(r => { release = r; }); let calls = 0;
    jobs = new BrowserJobs(lab, collector(async (task, _signal, stage) => { calls++; stage("waiting"); if (calls === 1) await blocked; return capture(task); }), async () => {});
    const j = jobs.create(key(), input(plan(3))); jobs.control({ id: j.id, action: "pause" }); release(); await drain(j.id);
    expect(calls).toBe(1); expect(jobs.rows()[0]).toMatchObject({ status: "paused", captured: 1, remaining: 2 });
    jobs.start(j.id); await drain(j.id); expect(calls).toBe(3); expect(jobs.job(j.id).status).toBe("completed");
  });
  it("wakes a between-question interval immediately when paused", async () => {
    let waiting!: () => void; const intervalStarted = new Promise<void>(r => { waiting = r; }); let calls = 0;
    jobs = new BrowserJobs(lab, collector(async task => { calls++; return capture(task); }), async (_ms, signal) => {
      waiting(); await new Promise<void>((_r, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const j = jobs.create(key(), input(plan(3))); await intervalStarted; jobs.control({ id: j.id, action: "pause" }); await drain(j.id);
    expect(calls).toBe(1); expect(jobs.job(j.id).status).toBe("paused");
  });
  it("records an interrupted submitted request as uncertain and never automatically resends it", async () => {
    let calls = 0;
    jobs = new BrowserJobs(lab, collector(async (task, signal, stage) => { calls++; if (calls > 1) return capture(task); stage("submitting");
      return await new Promise<Capture>((_r, reject) => signal.addEventListener("abort", () => reject(new Error("closed")), { once: true })); }), async () => {});
    const j = jobs.create(key(), input(plan(3))); jobs.control({ id: j.id, action: "stop" }); await drain(j.id);
    expect(jobs.items(j.id)[0]!.state).toBe("uncertain"); jobs.start(j.id); await drain(j.id);
    expect(calls).toBe(3); expect(jobs.rows()[0]).toMatchObject({ captured: 2, attention: 1, status: "needs_attention" });
  });
  it("persists a captcha then blocks that surface while continuing other surfaces", async () => {
    const calls: string[] = [];
    jobs = new BrowserJobs(lab, collector(async task => { calls.push(task.surface); return task.surface === "google_aio"
      ? capture(task, { status: "unavailable", restriction: "captcha", reason: "Synthetic CAPTCHA", answer: "", citations: [] }) : capture(task); }), async () => {});
    const j = jobs.create(key(), input(plan(3, ["google_aio", "chatgpt_search"]))); await drain(j.id);
    expect(calls.filter(s => s === "google_aio")).toHaveLength(1); expect(calls.filter(s => s === "chatgpt_search")).toHaveLength(3);
    expect(jobs.rows()[0]).toMatchObject({ captured: 4, attention: 3, status: "needs_attention" });
    expect(jobs.screening(j.id).rows.filter(r => r.category === "insufficient")).toHaveLength(3);
  });
  it("stops after a parser error instead of repeating the same failure 100 times", async () => {
    let calls = 0;
    jobs = new BrowserJobs(lab, collector(async task => { calls++; return capture(task, { status: "error", reason: "Synthetic selector failure", answer: "", citations: [] }); }), async () => {});
    const j = jobs.create(key(), input(plan())); await drain(j.id);
    expect(calls).toBe(1); expect(jobs.rows()[0]).toMatchObject({ captured: 1, remaining: 99, status: "needs_attention" });
  });
  it("does not infer citation absence when the source panel was not fully extracted", async () => {
    jobs = new BrowserJobs(lab, collector(async task => { const c=capture(task); c.citations=[]; c.browser!.citationsComplete=false; return c; }), async () => {});
    const j=jobs.create(key(), input(plan(1))); await drain(j.id);
    expect(jobs.screening(j.id).rows[0]).toMatchObject({ category: "insufficient", brandMentioned: null, ownedCitation: null, eligible: false });
  });
  it("recovers pre-submit work but quarantines committed submission checkpoints after restart", async () => {
    const planId = plan(3); const provider = collector(async task => capture(task));
    jobs = new BrowserJobs(lab, provider, async () => {});
    // Keep this batch queued to simulate process loss at specific persisted checkpoints.
    jobs.active.set("other", { pause: false, controller: new AbortController(), promise: Promise.resolve(), intervals: new Set() });
    const j = jobs.create(key(), input(planId)); jobs.active.clear();
    const items = jobs.items(j.id);
    lab.db.prepare("UPDATE console_browser_item SET state='running',stage='preparing' WHERE id=?").run(items[0]!.id);
    lab.db.prepare("UPDATE console_browser_item SET state='running',stage='submitting' WHERE id=?").run(items[1]!.id);
    jobs.setStatus(j.id, "running");
    jobs = new BrowserJobs(lab, provider, async () => {});
    expect(jobs.job(j.id).status).toBe("interrupted"); expect(jobs.items(j.id).map(i => i.state)).toEqual(["pending", "uncertain", "pending"]);
    jobs.start(j.id); await drain(j.id); expect(jobs.rows()[0]).toMatchObject({ captured: 2, attention: 1 });
  });
  it("keeps incomplete, unverified and synthetic captures out of formal metrics", async () => {
    jobs = new BrowserJobs(lab, collector(async task => capture(task, { collectionMode: "fixture", exitCountry: null, geo: "unverified" })), async () => {});
    const j = jobs.create(key(), input(plan(1))); await drain(j.id);
    lab.review(key(), { attemptId: jobs.items(j.id)[0]!.attempt_id!, decision: "accept", note: "Synthetic test", privacyReviewed: true });
    expect(jobs.screening(j.id)).toMatchObject({ eligible: 0, reviewed: 1 });
    expect(jobs.screening(j.id).rows[0]!.issues).toContain("合成演示数据");
    lab.db.exec("DROP TRIGGER console_artifact_immutable_UPDATE"); lab.db.prepare("UPDATE console_artifact SET bytes=?").run(Buffer.from("tampered"));
    expect(jobs.screening(j.id).rows[0]).toMatchObject({ integrity: false, category: "insufficient", brandMentioned: null });
  });
});

describe('explicit ephemeral login preparation',()=>{
  it.each(['signed_in_private','isolated'])('preserves verified %s preparation across a graceful pause and resumes only unsent questions',async accountMode=>{
    const planId=plan(3,['chatgpt_search'],accountMode),calls:string[]=[];
    let verified=true,release!:()=>void;const first=new Promise<void>(resolve=>{release=resolve;});
    const close=vi.fn(async()=>{verified=false;});
    const adapter:BrowserCollector={...collector(async(task,_signal,stage)=>{
      expect(verified).toBe(true);calls.push(task.slotId);stage('waiting');await first;stage('capturing');
      return capture(task,{account:'logged_in',session:'active',privacy:{mode:accountMode==='isolated'?'signed_in_independent':'signed_in_private',temporaryChat:accountMode==='isolated'?'unknown':'verified',personalization:accountMode==='isolated'?'unknown':'disabled',newConversation:true}});
    }),sessions:()=>verified?[{planId,surface:'chatgpt_search',verified:true}]:[],ready:id=>id===planId&&verified,close};
    jobs=new BrowserJobs(lab,adapter,async()=>{});
    const j=jobs.create(key(),input(planId));jobs.control({id:j.id,action:'pause'});release();await drain(j.id);
    expect(jobs.rows()[0]).toMatchObject({status:'paused',captured:1,remaining:2,failedRecords:0});
    expect(close).not.toHaveBeenCalled();expect(verified).toBe(true);
    const original=lab.db.prepare('SELECT * FROM console_attempt ORDER BY rowid').all();
    jobs.resume(j.id);await drain(j.id);
    expect(calls).toHaveLength(3);expect(new Set(calls).size).toBe(3);
    expect(lab.db.prepare('SELECT * FROM console_attempt ORDER BY rowid').all().slice(0,original.length)).toEqual(original);
    expect(jobs.job(j.id).status).toBe('completed');expect(close).toHaveBeenCalledTimes(1);expect(verified).toBe(false);
    expect(lab.db.prepare('SELECT COUNT(*) n FROM console_review').get()).toMatchObject({n:0});
  });
  it('ends the retained preparation on an explicit stop while already paused',async()=>{
    const planId=plan(2,['chatgpt_search'],'signed_in_private');let verified=true;
    const close=vi.fn(async()=>{verified=false;}),closePlanSessions=vi.fn(async id=>{expect(id).toBe(planId);verified=false;});
    jobs=new BrowserJobs(lab,{...collector(async task=>{jobs.control({id:[...jobs.active.keys()][0],action:'pause'});return capture(task);}),
      sessions:()=>verified?[{planId,surface:'chatgpt_search',verified:true}]:[],ready:id=>id===planId&&verified,close,closePlanSessions},async()=>{});
    const j=jobs.create(key(),input(planId));await drain(j.id);expect(verified).toBe(true);expect(close).not.toHaveBeenCalled();
    const saved=jobs.items(j.id);await jobs.control({id:j.id,action:'stop'});
    expect(closePlanSessions).toHaveBeenCalledTimes(1);expect(verified).toBe(false);expect(jobs.items(j.id)).toEqual(saved);
    expect(()=>jobs.resume(j.id)).toThrow(/登录窗口/);expect(jobs.active.size).toBe(0);
  });
  it('closes retained preparation on app shutdown without replaying saved or unsent positions',async()=>{
    const planId=plan(2,['chatgpt_search'],'isolated');let verified=true;
    const calls:string[]=[],close=vi.fn(async()=>{verified=false;});
    jobs=new BrowserJobs(lab,{...collector(async task=>{calls.push(task.slotId);jobs.control({id:[...jobs.active.keys()][0],action:'pause'});return capture(task);}),
      sessions:()=>verified?[{planId,surface:'chatgpt_search',verified:true}]:[],close},async()=>{});
    const j=jobs.create(key(),input(planId));await drain(j.id);expect(close).not.toHaveBeenCalled();
    const saved=jobs.items(j.id);await jobs.pauseAll();
    expect(close).toHaveBeenCalledTimes(1);expect(verified).toBe(false);expect(calls).toHaveLength(1);expect(jobs.items(j.id)).toEqual(saved);
  });
  it('closes preparation after an immediate stop and keeps submitted requests uncertain',async()=>{
    const planId=plan(2,['chatgpt_search'],'signed_in_private');let verified=true;
    const calls:string[]=[],close=vi.fn(async()=>{verified=false;});
    jobs=new BrowserJobs(lab,{...collector(async(task,signal,stage)=>{
      calls.push(task.slotId);stage('submitting');return await new Promise<Capture>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Synthetic stop')),{once:true}));
    }),sessions:()=>verified?[{planId,surface:'chatgpt_search',verified:true}]:[],ready:id=>id===planId&&verified,close},async()=>{});
    const j=jobs.create(key(),input(planId));jobs.control({id:j.id,action:'stop'});await drain(j.id);
    expect(close).toHaveBeenCalledTimes(1);expect(verified).toBe(false);
    expect(jobs.items(j.id).map(item=>item.state)).toEqual(['uncertain','pending']);
    expect(()=>jobs.resume(j.id)).toThrow(/登录窗口/);expect(calls).toHaveLength(1);
  });
  it('does not retain a preparation that is no longer reported verified during pause',async()=>{
    const planId=plan(2,['chatgpt_search'],'signed_in_private');let verified=true;
    const close=vi.fn(async()=>{verified=false;});
    jobs=new BrowserJobs(lab,{...collector(async task=>{jobs.control({id:[...jobs.active.keys()][0],action:'pause'});verified=false;return capture(task);}),
      sessions:()=>[{planId,surface:'chatgpt_search',verified}],ready:id=>id===planId&&verified,close},async()=>{});
    const j=jobs.create(key(),input(planId));await drain(j.id);
    expect(close).toHaveBeenCalledTimes(1);expect(()=>jobs.resume(j.id)).toThrow(/登录窗口/);
  });
  it('requires confirmation for each provider, carries frozen plan identity, clears sessions after a 100-question batch and supports idempotent replay',async()=>{
    const planId=plan(100,['chatgpt_search','google_aio'],'signed_in_private'),confirmed=new Set<string>(),opened=new Set<string>(),calls:BrowserTask[]=[];
    const adapter:BrowserCollector={...collector(async task=>{calls.push(task);return capture(task,{account:'logged_in',session:'active',privacy:{mode:'signed_in_private',temporaryChat:task.surface==='chatgpt_search'?'verified':'not_applicable',personalization:'disabled',newConversation:true}});}),
      ready:(id,surfaces)=>id===planId&&surfaces.every(s=>confirmed.has(s)),prepareSession:async t=>{opened.add(t.surface);},verifySession:async(_id,s)=>{if(!opened.has(s))throw new Error('Not opened');confirmed.add(s);},close:async()=>{confirmed.clear();opened.clear();}};
    jobs=new BrowserJobs(lab,adapter,async()=>{});
    expect(()=>jobs.create(key(),input(planId))).toThrow(/登录窗口/);
    for(const surface of ['chatgpt_search','google_aio']){
      await jobs.sessionControl({planId,surface,action:'open'});
      expect(()=>jobs.create(key(),input(planId))).toThrow(/登录窗口/);
      await jobs.sessionControl({planId,surface,action:'verify'});
    }
    const requestId=key(),j=jobs.create(requestId,input(planId));await drain(j.id);
    expect(calls).toHaveLength(200);expect(calls.every(c=>c.planId===planId&&c.config.accountMode==='signed_in_private')).toBe(true);expect(confirmed.size).toBe(0);
    expect(jobs.create(requestId,input(planId))).toEqual(j);expect(calls).toHaveLength(200);
    const attempt=jobs.items(j.id)[0]!.attempt_id!;lab.review(key(),{attemptId:attempt,decision:'accept',note:'Synthetic logged-in privacy evidence',privacyReviewed:true});
    expect(jobs.screening(j.id).eligible).toBe(200);
    expect(lab.report(planId).scope).toContain('登录态');
    expect(lab.report(planId).records[0]!.conditions?.privacy?.personalization).toBe('disabled');
  });
  it('rejects preparation on baseline plans and closes unused prepared windows on shutdown',async()=>{
    let closed=0;const id=plan(1);jobs=new BrowserJobs(lab,{...collector(async t=>capture(t)),close:async()=>{closed++;}},async()=>{});
    await expect(jobs.sessionControl({planId:id,surface:'chatgpt_search',action:'open'})).rejects.toThrow(/没有启用/);
    await jobs.pauseAll();expect(closed).toBe(1);
  });
});
