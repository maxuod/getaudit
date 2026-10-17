import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { execFileSync, spawnSync } from 'node:child_process';

const require=createRequire(import.meta.url);
const collectorSource=readFileSync(new URL('../../desktop/chrome-collector.cjs',import.meta.url),'utf8');
const root=fileURLToPath(new URL('../../',import.meta.url));
const runner=join(root,'scripts/verify-guest-platforms.mjs');
const question='Synthetic background collection question.';

// Synthetic browser and clock: no real Chrome, provider request or paid service.
function fixture(options:{restriction?:string;launchFailure?:boolean}={}){
  const launches:any[]=[],contexts:any[]=[],raws:any[]=[];
  let submitted=0,broughtToFront=0,closed=0,clock=Date.now();
  class FixtureDate extends Date{constructor(value?:number|string){super(value??clock);}static now(){return clock;}}
  const empty={all:async()=>[],or(){return this;},filter(){return this;},last(){return this;}};
  const input={isVisible:async()=>true,isEnabled:async()=>true,isEditable:async()=>true,fill:async(value:string)=>{expect(value).toBe(question);},press:async()=>{submitted++;}};
  const snapshot=()=>({body:options.restriction??'Synthetic public page',controls:[],signedOut:true,signedIn:false,accountConflict:false,
    containerFound:submitted>0,triggered:submitted>0,responseComplete:submitted>0,generating:false,sourcePanel:submitted>0,sourceCountExpected:1,
    answer:submitted?'A synthetic complete answer used solely to verify background collection and evidence metadata.':'',
    citations:submitted?[{url:'https://source.example/guide',title:'Synthetic source',placement:'source_panel'}]:[],unresolvedCitations:0,citationOverflow:0,
    locale:'en-CA',timezone:'UTC',model:null});
  const browser={isConnected:()=>true,version:()=> 'synthetic-background-browser',close:async()=>{},newContext:async(config:any)=>{
    contexts.push(config);
    const page={destination:'https://duckduckgo.com/',closed:false,goto:async(url:string)=>{page.destination=url;},url:()=>page.destination,isClosed:()=>page.closed,
      bringToFront:async()=>{broughtToFront++;},close:async()=>{page.closed=true;},getByRole:()=>empty,
      locator:()=>({all:async()=>[input]}),evaluate:async(fn:unknown,args:any)=>args?.surface?snapshot():String(fn).includes('readyState')?{readyState:'complete',bodyChars:100}:'denied'};
    return {newPage:async()=>page,grantPermissions:async()=>{},close:async()=>{closed++;page.closed=true;},storageState:async()=>{throw new Error('Guest context must not read account storage.');}};
  }};
  const module={exports:{} as any};
  runInNewContext(collectorSource,{module,require:(name:string)=>{
    if(name==='playwright-core')return {chromium:{launch:async(config:any)=>{launches.push(config);if(options.launchFailure)throw new Error('Synthetic headless launch blocked');return browser;}}};
    if(name==='node:timers/promises')return {setTimeout:async(ms:number)=>{clock+=ms;}};
    if(name==='./capture-artifact.cjs')return {captureArtifact:async(_page:unknown,raw:any)=>{raws.push(raw);return {mime:'text/plain',base64:Buffer.from(JSON.stringify(raw)).toString('base64')};}};
    if(name.startsWith('./'))return require('../../desktop/'+name.slice(2));
    return require(name);
  },AbortController,Buffer,URL,Date:FixtureDate});
  return {collector:module.exports.createChromeCollector(),launches,contexts,raws,counts:()=>({submitted,broughtToFront,closed})};
}

const task=(mode?:'silent'|'visible')=>({planId:'synthetic-background-plan',slotId:'synthetic-slot',surface:'duckduckgo_search_assist',prompt:question,
  timeoutSeconds:60,captureScreenshot:false,verifiedCountry:null,...(mode?{browserMode:mode}:{}),config:{accountMode:'signed_out',locale:'en-CA',timezone:'UTC'}});

describe('background collection defaults and evidence — synthetic browser',()=>{
  it('defaults sampling to headless and records actual silent mode in capture and artifact',async()=>{
    const f=fixture();
    const capture=await f.collector.collect(task(),new AbortController().signal,()=>{});
    expect(capture).toMatchObject({status:'observed',browser:{mode:'silent',answerComplete:true,citationsComplete:true,extractorVersion:'visible-dom-v16'}});
    expect(f.launches).toHaveLength(1);expect(f.launches[0].headless).toBe(true);
    expect(f.raws[0].browserMode).toBe('silent');expect(f.contexts[0]).not.toHaveProperty('storageState');
    expect(f.counts()).toEqual({submitted:1,broughtToFront:0,closed:1});
  });
  it('defaults entry inspection to headless without submitting and reports actual browser mode',async()=>{
    const f=fixture();
    expect(await f.collector.inspectGuest(task(),new AbortController().signal)).toMatchObject({status:'ready',browserMode:'silent',answer:'not_tested',citations:'not_tested'});
    expect(f.launches[0].headless).toBe(true);expect(f.counts()).toEqual({submitted:0,broughtToFront:0,closed:1});
  });
  it.each(['Verify you are human','Too many requests','Not available in your region'])('stops at %s without a visible fallback or submission',async restriction=>{
    const f=fixture({restriction});
    const capture=await f.collector.collect(task(),new AbortController().signal,()=>{});
    expect(capture).toMatchObject({status:'unavailable',browser:{mode:'silent'}});
    expect(f.launches.map(value=>value.headless)).toEqual([true]);expect(f.counts().submitted).toBe(0);expect(f.counts().broughtToFront).toBe(0);
  });
  it('does not retry a failed headless launch as a visible browser',async()=>{
    const f=fixture({launchFailure:true});
    await expect(f.collector.collect(task(),new AbortController().signal,()=>{})).rejects.toThrow('headless launch blocked');
    expect(f.launches.map(value=>value.headless)).toEqual([true]);expect(f.counts().submitted).toBe(0);
  });
  it('keeps explicit visible troubleshooting distinct in both entry observations and capture evidence',async()=>{
    const f=fixture();
    expect(await f.collector.inspectGuest(task('visible'),new AbortController().signal)).toMatchObject({browserMode:'visible',status:'ready'});
    const capture=await f.collector.collect(task('visible'),new AbortController().signal,()=>{});
    expect(capture.browser.mode).toBe('visible');expect(f.raws[0].browserMode).toBe('visible');
    expect(f.launches.map(value=>value.headless)).toEqual([false]);
  });
  it('never treats an invalid mode as permission to open a visible browser',async()=>{
    const f=fixture();const invalid={...task(),browserMode:'stealth'};
    await expect(f.collector.collect(invalid,new AbortController().signal,()=>{})).rejects.toThrow('Unsupported browser mode');
    await expect(f.collector.inspectGuest(invalid,new AbortController().signal)).rejects.toThrow('Unsupported browser mode');
    expect(f.launches).toHaveLength(0);
  });
});

describe('source-frozen guest runner browser cohort — plan only, no network',()=>{
  it('defaults to silent and freezes an explicit visible run into a different cohort',()=>{
    const directory=mkdtempSync(join(tmpdir(),'getgeo-background-runner-test-'));
    try{
      const manifests=[];
      for(const mode of [undefined,'visible']){
        const output=join(directory,mode??'default');
        execFileSync(process.execPath,['--experimental-strip-types','--no-warnings',runner,'--output-dir',output,'--surface','duckduckgo_search_assist','--plan-only',...(mode?['--browser-mode',mode]:[])],{cwd:root,encoding:'utf8'});
        manifests.push(JSON.parse(readFileSync(join(output,'manifest.json'),'utf8')));
      }
      expect(manifests[0].execution).toMatchObject({browserMode:'silent',automaticVisibleFallback:false,automaticRetries:false,automaticReplay:false});
      expect(manifests[1].execution.browserMode).toBe('visible');
      expect(manifests.map(value=>value.cohort.label)).toEqual(['strict-guest-silent','strict-guest-visible']);
      expect(manifests[0].cohortHash).not.toBe(manifests[1].cohortHash);
      expect(manifests[0].implementationHash).toBe(manifests[1].implementationHash);
      expect(manifests[0].frozenHash).toBe(manifests[1].frozenHash);
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  it('rejects unsupported or repeated browser mode flags before creating an evidence directory',()=>{
    for(const args of [['--browser-mode','stealth'],['--browser-mode','silent','--browser-mode','visible']]){
      const result=spawnSync(process.execPath,['--experimental-strip-types','--no-warnings',runner,...args,'--plan-only'],{cwd:root,encoding:'utf8'});
      expect(result.status).toBe(1);expect(result.stderr).toMatch(/--browser-mode/);expect(result.stdout).toBe('');
    }
  });
});
