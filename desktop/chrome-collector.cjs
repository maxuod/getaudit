const { chromium } = require('playwright-core');
const { existsSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { extractVisiblePage } = require('./browser-extract.cjs');
const { captureArtifact } = require('./capture-artifact.cjs');
const {verifyContextEgress}=require('./egress-check.cjs');
const {NEW_SURFACES,surfaceUrls:urls,inputSelector,freshEntryUrl,affirmCopilotAccount,dismissPerplexityOverlays,collectNewSurfaceSources,expandDuckDuckGoSearchAssist,officialSurfaceUrl}=require('./browser-platforms.cjs');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VERSION='visible-dom-v16';
const loginNames=/^(Sign in|Log in|登录|登入|Se connecter)$/i;
const accessMessages=Object.freeze({current_reply:'Sign up and repeat your request.',login_dialog:'Sign in to continue using Perplexity'});
function readAccessNotice(snapshot){
  const source=snapshot.accessNoticeSource;
  if(snapshot.accessNotice!=='login'||!Object.hasOwn(accessMessages,source)||snapshot.accessNoticeMessage!==accessMessages[source])return null;
  // The reader proves the visible reply/dialog boundary. Evidence uses only
  // these fixed messages, never arbitrary page labels or authentication text.
  return {kind:'login',source,message:accessMessages[source]};
}

function restriction(snapshot,url){
  if(/google\.[^/]+\/sorry/.test(url)||/unusual traffic from your computer network|our systems have detected unusual traffic|异常流量|确认您是真人|verify you are human|verify that you are human|正在验证您是否是真人/i.test(snapshot.body))return 'captcha';
  if(/too many requests|you.ve reached.{0,60}(limit|quota)|usage limit|达到.{0,12}(使用|消息|请求).{0,8}上限|请求过于频繁|try again (in|after) \d/i.test(snapshot.body))return 'rate_limit';
  if(/not (available|supported) in your (country|region)|所在.{0,8}(地区|国家).{0,8}(不可用|不支持)/i.test(snapshot.body))return 'region';
  if(/\/auth\/login|\/accounts?\/login|accounts\.google\.|login\.live\.com|login\.microsoftonline\.com/.test(url))return 'login';
  // Only the bounded reply/dialog reader can set a recognized signal. A Sign-up
  // phrase in page chrome, a quote or the submitted question never sets it.
  if(readAccessNotice(snapshot))return 'login';
  return null;
}
function createChromeCollector(){
  let page=null;
  const browsers=new Map(),launches=new Map();
  const prepared=new Map(),activePages=new Map(),activeSurfaces=new Set();
  const key=(planId,surface)=>planId+':'+surface;
  const samplingMode=value=>{
    const mode=value??'silent';
    if(!['silent','visible'].includes(mode))throw new Error('Unsupported browser mode. Use silent or visible explicitly.');
    return mode;
  };
  const ensureBrowser=async(mode='silent')=>{
    if(browsers.get(mode)?.isConnected())return browsers.get(mode);
    if(!launches.has(mode)){
      if(mode==='visible')prepared.clear();
      const launch=chromium.launch({executablePath:CHROME,headless:mode==='silent',chromiumSandbox:true,timeout:30000})
        .then(b=>{browsers.set(mode,b);return b;}).finally(()=>{launches.delete(mode);});
      launches.set(mode,launch);
    }
    return await launches.get(mode);
  };
  const newContext=async(browser,config,storageState)=>{
    const ctx=await browser.newContext({locale:config.locale,timezoneId:config.timezone,viewport:{width:1280,height:900},acceptDownloads:false,permissions:[],serviceWorkers:'block',...(storageState?{storageState}:{})});
    try{await ctx.grantPermissions([]);return ctx;}catch(error){await ctx.close().catch(()=>{});throw error;}
  };
  return {
    available:()=>({available:existsSync(CHROME),message:existsSync(CHROME)?'使用独立 Chrome 临时会话，不读取个人浏览器资料':'未找到 /Applications/Google Chrome.app，请安装标准 Chrome'}),
    async show(){const pages=[...activePages.values()].filter(p=>p.mode==='visible'&&!p.page.isClosed()).map(p=>p.page);if(!pages.length&&activePages.size)throw new Error('静默采样没有可显示的窗口；请在工作台查看进度和结果');if(!pages.length&&page&&!page.isClosed())pages.push(page);if(!pages.length)throw new Error('当前没有运行中的采样窗口');for(const p of pages)await p.bringToFront();},
    sessions(){return [...prepared.values()].map(p=>({planId:p.planId,surface:p.surface,verified:p.verified&&!p.page.isClosed()&&!!browsers.get('visible')?.isConnected()}));},
    ready(planId,surfaces){return surfaces.every(surface=>{const p=prepared.get(key(planId,surface));return !!p?.verified&&!p.page.isClosed()&&!!browsers.get('visible')?.isConnected();});},
    async prepareSession(task){
      if(!urls[task.surface])throw new Error('未支持的浏览器采样入口');
      if(NEW_SURFACES.has(task.surface)&&task.config.accountMode!=='isolated')throw new Error('此入口的登录仅支持独立会话；没有经过核验的登录隐私模式');
      if((task.config.accountMode??'signed_out')==='signed_out')throw new Error('Strict guest plans cannot prepare a signed-in session.');
      if(task.surface==='duckduckgo_search_assist')throw new Error('DuckDuckGo Search Assist supports strict guest sampling only.');
      const browser=await ensureBrowser('visible');
      if([...prepared.values()].some(p=>p.planId!==task.planId))throw new Error('请先结束另一个计划的登录会话');
      const k=key(task.planId,task.surface),existing=prepared.get(k);
      if(existing&&!existing.page.isClosed()){page=existing.page;await page.bringToFront();return {opened:true};}
      if(existing)await existing.context.close().catch(()=>{});
      const ctx=await newContext(browser,task.config);let loginPage;
      try{loginPage=await ctx.newPage();}catch(error){await ctx.close().catch(()=>{});throw error;}
      try{await loginPage.goto(urls[task.surface],{waitUntil:'domcontentloaded',timeout:30000});}
      catch{await ctx.close();throw new Error('官方登录准备页面未能加载，请检查网络');}
      prepared.set(k,{planId:task.planId,surface:task.surface,context:ctx,page:loginPage,verified:false});page=loginPage;
      await loginPage.bringToFront();return {opened:true};
    },
    async verifySession(planId,surface){
      if(surface==='duckduckgo_search_assist')throw new Error('DuckDuckGo Search Assist supports strict guest sampling only.');
      const p=prepared.get(key(planId,surface));if(!p||p.page.isClosed())throw new Error('请先打开此入口的独立登录窗口');
      const snapshot=await affirmCopilotAccount(surface,p.page,()=>p.page.evaluate(extractVisiblePage,{surface}));
      if(restriction(snapshot,p.page.url())){p.verified=false;throw new Error('当前页面仍有登录或访问限制，无法确认登录；请在独立窗口查看页面提示');}
      if(!snapshot.signedIn){
        p.verified=false;
        throw new Error(snapshot.signedOut
          ? '页面仍显示登录入口；请确认登录完成的是本计划打开的独立窗口'
          : '工具尚未识别到可核验的账号状态；若已完成登录，请展开账号或设置菜单后再确认');
      }
      try{p.entryUrl=freshEntryUrl(surface,p.page.url());}catch(error){p.verified=false;throw error;}
      p.verified=true;return {verified:true,note:'独立会话登录状态已确认；每题仍会检查账号与新对话，登录独立观察不代表匿名条件'};
    },
    async inspectGuest(task,signal){
      if(!urls[task.surface])throw new Error('Unsupported browser sampling surface.');
      if((task.config.accountMode??'signed_out')!=='signed_out')throw new Error('Guest entry checks require a strict guest plan.');
      if(activeSurfaces.has(task.surface))throw new Error('This surface already has an active browser check or sample.');
      if(signal.aborted)throw new Error('Guest entry check was stopped.');
      const mode=samplingMode(task.browserMode);
      activeSurfaces.add(task.surface);
      let ctx,current;
      const abort=()=>{void ctx?.close().catch(()=>{});};
      signal.addEventListener('abort',abort,{once:true});
      try{
        const browser=await ensureBrowser(mode);
        if(signal.aborted)throw new Error('Guest entry check was stopped.');
        // No prepared session, cookies or storage state are read by this path.
        ctx=await newContext(browser,task.config);
        current=await ctx.newPage();
        activePages.set(task.surface,{page:current,mode});
        await current.goto(urls[task.surface],{waitUntil:'domcontentloaded',timeout:30000});
        let snapshot=null,input=null,block=null;
        const deadline=Date.now()+10000;
        for(let n=0;n<11;n++){
          if(signal.aborted)throw new Error('Guest entry check was stopped.');
          snapshot=await current.evaluate(extractVisiblePage,{surface:task.surface});
          block=restriction(snapshot,current.url());
          if(block)break;
          for(const candidate of await current.locator(inputSelector(task.surface)).all()){
            if(await candidate.isVisible()&&(!candidate.isEnabled||await candidate.isEnabled({timeout:500}))&&(!candidate.isEditable||await candidate.isEditable({timeout:500}))){input=candidate;break;}
          }
          if(input||Date.now()>=deadline)break;
          await delay(1000,undefined,{signal});
        }
        if(!input&&!block){
          for(const control of await current.getByRole('button',{name:loginNames}).or(current.getByRole('link',{name:loginNames})).all())if(await control.isVisible()){block='login';break;}
        }
        const official=officialSurfaceUrl(task.surface,current.url());
        const account=snapshot?.accountConflict?'unknown':snapshot?.signedIn?'logged_in':snapshot?.signedOut?'logged_out':'unknown';
        const ready=official&&!block&&!!input&&account==='logged_out';
        const source=official?new URL(current.url()):new URL(urls[task.surface]);
        const sourceUrl=task.surface==='bing_copilot'&&['bing.com','www.bing.com','m365.cloud.microsoft'].includes(source.hostname)?source.origin+'/'+source.pathname.split('/')[1]:source.origin;
        return {checkedAt:new Date().toISOString(),browserMode:mode,status:block?'restricted':ready?'ready':'unknown',restriction:block||'none',account,sourceUrl,
          reason:block?'The guest entry has an access restriction: '+block+'.':!official?'The page left the supported official entry; no question was submitted.':account!=='logged_out'?'The guest account state could not be verified; no question was submitted.':input?'The guest entry is ready. Answers and citations have not been tested.':'No usable guest search or message input was found; no question was submitted.',answer:'not_tested',citations:'not_tested'};
      }finally{
        signal.removeEventListener('abort',abort);
        await ctx?.close().catch(()=>{});
        activePages.delete(task.surface);activeSurfaces.delete(task.surface);
      }
    },
    async close(){await Promise.allSettled([...launches.values()]);const all=[...browsers.values()];browsers.clear();page=null;prepared.clear();activePages.clear();await Promise.allSettled(all.map(b=>b.close()));},
    async closePlanSessions(planId){for(const [k,p] of prepared){if(p.planId!==planId)continue;prepared.delete(k);await p.context.close().catch(()=>{});if(page===p.page)page=null;}},
    async collect(task,signal,stage){
      if(signal.aborted)throw new Error('采样已停止');
      if(!urls[task.surface])throw new Error('未支持的浏览器采样入口');
      if(task.surface==='duckduckgo_search_assist'&&(task.config.accountMode??'signed_out')!=='signed_out')throw new Error('DuckDuckGo Search Assist supports strict guest sampling only.');
      if(NEW_SURFACES.has(task.surface)&&!['signed_out','isolated'].includes(task.config.accountMode??'signed_out'))throw new Error('此入口目前支持未登录或独立会话；没有经过核验的登录隐私模式');
      if(activeSurfaces.has(task.surface))throw new Error('同一入口已有问题在采样');
      const mode=samplingMode(task.browserMode);
      activeSurfaces.add(task.surface);
      const privateMode=task.config.accountMode==='signed_in_private';
      const isolatedMode=task.config.accountMode==='isolated';
      const strictGuest=(task.config.accountMode??'signed_out')==='signed_out';
      const independentMode=isolatedMode&&this.ready(task.planId,[task.surface]);
      const signedInMode=privateMode||independentMode;
      // Missing task mode is background-only. The job layer must resolve frozen
      // historical batch conditions before dispatch, rather than mutate them here.
      // Restrictions or headless launch failures never trigger a visible retry.
      let current,currentContext,browser,entryUrl=urls[task.surface],ownsContext=!signedInMode||mode==='silent'||independentMode;
      try{
        if(signedInMode&&!this.ready(task.planId,[task.surface]))throw new Error('登录准备已失效，请重新登录');
        browser=await ensureBrowser(mode);
        if(signal.aborted)throw new Error('采样已停止');
        if(signedInMode){
          const preparedSession=prepared.get(key(task.planId,task.surface));
          entryUrl=preparedSession.entryUrl||freshEntryUrl(task.surface,preparedSession.page.url());
          if(mode==='silent'||independentMode){
            // Transfer only the dedicated login session, in memory. Every question checks
            // the restored account and privacy controls before any prompt is submitted.
            const storageState=await preparedSession.context.storageState({indexedDB:true});
            if(signal.aborted)throw new Error('采样已停止');
            currentContext=await newContext(browser,task.config,storageState);
          }else currentContext=preparedSession.context;
        }else currentContext=await newContext(browser,task.config);
        current=await currentContext.newPage();
        if(signal.aborted)throw new Error('采样已停止');
        activePages.set(task.surface,{page:current,mode});
      }catch(error){
        if(ownsContext)await currentContext?.close().catch(()=>{});else await current?.close().catch(()=>{});
        activeSurfaces.delete(task.surface);throw error;
      }
      const browserVersion=browser.version(),sessionRef=randomUUID();let deadline=Date.now()+task.timeoutSeconds*1000;
      const abort=()=>{void currentContext.close().catch(()=>{});};
      signal.addEventListener('abort',abort,{once:true});
      let sent=false,last=null,completedReply=null,searchMode='unknown',notes=[],citationsComplete=false,newConversation=false,privacyVerified=false,accountVerified=false;
      if(independentMode)notes.push('登录态独立观察：仅使用此计划的独立登录准备会话，每题新建上下文；不代表匿名或已关闭个性化');
      let egress=null,egressValid=false,citationControls=0,citationControlsOpened=0;
      const verifyEgress=async()=>{
        if(!['canada_fixed','country_fixed'].includes(task.config.egressPolicy))return;
        const proof=await verifyContextEgress(currentContext,task.planId||task.config.promptSetId,task.config.country);
        if(egress&&egress.fingerprint!==proof.fingerprint)throw Object.assign(new Error('采样期间出口发生变化；本次结果不符合固定出口条件'),{code:'EGRESS_GUARD'});
        task.confirmEgress?.(proof);egress=proof;egressValid=true;
      };
      const check=()=>{if(signal.aborted)throw new Error('采样已停止');if(Date.now()>deadline)throw new Error('页面在本题时限内没有完成');};
      const inspect=async()=>{check();last=await current.evaluate(extractVisiblePage,{surface:task.surface,question:task.prompt});if(accountVerified&&!last.signedOut)last={...last,signedIn:true};return last;};
      const firstVisible=async loc=>{for(const e of await loc.all())if(await e.isVisible())return e;return null;};
      const findInput=async()=>{
        // Hydrated providers can briefly expose a disabled or read-only composer.
        // Never call fill/submit until one visible native input is usable.
        for(const e of await current.locator(inputSelector(task.surface)).all()){
          try{
            if(await e.isVisible()&&(!e.isEnabled||await e.isEnabled({timeout:500}))&&(!e.isEditable||await e.isEditable({timeout:500})))return e;
          }catch{
            // Hydration can replace a composer between the visibility and
            // editability checks. Poll the new element before any submission.
          }
        }
        return null;
      };
      const waitVisible=async loc=>{for(let i=0;i<12;i++){check();const el=await firstVisible(loc);if(el)return el;await delay(500,undefined,{signal});}return null;};
      const clickOptional=async loc=>{const e=await firstVisible(loc);if(!e)return false;await e.click({timeout:5000});return true;};
      const wait=async()=>{await delay(1500,undefined,{signal});check();};
      const boundedRead=async(read)=>{
        const bounded=new AbortController();
        try{return await Promise.race([read().catch(()=>null),delay(2000,null,{signal:bounded.signal})]);}
        finally{bounded.abort();}
      };
      const readFailureSnapshot=async()=>{
        // The normal inspector enforces the submission deadline. Failure evidence
        // gets a separate bounded read, without submitting or extending collection.
        const snapshot=await boundedRead(()=>current.evaluate(extractVisiblePage,{surface:task.surface,question:task.prompt}));
        if(snapshot&&typeof snapshot==='object')last=accountVerified&&!snapshot.signedOut?{...snapshot,signedIn:true}:snapshot;
      };
      const failureDiagnostics=async(snapshot)=>{
        // Every browser read here has its own limit. Keep counters local to the
        // probe so a response arriving after timeout cannot mutate saved evidence.
        const inputProbe=await boundedRead(async()=>{
          let inputsVisible=0,inputsReady=0;
          for(const e of await current.locator(inputSelector(task.surface)).all())if(await e.isVisible()){inputsVisible++;if((!e.isEnabled||await e.isEnabled({timeout:500}))&&(!e.isEditable||await e.isEditable({timeout:500})))inputsReady++;}
          return {inputsVisible,inputsReady};
        });
        const state=await boundedRead(()=>current.evaluate(()=>({readyState:document.readyState,bodyChars:(document.body?.innerText||'').length})));
        return {submitted:sent,browserMode:mode,documentReadyState:['loading','interactive','complete'].includes(state?.readyState)?state.readyState:'unknown',
          bodyChars:Number.isFinite(state?.bodyChars)?state.bodyChars:(snapshot.body||'').length,inputProbeComplete:!!inputProbe,visibleInputCount:inputProbe?.inputsVisible??null,readyInputCount:inputProbe?.inputsReady??null,
          visibleControlCount:(snapshot.controls||[]).length,responseFound:!!snapshot.containerFound,responseChars:(snapshot.answer||'').length,
          responseComplete:!!snapshot.responseComplete,generating:!!snapshot.generating,sourcePanel:!!snapshot.sourcePanel,citationCount:(snapshot.citations||[]).length,
          currentResponseAccessNotice:readAccessNotice(snapshot)?'login':null,accessNoticeSource:readAccessNotice(snapshot)?.source??null,
          loginPromptTextPresent:/Login or sign\s?up for free|Save and sync your searches|Continue with Google|Continue with Apple/i.test(snapshot.body||'')};
      };
      const capture=async(status,reason='',block='none')=>{
        if(status==='observed'&&strictGuest){
          const proof=await boundedRead(()=>current.evaluate(extractVisiblePage,{surface:task.surface,question:task.prompt}));
          if(!proof||!officialSurfaceUrl(task.surface,current.url())||!proof.signedOut||proof.signedIn||proof.accountConflict){
            status='error';citationsComplete=false;
            reason='The final guest account state could not be verified; the answer is excluded and the question will not be resent.';
            last={...last,signedOut:!!proof?.signedOut,signedIn:!!proof?.signedIn,accountConflict:!!proof?.accountConflict};
          }
        }
        if(status==='observed'){
          try{await verifyEgress();}catch(error){egressValid=false;status='error';reason='采样后出口核验失败；本次答案不计入目标国家固定出口样本';notes.push(reason);}
        }
        stage('capturing');
        const snapshot=last||await inspect();
        const accessNotice=readAccessNotice(snapshot);
        if(block==='login'&&accessNotice)reason=accessNotice.source==='current_reply'&&sent?'平台当前回复要求注册或登录后重新提问；本次已提交，不自动重发':sent?'平台显示登录要求；本次已提交，不自动重发':'平台显示登录要求；本次未提交问题';
        const diagnostic=status==='error'||status==='unavailable'?await failureDiagnostics(snapshot):null;
        if(diagnostic)notes.push(`页面诊断：${diagnostic.documentReadyState}；正文 ${diagnostic.bodyChars} 字符；输入 ${diagnostic.inputProbeComplete?diagnostic.readyInputCount+'/'+diagnostic.visibleInputCount+' 可用':'检查超时或不可读'}；答案 ${diagnostic.responseChars} 字符；完成控件 ${diagnostic.responseComplete?'已确认':'未确认'}${diagnostic.loginPromptTextPresent?'；页面含登录提示文字':''}`);
        // No account names, sidebar/history labels, auth tokens or private URL paths
        // enter diagnostics. The answer candidate is from the bounded reply reader.
        const evidenceNotes=(notes.length>10?[...notes.slice(0,8),`另有 ${notes.length-9} 条重复或来源控件说明；诊断备注最多保存 10 条`,notes.at(-1)]:notes).map(note=>String(note).slice(0,500));
        const navigated=new URL(current.url());
        const currentUrl=navigated.protocol==='https:'?navigated:new URL(entryUrl);
        // Never preserve conversation IDs or submitted query strings. Bing needs its AI path
        // to distinguish Copilot evidence from ordinary Bing search results.
        const origin=currentUrl.origin;
        const sourceUrl=task.surface==='bing_copilot'&&(/^(www\.)?bing\.com$/.test(currentUrl.hostname)||currentUrl.hostname==='m365.cloud.microsoft')&&/^\/(chat|copilot)(?:\/|$)/.test(currentUrl.pathname)
          ? origin+'/'+currentUrl.pathname.split('/')[1] : origin;
        const geoPermission=await boundedRead(()=>current.evaluate(()=>navigator.permissions.query({name:'geolocation'}).then(p=>p.state).catch(()=> 'unknown')));
        const observedAt=new Date().toISOString();
        const failureEvidence=diagnostic?{diagnostics:diagnostic,answerComplete:!!completedReply,answerCandidate:sent?(snapshot.answer||'').slice(0,150000):'',answerCandidateTruncated:sent&&(snapshot.answer||'').length>150000,citationCandidates:sent?(snapshot.citations||[]).slice(0,100):[],...(accessNotice?{accessNotice}:{})}:null;
        const raw={schema:'browser-visible-text-v4',browserMode:mode,...(egressValid?{egress}:{}),citationControls,citationControlsOpened,question:task.prompt,surface:task.surface,status,reason,observedAt,model:snapshot.model,answer:status==='observed'?snapshot.answer:'',citations:status==='observed'?snapshot.citations:[],sourceOrigin:origin,citationsComplete,sourceCountExpected:snapshot.sourceCountExpected??null,unresolvedCitations:snapshot.unresolvedCitations||0,citationOverflow:snapshot.citationOverflow||0,notes:evidenceNotes,...(!citationsComplete&&snapshot.sourceDiagnostics?{sourceDiagnostics:snapshot.sourceDiagnostics}:{}),...(failureEvidence?{failureEvidence}:{})};
        const artifact=await captureArtifact(current,raw,task.captureScreenshot===true);
        return {slotId:task.slotId,prompt:task.prompt,status,reason,restriction:block,observedAt,
          answer:status==='observed'?snapshot.answer:'',citations:status==='observed'?snapshot.citations:[],model:snapshot.model,
          sourceUrl,sessionRef,account:snapshot.accountConflict?'unknown':snapshot.signedIn?'logged_in':snapshot.signedOut?'logged_out':'unknown',session:signedInMode?'active':'fresh',exitCountry:['canada_fixed','country_fixed'].includes(task.config.egressPolicy)?(egressValid?egress?.country:null):task.verifiedCountry,
          privacy:{mode:privateMode?'signed_in_private':independentMode?'signed_in_independent':'signed_out',temporaryChat:signedInMode&&task.surface==='chatgpt_search'?(privateMode?privacyVerified:snapshot.temporaryChat)?'verified':'unknown':'not_applicable',personalization:signedInMode?(privateMode&&task.surface==='chatgpt_search'?privacyVerified:snapshot.personalizationDisabled)?'disabled':'unknown':'unknown',newConversation},
          geo:(['canada_fixed','country_fixed'].includes(task.config.egressPolicy)?egressValid:task.verifiedCountry)?'ip_observed':'unverified',geoVerificationNote:egressValid?`Chrome 同一会话请求 Cloudflare trace，已核验 ${task.config.country}；出口指纹与计划一致；${egress.verifiedAt}`:task.geoVerificationNote,
          locale:snapshot.locale||task.config.locale,timezone:snapshot.timezone||task.config.timezone,device:'desktop',geolocation:geoPermission==='denied'?'denied':'unknown',searchMode,
          collectionMode:'browser_capture',retrievalUsed:status==='observed'?(task.surface==='google_aio'||snapshot.citations.length>0?true:null):null,
          browser:{name:'Google Chrome',mode,version:browserVersion,extractorVersion:VERSION,answerComplete:status==='observed',citationsComplete,citationControls,citationControlsOpened,...(egressValid?{egress}:{}),unresolvedCitations:snapshot.unresolvedCitations||0,citationOverflow:snapshot.citationOverflow||0,notes:evidenceNotes},
          artifact};
      };
      try{
        stage('opening');
        await verifyEgress();
        await current.goto(entryUrl,{waitUntil:'domcontentloaded',timeout:30000});
        await wait();await inspect();
        let block=restriction(last,current.url());if(block)return await capture('unavailable','入口显示访问限制：'+block,block);
        if(strictGuest&&!officialSurfaceUrl(task.surface,current.url()))return await capture('error','The page left the supported official entry; no question was submitted.');
        let initialPromoClosed=false,initialCookieDeclined=false;
        if(task.surface==='perplexity'){
          for(let overlayCheck=0;overlayCheck<2;overlayCheck++){
            const dismissed=await dismissPerplexityOverlays(current,{body:last.body,hasInput:!!await firstVisible(current.locator(inputSelector(task.surface))),allowClose:!initialPromoClosed,allowDecline:!initialCookieDeclined});
            initialPromoClosed=initialPromoClosed||dismissed.closed;initialCookieDeclined=initialCookieDeclined||dismissed.declined;
            await wait();await inspect();
            block=restriction(last,current.url());if(block)return await capture('unavailable','入口显示访问限制：'+block,block);
          }
        }
        stage('preparing');
        if(signedInMode&&!last.signedIn){
          last=await affirmCopilotAccount(task.surface,current,inspect);
          accountVerified=!!last.accountVerified;
        }
        let input=await findInput();
        // Initial HTML/auth navigation can precede the hydrated guest composer. A
        // visible Sign-in link alone must not terminate a still-loading provider.
        // Poll only before submission, reserving at least ten seconds of this question's
        // configured budget. CAPTCHA, explicit login redirects and limits still stop now.
        if(!input){
          const readinessPolls=Math.min(20,Math.max(0,Math.floor((deadline-Date.now()-10000)/1000)));
          for(let readiness=0;!input&&readiness<readinessPolls;readiness++){
            await delay(1000,undefined,{signal});await inspect();
            block=restriction(last,current.url());if(block)return await capture('unavailable','等待提问框时出现访问限制：'+block,block);
            input=await findInput();
            if(task.surface==='perplexity'){
              const dismissed=await dismissPerplexityOverlays(current,{body:last.body,hasInput:!!input,allowClose:!initialPromoClosed,allowDecline:!initialCookieDeclined});
              initialPromoClosed=initialPromoClosed||dismissed.closed;initialCookieDeclined=initialCookieDeclined||dismissed.declined;
              if(dismissed.closed||dismissed.declined){await inspect();input=await findInput();}
            }
          }
          if(!input)notes.push(`提交前已等待提问框最多 ${readinessPolls} 秒；未提交或重发问题`);
        }
        if(!input&&task.surface==='chatgpt_search'){
          const guest=current.getByRole('button',{name:/^(Try it first|Try ChatGPT|先试用|先试试看)$/i}).or(current.getByRole('link',{name:/^(Try it first|Try ChatGPT|先试用|先试试看)$/i}));
          if(await clickOptional(guest)){await wait();await inspect();block=restriction(last,current.url());if(block)return await capture('unavailable','官方访客入口仍显示访问限制：'+block,block);input=await findInput();}
        }
        if(!input){
          await inspect();
          if(await firstVisible(current.getByRole('button',{name:loginNames}).or(current.getByRole('link',{name:loginNames}))))return await capture('unavailable','页面仅显示登录入口，没有可用的未登录提问框','login');
          return await capture('error',(last.body||'').trim()?'没有识别到可用的公开提问框；未提交问题':'入口页面未显示可读取的正文或提问框；未提交问题');
        }
        if(signedInMode&&!last.signedIn){last=await affirmCopilotAccount(task.surface,current,inspect);accountVerified=accountVerified||!!last.accountVerified;}
        if(signedInMode){
          if(!last.signedIn)return await capture('unavailable','登录状态已失效；未提交问题','login');
          if(privateMode&&task.surface==='chatgpt_search'){
            if(!last.temporaryChat){await clickOptional(current.getByRole('button',{name:/^(Temporary|Temporary chat|Turn on temporary chat|临时对话|临时聊天|开启临时对话)$/i}));await wait();await inspect();}
            if(!last.personalizationDisabled){await clickOptional(current.getByRole('button',{name:/^(Unpersonalized|非个性化|不进行个性化)$/i}).or(current.getByRole('radio',{name:/^(Unpersonalized|非个性化|不进行个性化)/i})));await wait();await inspect();}
            privacyVerified=last.temporaryChat&&last.personalizationDisabled;
            if(!privacyVerified)return await capture('error','未能核验 Temporary Chat 与 Unpersonalized；没有提交问题，请检查当前账号界面');
            input=await findInput();
            if(!input)return await capture('error','临时对话提问框不可用；没有提交问题');
          }
        }else if(!last.signedOut||last.signedIn||last.accountConflict)return await capture('error','The guest account state could not be verified; no question was submitted.');
        newConversation=!last.containerFound;
        if(!newConversation)return await capture('error','新页面中仍有既有答案；未提交问题，避免沿用对话上下文');
        if(task.surface==='chatgpt_search'){
          const selected=current.getByRole('button',{name:/search.*(remove|click)|网页搜索.*移除|搜索网页.*移除/i});
          const search=current.getByRole('button',{name:/^(Search the web|Web search|Search|网页搜索|搜索网页)$/i})
            .or(current.getByRole('menuitemcheckbox',{name:/Search|搜索/i})).or(current.getByRole('menuitem',{name:/^(Search the web|Web search|Search|网页搜索)/i})).or(current.getByText(/^(Search the web|Web search|网页搜索|搜索网页)$/i));
          // Server-rendered controls can precede interactive hydration. Retry only opening
          // the menu (at most twice), never a submitted question or a restricted request.
          for(let preparation=0;preparation<2&&!await firstVisible(selected);preparation++){
            if(!await firstVisible(search))await clickOptional(current.getByRole('button',{name:/^(Add (files|photos).+|添加文件等|添加照片和文件)$/i}));
            const option=await waitVisible(search);
            if(option){await option.click({timeout:5000});await waitVisible(selected);}
          }
          if(!await firstVisible(selected)){await inspect();return await capture('error','网页搜索模式未得到界面确认；未提交问题');}
          searchMode='explicit_search';
        }else searchMode=['google_aio','duckduckgo_search_assist'].includes(task.surface)?'explicit_search':'natural';
        await verifyEgress();
        check();
        await input.fill(task.prompt,{timeout:5000});
        const nativeSubmit=NEW_SURFACES.has(task.surface)?await firstVisible(current.getByRole('button',{name:/^(Submit|Send|Send message|发送|提交)$/i})):null;
        if(nativeSubmit&&!await nativeSubmit.isEnabled())return await capture('error','原生提交按钮不可用；未提交问题');
        check();
        stage('submitting');sent=true;
        if(nativeSubmit)await nativeSubmit.click({timeout:5000});
        else await input.press('Enter',{timeout:5000});
        stage('waiting');
        let previous='',stable=0,started=Date.now(),expanded=false,checkedPersonalization=false;
        for(;;){
          await wait();const s=await inspect();
          block=restriction(s,current.url());if(block)return await capture('unavailable','提交问题后出现访问限制：'+block,block);
          if(strictGuest&&(!officialSurfaceUrl(task.surface,current.url())||!s.signedOut||s.signedIn||s.accountConflict))return await capture('error','The guest account state changed or could not be verified after submission; the answer is excluded and the question will not be resent.');
          if(task.surface==='google_aio'&&signedInMode&&s.hasSearchResults&&!checkedPersonalization){
            checkedPersonalization=true;
            if(!s.personalizationDisabled&&await clickOptional(current.getByRole('link',{name:/^(Try without|Try without personalization|不使用个性化|尝试不使用个性化|不经过个性化处理)$/i}))){previous='';stable=0;continue;}
          }
          const isGenerating=s.generating||await firstVisible(current.getByRole('button',{name:/^(Stop generating|Stop response|Stop streaming|Stop|停止生成|停止回答|停止回复)$/i}));
          const loading=/^(Generating|Thinking|正在生成|正在思考|搜索中)/i.test(s.answer);
          if(task.surface==='google_aio'&&s.triggered&&!expanded){
            expanded=true;
            await clickOptional(current.getByRole('button',{name:/^(Show more|显示更多|展开|Afficher plus)$/i}));
          }
          if(task.surface==='duckduckgo_search_assist'&&s.triggered&&s.duckduckgoHasMore&&!expanded){
            expanded=true;
            const expansion=await expandDuckDuckGoSearchAssist(current);
            if(expansion.ambiguous)return await capture('error','Search Assist has ambiguous expansion controls; a complete answer could not be verified.');
            if(!expansion.expanded)return await capture('error','The complete Search Assist answer could not be expanded.');
            notes.push('Expanded the native Search Assist answer before checking completion.');
            previous='';stable=0;continue;
          }
          const hasFinishedControl=NEW_SURFACES.has(task.surface)?s.responseComplete:task.surface==='google_aio'||s.responseComplete||await firstVisible(task.surface==='chatgpt_search'?current.locator('[data-testid="copy-turn-action-button"]').or(current.getByRole('button',{name:/^(Copy response|复制回复|复制回答)$/i})):current.getByRole('button',{name:/^(Copy|Copy response|Copy text|复制回复|复制|复制回答)$/i}));
          if(s.answer.length>=40&&!isGenerating&&!loading&&hasFinishedControl){stable=s.answer===previous?stable+1:0;previous=s.answer;}else stable=0;
          if(stable>=3){
            if(s.answer.length>150000)return await capture('error','答案超过 150000 字符，未静默截断');
            break;
          }
          if(task.surface==='google_aio'&&!s.triggered&&s.hasSearchResults&&Date.now()-started>25000){citationsComplete=true;return await capture('not_triggered','正常搜索结果已加载，等待 25 秒后仍未显示 AI Overview');}
          if(task.surface==='duckduckgo_search_assist'&&!s.triggered&&s.hasSearchResults&&!isGenerating&&Date.now()-started>25000){citationsComplete=true;return await capture('not_triggered','Normal search results loaded, but Search Assist did not appear after 25 seconds.');}
        }
        const completed=last;completedReply=completed;deadline=Math.max(deadline,Date.now()+45000);
        if(task.surface==='chatgpt_search'){
          // Inline citation chips can also have aria-label Sources. The aggregate control has visible Sources text.
          const sources=current.getByRole('button',{name:/(^|\s)(Sources|来源)$/i}).filter({hasText:/Sources|来源/i}).last();
          const opened=await clickOptional(sources);
          if(opened){await wait();await inspect();}
          citationsComplete=opened&&!!last.sourcePanel&&last.citations.length>0&&last.unresolvedCitations===0&&!last.citationOverflow;
          if(opened)notes.push('已展开答案末尾的全部来源面板并提取可见链接');
        }else if(task.surface==='google_aio'){
          const opened=await clickOptional(current.getByRole('button',{name:/^(Show all|Show all sources|Show all results|显示所有相关结果|显示所有来源)$/i}));
          if(opened){await wait();await inspect();}
          citationsComplete=opened&&!!last.sourcePanel&&last.citations.length>0&&last.unresolvedCitations===0&&!last.citationOverflow;
        }else if(task.surface==='duckduckgo_search_assist'){
          citationsComplete=!!last.sourcePanel&&last.responseComplete&&!last.duckduckgoHasMore&&!last.sourcePanelHasMore&&last.citations.length>0&&
            last.citations.every(c=>c.placement==='source_panel')&&last.sourceCountExpected===last.citations.length&&!last.unresolvedCitations&&!last.citationOverflow;
          notes.push('Read only the current Search Assist source region; ordinary search results are excluded.');
        }else if(NEW_SURFACES.has(task.surface)){
          const sources=await collectNewSurfaceSources(task.surface,{page:current,inspect,wait,check});
          last=sources.snapshot;citationControls=sources.citationControls;citationControlsOpened=sources.citationControlsOpened;
          citationsComplete=sources.citationsComplete;notes.push(...sources.notes);
        }else if(task.surface==='gemini'){
          const chips=current.locator('model-response,[data-message-author-role="model"]').last().getByRole('button',{name:/View source details|查看来源|来源详情/i});
          const all=await chips.all();citationControls=all.length;
          const merged=new Map(completed.citations.map(c=>[c.url,c]));let unresolved=completed.unresolvedCitations||0,overflow=completed.citationOverflow||0;
          for(const chip of all.slice(0,100)){
            try{
              check();
              await chip.press('Enter',{timeout:5000});let panel;
              for(let n=0;n<30;n++){await delay(200,undefined,{signal});panel=await inspect();if(panel.sourcePanel&&panel.citations.some(c=>c.placement==='source_panel'))break;}
              if(panel?.sourcePanel&&panel.citations.some(c=>c.placement==='source_panel'))citationControlsOpened++;
              else notes.push('来源控件未返回可辨认的链接：'+String(await chip.getAttribute('aria-label')||'').slice(0,160));
              for(const c of panel?.citations||[])merged.set(c.url,c);
              unresolved+=panel?.unresolvedCitations||0;overflow+=panel?.citationOverflow||0;
              await current.keyboard.press('Escape');
            }catch(error){notes.push('一处 Gemini 引用未能展开；来源范围未确认完整');break;}
          }
          if(!all.length){const opened=await clickOptional(current.getByRole('button',{name:/^(Sources|Show sources|来源|显示来源)$/i}));if(opened){await wait();await inspect();for(const c of last.citations)merged.set(c.url,c);citationControls=1;citationControlsOpened=last.sourcePanel?1:0;}}
          last={...last,citations:[...merged.values()].slice(0,100),unresolvedCitations:unresolved,citationOverflow:overflow+Math.max(0,merged.size-100)};
          citationsComplete=citationControls>0&&citationControlsOpened===citationControls&&merged.size>0&&!last.unresolvedCitations&&!last.citationOverflow;
          notes.push(`Gemini 可见引用控件 ${citationControls} 个，成功展开 ${citationControlsOpened} 个`);
        }
        // Sources dialogs can hide the answer; retain the previously completed body.
        last={...last,answer:completed.answer,model:completed.model,signedOut:completed.signedOut,signedIn:completed.signedIn,personalizationDisabled:completed.personalizationDisabled,
          citations:[...new Map([...completed.citations,...last.citations].map(c=>[c.url,c])).values()]};
        if(last.citations.length>100){last.citationOverflow=(last.citationOverflow||0)+last.citations.length-100;last.citations=last.citations.slice(0,100);citationsComplete=false;}
        if(!citationsComplete)notes.push('引用范围未确认完整，自动质检排除；原文保留，不计入正式品牌指标');
        return await capture('observed');
      }catch(error){
        if(error.code==='EGRESS_GUARD'&&!sent)throw error;
        if(signal.aborted||current.isClosed())throw new Error(sent?'已提交但浏览器已关闭，结果未知':'提问前浏览器已关闭');
        await readFailureSnapshot();
        if(completedReply&&error.code!=='EGRESS_GUARD'){
          // A sources dialog/control failure must not discard the already stable
          // canonical reply. It remains excluded because source coverage is unknown.
          const citations=[...new Map([...completedReply.citations,...(last?.citations||[])].map(c=>[c.url,c])).values()];
          last={...completedReply,citations:citations.slice(0,100),unresolvedCitations:Math.max(completedReply.unresolvedCitations||0,last?.unresolvedCitations||0),citationOverflow:Math.max(completedReply.citationOverflow||0,last?.citationOverflow||0)+Math.max(0,citations.length-100)};
          citationsComplete=false;
          notes.push('正文已完成；来源提取未完成，原文与已辨认引用保留，自动质检排除；没有自动重发问题');
          return await capture('observed','正文已完成，但来源范围未确认完整');
        }
        // Keep a visible failure artifact when available. Never retry a submitted request.
        if(last){notes.push(sent?'本次已提交；没有自动重试':'本次没有提交问题');return await capture('error',error.code==='EGRESS_GUARD'?'采样期间出口核验失败；已提交请求保留，不自动重发':Date.now()>deadline?'页面未在时限内提供可确认完整的答案；保留现场，不自动重试':sent?'页面控件或来源提取异常；已提交请求保留，不自动重发':'页面准备或控件识别失败；没有提交问题');}
        throw error;
      }finally{
        signal.removeEventListener('abort',abort);
        if(ownsContext)await currentContext.close().catch(()=>{});else await current.close().catch(()=>{});
        activePages.delete(task.surface);activeSurfaces.delete(task.surface);
      }
    },
  };
}
module.exports={createChromeCollector,restriction};
