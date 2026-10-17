/** Authored application feedback only. Original answers, sources, identifiers, and hashes are never translated. */
export const samplingMessagePairs: ReadonlyArray<readonly [string, string]> = [
  ['Exit-country confirmation needs a verification basis of at least 15 characters.', '确认出口国家时需填写核验依据（至少 15 字符）'],
  ['Batch Chrome sampling requires the Mac app.', '批量 Chrome 采样需要 Mac 应用'],
  ['Uses independent temporary Chrome sessions without reading your personal browser profile', '使用独立 Chrome 临时会话，不读取个人浏览器资料'],
  ['Google Chrome was not found at /Applications/Google Chrome.app. Install standard Chrome.', '未找到 /Applications/Google Chrome.app，请安装标准 Chrome'],
  ['This platform has a restriction record, but complete matching capture evidence is missing. It cannot be classified as a login issue; the original restriction remains.', '当前入口有受限记录，但缺少完整、匹配的捕获证据，无法认定为登录问题；原限制保留。'],
  ['Capture evidence confirms this platform requires login. This plan is frozen as signed out. Create an independent-session plan before setting up login; the original plan and records are kept.', '捕获证据确认此入口要求登录；当前计划已冻结为未登录条件，请新建独立会话计划后配置登录。原计划和采样记录保留。'],
  ['This plan’s login window is confirmed, but the original login restriction remains. Confirm again in setup, then manually continue only unsubmitted positions.', '本计划的登录窗口已确认，但原登录限制仍保留；在配置处再次确认后，仅可手动继续未提交位置。'],
  ['This plan’s login window is confirmed. The login restriction for the signed-out scope remains; login confirmation does not remove it automatically. Review restriction handling or create an independent-session plan.', '本计划的登录窗口已确认；当前未登录范围的登录限制仍保留，登录确认不会自动解除此限制。请查看限制处理，或新建独立会话计划。'],
  ['This plan’s independent login is confirmed. Set it up again after closing the window, ending the session, or restarting the app.', '本计划的独立登录已确认；关闭窗口、结束会话或重启应用后需要重新配置。'],
  ['Login preparation is unconfirmed or the window has expired. Open this plan’s independent window, finish signing in, then click Confirm login.', '登录准备尚未确认或窗口已失效；请打开本计划的独立窗口，完成登录后点击确认登录。'],
  ['Capture evidence confirms this platform requires login. Open and confirm an independent window in this plan’s login setup, then manually continue unsubmitted tasks.', '捕获证据确认此入口要求登录；请在本计划的平台登录配置处打开独立窗口并确认登录，之后手动继续未提交任务。'],
  ['This plan uses signed-in temporary sampling. Set up and confirm an independent login window for each platform first.', '此计划采用登录态临时采样，每个入口都需要先配置并确认独立登录窗口。'],
  ['This plan previously encountered a login requirement. No independent session is confirmed now; set up login again after ending a session or restarting the app.', '本计划曾遇到登录要求；当前没有已确认的独立会话，关闭会话或重启应用后请重新配置登录。'],
  ['There is no complete evidence that this platform requires login. This plan keeps signed-out sampling.', '当前没有完整证据表明此入口要求登录；本计划保持未登录采样。'],
  ['There is no complete evidence that this platform requires login. Start signed out, and set up an independent login in this plan if needed.', '当前没有完整证据表明此入口要求登录；可以先未登录采样，必要时在本计划配置独立登录。'],
  [' This platform does not yet support this plan’s login mode.', ' 此入口暂不支持当前计划的登录模式。'],
  [' Login setup requires an updated Mac app.', ' 登录配置需要更新后的 Mac 应用。'],
  [' Pause the running sampling batch before setup.', ' 配置前需先暂停正在采样的批次。'],
  [' Another plan has prepared login sessions. End that plan’s independent sessions first.', ' 另一个计划保有登录准备，请先结束其他计划的独立会话。'],
  [' Independent-session confirmation status is currently unavailable.', ' 当前无法读取独立会话确认状态。'],
  ['Login setup uses only the selected plan’s independent temporary windows and does not save passwords. This check does not open pages, remove restrictions, or start sampling.', '登录配置仅用于所选计划的独立临时窗口，不保存账号密码；本检查不会打开网页、解除限制或开始采样。'],
  ['The target-country exit does not match or has changed. This plan is paused; restore the original exit before continuing.', '目标国家出口不匹配或已变化；本计划已暂停，请恢复原出口后继续'],
  ['The browser batch was not found.', '浏览器批次不存在'],
  ['Batch Chrome sampling currently supports only desktop plans.', 'Chrome 批量采样目前只支持 desktop 计划'],
  ['No unqueued empty positions remain for today. Use the resume button for an existing batch.', '当天没有尚未入队的空白位置；已有批次请使用恢复按钮'],
  ['A batch can contain at most 5,000 positions.', '单批最多 5000 个位置'],
  ['Open independent login windows for every platform in this plan and confirm the login state first. Login must be repeated after closing the app.', '请先为本计划的每个入口打开独立登录窗口，并确认登录状态；关闭应用后需重新登录'],
  ['Pause the running browser batch first.', '请先暂停正在运行的浏览器批次'],
  ['This signed-in platform is not enabled in the current plan.', '当前计划没有启用此登录态入口'],
  ['Login preparation requires an updated Mac app.', '登录准备需要更新后的 Mac 应用'],
  ['A browser batch started while login was being confirmed. Pause it before confirming again.', '确认登录期间已有浏览器批次运行；请先暂停后再确认'],
  ['Independent login is confirmed. This position has not been submitted and can be continued manually.', '独立登录已确认；此位置尚未提交，可手动继续'],
  ['The pause is still finishing: saving the current record or closing the browser. Continue once that is done.', '暂停收尾尚未完成；正在保存当前记录或关闭浏览器，完成后可继续采样'],
  ['No unsubmitted tasks can continue right now. Resolve restricted access first; submitted requests and requests with unknown outcomes are not resent automatically.', '当前没有可继续的未提交任务；受限入口需先处理限制，已提交或结果未知的请求不会自动重发'],
  ['A browser batch is already running. Pause it first.', '已有浏览器批次运行，请先暂停'],
  ['The continuation plan is ready. Prepare and confirm its logins again before continuing unsubmitted tasks.', '续采计划已建立；请为此计划重新准备并确认登录，再继续未提交任务'],
  ['; all platforms were stopped without duplicate submissions.', '；全部入口已停止，未重复提交'],
  ['The batch was interrupted unexpectedly. Unknown requests are kept; inspect them before resuming.', '批次意外中断；保留未知请求，请检查后恢复'],
  ['The batch encountered an error. Unconfirmed requests will not be resent.', '批次异常；未确认请求不会重发'],
  ['This position has a submission checkpoint with an unknown outcome. It was not resent automatically.', '此位置保留已提交检查点，结果未知；未自动重发'],
  ['The date window has ended. Remaining positions are kept; create a new plan for a new date.', '日期窗口已结束；剩余位置保留，需为新日期建立新计划'],
  ['This position already has evidence from another route. The query was not repeated.', '此位置已有其他途径取得的证据，未重复查询'],
  ['Exit verification failed. The question was not submitted.', '出口核验失败；未提交问题'],
  ['The target-country exit failed verification. Unsubmitted tasks are kept; restore the original exit before continuing.', '目标国家出口未通过核验；未提交任务保留，恢复原出口后继续'],
  ['Stopped. Requests that may have been submitted will not be resent automatically.', '已停止；可能已提交的请求不会自动重发'],
  ['Sampling could not finish. Check the browser or diagnostic log; no automatic retry is attempted.', '采样未能完成；请查看浏览器或诊断日志，不自动重试'],
  ['Sampling was interrupted on this platform. Other platforms continue; inspect it before continuing unsubmitted tasks.', '此入口采样中断；其余入口继续，检查后可继续未提交任务'],
  ['The collector returned a different question identity.', '采集器返回的问题身份不一致'],
  ['The answer and evidence are saved, and automatic quality checks are updated.', '答案与证据已保存，自动质检已更新'],
  ['This platform failed and its later questions are paused. Other platforms continue; inspect it before resuming.', '此入口出现失败，后续问题已暂停；其余入口继续，检查后可恢复'],
  ['Paused. In-flight questions on each platform have been handled; resuming runs only unsubmitted positions.', '已暂停；各入口在途问题已处理，恢复只执行尚未提交的位置'],
  ['Other runnable platforms have been handled. Unsubmitted tasks on failed platforms await continuation; restricted and unknown positions are not resent automatically.', '其他可执行入口已处理；失败入口的未提交任务等待恢复，受限与未知位置不自动重发'],
  ['This batch is complete. Quality checks and results are updated and ready to view or export.', '本批已完成；自动质检与结果已更新，可直接查看或导出'],
  ['Stopped. Unsubmitted positions are kept. Submitted requests without returned answers will not be resent automatically; independent login preparation has ended.', '已停止；未提交位置保留，已提交但未返回的请求不会自动重发；独立登录准备已结束'],
  ['Stopping. Submitted requests without returned answers will remain outcome unknown.', '正在停止；已提交但未返回的请求将保留为未知'],
  ['Waiting for the current question on each platform to be saved before pausing.', '等待各入口当前问题保存后暂停'],
  ['Another browser batch is still running. Pause it before ending this plan’s login preparation.', '另一个浏览器批次仍在运行，请先暂停后再结束此计划的登录准备'],
  ['Stopped. Unsubmitted positions are kept and this plan’s independent login preparation has ended.', '已停止；未提交位置保留，此计划的独立登录准备已结束'],
  ['Paused. Resuming runs only unsubmitted positions.', '已暂停；恢复只执行尚未提交的位置'],
  ['No complete evidence yet.', '尚无完整证据'],
  ['Wait for sampling to finish', '等待采样完成'],
  ['Excluded; the manual rejection record is kept', '已排除；保留人工退回记录'],
  ['Excluded automatically; inspect the capture-quality reasons', '已自动排除；查看采集质量原因'],
  ['Excluded from formal metrics; condition differences are kept', '已排除出正式指标；保留条件差异'],
  ['View cited pages and results', '查看已引用页面与结果'],
  ['View brand mentions and link differences', '查看品牌提及与链接差异'],
  ['View actual cited pages and content hypotheses to verify', '查看实际引用页面与待验证内容假设'],
  ['All records are checked automatically. Complete answers and sources can support candidate observations; formal brand metrics include only quality-passed records with matching sampling conditions, with no item-by-item confirmation. Manual rejections remain excluded. A missing mention does not explain its cause. This table does not call paid models and is not a technical website audit.', '全量自动质检；完整答案与来源可用于候选观察，正式品牌指标只纳入质量通过且采样条件匹配的记录，无须人工逐条确认。人工退回仍排除。未提及不是原因判断。本表不调用付费模型，不构成网站技术审计。'],
  ['Only links and source panels actually shown on the captured page are identified. These do not represent the model’s complete internal search history or prove every source was cited in the answer. Readable original links include diagnostic candidates that failed quality checks; synthetic demonstrations are labeled separately and are not consumer-answer evidence. Formal counts include only quality-passed records with matching conditions, with no item-by-item confirmation.', '仅识别采集页面实际展示的链接与来源面板，不代表模型后台全部搜索记录，也不证明每条来源均被正文引用。原始可读链接包含未通过质检的诊断候选；合成演示单独标注，不构成消费者答案证据。正式计数只纳入自动质检通过且条件匹配的记录，无须人工逐条确认。'],
  ['Capture-record or original-evidence integrity check failed', '采集记录或原始证据完整性检查失败'],
  ['The saved capture record has an invalid format', '保存的采集记录格式无效'],
  ['An optional manual check rejected this record', '可选人工检查已拒绝此记录'],
  ['The captured question or position does not match the frozen plan', '采集问题或位置与冻结计划不符'],
  ['Synthetic demo data cannot serve as a web observation', '合成演示数据不能作为网页观测结果'],
  ['The answer body is empty', '答案正文为空'],
  ['Original evidence is missing', '缺少原始证据'],
  ['Completeness of the extracted answer is unconfirmed', '自动提取的正文完整性未确认'],
  ['Completeness of the extracted citations is unconfirmed', '自动提取的引用完整性未确认'],
  ['Answer and source extractor versions are missing', '缺少正文与来源提取器版本'],
  ['No source page matching the sampling platform was recorded', '未记录匹配采样入口的来源页面'],
  ['The manual import lacks answer and citation completeness metadata', '手动导入记录缺少正文与引用完整性元数据'],
  ['The manual import lacks a matching platform and extractor provenance', '手动导入记录缺少匹配入口与提取器来源'],
  ['Some citations remain unresolved', '仍有未解析引用'],
  ['The citation count exceeds the extraction limit', '引用数量超出提取上限'],
  ['The source panel was not read completely', '来源面板未全部读取'],
  ['Some citation URLs cannot be identified safely', '存在无法安全识别的引用网址'],
  ['The captured source page does not match the planned platform', '采集来源页面与计划入口不符'],
  ['The search mode does not match the plan', '搜索模式与计划不符'],
  ['The observation time is outside the plan window', '观测时间不在计划窗口内'],
  ['The observation date cannot be verified', '观测日期无法核验'],
  ['Automatic quality checks passed', '自动质检通过'],
  ['Answer complete; sampling conditions do not match', '正文完整，采样条件未匹配'],
  ['Terminal state recorded', '结束状态已记录'],
  ['Excluded by automatic quality checks', '自动质检已排除'],
  ['Rejected manually', '人工已拒绝'],
  ['The time zone is invalid', '时区无效'],
  ['The date is invalid', '日期无效'],
  ['A fixed Canada exit plan must use country CA', '固定加拿大出口的计划国家必须为 CA'],
  ['The selected platform does not yet support verified signed-in temporary sampling. Use a signed-out independent session.', '所选入口暂不支持已核验的登录态临时采样；请使用未登录独立会话'],
  ['Platforms and windows cannot be duplicated', '入口与窗口不可重复'],
  ['Citations must use web URLs', '引用必须是网页地址'],
  ['Sources must use HTTPS URLs', '来源必须是 HTTPS 地址'],
  ['A complete answer needs body text', '完整答案需要正文'],
  ['An incomplete answer cannot include body text or citations', '无完整答案时不能填写正文或引用'],
  ['Record the reason the task ended', '请记录结束原因'],
  ['Attach a screenshot or original text evidence', '请附上截图或文本原始证据'],
  ['Describe the access restriction', '请说明访问限制'],
  ['Access restrictions apply only to unavailable states', '访问限制只适用于无法访问状态'],
  ['A verified exit needs a country', '已核验出口时必须填写国家'],
  ['The observation time cannot be in the future', '观测时间不能在未来'],
  ['This platform does not support verified signed-in temporary sampling', '此入口不支持已核验的登录态临时采样'],
  ['Signed-in independent sampling conditions are unconfirmed', '未确认登录态独立采样条件'],
  ['Personalization has not been confirmed off', '个性化未确认关闭'],
  ['A new conversation or search page is unconfirmed', '未确认新对话或新搜索页面'],
  ['Temporary conversation mode is unconfirmed', '临时对话未确认'],
  ['This platform does not support signed-in independent observation', '此入口不支持登录态独立观察'],
  ['An independent sampling session is unconfirmed', '未确认独立采样会话'],
  ['Account state is unconfirmed', '账号状态未确认'],
  ['Sign-out is unconfirmed', '未确认退出账号'],
  ['A fresh session is unconfirmed', '未确认全新会话'],
  ['Signed-in samples cannot be mixed into the signed-out baseline', '登录态样本不能混入未登录基线'],
  ['The exit location is unverified or does not match', '出口地区未核验或不匹配'],
  ['Per-question verification evidence for the fixed target-country exit is missing', '缺少目标国家固定出口的逐题核验证据'],
  ['Language, time zone, or device does not match the plan', '语言、时区或设备与计划不符'],
  ['Location permission has not been confirmed off', '定位权限未确认关闭'],
  ['Synthetic demo data', '合成演示数据'],
];

const exact = new Map(samplingMessagePairs.flatMap(pair => [[pair[0], pair], [pair[1], pair]] as const));
const readinessSuffixes = samplingMessagePairs.filter(pair => pair[1].startsWith(' '));
const readinessBases = samplingMessagePairs.filter(pair => /^(当前入口有受限记录|捕获证据确认|本计划的登录窗口|本计划的独立登录|登录准备尚未|此计划采用|本计划曾遇到|当前没有完整证据)/.test(pair[1]));

/** Render only allowlisted server-authored wrappers. Any embedded original diagnostic stays verbatim. */
export function samplingMessage(message: string | null | undefined, language: 'en' | 'zh-CN'): string {
  if (!message) return '';
  const pair = exact.get(message);
  if (pair) return pair[language === 'zh-CN' ? 1 : 0];
  if (language === 'zh-CN') return message;

  // Readiness text appends fixed application reminders to a fixed application reason.
  // Do not replace text inside an unknown reason, a captured answer, or a source title.
  const base = readinessBases.find(pair => message.startsWith(pair[1]));
  if (base) {
    let remainder = message.slice(base[1].length), result = base[0];
    while (remainder) {
      const suffix = readinessSuffixes.find(pair => remainder.startsWith(pair[1]));
      if (!suffix) { result += remainder; break; }
      result += suffix[0]; remainder = remainder.slice(suffix[1].length);
    }
    return result;
  }

  let match = /^当前入口受 (none|login|captcha|rate_limit|region) 限制；登录配置不能解除这类限制。([\s\S]*)$/.exec(message);
  if (match) {
    const restriction = {none:'an unspecified access restriction', login:'a login restriction', captcha:'a CAPTCHA restriction', rate_limit:'a rate limit', region:'a location restriction'}[match[1] as 'none'|'login'|'captcha'|'rate_limit'|'region'];
    return `This platform is under ${restriction}. Login setup cannot remove this kind of restriction.${match[2] ? ' ' + match[2] : ''}`;
  }
  match = /^独立登录已确认；(\d+) 个未提交位置可手动继续。原登录失败和未知请求保留，未自动开始采样。$/.exec(message);
  if (match) return `Independent login is confirmed. ${match[1]} unsubmitted positions can continue manually. Original login failures and unknown requests are kept; sampling has not started automatically.`;
  match = /^从原批次续接 (\d+) 个未提交位置；按 (\d{4}-\d{2}-\d{2}) 记录，地区待重新核验$/.exec(message);
  if (match) return `${match[1]} unsubmitted positions continue from the original batch, recorded on ${match[2]}. Location needs to be verified again.`;
  match = /^(\d+) 个未提交位置已转入 (\d{4}-\d{2}-\d{2}) 的续采批次；已保存证据及入口限制保留$/.exec(message);
  if (match) return `${match[1]} unsubmitted positions have moved to the continuation batch for ${match[2]}. Saved evidence and platform restrictions are kept.`;
  match = /^已转入 (\d{4}-\d{2}-\d{2}) 的续采批次 ([a-zA-Z0-9-]+)；原位置与日期保留$/.exec(message);
  if (match) return `Moved to continuation batch ${match[2]} for ${match[1]}. The original position and date are kept.`;
  match = /^人工已接受 · ([\s\S]+)$/.exec(message);
  if (match) return `Accepted manually · ${samplingMessage(match[1], language)}`;
  match = /^没有完整答案：(observed|not_triggered|unavailable|error|cancelled)(?: · ([\s\S]*))?$/.exec(message);
  if (match) {
    const status = {observed:'observed', not_triggered:'not triggered', unavailable:'unavailable', error:'error', cancelled:'cancelled'}[match[1] as 'observed'|'not_triggered'|'unavailable'|'error'|'cancelled'];
    return `No complete answer: ${status}${match[2] ? ' · ' + match[2] : ''}`;
  }
  if (message.endsWith('；全部入口已停止，未重复提交')) {
    const original = message.slice(0, -'；全部入口已停止，未重复提交'.length);
    return samplingMessage(original, language) + '; all platforms were stopped without duplicate submissions.';
  }
  return message;
}
