import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import React,{act,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseHTML} from 'linkedom';
import {getUiLanguage,LanguageSwitch,setUiLanguage,t,uiLanguageStorageKey,uiMessage,useUiLanguage} from '../../apps/console/i18n.tsx';
import {ConnectionAccessNotice} from '../../apps/console/connection-access.tsx';
import {KeywordAuditPanel,KeywordAuditResult} from '../../apps/console/keyword-audit-panel.tsx';
import {LoadingHelper} from '../../apps/console/loading-helper.tsx';
import {WorkflowGuide,type WorkflowFacts} from '../../apps/console/workflow-guide.tsx';
import {request} from '../../apps/console/api.ts';
import type {KeywordAuditKeyword,PageEvidence} from '../../src/console/keyword-audit.ts';

vi.mock('../../apps/console/api.ts',()=>({request:vi.fn()}));
vi.mock('../../apps/console/download.ts',()=>({downloadText:vi.fn()}));

beforeEach(()=>setUiLanguage('en'));
afterEach(()=>{
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(request).mockReset();
  setUiLanguage('en');
});

function storageFixture(choice:string|null=null) {
  const values=new Map<string,string>();
  if(choice!==null)values.set(uiLanguageStorageKey,choice);
  return {values,getItem:vi.fn((key:string)=>values.get(key)??null),setItem:vi.fn((key:string,value:string)=>{values.set(key,value);})};
}

// Re-import only for initialization checks; these module instances are never mounted
// with React. Live components below share the statically imported React/i18n instance.
async function initializedLanguage(choice:string|null,readFails=false) {
  const storage=storageFixture(choice);
  if(readFails)storage.getItem.mockImplementation(()=>{throw new Error('Storage unavailable');});
  const {document}=parseHTML('<html><head></head><body></body></html>');
  vi.stubGlobal('window',{localStorage:storage,addEventListener:vi.fn()});
  vi.stubGlobal('document',document);
  vi.resetModules();
  const language=await import('../../apps/console/i18n.tsx');
  return {language,storage,document};
}

describe('English-first language initialization',()=>{
  it.each([null,'fr','zh','unsupported'])('uses English when the saved choice is %j',async choice=>{
    const {language,storage,document}=await initializedLanguage(choice);
    expect(language.getUiLanguage()).toBe('en');
    expect(language.t('Workspace','工作区')).toBe('Workspace');
    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe('getaudit · Workspace');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(['en','zh-CN'] as const)('preserves the explicit saved language %s without overwriting it',async choice=>{
    const {language,storage,document}=await initializedLanguage(choice);
    expect(language.getUiLanguage()).toBe(choice);
    expect(document.documentElement.lang).toBe(choice);
    expect(storage.values.get(uiLanguageStorageKey)).toBe(choice);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('still defaults to English and permits switching if storage reads and writes fail',async()=>{
    const {language,storage,document}=await initializedLanguage(null,true);
    storage.setItem.mockImplementation(()=>{throw new Error('Storage unavailable');});
    expect(language.getUiLanguage()).toBe('en');
    expect(()=>language.setUiLanguage('zh-CN')).not.toThrow();
    expect(language.getUiLanguage()).toBe('zh-CN');
    expect(language.t('Workspace','工作区')).toBe('工作区');
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(()=>language.setUiLanguage('en')).not.toThrow();
    expect(language.getUiLanguage()).toBe('en');
  });
});

function mountDocument() {
  const {window,document}=parseHTML('<html><head></head><body><main id="root"></main></body></html>');
  const storage=storageFixture();
  const session=new Map<string,string>();
  Object.defineProperty(document,'hidden',{value:false,configurable:true});
  vi.stubGlobal('window',window);
  vi.stubGlobal('document',document);
  vi.stubGlobal('localStorage',storage);
  vi.stubGlobal('sessionStorage',{getItem:(key:string)=>session.get(key)??null,setItem:(key:string,value:string)=>{session.set(key,value);}});
  vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  return {window,document,storage,session,root:createRoot(document.getElementById('root')! as unknown as HTMLElement)};
}

const facts:WorkflowFacts={brand:'Fixture project',set:'Original question set',questions:3,frozen:true,planned:3,recorded:1,answers:1,checked:1,qualified:1,eligible:0,attention:1,transferred:0,running:false};

describe('live language switching',()=>{
  it('updates target-language buttons, workflow, connection states and playful copy in both languages',()=>{
    const render=()=>renderToStaticMarkup(<>
      <LanguageSwitch/>
      <WorkflowGuide facts={facts} page="workspace" onNavigate={vi.fn()} onAction={vi.fn()}/>
      <ConnectionAccessNotice access={{status:'locked'}} onUnlock={vi.fn()}/>
      <LoadingHelper active phase="entry"/>
    </>);
    const english=render();
    expect(english).toContain('Switch to Simplified Chinese');
    expect(english).toContain('<span lang="zh-CN" aria-hidden="true">中</span>');
    expect(english).toContain('View results');
    expect(english).toContain('Saved connections are locked');
    expect(english).toContain('Our little helper is clearing the desk for fresh clues.');
    expect(english).toContain('Check entry points');
    expect(english).toContain('Original question set');
    setUiLanguage('zh-CN');
    const chinese=render();
    expect(chinese).toContain('切换为英文');
    expect(chinese).toContain('<span lang="en" aria-hidden="true">EN</span>');
    expect(chinese).toContain('查看结果');
    expect(chinese).toContain('已保存连接尚未解锁');
    expect(chinese).toContain('小助手正在整理桌面，给新线索腾个位置。');
    expect(chinese).toContain('查看入口');
    expect(chinese).toContain('Original question set');
  });

  it('keeps the input node, entered text, focused element, selected task and local state without invoking an operation',async()=>{
    const {window,document,storage,root}=mountDocument();
    const run=vi.fn();
    function Workspace() {
      useUiLanguage();
      const [selectedTask,setSelectedTask]=useState('task-one');
      const [notesOpen,setNotesOpen]=useState(false);
      return <>
        <LanguageSwitch/>
        <form onSubmit={event=>{event.preventDefault();run();}}>
          <label htmlFor="notes">{t('Private notes','私有笔记')}</label>
          <input id="notes" defaultValue=""/>
          <button type="submit">{t('Run selected task','运行所选任务')}</button>
        </form>
        <button data-task="task-two" onClick={()=>setSelectedTask('task-two')}>{t('Select second task','选择第二个任务')}</button>
        <output data-selected-task>{selectedTask}</output>
        <button data-notes-toggle onClick={()=>setNotesOpen(value=>!value)}>{t('Open notebook','打开笔记本')}</button>
        {notesOpen&&<aside data-notes-open>{t('Notebook open','笔记本已打开')}</aside>}
      </>;
    }
    try {
      await act(async()=>root.render(<Workspace/>));
      const input=document.getElementById('notes')! as unknown as HTMLInputElement;
      input.value='Leave my draft exactly here — 原文';
      await act(async()=>{
        document.querySelector('[data-task="task-two"]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
        document.querySelector('[data-notes-toggle]')!.dispatchEvent(new window.Event('click',{bubbles:true}));
      });
      // Linkedom has no browser focus implementation. Give React its usual
      // activeElement snapshot so this checks that language rendering preserves
      // the focused DOM node; real browser focus is covered by UI verification.
      Object.defineProperty(document,'activeElement',{get:()=>input,configurable:true});
      for(const target of ['zh-CN','en'] as const) {
        await act(async()=>document.querySelector('.language-switch')!.dispatchEvent(new window.Event('click',{bubbles:true})));
        expect(getUiLanguage()).toBe(target);
        expect(document.getElementById('notes')).toBe(input);
        expect(input.value).toBe('Leave my draft exactly here — 原文');
        expect(document.activeElement).toBe(input);
        expect(document.querySelector('[data-selected-task]')!.textContent).toBe('task-two');
        expect(document.querySelector('[data-notes-open]')!.textContent).toBe(target==='en'?'Notebook open':'笔记本已打开');
        expect(document.querySelector('label')!.textContent).toBe(target==='en'?'Private notes':'私有笔记');
        const switchButton=document.querySelector('.language-switch')!;
        expect(switchButton.querySelector('span')!.textContent).toBe(target==='en'?'中':'EN');
        expect(switchButton.getAttribute('aria-label')).toBe(target==='en'?'Switch to Simplified Chinese':'切换为英文');
        expect(switchButton.getAttribute('title')).toBe(switchButton.getAttribute('aria-label'));
        expect(document.documentElement.lang).toBe(target);
        expect(storage.values.get(uiLanguageStorageKey)).toBe(target);
      }
      expect(run).not.toHaveBeenCalled();
      expect(vi.mocked(request)).not.toHaveBeenCalled();
    }finally{await act(async()=>root.unmount());}
  });

  it('preserves a real panel’s selected collection language, market, device and snapshot and does not repeat reads or start collection',async()=>{
    vi.useFakeTimers();
    const {window,document,root}=mountDocument();
    const brand={id:'language-brand',name:'Original brand',owned_domains:'["client.example"]'};
    const snapshot={id:'language-snapshot',property:'sc-domain:client.example',startDate:'2026-09-01',endDate:'2026-09-30',country:'CAN',captured_at:'2026-10-11',hash:'frozen-snapshot',dashboard:1};
    vi.mocked(request).mockImplementation(async(path,input)=>{
      if(path==='gsc/history')return [snapshot];
      if(path==='keyword-audit/config')return {providers:[{id:'openai',label:'OpenAI',available:true,model:'fixture-model'}],locations:[{code:2124,country:'CAN',label:'Canada'}],dataForSeoConfigured:true};
      if(path.startsWith('keyword-audit/jobs?'))return [];
      if(path==='keyword-audit/preview')return {input,brand:{...brand,ownedDomains:['client.example']},snapshot:{property:snapshot.property,startDate:snapshot.startDate,endDate:snapshot.endDate,country:'CAN',device:'ALL'},keywords:[],candidateCount:0,shortfall:5,warnings:[]};
      throw new Error('Unexpected request: '+path);
    });
    function field(label:string){return [...document.querySelectorAll('label')].find(item=>item.querySelector('span')?.textContent===label)!.querySelector('select')!;}
    async function selectValue(select:Element,value:string){
      Object.defineProperty(select,'value',{value,writable:true,configurable:true});
      await act(async()=>select.dispatchEvent(new window.Event('change',{bubbles:true})));
    }
    try {
      await act(async()=>root.render(<><LanguageSwitch/><KeywordAuditPanel brandId={brand.id} brand={brand}/></>));
      await act(async()=>{await vi.advanceTimersByTimeAsync(200);});
      await selectValue(field('Search language'),'fr');
      await selectValue(field('Search device'),'mobile');
      await act(async()=>{await vi.advanceTimersByTimeAsync(200);});
      const before=vi.mocked(request).mock.calls.map(call=>structuredClone(call));
      const lastPreview=before.filter(([path])=>path==='keyword-audit/preview').at(-1)?.[1];
      expect(lastPreview).toMatchObject({languageCode:'fr',countryCode:2124,device:'mobile',snapshotId:snapshot.id});
      await act(async()=>document.querySelector('.language-switch')!.dispatchEvent(new window.Event('click',{bubbles:true})));
      await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
      expect(field('搜索语言').value).toBe('fr');
      expect(field('搜索市场').value).toBe('2124');
      expect(field('搜索设备').value).toBe('mobile');
      expect(field('GSC 快照').value).toBe(snapshot.id);
      expect(document.getElementById('keyword-audit-title')!.textContent).toBe('关键词机会');
      expect(vi.mocked(request).mock.calls).toEqual(before);
      await act(async()=>document.querySelector('.language-switch')!.dispatchEvent(new window.Event('click',{bubbles:true})));
      expect(field('Search language').value).toBe('fr');
      expect(document.getElementById('keyword-audit-title')!.textContent).toBe('Keyword opportunities');
      expect(vi.mocked(request).mock.calls).toEqual(before);
      expect(vi.mocked(request).mock.calls.some(([path])=>path==='keyword-audit/start'||path==='connections/unlock')).toBe(false);
    }finally{await act(async()=>root.unmount());}
  });

  it('translates authored feedback while retaining unknown original evidence, URLs, identifiers and hashes verbatim',()=>{
    const evidence=Object.freeze({text:'来源原文：记录暂不可用。 The original quote stays here.',url:'https://client.example/路径?q=原文',id:'record-123',hash:'frozen-sha256-fixture',locale:'fr-CA',country:'CA'});
    const original=JSON.stringify(evidence);
    const authored=t('The notebook is ready.','笔记本准备好了。');
    expect(uiMessage(authored)).toBe('The notebook is ready.');
    setUiLanguage('zh-CN');
    expect(uiMessage(authored)).toBe('笔记本准备好了。');
    for(const value of Object.values(evidence))expect(uiMessage(value)).toBe(value);
    expect(JSON.stringify(evidence)).toBe(original);
    setUiLanguage('en');
    for(const value of Object.values(evidence))expect(uiMessage(value)).toBe(value);
    expect(uiMessage('笔记本准备好了。')).toBe('The notebook is ready.');
    expect(JSON.stringify(evidence)).toBe(original);
  });

  it('leaves source titles and quotes verbatim in rendered results even when they match a registered UI message',()=>{
    const originalText='操作未完成';
    // Matching an interface message does not turn source material into UI copy.
    t('The action could not be completed.',originalText);
    const source:PageEvidence={id:'original-source-id',url:'https://client.example/original?q=source',resolvedUrl:'https://client.example/original?q=source',observedAt:'2026-10-11T12:00:00Z',status:'available',title:originalText,headings:[originalText],body:originalText,excerpt:originalText,hash:'frozen-original-source-hash',limitations:[]};
    const item:KeywordAuditKeyword={keyword:originalText,position:13,clicks:1,impressions:10,ctr:0.1,ownerUrl:source.url,ownerAlternatives:[],reason:'Original selection reason',ownerEvidence:source,competitorEvidence:[],serp:null,analysis:{summary:originalText,comparisons:[{competitorUrl:'https://competitor.example/page',actualRank:1,approach:[{text:originalText,evidence:[{sourceId:source.id,quote:originalText}]}],gaps:[],improvements:[],unknowns:[]}],unknowns:[]}};
    const before=JSON.stringify(item);
    for(const language of ['en','zh-CN'] as const) {
      setUiLanguage(language);
      const html=renderToStaticMarkup(<KeywordAuditResult item={item} index={0}/>);
      const {document}=parseHTML(html);
      expect(document.querySelector('h3')!.textContent).toBe(originalText);
      expect(document.querySelector('.keyword-audit-analysis-summary')!.textContent).toBe(originalText);
      expect(document.querySelector('blockquote')!.textContent).toBe(originalText);
      expect(document.querySelector('.keyword-audit-page-proof p')!.textContent).toBe(originalText);
      expect(html).toContain(source.url.replaceAll('&','&amp;'));
      expect(html).toContain(source.id);
      expect(html).toContain(source.hash);
      expect(document.querySelector('.keyword-audit-result-head p')!.textContent).toContain(language==='en'?'GSC average position':'GSC 平均排名');
      expect(JSON.stringify(item)).toBe(before);
    }
  });
});
