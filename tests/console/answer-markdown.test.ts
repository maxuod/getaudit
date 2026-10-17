import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LabService} from '../../src/console/service.ts';
import {connectLedger} from '../../src/db/index.ts';
import {answerMarkdown} from '../../src/console/answer-markdown.ts';
import {serveConsole} from '../../src/console/server.ts';
const {captureArtifact}=createRequire(import.meta.url)('../../desktop/capture-artifact.cjs');
const key=()=>randomUUID();
let lab:LabService,root:string,planId:string;
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),'answer-markdown-'));lab=new LabService(connectLedger(join(root,'ledger.db')));
  const brandId=lab.createBrand(key(),{name:'Synthetic',ownedDomains:['owned.example'],aliases:[]}).id;
  const set=lab.createSet(key(),{brandId,label:'Markdown fixture',locale:'en-CA',source:'Synthetic test only',kind:'hypothesis',prompts:Array.from({length:5},(_,i)=>({text:`Question ${i}?`,intent:'discovery'}))}).id;
  lab.freeze(key(),set);planId=lab.createPlan(key(),{promptSetId:set,label:'Synthetic Markdown',country:'CA',locale:'en-CA',timezone:'UTC',device:'desktop',surfaces:['chatgpt_search'],windows:['2026-09-26']}).id;
});
afterEach(()=>{lab.db.close();rmSync(root,{force:true,recursive:true});});
function capture(index:number,extra:Record<string,unknown>={}){
  const slot=lab.plan(planId).slots[index]!;
  return lab.capture(key(),{slotId:slot.id,prompt:slot.prompt,status:'observed',observedAt:'2026-09-26T10:00:00Z',answer:'Synthetic original answer.\n\nSecond paragraph.',
    citations:[{url:'https://owned.example/guide?utm_source=test',title:'Source title',placement:'answer_link'},{url:'https://other.example/article',title:'Panel only',placement:'source_panel'}],
    model:'unknown',sourceUrl:'https://chatgpt.com/c/private-session',account:'logged_out',session:'fresh',exitCountry:null,geo:'unverified',locale:'en-CA',timezone:'UTC',device:'desktop',geolocation:'denied',searchMode:'explicit_search',collectionMode:'browser_capture',
    browser:{name:'Google Chrome',version:'test',extractorVersion:'test',answerComplete:true,citationsComplete:false,unresolvedCitations:2,notes:[]},
    artifact:{mime:'text/plain',base64:Buffer.from('Synthetic text evidence').toString('base64')},...extra});
}
describe('text-first evidence and answer Markdown',()=>{
  it('never invokes screenshots in default text mode and retains source metadata exactly',async()=>{
    const screenshot=vi.fn(()=>{throw new Error('Must not take a screenshot');});
    const raw={question:'Q?',answer:'Answer\nwith paragraphs',citations:[{url:'https://source.example/p',title:'Source'}],observedAt:'2026-09-26T10:00:00Z'};
    const artifact=await captureArtifact({screenshot},raw);expect(screenshot).not.toHaveBeenCalled();expect(artifact.mime).toBe('text/plain');expect(JSON.parse(Buffer.from(artifact.base64,'base64').toString())).toEqual(raw);
    await captureArtifact({screenshot},raw,false);expect(screenshot).not.toHaveBeenCalled();
  });
  it('takes screenshots only with opt-in and falls back to text on oversized or failed images',async()=>{
    const screenshot=vi.fn().mockResolvedValue(Buffer.from('synthetic JPEG'));
    expect((await captureArtifact({screenshot},{answer:'A'},true)).mime).toBe('image/jpeg');expect(screenshot).toHaveBeenCalledTimes(1);
    screenshot.mockReset().mockResolvedValue(Buffer.alloc(4*1024*1024+1));expect((await captureArtifact({screenshot},{answer:'A'},true)).mime).toBe('text/plain');expect(screenshot).toHaveBeenCalledTimes(2);
    screenshot.mockReset().mockRejectedValue(new Error('Synthetic unavailable image'));expect((await captureArtifact({screenshot},{answer:'A'},true)).mime).toBe('text/plain');
  });
  it('exports original answers, per-answer clickable source links and explicit incomplete provenance',()=>{
    capture(0);const plan=lab.plan(planId),result=answerMarkdown(plan,['owned.example'],'zh-CN');
    expect(result).toMatchObject({positions:5,exportedAnswers:1,sourceCount:2});
    expect(result.markdown).toContain('Synthetic original answer.\n\nSecond paragraph.');expect(result.markdown).toContain('[Source title](<https://owned.example/guide>)');
    expect(result.markdown).toContain('正文链接 · 自有域名');expect(result.markdown).toContain('来源面板（不等同于逐句引用）');expect(result.markdown).toContain('未确认完整 · 未解析引用：2');
    expect(result.markdown).toContain('自动质检');expect(result.markdown).toContain('未请求（不阻塞结果）');expect(result.markdown).toContain('尚未取得采集记录');expect(result.markdown).toContain('2026-09-26T10:00:00Z');expect(result.markdown).not.toContain('private-session');
    expect(result.sha256).toHaveLength(64);expect(answerMarkdown(plan,['owned.example'],'zh-CN')).toEqual(result);
  });
  it('retains no-source and blocked states without inventing a source or a missing brand result',()=>{
    capture(0,{citations:[]});capture(1,{status:'unavailable',restriction:'captcha',reason:'Synthetic CAPTCHA',answer:'',citations:[]});
    const md=answerMarkdown(lab.plan(planId),[],'zh-CN').markdown;expect(md).toContain('未提取到可辨认的来源链接');expect(md).toContain('入口受限');expect(md).toContain('Synthetic CAPTCHA');expect(md).toContain('不将此状态解释为');
  });
  it('exports the actual browser mode while labeling historical captures as unrecorded',()=>{
    capture(0,{browser:{name:'Google Chrome',mode:'silent',version:'test',extractorVersion:'test',answerComplete:true,citationsComplete:true,notes:[]}});capture(1);
    const md=answerMarkdown(lab.plan(planId),[],'zh-CN').markdown;expect(md).toContain('浏览器运行方式：静默后台');expect(md).toContain('浏览器运行方式：历史记录未单独标注');
  });
  it('omits rejected and corrupt capture bodies while keeping their positions',()=>{
    const a=capture(0,{answer:'REJECTED SECRET',citations:[{url:'https://rejected.example/'}]});lab.review(key(),{attemptId:a.id,decision:'reject',note:'Synthetic privacy rejection',privacyReviewed:true});
    capture(1,{answer:'CORRUPT BODY'});const plan=lab.plan(planId);plan.slots[1]!.latest!.integrity=false;
    const result=answerMarkdown(plan,[],'zh-CN');expect(result.exportedAnswers).toBe(0);expect(result.markdown).not.toContain('REJECTED SECRET');expect(result.markdown).not.toContain('rejected.example');expect(result.markdown).not.toContain('CORRUPT BODY');expect(result.markdown).toContain('完整性检查失败');expect(result.positions).toBe(5);
  });
  it('isolates raw Markdown and HTML in fences and rejects unsafe source targets',()=>{
    const answer='```\n![tracking](https://image.example/p)\n<script>bad()</script>\n```';
    capture(0,{answer,citations:[{url:'https://user:secret@credential.example/path',title:'Hidden'},{url:'https://safe.example/page',title:'[fake](javascript:bad)\n<script>bad</script>',placement:'answer_link'}]});
    const result=answerMarkdown(lab.plan(planId),[],'zh-CN');expect(result.markdown).toContain('````text\n'+answer+'\n````');expect(result.markdown).not.toContain('user:secret');expect(result.markdown).toContain('链接未能安全解析');expect(result.markdown).toContain('\\[fake\\]');expect(result.sourceCount).toBe(1);
  });
  it('provides the Markdown through the authenticated export endpoint',async()=>{
    capture(0);const app=await serveConsole(lab);
    try{const path=app.origin+'/api/answers-markdown?id='+planId;expect((await fetch(path)).status).toBe(401);const response=await fetch(path,{headers:{Authorization:'Bearer '+app.token}});expect(response.status).toBe(200);const result=await response.json();expect(result.filename).toMatch(/\.md$/);expect(result.exportedAnswers).toBe(1);expect(result.markdown).toContain('Source title');}
    finally{await app.browserJobs.pauseAll();await new Promise<void>(r=>app.server.close(()=>r()));}
  });
});
