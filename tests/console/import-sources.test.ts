import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {parseQuestions} from '../../src/console/question-import.ts';
import {identifySources,normalizeSourceUrl} from '../../src/console/sources.ts';
import {LabService} from '../../src/console/service.ts';
import {connectLedger} from '../../src/db/index.ts';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

describe('question file import',()=>{
  it('imports 100 CSV questions with BOM, quoted commas, CRLF and per-question intent',()=>{
    const csv='\uFEFFquestion,intent\r\n'+Array.from({length:100},(_,i)=>`"Question ${i+1}, with comma?",${i%2?'branded':'discovery'}`).join('\r\n');
    const p=parseQuestions(csv,'csv');expect(p.errors).toEqual([]);expect(p.prompts).toHaveLength(100);expect(p.prompts[1]).toEqual({text:'Question 2, with comma?',intent:'branded'});
  });
  it('retains multiline quoted cells and escaped quotes without executing formulas',()=>{
    expect(parseQuestions('question,intent\n"A ""quote""\nand another line",branded\n=1+2,discovery','csv').prompts).toEqual([{text:'A "quote"\nand another line',intent:'branded'},{text:'=1+2',intent:'discovery'}]);
  });
  it('imports Excel TSV with reordered Chinese columns and de-duplicates trimmed question text',()=>{
    const p=parseQuestions('类型\t问题\n品牌型\tWhich tool?\n发现型\tWhich tool? \n发现型\tNext?\n\t','tsv');
    expect(p.errors).toEqual([]);expect(p.duplicates).toBe(1);expect(p.blank).toBe(1);expect(p.prompts).toEqual([{text:'Which tool?',intent:'branded'},{text:'Next?',intent:'discovery'}]);
  });
  it('rejects ambiguous columns, malformed quoting, invalid types and limits before saving',()=>{
    for(const text of ['name,value\nQ1,Q2','question,intent\nQ,unknown','question\n"never closed','question\n"closed"tail'])expect(parseQuestions(text,'csv').errors.length).toBeGreaterThan(0);
    expect(parseQuestions(Array.from({length:501},(_,i)=>`Q${i}`).join('\n')).errors.join()).toContain('500');
    expect(parseQuestions('x'.repeat(3001)).errors.join()).toContain('3000');
    expect(parseQuestions('').errors).toHaveLength(1);
  });
  it('supports single-column CSV and plain text without changing question punctuation',()=>{
    expect(parseQuestions('"Question, why?"\n"Next?"','csv').prompts.map(p=>p.text)).toEqual(['Question, why?','Next?']);
    expect(parseQuestions('  Q1?\n\nQ1?\nQ2?','text','branded')).toMatchObject({duplicates:1,blank:1,errors:[],prompts:[{text:'Q1?',intent:'branded'},{text:'Q2?',intent:'branded'}]});
  });
});
let lab:LabService,root:string,planId:string;
const key=()=>randomUUID();
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),'geo-import-sources-'));lab=new LabService(connectLedger(join(root,'ledger.db')));
  const brandId=lab.createBrand(key(),{name:'Northstar',aliases:[],ownedDomains:['northstar.example']}).id;
  const promptSetId=lab.createSet(key(),{brandId,label:'Synthetic import',locale:'en-CA',source:'Synthetic test',kind:'hypothesis',prompts:parseQuestions('Q1?\nQ2?').prompts}).id;
  lab.freeze(key(),promptSetId);planId=lab.createPlan(key(),{promptSetId,label:'Sources QA',country:'CA',locale:'en-CA',timezone:'UTC',device:'desktop',surfaces:['chatgpt_search','google_aio'],windows:['2026-09-25']}).id;
});
afterEach(()=>{lab.db.close();rmSync(root,{force:true,recursive:true});});
function add(index:number,extra:Record<string,unknown>={}){
  const s=lab.plan(planId).slots[index]!;
  return lab.capture(key(),{slotId:s.id,prompt:s.prompt,status:'observed',observedAt:'2026-09-25T16:00:00Z',answer:'Synthetic answer used for source verification.',
    citations:[{url:'https://northstar.example/a?utm_source=chatgpt',title:'Owned A',placement:'answer_link'},{url:'https://northstar.example/a#cite',title:'Same A',placement:'source_panel'},{url:'https://northstar.example/b',title:'Owned B',placement:'source_panel'}],
    account:'logged_out',session:'fresh',exitCountry:'CA',geo:'ip_observed',locale:'en-CA',timezone:'UTC',device:'desktop',geolocation:'denied',searchMode:'explicit_search',collectionMode:'browser_capture',sourceUrl:s.surface==='google_aio'?'https://www.google.com/search?q=synthetic':'https://chatgpt.com/',
    browser:{name:'Google Chrome',version:'fixture',extractorVersion:'test',answerComplete:true,citationsComplete:true,notes:['Synthetic test']},artifact:{mime:'text/plain',base64:Buffer.from('Synthetic evidence').toString('base64')},...extra});
}
const accept=(id:string)=>lab.review(key(),{attemptId:id,decision:'accept',note:'Synthetic source fixture review',privacyReviewed:true});
describe('visible source inventory',()=>{
  it('counts each question and observation once despite multiple pages and multiple platforms',()=>{
    const a=add(0);accept(a.id);add(1);const result=identifySources(lab.plan(planId),['northstar.example']);
    expect(result).toMatchObject({totalPositions:4,observedPositions:2,completeSourcePositions:2,unresolved:0});
    expect(result.pages[0]!.occurrences[0]).toMatchObject({account:'logged_out',geo:'ip_observed',exitCountry:'CA'});
    expect(result.pages).toHaveLength(2);expect(result.pages[0]).toMatchObject({questionCount:1,observationCount:2,eligibleObservations:2});
    expect(result.sites[0]).toMatchObject({host:'northstar.example',pageCount:2,observationCount:2,questionCount:1,eligibleObservations:2});
    expect(result.pages[0]!.occurrences.every(o=>o.evidenceHash.length===64)).toBe(true);
    expect(identifySources(lab.plan(planId),['northstar.example']).hash).toBe(result.hash);
  });
  it('retains incomplete source candidates without claiming complete coverage or formal eligibility',()=>{
    const a=add(0,{browser:{name:'Google Chrome',version:'fixture',extractorVersion:'test',answerComplete:true,citationsComplete:false,unresolvedCitations:3,notes:[]}});accept(a.id);
    const result=identifySources(lab.plan(planId),['northstar.example']);expect(result).toMatchObject({unresolved:3,completeSourcePositions:0});
    expect(result.pages[0]!.occurrences[0]).toMatchObject({eligible:false,rangeComplete:false,review:'accept'});
  });
  it('omits rejected or altered evidence, including the latest of multiple attempts',()=>{
    const a=add(0);lab.review(key(),{attemptId:a.id,decision:'reject',note:'Rejected first fixture attempt',privacyReviewed:true});const replacement=add(0,{reason:'Replacement synthetic source QA'});lab.review(key(),{attemptId:replacement.id,decision:'reject',note:'Rejected fixture',privacyReviewed:true});
    expect(identifySources(lab.plan(planId),[]).pages).toHaveLength(0);
    add(1);const damaged=lab.plan(planId);damaged.slots[1]!.latest!.integrity=false;
    expect(identifySources(damaged,[]).pages).toHaveLength(0);
  });
  it('resolves explicit redirect targets while rejecting opaque, credentialed and non-web URLs',()=>{
    expect(normalizeSourceUrl('https://www.google.com/url?q=https%3A%2F%2Fsource.example%2Fp%3Futm_source%3Dg%26topic%3Dx')).toBe('https://source.example/p?topic=x');
    for(const url of ['https://www.google.com/goto?token=opaque','javascript:alert(1)','https://user:secret@source.example/'])expect(normalizeSourceUrl(url)).toBeNull();
  });
});
