import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../../desktop/chrome-collector.cjs',import.meta.url),'utf8');
function fixture(){
  let launches=0;const contexts:any[]=[],launchOptions:any[]=[],otherBrowsers:any[]=[];let release!:()=>void,launchError:Error|undefined;
  const launched=new Promise<void>(r=>{release=r;});
  const browser={closed:false,isConnected:()=>!browser.closed,version:()=> 'synthetic',close:async()=>{browser.closed=true;},newContext:async(options?:unknown)=>{
    const ctx:any={options,closed:false,storageOptions:null,grantPermissions:async()=>{},close:async()=>{ctx.closed=true;ctx.page.closed=true;},storageState:async(options:unknown)=>{ctx.storageOptions=options;return {cookies:[{name:'synthetic',value:'SYNTHETIC TOKEN'}],origins:[]};}};
    ctx.page={closed:false,destination:'',goto:async(url:string)=>{ctx.page.destination=url;},isClosed:()=>ctx.page.closed,
      fronts:0,close:async()=>{ctx.page.closed=true;},url:()=>ctx.page.destination,bringToFront:async()=>{ctx.page.fronts++;},
      snapshot:{body:'Verify you are human',controls:[],answer:'',citations:[],signedOut:true,model:'synthetic'},
      evaluate:async(_fn:unknown,args:unknown)=>args?ctx.page.snapshot:'denied'};
    ctx.newPage=async()=>ctx.page;contexts.push(ctx);return ctx;
  }};
  const module={exports:{} as any};
  runInNewContext(source,{module,require:(name:string)=>{
    if(name==='playwright-core')return {chromium:{launch:async(options:unknown)=>{launches++;launchOptions.push(options);await launched;if(launchError)throw launchError;if(launches===1)return browser;const b={...browser,closed:false,isConnected:()=>!b.closed,close:async()=>{b.closed=true;}};otherBrowsers.push(b);return b;}}};
    if(name==='node:timers/promises')return {setTimeout:async()=>{await Promise.resolve();}};
    if(name.startsWith('./'))return require('../../desktop/'+name.slice(2));
    return require(name);
  },AbortController,Buffer,URL});
  return {collector:module.exports.createChromeCollector(),contexts,browser,otherBrowsers,launchOptions,release,failLaunch:()=>{launchError=new Error('Synthetic launch failed');},launches:()=>launches};
}
const task=(surface:string)=>({planId:'synthetic-plan',slotId:'slot-'+surface,prompt:'Synthetic question for '+surface,surface,config:{accountMode:'signed_out',locale:'en-CA',timezone:'UTC'},timeoutSeconds:45,captureScreenshot:false,verifiedCountry:null,geoVerificationNote:''});
describe('Chrome parallel session isolation with a synthetic browser',()=>{
  it('runs silent lanes in one headless browser, preserves mode in evidence and never raises a window',async()=>{
    const f=fixture();f.release();const signal=new AbortController().signal;
    const results=await Promise.all(['chatgpt_search','gemini'].map(surface=>f.collector.collect({...task(surface),browserMode:'silent'},signal,()=>{})));
    expect(f.launchOptions).toHaveLength(1);expect(f.launchOptions[0]).toMatchObject({headless:true});
    expect(f.contexts.every(c=>c.page.fronts===0&&c.closed)).toBe(true);
    for(const result of results){expect(result.browser.mode).toBe('silent');expect(JSON.parse(Buffer.from(result.artifact.base64,'base64').toString()).browserMode).toBe('silent');}
    await f.collector.close();expect(f.browser.closed).toBe(true);
  });
  it('defaults missing task mode to silent and preserves explicitly dispatched visible mode',async()=>{
    const f=fixture();f.release();const signal=new AbortController().signal;
    const defaultMode=await f.collector.collect(task('gemini'),signal,()=>{});
    // BrowserJobs resolves historical frozen batches to explicit visible mode
    // before dispatch. A missing collector task mode is always background-only.
    const visible=await f.collector.collect({...task('gemini'),browserMode:'visible'},signal,()=>{});
    expect(f.launchOptions.map(options=>options.headless)).toEqual([true,false]);expect(defaultMode.browser.mode).toBe('silent');expect(visible.browser.mode).toBe('visible');await f.collector.close();
  });
  it('restores only a verified dedicated login into an isolated silent context without closing login preparation',async()=>{
    const f=fixture();f.release();const signed={...task('chatgpt_search'),config:{...task('chatgpt_search').config,accountMode:'signed_in_private'},browserMode:'silent'};
    await f.collector.prepareSession(signed);const login=f.contexts[0];
    login.page.snapshot={body:'',signedIn:true};await f.collector.verifySession(signed.planId,signed.surface);
    const result=await f.collector.collect(signed,new AbortController().signal,()=>{});
    expect(f.launchOptions.map(o=>o.headless)).toEqual([false,true]);expect(login.storageOptions).toEqual({indexedDB:true});
    expect(f.contexts[1].options.storageState.cookies[0].value).toBe('SYNTHETIC TOKEN');expect(f.contexts[1].closed).toBe(true);expect(login.closed).toBe(false);
    expect(f.collector.ready(signed.planId,[signed.surface])).toBe(true);expect(JSON.stringify(result)).not.toContain('SYNTHETIC TOKEN');
    await f.collector.close();expect(f.browser.closed).toBe(true);expect(f.otherBrowsers.every(b=>b.closed)).toBe(true);
  });
  it('rejects silent signed-in sampling before launching when login is unverified',async()=>{
    const f=fixture();f.release();const signed={...task('chatgpt_search'),config:{...task('chatgpt_search').config,accountMode:'signed_in_private'},browserMode:'silent'};
    await expect(f.collector.collect(signed,new AbortController().signal,()=>{})).rejects.toThrow(/重新登录/);expect(f.launchOptions).toHaveLength(0);expect(f.contexts).toHaveLength(0);await f.collector.close();
  });
  it('stops before submitting when restored login is missing, with no automatic visible fallback',async()=>{
    const f=fixture();f.release();const signed={...task('chatgpt_search'),config:{...task('chatgpt_search').config,accountMode:'signed_in_private'},browserMode:'silent'};
    await f.collector.prepareSession(signed);f.contexts[0].page.snapshot={body:'',signedIn:true};await f.collector.verifySession(signed.planId,signed.surface);
    let submitted=0;const create=f.browser.newContext;
    f.browser.newContext=async options=>{const ctx=await create(options);ctx.page.snapshot={body:'',signedIn:false,signedOut:true,controls:[],answer:'',citations:[],model:'synthetic'};ctx.page.locator=()=>({all:async()=>[{isVisible:async()=>true,fill:async()=>{submitted++;},press:async()=>{submitted++;}}]});return ctx;};
    const result=await f.collector.collect(signed,new AbortController().signal,()=>{});
    expect(result).toMatchObject({status:'unavailable',restriction:'login',browser:{mode:'silent'}});expect(submitted).toBe(0);expect(f.launchOptions.map(o=>o.headless)).toEqual([false,true]);expect(f.contexts[1].closed).toBe(true);expect(f.contexts[0].closed).toBe(false);await f.collector.close();
  });
  it('retains a headless launch failure without switching to visible sampling',async()=>{
    const f=fixture();f.failLaunch();f.release();
    await expect(f.collector.collect({...task('gemini'),browserMode:'silent'},new AbortController().signal,()=>{})).rejects.toThrow(/launch failed/);
    expect(f.launchOptions).toHaveLength(1);expect(f.launchOptions[0].headless).toBe(true);expect(f.contexts).toHaveLength(0);await f.collector.close();
  });
  it('does not open an interactive window when show is requested during silent sampling',async()=>{
    const f=fixture();f.release();let started!:()=>void,release!:()=>void;const opening=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
    const create=f.browser.newContext;f.browser.newContext=async options=>{const ctx=await create(options);const goto=ctx.page.goto;ctx.page.goto=async(url:string)=>{started();await gate;await goto(url);};return ctx;};
    const pending=f.collector.collect({...task('gemini'),browserMode:'silent'},new AbortController().signal,()=>{});await opening;
    await expect(f.collector.show()).rejects.toThrow(/静默采样/);expect(f.contexts[0].page.fronts).toBe(0);release();await pending;await f.collector.close();
  });
  it('shares one pending launch and captures provider-specific pages and artifacts',async()=>{
    const f=fixture(),signal=new AbortController().signal;
    const first=f.collector.collect(task('chatgpt_search'),signal,()=>{});
    const second=f.collector.collect(task('gemini'),signal,()=>{});
    expect(f.launches()).toBe(1);f.release();const results=await Promise.all([first,second]);
    expect(f.contexts).toHaveLength(2);expect(new Set(f.contexts.map(c=>c.page)).size).toBe(2);
    expect(results.map(r=>r.sourceUrl)).toEqual(['https://chatgpt.com','https://gemini.google.com']);
    for(const [i,surface] of ['chatgpt_search','gemini'].entries()){
      expect(results[i].slotId).toBe('slot-'+surface);
      const raw=JSON.parse(Buffer.from(results[i].artifact.base64,'base64').toString());
      expect(raw.surface).toBe(surface);expect(raw.question).toBe('Synthetic question for '+surface);
    }
    expect(f.contexts.every(c=>c.closed)).toBe(true);await f.collector.close();
  });
  it('rejects overlap within one provider and releases its guard after completion',async()=>{
    const f=fixture(),signal=new AbortController().signal;
    const first=f.collector.collect(task('gemini'),signal,()=>{});
    await expect(f.collector.collect(task('gemini'),signal,()=>{})).rejects.toThrow(/同一入口/);
    f.release();await first;await f.collector.collect(task('gemini'),signal,()=>{});
    expect(f.launches()).toBe(1);expect(f.contexts).toHaveLength(2);await f.collector.close();
  });
  it('cleans up failed setup without closing another provider context',async()=>{
    const f=fixture(),signal=new AbortController().signal;f.release();
    const create=f.browser.newContext;let created=0;
    f.browser.newContext=async()=>{const ctx=await create();if(++created===1)ctx.newPage=async()=>{throw new Error('Synthetic page creation failure');};return ctx;};
    const results=await Promise.allSettled(['chatgpt_search','gemini'].map(s=>f.collector.collect(task(s),signal,()=>{})));
    expect(results[0].status).toBe('rejected');expect(results[1].status).toBe('fulfilled');expect(f.contexts.every(c=>c.closed)).toBe(true);
    await f.collector.collect(task('chatgpt_search'),signal,()=>{});expect(f.contexts).toHaveLength(3);await f.collector.close();
  });
  it('honors a stop requested during launch before creating any page',async()=>{
    const f=fixture(),controller=new AbortController();
    const pending=f.collector.collect(task('gemini'),controller.signal,()=>{});controller.abort();f.release();
    await expect(pending).rejects.toThrow(/已停止/);expect(f.contexts).toHaveLength(0);
    await f.collector.collect(task('gemini'),new AbortController().signal,()=>{});expect(f.contexts).toHaveLength(1);await f.collector.close();
  });
});
