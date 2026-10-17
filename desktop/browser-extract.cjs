/* Pure visible-page reader. Kept self-contained so Playwright can serialize it.
 * No requests, page scripts, hidden service APIs, cookies or account storage. */
function extractVisiblePage(input) {
  const doc = input.document || document;
  const surface = input.surface;
  const visible = (el) => {
    if (!el || el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent.hidden||parent.getAttribute('aria-hidden')==='true')return false;
    const style = doc.defaultView?.getComputedStyle?.(el);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    if (typeof el.getBoundingClientRect === 'function') { const r = el.getBoundingClientRect(); if (!r.width && !r.height) return false; }
    return true;
  };
  const text = el => (el?.innerText || el?.textContent || '').trim();
  const visibleAll = (selector, root = doc) => [...root.querySelectorAll(selector)].filter(visible);
  const body = text(doc.body).slice(0, 35000);
  const headings = visibleAll('h1,h2,h3,h4,[role="heading"]');
  const newSurface=['bing_copilot','perplexity','grok'].includes(surface);
  // Account evidence belongs to native chrome, never an answer, quoted example or composer.
  const copilotNonAccountSelector='[data-content="ai-message"],[data-testid="ai-message"],[data-testid="assistant-message"],[data-testid="answer"],[data-testid="answer-content"],[data-message-author-role],[data-role="assistant"],[data-role="user"],[data-content="user-message"],[data-testid="user-message"],[data-content="question-message"],[data-testid="question-message"],[data-testid="user-query"],[data-testid="query"],[data-testid="sources-panel"],[data-testid="source-list"],[aria-label="Sources"],inline-source-card,.source-inline-chip-container,.markdown,.prose,blockquote,q,pre,code,[contenteditable],textarea,input';
  const nativeAccountUi=el=>{
    if(el.closest(copilotNonAccountSelector+',model-response,[data-message-author-role="model"],.model-response-text,[class~="group/partition"],[class~="group/final-text"],article[aria-label="Grok"],.response-content-markdown,#search,#rso,[data-testid="result"],.result--web,.results_links_deep,[data-testid="search-assist"],[data-testid="search-assist-module"],[data-module="SearchAssist"],section[aria-label="Search Assist"]'+(surface==='bing_copilot'?'':',form')))return false;
    for(let parent=el.parentElement,depth=0;parent&&depth<6;parent=parent.parentElement,depth++){
      if(parent.matches('body,html,main,[role="main"]'))break;
      if(visibleAll('h1,h2,h3,h4,[role="heading"]',parent).some(h=>/^(Sources|来源|Sources citées|Search Assist|搜索助手)(?:\s*\(?\d+\)?)?$/i.test(text(h))))return false;
    }
    return true;
  };
  const copilotAccountUi=el=>!el.closest(copilotNonAccountSelector+',form');
  const accountLabel=el=>(el.getAttribute('aria-label')||text(el)).replace(/\s+/g,' ').trim();
  let copilotConsumerPage=false,copilotM365Page=false;
  if(surface==='bing_copilot')try{
    const url=new URL(doc.URL||doc.baseURI);
    const officialHttps=url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443');
    copilotConsumerPage=officialHttps&&['copilot.microsoft.com','copilot.com'].includes(url.hostname);
    copilotM365Page=officialHttps&&url.hostname==='m365.cloud.microsoft'&&/^\/chat(?:\/|$)/.test(url.pathname);
  }catch{}
  const copilotAccountMenuSignedIn=surface==='bing_copilot'&&copilotConsumerPage&&visibleAll('[role="menu"],[role="dialog"][aria-label]').some(menu=>{
    if(!copilotAccountUi(menu)||menu.getAttribute('role')==='dialog'&&!/^(Settings(?: and more)?|Account(?: settings)?|Profile(?: settings)?|设置(?:和更多|与更多)?|账户(?:设置)?|帐号(?:设置)?|个人资料(?:设置)?)$/i.test(menu.getAttribute('aria-label')||''))return false;
    return visibleAll('a,button,[role="button"],[role="menuitem"]',menu).some(el=>copilotAccountUi(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&/^(Sign out|Log out|Logout|退出登录|注销|Se déconnecter|Déconnexion)$/i.test(accountLabel(el)));
  });
  let signedOut = visibleAll(surface==='bing_copilot'?'a,button,[role="button"],[role="menuitem"]':'a,button,[role="button"]').some(el => {
    if(!nativeAccountUi(el))return false;
    const label=accountLabel(el);
    return /^(log in|sign in|登录|登入|se connecter|connexion)$/i.test(label) || newSurface && /^(sign up|注册)$/i.test(label);
  });
  const accountControl=surface==='chatgpt_search'
    ? visibleAll('button,[role="button"]').some(el=>nativeAccountUi(el)&&/open profile menu|打开个人资料菜单|打开个人菜单/i.test(el.getAttribute('aria-label')||''))
    : surface==='gemini'||surface==='google_aio'
      ? visibleAll('a,button,[role="button"]').some(el=>nativeAccountUi(el)&&/^(Google Account|Google 帐号|Google 账号|Compte Google)/i.test(el.getAttribute('aria-label')||''))
      : surface==='bing_copilot'
        ? copilotM365Page&&visibleAll('#me-control-sign-out-button').some(el=>copilotAccountUi(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true')||copilotAccountMenuSignedIn
        : visibleAll('button,[role="button"]').some(el=>nativeAccountUi(el)&&/^(Open (?:profile|account|user) menu|Account settings|Profile settings|User profile|Account manager|打开个人资料菜单|账户设置)$/i.test(el.getAttribute('aria-label')||''));
  // DuckDuckGo Search is accountless. A native search form on the official
  // HTTPS origin proves the guest surface without inventing a Sign-in button.
  if(surface==='duckduckgo_search_assist')try{
    const url=new URL(doc.URL||doc.baseURI);
    signedOut=url.protocol==='https:'&&['duckduckgo.com','www.duckduckgo.com'].includes(url.hostname)&&!url.username&&!url.password&&(!url.port||url.port==='443')&&
      !!visibleAll('textarea[name="q"],input[name="q"]').length&&!accountControl;
  }catch{signedOut=false;}
  const accountConflict=signedOut&&accountControl;
  const signedIn=!signedOut && accountControl;
  const controls=visibleAll('button,[role="button"],[role="radio"],[role="checkbox"],label');
  const selected=(re)=>controls.some(el=>re.test(text(el)) && (el.getAttribute('aria-checked')==='true'||el.getAttribute('aria-pressed')==='true'||el.getAttribute('data-state')==='checked'||el.getAttribute('data-state')==='active'||el.querySelector('input:checked')));
  const temporaryChat=surface==='chatgpt_search' && (selected(/^(Temporary|临时对话|临时聊天)$/i) || /(?:Temporary chat|临时对话|临时聊天)(?:\n|$)/i.test(body));
  const personalizationDisabled=surface==='google_aio'
    ? visibleAll('#fbar,footer,[role="contentinfo"]').some(el=>/Results are not personali[sz]ed|结果未经个性化处理|结果未经过个性化处理|非个性化搜索结果/i.test(text(el)))
    : selected(/^(Unpersonalized|非个性化|不进行个性化)$/i) || /(?:This chat|Temporary chat).{0,80}(?:won't|will not|does not) use (?:your )?(?:memories|memory)|此(?:临时)?对话不会使用.{0,12}记忆/i.test(body);
  let container = null, responseRoot = null, triggered = false, verifiedSinglePerplexityTurn = null, answerContainers = null, perplexityQueryFallback = false, linkedPerplexitySourcePanels = [], perplexitySourceRelations = [], accessNotice = null, accessNoticeSource = null, accessNoticeMessage = null;
  let duckduckgoAssist=null,duckduckgoSources=null,duckduckgoHasMore=false;
  if (surface === 'google_aio') {
    const h = headings.find(el => /^(AI Overview|AI Overviews|AI 概览|AI概览|AI 摘要|Aperçu IA|Aperçu de l’IA|Résumé généré par l’IA)$/i.test(text(el)));
    triggered = !!h;
    if (h) {
      let el = h.parentElement;
      for (let i = 0; el && i < 9; i++, el = el.parentElement) {
        const t = text(el);
        if (el === doc.body || el === doc.documentElement || /People also ask|用户还搜索了|相关问题|赞助商搜索结果/.test(t)) break;
        if (t.length > 65000 || /(?:^|\n)(Web results|People also ask|相关问题|用户还搜索了|搜索结果|赞助商搜索结果)(?:\n|$)/i.test(t)) break;
        if (t.length > text(h).length + 50) container = el;
      }
    }
  } else if(surface==='duckduckgo_search_assist'){
    const organic='[data-testid="result"],.result--web,.results_links_deep,nav,form';
    const nativeRoots=visibleAll('[data-testid="search-assist"],[data-testid="search-assist-module"],[data-module="SearchAssist"],[data-module="SearchAssistMainline"],section[aria-label="Search Assist"],[role="region"][aria-label="Search Assist"]')
      .filter(el=>!el.closest(organic)&&!el.querySelector('[data-testid="result"],.result--web,.results_links_deep'));
    const h=headings.find(el=>/^(Search Assist|搜索助手)$/i.test(text(el))&&!el.closest(organic));
    if(nativeRoots.length===1)duckduckgoAssist=nativeRoots[0];
    else if(!nativeRoots.length&&h){
      for(let parent=h.parentElement,depth=0;parent&&depth<6;parent=parent.parentElement,depth++){
        if(parent.matches('body,html,main,[role="main"]')||parent.querySelector('[data-testid="result"],.result--web,.results_links_deep'))break;
        if(text(parent).length>text(h).length+40&&visibleAll('a[href]',parent).length){duckduckgoAssist=parent;break;}
      }
    }
    triggered=!!duckduckgoAssist;
    if(duckduckgoAssist){
      responseRoot=duckduckgoAssist;
      const sources=visibleAll('[data-testid="search-assist-sources"],[data-testid="search-assist-source-list"],[aria-label="Sources"],footer',duckduckgoAssist)
        .filter(el=>visibleAll('a[href]',el).length);
      if(sources.length===1)duckduckgoSources=sources[0];
      const authored=visibleAll('[data-testid="search-assist-answer"],[data-testid="search-assist-content"],.markdown,.prose',duckduckgoAssist)
        .filter(el=>!duckduckgoSources?.contains(el)&&!el.closest('[data-testid="search-assist-sources"],[data-testid="search-assist-source-list"],[aria-label="Sources"],footer'));
      const top=authored.filter(el=>!authored.some(other=>other!==el&&other.contains(el)));
      container=top.length===1?top[0]:duckduckgoAssist;
      duckduckgoHasMore=visibleAll('button,[role="button"]',duckduckgoAssist).some(el=>/^(More|Show more|Read more|Expand|显示更多|展开|更多)$/i.test(el.getAttribute('aria-label')||text(el))&&el.getAttribute('aria-expanded')!=='true');
    }
  } else if (surface === 'chatgpt_search') {
    container = visibleAll('[data-message-author-role="assistant"]').at(-1) || null;
    if (!container) {
      const heading = headings.find(el => /^(ChatGPT said:|ChatGPT 说：|ChatGPT a dit\s*:?)$/i.test(text(el)));
      if (heading) container = heading.closest('article') || heading.parentElement;
    }
  } else if (surface === 'gemini') {
    responseRoot = visibleAll('model-response,[data-message-author-role="model"]').at(-1) || null;
    container = responseRoot && visibleAll('message-content .markdown,[id^="model-response-message-content"],.model-response-text',responseRoot).at(-1) || responseRoot || visibleAll('.model-response-text').at(-1) || null;
  } else if (surface === 'bing_copilot') {
    responseRoot = visibleAll('[data-content="ai-message"],[data-testid="ai-message"],[data-testid="assistant-message"],[data-message-author-role="assistant"]').at(-1) || null;
    container = responseRoot && (visibleAll('[data-testid="answer"],.markdown,.prose',responseRoot).at(-1) || responseRoot);
  } else if (surface === 'perplexity') {
    const sourceControls=visibleAll('button,[role="button"],[role="tab"]')
      .filter(el=>!el.closest('nav,aside,[role="complementary"],[contenteditable],[role="textbox"],form')&&/^(Sources|Links|来源|链接)(?:\s*\(?\d+\)?)?$/i.test(el.getAttribute('aria-label')||text(el)));
    for(const control of sourceControls){
      if(control.getAttribute('role')==='tab'&&control.getAttribute('aria-selected')!=='true')continue;
      const id=control.getAttribute('aria-controls');
      const controlled=id&&doc.getElementById(id);
      if(controlled)perplexitySourceRelations.push({control,panel:controlled});
      if(control.id)for(const panel of visibleAll('[role="tabpanel"]'))if((panel.getAttribute('aria-labelledby')||'').split(/\s+/).includes(control.id))perplexitySourceRelations.push({control,panel});
    }
    linkedPerplexitySourcePanels=perplexitySourceRelations.map(({panel})=>panel).filter(panel=>visible(panel)&&!panel.matches('body,html,main,[role="main"],nav,[class~="group/partition"],[class~="group/final-text"]')&&
      !panel.querySelector('[data-testid="assistant-message"],[data-message-author-role="assistant"],[class~="group/partition"],[class~="group/final-text"]'));
    const sourceOrComposer = el => el.closest('nav,aside,[role="complementary"],[role="dialog"],[aria-label="Sources"],[data-testid="sources-panel"],[data-testid="source-list"],[contenteditable],[role="textbox"],textarea,input,form')||linkedPerplexitySourcePanels.some(panel=>panel.contains(el));
    const proseIn = root => {
      const candidates = [root, ...visibleAll('.prose,[data-testid="answer-content"],.markdown',root)]
        .filter(el => el.matches('.prose,[data-testid="answer-content"],.markdown') && visible(el) && !sourceOrComposer(el));
      // A prose wrapper can itself contain markdown. Keep each rendered fragment once.
      return candidates.filter(el => !candidates.some(other => other !== el && other.contains(el)));
    };
    responseRoot = visibleAll('[data-testid="answer"],[data-testid="assistant-message"],[data-message-author-role="assistant"],[data-role="assistant"]')
      .filter(el => !el.matches('button,a,[role="tab"],[role="button"]') && !sourceOrComposer(el) &&
        (!el.matches('[data-testid="answer"]')||el.matches('[data-message-author-role="assistant"],[data-role="assistant"]')||proseIn(el).length)).at(-1) || null;
    if (responseRoot) {
      answerContainers = proseIn(responseRoot);
      if (!answerContainers.length) answerContainers = [responseRoot];
      container = answerContainers[0];
    }
    if(!container && typeof input.question==='string' && input.question.trim()){
      // Guest pages can split one answer across several prose fragments and also
      // render prose in sidebars. Bind them to one response partition after the
      // exact submitted query echo; never infer an answer from all of main.
      const normalizeQuery=value=>value.normalize('NFKC').replace(/\s+/g,' ').trim();
      const renderedQuery=el=>{
        const clone=el.cloneNode(true),originals=[...el.querySelectorAll('*')],copies=[...clone.querySelectorAll('*')];
        originals.forEach((child,index)=>{if(!visible(child))copies[index]?.remove();});
        for(const control of clone.querySelectorAll('button,[role="button"],[role="tab"],input,textarea,script,style'))control.remove();
        return normalizeQuery(text(clone));
      };
      const expected=normalizeQuery(input.question);
      for(const main of visibleAll('main,[role="main"]')){
        const answers=proseIn(main);
        if(!answers.length)continue;
        const position=new Map([...main.querySelectorAll('*')].map((el,index)=>[el,index]));
        const queryMarkers=visibleAll('h1,h2,h3,[role="heading"],[data-testid="query-title"],[data-message-author-role="user"],div,p,span',main)
          .filter(el=>!sourceOrComposer(el)&&!el.closest('button,[role="button"],[role="tab"]')&&!answers.some(answer=>el.contains(answer)||answer.contains(el))&&renderedQuery(el));
        if(!queryMarkers.some(el=>renderedQuery(el)===expected))continue;
        // The nearest rendered marker before this response must be the submitted
        // query. An earlier matching title cannot claim a later unrelated turn.
        const matchesQuery=firstAnswer=>{
          const preceding=queryMarkers.filter(query=>position.get(query)<position.get(firstAnswer));
          const nearest=preceding.at(-1);
          return !!nearest&&renderedQuery(nearest)===expected;
        };
        const partitions=visibleAll('[class~="group/partition"],[class~="group/final-text"]',main)
          .filter(el=>!sourceOrComposer(el)&&answers.some(answer=>el.contains(answer)));
        const topTurns=partitions.filter(el=>!partitions.some(other=>other!==el&&other.contains(el)));
        const turns=topTurns.filter(el=>matchesQuery(answers.find(answer=>el.contains(answer))));
        if(turns.length===1&&turns[0]===topTurns.at(-1)){
          verifiedSinglePerplexityTurn=turns[0];
          answerContainers=answers.filter(answer=>verifiedSinglePerplexityTurn.contains(answer));
        }else if(partitions.length===0&&answers.length===1&&matchesQuery(answers[0])){
          // Preserve an unambiguously associated partial body, but without a
          // response partition its global Copy buttons cannot prove completion.
          answerContainers=answers;
        }else continue;
        container=answerContainers[0];responseRoot=verifiedSinglePerplexityTurn||container;perplexityQueryFallback=true;break;
      }
    }
    if(typeof input.question==='string'&&input.question.trim()){
      const normalize=value=>value.normalize('NFKC').replace(/\s+/g,' ').trim();
      const rendered=el=>{
        const clone=el.cloneNode(true),originals=[...el.querySelectorAll('*')],copies=[...clone.querySelectorAll('*')];
        originals.forEach((child,index)=>{if(!visible(child))copies[index]?.remove();});
        for(const control of clone.querySelectorAll('button,[role="button"],[role="tab"],nav,form,input,textarea,script,style'))control.remove();
        return normalize(text(clone));
      };
      for(const main of visibleAll('main,[role="main"]')){
        const partitions=visibleAll('[class~="group/partition"],[class~="group/final-text"]',main).filter(el=>!sourceOrComposer(el));
        const latest=partitions.filter(el=>!partitions.some(other=>other!==el&&other.contains(el))).at(-1);
        if(!latest||latest.matches('[data-message-author-role="user"],[data-role="user"]')||
          visibleAll('blockquote,q,pre,code,table,[data-message-author-role="user"],[data-role="user"]',latest).length||
          rendered(latest)!=='Sign up and repeat your request.')continue;
        const buttons=visibleAll('button,[role="button"]',latest);
        if(latest.matches('[aria-busy="true"],[data-streaming="true"]')||visibleAll('[aria-busy="true"],[data-streaming="true"]',latest).length||
          buttons.some(button=>/^(Stop generating|Stop response|Stop streaming|Stop|停止生成|停止回复)$/i.test(button.getAttribute('aria-label')||text(button)))||
          !buttons.some(button=>!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&/^(Copy|Copy response|Copy answer|Copy text|复制|复制回复|复制回答)$/i.test(button.getAttribute('aria-label')||text(button))))continue;
        const position=new Map([...main.querySelectorAll('*')].map((el,index)=>[el,index]));
        const markers=visibleAll('h1,h2,h3,[role="heading"],[data-testid="query-title"],[data-message-author-role="user"],div,p,span',main)
          .filter(el=>!sourceOrComposer(el)&&!el.closest('button,[role="button"],[role="tab"]')&&!partitions.some(partition=>partition.contains(el)||el.contains(partition))&&position.get(el)<position.get(latest)&&rendered(el));
        if(!markers.length||rendered(markers.at(-1))!==normalize(input.question))continue;
        // This exact current reply is an access notice, never an answer sample.
        accessNotice='login';accessNoticeSource='current_reply';accessNoticeMessage='Sign up and repeat your request.';
        container=null;answerContainers=[];responseRoot=latest;
        verifiedSinglePerplexityTurn=latest;perplexityQueryFallback=true;break;
      }
    }
    const embeddedContent='nav,aside,[role="complementary"],blockquote,q,pre,code,[data-testid="answer"],[data-testid="assistant-message"],[data-message-author-role="assistant"],[data-role="assistant"],[data-message-author-role="user"],[data-role="user"],[class~="group/partition"],[class~="group/final-text"],.prose,.markdown';
    const visibleDialogText=el=>{
      const clone=el.cloneNode(true),originals=[...el.querySelectorAll('*')],copies=[...clone.querySelectorAll('*')];
      originals.forEach((child,index)=>{if(!visible(child))copies[index]?.remove();});
      return text(clone).replace(/\s+/g,' ').trim();
    };
    for(const dialog of visibleAll('[role="dialog"]')){
      if(dialog.closest(embeddedContent)||visibleAll(embeddedContent,dialog).length||
        !(dialog.getAttribute('aria-modal')==='true'||doc.defaultView?.getComputedStyle?.(dialog)?.position==='fixed'))continue;
      const titles=visibleAll('h1,h2,h3,[role="heading"],p,span,div',dialog);
      const hasTitle=titles.some(title=>visibleDialogText(title)==='Sign in to continue using Perplexity');
      const email=visibleAll('input[type="email"],input[autocomplete="email"],input[placeholder="Enter your email"]',dialog)
        .some(input=>!input.disabled&&input.getAttribute('aria-disabled')!=='true');
      const provider=visibleAll('button,[role="button"]',dialog).some(button=>!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&
        /^(Continue with Google|Continue with Apple)$/.test(button.getAttribute('aria-label')||visibleDialogText(button)));
      if(!hasTitle||!email||!provider)continue;
      accessNotice='login';accessNoticeSource='login_dialog';accessNoticeMessage='Sign in to continue using Perplexity';break;
    }
  } else if (surface === 'grok') {
    responseRoot = visibleAll('[data-testid="assistant-message"],[data-message-author-role="assistant"],article[aria-label="Grok"],.response-content-markdown').at(-1) || null;
    container = responseRoot && (visibleAll('.response-content-markdown,.markdown,.prose',responseRoot).at(-1) || responseRoot);
  }
  const normalizeUrl = raw => {
    try {
      let u = new URL(raw, doc.baseURI);
      if (/^(www\.)?google\.[a-z.]+$/.test(u.hostname) && /^\/(url|goto)$/.test(u.pathname)) {
        const target = u.searchParams.get('url') || u.searchParams.get('q') || u.searchParams.get('u');
        if (!target || !/^https?:\/\//.test(target)) return null;
        u = new URL(target);
      }
      if (/^(www\.)?bing\.com$/.test(u.hostname) && /^\/ck\/a\/?$/.test(u.pathname)) {
        let target = u.searchParams.get('u');
        // Bing's visible href carries the destination in a1-prefixed base64; no request is made.
        if (target?.startsWith('a1')) {
          const bytes=atob(target.slice(2).replace(/-/g,'+').replace(/_/g,'/'));
          target=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(bytes,c=>c.charCodeAt(0)));
        }
        if (!target || !/^https?:\/\//.test(target)) return null;
        u = new URL(target);
      }
      if(surface==='duckduckgo_search_assist'&&/^(www\.)?duckduckgo\.com$/.test(u.hostname)&&/^\/l\/?$/.test(u.pathname)){
        const target=u.searchParams.get('uddg');
        if(!target||!/^https?:\/\//.test(target))return null;
        u=new URL(target);
      }
      if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return null;
      if (/(^|\.)(chatgpt\.com|gstatic\.com)$/.test(u.hostname)) return null;
      if (/^(?:www\.)?(?:grok\.com|copilot\.com|copilot\.microsoft\.com)$/.test(u.hostname)) return null;
      if (/^(www\.)?bing\.com$/.test(u.hostname) && /^\/(?:search|chat|copilot|ck\/a)(?:\/|$)/.test(u.pathname)) return null;
      if (/^(www\.)?perplexity\.ai$/.test(u.hostname) && /^\/(?:search|account|settings|login|signup|discover)(?:\/|$)/.test(u.pathname)) return null;
      if (/^(www\.)?google\.[a-z.]+$/.test(u.hostname) && /^\/(search|url|goto|preferences|setprefs|sorry|advanced_search)?\/?$/.test(u.pathname)) return null;
      if(surface==='duckduckgo_search_assist'&&/^(www\.)?duckduckgo\.com$/.test(u.hostname))return null;
      u.hash = '';
      for (const key of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|ved|ei|sxsrf)/i.test(key)) u.searchParams.delete(key);
      return u.toString();
    } catch { return null; }
  };
  const perplexityTurn=surface==='perplexity'?(perplexityQueryFallback?verifiedSinglePerplexityTurn:
    responseRoot?.closest('[data-testid="assistant-message"],[data-message-author-role="assistant"],[data-role="assistant"],[class~="group/partition"],[class~="group/final-text"],article')||responseRoot):null;
  let sourcePanel = null, perplexityFallbackSourceCount = null;
  const sourceHeading = headings.find(el => /^(Sources|来源|Sources citées|相关结果|Related results)(?:\s*\(?\d+\)?)?$/i.test(text(el)));
  if (sourceHeading && !['perplexity','duckduckgo_search_assist'].includes(surface)) {
    let parent = sourceHeading.parentElement;
    for (let i=0; parent && i<5; i++, parent=parent.parentElement) {
      if (parent === doc.body || (container && parent.contains(container))) break;
      if (parent.querySelectorAll('a[href]').length) {sourcePanel=parent; break;}
    }
  }
  if(surface==='duckduckgo_search_assist')sourcePanel=duckduckgoSources;
  const perplexityCurrentSourcePanels=surface==='perplexity'?perplexitySourceRelations.filter(({control,panel})=>linkedPerplexitySourcePanels.includes(panel)&&perplexityTurn&&
    (perplexityTurn.contains(control)||control.getAttribute('role')==='tab'&&control.getAttribute('aria-selected')==='true'&&
      control.closest('main,[role="main"]')===perplexityTurn.closest('main,[role="main"]')&&!!control.closest('main,[role="main"]'))).map(({panel})=>panel):[];
  if(surface==='gemini'){
    const expanded=responseRoot&&visibleAll('button[aria-expanded="true"]',responseRoot).some(b=>/View source details|查看来源|来源详情/i.test(b.getAttribute('aria-label')||''));
    if(expanded)sourcePanel=visibleAll('[role="dialog"]').find(d=>d.querySelector('inline-source-card a[href]'))||sourcePanel;
  }
  if(['bing_copilot','perplexity','grok'].includes(surface)){
    // Bounded native sources containers only; never treat an entire conversation/main as a source list.
    const panels=visibleAll('[data-testid="sources-panel"],[data-testid="source-list"],[aria-label="Sources"],[role="dialog"],[role="complementary"]');
    sourcePanel=panels.find(p=>p!==container && !p.contains(container) && visibleAll('a[href]',p).length &&
      (surface!=='perplexity'||p.matches('[data-testid="sources-panel"],[data-testid="source-list"]')||perplexityCurrentSourcePanels.includes(p))&&
      (p.matches('[data-testid="sources-panel"],[data-testid="source-list"],[aria-label="Sources"]') || /^(?:Sources|来源|\d+ sources)(?:\s|$)/i.test(text(p)) ||
        visibleAll('button,[role="button"],[role="tab"]',p).some(b=>/^(Sources|来源)(?:\s*\(?\d+\)?)?$/i.test(b.getAttribute('aria-label')||text(b))))) || sourcePanel;
  }
  if(surface==='perplexity'){
    // A Sources/Links portal need not have an aside/dialog wrapper. Accept an
    // explicitly linked visible panel only, never the conversation or a sidebar.
    sourcePanel=perplexityCurrentSourcePanels.find(panel=>
      !(responseRoot&&panel.contains(responseRoot))&&!(answerContainers||[container]).filter(Boolean).some(answer=>panel.contains(answer)||answer.contains(panel))&&
      visibleAll('a[href]',panel).length)||sourcePanel;
    if(!sourcePanel&&perplexityQueryFallback&&verifiedSinglePerplexityTurn){
      // Observed guest Sources is a plain sibling pane with no role/heading/id.
      // Its expanded header must belong to this main, and its links must overlap
      // the current answer. The unique response aggregate supplies the full N;
      // partial hydration can be read but cannot satisfy the source collector.
      const aggregateControls=visibleAll('button,[role="button"]',perplexityTurn)
        .filter(control=>!(answerContainers||[]).some(answer=>answer.contains(control)))
        .map(control=>({control,count:((control.getAttribute('aria-label')||'')+' '+text(control)).match(/(?:^|\s)(\d+)\s+sources\b|\bSources\s*\(?(\d+)\)?\b|(\d+)\s*来源/i)}))
        .filter(entry=>entry.count&&Number(entry.count[1]||entry.count[2]||entry.count[3])>0);
      if(aggregateControls.length===1){
        const expected=Number(aggregateControls[0].count[1]||aggregateControls[0].count[2]||aggregateControls[0].count[3]);
        const main=perplexityTurn.closest('main,[role="main"]');
        const inlineUrls=new Set((answerContainers||[]).flatMap(answer=>visibleAll('a[href]',answer).map(link=>normalizeUrl(link.getAttribute('href')))).filter(Boolean));
        const candidates=[];
        for(const header of main?visibleAll('button,[role="button"]',main):[]){
          if(perplexityTurn.contains(header)||header.getAttribute('aria-expanded')!=='true'||
            header.closest('nav,aside,[role="complementary"],[role="dialog"],[contenteditable],[role="textbox"],form')||
            !/^(Sources|来源)$/i.test(header.getAttribute('aria-label')||text(header)))continue;
          for(let parent=header.parentElement,depth=0;parent&&depth<5;parent=parent.parentElement,depth++){
            if(parent.matches('body,html,main,[role="main"],nav,aside,[role="complementary"],[role="dialog"],form,[contenteditable],[role="textbox"]')||
              parent.contains(perplexityTurn)||parent.matches('[data-testid="answer"],[data-testid="assistant-message"],[data-message-author-role="assistant"],[data-role="assistant"],[class~="group/partition"],[class~="group/final-text"]')||
              parent.querySelector('[data-testid="answer"],[data-testid="assistant-message"],[data-message-author-role="assistant"],[data-role="assistant"],[class~="group/partition"],[class~="group/final-text"]'))break;
            const urls=new Set(visibleAll('a[href]',parent).map(link=>normalizeUrl(link.getAttribute('href'))).filter(Boolean));
            if(urls.size>expected)break;
            if(urls.size&&[...urls].some(url=>inlineUrls.has(url))){candidates.push(parent);break;}
          }
        }
        const uniqueCandidates=[...new Set(candidates)];
        if(uniqueCandidates.length===1){sourcePanel=uniqueCandidates[0];perplexityFallbackSourceCount=expected;}
      }
    }
  }
  const links = [];
  let unresolvedCitations = 0;
  for (const root of (surface==='duckduckgo_search_assist'?[sourcePanel]:[...(answerContainers||[container]),sourcePanel]).filter(Boolean)) for (const a of visibleAll('a[href]', root)) {
    const raw=a.getAttribute('href'), url=normalizeUrl(raw);
    const placement=root===sourcePanel||a.closest('inline-source-card')?'source_panel':'answer_link';
    const existing=url&&links.find(l=>l.url===url);
    if (url && !existing) links.push({url,title:text(a).slice(0,500),placement});
    else if(existing&&placement==='source_panel'){existing.placement='source_panel';existing.title=text(a).slice(0,500)||existing.title;}
    else if (/(?:google\.[^/]+\/(?:goto|url)|bing\.com\/ck\/a|duckduckgo\.com\/l\/)/.test(raw || '') && !url) unresolvedCitations++;
  }
  const answerFragments=[];
  for (const answerContainer of (answerContainers||[container]).filter(Boolean)) {
    const clone=answerContainer.cloneNode(true);
    const originals=[...answerContainer.querySelectorAll('*')], copies=[...clone.querySelectorAll('*')];
    originals.forEach((el,index)=>{if(!visible(el))copies[index]?.remove();});
    if(surface==='duckduckgo_search_assist'){
      for(const el of clone.querySelectorAll('[data-testid="search-assist-sources"],[data-testid="search-assist-source-list"],[aria-label="Sources"],footer'))el.remove();
      for(const heading of clone.querySelectorAll('h1,h2,h3,h4,[role="heading"]'))if(/^(Search Assist|搜索助手)$/i.test(text(heading)))heading.remove();
    }
    // Remove source cards identified by their own About control, not arbitrary content links.
    for (const b of clone.querySelectorAll('button,[role="button"]')) {
      if (/^(About this result|关于这条结果|关于这条结果的详细信息)$/i.test(text(b))) {
        let p=b.parentElement, card=null;
        for(let i=0;p&&p!==clone&&i<4;i++,p=p.parentElement){ if(text(p).length>1500)break;if(p.querySelector('a[href]'))card=p; }
        if(card)card.remove();
      }
    }
    for(const el of clone.querySelectorAll('button,[role="button"],inline-source-card,.source-inline-chip-container,[role="dialog"],script,style,nav,form,textarea,input,[aria-hidden="true"],[hidden]')) el.remove();
    const plain=node=>{
      if(node.nodeType===3)return node.textContent||'';
      const content=[...node.childNodes].map(plain).join('');
      return /^(P|DIV|SECTION|ARTICLE|LI|UL|OL|H[1-6]|TR|BLOCKQUOTE|BR)$/.test(node.nodeName)?'\n'+content+'\n':content;
    };
    const fragment=plain(clone).replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n\n').trim();
    if(fragment)answerFragments.push(fragment);
  }
  const answer=answerFragments.join('\n\n').replace(/^(AI Overview|AI Overviews|AI 概览|AI概览|ChatGPT said:|ChatGPT 说：)\s*/i,'').trim();
  const modelLabels=visibleAll('button,[role="button"]').map(text).filter(t=>/^(GPT-[\w. -]+|Grok(?:[ -][\w. -]+)?|Sonar(?:[ -][\w. -]+)?|Flash(?:-Lite)?|Fast|Thinking|Pro|快速|思考|深度思考)$/i.test(t));
  const boundedParent=responseRoot?.parentElement;
  const turn=surface==='perplexity'?perplexityTurn:(newSurface ? responseRoot?.closest('[data-testid="assistant-message"],[data-message-author-role="assistant"],[data-content="ai-message"],article') ||
    (boundedParent&&!boundedParent.matches('body,html,main,[role="main"]')&&!visibleAll('[data-message-author-role="user"],[data-role="user"]',boundedParent).length?boundedParent:null) : responseRoot || container?.closest('article') || container?.parentElement);
  // Current Grok also uses semantic assistant articles with an adjacent response footer.
  // Only the immediate non-message sibling is eligible; never a different turn or main.
  const grokFooter=surface==='grok'&&responseRoot?.matches('article[aria-label="Grok"]')&&responseRoot.nextElementSibling;
  const completionRoots=[turn,grokFooter&&!grokFooter.matches('article,main,[role="main"]')&&!grokFooter.querySelector('article,[data-message-author-role],.response-content-markdown')?grokFooter:null].filter(Boolean);
  const generating=completionRoots.some(root=>root.matches('[aria-busy="true"],[data-streaming="true"]')||visibleAll('[aria-busy="true"],[data-streaming="true"]',root).length>0 || visibleAll('button',root).some(b=>/^(Stop generating|Stop response|Stop streaming|Stop|停止生成|停止回答|停止回复)$/i.test(b.getAttribute('aria-label')||text(b))));
  const responseComplete=!!container && !!answer && !generating && (surface==='duckduckgo_search_assist'
    ? !duckduckgoHasMore&&!!duckduckgoSources&&visibleAll('a[href]',duckduckgoSources).length>0
    : completionRoots.some(root=>visibleAll('button,[role="button"]',root).some(b=>!(answerContainers||[container]).some(answer=>answer.contains(b))&&!b.disabled&&b.getAttribute('aria-disabled')!=='true' && /^(Copy|Copy response|Copy answer|Copy text|复制|复制回复|复制回答)$/i.test(b.getAttribute('aria-label')||text(b)))));
  const citationControls=surface==='gemini'&&responseRoot?visibleAll('button',responseRoot).filter(b=>/View source details|查看来源|来源详情/i.test(b.getAttribute('aria-label')||'')).length:0;
  const sourceCountText=sourcePanel&&(visibleAll('h1,h2,h3,h4,[role="heading"]',sourcePanel).map(text).find(t=>/^(Sources|来源|\d+ sources)/i.test(t))||text(sourcePanel));
  const sourceCountMatch=sourceCountText&&sourceCountText.match(/^(?:Sources|来源)\s*\(?(\d+)\)?\b|^(\d+)\s+sources\b/i);
  const sourceCountExpected=perplexityFallbackSourceCount??(sourceCountMatch?Number(sourceCountMatch[1]||sourceCountMatch[2]):surface==='duckduckgo_search_assist'&&duckduckgoSources?new Set(visibleAll('a[href]',duckduckgoSources).map(a=>normalizeUrl(a.getAttribute('href'))).filter(Boolean)).size:null);
  const sourcePanelHasMore=!!sourcePanel&&visibleAll('button,[role="button"],a',sourcePanel).some(b=>/^(Show more|Load more|See more|Show all|See all|显示更多|加载更多|显示全部)$/i.test(b.getAttribute('aria-label')||text(b)));
  let sourceDiagnostics=null;
  if(surface==='perplexity'){
    // Structural diagnostics are deliberately separate from source recognition.
    // They never expose page text, account/history labels, element IDs or raw DOM.
    const knownTags=new Set(['html','body','main','article','section','div','aside','nav','header','footer','button','a','span','p','h1','h2','h3','h4','ul','ol','li']);
    const knownRoles=new Set(['button','tab','tabpanel','tablist','dialog','complementary','main','region','heading','list','listitem','menu','menuitem','textbox']);
    const knownClasses=new Set(['prose','markdown','group/partition','group/final-text','flex','flex-col','flex-row','grid','relative','absolute','fixed','overflow-y-auto','overflow-auto','overflow-hidden','rounded-lg','rounded-xl','border','shadow','shadow-lg']);
    const knownTestIds=new Set(['answer','answer-content','assistant-message','sources-panel','source-list','query-title']);
    const diagnosticUrl=raw=>{
      const normalized=normalizeUrl(raw);if(!normalized)return null;
      const url=new URL(normalized);url.search='';url.hash='';return url.toString();
    };
    const currentUrls=new Set();
    for(const root of [...(answerContainers||[container]),sourcePanel].filter(Boolean))for(const link of visibleAll('a[href]',root)){
      const url=diagnosticUrl(link.getAttribute('href'));if(url)currentUrls.add(url);
    }
    const scope=el=>sourcePanel?.contains(el)?'recognized_source_panel':perplexityTurn?.contains(el)?'current_response':
      perplexityTurn?.closest('main,[role="main"]')?.contains(el)?'current_view':'outside_response';
    const shape=el=>{
      const tag=(el.tagName||'').toLowerCase(),role=el.getAttribute('role'),testId=el.getAttribute('data-testid');
      const anchors=visibleAll('a[href]',el),matched=new Set(anchors.map(link=>diagnosticUrl(link.getAttribute('href'))).filter(url=>url&&currentUrls.has(url)));
      return {tag:knownTags.has(tag)?tag:'other',role:role?(knownRoles.has(role)?role:'other'):null,
        classes:[...(el.classList||[])].filter(value=>knownClasses.has(value)).slice(0,12),
        testId:knownTestIds.has(testId)?testId:null,testIdPresent:!!testId,scope:scope(el),linkCount:Math.min(101,anchors.length),
        currentCitationMatches:Math.min(101,matched.size)};
    };
    const ancestors=el=>{const result=[];for(let parent=el.parentElement;parent&&result.length<5;parent=parent.parentElement)result.push(shape(parent));return result;};
    const label=el=>{
      const value=(el.getAttribute('aria-label')||text(el)).replace(/\s+/g,' ').trim();
      const sources=/^(?:Sources|View sources|Show all sources|See all sources|\d+ sources|Sources\s*\d+|来源|查看来源|显示所有来源|\d+\s*来源)(?:\s*\(\d+\))?$/i.test(value);
      const links=/^(?:Links|链接)(?:\s*\(?\d+\)?)?$/i.test(value);
      if(!sources&&!links)return null;
      const count=value.match(/(?:^|\s)(\d+)\s+(?:sources|来源)\b|(?:Sources|Links|来源|链接)\s*\(?(\d+)\)?/i);
      return {label:sources?'sources':'links',declaredCount:count?Number(count[1]||count[2]):null};
    };
    const controls=visibleAll('button,[role="button"],[role="tab"]').map(el=>({el,label:label(el)})).filter(entry=>entry.label);
    const sourceHeadings=[...new Set([...headings,...visibleAll('p,span,div')])]
      .filter(el=>!el.closest('button,[role="button"],[role="tab"]')).map(el=>({el,label:label(el)})).filter(entry=>entry.label);
    const candidates=[...new Set([sourcePanel,...perplexityCurrentSourcePanels,...visibleAll('[data-testid="sources-panel"],[data-testid="source-list"],[aria-label="Sources"],[role="tabpanel"],[role="dialog"],[role="complementary"]')].filter(Boolean))];
    const nodes=[];
    if(perplexityTurn)nodes.push({kind:'response',...shape(perplexityTurn),ancestors:ancestors(perplexityTurn)});
    for(const {el,label:fixedLabel} of controls.slice(0,12))nodes.push({kind:'source_control',...shape(el),...fixedLabel,
      ariaControlsPresent:!!el.getAttribute('aria-controls'),ariaLabelledByPresent:!!el.getAttribute('aria-labelledby'),
      expanded:el.hasAttribute('aria-expanded')?el.getAttribute('aria-expanded')==='true':null,
      selected:el.hasAttribute('aria-selected')?el.getAttribute('aria-selected')==='true':null,ancestors:ancestors(el)});
    for(const {el,label:fixedLabel} of sourceHeadings.slice(0,9))nodes.push({kind:'source_heading',...shape(el),...fixedLabel,ancestors:ancestors(el)});
    for(const el of candidates.slice(0,8))nodes.push({kind:'source_candidate',...shape(el),recognized:el===sourcePanel,
      currentControlLinked:perplexityCurrentSourcePanels.includes(el),ancestors:ancestors(el)});
    sourceDiagnostics={version:'visible-source-structure-v1',maxNodes:30,maxAncestors:5,nodes:nodes.slice(0,30),
      nodesTruncated:controls.length>12||sourceHeadings.length>9||candidates.length>8||nodes.length>30,
      currentCitationUrls:[...currentUrls].slice(0,20),citationUrlsTruncated:currentUrls.size>20};
  }
  return {body,answer,responseComplete,generating,citationControls,signedIn,accountConflict,copilotAccountMenuSignedIn,temporaryChat,personalizationDisabled,citationOverflow:Math.max(0,links.length-100),citations:links.slice(0,100),unresolvedCitations,sourcePanel:!!sourcePanel,sourceCountExpected,sourcePanelHasMore,duckduckgoHasMore,
    sourceDiagnostics,accessNotice,accessNoticeSource,accessNoticeMessage,
    controls:visibleAll('button,[role="button"],[role="menuitem"],[role="menuitemcheckbox"]').map(el=>surface==='bing_copilot'&&el.matches('div[role="button"][aria-label]')?'Microsoft account control':el.getAttribute('aria-label')||text(el)).filter(Boolean).slice(0,35),
    triggered,containerFound:!!container,signedOut,model:modelLabels[0]||'unknown',
    hasSearchResults:surface==='duckduckgo_search_assist'?visibleAll('[data-testid="result"] h2,[data-testid="result"] h3,.result--web .result__title,.results_links_deep .result__title').length>0:!!doc.querySelector('#search h3,#rso h3'),
    locale:doc.defaultView?.navigator?.language || null,
    timezone:typeof Intl !== 'undefined'?Intl.DateTimeFormat().resolvedOptions().timeZone:null};
}
module.exports = { extractVisiblePage };
