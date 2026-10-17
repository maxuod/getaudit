import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
const require=createRequire(import.meta.url);
const {extractVisiblePage}=require('../../desktop/browser-extract.cjs');
const {surfaceUrls,inputSelector,officialSurfaceUrl,duckduckgoAssistControl}=require('../../desktop/browser-platforms.cjs');
const collectorSource=readFileSync(new URL('../../desktop/chrome-collector.cjs',import.meta.url),'utf8');
const surface='duckduckgo_search_assist';
const query='How does a heat pump work? Cite the sources used.';
const answer='A heat pump moves thermal energy between indoor and outdoor spaces using a refrigerant cycle.';
const organic='<article data-testid="result"><h2><a href="https://organic.example/heat">Organic search result</a></h2><p>An ordinary search snippet.</p></article>';
const input='<input name="q">';

// All DOM below is synthetic. These are parser and lifecycle regression tests,
// not evidence that a particular live provider currently returns this markup.
function documentFor(html:string,base='https://duckduckgo.com/'){
  const {document,window}=parseHTML(`<html><head><base href="${base}"></head><body>${html}</body></html>`);
  window.HTMLElement.prototype.getBoundingClientRect=()=>({width:100,height:20} as DOMRect);
  window.getComputedStyle=(el:Element)=>({display:el.getAttribute('style')?.includes('display:none')?'none':'block',visibility:'visible'} as CSSStyleDeclaration);
  return document;
}
function extract(html:string,platform=surface,base='https://duckduckgo.com/'){
  return extractVisiblePage({document:documentFor(html,base),surface:platform,question:query});
}
function assist(options:{more?:boolean;busy?:boolean;sources?:string;content?:string}={}){
  return `<section data-testid="search-assist"${options.busy?' aria-busy="true"':''}><h2>Search Assist</h2><div data-testid="search-assist-answer"><p>${options.content??answer}</p><span hidden>Hidden text must not enter the answer.</span></div>${options.more?'<button aria-expanded="false">More</button>':''}<footer data-testid="search-assist-sources">${options.sources??'<a href="https://energy.example/heat-pumps?utm_source=duckduckgo#intro">Energy guide</a><a href="https://research.example/heat">Research source</a>'}</footer></section>`;
}
function task(platform=surface,accountMode='signed_out'){
  return {planId:'synthetic-guest-plan',slotId:'synthetic-'+platform,surface:platform,prompt:query,timeoutSeconds:50,captureScreenshot:false,browserMode:'silent',verifiedCountry:null,
    config:{accountMode,locale:'en-CA',timezone:'UTC'}};
}
function fixture(options:{platform?:string;noAssist?:boolean;empty?:boolean;restriction?:string;more?:boolean;conflictBefore?:boolean;conflictAfter?:boolean;unknownAfter?:boolean;noSources?:boolean;sourceMore?:boolean;destination?:string}={}){
  const platform=options.platform??surface;
  let submitted=0,expanded=false,storageReads=0,closed=0,contextCount=0,clock=Date.now();
  const contextOptions:any[]=[],raws:any[]=[];
  class FixtureDate extends Date{constructor(value?:number|string){super(value??clock);}static now(){return clock;}}
  const empty={all:async()=>[],or(){return this;},filter(){return this;},last(){return this;}};
  const guest=platform===surface?input:'<button>Sign in</button>';
  const profile='<button aria-label="Open profile menu">Account</button>';
  let page:any;
  const html=()=>{
    if(options.restriction)return guest+'<p>'+options.restriction+'</p>';
    if(!submitted)return guest+(options.conflictBefore?profile:'');
    const state=options.unknownAfter?'':guest+(options.conflictAfter?profile:'');
    if(options.empty)return state;
    if(options.noAssist)return state+organic;
    if(platform!==surface)return state+'<article data-testid="assistant-message"><div class="prose"><p>'+answer+'</p></div><button aria-label="Copy response">Copy</button></article>';
    return state+assist({more:options.more&&!expanded,sources:options.noSources?'':options.sourceMore?'<a href="https://energy.example">Energy</a><button>Load more</button>':undefined})+organic;
  };
  const inputControl={isVisible:async()=>true,isEnabled:async()=>true,isEditable:async()=>true,fill:async(value:string)=>{expect(value).toBe(query);},press:async(key:string)=>{expect(key).toBe('Enter');submitted++;}};
  const moreControl={isVisible:async()=>true,isEnabled:async()=>true,evaluate:async(fn:(el:Element)=>boolean)=>fn(documentFor(html()).querySelector('section button')!),click:async()=>{expanded=true;}};
  const browser={isConnected:()=>true,version:()=> 'synthetic-ddg-fixture',close:async()=>{},newContext:async(opts:any)=>{
    contextCount++;contextOptions.push(opts);
    page={destination:'',closed:false,goto:async(url:string)=>{page.destination=options.destination??url;},url:()=>page.destination,isClosed:()=>page.closed,close:async()=>{page.closed=true;},
      locator:(selector:string)=>selector===inputSelector(platform)?{all:async()=>[inputControl]}:empty,
      getByRole:(_role:string,{name}:{name:RegExp})=>options.more&&!expanded&&submitted&&name.test('More')?{all:async()=>[moreControl]}:empty,
      evaluate:async(fn:unknown,args:any)=>args?.surface?extract(html(),platform,page.destination):String(fn).includes('readyState')?{readyState:'complete',bodyChars:html().length}:'denied'};
    return {newPage:async()=>page,grantPermissions:async()=>{},storageState:async()=>{storageReads++;throw new Error('Strict guests must never read prepared storage.');},close:async()=>{closed++;page.closed=true;}};
  }};
  const module={exports:{} as any};
  runInNewContext(collectorSource,{module,require:(name:string)=>{
    if(name==='playwright-core')return {chromium:{launch:async()=>browser}};
    if(name==='node:timers/promises')return {setTimeout:async(ms:number)=>{clock+=ms;}};
    if(name==='./capture-artifact.cjs')return {captureArtifact:async(_page:unknown,raw:any)=>{raws.push(raw);return {mime:'text/plain',base64:Buffer.from('synthetic fixture artifact').toString('base64')};}};
    if(name.startsWith('./'))return require('../../desktop/'+name.slice(2));
    return require(name);
  },AbortController,Buffer,URL,Date:FixtureDate});
  return {collector:module.exports.createChromeCollector(),raws,contextOptions,counts:()=>({submitted,expanded,storageReads,closed,contextCount})};
}

describe('DuckDuckGo Search Assist — synthetic extraction boundaries',()=>{
  it('recognizes only the accountless official search surface and the native search input',()=>{
    expect(surfaceUrls[surface]).toBe('https://duckduckgo.com/');
    expect(inputSelector(surface)).toBe('textarea[name="q"],input[name="q"]');
    expect(extract(input)).toMatchObject({signedOut:true,signedIn:false});
    for(const base of ['http://duckduckgo.com/','https://duckduckgo.com.evil.example/','https://person:secret@duckduckgo.com/','https://duckduckgo.com:8443/']){
      expect(extract(input,surface,base).signedOut).toBe(false);expect(officialSurfaceUrl(surface,base)).toBe(false);
    }
    expect(extract('<p>Public text without a native search form.</p>').signedOut).toBe(false);
  });
  it('keeps the full current answer separate from organic results and source-card text',()=>{
    const result=extract(input+assist()+organic+'<aside><h2>Sources</h2><a href="https://unrelated.example">Unrelated sources panel</a></aside>');
    expect(result).toMatchObject({triggered:true,responseComplete:true,sourcePanel:true,sourceCountExpected:2,hasSearchResults:true});
    expect(result.answer).toBe(answer);
    expect(result.citations).toEqual([{url:'https://energy.example/heat-pumps',title:'Energy guide',placement:'source_panel'},{url:'https://research.example/heat',title:'Research source',placement:'source_panel'}]);
  });
  it('does not treat an organic result about Search Assist or arbitrary prose as an answer',()=>{
    for(const html of [organic,organic.replace('Organic search result','Search Assist'),'<main><h2>Search Assist</h2><p>'+answer+'</p>'+organic+'</main>','<main><div class="prose">'+answer+'</div></main>']){
      expect(extract(input+html)).toMatchObject({triggered:false,containerFound:false,responseComplete:false,answer:'',citations:[]});
    }
  });
  it('requires expansion, no generation and an identifiable current source region',()=>{
    expect(extract(input+assist({more:true}))).toMatchObject({triggered:true,duckduckgoHasMore:true,responseComplete:false});
    expect(extract(input+assist({busy:true}))).toMatchObject({generating:true,responseComplete:false});
    expect(extract(input+assist({sources:''}))).toMatchObject({responseComplete:false,citations:[]});
    expect(extract(input+assist({sources:'<a href="https://energy.example">Energy</a><button>Load more</button>'}))).toMatchObject({sourcePanelHasMore:true});
  });
  it('decodes visible DuckDuckGo destination links without following them and preserves unresolved redirects',()=>{
    const resolved='https://duckduckgo.com/l/?uddg='+encodeURIComponent('https://energy.example/énergie?utm_campaign=test');
    const result=extract(input+assist({sources:'<a href="'+resolved+'">Source</a><a href="https://duckduckgo.com/l/?opaque=1">Unknown destination</a>'}));
    expect(result.citations.map((c:any)=>c.url)).toEqual(['https://energy.example/%C3%A9nergie']);
    expect(result.unresolvedCitations).toBe(1);
  });
  it('allows expansion only within the feature, never organic snippets or generic More buttons',()=>{
    const doc=documentFor(assist({more:true})+organic.replace('</article>','<button>More</button></article>')+'<button id="outside">More</button>');
    expect(duckduckgoAssistControl(doc.querySelector('section button'))).toBe(true);
    expect(duckduckgoAssistControl(doc.querySelector('article button'))).toBe(false);
    expect(duckduckgoAssistControl(doc.querySelector('#outside'))).toBe(false);
  });
});

describe('strict guest browser lifecycle — synthetic browser, no network',()=>{
  it('expands Search Assist once and qualifies only its complete bounded citations',async()=>{
    const f=fixture({more:true});
    const result=await f.collector.collect(task(),new AbortController().signal,()=>{});
    expect(result).toMatchObject({status:'observed',account:'logged_out',searchMode:'explicit_search',session:'fresh',browser:{answerComplete:true,citationsComplete:true}});
    expect(result.answer).toBe(answer);expect(result.citations).toHaveLength(2);
    expect(f.counts()).toEqual({submitted:1,expanded:true,storageReads:0,closed:1,contextCount:1});
    expect(f.contextOptions[0]).not.toHaveProperty('storageState');
  });
  it('records not_triggered only when ordinary search results actually completed',async()=>{
    const f=fixture({noAssist:true});
    const result=await f.collector.collect(task(),new AbortController().signal,()=>{});
    expect(result).toMatchObject({status:'not_triggered',answer:'',citations:[],restriction:'none'});
    const missing=fixture({empty:true});
    expect((await missing.collector.collect(task(),new AbortController().signal,()=>{})).status).toBe('error');
  });
  it('never converts a restriction into not_triggered or submits through it',async()=>{
    for(const [message,restriction] of [['Verify you are human','captcha'],['Too many requests','rate_limit'],['Not available in your region','region']]){
      const f=fixture({restriction:message});
      expect(await f.collector.collect(task(),new AbortController().signal,()=>{})).toMatchObject({status:'unavailable',restriction});
      expect(f.counts().submitted).toBe(0);
    }
  });
  it('rejects account uncertainty before submission and when it appears after submission',async()=>{
    for(const options of [{conflictBefore:true},{conflictAfter:true},{unknownAfter:true}]){
      const f=fixture({platform:'perplexity',...options});
      const result=await f.collector.collect(task('perplexity'),new AbortController().signal,()=>{});
      expect(result.status).toBe('error');expect(result.answer).toBe('');expect(result.browser.citationsComplete).toBe(false);
      expect(f.counts().submitted).toBe(options.conflictBefore?0:1);
    }
  });
  it('keeps incomplete citation coverage excluded without calling organic links sources',async()=>{
    const f=fixture({sourceMore:true});
    const result=await f.collector.collect(task(),new AbortController().signal,()=>{});
    expect(result).toMatchObject({status:'observed',browser:{answerComplete:true,citationsComplete:false}});
    expect(result.citations.every((c:any)=>!c.url.includes('organic.example'))).toBe(true);
  });
  it('entry checks submit nothing, use only fresh guest contexts and report answer/citation validation separately',async()=>{
    const f=fixture();
    expect(await f.collector.inspectGuest(task(),new AbortController().signal)).toMatchObject({status:'ready',restriction:'none',account:'logged_out',sourceUrl:'https://duckduckgo.com',answer:'not_tested',citations:'not_tested'});
    expect(f.counts()).toEqual({submitted:0,expanded:false,storageReads:0,closed:1,contextCount:1});
    const blocked=fixture({restriction:'Verify you are human'});
    expect(await blocked.collector.inspectGuest(task(),new AbortController().signal)).toMatchObject({status:'restricted',restriction:'captcha',answer:'not_tested',citations:'not_tested'});
  });
  it('guest inspection refuses unsupported origins and never opens a login preparation for guest-only plans',async()=>{
    const f=fixture({destination:'https://duckduckgo.com.evil.example/'});
    expect(await f.collector.inspectGuest(task(),new AbortController().signal)).toMatchObject({status:'unknown',account:'unknown'});
    await expect(f.collector.prepareSession(task())).rejects.toThrow('Strict guest');
    await expect(f.collector.prepareSession(task(surface,'isolated'))).rejects.toThrow('strict guest');
    await expect(f.collector.collect(task(surface,'isolated'),new AbortController().signal,()=>{})).rejects.toThrow('strict guest');
  });
});

describe('native account-state evidence — synthetic adversarial content',()=>{
  const wrappers=[['chatgpt_search','<article data-message-author-role="assistant">','</article>'],['gemini','<model-response>','</model-response>'],['google_aio','<div id="search">','</div>'],['perplexity','<div class="group/partition">','</div>'],['grok','<article aria-label="Grok">','</article>'],['bing_copilot','<div data-content="ai-message">','</div>']];
  it.each(wrappers)('%s ignores login/profile lookalikes in an answer or citation panel',(platform,open,close)=>{
    const fake='<button>Sign in</button><button aria-label="Open profile menu">Account</button><button aria-label="Google Account: Example">Google</button>';
    expect(extract(open+fake+close,platform)).toMatchObject({signedOut:false,signedIn:false,accountConflict:false});
    expect(extract('<aside><h2>Sources</h2>'+fake+'</aside>',platform)).toMatchObject({signedOut:false,signedIn:false});
  });
  it('retains contradictory native account controls as an explicit conflict, not proof of guest access',()=>{
    expect(extract('<header><button>Sign in</button><button aria-label="Open profile menu">Account</button></header>','perplexity')).toMatchObject({signedOut:true,signedIn:false,accountConflict:true});
  });
});
