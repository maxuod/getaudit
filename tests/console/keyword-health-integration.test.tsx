import React,{act} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createRoot} from 'react-dom/client';
import {parseHTML} from 'linkedom';
import {GscPanel} from '../../apps/console/gsc-panel.tsx';
import {request} from '../../apps/console/api.ts';
import {setUiLanguage} from '../../apps/console/i18n.tsx';
import type {GscEvidence} from '../../src/console/gsc.ts';

vi.mock('../../apps/console/api.ts',()=>({request:vi.fn()}));
vi.mock('../../apps/console/download.ts',()=>({downloadText:vi.fn(),downloadBlob:vi.fn()}));
vi.mock('../../apps/console/keyword-health-panel.tsx',()=>({KeywordHealthPanel:(props:any)=><section data-health-source={props.evidence?.snapshot.id} data-stale={String(props.stale)}><button onClick={props.onReadHistory}>Read history fixture</button></section>}));
const NativeFormData=globalThis.FormData;
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();setUiLanguage('en');});
function source():GscEvidence {return {hash:'original-snapshot-hash',snapshot:{id:'dashboard',property:'sc-domain:sample-studio.example',country:'CAN',type:'web',startDate:'2026-09-16',endDate:'2026-10-13',capturedAt:'2026-10-16T12:00:00Z',timeZone:'America/Los_Angeles',dataState:'final',source:'Synthetic GSC integration fixture',totals:null,queries:[],pages:[],daily:[],queryDaily:[],requests:[],raw:[],limitations:[],comparison:{startDate:'2026-08-19',endDate:'2026-09-15',totals:null,queries:[],pages:[]}}};}
async function mount(autoRead:boolean|undefined,options:{empty?:boolean}={}){
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-16T16:00:00Z'));setUiLanguage('en');
 const {window,document}=parseHTML('<html><body><main id="root"></main></body></html>');
 vi.stubGlobal('window',window);vi.stubGlobal('document',document);vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 Object.defineProperty(window.HTMLElement.prototype,'showModal',{configurable:true,value(){this.setAttribute('open','');}});
 vi.stubGlobal('FormData',class extends NativeFormData{constructor(form?:HTMLFormElement){super();if(form)for(const node of form.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input[name],select[name],textarea[name]')){if(!node.disabled)this.append(node.name,node.value);}}});
 const saved=source(),history={...saved,hash:'history-snapshot-hash',snapshot:{...saved.snapshot,id:'history',startDate:'2026-06-16',comparison:undefined}};
 vi.mocked(request).mockImplementation(async(path,input:any)=>{
  if(path==='gsc/sites')return options.empty?[]:[{siteUrl:saved.snapshot.property,permissionLevel:'siteOwner'}];
  if(path==='gsc/history')return options.empty?[]:[{id:'dashboard',property:saved.snapshot.property,captured_at:saved.snapshot.capturedAt,startDate:saved.snapshot.startDate,endDate:saved.snapshot.endDate,country:'CAN',hash:saved.hash,dashboard:1}];
  if(path.startsWith('gsc/items?'))return options.empty?[]:[{id:'prefs',property:saved.snapshot.property,kind:'preferences',payload:{...(autoRead===undefined?{}:{autoRead}),language:'en',metric:'impressions',pageSize:25,hideSuspicious:false}}];
  if(path.startsWith('gsc/inspections?'))return [];
  if(path==='gsc/snapshot?id=dashboard')return saved;
  if(path==='gsc/sync')return {evidence:input.filters.includeMonthly===false?history:saved,cached:true,nextRefreshAt:'2026-10-17T12:00:00Z'};
  throw new Error('Unexpected test API: '+path);
 });
 const root=createRoot(document.getElementById('root')! as unknown as HTMLElement);
 await act(async()=>root.render(<GscPanel preferredProperty={options.empty?undefined:saved.snapshot.property}/>));
 const click=async(label:string)=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent===label);expect(button,`button ${label}`).toBeDefined();await act(async()=>button!.dispatchEvent(new window.Event('click',{bubbles:true})));};
 const clickTab=async(tab:string)=>{const button=document.querySelector('[data-tab="'+tab+'"]');expect(button,`tab ${tab}`).not.toBeNull();await act(async()=>button!.dispatchEvent(new window.Event('click',{bubbles:true})));};
 const openFilters=async()=>{await act(async()=>document.querySelector('[data-action="filters"]')!.dispatchEvent(new window.Event('click',{bubbles:true})));};
 if(!options.empty){
  // A public workspace starts at ALL; this fixture deliberately studies Canada.
  await openFilters();
  const picker=document.querySelector('select[aria-label="GSC region"]')!;
  Object.defineProperty(picker,'value',{value:'CAN',configurable:true});
  await act(async()=>picker.dispatchEvent(new window.Event('change',{bubbles:true})));
  await act(async()=>document.querySelector('.gsc-dialog form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
 }
 await act(async()=>vi.advanceTimersByTimeAsync(750));
 return {root,document,window,click,clickTab,openFilters,saved,history};
}
describe('keyword health in the GSC workspace',()=>{
 it('leaves an empty public workspace without an owner property or automatic data read',async()=>{
  const {root,document,clickTab}=await mount(undefined,{empty:true});
  try{
   await clickTab('health');
   expect((document.querySelector('.gsc-site-picker select') as unknown as HTMLSelectElement).value).toBe('');
   expect(vi.mocked(request).mock.calls.some(([path])=>path==='gsc/sync'||path.startsWith('gsc/snapshot?'))).toBe(false);
   expect(document.querySelector('[data-health-source]')).toBeNull();
  }finally{await act(async()=>root.unmount());}
 });
 it('does not infer automatic-read consent from saved preferences that omit autoRead',async()=>{
  const {root,document,clickTab}=await mount(undefined);
  try{
   await clickTab('health');
   expect(document.querySelector('[data-health-source]')?.getAttribute('data-health-source')).toBe('dashboard');
   expect(vi.mocked(request).mock.calls.some(([path])=>path==='gsc/sync')).toBe(false);
  }finally{await act(async()=>root.unmount());}
 });
 it('reads a separate 120-day history automatically on entering diagnostics, preserving the dashboard period',async()=>{
  const {root,document,clickTab,openFilters,saved}=await mount(true);const before=JSON.stringify(saved);
  try{
   expect(vi.mocked(request).mock.calls.filter(([p,b]:any)=>p==='gsc/sync'&&b.filters.includeMonthly===false)).toHaveLength(0);
   await clickTab('health');
   const reads=vi.mocked(request).mock.calls.filter(([p,b]:any)=>p==='gsc/sync'&&b.filters.includeMonthly===false);
   expect(reads).toHaveLength(1);
   expect((reads[0]![1] as any).filters).toMatchObject({startDate:'2026-06-16',endDate:'2026-10-13',country:'CAN',device:'ALL',type:'web',query:'',page:'',compare:false,includeMonthly:false});
   expect(document.querySelector('[data-health-source]')?.getAttribute('data-health-source')).toBe('history');
   await openFilters();
   expect((document.querySelector('input[aria-label="GSC start date"]') as any).value).toBe('2026-09-16');
   expect(JSON.stringify(saved)).toBe(before);
  }finally{await act(async()=>root.unmount());}
 });
 it('honors paused automatic reads and still allows an explicit history read',async()=>{
  const {root,document,click,clickTab}=await mount(false);
  try{
   await clickTab('health');
   expect(vi.mocked(request).mock.calls.filter(([p])=>p==='gsc/sync')).toHaveLength(0);
   expect(document.querySelector('[data-health-source]')?.getAttribute('data-health-source')).toBe('dashboard');
   await click('Read history fixture');
   expect(vi.mocked(request).mock.calls.filter(([p])=>p==='gsc/sync')).toHaveLength(1);
   expect(document.querySelector('[data-health-source]')?.getAttribute('data-health-source')).toBe('history');
  }finally{await act(async()=>root.unmount());}
 });
 it.each(['country','connection'] as const)('ignores a history response after the %s condition changes',async(condition)=>{
  const {root,document,window,clickTab,openFilters,history}=await mount(true);
  const original=vi.mocked(request).getMockImplementation()!;
  let finish!:(value:unknown)=>void;
  const pending=new Promise(resolve=>{finish=resolve;});
  vi.mocked(request).mockImplementation((path,input:any)=>path==='gsc/sync'&&input.filters.includeMonthly===false?pending:original(path,input));
  try{
   await clickTab('health');
   if(condition==='connection')await act(async()=>root.render(<GscPanel preferredProperty={history.snapshot.property} connectionsReady={false}/>));
   else{
    await openFilters();
    const picker=document.querySelector('select[aria-label="GSC region"]')!;
    Object.defineProperty(picker,'value',{value:'USA',configurable:true});
    await act(async()=>picker.dispatchEvent(new window.Event('change',{bubbles:true})));
    await act(async()=>document.querySelector('.gsc-dialog form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
    expect(document.querySelector('[data-stale]')?.getAttribute('data-stale')).toBe('true');
   }
   await act(async()=>{finish({evidence:history,cached:true,nextRefreshAt:'2026-10-17T12:00:00Z'});});
   expect(document.querySelector('[data-health-source]')?.getAttribute('data-health-source')).toBe('dashboard');
  }finally{await act(async()=>root.unmount());}
 });
});
