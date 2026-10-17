import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
const require = createRequire(import.meta.url);
const { extractVisiblePage } = require('../../desktop/browser-extract.cjs');
const { collectNewSurfaceSources, inputSelector, freshEntryUrl, affirmCopilotAccount, dismissPerplexityOverlays } = require('../../desktop/browser-platforms.cjs');
const collectorSource = readFileSync(new URL('../../desktop/chrome-collector.cjs', import.meta.url), 'utf8');
const surfaces = ['bing_copilot', 'perplexity', 'grok'];
const question = 'Which scheduling tools suit a Canadian restaurant?\nCompare C++ & C# literally; do not alter this question.';

// Synthetic visible DOM fixtures test parser boundaries; they are not live provider samples.
function extract(html: string, surface: string, base = 'https://grok.com/', expectedQuestion?: string) {
  const { document, window } = parseHTML(`<html><head><base href="${base}"></head><body>${html}</body></html>`);
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 } as DOMRect);
  window.getComputedStyle = (el: Element) => ({ display: el.getAttribute('style')?.includes('display:none') ? 'none' : 'block', visibility: 'visible' } as CSSStyleDeclaration);
  return extractVisiblePage({ document, surface, question: expectedQuestion });
}
function turn(surface: string, answer = 'A completed answer discussing restaurant scheduling and staffing.', streaming = false) {
  const selector = surface === 'bing_copilot' ? 'data-content="ai-message"' : 'data-testid="assistant-message"';
  const css = surface === 'grok' ? 'response-content-markdown' : surface === 'perplexity' ? 'prose' : 'markdown';
  return `<article ${selector}><div class="${css}"><p>${answer}</p><a href="https://guide.example/shifts?utm_source=ai#section">Guide</a><div hidden>Hidden private text</div></div>${streaming ? '<button aria-label="Stop generating">Stop</button>' : '<button aria-label="Copy response">Copy</button>'}</article>`;
}
function sourcesPanel(count = 1, extra = '') {
  return `<aside data-testid="sources-panel"><h2>Sources ${count}</h2><a href="https://guide.example/shifts">Complete cited guide</a>${extra}</aside>`;
}
function task(surface: string) {
  return { planId: 'synthetic-plan', slotId: 'synthetic-' + surface, surface, prompt: question,
    config: { accountMode: 'signed_out', locale: 'en-CA', timezone: 'UTC' },
    timeoutSeconds: 45, captureScreenshot: false, browserMode: 'silent', verifiedCountry: null };
}
function collectorFixture(surface: string, options: { initial?: string; noSources?: boolean; failure?: boolean; destination?: string; loggedIn?: boolean; nativeSubmit?: boolean; inputDelayReads?: number; neverInput?: boolean } = {}) {
  let launches = 0, polls = 0, submitted = 0, rawPrompt = '', sourceOpened = false;
  let preparationReads=0;
  const pages: any[] = [], contexts: any[] = [], requests: string[] = [];
  const empty = { all: async () => [], or() { return this; }, filter() { return this; }, last() { return this; } };
  const browser: any = { isConnected: () => true, version: () => 'synthetic-provider-fixture', close: async () => {},
    newContext: async (contextOptions: any) => {
      const input = { isVisible: async () => true, fill: async (value: string) => { rawPrompt = value; },
        press: async (key: string) => { expect(key).toBe('Enter'); submitted++; } };
      const sourceControl = { isVisible: async () => true, getAttribute: async () => null,
        click: async () => { if (options.failure) throw new Error('Synthetic control failure'); sourceOpened = true; } };
      const submitControl = { isVisible: async () => true, isEnabled: async () => true, click: async () => { submitted++; } };
      const account = options.loggedIn ? surface==='bing_copilot'?'<button id="me-control-sign-out-button">Sign out</button>':'<button aria-label="Open profile menu">Profile</button>' : '<button>Sign in</button>';
      const page: any = { closed: false, destination: '', goto: async (url: string) => { requests.push(url); page.destination = options.destination || url; },
        bringToFront: async () => {},
        url: () => page.destination, isClosed: () => page.closed, close: async () => { page.closed = true; },
        locator: (selector: string) => selector === inputSelector(surface) ? { all: async () => options.neverInput||preparationReads<(options.inputDelayReads||0)?[]:[input] } : empty,
        getByRole: (_role: string, config: { name: RegExp }) => {
          if(options.neverInput&&config.name.test('Sign in'))return { all: async () => [{isVisible:async()=>true}],or(){return this;} };
          if (options.nativeSubmit && config.name.test('Submit')) return { all: async () => [submitControl] };
          if (!options.noSources && config.name.test('Sources')) return { all: async () => [sourceControl] };
          return empty;
        },
        evaluate: async (_fn: unknown, args: unknown) => {
          if (!args) return 'denied';
          if (!submitted) { preparationReads++;return extract(options.initial ?? account, surface, page.destination); }
          polls++;
          return extract(account + turn(surface, undefined, polls <= 2) + (sourceOpened ? sourcesPanel() : ''), surface, page.destination);
        } };
      const ctx: any = { options: contextOptions, closed: false, grantPermissions: async () => {},
        storageState: async () => ({ cookies: [{ name: 'dedicated-login', value: 'SYNTHETIC DEDICATED TOKEN' }], origins: [] }),
        newPage: async () => page, close: async () => { ctx.closed = true; page.closed = true; } };
      pages.push(page); contexts.push(ctx); return ctx;
    } };
  const module = { exports: {} as any };
  runInNewContext(collectorSource, { module, require: (name: string) => {
    if (name === 'playwright-core') return { chromium: { launch: async () => { launches++; return browser; } } };
    if (name === 'node:timers/promises') return { setTimeout: async () => {} };
    if (name.startsWith('./')) return require('../../desktop/' + name.slice(2));
    return require(name);
  }, AbortController, Buffer, URL });
  return { collector: module.exports.createChromeCollector(), pages, contexts, requests,
    counts: () => ({ launches, polls, submitted, rawPrompt, sourceOpened }) };
}

function consumerLoginMenuFixture(options: {
  url?: string; triggerHtml?: string; menuHtml?: string; manuallyOpened?: boolean;
  failRead?: boolean; failClick?: boolean; navigateOnClick?: string; navigateOnRead?: string;
} = {}) {
  let url=options.url??'https://copilot.microsoft.com/',opened=!!options.manuallyOpened,clicks=0,escapes=0,reads=0;
  const trigger=options.triggerHtml??'<button aria-label="Settings and more"></button>';
  const menu=options.menuHtml??'<div role="menu"><button role="menuitem" aria-label="Sign out">Sign out</button></div>';
  const page:any={
    url:()=>url,
    getByRole:(role:string,{name}:{name:RegExp})=>({all:async()=>{
      expect(role).toBe('button');
      const {document}=parseHTML(`<html><body>${trigger}</body></html>`);
      return [...document.querySelectorAll('button,[role="button"]')]
        .filter(el=>name.test(el.getAttribute('aria-label')||el.textContent||''))
        .map(el=>({
          isVisible:async()=>!el.hidden&&!el.closest('[hidden],[aria-hidden="true"]')&&!(el.getAttribute('style')||'').includes('display:none'),
          isEnabled:async()=>!el.hasAttribute('disabled')&&el.getAttribute('aria-disabled')!=='true',
          evaluate:async(fn:(el:Element,selector:string)=>unknown,selector:string)=>fn(el,selector),
          click:async()=>{clicks++;opened=true;if(options.navigateOnClick)url=options.navigateOnClick;if(options.failClick)throw new Error('Synthetic settings click timed out.');},
        }));
    }}),
    keyboard:{press:async(key:string)=>{expect(key).toBe('Escape');escapes++;opened=false;}},
  };
  const read=async()=>{
    reads++;
    if(opened&&options.failRead)throw new Error('Synthetic menu read failed.');
    const snapshot=extract(trigger+(opened?menu:''),'bing_copilot',url);
    if(opened&&options.navigateOnRead)url=options.navigateOnRead;
    return snapshot;
  };
  return {page,read,counts:()=>({clicks,escapes,reads,opened})};
}

describe('new consumer platform visible extraction — synthetic fixtures', () => {
  for (const surface of surfaces) {
    it(`${surface}: isolates the completed latest assistant answer from questions and sources`, () => {
      const s = extract('<button>Sign in</button><nav><a href="https://navigation.example">Menu</a></nav><div data-message-author-role="user">Private user question</div>' + turn(surface, 'Old response') + turn(surface) + sourcesPanel(), surface);
      expect(s).toMatchObject({ signedOut: true, signedIn: false, responseComplete: true, sourcePanel: true, sourceCountExpected: 1 });
      expect(s.answer).toContain('A completed answer');
      expect(s.answer).not.toMatch(/Old response|Private user|Hidden private|Complete cited guide/);
      expect(s.citations.map((c: any) => c.url)).toEqual(['https://guide.example/shifts']);
    });
    it(`${surface}: does not call a streaming or copyable-table response complete`, () => {
      expect(extract(turn(surface, undefined, true), surface)).toMatchObject({ generating: true, responseComplete: false });
      const table = turn(surface).replace('<button aria-label="Copy response">Copy</button>', '').replace('</p>', '</p><button aria-label="Copy table">Copy</button>');
      expect(extract(table, surface).responseComplete).toBe(false);
    });
  }
  it('never uses ordinary Bing search cards, generic prose or an unknown provider as an AI answer', () => {
    const ordinary = '<main id="b_ans"><div class="prose">A search snippet with an AI phrase.</div><button aria-label="Copy response">Copy</button></main>';
    for (const surface of [...surfaces, 'unknown_provider']) expect(extract(ordinary, surface)).toMatchObject({ answer: '', containerFound: false, responseComplete: false });
    expect(extract('<model-response>Gemini content</model-response>', 'unknown_provider').answer).toBe('');
  });
  it('reads the observed Perplexity main prose only after this exact raw submitted question is rendered', () => {
    const html = '<button>Sign in</button><main><p>' + question + '</p><div class="group/partition flex flex-col group/final-text mt-2"><div><div><div><div><div><div class="prose"><p>A completed answer describing scheduling tools for Canadian restaurants.</p><a href="https://guide.example">Guide</a></div></div></div></div></div></div><button aria-label="Copy">Copy</button><button>10 sources</button></div><div id="ask-input" role="textbox" contenteditable="true"></div></main>';
    expect(extract(html, 'perplexity').containerFound).toBe(false);
    expect(extract(html, 'perplexity', 'https://www.perplexity.ai/', 'A different question').containerFound).toBe(false);
    expect(extract(html, 'perplexity', 'https://www.perplexity.ai/', question)).toMatchObject({ containerFound: true, responseComplete: true });
    expect(extract(html.replace('<p>' + question + '</p>', ''), 'perplexity', 'https://www.perplexity.ai/', question).containerFound).toBe(false);
    expect(extract(html.replace('class="group/partition flex flex-col group/final-text mt-2"', ''), 'perplexity', 'https://www.perplexity.ai/', question).responseComplete).toBe(false);
  });
  it('reads semantic Grok assistant articles and only their immediate response footer, preserving unknown sources', () => {
    const html = '<main><section role="region" aria-label="Shared conversation"><article aria-label="You">Synthetic user query</article><article aria-label="Grok"><button>Worked for 7s</button><h3>Scheduling tools</h3><p>A completed restaurant scheduling answer with details.</p><ul><li>Compare staffing coverage.</li></ul></article><div><button aria-label="Copy response">Copy</button><button>More actions</button></div></section></main>';
    const s = extract(html, 'grok');
    expect(s).toMatchObject({ containerFound: true, responseComplete: true, sourcePanel: false, citations: [] });
    expect(s.answer).toContain('Compare staffing coverage.'); expect(s.answer).not.toMatch(/Synthetic user|Worked for|More actions/);
    expect(extract(html.replace('<button aria-label="Copy response">Copy</button>', '<button aria-label="Copy response" disabled>Copy</button>'), 'grok').responseComplete).toBe(false);
    expect(extract(html.replace('<div><button aria-label="Copy response">Copy</button><button>More actions</button></div>', '<article aria-label="You"><button aria-label="Copy response">Copy</button></article>'), 'grok').responseComplete).toBe(false);
  });
  it('never treats newly typed Perplexity composer/form text as a submitted query echo for an old answer', () => {
    const oldAnswer = '<div class="group/partition"><div class="prose"><p>OLDER ANSWER with a completed response unrelated to the newly typed question.</p></div><button aria-label="Copy">Copy</button></div>';
    for(const composer of [
      '<div id="ask-input" contenteditable="true"><p>' + question + '</p></div>',
      '<div role="textbox"><span>' + question + '</span></div>',
      '<form><p>' + question + '</p></form>'
    ]){
      const s=extract('<main>' + oldAnswer + composer + '</main>', 'perplexity', 'https://www.perplexity.ai/', question);
      expect(s).toMatchObject({ containerFound: false, responseComplete: false, answer: '' });
    }
  });
  it('resolves visible Bing citation redirects and marks opaque redirects unresolved', () => {
    const href = 'https://www.bing.com/ck/a?u=a1' + Buffer.from('https://official.example/rules?utm_campaign=test').toString('base64');
    const s = extract(turn('bing_copilot').replace('https://guide.example/shifts?utm_source=ai#section', href) + sourcesPanel(2, '<a href="https://www.bing.com/ck/a?opaque=1">Opaque source</a>'), 'bing_copilot');
    expect(s.citations[0].url).toBe('https://official.example/rules');
    expect(s.unresolvedCitations).toBe(1);
  });
  it('preserves UTF-8 Canadian/French and Chinese paths in visible Bing redirects', () => {
    for (const target of ['https://official.example/règles/Québec', 'https://official.example/餐馆/排班']) {
      const href = 'https://www.bing.com/ck/a?u=a1' + Buffer.from(target).toString('base64url');
      const s = extract(turn('bing_copilot').replace('https://guide.example/shifts?utm_source=ai#section', href), 'bing_copilot');
      expect(s.citations[0].url).toBe(new URL(target).toString()); expect(s.unresolvedCitations).toBe(0);
    }
  });
  it('excludes consumer-site navigation but retains actual official product documentation', () => {
    const s = extract(turn('perplexity').replace('</p>', '</p><a href="https://www.perplexity.ai/search/private-id">Old thread</a><a href="https://www.perplexity.ai/help-center/en/articles/how-search-works">Official help</a>'), 'perplexity');
    expect(s.citations.map((c: any) => c.url)).toEqual(['https://www.perplexity.ai/help-center/en/articles/how-search-works', 'https://guide.example/shifts']);
  });
});

describe('consumer Copilot login confirmation — synthetic native UI only',()=>{
  it('opens only a unique named settings control, verifies its native sign-out menu and closes it',async()=>{
    for(const url of ['https://copilot.microsoft.com/','https://copilot.com/']){
      const f=consumerLoginMenuFixture({url});
      expect(await affirmCopilotAccount('bing_copilot',f.page,f.read)).toMatchObject({signedIn:true,accountVerified:true,signedOut:false});
      expect(f.counts()).toEqual({clicks:1,escapes:1,reads:3,opened:false});
    }
  });
  it('accepts manually opened native account evidence without guessing or auto-clicking a generic Menu',async()=>{
    const triggerHtml='<button aria-label="Menu"></button>';
    const closed=consumerLoginMenuFixture({triggerHtml});
    expect(await affirmCopilotAccount('bing_copilot',closed.page,closed.read)).toMatchObject({signedIn:false});
    expect(closed.counts()).toMatchObject({clicks:0,escapes:0,reads:1});
    const manual=consumerLoginMenuFixture({triggerHtml,manuallyOpened:true});
    expect(await affirmCopilotAccount('bing_copilot',manual.page,manual.read)).toMatchObject({signedIn:true});
    expect(manual.counts()).toMatchObject({clicks:0,escapes:0,reads:1,opened:true});
  });
  it('does not mistake settings, guest sign-in, hidden sign-out or assistant-authored UI for login',async()=>{
    for(const menuHtml of [
      '<div role="menu"><button aria-label="Sign in"></button></div>',
      '<div role="menu"><button>Theme</button></div>',
      '<div role="menu" hidden><button>Sign out</button></div>',
      '<div data-message-author-role="assistant"><div role="menu"><button>Sign out</button></div></div>',
      '<div data-content="user-message"><div role="menu"><button>Sign out</button></div></div>',
      '<div data-testid="user-message"><div role="menu"><button>Sign out</button></div></div>',
      '<article data-role="user"><div role="menu"><button>Sign out</button></div></article>',
      '<div data-testid="user-query"><div role="menu"><button>Sign out</button></div></div>',
      '<aside data-testid="sources-panel"><div role="menu"><button>Sign out</button></div></aside>',
      '<form><div role="menu"><button>Sign out</button></div></form>',
    ]){
      const f=consumerLoginMenuFixture({menuHtml});
      const result=await affirmCopilotAccount('bing_copilot',f.page,f.read);
      expect(result.signedIn).toBe(false);expect(result.accountVerified).not.toBe(true);
      expect(f.counts()).toMatchObject({clicks:1,escapes:1,opened:false});
    }
  });
  it('does not click a lookalike/insecure origin, ambiguous controls or fake settings inside an answer',async()=>{
    for(const options of [
      {url:'https://copilot.microsoft.com.evil.example/'},{url:'http://copilot.microsoft.com/'},
      {url:'https://unrelated.invalid/'},{url:'http://m365.cloud.microsoft/chat'},
      {url:'https://m365.cloud.microsoft.evil.example/chat'},
      {url:'https://private:secret@copilot.com/'},{url:'https://copilot.com:8443/'},
      {triggerHtml:'<button aria-label="Settings"></button><button aria-label="Settings and more"></button>'},
      {triggerHtml:'<div data-message-author-role="assistant"><button aria-label="Settings and more"></button></div>'},
      {triggerHtml:'<div data-content="user-message"><button aria-label="Settings and more"></button></div>'},
      {triggerHtml:'<div data-testid="user-message"><button aria-label="Settings and more"></button></div>'},
      {triggerHtml:'<article data-role="user"><button aria-label="Settings and more"></button></article>'},
      {triggerHtml:'<div data-testid="user-query"><button aria-label="Settings and more"></button></div>'},
      {triggerHtml:'<aside data-testid="sources-panel"><button aria-label="Settings and more"></button></aside>'},
      {triggerHtml:'<button aria-label="Settings and more" disabled></button>'},
    ]){
      const f=consumerLoginMenuFixture(options);
      expect((await affirmCopilotAccount('bing_copilot',f.page,f.read)).signedIn).toBe(false);
      expect(f.counts()).toMatchObject({clicks:0,escapes:0,reads:1});
    }
  });
  it('always escapes an actively opened overlay if menu read or click fails',async()=>{
    for(const options of [{failRead:true},{failClick:true}]){
      const f=consumerLoginMenuFixture(options);
      await expect(affirmCopilotAccount('bing_copilot',f.page,f.read)).rejects.toThrow(/Synthetic/);
      expect(f.counts()).toMatchObject({clicks:1,escapes:1,opened:false});
    }
  });
  it('rechecks the official origin after click and read, refusing navigation even with a positive stale snapshot',async()=>{
    for(const options of [
      {navigateOnClick:'https://login.live.com/'},
      {navigateOnClick:'https://copilot.microsoft.com.evil.example/'},
      {navigateOnRead:'https://login.live.com/'},
      {navigateOnRead:'https://copilot.com.evil.example/'},
    ]){
      const f=consumerLoginMenuFixture(options);
      expect(await affirmCopilotAccount('bing_copilot',f.page,f.read)).toMatchObject({signedIn:false,accountVerified:false});
      expect(f.counts()).toMatchObject({clicks:1,escapes:1,opened:false});
    }
    const stale=consumerLoginMenuFixture({manuallyOpened:true,navigateOnRead:'https://unrelated.invalid/'});
    expect(await affirmCopilotAccount('bing_copilot',stale.page,stale.read)).toMatchObject({signedIn:false,accountVerified:false});
    expect(stale.counts()).toMatchObject({clicks:0,escapes:0,reads:1});
    for(const url of ['https://unrelated.invalid/','http://m365.cloud.microsoft/chat','https://m365.cloud.microsoft.evil.example/chat']){
      const page={url:()=>url};
      expect(await affirmCopilotAccount('bing_copilot',page,async()=>({signedIn:true,signedOut:false}))).toMatchObject({signedIn:false,accountVerified:false});
    }
  });
  it('verifySession marks the dedicated session ready using manual native evidence without submitting a question',async()=>{
    const f=collectorFixture('bing_copilot');
    const sample={...task('bing_copilot'),browserMode:'visible',config:{...task('bing_copilot').config,accountMode:'isolated'}};
    await f.collector.prepareSession(sample);
    const manual=consumerLoginMenuFixture({triggerHtml:'<button aria-label="Menu"></button>',manuallyOpened:true});
    Object.assign(f.pages[0],{url:manual.page.url,evaluate:manual.read,getByRole:manual.page.getByRole,keyboard:manual.page.keyboard});
    expect(await f.collector.verifySession(sample.planId,sample.surface)).toMatchObject({verified:true});
    expect(f.collector.ready(sample.planId,[sample.surface])).toBe(true);
    expect(f.counts()).toMatchObject({submitted:0,rawPrompt:''});
    expect(manual.counts()).toMatchObject({clicks:0,escapes:0,reads:1});
  });
  it('verifySession distinguishes native signed-out UI from unrecognized account evidence, retaining not-ready state',async()=>{
    for(const [html,message] of [
      ['<button aria-label="Sign in"></button>',/页面仍显示登录入口/],
      ['<button aria-label="Menu"></button>',/工具尚未识别到可核验的账号状态/],
    ] as const){
      const f=collectorFixture('bing_copilot');
      const sample={...task('bing_copilot'),browserMode:'visible',config:{...task('bing_copilot').config,accountMode:'isolated'}};
      await f.collector.prepareSession(sample);
      const guest=consumerLoginMenuFixture({triggerHtml:html,menuHtml:''});
      Object.assign(f.pages[0],{url:guest.page.url,evaluate:guest.read,getByRole:guest.page.getByRole,keyboard:guest.page.keyboard});
      await expect(f.collector.verifySession(sample.planId,sample.surface)).rejects.toThrow(message);
      expect(f.collector.ready(sample.planId,[sample.surface])).toBe(false);
      expect(f.counts()).toMatchObject({submitted:0,rawPrompt:''});
    }
  });
});

describe('new platform Chrome collection — synthetic browser only', () => {
  for (const surface of surfaces) {
    it(`${surface}: sends the exact raw question once, waits for completion and opens sources in an isolated silent context`, async () => {
      const f = collectorFixture(surface);
      const result = await f.collector.collect(task(surface), new AbortController().signal, () => {});
      expect(result).toMatchObject({ status: 'observed', account: 'logged_out', session: 'fresh', searchMode: 'natural',
        browser: { mode: 'silent', answerComplete: true, citationsComplete: true, citationControls: 1, citationControlsOpened: 1 } });
      expect(f.counts()).toMatchObject({ submitted: 1, rawPrompt: question, sourceOpened: true });
      expect(f.counts().polls).toBeGreaterThanOrEqual(6);
      expect(f.contexts).toHaveLength(1); expect(f.contexts[0].closed).toBe(true);
      expect(f.requests).toHaveLength(1); // No API/source URL fetch or submitted-request retry.
      const raw = JSON.parse(Buffer.from(result.artifact.base64, 'base64').toString());
      expect(raw).toMatchObject({ surface, question, citationsComplete: true });
    });
  }
  it('retains original text but keeps inline-links-only sources incomplete', async () => {
    const f = collectorFixture('grok', { noSources: true });
    const result = await f.collector.collect(task('grok'), new AbortController().signal, () => {});
    expect(result.status).toBe('observed'); expect(result.answer).toContain('A completed answer');
    expect(result.browser.citationsComplete).toBe(false); expect(result.browser.citationControls).toBe(0);
    expect(f.counts().submitted).toBe(1);
  });
  it('waits for delayed guest hydration instead of misclassifying an early Sign-in link as a login wall', async () => {
    for(const surface of surfaces){
      const f=collectorFixture(surface,{inputDelayReads:8});
      const result=await f.collector.collect(task(surface),new AbortController().signal,()=>{});
      expect(result).toMatchObject({status:'observed',account:'logged_out'});expect(f.counts()).toMatchObject({submitted:1,rawPrompt:question});
    }
  });
  it('records a bounded no-input terminal state without submitting or automatically retrying', async () => {
    const f=collectorFixture('grok',{neverInput:true});
    const result=await f.collector.collect(task('grok'),new AbortController().signal,()=>{});
    expect(result).toMatchObject({status:'unavailable',restriction:'login'});expect(f.counts().submitted).toBe(0);
    expect(result.browser.notes.some((note:string)=>note.includes('提交前已等待提问框最多'))).toBe(true);expect(f.requests).toHaveLength(1);
  });
  it('a sources-control failure retains the answered request without resending it', async () => {
    const f = collectorFixture('grok', { failure: true });
    const result = await f.collector.collect(task('grok'), new AbortController().signal, () => {});
    expect(result).toMatchObject({ status: 'observed', browser: { citationsComplete: false, citationControlsOpened: 0 } });
    expect(f.counts().submitted).toBe(1); expect(result.answer).toContain('A completed answer');
  });
  it('does not submit when explicit signed-out state cannot be established', async () => {
    const f = collectorFixture('perplexity', { initial: '<textarea placeholder="Ask anything"></textarea>' });
    const result = await f.collector.collect(task('perplexity'), new AbortController().signal, () => {});
    expect(result).toMatchObject({ status: 'error', account: 'unknown' }); expect(f.counts().submitted).toBe(0);
  });
  it('does not submit into a page containing a pre-existing answer, even if it has completed controls and sources', async () => {
    const f = collectorFixture('bing_copilot', { initial: '<button>Sign in</button>' + turn('bing_copilot') + sourcesPanel() });
    const result = await f.collector.collect(task('bing_copilot'), new AbortController().signal, () => {});
    expect(result).toMatchObject({ status: 'error' }); expect(result.reason).toMatch(/既有答案/); expect(f.counts().submitted).toBe(0);
  });
  it('preserves CAPTCHA/rate-limit/login terminal states without submitting', async () => {
    for (const [body, restriction, destination] of [
      ['Verify you are human', 'captcha', undefined], ['Too many requests', 'rate_limit', undefined], ['', 'login', 'https://login.live.com/']
    ]) {
      const f = collectorFixture('bing_copilot', { initial: String(body), destination });
      const result = await f.collector.collect(task('bing_copilot'), new AbortController().signal, () => {});
      expect(result).toMatchObject({ status: 'unavailable', restriction }); expect(f.counts().submitted).toBe(0);
    }
  });
  it('rejects unsupported signed-in private preparation/collection and unknown surface before any browser launch', async () => {
    for (const surface of surfaces) {
      const f = collectorFixture(surface);
      await expect(f.collector.prepareSession(task(surface))).rejects.toThrow(/没有经过核验的登录隐私模式/);
      await expect(f.collector.collect({ ...task(surface), config: { ...task(surface).config, accountMode: 'signed_in_private' } }, new AbortController().signal, () => {})).rejects.toThrow(/没有经过核验的登录隐私模式/);
      expect(f.counts().launches).toBe(0);
    }
    const f = collectorFixture('unknown_provider');
    await expect(f.collector.collect(task('unknown_provider'), new AbortController().signal, () => {})).rejects.toThrow(/未支持/);
    expect(f.counts().launches).toBe(0);
  });
  it('retains only the fixed Bing AI path, excluding a private conversation/query URL', async () => {
    const f = collectorFixture('bing_copilot', { destination: 'https://www.bing.com/chat/private-thread?q=sensitive' });
    const result = await f.collector.collect(task('bing_copilot'), new AbortController().signal, () => {});
    expect(result.sourceUrl).toBe('https://www.bing.com/chat');
  });
  it('preserves the existing default of signed-out when accountMode is omitted', async () => {
    const f = collectorFixture('grok'); const sample = task('grok');
    const result = await f.collector.collect({ ...sample, config: { locale: sample.config.locale, timezone: sample.config.timezone } }, new AbortController().signal, () => {});
    expect(result).toMatchObject({ status: 'observed', account: 'logged_out', privacy: { mode: 'signed_out' } });
  });
  it('uses a provider native Submit button when present without altering or resending the question', async () => {
    const f = collectorFixture('grok', { nativeSubmit: true });
    const result = await f.collector.collect(task('grok'), new AbortController().signal, () => {});
    expect(result.status).toBe('observed'); expect(f.counts()).toMatchObject({ submitted: 1, rawPrompt: question });
  });
  it('isolated plans use an empty fresh guest context when that provider has no prepared login', async () => {
    for (const surface of surfaces) {
      const f = collectorFixture(surface);
      const sample = { ...task(surface), config: { ...task(surface).config, accountMode: 'isolated' } };
      const result = await f.collector.collect(sample, new AbortController().signal, () => {});
      expect(result).toMatchObject({ status: 'observed', account: 'logged_out', session: 'fresh', privacy: { mode: 'signed_out', newConversation: true } });
      expect(f.contexts[0].options.storageState).toBeUndefined(); expect(f.contexts).toHaveLength(1);
    }
  });
  it('clones only the verified dedicated login into a fresh context per independent question and labels it logged-in', async () => {
    const f = collectorFixture('bing_copilot', { loggedIn: true, destination: 'https://m365.cloud.microsoft/chat/private-id?q=private' });
    const sample = { ...task('bing_copilot'), browserMode: 'visible', config: { ...task('bing_copilot').config, accountMode: 'isolated' } };
    // Native login UI itself is user-operated; the synthetic fixture supplies affirmative profile UI.
    await f.collector.prepareSession(sample);
    await f.collector.verifySession(sample.planId, sample.surface);
    const result = await f.collector.collect(sample, new AbortController().signal, () => {});
    expect(result).toMatchObject({ status: 'observed', account: 'logged_in', session: 'active', sourceUrl: 'https://m365.cloud.microsoft/chat',
      privacy: { mode: 'signed_in_independent', personalization: 'unknown', newConversation: true } });
    expect(f.contexts).toHaveLength(2); expect(f.contexts[0].closed).toBe(false); expect(f.contexts[1].closed).toBe(true);
    expect(f.contexts[1].options.storageState.cookies[0].value).toBe('SYNTHETIC DEDICATED TOKEN');
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC DEDICATED TOKEN');
    expect(f.requests).toEqual(['https://copilot.microsoft.com/', 'https://m365.cloud.microsoft/chat']);
  });
  it('affirms M365 account state only by an opened native Sign-out control and does not inspect the user identity', async () => {
    let clicks = 0, escapes = 0, reads = 0;
    const account = { isVisible: async () => true, click: async () => { clicks++; }, getAttribute: () => { throw new Error('Identity must never be read'); } };
    const page = { url: () => 'https://m365.cloud.microsoft/chat', locator: () => ({ all: async () => [account] }), keyboard: { press: async (key: string) => { expect(key).toBe('Escape'); escapes++; } } };
    const result = await affirmCopilotAccount('bing_copilot', page, async () => ({ signedIn: ++reads === 2, signedOut: false }));
    expect(result).toMatchObject({ signedIn: true, accountVerified: true }); expect(clicks).toBe(1); expect(escapes).toBe(1);
    expect(extract('<div role="button" aria-label="Private User">Profile</div><button id="me-control-sign-out-button">Sign out</button>', 'bing_copilot','https://m365.cloud.microsoft/chat')).toMatchObject({ signedIn: true, controls: ['Microsoft account control', 'Sign out'] });
  });
  it('does not click ambiguous M365 account controls or infer login from their existence', async () => {
    const account = { isVisible: async () => true, click: async () => { throw new Error('Ambiguous controls must not be clicked'); } };
    const page = { url: () => 'https://m365.cloud.microsoft/chat', locator: () => ({ all: async () => [account, account] }) };
    const result = await affirmCopilotAccount('bing_copilot', page, async () => ({ signedIn: false, signedOut: false }));
    expect(result.signedIn).toBe(false); expect(result.accountVerified).toBeUndefined();
  });
  it('dismisses only optional initial Perplexity Decline/Close controls without signing in or accepting cookies', async () => {
    const clicks: string[] = [];
    const page = { getByRole: (_role: string, { name }: { name: RegExp }) => ({ all: async () => ['Accept all', 'Decline optional', 'Close', 'Sign in'].filter(label => name.test(label)).map(label => ({ isVisible: async () => true, click: async () => { clicks.push(label); } })) }) };
    await dismissPerplexityOverlays(page, { body: 'Login or signup for free. Save and sync your searches', hasInput: true }); expect(clicks).toEqual(['Decline optional', 'Close']);
    clicks.length=0;
    await dismissPerplexityOverlays(page, { body: 'Mandatory login without a guest input', hasInput: false, allowDecline: false }); expect(clicks).toEqual([]);
  });
  it('rejects unrelated account preparation pages and removes conversation/query identifiers from official fresh URLs', () => {
    expect(freshEntryUrl('bing_copilot', 'https://m365.cloud.microsoft/chat/private?q=sensitive')).toBe('https://m365.cloud.microsoft/chat');
    expect(freshEntryUrl('bing_copilot', 'https://www.bing.com/chat?q=sensitive')).toBe('https://www.bing.com/chat');
    expect(() => freshEntryUrl('bing_copilot', 'https://www.bing.com/search?q=other')).toThrow(/对话入口/);
    expect(() => freshEntryUrl('grok', 'https://unrelated.example/account')).toThrow(/不属于/);
    expect(() => freshEntryUrl('grok', 'https://private:secret@grok.com/')).toThrow(/HTTPS/);
  });
});

describe('bounded native source-panel coverage — synthetic controls', () => {
  it('keeps a declared zero source range uncertain rather than counting a generic panel help link as complete citations', async () => {
    for(const declaredBy of ['control','panel']){
      const control={isVisible:async()=>true,getAttribute:async(name:string)=>name==='aria-label'?(declaredBy==='control'?'0 sources':'Sources'):'true'};
      const result=await collectNewSurfaceSources('perplexity',{page:{getByRole:()=>({all:async()=>[control]})},
        inspect:async()=>({sourcePanel:true,sourceCountExpected:declaredBy==='panel'?0:null,citations:[{url:'https://help.example/guide',placement:'source_panel'}]}),wait:async()=>{},check:()=>{}});
      expect(result.citationsComplete).toBe(false);expect(result.snapshot.citations).toHaveLength(1);
      expect(result.notes.some((note:string)=>note.includes('零条来源'))).toBe(true);
    }
  });
  it('marks combined source-panel overflow incomplete even when each individual panel is bounded', async () => {
    let active=0;
    const control=(n:number)=>({isVisible:async()=>true,getAttribute:async()=>null,click:async()=>{active=n;}});
    const result=await collectNewSurfaceSources('grok',{page:{getByRole:()=>({all:async()=>[control(1),control(2)]})},
      inspect:async()=>active?{sourcePanel:true,sourceCountExpected:60,citations:Array.from({length:60},(_,n)=>({url:`https://source-${active}-${n}.example/`,placement:'source_panel'}))}:{sourcePanel:false,citations:[]},
      wait:async()=>{},check:()=>{}});
    expect(result).toMatchObject({citationsComplete:false,citationControlsOpened:2});
    expect(result.snapshot.citationOverflow).toBe(20);expect(result.snapshot.citations).toHaveLength(100);
  });
  it('opens the unique counted Perplexity aggregate once, excluding generic inline Sources previews', async () => {
    let inlineClicks=0,aggregateClicks=0;
    const inline={isVisible:async()=>true,getAttribute:async(name:string)=>name==='aria-label'?'Sources':null,innerText:async()=> 'Source preview',click:async()=>{inlineClicks++;}};
    const aggregate={isVisible:async()=>true,getAttribute:async(name:string)=>name==='aria-label'?'Sources':null,innerText:async()=> '10 sources',click:async()=>{aggregateClicks++;}};
    const citations=Array.from({length:10},(_,n)=>({url:`https://guide-${n}.example/`,placement:'source_panel'}));
    const result=await collectNewSurfaceSources('perplexity',{page:{getByRole:()=>({all:async()=>[inline,aggregate]})},
      inspect:async()=>aggregateClicks?{sourcePanel:true,citations}:{sourcePanel:false,citations:[]},wait:async()=>{},check:()=>{}});
    expect(inlineClicks).toBe(0);expect(aggregateClicks).toBe(1);expect(result).toMatchObject({citationControls:1,citationControlsOpened:1,citationsComplete:true});
  });
  it('waits for the same counted-source portal to hydrate without clicking again or resending a question', async () => {
    let reads=0,clicks=0,waits=0;
    const aggregate={isVisible:async()=>true,getAttribute:async(name:string)=>name==='aria-label'?'10 sources':null,click:async()=>{clicks++;}};
    const ten=Array.from({length:10},(_,n)=>({url:`https://source-${n}.example/`,placement:'source_panel'}));
    const result=await collectNewSurfaceSources('perplexity',{page:{getByRole:()=>({all:async()=>[aggregate]})},
      inspect:async()=>++reads<3?{sourcePanel:false,citations:[]}:{sourcePanel:true,citations:reads===3?ten.slice(0,2):ten},
      wait:async()=>{waits++;},check:()=>{}});
    expect(clicks).toBe(1);expect(waits).toBe(3);expect(result.citationsComplete).toBe(true);expect(result.snapshot.citations).toHaveLength(10);
  });
  it('honors the native Sources-button count when the panel heading omits the count', async () => {
    const control = { isVisible: async () => true, getAttribute: async (name: string) => name === 'aria-label' ? '3 sources' : 'true' };
    const snapshot = { sourcePanel: true, citations: [{ url: 'https://guide.example', placement: 'source_panel' }] };
    const result = await collectNewSurfaceSources('grok', { page: { getByRole: () => ({ all: async () => [control] }) },
      inspect: async () => snapshot, wait: async () => {}, check: () => {} });
    expect(result.citationsComplete).toBe(false);
  });
  it('does not use unrelated inline links to satisfy the advertised panel source count', async () => {
    const control = { isVisible: async () => true, getAttribute: async () => 'true' };
    const snapshot = { sourcePanel: true, sourceCountExpected: 3, citations: [
      { url: 'https://guide.example', placement: 'source_panel' },
      { url: 'https://inline-one.example', placement: 'answer_link' }, { url: 'https://inline-two.example', placement: 'answer_link' }
    ] };
    const result = await collectNewSurfaceSources('grok', { page: { getByRole: () => ({ all: async () => [control] }) },
      inspect: async () => snapshot, wait: async () => {}, check: () => {} });
    expect(result.citationsComplete).toBe(false); expect(result.snapshot.citations).toHaveLength(3);
  });
  it('retains a prior incomplete source panel even when the last panel has complete coverage', async () => {
    let active='none';
    const control=(state:string)=>({isVisible:async()=>true,getAttribute:async()=>null,click:async()=>{active=state;}});
    const result = await collectNewSurfaceSources('grok', { page: { getByRole: () => ({ all: async () => [control('partial'), control('complete')] }) },
      inspect: async () => active==='none'?{sourcePanel:false,citations:[]}:active==='partial'
        ?{sourcePanel:true,sourceCountExpected:3,citations:[{url:'https://partial.example',placement:'source_panel'}]}
        :{sourcePanel:true,sourceCountExpected:1,citations:[{url:'https://complete.example',placement:'source_panel'}]},
      wait: async () => {}, check: () => {} });
    expect(result.citationsComplete).toBe(false); expect(result.citationControlsOpened).toBe(2);
  });
  it('recognizes pagination announced by native role buttons and links in the sources panel', () => {
    for (const more of ['<span role="button">Show more</span>', '<a href="#more-sources">See all</a>']) {
      expect(extract(turn('grok') + sourcesPanel(1, more), 'grok').sourcePanelHasMore).toBe(true);
    }
  });
  it('does not accept a page-level Copy button for an otherwise unbounded Grok response', () => {
    const s = extract('<main><div class="response-content-markdown">A sufficiently long standalone response.</div><button aria-label="Copy response">Copy</button></main>', 'grok');
    expect(s.answer).toContain('standalone response'); expect(s.responseComplete).toBe(false);
  });
  it('does not claim completeness when the panel advertises more sources, unresolved redirects or overflow', async () => {
    const control = { isVisible: async () => true, getAttribute: async () => 'true', click: async () => { throw new Error('Should not toggle open panel closed'); } };
    const base = { citations: [{ url: 'https://guide.example', placement: 'source_panel' }], sourcePanel: true, unresolvedCitations: 0, citationOverflow: 0 };
    for (const limitation of [{ sourceCountExpected: 2 }, { sourcePanelHasMore: true }, { unresolvedCitations: 1 }, { citationOverflow: 1 }]) {
      const result = await collectNewSurfaceSources('perplexity', { page: { getByRole: () => ({ all: async () => [control] }) },
        inspect: async () => ({ ...base, ...limitation }), wait: async () => {}, check: () => {} });
      expect(result.citationsComplete).toBe(false); expect(result.citationControlsOpened).toBe(1);
    }
  });
});
