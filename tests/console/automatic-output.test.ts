import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {connectLedger} from '../../src/db/index.ts';
import {LabService} from '../../src/console/service.ts';
import {serveConsole} from '../../src/console/server.ts';
import type {Capture} from '../../src/console/contracts.ts';

let root:string,lab:LabService;
const id=()=>randomUUID();
function setup(){
 root=mkdtempSync(join(tmpdir(),'geo-automatic-output-'));lab=new LabService(connectLedger(join(root,'ledger.db')));
 const brandId=lab.createBrand(id(),{name:'Northstar',aliases:[],ownedDomains:['northstar.example']}).id;
 const setId=lab.createSet(id(),{brandId,label:'SYNTHETIC automatic report QA',locale:'en-CA',kind:'hypothesis',source:'Synthetic endpoint verification',prompts:[{text:'Which scheduler fits a small restaurant?',intent:'discovery'},{text:'What is the total cost?',intent:'discovery'},{text:'What sources describe the product?',intent:'discovery'}]}).id;
 lab.freeze(id(),setId);return lab.createPlan(id(),{promptSetId:setId,label:'Synthetic offline automatic output',surfaces:['chatgpt_search'],windows:[new Date().toISOString().slice(0,10)],country:'CA',locale:'en-CA',timezone:'UTC',device:'desktop'}).id;
}
function save(planId:string,n:number,extra:Partial<Capture>={}){
 const slot=lab.plan(planId).slots[n]!;
 return lab.capture(id(),{slotId:slot.id,prompt:slot.prompt,observedAt:new Date().toISOString(),status:'observed',restriction:'none',reason:'',answer:'SYNTHETIC AUTO OUTPUT ONLY. Northstar is described here.',citations:[{url:'https://northstar.example/features',title:'Synthetic source',placement:'answer_link'}],model:'synthetic-test',account:'logged_out',session:'fresh',exitCountry:'CA',geo:'ip_observed',locale:'en-CA',timezone:'UTC',device:'desktop',geolocation:'denied',searchMode:'explicit_search',collectionMode:'browser_capture',retrievalUsed:true,sourceUrl:'https://chatgpt.com/',browser:{name:'Google Chrome',version:'synthetic',extractorVersion:'test',answerComplete:true,citationsComplete:true,notes:['SYNTHETIC TEST']},artifact:{mime:'text/plain',base64:Buffer.from('Synthetic original evidence').toString('base64')},...extra});
}
afterEach(()=>{lab?.db.close();if(root)rmSync(root,{recursive:true,force:true});});
describe('automatic report and Markdown endpoint without a human gate',()=>{
 it('immediately exposes qualified originals and metrics, filters incomplete content, preserves blocked state, and exports a matching hash without reviews',async()=>{
  const planId=setup();save(planId,0);save(planId,1,{answer:'EXCLUDED INCOMPLETE BODY',browser:{name:'Google Chrome',version:'synthetic',extractorVersion:'test',answerComplete:true,citationsComplete:false,unresolvedCitations:1,notes:[]}});save(planId,2,{status:'unavailable',restriction:'captcha',reason:'SYNTHETIC blocked entry',answer:'',citations:[]});
  const app=await serveConsole(lab);
  try{
   const headers={Authorization:'Bearer '+app.token};
   expect((await fetch(app.origin+'/api/export?id='+planId+'&format=md')).status).toBe(401);
   const result=await (await fetch(app.origin+'/api/report?id='+planId,{headers})).json();
   expect(result.qualityPolicy).toMatchObject({humanReviewRequired:false,verifiesAnswerTruth:false});
   expect(result.groups[0]).toMatchObject({planned:3,autoChecked:3,contentQualified:1,eligible:1,candidateBrandMentions:1,brandMentions:1,unavailable:1});
   expect(result.records[0]).toMatchObject({manualDecision:null,answer:'SYNTHETIC AUTO OUTPUT ONLY. Northstar is described here.',decision:'auto_accept'});
   expect(result.records[1].answer).toBeNull();expect(result.records[2].status).toBe('unavailable');
   const response=await fetch(app.origin+'/api/export?id='+planId+'&format=md',{headers});
   const md=await response.text();expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('text/markdown');
   expect(response.headers.get('x-report-sha256')).toBe(createHash('sha256').update(md).digest('hex'));
   expect(md).toContain('无需人工复核');expect(md).toContain('SYNTHETIC AUTO OUTPUT ONLY');expect(md).toContain('https://northstar.example/features');expect(md).toContain('SYNTHETIC blocked entry');expect(md).not.toContain('EXCLUDED INCOMPLETE BODY');
   expect(lab.db.prepare('SELECT count(*) n FROM console_review').get()).toMatchObject({n:0});
   expect(lab.db.prepare('SELECT count(*) n FROM observation').get()).toMatchObject({n:0});
  }finally{await app.browserJobs.pauseAll();await app.gscSync.stop();app.server.closeAllConnections();await new Promise<void>(r=>app.server.close(()=>r()));}
 });
 it('does not export from a ledger being restored',async()=>{
  const planId=setup();save(planId,0);const app=await serveConsole(lab,{canMutate:()=>false});
  try{const response=await fetch(app.origin+'/api/export?id='+planId+'&format=md',{headers:{Authorization:'Bearer '+app.token}});expect(response.status).toBe(503);expect(lab.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='console_report_snapshot'").get()).toMatchObject({n:0});}
  finally{await app.gscSync.stop();app.server.closeAllConnections();await new Promise<void>(r=>app.server.close(()=>r()));}
 });
});
