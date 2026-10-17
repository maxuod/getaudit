import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { parseHTML } from "linkedom";
const { extractVisiblePage } = createRequire(import.meta.url)("../../desktop/browser-extract.cjs");
const { collectNewSurfaceSources } = createRequire(import.meta.url)("../../desktop/browser-platforms.cjs");
function extract(html: string, surface = "chatgpt_search", question?: string, base = "https://www.google.com/") {
  const { document, window } = parseHTML(`<html><head><base href="${base}"></head><body>${html}</body></html>`);
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 } as DOMRect);
  window.getComputedStyle = (el: Element) => ({ display: el.getAttribute("style")?.includes("display:none") ? "none" : "block", visibility: "visible", position: /(?:^|;)\s*position\s*:\s*fixed/.test(el.getAttribute('style')||'')?'fixed':'static' } as CSSStyleDeclaration);
  return extractVisiblePage({ document, surface, question });
}
describe("visible answer and citation boundaries", () => {
  it('reads Gemini inline citation dialogs without mixing source cards into the answer',()=>{
    const s=extract(`<button>Sign in</button><model-response><message-content><div class="markdown" id="model-response-message-content-test"><p>A completed answer for restaurant tip pools.</p><div class="source-inline-chip-container"><button aria-expanded="true" aria-label="View source details for citation from source.example. Press Enter to open sources dialog.">Source</button><div role="dialog"><inline-source-card><a href="https://source.example/tips#fragment">Actual source title and preview</a></inline-source-card></div></div></div></message-content><action-bar-buttons><copy-button><button aria-label="Copy">Copy</button></copy-button></action-bar-buttons></model-response>`,'gemini');
    expect(s.answer).toBe('A completed answer for restaurant tip pools.');expect(s.responseComplete).toBe(true);
    expect(s.citationControls).toBe(1);expect(s.sourcePanel).toBe(true);
    expect(s.citations).toEqual([{url:'https://source.example/tips',title:'Actual source title and preview',placement:'source_panel'}]);
  });
  it('counts unexpanded Gemini citation controls but does not guess their links',()=>{
    const s=extract(`<model-response><message-content><div class="markdown"><p>Restaurant answer with a visible citation.</p><button aria-expanded="false" aria-label="View source details for citation from source.example. Press Enter to open sources dialog.">Source</button></div></message-content><button aria-label="Copy">Copy</button></model-response>`,'gemini');
    expect(s.citationControls).toBe(1);expect(s.citations).toEqual([]);expect(s.sourcePanel).toBe(false);
  });
  it("distinguishes a copyable table from the completed response controls", () => {
    const partial=extract(`<article><div data-message-author-role="assistant"><table><tr><td>Still generating</td></tr></table><button aria-label="Copy table">Copy</button></div></article>`);
    expect(partial.responseComplete).toBe(false);
    const complete=extract(`<article><div data-message-author-role="assistant"><p>Finished response</p></div><footer><button aria-label="Copy response">Copy</button></footer></article>`);
    expect(complete.responseComplete).toBe(true);
  });
  it("extracts the latest assistant response, excluding prompts, hidden content and navigation", () => {
    const s = extract(`<button>Log in</button><nav><a href="https://nav.example/">Northstar</a></nav><div data-message-author-role="user">Northstar?</div><div data-message-author-role="assistant">Old answer</div><div data-message-author-role="assistant"><p>Current answer.</p><div hidden>Northstar hidden</div><span style="display:none">Hidden brand</span><a href="https://source.example/page?utm_source=chatgpt&topic=work#section">Source</a><button>Copy</button></div>`);
    expect(s.signedOut).toBe(true); expect(s.answer).toBe("Current answer.\nSource");
    expect(s.citations).toEqual([{ url: "https://source.example/page?topic=work", title: "Source", placement:"answer_link" }]);
  });
  it("does not infer an Overview from organic search results", () => {
    const s = extract(`<div id="search"><h3>AI Overview guide</h3><p>Normal organic result</p></div>`, "google_aio");
    expect(s).toMatchObject({ triggered: false, containerFound: false, answer: "", hasSearchResults: true });
  });
  it("isolates a Google Overview from normal results and resolves citations", () => {
    const s = extract(`<div><section><h2>AI Overview</h2><p>Build weekly shifts using demand, availability and labour budget.</p><a href="https://www.google.com/url?q=https%3A%2F%2Fguide.example%2Fshifts%3Futm_source%3Dgoogle">Guide</a></section><div>\nPeople also ask\n<h3>Northstar organic result</h3></div></div>`, "google_aio");
    expect(s.triggered).toBe(true); expect(s.answer).toContain("Build weekly shifts"); expect(s.answer).not.toContain("Northstar");
    expect(s.citations[0].url).toBe("https://guide.example/shifts");
  });
  it("includes legitimate provider documentation and a separately opened Sources panel", () => {
    const s = extract(`<div data-message-author-role="assistant"><p>Answer describing the product.</p><a href="https://openai.com/index/searchgpt-prototype/">OpenAI</a><a href="https://developers.google.com/search/docs/">Google docs</a><a href="https://www.google.com/search?q=other">Navigation</a></div><aside><h2>Sources</h2><a href="https://source.example/full">Full citation</a></aside>`);
    expect(s.sourcePanel).toBe(true); expect(s.citations.map((c: {url:string}) => c.url)).toEqual(["https://openai.com/index/searchgpt-prototype/", "https://developers.google.com/search/docs/", "https://source.example/full"]);
  });
  it("reports unresolved redirects rather than guessing source URLs", () => {
    const s = extract(`<section><h2>AI Overview</h2><p>A sufficient example answer with a visible citation to be resolved.</p><a href="https://www.google.com/goto?token=opaque">Citation</a></section>`, "google_aio");
    expect(s.unresolvedCitations).toBe(1); expect(s.citations).toEqual([]);
  });
});

describe('Perplexity response partitions and linked source portals — synthetic DOM',()=>{
  const question='How does Sample Studio compare with 7shifts for a small restaurant in Canada?';
  const body='<div class="prose"><p>Compare the published scheduling and payroll features.</p><a href="https://guide.example/shifts?utm_source=perplexity">Scheduling guide</a></div>';
  const second='<div class="prose"><p>The price and plan limits need to be checked on the current product pages.</p><a href="https://product.example/plans">Plans</a></div>';
  const page=(answer=body+second,footer='<button aria-label="Copy">Copy</button>',partition='group/partition group/final-text')=>
    `<button>Sign In</button><main><h1>${question}</h1><div class="${partition}">${answer}<footer>${footer}</footer></div><div id="ask-input" contenteditable="true"></div></main>`;

  it('keeps all fragments of one answer while excluding sidebar prose, query text and response controls',()=>{
    const s=extract(page().replace('</main>','<aside><div class="prose">Sidebar recommendation, unrelated to this answer.</div><a href="https://sidebar.example">Sidebar link</a></aside></main>'),'perplexity',question);
    expect(s).toMatchObject({containerFound:true,responseComplete:true,generating:false,signedOut:true});
    expect(s.answer).toContain('Compare the published');expect(s.answer).toContain('price and plan limits');
    expect(s.answer).not.toMatch(/Sample Studio compare|Sidebar|Copy|Sign In/);
    expect(s.citations.map((c:{url:string})=>c.url)).toEqual(['https://guide.example/shifts','https://product.example/plans']);
  });
  it('reads split fragments in a semantic assistant root without choosing only its last prose block',()=>{
    const s=extract(`<article data-testid="assistant-message">${body}${second}<div role="button" aria-label="Copy response">Copy</div></article>`,'perplexity');
    expect(s.responseComplete).toBe(true);expect(s.answer).toContain('Compare the published');expect(s.answer).toContain('price and plan limits');
  });
  it('recognizes the final-text partition when the outer response class differs',()=>{
    const s=extract(page(body,'<button aria-label="Copy">Copy</button>','group/final-text'),'perplexity',question);
    expect(s).toMatchObject({containerFound:true,responseComplete:true});
  });
  it('does not use a global Copy button to complete an unbounded prose body',()=>{
    const s=extract(page(body,'<button aria-label="Copy">Copy</button>','layout-only'),'perplexity',question);
    expect(s).toMatchObject({containerFound:true,responseComplete:false});expect(s.answer).toContain('Compare the published');
  });
  it('does not attribute another response footer to the answer of this exact query',()=>{
    const old='<div class="group/partition"><div class="prose">Older answer.</div><button aria-label="Copy">Copy</button></div>';
    const s=extract(page(body,'').replace(`<h1>${question}</h1>`,old+`<h1>${question}</h1>`),'perplexity',question);
    expect(s).toMatchObject({containerFound:true,responseComplete:false});expect(s.answer).not.toContain('Older answer');
  });
  it('refuses ambiguous response partitions after the submitted question',()=>{
    const ambiguous=page(body).replace('</main>',`<div class="group/partition">${second}<button aria-label="Copy">Copy</button></div></main>`);
    expect(extract(ambiguous,'perplexity',question)).toMatchObject({containerFound:false,responseComplete:false,answer:''});
  });
  it('does not let an earlier exact-query echo claim a later unrelated response',()=>{
    for(const nextQuery of ['<h1>Which unrelated software should I use?</h1>','<div><span>Which unrelated software should I use?</span></div>']){
      const stale=page().replace(`<h1>${question}</h1>`,`<h1>${question}</h1>${nextQuery}`);
      expect(extract(stale,'perplexity',question)).toMatchObject({containerFound:false,responseComplete:false,answer:''});
    }
    const laterTurn='<h1>Which unrelated software should I use?</h1><div class="group/partition">'+second+'<button aria-label="Copy">Copy</button></div>';
    expect(extract(page().replace('</main>',laterTurn+'</main>'),'perplexity',question)).toMatchObject({containerFound:false,responseComplete:false,answer:''});
  });
  it('uses rendered query text, so hidden descendants cannot manufacture an exact-query echo',()=>{
    const hidden=page().replace(`<h1>${question}</h1>`,`<h1><span hidden>${question}</span></h1>`);
    expect(extract(hidden,'perplexity',question)).toMatchObject({containerFound:false,responseComplete:false,answer:''});
    const obscured=page().replace(`<h1>${question}</h1>`,`<h1>${question}<span hidden>Invisible unrelated title</span></h1>`);
    expect(extract(obscured,'perplexity',question)).toMatchObject({containerFound:true,responseComplete:true});
  });
  it('never treats composer text or an Answer tab as a submitted response',()=>{
    const old=`<div class="group/partition">${body}<button aria-label="Copy">Copy</button></div>`;
    expect(extract(`<main><button role="tab" data-testid="answer">Answer</button>${old}<div contenteditable="true"><h1>${question}</h1></div></main>`,'perplexity',question))
      .toMatchObject({containerFound:false,responseComplete:false,answer:''});
  });
  it('does not turn an answer-view shell and its Copy action into a completed reply',()=>{
    const shell='<main><h1>'+question+'</h1><section><div data-testid="answer"><h2>Answer</h2><p>Sign in or create an account to save and synchronize your searches.</p><span>Links Images Sources</span></div><button aria-label="Copy">Copy</button></section></main>';
    expect(extract(shell,'perplexity',question)).toMatchObject({containerFound:false,responseComplete:false,answer:''});
  });
  it('uses Copy controls inside a semantic response, not a generic ancestor footer',()=>{
    const partial='<main><section><footer><button aria-label="Copy">Copy</button></footer><div data-testid="answer">'+body+'</div></section></main>';
    expect(extract(partial,'perplexity')).toMatchObject({containerFound:true,responseComplete:false});
    const complete='<main><div data-role="assistant">'+body+'<footer><button aria-label="Copy">Copy</button></footer></div></main>';
    expect(extract(complete,'perplexity')).toMatchObject({containerFound:true,responseComplete:true});
  });
  it('requires streaming to finish even when stale Copy controls remain',()=>{
    for(const attribute of ['aria-busy="true"','data-streaming="true"']){
      const html=page().replace('class="group/partition group/final-text"',`class="group/partition group/final-text" ${attribute}`);
      expect(extract(html,'perplexity',question)).toMatchObject({generating:true,responseComplete:false});
    }
    expect(extract(page(body,'<button aria-label="Copy" disabled>Copy</button>'),'perplexity',question).responseComplete).toBe(false);
  });
  it('reads a visible Sources portal only through its explicit control relationship',()=>{
    const portal='<div id="source-portal"><h2>Sources 2</h2><a href="https://guide.example/shifts">Scheduling guide</a><a href="https://product.example/plans#price">Plans</a></div>';
    const s=extract(page(body,'<button aria-label="Copy">Copy</button><button aria-controls="source-portal" aria-expanded="true">Sources</button>')+portal,'perplexity',question);
    expect(s).toMatchObject({responseComplete:true,sourcePanel:true,sourceCountExpected:2});
    expect(s.citations).toEqual([{url:'https://guide.example/shifts',title:'Scheduling guide',placement:'source_panel'},{url:'https://product.example/plans',title:'Plans',placement:'source_panel'}]);
    expect(s.answer).not.toContain('Sources 2');
  });
  it('reads an active Links tab panel without harvesting sidebar or navigation links',()=>{
    const portal='<div role="tablist"><button role="tab" id="answer-tab" aria-selected="false">Answer</button><button role="tab" id="links-tab" aria-selected="true">Links</button></div><div role="tabpanel" aria-labelledby="links-tab"><h2>Sources 1</h2><a href="https://source.example/current">Current citation</a></div><nav><a href="https://nav.example">Navigation</a></nav>';
    const s=extract(page().replace('</main>',portal+'</main>'),'perplexity',question);
    expect(s).toMatchObject({sourcePanel:true,sourceCountExpected:1});
    expect(s.citations.filter((c:{placement:string})=>c.placement==='source_panel')).toEqual([{url:'https://source.example/current',title:'Current citation',placement:'source_panel'}]);
    expect(s.citations.some((c:{url:string})=>c.url==='https://nav.example/')).toBe(false);
  });
  it('does not attribute an unrelated sidebar Sources portal to the current response',()=>{
    const unrelated='<aside><button aria-controls="sidebar-portal">Sources</button></aside><div id="sidebar-portal"><h2>Sources 1</h2><a href="https://unrelated.example/private">Unrelated sidebar source</a></div>';
    const s=extract(page()+unrelated,'perplexity',question);
    expect(s).toMatchObject({containerFound:true,responseComplete:true,sourcePanel:false});
    expect(s.citations.some((c:{url:string})=>c.url==='https://unrelated.example/private')).toBe(false);
  });
  it('does not accept an active Links panel belonging to another view',()=>{
    const unrelated='<section><button role="tab" id="other-links" aria-selected="true">Links</button><div role="tabpanel" aria-labelledby="other-links"><h2>Sources 1</h2><a href="https://unrelated.example/private">Unrelated citation</a></div></section>';
    const s=extract(page()+unrelated,'perplexity',question);
    expect(s).toMatchObject({responseComplete:true,sourcePanel:false});
    expect(s.citations.some((c:{url:string})=>c.url==='https://unrelated.example/private')).toBe(false);
  });
  it('keeps a linked source panel inside the response layout out of its answer fragments',()=>{
    const portal='<button aria-controls="source-portal" aria-expanded="true">Sources</button><div id="source-portal"><h2>Sources 1</h2><div class="prose"><a href="https://source.example/current">Source preview, not answer prose.</a></div></div>';
    const s=extract(page(body,'<button aria-label="Copy">Copy</button>'+portal),'perplexity',question);
    expect(s).toMatchObject({containerFound:true,responseComplete:true,sourcePanel:true,sourceCountExpected:1});
    expect(s.answer).not.toMatch(/Source preview|Sources 1/);
    expect(s.citations.find((c:{url:string})=>c.url==='https://source.example/current')?.placement).toBe('source_panel');
  });
  it('rejects inactive source tabs and controls pointing at the entire conversation',()=>{
    const inactive='<button role="tab" id="links-tab" aria-selected="false" aria-controls="links-panel">Links</button><div role="tabpanel" id="links-panel" aria-labelledby="links-tab"><a href="https://unknown.example">Unopened citation</a></div>';
    expect(extract(page()+inactive,'perplexity',question).sourcePanel).toBe(false);
    const broad=page().replace('<main>','<main id="conversation">').replace('</main>','<button aria-controls="conversation">Sources</button></main>');
    expect(extract(broad,'perplexity',question).sourcePanel).toBe(false);
  });
  const plainSourceLinks=(count:number,offset=0)=>Array.from({length:count},(_,index)=>`<a href="https://source${index+offset}.example/guide">Source ${index+offset}</a>`).join('');
  const plainPortal=(count=10,offset=0)=>`<div class="flex flex-col overflow-y-auto rounded-xl"><div class="flex flex-col"><button aria-expanded="true">Sources</button><div>${plainSourceLinks(count,offset)}</div></div></div>`;
  const plainGuest=(count=10)=>page(`<div class="prose"><p>Completed current response with seven inline source citations.</p>${plainSourceLinks(7)}</div>`,'<button aria-label="Copy">Copy</button><button>10 sources</button>').replace('</main>',plainPortal(count)+'</main>');
  it('reads the observed plain guest Sources sibling by its unique aggregate count and current citation overlap',()=>{
    // Shape derived from native Sources diagnostics: a 10-sources response
    // footer, expanded plain Sources button, and immediate parent with 10 links.
    const s=extract(plainGuest(),'perplexity',question);
    expect(s).toMatchObject({responseComplete:true,sourcePanel:true,sourceCountExpected:10});
    expect(s.citations).toHaveLength(10);expect(s.citations.every((c:{placement:string})=>c.placement==='source_panel')).toBe(true);
    expect(s.answer).not.toMatch(/Sources|Source 9/);
    expect(s.sourceDiagnostics.nodes.some((node:{kind:string;recognized?:boolean;linkCount:number})=>node.kind==='source_candidate'&&node.recognized&&node.linkCount===10)).toBe(true);
  });
  it('keeps the aggregate N while a plain Sources sibling is only partly hydrated',async()=>{
    const inspect=async()=>extract(plainGuest(3),'perplexity',question);
    const initial=await inspect();expect(initial).toMatchObject({sourcePanel:true,sourceCountExpected:10});
    expect(initial.citations.filter((c:{placement:string})=>c.placement==='source_panel')).toHaveLength(3);
    const sourceButton=(name:string,expanded=false)=>({isVisible:async()=>true,innerText:async()=>name,getAttribute:async(key:string)=>key==='aria-expanded'&&expanded?'true':null,click:async()=>{}});
    const result=await collectNewSurfaceSources('perplexity',{page:{getByRole:()=>({all:async()=>[sourceButton('10 sources'),sourceButton('Sources',true)]})},inspect,wait:async()=>{},check:()=>{}});
    expect(result).toMatchObject({citationControls:1,citationControlsOpened:1,citationsComplete:false});
    const complete=await collectNewSurfaceSources('perplexity',{page:{getByRole:()=>({all:async()=>[sourceButton('10 sources'),sourceButton('Sources',true)]})},inspect:async()=>extract(plainGuest(),'perplexity',question),wait:async()=>{},check:()=>{}});
    expect(complete).toMatchObject({citationControls:1,citationControlsOpened:1,citationsComplete:true});
  });
  it('rejects a sidebar plain Sources portal even when it copies the current citation URLs and count',()=>{
    const sidebar=plainGuest().replace(plainPortal(),'<aside>'+plainPortal()+'</aside>');
    expect(extract(sidebar,'perplexity',question)).toMatchObject({responseComplete:true,sourcePanel:false,sourceCountExpected:null});
  });
  it('rejects a different response node used as the plain Sources parent, including its own semantic marker',()=>{
    for(const marker of ['class="group/partition"','data-role="assistant"','data-testid="answer"']){
      const otherTurn=plainGuest().replace(plainPortal(),`<div ${marker}><button aria-expanded="true">Sources</button>${plainSourceLinks(10)}</div>`);
      expect(extract(otherTurn,'perplexity',question).sourcePanel).toBe(false);
    }
  });
  it('rejects a plain Sources sibling without overlap, an excess count, an unopened header or ambiguous panes',()=>{
    const fixtures=[plainGuest().replace(plainPortal(),plainPortal(10,100)),plainGuest(11),plainGuest().replace('aria-expanded="true"','aria-expanded="false"'),plainGuest().replace('</main>',plainPortal()+'</main>')];
    for(const html of fixtures)expect(extract(html,'perplexity',question)).toMatchObject({sourcePanel:false,sourceCountExpected:null});
  });
  it('requires one aggregate outside answer prose and an exact query before recognizing the plain portal',()=>{
    const ambiguous=plainGuest().replace('<button>10 sources</button>','<button>10 sources</button><button>5 sources</button>');
    expect(extract(ambiguous,'perplexity',question).sourcePanel).toBe(false);
    expect(extract(plainGuest(),'perplexity','Different submitted question').sourcePanel).toBe(false);
    const inlineOnly=plainGuest().replace('<button>10 sources</button>','').replace('</p>','</p><button>10 sources</button>');
    expect(extract(inlineOnly,'perplexity',question).sourcePanel).toBe(false);
  });
  it('diagnoses plain source headers and ancestors without promoting an unknown portal to complete sources',()=>{
    const unknown='<div id="private-portal-id" class="flex flex-col PRIVATE_CLASS"><div><span>Sources 3</span></div><a href="https://guide.example/shifts?tracking=PRIVATE_QUERY">Actual same source</a><a href="https://unrelated.example/PRIVATE_PATH">Unassociated private link</a></div>';
    const s=extract(page(body,'<button aria-label="Copy">Copy</button><button>3 sources</button>')+unknown,'perplexity',question);
    expect(s).toMatchObject({responseComplete:true,sourcePanel:false});
    const diagnostics=s.sourceDiagnostics;
    expect(diagnostics).toMatchObject({version:'visible-source-structure-v1',maxNodes:30,maxAncestors:5});
    expect(diagnostics.nodes.some((node:{kind:string;label?:string;declaredCount?:number})=>node.kind==='source_heading'&&node.label==='sources'&&node.declaredCount===3)).toBe(true);
    expect(diagnostics.nodes.some((node:{kind:string;ancestors:Array<{linkCount:number;currentCitationMatches:number}>})=>node.kind==='source_heading'&&node.ancestors.some(parent=>parent.linkCount===2&&parent.currentCitationMatches===1))).toBe(true);
    expect(diagnostics.currentCitationUrls).toEqual(['https://guide.example/shifts']);
    expect(JSON.stringify(diagnostics)).not.toMatch(/private-portal-id|PRIVATE_CLASS|PRIVATE_QUERY|PRIVATE_PATH|Unassociated private link/);
  });
  it('never places account, history, IDs, raw labels or conversation URLs in structural diagnostics',()=>{
    const unrelated='<aside class="SECRET_ACCOUNT"><button aria-label="Open profile menu for SECRET_PERSON">SECRET_NAME</button><button aria-controls="SECRET_TARGET">Sources</button><a href="https://www.perplexity.ai/search/SECRET_THREAD">SECRET_HISTORY</a><div id="SECRET_TARGET" data-testid="SECRET_TEST_ID"><p>Sources 1</p><a href="https://unrelated.example/SECRET_PATH?token=SECRET_TOKEN">SECRET_TITLE</a></div></aside>';
    const s=extract(page()+unrelated,'perplexity',question), serialized=JSON.stringify(s.sourceDiagnostics);
    expect(serialized).not.toMatch(/SECRET_|Sample Studio|7shifts|perplexity\.ai\/search/);
    expect(s.sourceDiagnostics.nodes.some((node:{kind:string;scope:string;ariaControlsPresent?:boolean})=>node.kind==='source_control'&&node.scope==='outside_response'&&node.ariaControlsPresent)).toBe(true);
    expect(s.sourceDiagnostics.currentCitationUrls).toEqual(['https://guide.example/shifts','https://product.example/plans']);
  });
  it('bounds structural nodes, ancestors and diagnostic URLs and reports truncation',()=>{
    const buttons=Array.from({length:50},(_,index)=>`<button>${index+1} sources</button>`).join('');
    const headers=Array.from({length:50},(_,index)=>`<span>Sources ${index+1}</span>`).join('');
    const dialogs=Array.from({length:50},()=>'<div role="dialog"><span>Unrelated visible prompt</span></div>').join('');
    const answer=Array.from({length:30},(_,index)=>`<a href="https://citation${index}.example/guide?q=PRIVATE_QUERY">Citation</a>`).join('');
    const diagnostics=extract(page('<div class="prose"><p>Current completed response.</p>'+answer+'</div>',buttons)+headers+dialogs,'perplexity',question).sourceDiagnostics;
    expect(diagnostics.nodes.length).toBeLessThanOrEqual(30);expect(diagnostics.nodesTruncated).toBe(true);
    for(const node of diagnostics.nodes)expect(node.ancestors.length).toBeLessThanOrEqual(5);
    expect(diagnostics.currentCitationUrls).toHaveLength(20);expect(diagnostics.citationUrlsTruncated).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_QUERY');
  });
  it('leaves structural source diagnostics disabled on other providers',()=>{
    expect(extract('<div data-message-author-role="assistant"><p>Current answer.</p></div>').sourceDiagnostics).toBe(null);
  });
  it('identifies only the exact completed current reply as a Perplexity login notice',()=>{
    const gate=page('<div>Sign up and repeat your request.</div>','<button aria-label="Copy">Copy</button><button>Share</button><button>Helpful</button>');
    expect(extract(gate,'perplexity',question)).toMatchObject({accessNotice:'login',accessNoticeSource:'current_reply',accessNoticeMessage:'Sign up and repeat your request.',answer:'',containerFound:false,responseComplete:false});
    expect(extract(gate,'perplexity','Different submitted question').accessNotice).toBe(null);
    expect(extract(gate,'perplexity').accessNotice).toBe(null);
    expect(extract(gate.replace('group/partition group/final-text','layout-only'),'perplexity',question).accessNotice).toBe(null);
  });
  it('does not turn a quoted instruction, sidebar notice or marketing copy into a login gate',()=>{
    const fixtures=[page('<blockquote>Sign up and repeat your request.</blockquote>'),page('<code>Sign up and repeat your request.</code>'),page('<p>Example instruction: Sign up and repeat your request.</p>'),page()+ '<aside><div class="group/final-text">Sign up and repeat your request.<button>Copy</button></div></aside>',page().replace('</main>','<p>Sign up and repeat your request.</p></main>')];
    for(const html of fixtures)expect(extract(html,'perplexity',question).accessNotice).toBe(null);
  });
  it('does not attribute an old gate to a later reply or a new question',()=>{
    const oldGate='<div class="group/partition">Sign up and repeat your request.<button aria-label="Copy">Copy</button></div>';
    expect(extract(page().replace(`<h1>${question}</h1>`,oldGate+`<h1>${question}</h1>`),'perplexity',question).accessNotice).toBe(null);
    const later=page('<div>Sign up and repeat your request.</div>').replace('</main>','<h1>Unrelated newer question</h1><div class="group/final-text"><p>Different response.</p><button>Copy</button></div></main>');
    expect(extract(later,'perplexity',question).accessNotice).toBe(null);
    const userGate=page('<div>Sign up and repeat your request.</div>').replace('class="group/partition group/final-text"','class="group/partition group/final-text" data-role="user"');
    expect(extract(userGate,'perplexity',question).accessNotice).toBe(null);
  });
  it('requires visible query evidence and completed controls before classifying the exact gate',()=>{
    const gate=page('<div>Sign up and repeat your request.</div>');
    const hiddenQuery=gate.replace(`<h1>${question}</h1>`,`<h1><span hidden>${question}</span></h1>`);
    expect(extract(hiddenQuery,'perplexity',question).accessNotice).toBe(null);
    expect(extract(gate.replace('<button aria-label="Copy">Copy</button>',''),'perplexity',question).accessNotice).toBe(null);
    expect(extract(gate.replace('class="group/partition group/final-text"','class="group/partition group/final-text" aria-busy="true"'),'perplexity',question).accessNotice).toBe(null);
    expect(extract(gate,'grok',question).accessNotice).toBe(null);
  });
  const loginDialog='<div role="dialog" aria-modal="true"><h2>Sign in to continue using Perplexity</h2><button>Continue with Google</button><button>Continue with Apple</button><input type="email" placeholder="Enter your email"><button disabled>Continue with email</button></div>';
  it('identifies the observed modal login dialog only from its complete fixed title and available auth controls',()=>{
    const s=extract(loginDialog,'perplexity');
    expect(s).toMatchObject({accessNotice:'login',accessNoticeSource:'login_dialog',accessNoticeMessage:'Sign in to continue using Perplexity',answer:'',responseComplete:false});
    const both=page('<div>Sign up and repeat your request.</div>')+loginDialog;
    expect(extract(both,'perplexity',question).accessNoticeSource).toBe('login_dialog');
  });
  it('also recognizes a fixed login dialog without requiring an HTML form or aria-modal',()=>{
    const fixed=loginDialog.replace('aria-modal="true"','style="position:fixed"').replace('<button>Continue with Google</button>','').replace('type="email"','type="text" autocomplete="email"');
    expect(extract(fixed,'perplexity')).toMatchObject({accessNotice:'login',accessNoticeSource:'login_dialog'});
    expect(extract(fixed.replace('position:fixed','position:absolute'),'perplexity').accessNotice).toBe(null);
  });
  it('rejects hidden dialog titles, email inputs and provider buttons or providers that are disabled',()=>{
    const fixtures=[`<section hidden>${loginDialog}</section>`,loginDialog.replace('role="dialog"','role="dialog" hidden'),loginDialog.replace('role="dialog"','role="dialog" style="display:none"'),loginDialog.replace('<h2>','<h2 hidden>'),loginDialog.replace('type="email"','type="email" hidden'),loginDialog.replace('<button>Continue with Google</button><button>Continue with Apple</button>','<button disabled>Continue with Google</button><button aria-disabled="true">Continue with Apple</button>'),loginDialog.replace('<button>Continue with Google</button><button>Continue with Apple</button>','<button><span hidden>Continue with Google</span></button>')];
    for(const html of fixtures)expect(extract(html,'perplexity').accessNotice).toBe(null);
  });
  it('rejects login-looking dialogs embedded in sidebar, navigation, quoted or message content',()=>{
    for(const wrapper of ['aside','nav','blockquote','code','section data-role="user"','section data-role="assistant"','div class="group/final-text"','div class="prose"']){
      const tag=wrapper.split(' ')[0];expect(extract(`<${wrapper}>${loginDialog}</${tag}>`,'perplexity').accessNotice).toBe(null);
    }
    expect(extract(loginDialog.replace('<h2>','<blockquote><h2>').replace('</h2>','</h2></blockquote>'),'perplexity').accessNotice).toBe(null);
  });
  it('does not infer a login wall from marketing copy, incomplete auth forms or another provider',()=>{
    const fixtures=[loginDialog.replace('Sign in to continue using Perplexity','Sign in to save and sync your searches'),loginDialog.replace('<input type="email" placeholder="Enter your email">',''),loginDialog.replace('<button>Continue with Google</button><button>Continue with Apple</button>','<a>Continue with Google</a>'),loginDialog.replace('aria-modal="true"',''),loginDialog.replace('role="dialog"','role="region"')];
    for(const html of fixtures)expect(extract(html,'perplexity').accessNotice).toBe(null);
    expect(extract(loginDialog,'grok')).toMatchObject({accessNotice:null,accessNoticeSource:null,accessNoticeMessage:null});
  });
});

describe('positive account and privacy controls',()=>{
  it('does not infer login from missing sign-in controls or from answer content',()=>{
    expect(extract('<div data-message-author-role="assistant">You are logged in</div>').signedIn).toBe(false);
    expect(extract('<button aria-label="Open profile menu">Account</button>').signedIn).toBe(true);
    expect(extract('<button aria-label="Open profile menu">Account</button><button>Log in</button>').signedIn).toBe(false);
  });
  it('requires an active Unpersonalized control, not its label alone',()=>{
    expect(extract('<button>Unpersonalized</button>').personalizationDisabled).toBe(false);
    const s=extract('<button aria-label="Open profile menu">Account</button><button aria-pressed="true">Temporary</button><button role="radio" aria-checked="true">Unpersonalized</button>');
    expect(s).toMatchObject({signedIn:true,temporaryChat:true,personalizationDisabled:true});
  });
  it('reads Google personalization status from footer UI, not an answer claiming that status',()=>{
    const s=extract('<a aria-label="Google Account: private@example.test">Avatar</a><footer>Results are not personalized</footer>','google_aio');
    expect(s).toMatchObject({signedIn:true,personalizationDisabled:true});
    expect(extract('<section><h2>AI Overview</h2><p>Results are not personalized</p></section>','google_aio').personalizationDisabled).toBe(false);
  });
});

describe('consumer Copilot account-menu evidence',()=>{
  const menu='<div role="menu"><button role="menuitem" aria-label="Sign out">Sign out</button></div>';
  const read=(html:string,base='https://copilot.microsoft.com/')=>extract(html,'bing_copilot',undefined,base);
  it('requires an enabled native sign-out control rather than a settings or profile menu trigger',()=>{
    for(const label of ['Settings and more','Settings','Menu','Open account menu','Open profile menu','Account settings']){
      expect(read(`<button aria-label="${label}"></button>`)).toMatchObject({signedIn:false,copilotAccountMenuSignedIn:false});
    }
    for(const base of ['https://copilot.microsoft.com/','https://copilot.com/']){
      expect(read('<button aria-label="Menu"></button>'+menu,base)).toMatchObject({signedIn:true,copilotAccountMenuSignedIn:true,signedOut:false});
      expect(read('<div role="dialog" aria-label="Account settings"><a aria-label="Log out"></a></div>',base).signedIn).toBe(true);
    }
  });
  it('does not accept hidden, disabled or unrelated-dialog sign-out controls',()=>{
    for(const html of [
      `<div hidden>${menu}</div>`,menu.replace('role="menu"','role="menu" aria-hidden="true"'),
      menu.replace('role="menu"','role="menu" style="display:none"'),menu.replace('role="menuitem"','role="menuitem" disabled'),
      menu.replace('role="menuitem"','role="menuitem" aria-disabled="true"'),
      '<div role="dialog" aria-label="Sources"><button>Sign out</button></div>',
      '<button>Sign out</button>',
    ])expect(read(html)).toMatchObject({signedIn:false,copilotAccountMenuSignedIn:false});
  });
  it('does not take account state from assistant/user content, quotes or forms',()=>{
    for(const wrapper of [
      ['<div data-content="ai-message">','</div>'],['<div data-message-author-role="user">','</div>'],
      ['<div data-message-author-role="assistant">','</div>'],['<div class="prose">','</div>'],
      ['<div data-content="user-message">','</div>'],['<div data-testid="user-message">','</div>'],
      ['<article data-role="user">','</article>'],['<div data-testid="user-query">','</div>'],
      ['<aside data-testid="sources-panel">','</aside>'],['<section data-testid="source-list">','</section>'],
      ['<blockquote>','</blockquote>'],['<pre>','</pre>'],['<form>','</form>'],
    ])expect(read(wrapper[0]+menu+wrapper[1])).toMatchObject({signedIn:false,copilotAccountMenuSignedIn:false});
    expect(read('<div data-message-author-role="assistant"><button aria-label="Sign in"></button></div>').signedOut).toBe(false);
  });
  it('recognizes aria-only sign-in in native chrome and refuses conflicting account evidence',()=>{
    expect(read('<button aria-label="Sign in"></button>')).toMatchObject({signedIn:false,signedOut:true});
    expect(read('<form><button aria-label="Sign in"></button></form>').signedOut).toBe(true);
    expect(read(menu+'<button aria-label="Sign in"></button>')).toMatchObject({signedIn:false,signedOut:true});
    expect(read('<div role="menu"><div role="menuitem" aria-label="Sign in"></div></div>').signedOut).toBe(true);
  });
  it('requires an official HTTPS consumer origin and preserves the M365 sign-out-ID signal',()=>{
    for(const base of ['https://copilot.microsoft.com.evil.example/','http://copilot.microsoft.com/','https://private:secret@copilot.com/','https://copilot.com:8443/'])expect(read(menu,base).signedIn).toBe(false);
    expect(read('<button id="me-control-sign-out-button">Sign out</button>','https://m365.cloud.microsoft/chat')).toMatchObject({signedIn:true,copilotAccountMenuSignedIn:false});
    for(const base of ['https://unrelated.invalid/','http://m365.cloud.microsoft/chat','https://m365.cloud.microsoft.evil.example/chat','https://m365.cloud.microsoft/search','https://copilot.microsoft.com/']){
      expect(read('<button id="me-control-sign-out-button">Sign out</button>',base).signedIn).toBe(false);
    }
  });
});
