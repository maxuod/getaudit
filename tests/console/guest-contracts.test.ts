import {afterEach, describe, expect, it} from "vitest";
import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {connectLedger} from "../../src/db/index.ts";
import {LabService} from "../../src/console/service.ts";
import {conditionIssues, planSchema, surfaceIds, surfaces} from "../../src/console/contracts.ts";
import type {Capture, PlanConfig} from "../../src/console/contracts.ts";

const roots: string[] = [], labs: LabService[] = [];
afterEach(() => {for (const lab of labs.splice(0)) lab.db.close(); for (const root of roots.splice(0)) rmSync(root, {recursive:true, force:true});});
const date = "2026-09-26";
const base: PlanConfig = {promptSetId:"synthetic", label:"Guest regression", surfaces:["duckduckgo_search_assist"], accountMode:"signed_out", guestPolicy:"no_login_v1", country:"CA", locale:"en-CA", timezone:"UTC", device:"desktop", windows:[date]};
function setup() {
  const root = mkdtempSync(join(tmpdir(), "getgeo-guest-contract-")); roots.push(root);
  const lab = new LabService(connectLedger(join(root, "ledger.db"))); labs.push(lab);
  const brandId = lab.createBrand(randomUUID(), {name:"Synthetic Guest", aliases:[], ownedDomains:["guest.example"]}).id;
  const promptSetId = lab.createSet(randomUUID(), {brandId, label:"Frozen guest regression", locale:"en-CA", source:"Synthetic fixture", kind:"hypothesis", prompts:[{text:"How does synthetic scheduling work?", intent:"discovery"}]}).id;
  lab.freeze(randomUUID(), promptSetId);
  return {lab, promptSetId};
}
function terminal(slotId: string, prompt: string, sourceUrl: string): Capture {
  return {slotId, prompt, status:"not_triggered", reason:"Completed search without an AI answer.", restriction:"none", observedAt:date+"T12:00:00Z", answer:"", citations:[], model:"unknown", sourceUrl, account:"logged_out", session:"fresh", privacy:{mode:"signed_out", temporaryChat:"not_applicable", personalization:"unknown", newConversation:true}, exitCountry:null, geo:"unverified", locale:"en-CA", timezone:"UTC", device:"desktop", geolocation:"denied", searchMode:"explicit_search", collectionMode:"browser_capture", browser:{name:"Google Chrome", mode:"visible", version:"Synthetic", extractorVersion:"guest-test-v1", answerComplete:false, citationsComplete:false, notes:[]}, retrievalUsed:null, artifact:{mime:"text/plain",base64:Buffer.from("Synthetic completed SERP without Search Assist").toString("base64")}};
}
describe("strict guest plans and additive Search Assist evidence", () => {
  it("accepts seven strict guest platforms while rejecting login-capable modes for Search Assist", () => {
    expect(planSchema.safeParse({...base,surfaces:surfaceIds}).success).toBe(true);
    expect(planSchema.safeParse({...base,accountMode:undefined}).success).toBe(true);
    for (const mode of ["isolated","signed_in_private"]) {
      expect(planSchema.safeParse({...base,guestPolicy:undefined,accountMode:mode}).success).toBe(false);
      expect(planSchema.safeParse({...base,surfaces:["chatgpt_search"],accountMode:mode}).success).toBe(false);
    }
  });
  it("requires explicit fresh guest privacy proof for new strict plans without rewriting legacy conditions", () => {
    const {artifact:_, ...record} = terminal("synthetic-slot", "Synthetic question", surfaces.duckduckgo_search_assist.url);
    const capture = {...record,artifactHash:null};
    expect(conditionIssues(base,capture,"duckduckgo_search_assist")).not.toContain("Strict guest session and fresh conversation were not verified.");
    expect(conditionIssues(base,{...capture,privacy:undefined},"duckduckgo_search_assist")).toContain("Strict guest session and fresh conversation were not verified.");
    expect(conditionIssues({...base,guestPolicy:undefined},{...capture,privacy:undefined},"duckduckgo_search_assist")).not.toContain("Strict guest session and fresh conversation were not verified.");
    expect(conditionIssues(base,{...capture,privacy:{...capture.privacy!,newConversation:false}},"duckduckgo_search_assist")).toContain("Strict guest session and fresh conversation were not verified.");
  });
  it("records Search Assist non-triggering as a terminal result while rejecting it for chat surfaces", () => {
    const {lab,promptSetId}=setup();
    const id=lab.createPlan(randomUUID(),{...base,promptSetId,surfaces:surfaceIds}).id;
    const plan=lab.plan(id); expect(plan.slots).toHaveLength(7);
    const slot=plan.slots.find(s=>s.surface==="duckduckgo_search_assist")!;
    lab.capture(randomUUID(),terminal(slot.id,slot.prompt,surfaces.duckduckgo_search_assist.url));
    const saved=lab.plan(id).slots.find(s=>s.id===slot.id)!.latest!;
    expect(saved.capture.status).toBe("not_triggered");
    expect(saved.quality).toMatchObject({status:"terminal",contentQualified:false,metricEligible:false});
    const chat=plan.slots.find(s=>s.surface==="chatgpt_search")!;
    expect(()=>lab.capture(randomUUID(),terminal(chat.id,chat.prompt,surfaces.chatgpt_search.url))).toThrow("Not triggered applies only");
  });
});
