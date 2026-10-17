import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {request} from '../../apps/console/api.ts';
import {GscPanel} from '../../apps/console/gsc-panel.tsx';
import {KeywordAuditPanel} from '../../apps/console/keyword-audit-panel.tsx';
import {setUiLanguage} from '../../apps/console/i18n.tsx';
vi.mock('../../apps/console/api.ts',()=>({request:vi.fn()}));
vi.mock('../../apps/console/download.ts',()=>({downloadText:vi.fn()}));
const NativeFormData=globalThis.FormData;
beforeEach(()=>setUiLanguage('zh-CN'));
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.mocked(request).mockReset();setUiLanguage('en');});
function fixture(){
  const {window,document}=parseHTML('<html><body><main id="root"></main></body></html>'),storage=new Map<string,string>();
  vi.stubGlobal('window',window);vi.stubGlobal('document',document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.stubGlobal('sessionStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)});
  Object.defineProperty(window.HTMLElement.prototype,'showModal',{configurable:true,value(){this.setAttribute('open','');}});
  vi.stubGlobal('FormData',class extends NativeFormData{constructor(form?:HTMLFormElement){super();if(form)for(const node of form.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input[name],select[name],textarea[name]')){if(!node.disabled)this.append(node.name,node.value);}}});
  return {window,document,root:createRoot(document.getElementById('root')! as unknown as HTMLElement)};
}
async function selectValue(select:Element, value:string, window:ReturnType<typeof parseHTML>['window']) {
  Object.defineProperty(select,'value',{value,writable:true,configurable:true});
  await act(async()=>{select.dispatchEvent(new window.Event('change',{bubbles:true}));});
}
describe('panels after asynchronous connection load',()=>{
  it('opens settings and returns home locally without losing filters or restarting paused reads',async()=>{
    setUiLanguage('en');const {window,document,root}=fixture(),property='sc-domain:client.example',changed=vi.fn();
    vi.mocked(request).mockImplementation(async path=>{
      if(path==='gsc/sites')return [{siteUrl:property,permissionLevel:'siteOwner'}];
      if(path==='gsc/history'||path.startsWith('gsc/inspections?'))return [];
      if(path.startsWith('gsc/items?'))return [{id:'preferences',kind:'preferences',payload:{autoRead:false,metric:'impressions',pageSize:25,language:'en'}}];
      throw new Error('Unexpected request while navigating: '+path);
    });
    const props={preferredProperty:property,onSectionChange:changed};
    try{
      await act(async()=>root.render(React.createElement(GscPanel,props)));
      await act(async()=>document.querySelector('[data-action="filters"]')!.dispatchEvent(new window.Event('click',{bubbles:true})));
      await selectValue(document.querySelector('[aria-label="GSC region"]')!,'USA',window);
      (document.querySelector('input[name="query"]') as unknown as HTMLInputElement).value='Keep this filter 原文';
      await act(async()=>document.querySelector('.gsc-dialog form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
      const before=vi.mocked(request).mock.calls.length;
      await act(async()=>root.render(React.createElement(GscPanel,{...props,sectionRequest:{section:'settings',revision:1}})));
      expect(document.querySelector('[data-tab="settings"]')?.getAttribute('aria-current')).toBe('page');
      await act(async()=>root.render(React.createElement(GscPanel,{...props,sectionRequest:{section:'overview',revision:2}})));
      expect(document.querySelector('[data-tab="overview"]')?.getAttribute('aria-current')).toBe('page');
      await act(async()=>document.querySelector('[data-tab="health"]')!.dispatchEvent(new window.Event('click',{bubbles:true})));
      expect(changed).toHaveBeenCalledWith('health');
      await act(async()=>document.querySelector('[data-tab="overview"]')!.dispatchEvent(new window.Event('click',{bubbles:true})));
      expect(changed).toHaveBeenCalledWith('overview');
      await act(async()=>document.querySelector('[data-action="filters"]')!.dispatchEvent(new window.Event('click',{bubbles:true})));
      expect((document.querySelector('[aria-label="GSC region"]') as unknown as HTMLSelectElement).value).toBe('USA');
      expect((document.querySelector('input[name="query"]') as unknown as HTMLInputElement).value).toBe('Keep this filter 原文');
      expect(vi.mocked(request).mock.calls).toHaveLength(before);
    }finally{await act(async()=>root.unmount());}
  });
  it('shows useful saved opportunities without mounting the full data table or reading providers',async()=>{
    setUiLanguage('en');const {window,document,root}=fixture(),property='sc-domain:client.example';
    const queries=[['low boundary',11,100],['upper boundary',20,300],['middle result',15,200],['too high',10,1000],['too low',21,1000],['too few impressions',14,9]].map(([query,position,impressions])=>({keys:[query],position,impressions,clicks:1,ctr:.01}));
    const evidence={hash:'original-search-hash',snapshot:{id:'existing-search-snapshot',property,country:'ALL',device:'ALL',type:'web',startDate:'2026-09-16',endDate:'2026-10-13',capturedAt:'2026-10-16T12:00:00Z',source:'Synthetic saved search',timeZone:'America/Los_Angeles',dataState:'final',totals:null,queries,pages:[],daily:[],requests:[],raw:[],limitations:[]}},original=JSON.stringify(evidence);
    vi.mocked(request).mockImplementation(async path=>{
      if(path==='gsc/sites')return [{siteUrl:property,permissionLevel:'siteOwner'}];
      if(path==='gsc/history')return [{id:evidence.snapshot.id,property,captured_at:evidence.snapshot.capturedAt,startDate:evidence.snapshot.startDate,endDate:evidence.snapshot.endDate,country:'ALL',hash:evidence.hash,dashboard:1}];
      if(path.startsWith('gsc/items?'))return [{id:'preferences',kind:'preferences',payload:{autoRead:false,metric:'impressions',pageSize:25,language:'en'}}];
      if(path.startsWith('gsc/inspections?'))return [];
      if(path==='gsc/snapshot?id='+evidence.snapshot.id)return evidence;
      throw new Error('Unexpected provider read: '+path);
    });
    try{
      await act(async()=>root.render(React.createElement(GscPanel,{preferredProperty:property})));
      expect([...document.querySelectorAll('.gsc-starting-points li>button>span')].map(node=>node.textContent)).toEqual(['upper boundary','middle result','low boundary']);
      expect(document.querySelector('.gsc-overview-details')?.hasAttribute('open')).toBe(false);
      expect(document.querySelector('.gsc-data-table')).toBeNull();
      const before=vi.mocked(request).mock.calls.length;
      await act(async()=>document.querySelector('.gsc-starting-points li>button')!.dispatchEvent(new window.Event('click',{bubbles:true})));
      expect(document.querySelector('[data-tab="opportunity"]')?.getAttribute('aria-current')).toBe('page');
      expect(document.querySelector('.gsc-data-table tbody')?.textContent).toContain('upper boundary');
      expect(document.querySelector('.gsc-data-table tbody')?.textContent).not.toContain('middle result');
      expect(vi.mocked(request).mock.calls).toHaveLength(before);
      expect(vi.mocked(request).mock.calls.every(([,input])=>input===undefined)).toBe(true);
      expect(JSON.stringify(evidence)).toBe(original);
    }finally{await act(async()=>root.unmount());}
  });
  it('notifies project selection only after an explicit site change and never enables paused reads',async()=>{
    const {window,document,root}=fixture(),changed=vi.fn(),first='sc-domain:first.example',next='sc-domain:next.example';
    vi.mocked(request).mockImplementation(async path=>{
      if(path==='gsc/sites')return [{siteUrl:first,permissionLevel:'siteOwner'},{siteUrl:next,permissionLevel:'siteOwner'}];
      if(path==='gsc/history'||path.startsWith('gsc/inspections?'))return [];
      if(path.startsWith('gsc/items?'))return [{id:'preferences',kind:'preferences',payload:{autoRead:false,metric:'impressions',pageSize:25,language:'en'}}];
      throw new Error('Unexpected provider read: '+path);
    });
    try{
      await act(async()=>root.render(React.createElement(GscPanel,{preferredProperty:first,onPropertyChange:changed})));
      expect(changed).not.toHaveBeenCalled();
      await selectValue(document.querySelector('.gsc-site-picker select')!,next,window);
      expect(changed).toHaveBeenCalledExactlyOnceWith(next);
      expect(vi.mocked(request).mock.calls.some(([path])=>path==='gsc/sync'||path==='gsc/item-save'||path==='connections/unlock')).toBe(false);
      expect((document.querySelector('.gsc-site-picker select') as unknown as HTMLSelectElement).value).toBe(next);
    }finally{await act(async()=>root.unmount());}
  });
  it('keeps advanced filter drafts local until Apply and preserves paused automatic reads',async()=>{
    setUiLanguage('en');const {window,document,root}=fixture();
    vi.mocked(request).mockImplementation(async path=>{
      if(path==='gsc/sites')return [{siteUrl:'sc-domain:sample-studio.example',permissionLevel:'siteOwner'}];
      if(path==='gsc/history'||path.startsWith('gsc/inspections?'))return [];
      if(path.startsWith('gsc/items?'))return [{id:'preferences',kind:'preferences',payload:{autoRead:false,metric:'impressions',pageSize:25,language:'en'}}];
      throw new Error('Unexpected request: '+path);
    });
    const open=async()=>{await act(async()=>document.querySelector('[data-action="filters"]')!.dispatchEvent(new window.Event('click',{bubbles:true})));};
    const close=async()=>{await act(async()=>document.querySelector('.gsc-dialog header button:last-child')!.dispatchEvent(new window.Event('click',{bubbles:true})));};
    try{
      await act(async()=>root.render(React.createElement(GscPanel,{preferredProperty:'sc-domain:sample-studio.example'})));
      await open();
      await selectValue(document.querySelector('[aria-label="GSC region"]')!,'USA',window);
      expect(vi.mocked(request).mock.calls.some(([path])=>path==='gsc/sync')).toBe(false);
      await close();await open();
      expect((document.querySelector('[aria-label="GSC region"]') as unknown as HTMLSelectElement).value).toBe('ALL');
      await selectValue(document.querySelector('[aria-label="GSC region"]')!,'USA',window);
      const input=document.querySelector('input[name="query"]')! as unknown as HTMLInputElement;
      input.value='Original search filter 原文';
      await act(async()=>document.querySelector('.gsc-dialog .language-switch')!.dispatchEvent(new window.Event('click',{bubbles:true})));
      expect(document.querySelector('input[name="query"]')).toBe(input);
      expect(input.value).toBe('Original search filter 原文');
      await act(async()=>document.querySelector('.gsc-dialog form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
      expect(document.querySelector('.gsc-dialog')).toBeNull();
      expect(vi.mocked(request).mock.calls.some(([path])=>path==='gsc/sync'||path==='gsc/item-save'||path==='connections/unlock')).toBe(false);
      await open();
      expect((document.querySelector('[aria-label="GSC 地区"]') as unknown as HTMLSelectElement).value).toBe('USA');
      expect((document.querySelector('input[name="query"]') as unknown as HTMLInputElement).value).toBe('Original search filter 原文');
    }finally{await act(async()=>root.unmount());}
  });
  it('validates GSC only when connections are ready while retaining a user-selected market',async()=>{
    const {window,document,root}=fixture();
    vi.mocked(request).mockImplementation(async(path,input:any)=>{
      if(path==='gsc/sites')return [{siteUrl:'sc-domain:sample-studio.example',permissionLevel:'siteOwner'}];
      if(path==='gsc/history'||path.startsWith('gsc/inspections?'))return [];
      if(path.startsWith('gsc/items?'))return [{id:'preferences',kind:'preferences',payload:{autoRead:false,metric:'impressions',pageSize:25,language:'zh'}}];
      if(path==='gsc/sync')return {cached:true,nextRefreshAt:'',evidence:{hash:'synthetic-saved-hash',snapshot:{...input.filters,id:'saved-market-fixture',capturedAt:'2026-10-16T12:00:00Z',source:'Synthetic read fixture',timeZone:'America/Los_Angeles',dataState:'final',totals:null,queries:[],pages:[],daily:[],requests:[],raw:[],limitations:[]}}};
      throw new Error('Unexpected request: '+path);
    });
    try {
      await act(async()=>root.render(React.createElement(GscPanel,{connectionsReady:false,preferredProperty:'sc-domain:sample-studio.example'})));
      expect(vi.mocked(request).mock.calls.filter(([path])=>path==='gsc/sites')).toHaveLength(0);
      expect(document.body.textContent).toContain('GSC 尚未连接');
      await act(async()=>document.querySelector('[data-action="filters"]')!.dispatchEvent(new window.Event('click',{bubbles:true})));
      await selectValue(document.querySelector('[aria-label="GSC 地区"]')!,'USA',window);
      await act(async()=>document.querySelector('.gsc-dialog form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
      await act(async()=>root.render(React.createElement(GscPanel,{connectionsReady:true,preferredProperty:'sc-domain:sample-studio.example'})));
      expect(vi.mocked(request).mock.calls.filter(([path])=>path==='gsc/sites')).toHaveLength(1);
      expect(vi.mocked(request).mock.calls.some(([path])=>path==='connections/unlock'||path==='gsc/sync')).toBe(false);
      expect(document.querySelector('button.gsc-refresh')!.hasAttribute('disabled')).toBe(false);
      await act(async()=>{[...document.querySelectorAll('button')].find(button=>button.textContent==='立即更新')!.dispatchEvent(new window.Event('click',{bubbles:true}));});
      const read=vi.mocked(request).mock.calls.find(([path])=>path==='gsc/sync');
      expect(read?.[1]).toMatchObject({filters:{country:'USA'},force:true});
      expect(document.querySelector('.gsc-metrics')).not.toBeNull();
      await act(async()=>document.querySelector('[data-action="filters"]')!.dispatchEvent(new window.Event('click',{bubbles:true})));
      expect((document.querySelector('[aria-label="GSC 地区"]') as unknown as HTMLSelectElement).value).toBe('USA');
      await act(async()=>document.querySelector('.gsc-dialog header button:last-child')!.dispatchEvent(new window.Event('click',{bubbles:true})));
      expect(vi.mocked(request).mock.calls.filter(([path])=>path==='gsc/history')).toHaveLength(2);
      expect(vi.mocked(request).mock.calls.some(([path])=>path==='connections/unlock')).toBe(false);
      await act(async()=>root.render(React.createElement(GscPanel,{connectionsReady:true,preferredProperty:'sc-domain:sample-studio.example'})));
      expect(vi.mocked(request).mock.calls.filter(([path])=>path==='gsc/sites')).toHaveLength(1);
    }finally{await act(async()=>root.unmount());}
  });
  it('refreshes audit availability without resetting the selected service, device, language or snapshot',async()=>{
    vi.useFakeTimers();const {window,document,root}=fixture();
    const brandId='brand-fixture',snapshotId='snapshot-fixture',brand={id:brandId,name:'Client',owned_domains:'["client.example"]'};
    let ready=false;
    vi.mocked(request).mockImplementation(async(path,input)=>{
      if(path==='gsc/history')return [{id:snapshotId,property:'sc-domain:client.example',startDate:'2026-09-01',endDate:'2026-09-30',country:'CAN',captured_at:'2026-10-11',hash:'frozen',dashboard:1}];
      if(path==='keyword-audit/config')return {providers:[{id:'openai',label:'OpenAI',available:ready,model:'gpt-default'},{id:'anthropic',label:'Claude',available:ready,model:'claude-default'}],locations:[{code:2124,country:'CAN',label:'加拿大'}],dataForSeoConfigured:ready};
      if(path.startsWith('keyword-audit/jobs?'))return [];
      if(path==='keyword-audit/preview')return {input,brand:{...brand,ownedDomains:['client.example']},snapshot:{property:'sc-domain:client.example',startDate:'2026-09-01',endDate:'2026-09-30',country:'CAN',device:'ALL'},keywords:[],candidateCount:0,shortfall:5,warnings:[]};
      throw new Error('Unexpected request: '+path);
    });
    function field(label:string){return [...document.querySelectorAll('label')].find(item=>item.querySelector('span')?.textContent===label)!.querySelector('select')!;}
    try {
      await act(async()=>root.render(React.createElement(KeywordAuditPanel,{brandId,brand,connectionsReady:false})));
      await act(async()=>{await vi.advanceTimersByTimeAsync(200);});
      await selectValue(field('模型供应商'),'anthropic',window);
      await selectValue(field('搜索设备'),'mobile',window);
      await selectValue(field('搜索语言'),'fr',window);
      await act(async()=>{await vi.advanceTimersByTimeAsync(200);});
      expect(vi.mocked(request).mock.calls.filter(([path])=>path==='keyword-audit/preview').at(-1)?.[1]).toMatchObject({provider:'anthropic',device:'mobile',languageCode:'fr',model:'claude-default'});
      expect(document.body.textContent).toContain('尚未配置');
      ready=true;
      await act(async()=>root.render(React.createElement(KeywordAuditPanel,{brandId,brand,connectionsReady:true})));
      expect(vi.mocked(request).mock.calls.filter(([path])=>path==='keyword-audit/config')).toHaveLength(2);
      expect(vi.mocked(request).mock.calls.filter(([path])=>path==='gsc/history')).toHaveLength(1);
      expect(field('模型供应商').getAttribute('value')??(field('模型供应商') as unknown as HTMLSelectElement).value).toBe('anthropic');
      expect((field('搜索设备') as unknown as HTMLSelectElement).value).toBe('mobile');
      expect((field('搜索语言') as unknown as HTMLSelectElement).value).toBe('fr');
      expect((field('GSC 快照') as unknown as HTMLSelectElement).value).toBe(snapshotId);
      expect(document.body.textContent).not.toContain('尚未配置');
      expect(vi.mocked(request).mock.calls.some(([path])=>path==='connections/unlock'||path==='keyword-audit/start')).toBe(false);
      await act(async()=>root.render(React.createElement(KeywordAuditPanel,{brandId,brand,connectionsReady:true})));
      expect(vi.mocked(request).mock.calls.filter(([path])=>path==='keyword-audit/config')).toHaveLength(2);
    }finally{await act(async()=>root.unmount());}
  });
  it('does not let an older initial audit configuration overwrite the ready refresh',async()=>{
    const {document,root}=fixture(),brandId='brand-fixture',brand={id:brandId,name:'Client',owned_domains:'["client.example"]'};
    let release!:(value:unknown)=>void,reads=0;
    const initialConfig=new Promise(resolve=>{release=resolve;});
    const config=(available:boolean)=>({providers:[{id:'openai',label:'OpenAI',available,model:'gpt-default'}],locations:[{code:2124,country:'CAN',label:'加拿大'}],dataForSeoConfigured:available});
    vi.mocked(request).mockImplementation(async(path,input)=>{
      if(path==='keyword-audit/config'){reads++;return reads===1?initialConfig:config(true);}
      if(path==='gsc/history')return [{id:'snapshot',property:'sc-domain:client.example',startDate:'2026-09-01',endDate:'2026-09-30',country:'CAN',captured_at:'2026-10-11',hash:'frozen',dashboard:1}];
      if(path.startsWith('keyword-audit/jobs?'))return [];
      if(path==='keyword-audit/preview')return {input,keywords:[],candidateCount:0,shortfall:5,warnings:[],snapshot:{property:'sc-domain:client.example',startDate:'2026-09-01',endDate:'2026-09-30',country:'CAN',device:'ALL'}};
      throw new Error('Unexpected request: '+path);
    });
    try {
      await act(async()=>root.render(React.createElement(KeywordAuditPanel,{brandId,brand,connectionsReady:false})));
      await act(async()=>root.render(React.createElement(KeywordAuditPanel,{brandId,brand,connectionsReady:true})));
      await act(async()=>{release(config(false));});
      expect(reads).toBe(2);
      expect(document.body.textContent).not.toContain('尚未配置');
      expect(document.body.textContent).not.toContain('配置分析连接后开始');
      expect(vi.mocked(request).mock.calls.some(([path])=>path==='connections/unlock'||path==='keyword-audit/start')).toBe(false);
    }finally{await act(async()=>root.unmount());}
  });
});
