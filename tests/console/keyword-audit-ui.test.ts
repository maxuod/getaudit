import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseHTML} from 'linkedom';
import {auditLink,matchingAuditSnapshots,summarizeKeywordAuditActions,KeywordAuditResult,KeywordAuditPanel} from '../../apps/console/keyword-audit-panel.tsx';
import type {KeywordAuditInput,KeywordAuditJob,KeywordAuditKeyword,KeywordAuditPreview,PageEvidence} from '../../src/console/keyword-audit.ts';
import {request} from '../../apps/console/api.ts';
import {setUiLanguage} from '../../apps/console/i18n.tsx';

beforeEach(()=>setUiLanguage('zh-CN'));
afterEach(()=>setUiLanguage('en'));

vi.mock('../../apps/console/download.ts',()=>({downloadText:vi.fn()}));
vi.mock('../../apps/console/api.ts',()=>({request:vi.fn()}));

const page=(id:string,url:string):PageEvidence=>({id,url,resolvedUrl:url,observedAt:'2026-10-11T12:00:00Z',status:'available',title:'Evidence title',headings:['How to calculate'],body:'Exact saved source example',excerpt:'Exact saved source example',hash:'frozen-page-'+id,limitations:[]});
function item():KeywordAuditKeyword {
  const owner=page('own','https://client.example/tool'),one=page('one','https://rival.example/guide'),two=page('two','https://rival.example/calculator'),three=page('three','https://other.example/tips');
  const refs=(id:string)=>[{sourceId:id,quote:'Exact saved source example'}];
  const competitors=[{url:one.url,title:'First guide',actualRank:1,rankAbsolute:1},{url:two.url,title:'Another page from same site',actualRank:3,rankAbsolute:4},{url:three.url,title:'Third external page',actualRank:4,rankAbsolute:5}];
  return {keyword:'tip calculator',position:13.42,clicks:12,impressions:580,ctr:12/580,ownerUrl:owner.url,ownerAlternatives:[],reason:'Rank 11–20 GSC query',ownerEvidence:owner,competitorEvidence:[one,two,three],serp:{status:'available',observedAt:'2026-10-11T13:00:00Z',source:'DataForSEO Google organic live advanced',conditions:{engine:'google',countryCode:2124,languageCode:'en',device:'desktop'},organic:competitors,competitors,ownResults:[],raw:{source:'saved'},hash:'frozen-serp'},analysis:{summary:'A task-specific comparison.',comparisons:competitors.map((competitor,i)=>({competitorUrl:competitor.url,actualRank:competitor.actualRank,approach:[{text:'They explain the calculation.',evidence:refs([one,two,three][i]!.id)}],gaps:[{text:'Our worked example needs the same input detail.',evidence:[...refs(owner.id),...refs([one,two,three][i]!.id)]}],improvements:[{action:'Add a worked party-size example',priority:'high',targetUrl:owner.url,reason:'Help the reader reproduce the calculation.',acceptance:'The example matches the calculator result.',followUp:'Compare clicks and ranking in the next 28-day window.',evidence:[...refs(owner.id),...refs([one,two,three][i]!.id)]}],unknowns:[]})),unknowns:[]}};
}
describe('keyword audit interface evidence',()=>{
  it('keeps brand-matching property snapshots in date order and excludes other sites',()=>{
    const base={startDate:'2026-09-01',endDate:'2026-09-30',country:'CAN',hash:'saved',dashboard:1};
    const history=[{...base,id:'old',property:'sc-domain:client.example',captured_at:'2026-10-01 12:00:00'},{...base,id:'unrelated',property:'sc-domain:rival.example',captured_at:'2026-10-11 12:00:00'},{...base,id:'new',property:'https://help.client.example/',captured_at:'2026-10-09 12:00:00'},{...base,id:'lookalike',property:'sc-domain:client.example.evil.example',captured_at:'2026-10-12 12:00:00'}];
    expect(matchingAuditSnapshots(history,['client.example']).map(s=>s.id)).toEqual(['new','old']);
    expect(matchingAuditSnapshots(history,[])).toEqual([]);
  });
  it('does not enlarge a subdomain ownership grant to the parent property',()=>{
    const snapshot={id:'parent',property:'sc-domain:client.example',startDate:'2026-09-01',endDate:'2026-09-30',country:'CAN',captured_at:'2026-10-11 12:00:00',hash:'saved',dashboard:1};
    expect(matchingAuditSnapshots([snapshot],['help.client.example'])).toEqual([]);
  });
  it('allows ordinary page links but does not create executable or credential-bearing links',()=>{
    expect(auditLink('https://rival.example/guide?region=ca')).toBe('https://rival.example/guide?region=ca');
    expect(auditLink('javascript:alert(1)')).toBeUndefined();
    expect(auditLink('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(auditLink('https://username:secret@rival.example/guide')).toBeUndefined();
  });
  it('retains actual natural ranks and two pages on the same competitor domain',()=>{
    const html=renderToStaticMarkup(React.createElement(KeywordAuditResult,{item:item(),index:0}));
    expect(html).toContain('样本 1 · 自然第 1 位');
    expect(html).toContain('样本 2 · 自然第 3 位');
    expect(html).toContain('样本 3 · 自然第 4 位');
    expect(html).not.toContain('自然第 2 位');
    expect(html).toContain('https://rival.example/guide');
    expect(html).toContain('https://rival.example/calculator');
    expect(html).toContain('GSC 平均排名');
    expect(html).toContain('13.42');
  });
  it('shows page quotes, own target URL, acceptance and follow-up rather than generic recommendations',()=>{
    const html=renderToStaticMarkup(React.createElement(KeywordAuditResult,{item:item(),index:0}));
    expect(html).toContain('Exact saved source example');
    expect(html).toContain('来源 own');
    expect(html).toContain('https://client.example/tool');
    expect(html).toContain('The example matches the calculator result.');
    expect(html).toContain('Compare clicks and ranking in the next 28-day window.');
    expect(html).toContain('frozen-page-one');
  });
  it('marks unavailable pages and an absent third result instead of claiming complete analysis',()=>{
    const missing=item();missing.serp!.competitors=missing.serp!.competitors.slice(0,2);missing.competitorEvidence=[{...missing.competitorEvidence[0]!,status:'unavailable',error:'Page access blocked'}];missing.ownerEvidence=null;missing.analysis=null;missing.error='自有页面证据缺失';
    const html=renderToStaticMarkup(React.createElement(KeywordAuditResult,{item:missing,index:0}));
    expect(html).toContain('分析未完成');
    expect(html).toContain('本词只取得 2 / 3 条外部自然结果，剩余位置未完成。');
    expect(html).toContain('页面访问受限 · 无法分析');
    expect(html).toContain('Page access blocked');
    expect(html).not.toContain('已生成页面对比');
    expect(html).not.toContain('具体怎么改善');
  });
  it('renders untrusted source and model content as text',()=>{
    const malicious=item();malicious.analysis!.summary='<script>stealCredentials()</script>';malicious.analysis!.comparisons[0]!.approach[0]!.text='<img src=x onerror=run()> ';
    const html=renderToStaticMarkup(React.createElement(KeywordAuditResult,{item:malicious,index:0}));
    expect(html).toContain('&lt;script&gt;stealCredentials()&lt;/script&gt;');
    expect(html).not.toContain('<script>stealCredentials()');
    expect(html).not.toContain('<img src=x onerror=run()>');
  });
  it('merges the same action on the same page while preserving each keyword and both same-domain pages',()=>{
    const first=item(),second=item();second.keyword='split bill tip calculator';
    second.analysis!.comparisons[0]!.improvements[0]!.action='  ADD A WORKED  PARTY-SIZE EXAMPLE ';
    const summary=summarizeKeywordAuditActions([first,second]);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.keywords).toEqual(['tip calculator','split bill tip calculator']);
    expect(summary[0]!.competitorUrls).toEqual(['https://rival.example/guide','https://rival.example/calculator','https://other.example/tips']);
  });
  it('keeps actions on different target pages separate and sorts by the highest supported priority',()=>{
    const first=item(),second=item();second.keyword='service charge calculator';
    first.analysis!.comparisons.forEach(c=>{c.improvements[0]!.priority='low';});
    second.analysis!.comparisons.forEach(c=>{c.improvements[0]!.targetUrl='https://client.example/service-charge';c.improvements[0]!.priority='medium';});
    second.analysis!.comparisons[2]!.improvements[0]!.priority='high';
    const summary=summarizeKeywordAuditActions([first,second]);
    expect(summary).toHaveLength(2);
    expect(summary.map(s=>[s.targetUrl,s.priority])).toEqual([['https://client.example/service-charge','high'],['https://client.example/tool','low']]);
  });
});

describe('keyword audit bounded run interface',()=>{
  afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.mocked(request).mockReset();});
  it('restores configured analysis preferences, starts only explicitly and polls until completion or unmount',async()=>{
    vi.useFakeTimers();
    const {window,document}=parseHTML('<html><body><main id="root"></main></body></html>');
    Object.defineProperty(document,'hidden',{value:false,configurable:true});
    const store=new Map<string,string>();
    vi.stubGlobal('window',window);vi.stubGlobal('document',document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('sessionStorage',{getItem:(key:string)=>store.get(key)??null,setItem:(key:string,value:string)=>store.set(key,value)});
    const brandId='fd047642-2a85-424f-bd55-520977a35ae8',snapshotId='f398dd49-3b56-42b7-84ce-b73f22093403',jobId='f3b03d36-e66d-40aa-8d4a-aa4eb2b7166e';
    const input:KeywordAuditInput={brandId,snapshotId,countryCode:2124,languageCode:'fr',device:'mobile',provider:'openai',model:'saved-analysis-model'};
    store.set('getaudit.keywordAudit.settings:'+brandId,JSON.stringify({countryCode:2124,languageCode:'fr',device:'mobile',provider:'openai',model:'saved-analysis-model'}));
    vi.stubGlobal('localStorage',{getItem:(key:string)=>store.get(key)??null,setItem:(key:string,value:string)=>store.set(key,value)});
    const preview:KeywordAuditPreview={input,brand:{id:brandId,name:'Test brand',ownedDomains:['client.example'],category:null},snapshot:{id:snapshotId,hash:'frozen-gsc',property:'sc-domain:client.example',startDate:'2026-09-01',endDate:'2026-09-30',country:'CAN',device:'ALL',type:'web',capturedAt:'2026-10-11T12:00:00Z',timeZone:'America/Los_Angeles'},keywords:[item()],candidateCount:1,shortfall:4,limits:{serp:5,pages:20,llm:5},warnings:[]};
    const job:KeywordAuditJob={id:jobId,brandId,status:'running',createdAt:'2026-10-11T13:00:00Z',updatedAt:'2026-10-11T13:00:00Z',input,inputHash:'frozen-input',preview,keywords:[item()],warnings:[],requests:{serp:1,pages:4,llm:1},completion:{keywords:1,competitorSlots:3,comparisons:3,targetKeywords:5,targetComparisons:15},reportHash:null};
    let submitted=false,reads=0;
    vi.mocked(request).mockImplementation(async(path)=>{
      if(path==='gsc/history')return [{id:snapshotId,property:'sc-domain:client.example',startDate:'2026-09-01',endDate:'2026-09-30',country:'CAN',captured_at:'2026-10-11 12:00:00',hash:'frozen-gsc',dashboard:1}];
      if(path==='keyword-audit/config')return {providers:[{id:'openai',label:'OpenAI',available:true,model:'gpt-recommended'}],locations:[{code:2124,country:'CAN',label:'加拿大'}],dataForSeoConfigured:true,limits:{serp:5,pages:20,llm:5}};
      if(path.startsWith('keyword-audit/jobs?'))return [];
      if(path==='keyword-audit/preview')return preview;
      if(path==='keyword-audit/start'){submitted=true;return {id:jobId,status:'queued'};}
      if(path.startsWith('keyword-audit/job?')){expect(submitted).toBe(true);reads++;return {...job,status:reads>1?'partial':'running'};}
      throw new Error('Unexpected API path: '+path);
    });
    const root=createRoot(document.getElementById('root')! as unknown as HTMLElement);
    try {
      await act(async()=>{root.render(React.createElement(KeywordAuditPanel,{brandId,brand:{id:brandId,name:'Test brand',owned_domains:'["client.example"]'}}));});
      await act(async()=>{await vi.advanceTimersByTimeAsync(200);});
      expect(vi.mocked(request).mock.calls.filter(([path])=>path==='keyword-audit/start')).toHaveLength(0);
      expect(document.body.textContent).toContain('本次选词与来源');
      expect(document.querySelector('.keyword-audit-options')!.hasAttribute('open')).toBe(false);
      expect(vi.mocked(request).mock.calls.find(([path])=>path==='keyword-audit/preview')?.[1]).toEqual(input);
      expect(document.querySelector('.keyword-audit-preview')!.hasAttribute('open')).toBe(false);
      expect(document.querySelector('form>.keyword-audit-warning')!.textContent).toContain('不足 5 个');
      await act(async()=>{document.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));});
      expect(vi.mocked(request).mock.calls.filter(([path])=>path==='keyword-audit/start')).toHaveLength(1);
      expect(document.body.textContent).toContain('正在分析');
      expect(document.querySelector('.keyword-audit-setup')!.hasAttribute('open')).toBe(false);
      await act(async()=>{await vi.advanceTimersByTimeAsync(2600);});
      expect(document.body.textContent).toContain('部分完成');
      expect(document.body.textContent).toContain('不能视为完整的 5 词 × 3 页审计');
      expect(document.body.textContent).toContain('具体怎么改善');
      expect(vi.mocked(request).mock.calls.filter(([path])=>path==='keyword-audit/start')).toHaveLength(1);
      expect(store.get('keyword-audit-selected:'+brandId)).toBe(jobId);
      await act(async()=>{root.unmount();});
      const stoppedReads=reads;
      await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
      expect(reads).toBe(stoppedReads);
    } finally {await act(async()=>{root.unmount();});}
  });
});
