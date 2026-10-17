import {expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import {connectLedger} from "../../src/db/index.ts";
import {LabService} from "../../src/console/service.ts";
import {BrowserJobs, type BrowserTask} from "../../src/console/browser-jobs.ts";
import type {Capture} from "../../src/console/contracts.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {release = resolve;});
  return {promise, release};
}

it("does not report a successful Continue while a paused browser is still closing, then resumes exactly the unsent item", async () => {
  const lab = new LabService(connectLedger(":memory:"));
  const answer = gate(), cleanup = gate(), closing = gate();
  const calls: string[] = [];
  let closes = 0;
  const jobs = new BrowserJobs(lab, {
    available: () => ({available: true, message: "Synthetic queue test; no browser"}),
    show: async () => {},
    close: async () => {if (++closes === 1) {closing.release(); await cleanup.promise;}},
    collect: async (task: BrowserTask, _signal, stage): Promise<Capture> => {
      calls.push(task.slotId);
      stage("waiting");
      await answer.promise;
      return {slotId:task.slotId,prompt:task.prompt,observedAt:new Date().toISOString(),
        status:"observed",restriction:"none",reason:"",answer:"Synthetic queue verification answer.",
        citations:[{url:"https://northstar.example/guide"}],model:"synthetic-fixture",
        account:"logged_out",session:"fresh",exitCountry:"CA",geo:"ip_observed",locale:"en-CA",timezone:"UTC",
        device:"desktop",geolocation:"denied",searchMode:"explicit_search",collectionMode:"browser_capture",
        sourceUrl:"https://chatgpt.com/",retrievalUsed:true,
        browser:{name:"Google Chrome",version:"synthetic",extractorVersion:"test",answerComplete:true,citationsComplete:true,notes:["SYNTHETIC TEST"]},
        artifact:{mime:"text/plain",base64:Buffer.from("SYNTHETIC TEST evidence " + task.prompt).toString("base64")}};
    },
  }, async () => {});
  try {
    const brandId = lab.createBrand(randomUUID(), {name:"Northstar",aliases:[],ownedDomains:["northstar.example"]}).id;
    const setId = lab.createSet(randomUUID(), {brandId,label:"Synthetic pause",source:"Synthetic queue test",kind:"hypothesis",locale:"en-CA",
      prompts:[{text:"Synthetic question one?",intent:"discovery"},{text:"Synthetic question two?",intent:"discovery"}]}).id;
    lab.freeze(randomUUID(),setId);
    const planId = lab.createPlan(randomUUID(), {promptSetId:setId,label:"Synthetic pause",surfaces:["chatgpt_search"],
      accountMode:"isolated",country:"CA",locale:"en-CA",timezone:"UTC",device:"desktop",windows:[new Date().toISOString().slice(0,10)]}).id;
    const job = jobs.create(randomUUID(), {planId,transmissionAcknowledged:true,intervalSeconds:5});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await jobs.control({id:job.id,action:"pause"});
    expect(() => jobs.resume(job.id)).toThrow(/暂停收尾尚未完成/);
    answer.release();
    await closing.promise;
    expect(jobs.rows()[0]).toMatchObject({status:"paused",finalizing:true,resume:{current:1}});
    expect(() => jobs.resume(job.id)).toThrow(/暂停收尾尚未完成/);
    expect(calls).toHaveLength(1);
    const finishing = jobs.active.get(job.id)!.promise;
    cleanup.release();
    await finishing;
    expect(jobs.rows()[0]).toMatchObject({status:"paused",finalizing:false});
    jobs.resume(job.id);
    await jobs.active.get(job.id)?.promise;
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(2);
    expect(jobs.job(job.id).status).toBe("completed");
    expect(lab.db.prepare("SELECT count(*) n FROM console_attempt").get()).toMatchObject({n:2});
  } finally {
    answer.release(); cleanup.release();
    await jobs.pauseAll();
    lab.db.close();
  }
});
