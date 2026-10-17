import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {randomUUID} from "node:crypto";
import {connectLedger} from "../../src/db/index.ts";
import {BrowserJobs} from "../../src/console/browser-jobs.ts";
import {LabService} from "../../src/console/service.ts";
import type {TrustedBrowserCaptureContext} from "../../src/console/service.ts";
import type {Capture} from "../../src/console/contracts.ts";
import {canonicalJson, sha256} from "../../src/lib/canonical-json.ts";

// Historical synthetic records only; no browser, provider request or user ledger.
let lab: LabService;
const key = () => randomUUID();
beforeEach(() => { lab = new LabService(connectLedger(":memory:")); new BrowserJobs(lab); });
afterEach(() => lab.db.close());

function fixture(options: {timezone?:string;startedAt?:string;jobConfig?:string;jobStatus?:string} = {}) {
  const brandId = lab.createBrand(key(), {name:"Northstar",aliases:[],ownedDomains:["northstar.example"]}).id;
  const setId = lab.createSet(key(), {brandId,label:"Synthetic midnight",locale:"en-CA",source:"Synthetic queue test",kind:"hypothesis",
    prompts:[{text:"Which restaurant scheduling tools are useful?",intent:"discovery"}]}).id;
  lab.freeze(key(), setId);
  const planId = lab.createPlan(key(), {promptSetId:setId,label:"Synthetic midnight plan",surfaces:["chatgpt_search"],
    accountMode:"isolated",windows:["2026-09-25"],country:"CA",locale:"en-CA",timezone:options.timezone??"UTC",device:"desktop"}).id;
  const slot = lab.plan(planId).slots[0]!, context:TrustedBrowserCaptureContext = {jobId:key(),itemId:key()};
  lab.db.prepare("INSERT INTO console_browser_job(id,plan_id,config_json,status) VALUES(?,?,?,?)")
    .run(context.jobId,planId,options.jobConfig??JSON.stringify({planId}),options.jobStatus??"running");
  lab.db.prepare("INSERT INTO console_browser_item(id,job_id,slot_id,ordinal,state,stage,started_at) VALUES(?,?,?,0,'running','capturing',?)")
    .run(context.itemId,context.jobId,slot.id,options.startedAt??"2026-09-25 23:59:59");
  const answer = "Northstar has a useful restaurant scheduling guide.";
  const raw = canonicalJson({schema:"synthetic-midnight-original",question:slot.prompt,answer,citations:[{url:"https://northstar.example/guide"}],observedAt:"2026-09-26T00:00:01Z"});
  const capture:Capture = {slotId:slot.id,prompt:slot.prompt,status:"observed",reason:"",restriction:"none",observedAt:"2026-09-26T00:00:01Z",
    answer,citations:[{url:"https://northstar.example/guide",placement:"source_panel"}],model:"synthetic-test",sourceUrl:"https://chatgpt.com/",
    account:"logged_out",session:"fresh",privacy:{mode:"signed_out",temporaryChat:"not_applicable",personalization:"unknown",newConversation:true},
    exitCountry:"CA",geo:"ip_observed",locale:"en-CA",timezone:options.timezone??"UTC",device:"desktop",geolocation:"denied",searchMode:"explicit_search",
    collectionMode:"browser_capture",retrievalUsed:true,browser:{name:"Google Chrome",mode:"silent",version:"synthetic",extractorVersion:"midnight-test",
      answerComplete:true,citationsComplete:true,citationControls:1,citationControlsOpened:1,notes:[]},artifact:{mime:"text/plain",base64:Buffer.from(raw).toString("base64")}};
  return {planId,setId,slot,context,capture,raw};
}
function counts() {
  return {attempts:(lab.db.prepare("SELECT COUNT(*) n FROM console_attempt").get() as {n:number}).n,
    artifacts:(lab.db.prepare("SELECT COUNT(*) n FROM console_artifact").get() as {n:number}).n};
}

describe("trusted in-flight browser responses crossing a frozen date window", () => {
  it("retains the original artifact and actual return time while preserving the frozen window and excluding formal metrics", () => {
    const f = fixture(), beforePlan = lab.planRow(f.planId), requestId = key();
    const saved = lab.capture(requestId,f.capture,f.context), latest = lab.plan(f.planId).slots[0]!.latest!;
    expect(latest).toMatchObject({id:saved.id,integrity:true,capture:{observedAt:f.capture.observedAt,answer:f.capture.answer,citations:f.capture.citations},
      quality:{contentQualified:true,metricEligible:false,status:"condition_mismatch",retryable:false}});
    expect(latest.quality.conditionIssues).toContain("观测时间不在计划窗口内");
    expect(Buffer.from(lab.artifact(latest.capture.artifactHash!).bytes).equals(Buffer.from(f.raw))).toBe(true);
    expect(latest.capture.artifactHash).toBe(sha256(f.raw));
    expect(lab.planRow(f.planId)).toEqual(beforePlan);
    expect(lab.plan(f.planId).slots[0]!.window).toBe("2026-09-25");
    expect(lab.report(f.planId).groups[0]).toMatchObject({observed:1,contentQualified:1,eligible:0,brandMentions:0,ownedCitations:0,conditionMismatched:1});
    expect(counts()).toEqual({attempts:1,artifacts:1});
    expect(() => lab.db.prepare("UPDATE console_attempt SET capture_json='{}' WHERE id=?").run(saved.id)).toThrow(/不可修改/);
    expect(() => lab.db.prepare("UPDATE console_slot SET window='2026-09-26' WHERE id=?").run(f.slot.id)).toThrow(/不可修改/);
    // Exact command receipt remains idempotent after queue completion; a new capture cannot replay the slot.
    lab.db.prepare("UPDATE console_browser_item SET state='captured',stage='saved',attempt_id=? WHERE id=?").run(saved.id,f.context.itemId);
    expect(lab.capture(requestId,f.capture,f.context)).toEqual(saved);
    expect(() => lab.capture(key(),f.capture,f.context)).toThrow(/计划窗口/);
    expect(counts()).toEqual({attempts:1,artifacts:1});
  });
  it("uses the plan timezone for a SQLite UTC dispatch timestamp, including a graceful pause", () => {
    const f = fixture({timezone:"America/Halifax",startedAt:"2026-09-26 02:59:59",jobStatus:"pausing"});
    f.capture.observedAt = "2026-09-26T03:00:01Z";
    const saved = lab.capture(key(),f.capture,f.context);
    expect(lab.plan(f.planId).slots[0]!.latest).toMatchObject({id:saved.id,capture:{observedAt:f.capture.observedAt},quality:{metricEligible:false}});
  });
  it("accepts an explicit ISO dispatch timestamp without changing the response timestamp", () => {
    const f = fixture({startedAt:"2026-09-25T23:59:59Z"});
    lab.capture(key(),f.capture,f.context);
    expect(lab.plan(f.planId).slots[0]!.latest!.capture.observedAt).toBe(f.capture.observedAt);
  });
  it.each(["manual_capture","browser_capture"] as const)("keeps out-of-window %s API/import calls strict without trusted context", collectionMode => {
    const f = fixture();
    expect(() => lab.capture(key(),{...f.capture,collectionMode})).toThrow(/计划窗口/);
    expect(counts()).toEqual({attempts:0,artifacts:0});
  });
  it("cannot supply trusted queue identity through the public capture payload", () => {
    const f = fixture();
    expect(() => lab.capture(key(),{...f.capture,trustedBrowserContext:f.context})).toThrow();
    expect(counts()).toEqual({attempts:0,artifacts:0});
  });
  it.each(["bad_id","extra_field","unknown_item","wrong_job"] as const)("rejects malformed or unlinked context: %s", kind => {
    const f = fixture();
    const context = kind === "bad_id" ? {...f.context,itemId:"not-a-uuid"}
      : kind === "extra_field" ? {...f.context,allowCrossWindow:true}
        : kind === "unknown_item" ? {...f.context,itemId:key()} : {...f.context,jobId:key()};
    expect(() => lab.capture(key(),f.capture,context)).toThrow();
    expect(counts()).toEqual({attempts:0,artifacts:0});
  });
  it.each(["preparing","submitting","waiting","saved"])("does not authorize a %s checkpoint", stage => {
    const f = fixture();
    lab.db.prepare("UPDATE console_browser_item SET stage=? WHERE id=?").run(stage,f.context.itemId);
    expect(() => lab.capture(key(),f.capture,f.context)).toThrow(/计划窗口/);
    expect(counts()).toEqual({attempts:0,artifacts:0});
  });
  it("requires a running item and linked active job", () => {
    const f = fixture();
    lab.db.prepare("UPDATE console_browser_item SET state='pending' WHERE id=?").run(f.context.itemId);
    expect(() => lab.capture(key(),f.capture,f.context)).toThrow(/计划窗口/);
    lab.db.prepare("UPDATE console_browser_item SET state='running' WHERE id=?").run(f.context.itemId);
    lab.db.prepare("UPDATE console_browser_job SET status='paused' WHERE id=?").run(f.context.jobId);
    expect(() => lab.capture(key(),f.capture,f.context)).toThrow(/计划窗口/);
    expect(counts()).toEqual({attempts:0,artifacts:0});
  });
  it.each(["2026-09-26 00:00:00","invalid","2026-09-25T23:59:59"])("rejects dispatch outside the frozen window or without a valid zone: %s", startedAt => {
    const f = fixture({startedAt});
    expect(() => lab.capture(key(),f.capture,f.context)).toThrow(/计划窗口/);
    expect(counts()).toEqual({attempts:0,artifacts:0});
  });
  it.each(["{}","{invalid",JSON.stringify({planId:"unlinked-plan"})])("rejects malformed or unlinked frozen browser-job config: %s", jobConfig => {
    const f = fixture({jobConfig});
    expect(() => lab.capture(key(),f.capture,f.context)).toThrow(/计划窗口/);
    expect(counts()).toEqual({attempts:0,artifacts:0});
  });
  it("rejects a response timestamp before dispatch and a manual capture even with real queue IDs", () => {
    const f = fixture();
    expect(() => lab.capture(key(),{...f.capture,observedAt:"2026-09-24T23:59:59Z"},f.context)).toThrow(/计划窗口/);
    expect(() => lab.capture(key(),{...f.capture,collectionMode:"manual_capture"},f.context)).toThrow(/计划窗口/);
    expect(counts()).toEqual({attempts:0,artifacts:0});
  });
  it("does not bypass earlier external evidence while the browser item still has no attempt ID", () => {
    const f = fixture();
    const first = lab.capture(key(),{...f.capture,observedAt:"2026-09-25T23:59:59Z"});
    expect(() => lab.capture(key(),f.capture,f.context)).toThrow(/计划窗口/);
    expect(lab.plan(f.planId).slots[0]!.latest!.id).toBe(first.id);
    expect(counts()).toEqual({attempts:1,artifacts:1});
  });
  it("rejects another slot's linked running item", () => {
    const first = fixture(), other = fixture();
    expect(() => lab.capture(key(),first.capture,other.context)).toThrow(/计划窗口/);
    expect(counts()).toEqual({attempts:0,artifacts:0});
  });
});
