// Consumer web adapters only. No API fallback, account-store access or CAPTCHA handling.
const NEW_SURFACES = new Set(['bing_copilot', 'perplexity', 'grok']);
const surfaceUrls = Object.freeze({
  google_aio: 'https://www.google.com/',
  chatgpt_search: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
  bing_copilot: 'https://copilot.microsoft.com/',
  perplexity: 'https://www.perplexity.ai/',
  grok: 'https://grok.com/',
  duckduckgo_search_assist: 'https://duckduckgo.com/',
});
function officialSurfaceUrl(surface,raw){
  try{
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return false;
    if(surface==='google_aio')return ['google.com','www.google.com','google.ca','www.google.ca','google.co.uk','www.google.co.uk','google.com.au','www.google.com.au'].includes(url.hostname)&&['/','/search'].includes(url.pathname);
    if(surface==='bing_copilot')return ['copilot.microsoft.com','copilot.com'].includes(url.hostname)||['bing.com','www.bing.com'].includes(url.hostname)&&/^\/(chat|copilot)(?:\/|$)/.test(url.pathname)||url.hostname==='m365.cloud.microsoft'&&/^\/chat(?:\/|$)/.test(url.pathname);
    if(surface==='duckduckgo_search_assist')return ['duckduckgo.com','www.duckduckgo.com'].includes(url.hostname)&&['/','/html','/html/'].includes(url.pathname);
    const root=surfaceUrls[surface];
    if(!root)return false;
    const host=new URL(root).hostname;
    return url.hostname===host||host.startsWith('www.')&&url.hostname===host.slice(4);
  }catch{return false;}
}
function inputSelector(surface) {
  switch (surface) {
    case 'google_aio': return 'textarea[name="q"],input[name="q"]';
    case 'chatgpt_search': return '#prompt-textarea,[contenteditable="true"][role="textbox"],textarea[placeholder]';
    case 'gemini': return 'rich-textarea [contenteditable="true"],[contenteditable="true"][role="textbox"],textarea[placeholder]';
    case 'bing_copilot': return '#m365-chat-editor-target-element[contenteditable="true"],#userInput,textarea[data-testid="composer-input"],textarea[placeholder],[contenteditable="true"][role="textbox"]';
    case 'perplexity': return '#ask-input[contenteditable="true"],textarea[placeholder],[contenteditable="true"][role="textbox"],[contenteditable="true"][data-lexical-editor="true"]';
    case 'grok': return 'textarea[placeholder="Ask Grok anything"],textarea[placeholder],[contenteditable="true"][role="textbox"],[contenteditable="true"][data-placeholder]';
    case 'duckduckgo_search_assist': return 'textarea[name="q"],input[name="q"]';
    default: throw new Error('未支持的浏览器采样入口');
  }
}
// A More button is eligible only inside the bounded Search Assist feature. A
// search result titled "Search Assist" must never turn its controls into UI.
function duckduckgoAssistControl(el) {
  const organic='[data-testid="result"],.result--web,.results_links_deep,nav,form';
  if(el.closest(organic))return false;
  for(let parent=el.parentElement,depth=0;parent&&depth<7;parent=parent.parentElement,depth++){
    if(parent.matches('body,html,main,[role="main"]')||parent.querySelector('[data-testid="result"],.result--web,.results_links_deep'))break;
    if(parent.matches('[data-testid="search-assist"],[data-testid="search-assist-module"],[data-module="SearchAssist"],[data-module="SearchAssistMainline"],section[aria-label="Search Assist"],[role="region"][aria-label="Search Assist"]'))return true;
    if([...parent.querySelectorAll('h1,h2,h3,h4,[role="heading"]')].some(h=>/^(Search Assist|搜索助手)$/i.test((h.innerText||h.textContent||'').trim())))return true;
  }
  return false;
}
async function expandDuckDuckGoSearchAssist(page) {
  const matches=[];
  for(const button of await page.getByRole('button',{name:/^(More|Show more|Read more|Expand|显示更多|展开|更多)$/i}).all()){
    if(await button.isVisible()&&await button.isEnabled()&&await button.evaluate(duckduckgoAssistControl))matches.push(button);
  }
  if(matches.length!==1)return {expanded:false,ambiguous:matches.length>1};
  await matches[0].click({timeout:5000});
  return {expanded:true,ambiguous:false};
}
function sourceControlName(surface) {
  switch (surface) {
    case 'bing_copilot': return /^(?:Sources|View sources|Show sources|See all sources|Show all sources|\d+ sources|Sources\s*\d+|来源|查看来源|显示来源)(?:\s*\(\d+\))?$/i;
    case 'perplexity': return /^(?:Sources|View sources|Show all sources|See all sources|\d+ sources|Sources\s*\d+|\d+\s*来源|来源|查看来源|显示所有来源)(?:\s*\(\d+\))?$/i;
    case 'grok': return /^(?:Sources|View sources|Show sources|View all sources|\d+ sources|Sources\s*\d+|\d+\s*来源|来源|查看来源|显示来源)(?:\s*\(\d+\))?$/i;
    default: throw new Error('未支持的来源面板入口');
  }
}
function freshEntryUrl(surface, preparedUrl) {
  const url = new URL(preparedUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('登录准备页面并非此入口的官方 HTTPS 页面');
  if (surface === 'bing_copilot') {
    if (['copilot.microsoft.com', 'copilot.com'].includes(url.hostname)) return url.origin + '/';
    if (['bing.com', 'www.bing.com'].includes(url.hostname) && /^\/(chat|copilot)(?:\/|$)/.test(url.pathname)) return url.origin + '/' + url.pathname.split('/')[1];
    if (url.hostname === 'm365.cloud.microsoft' && /^\/chat(?:\/|$)/.test(url.pathname)) return url.origin + '/chat';
    throw new Error('登录准备页面不是 Copilot 对话入口');
  }
  const root = surfaceUrls[surface];
  if (!root || ![new URL(root).hostname, new URL(root).hostname.replace(/^www\./, '')].includes(url.hostname)) throw new Error('登录准备页面不属于此 AI 入口');
  return root;
}
async function affirmCopilotAccount(surface, page, read) {
  const initial = await read();
  if (surface !== 'bing_copilot') return initial;
  // Validate the current URL after the initial read; a stale positive snapshot must
  // not bypass the official-origin check after navigation.
  let url;
  try{url=new URL(page.url());}catch{return {...initial,signedIn:false,accountVerified:false};}
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return {...initial,signedIn:false,accountVerified:false};
  const consumer=['copilot.microsoft.com','copilot.com'].includes(url.hostname);
  const m365=url.hostname==='m365.cloud.microsoft'&&/^\/chat(?:\/|$)/.test(url.pathname);
  if(!consumer&&!m365)return {...initial,signedIn:false,accountVerified:false};
  if(initial.signedIn)return initial;
  if(consumer){
    // Supported accessible names are intentionally narrow. This is not a claim about
    // a particular live DOM release; a bare Menu button needs separate verification.
    const names=/^(Settings(?: and more)?|Open settings menu|Account settings|Open (?:account|profile) menu|设置(?:和更多|与更多)?|打开设置菜单|账户设置|打开(?:账户|个人资料)菜单)$/i;
    const exclude='[data-content="ai-message"],[data-testid="ai-message"],[data-testid="assistant-message"],[data-testid="answer"],[data-testid="answer-content"],[data-message-author-role],[data-role="assistant"],[data-role="user"],[data-content="user-message"],[data-testid="user-message"],[data-content="question-message"],[data-testid="question-message"],[data-testid="user-query"],[data-testid="query"],[data-testid="sources-panel"],[data-testid="source-list"],[aria-label="Sources"],inline-source-card,.source-inline-chip-container,.markdown,.prose,blockquote,q,pre,code,[contenteditable],textarea,input,form';
    const controls=[];
    for(const control of await page.getByRole('button',{name:names}).all()){
      if(await control.isVisible()&&await control.isEnabled()&&await control.evaluate((el,selector)=>!el.closest(selector),exclude))controls.push(control);
    }
    if(controls.length!==1)return initial;
    const sameEntry=()=>{
      try{const after=new URL(page.url());return after.protocol==='https:'&&after.origin===url.origin&&!after.username&&!after.password;}catch{return false;}
    };
    let opened;
    try{
      await controls[0].click({timeout:5000});
      if(sameEntry())opened=await read();
    }finally{
      // A failed menu read or a click that took effect before timing out must not
      // leave the settings overlay open. No Sign-out or authentication action is clicked.
      await page.keyboard.press('Escape');
    }
    if(!sameEntry()||!opened)return {...initial,signedIn:false,accountVerified:false};
    const closed=await read();
    if(!sameEntry())return {...closed,signedIn:false,accountVerified:false};
    return opened.copilotAccountMenuSignedIn&&!opened.signedOut&&!closed.signedOut?{...closed,signedIn:true,accountVerified:true}:closed;
  }
  // The observed Microsoft account control is an unlabeled-in-code global div. Do not
  // read or retain its user-name aria label; ambiguity fails closed without clicking.
  const controls = [];
  for (const control of await page.locator('div[role="button"][aria-label]').all()) if (await control.isVisible()) controls.push(control);
  if (controls.length !== 1) return initial;
  let opened;
  try{
    await controls[0].click({ timeout: 5000 });
    opened = await read();
  }finally{
    await page.keyboard.press('Escape');
  }
  const closed = await read();
  const after=new URL(page.url());
  if(after.origin!==url.origin||!/^\/chat(?:\/|$)/.test(after.pathname))return {...closed,signedIn:false,accountVerified:false};
  return opened.signedIn && !closed.signedOut ? { ...closed, signedIn: true, accountVerified: true } : closed;
}
async function dismissPerplexityOverlays(page, { body = '', hasInput = false, allowClose = true, allowDecline = true } = {}) {
  // Only initial optional native overlays. Do not click Sign in, grant tracking consent,
  // dismiss CAPTCHA, or conceal a login wall that has no Close control.
  let declined = false, closed = false;
  const decline = page.getByRole('button', { name: /^(Decline optional|Decline|Decline all|Reject all|拒绝|全部拒绝)$/i });
  if(allowDecline)for (const button of await decline.all()) if (await button.isVisible()) { await button.click({ timeout: 5000 }); declined = true; break; }
  if(allowClose&&hasInput&&/Login or sign\s?up for free|Save and sync your searches/i.test(body)){
    const close = [];
    for(const button of await page.getByRole('button', { name: /^(Close|关闭)$/i }).all())if(await button.isVisible())close.push(button);
    if(close.length===1){await close[0].click({timeout:5000});closed=true;}
  }
  return { declined, closed };
}
// Count only native Sources controls, never follow the cited external links.
async function collectNewSurfaceSources(surface, { page, inspect, wait, check }) {
  const visibleControls = [], expectedCounts = new Map();
  for (const button of await page.getByRole('button', { name: sourceControlName(surface) }).all()) {
    if (await button.isVisible()) {
      visibleControls.push(button);
      const label = (await button.getAttribute('aria-label') || '') + ' ' + (typeof button.innerText === 'function' ? await button.innerText() : '');
      const countMatch = label.match(/(?:^|\s)(\d+)\s+sources\b|\bSources\s*\(?(\d+)\)?\b|(\d+)\s*来源/i);
      if(countMatch)expectedCounts.set(button,Number(countMatch[1]||countMatch[2]||countMatch[3]));
    }
  }
  // Observed Perplexity has generic inline Sources buttons plus one N-sources
  // response footer. Open the unique counted aggregate once, rather than toggling
  // the same portal through both an inline preview and its aggregate control.
  const counted=visibleControls.filter(button=>expectedCounts.has(button));
  const all=surface==='perplexity'&&counted.length===1?counted:visibleControls;
  let snapshot = await inspect(), opened = 0, allPanelsCovered = true;
  const merged = new Map(snapshot.citations.map(c => [c.url, c]));
  let unresolved = snapshot.unresolvedCitations || 0, overflow = snapshot.citationOverflow || 0;
  const notes = [];
  for (const control of all.slice(0, 100)) {
    try {
      check();
      const controlExpected = expectedCounts.get(control) ?? null;
      // An already visible bounded source list is still inspected, without toggling it closed.
      if (await control.getAttribute('aria-expanded') !== 'true') await control.click({ timeout: 5000 });
      let panelCount=0,expectedRange=controlExpected??0,explicitZeroRange=controlExpected===0;
      // Source portals and their cards hydrate after the control itself opens. Poll
      // the same opening at most five times; never click again or resend the question.
      for(let panelRead=0;panelRead<5;panelRead++){
        await wait();snapshot=await inspect();
        panelCount=new Set(snapshot.citations.filter(c=>c.placement==='source_panel').map(c=>c.url)).size;
        explicitZeroRange=explicitZeroRange||snapshot.sourceCountExpected===0;
        if(snapshot.sourcePanelHasMore||snapshot.unresolvedCitations||snapshot.citationOverflow)break;
        expectedRange=Math.max(expectedRange,snapshot.sourceCountExpected??0);
        if(snapshot.sourcePanel&&panelCount>0&&panelCount>=expectedRange)break;
      }
      if (snapshot.sourcePanel && panelCount > 0) opened++;
      else { allPanelsCovered = false; notes.push('来源控件未提供可辨认的来源面板；来源范围未确认完整'); }
      if (explicitZeroRange || expectedRange > panelCount || snapshot.sourcePanelHasMore || snapshot.unresolvedCitations || snapshot.citationOverflow) allPanelsCovered = false;
      if(explicitZeroRange)notes.push('来源控件或面板显示零条来源；面板中的其他链接不能证明完整引用范围');
      for (const citation of snapshot.citations) merged.set(citation.url, citation);
      unresolved = Math.max(unresolved, snapshot.unresolvedCitations || 0);
      overflow = Math.max(overflow, snapshot.citationOverflow || 0);
    } catch {
      allPanelsCovered = false;
      notes.push('来源控件未能展开；保留已取得的原文与引用，不自动重发问题');
      break;
    }
  }
  // Non-empty inline links alone cannot prove that the complete source range was collected.
  const citationsComplete = all.length > 0 && all.length <= 100 && opened === all.length && allPanelsCovered &&
    snapshot.sourcePanel && merged.size > 0 && merged.size <= 100 && !unresolved && !overflow &&
    !snapshot.sourcePanelHasMore;
  notes.push(`可见来源控件 ${all.length} 个，成功读取 ${opened} 个`);
  return {
    snapshot: { ...snapshot, citations: [...merged.values()].slice(0, 100), unresolvedCitations: unresolved,
      citationOverflow: overflow + Math.max(0, merged.size - 100) },
    citationControls: all.length, citationControlsOpened: opened, citationsComplete: !!citationsComplete, notes,
  };
}
module.exports = { NEW_SURFACES, surfaceUrls, inputSelector, sourceControlName, freshEntryUrl, affirmCopilotAccount, dismissPerplexityOverlays, collectNewSurfaceSources, duckduckgoAssistControl, expandDuckDuckGoSearchAssist, officialSurfaceUrl };
