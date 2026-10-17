import React,{act} from 'react';
import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {request} from '../../apps/console/api.ts';
import {getUiLanguage,setUiLanguage,uiLanguageStorageKey} from '../../apps/console/i18n.tsx';
import {refreshAccountStatus} from '../../apps/console/account-chip.tsx';

// This suite exercises the real shell and its callbacks. Detailed provider,
// connection and collection behavior remains covered by the real panel suites.
vi.mock('../../apps/console/api.ts',()=>({request:vi.fn(),authHeaders:()=>({})}));
vi.mock('../../apps/console/account-chip.tsx',()=>({AccountChip:()=>null,refreshAccountStatus:vi.fn()}));
vi.mock('../../apps/console/gsc-panel.tsx',()=>({GscPanel:(props:any)=><section data-search-home data-property={props.preferredProperty} data-connected={String(props.connectionsReady)}><button data-configure-search onClick={props.onConnections}>Configure search fixture</button></section>}));
vi.mock('../../apps/console/browser-panel.tsx',()=>({BrowserPanel:()=> <section data-ai-visibility/>}));
vi.mock('../../apps/console/agent-panel.tsx',()=>({AgentPanel:()=> <section data-agent-settings/>}));
vi.mock('../../apps/console/brands-panel.tsx',()=>({BrandsPanel:(props:any)=> <section data-project-settings><button data-create-project onClick={props.onCreate}>Create project fixture</button></section>}));
vi.mock('../../apps/console/keyword-audit-panel.tsx',()=>({KeywordAuditPanel:()=> <section data-keyword-audit/>}));
vi.mock('../../apps/console/local-questions-panel.tsx',()=>({LocalQuestionsPanel:()=> <section data-question-settings/>}));
vi.mock('../../apps/console/sources-panel.tsx',()=>({SourcesPanel:()=>null}));
vi.mock('../../apps/console/ai-panel.tsx',()=>({AiPanel:()=>null}));

let App:React.ComponentType;
beforeAll(async()=>{
  // Importing the browser entry may read the URL token. It must not mount
  // itself when there is no #root, so test render owns the complete lifecycle.
  const {window,document}=parseHTML('<html><body></body></html>');
  vi.stubGlobal('window',window);vi.stubGlobal('document',document);
  vi.stubGlobal('location',{hash:'',pathname:'/'});
  vi.stubGlobal('sessionStorage',{getItem:()=>null,setItem:vi.fn()});
  ({App}=await import('../../apps/console/src.tsx'));
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.mocked(request).mockReset();vi.mocked(refreshAccountStatus).mockReset();setUiLanguage('en');});

const brand={id:'existing-project',name:'Original project 原名',owned_domains:'["client.example"]',aliases:'[]',category:null};
const savedSet={id:'original-set-id',brand_id:brand.id,label:'Original questions 原文',frozen_at:'2026-10-01',frozen_hash:'original-frozen-hash',prompt_count:2};
async function mount(options:{empty?:boolean;access?:'ready'|'locked';locale?:'en'|'zh-CN'}={}){
  const {window,document}=parseHTML('<html><head></head><body><div id="fixture"></div></body></html>');
  const values=new Map<string,string>(options.empty?[]:[['lab-set',savedSet.id]]),session=new Map<string,string>();
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)};
  Object.defineProperty(window,'localStorage',{configurable:true,value:storage});
  Object.defineProperty(document,'hidden',{configurable:true,value:false});
  Object.defineProperty(window,'scrollTo',{configurable:true,value:vi.fn()});
  vi.stubGlobal('window',window);vi.stubGlobal('document',document);vi.stubGlobal('localStorage',storage);
  vi.stubGlobal('sessionStorage',{getItem:(key:string)=>session.get(key)??null,setItem:(key:string,value:string)=>session.set(key,value)});
  vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  // Linkedom does not implement native dialog APIs; actual dialog behavior is
  // verified in the isolated browser walkthrough.
  Object.defineProperty(window.HTMLElement.prototype,'showModal',{configurable:true,value(){this.setAttribute('open','');}});
  const state={brands:options.empty?[]:[brand],deletedBrands:[],sets:options.empty?[]:[savedSet],selectedSetId:options.empty?null:savedSet.id,plans:[],prompts:[],runs:[],engines:[],apiJobs:[],browserJobs:[],browserSessions:[],browserAvailability:{available:true,message:'Synthetic native availability'},settings:{persisted:true,access:{status:options.access??'ready'},fields:[]},demo:true,isolatedSampling:true};
  vi.mocked(request).mockImplementation(async path=>{
    if(path==='state'||path.startsWith('state?'))return state;
    throw new Error('Unexpected shell operation: '+path);
  });
  setUiLanguage(options.locale??'en');
  const root=createRoot(document.getElementById('fixture')! as unknown as HTMLElement);
  await act(async()=>root.render(<App/>));
  const click=async(selector:string)=>{const button=document.querySelector(selector);expect(button,selector).not.toBeNull();await act(async()=>button!.dispatchEvent(new window.Event('click',{bubbles:true})));};
  return {root,document,window,values,state,click};
}

describe('simple daily navigation',()=>{
  it.each(['en','zh-CN'] as const)('opens the Search desk directly with three daily destinations in %s',async locale=>{
    const ui=await mount({locale});
    try{
      expect(ui.document.querySelector('.app')?.getAttribute('data-page')).toBe('gsc');
      expect(ui.document.querySelector('[data-search-home]')?.getAttribute('data-property')).toBe('sc-domain:client.example');
      expect(ui.document.querySelectorAll('.sidebar nav button')).toHaveLength(3);
      expect(ui.document.querySelector('.sidebar nav button[aria-current="page"]')).not.toBeNull();
      expect(ui.document.querySelector('[data-nav="settings"]')).not.toBeNull();
      expect(vi.mocked(request).mock.calls.every(([,input])=>input===undefined)).toBe(true);
      expect(ui.values.get('lab-set')).toBe(savedSet.id);
      expect(getUiLanguage()).toBe(locale);
    }finally{await act(async()=>ui.root.unmount());}
  });

  it('keeps configuration and advanced destinations reachable without making them daily navigation',async()=>{
    const ui=await mount();
    try{
      for(const page of ['brands','agents','lab']){
        await ui.click('[data-nav="settings"]');
        expect(ui.document.querySelector('.app')?.getAttribute('data-page')).toBe('settings');
        await ui.click('main [data-nav="'+page+'"]');
        expect(ui.document.querySelector('.app')?.getAttribute('data-page')).toBe(page);
      }
      expect(ui.values.get('lab-set')).toBe(savedSet.id);
      expect(vi.mocked(request).mock.calls.every(([,input])=>input===undefined)).toBe(true);
    }finally{await act(async()=>ui.root.unmount());}
  });

  it('lets an empty installation create its first project from Settings',async()=>{
    const ui=await mount({empty:true});
    try{
      expect(ui.document.querySelector('.app')?.getAttribute('data-page')).toBe('gsc');
      expect(ui.document.querySelector('[data-search-home]')?.getAttribute('data-property')??null).toBeNull();
      await ui.click('[data-nav="settings"]');
      await ui.click('main [data-nav="brands"]');
      await ui.click('[data-create-project]');
      expect(ui.document.querySelector('dialog[open] input[name="name"]')).not.toBeNull();
      expect(vi.mocked(request).mock.calls.every(([,input])=>input===undefined)).toBe(true);
    }finally{await act(async()=>ui.root.unmount());}
  });

  it('keeps a locked connection locked and preserves the selected scope when switching language',async()=>{
    const ui=await mount({access:'locked'});
    try{
      expect(ui.document.querySelector('[data-search-home]')?.getAttribute('data-connected')).toBe('false');
      const before=JSON.stringify(ui.state),reads=vi.mocked(request).mock.calls.length;
      await ui.click('.topbar .language-switch');
      expect(getUiLanguage()).toBe('zh-CN');
      expect(ui.values.get(uiLanguageStorageKey)).toBe('zh-CN');
      expect(ui.values.get('lab-set')).toBe(savedSet.id);
      expect(ui.document.querySelector('[data-search-home]')?.getAttribute('data-property')).toBe('sc-domain:client.example');
      expect(ui.document.querySelector('[data-search-home]')?.getAttribute('data-connected')).toBe('false');
      expect(vi.mocked(request).mock.calls).toHaveLength(reads);
      expect(JSON.stringify(ui.state)).toBe(before);
      expect(vi.mocked(request).mock.calls.some(([path])=>path==='connections/unlock'||path==='browser-jobs'||path==='gsc/sync'||path==='keyword-audit/start')).toBe(false);
    }finally{await act(async()=>ui.root.unmount());}
  });

  it.each([true,false])('refreshes account observers once after explicit unlock completes (success=%s) without hiding errors or authorizing Google',async success=>{
    const ui=await mount({access:'locked'}),original=vi.mocked(request).getMockImplementation()!;
    vi.mocked(request).mockImplementation(async(path,input)=>{
      if(path==='connections/unlock'){
        if(!success)throw new Error('The system access request was cancelled.');
        ui.state.settings.access.status='ready';return {};
      }
      return original(path,input);
    });
    try{
      await ui.click('.connection-access-notice button');
      expect(vi.mocked(request).mock.calls).toContainEqual(['connections/unlock',{}]);
      expect(refreshAccountStatus).toHaveBeenCalledTimes(1);
      expect(ui.document.querySelector('[data-search-home]')?.getAttribute('data-connected')).toBe(String(success));
      if(success)expect(ui.document.querySelector('.connection-access-notice')).toBeNull();
      else expect(ui.document.querySelector('.alert.error')?.textContent).toContain('The system access request was cancelled.');
      expect(vi.mocked(request).mock.calls.filter(([,input])=>input!==undefined)).toEqual([['connections/unlock',{}]]);
    }finally{await act(async()=>ui.root.unmount());}
  });
});
