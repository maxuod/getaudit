/** UI translations for program-authored diagnostics. Evidence text is not included. */
export const coreMessages: readonly [string, string][] = [
  ["System authorization timed out. Your saved connections are unchanged. Check macOS access and try again.", "系统授权等待超时，已保存的连接未改动。请检查 macOS 的访问授权后重试。"],
  ["macOS is still completing the previous authorization request. Your saved connections are unchanged. Wait a moment, then try again.", "macOS 仍在处理上一次授权请求，已保存的连接未改动。请稍后重试。"],
  ["Capture record or original evidence failed the integrity check", "采集记录或原始证据完整性检查失败"],
  ["Saved capture record has an invalid format", "保存的采集记录格式无效"],
  ["Optional manual review rejected this record", "可选人工检查已拒绝此记录"],
  ["Capture question or slot does not match the frozen plan", "采集问题或位置与冻结计划不符"],
  ["Synthetic demo data cannot be used as web observations", "合成演示数据不能作为网页观测结果"],
  ["Answer text is empty", "答案正文为空"],
  ["Original evidence is missing", "缺少原始证据"],
  ["Completeness of automatically extracted answer text is unconfirmed", "自动提取的正文完整性未确认"],
  ["Completeness of automatically extracted citations is unconfirmed", "自动提取的引用完整性未确认"],
  ["Text and source extractor version is missing", "缺少正文与来源提取器版本"],
  ["No source page matching the sampled platform was recorded", "未记录匹配采样入口的来源页面"],
  ["Manual import lacks text and citation completeness metadata", "手动导入记录缺少正文与引用完整性元数据"],
  ["Manual import lacks a matching platform and extractor provenance", "手动导入记录缺少匹配入口与提取器来源"],
  ["Some citations remain unresolved", "仍有未解析引用"],
  ["Citation count exceeds the extraction limit", "引用数量超出提取上限"],
  ["Not all source panels were read", "来源面板未全部读取"],
  ["A citation URL could not be safely identified", "存在无法安全识别的引用网址"],
  ["Capture source page does not match the planned platform", "采集来源页面与计划入口不符"],
  ["Search mode does not match the plan", "搜索模式与计划不符"],
  ["Observation time is outside the planned window", "观测时间不在计划窗口内"],
  ["Observation date could not be verified", "观测日期无法核验"],
  ["Automatic quality check passed", "自动质检通过"],
  ["Text is complete; sampling conditions do not match", "正文完整，采样条件未匹配"],
  ["Terminal state recorded", "结束状态已记录"],
  ["Excluded by automatic quality checks", "自动质检已排除"],
  ["Manually rejected", "人工已拒绝"],
  ["Plan configuration hash does not match", "计划配置哈希不匹配"],
  ["Frozen question set failed the integrity check", "冻结问题集完整性检查失败"],
  ["Sampling slot does not match the plan configuration", "采样位置与计划配置不符"],
  ["A frozen question in the plan is missing", "计划中的冻结问题缺失"],
  ["Saved capture text could not be parsed; original bytes were kept and the record excluded", "保存的采集原文无法解析，已保留原始字节并排除此记录"],
  ["Collection has not run or saved a record yet", "尚未执行或保存采集记录"],
  ["This platform does not support verified signed-in temporary sampling", "此入口不支持已核验的登录态临时采样"],
  ["Signed-in independent sampling conditions are unconfirmed", "未确认登录态独立采样条件"],
  ["Personalization has not been confirmed disabled", "个性化未确认关闭"],
  ["A new conversation or search page is unconfirmed", "未确认新对话或新搜索页面"],
  ["Temporary conversation is unconfirmed", "临时对话未确认"],
  ["This platform does not support signed-in independent observations", "此入口不支持登录态独立观察"],
  ["Independent sampling session is unconfirmed", "未确认独立采样会话"],
  ["Account state is unconfirmed", "账号状态未确认"],
  ["Signed-out state is unconfirmed", "未确认退出账号"],
  ["Fresh session is unconfirmed", "未确认全新会话"],
  ["Signed-in samples cannot be mixed into the signed-out baseline", "登录态样本不能混入未登录基线"],
  ["Network exit region is unverified or does not match", "出口地区未核验或不匹配"],
  ["Per-question verification evidence for the fixed target-country exit is missing", "缺少目标国家固定出口的逐题核验证据"],
  ["Language, timezone, or device does not match the plan", "语言、时区或设备与计划不符"],
  ["Location permission has not been confirmed disabled", "定位权限未确认关闭"],
  ["Synthetic demo data", "合成演示数据"],
  ["Extra characters appear after a closing CSV quote", "CSV 引号闭合后出现额外字符"],
  ["CSV contains an unclosed double quote", "CSV 有未闭合的双引号"],
  ["Multi-column files need a question, prompt, or 问题 column. Download the template for an example.", "多列文件必须包含 question、prompt 或 问题 列名；可下载模板"],
  ["More than 500 questions remain after deduplication. Split them into multiple sets.", "去重后超过 500 题，请分成多个问题集"],
  ["No questions to import", "没有可导入的问题"],
  ["The question set does not exist or has not been frozen", "prompt 集不存在或尚未冻结"],
  ["All runs passed the formal integrity checks", "所有 run 均通过 formal 完整性检查"],
  ["No assignment has been recorded", "尚未写入 assignment"],
  ["No manifest matches the current parser, question hash, assignment, and eligible baselines", "没有与当前 parser、prompt hash、分组及合格 baseline 一致的 manifest"],
  ["No strong email/contract/RFC3161/OpenTimestamps anchor yet", "尚无 email/contract/RFC3161/OpenTimestamps 强锚点"],
  ["Not preregistered yet", "尚未预注册"],
  ["No intervention records yet", "尚无干预记录"],
  ["The manifest does not define a valid follow-up round count", "manifest 未规定有效 follow-up 轮数"],
  ["No follow-up yet", "尚无 follow-up"],
  ["Manifest, preregistration, intervention, and follow-up are in the required order", "manifest/预注册/干预/follow-up 顺序成立"],
  ["Follow-up lacks prior preregistration/intervention or precedes the last intervention", "follow-up 缺少事前预注册/干预，或早于最后一项干预"],
];

/** Match only known diagnostic templates, keeping interpolated evidence and identifiers unchanged. */
export function formatCoreMessage(text: string, language: "en" | "zh-CN"): string | undefined {
  if (language === "zh-CN") return undefined;
  const rules: readonly [RegExp, (...values: string[]) => string][] = [
    [/^第 (\d+) 行问题超过 3000 字符$/, n => `Question on row ${n} exceeds 3,000 characters`],
    [/^第 (\d+) 行类型应为 discovery 或 branded$/, n => `Type on row ${n} must be discovery or branded`],
    [/^已冻结；hash (.+)$/, hash => `Frozen; hash ${hash}`],
    [/^(\d+) 条 prompt；正式推断最低门槛为每组 8 条，功效模拟可能要求更多$/, n => `${n} prompts; formal inference requires at least 8 per group, and power simulations may require more`],
    [/^(\d+) 个已封存、完整、parser 全覆盖且配置可比较的 baseline$/, n => `${n} sealed, complete baselines with full parser coverage and comparable configurations`],
    [/^只有 (\d+) 个合格 baseline；需要至少 2 个$/, n => `Only ${n} eligible baselines; at least 2 are required`],
    [/^(\d+) 个 run 因未封存、legacy config、矩阵不完整或 parser 覆盖不足而不具 formal 资格$/, n => `${n} runs are ineligible for formal analysis due to an unsealed state, legacy configuration, incomplete matrix, or insufficient parser coverage`],
    [/^干预 (\d+)、对照 (\d+)；seed\/algorithm (一致|不一致)$/, (treatment, control, consistent) => `Treatment ${treatment}, control ${control}; seed/algorithm ${consistent === "一致" ? "consistent" : "inconsistent"}`],
    [/^canonical manifest 已绑定 parser、分组和 (\d+) 个合格 baseline$/, n => `Canonical manifest binds the parser, assignment, and ${n} eligible baselines`],
    [/^(\d+) 个强外部锚点$/, n => `${n} strong external anchors`],
    [/^预注册绑定 (.+)$/, hash => `Preregistration binds ${hash}`],
    [/^(\d+) 条干预记录$/, n => `${n} intervention records`],
    [/^(\d+)\/(\d+) 个已封存、完整、parser 全覆盖且配置匹配的 follow-up$/, (n, total) => `${n}/${total} sealed, complete follow-ups with full parser coverage and matching configurations`],
    [/^入口限制未解除：([\s\S]*)$/, reason => `Platform restriction remains active: ${reason}`],
    [/^没有完整答案：([\s\S]*)$/, reason => `No complete answer: ${reason}`],
  ];
  for (const [pattern, format] of rules) {
    const match = text.match(pattern);
    if (match) return format(...match.slice(1));
  }
  if (text.startsWith("人工已接受 · ")) {
    const label = text.slice("人工已接受 · ".length);
    const pair = coreMessages.find(([, chinese]) => chinese === label);
    if (pair) return `Manually accepted · ${pair[0]}`;
  }
  const scopeBody = "仅描述这些固定问题、入口和时间窗口；不代表用户总体、因果提升或转化。自动内容筛查基于正文与引用完整性通过的答案；正式品牌指标进一步要求地区、账号、语言、时间和设备等采样条件匹配。自动质检只验证采集质量，不验证答案事实；无需人工复核，可选人工拒绝会排除记录。";
  const scopeEnglish = "Describes only these fixed questions, platforms, and date windows; it does not represent all users, causal uplift, or conversions. Automatic content screening uses answers whose text and citations passed completeness checks. Formal brand metrics additionally require matching region, account, language, time, device, and other sampling conditions. Automatic quality checks verify capture quality, not answer truth. Manual review is not required; optional manual rejection excludes a record.";
  if (text === scopeBody) return scopeEnglish;
  if (text === "登录态独立临时采样，与未登录基线分开统计。" + scopeBody) return "Signed-in independent temporary sampling is counted separately from the signed-out baseline. " + scopeEnglish;
  if (text === "独立无痕会话，按平台优先未登录、确需时使用专用登录；实际账号状态逐条保留。" + scopeBody) return "Separate incognito sessions prefer signed-out access per platform and use dedicated login only when needed. The actual account state is kept for every record. " + scopeEnglish;
  return undefined;
}
