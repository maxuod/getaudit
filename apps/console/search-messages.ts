// Presentation-only translations for authored search diagnostics. Evidence and user text stay unchanged.
export const searchMessages: readonly [string, string][] = [
  [
    "Canada",
    "加拿大"
  ],
  [
    "United States",
    "美国"
  ],
  [
    "United Kingdom",
    "英国"
  ],
  [
    "Australia",
    "澳大利亚"
  ],
  [
    "New Zealand",
    "新西兰"
  ],
  [
    "Germany",
    "德国"
  ],
  [
    "France",
    "法国"
  ],
  [
    "Unknown",
    "无法识别"
  ],
  [
    "Default path",
    "默认路径"
  ],
  [
    "Questions and content ideas",
    "问答与内容选题"
  ],
  [
    "Long-tail queries (4+ words)",
    "长尾查询（4 个词以上）"
  ],
  [
    "Comparisons and alternatives",
    "比较与替代品"
  ],
  [
    "Problems and pain points",
    "故障与痛点"
  ],
  [
    "Guides and templates",
    "教程与模板"
  ],
  [
    "Real GSC queries at average positions 11–20, ordered by impressions, clicks and proximity to the first page. Matching pages come only from query-and-page records. Impressions indicate an opportunity, not verified purchase intent or conversion value.",
    "真实 GSC 查询平均排名在 11–20；按展示量、点击量、较近首页的排名排序。对应页面仅来自查询×页面记录；展示量是机会信号，不是已验证的购买意图或转化价值。"
  ],
  [
    "The app is closing. Automatic reads have stopped.",
    "软件正在退出，自动读取已停止"
  ],
  [
    "Local snapshot loaded",
    "已读取本地快照"
  ],
  [
    "Several reads are queued. Wait for the current read to finish.",
    "已有多个读取条件排队，请等当前读取完成"
  ],
  [
    "Waiting for a background read",
    "等待后台读取"
  ],
  [
    "Reading Google Search Console",
    "正在读取 Google Search Console"
  ],
  [
    "Live data updated",
    "真实数据已更新"
  ],
  [
    "Automatic GSC read failed",
    "GSC 自动读取失败"
  ],
  [
    "The background GSC read stopped. Existing snapshots are retained.",
    "GSC 后台读取已停止；旧快照保留"
  ],
  [
    "GSC could not connect or timed out. No zero-value snapshot was saved. Try again.",
    "GSC 网络连接失败或超时；没有保存零值快照，请重试"
  ],
  [
    "GSC authorization has expired or been revoked. Authorize it again, then update the connection.",
    "GSC 授权已过期或撤销，请重新授权后更新连接配置"
  ],
  [
    "Import existing read-only GSC authorization or add GSC credentials in API connections.",
    "请先导入已有 GSC 只读授权，或在 API 连接中配置 GSC 凭据"
  ],
  [
    "GSC did not return valid authorization.",
    "GSC 没有返回有效授权"
  ],
  [
    "This connection requires verified read-only GSC permissions. Authorize it again with webmasters.readonly.",
    "此连接需要已验证的 GSC 只读权限，请使用 webmasters.readonly 重新授权"
  ],
  [
    "Importing authorization requires the Mac app's encrypted storage.",
    "导入授权需要 Mac 应用的加密存储"
  ],
  [
    "This authorization has no verified property access for these two sites.",
    "此授权没有这两个网站的已验证属性权限"
  ],
  [
    "No local GSC authorization was found. Configure it in API connections.",
    "没有找到可导入的本机 GSC 授权，请在 API 连接中配置"
  ],
  [
    "This site is not supported.",
    "不支持的网站"
  ],
  [
    "Enter a complete URL.",
    "请输入完整 URL"
  ],
  [
    "The URL must use HTTPS and belong to the selected site.",
    "URL 必须属于所选网站并使用 HTTPS"
  ],
  [
    "The sitemap redirect has no destination.",
    "站点地图跳转缺少目标"
  ],
  [
    "The sitemap could not be read. Check its URL and the site's response.",
    "站点地图未能读取；检查网址和网站响应"
  ],
  [
    "The sitemap has no response body.",
    "站点地图没有正文"
  ],
  [
    "The sitemap exceeds 5 MiB. Use a smaller child sitemap.",
    "单个站点地图超过 5 MiB，请使用较小的子站点地图"
  ],
  [
    "This URL did not return sitemap XML.",
    "此地址没有返回 sitemap XML"
  ],
  [
    "This request ID belongs to another operation.",
    "请求标识已被另一操作使用"
  ],
  [
    "The index-evidence hash check failed.",
    "索引证据哈希校验失败"
  ],
  [
    "This authorization cannot read the selected site.",
    "当前授权无法读取所选网站"
  ],
  [
    "Inspection failed",
    "检查失败"
  ],
  [
    "The GSC snapshot was not found.",
    "找不到 GSC 快照"
  ],
  [
    "The GSC snapshot hash check failed.",
    "GSC 快照哈希校验失败"
  ],
  [
    "GSC returned different dimensions from those requested. No snapshot was saved.",
    "GSC 返回的维度与请求不一致；没有保存快照"
  ],
  [
    "Anonymous queries may be omitted. Query, page and joint-dimension totals do not equal property totals.",
    "匿名查询可能省略；查询行、页面行、联合维度行的合计不等于属性总计。"
  ],
  [
    "This records search performance, not AI answers, citations or a dedicated generative-AI report.",
    "这是搜索表现，不是 AI 回答、引用或生成式 AI 专属报告。"
  ],
  [
    "Dates use Pacific Time and finalized data only. Missing dates or queries do not establish zero traffic or disappearance.",
    "日期以太平洋时间统计；只请求已最终确定的数据。缺失日期和缺失查询不能直接解释为零流量或消失。"
  ],
  [
    "Pages absent from the previous response are marked as appearing this period. This does not determine publication or first indexation dates.",
    "上期未返回的页面只能标记为本期出现，不能据此确定发布或首次索引日期。"
  ],
  [
    "The preset site differs from the current project.",
    "预设的网站与当前项目不一致"
  ],
  [
    "This item was not found in the current project.",
    "找不到当前项目的条目"
  ],
  [
    "The item does not exist or was removed.",
    "条目不存在或已移除"
  ],
  [
    "The AI quote did not exactly match the supplied evidence. The draft was not accepted.",
    "AI 引用未逐字匹配所提供的证据，草案未接受"
  ],
  [
    "The service was interrupted. Results and costs are unknown; the request was not resubmitted.",
    "服务中断；结果和费用未知，未自动重发"
  ],
  [
    "Set an OpenAI API key and an explicit model ID in the workspace.",
    "请在实验室配置 OpenAI API Key 和明确的模型 ID"
  ],
  [
    "The evidence has changed. Preview it again before sending.",
    "证据已变化，请重新预览后再发送"
  ],
  [
    "No real answers passed content and source-integrity checks. Synthetic demonstrations are not sent.",
    "没有通过内容与来源完整性自动质检的真实答案；合成演示不会发送"
  ],
  [
    "An AI interpretation task is already running.",
    "已有 AI 解读任务运行"
  ],
  [
    "The model output did not finish. The draft was not accepted.",
    "模型输出未完整结束，草案未接受"
  ],
  [
    "AI interpretation failed",
    "AI 解读失败"
  ],
  [
    "This task has no AI draft available for review.",
    "此任务没有可复核的 AI 草案"
  ],
  [
    "Owned-page evidence is missing. Gap analysis cannot be accepted.",
    "自有页面证据缺失，不能接受差距分析"
  ],
  [
    "The analysis does not cover each competing page that was read.",
    "分析没有逐一覆盖已读取的竞争页面"
  ],
  [
    "The analysis does not match the competing page or observed organic position.",
    "分析竞争页面或真实自然排名不匹配"
  ],
  [
    "The AI source or quote does not exactly match saved evidence.",
    "AI 来源或引文未逐字匹配保存证据"
  ],
  [
    "The competing page's approach lacks evidence from that page.",
    "竞争页面做法缺少该页面证据"
  ],
  [
    "The gap lacks paired evidence from the competing and owned pages.",
    "差距缺少竞争页面与自有页面的成对证据"
  ],
  [
    "The improvement lacks paired evidence or a named owned page.",
    "改善动作缺少成对证据或没有指定自有页面"
  ],
  [
    "Choose a supported country market code.",
    "请选择支持的国家市场代码"
  ],
  [
    "Keyword opportunities require a GSC web-search snapshot.",
    "机会关键词需要 GSC web 自然搜索快照"
  ],
  [
    "This snapshot has a page filter, so its average positions do not represent property-wide queries. Read an unfiltered GSC snapshot.",
    "此快照带有页面筛选，平均排名不代表整个属性查询；请读取不限制页面的 GSC 快照"
  ],
  [
    "GSC queries are aggregated by page, not by property. Read a property-aggregated query snapshot.",
    "GSC 查询按页面聚合，不能作为属性查询的平均排名；请读取按属性聚合的查询快照"
  ],
  [
    "Read a single-country GSC snapshot matching the selected market. ALL or another country's averages cannot replace it.",
    "请读取与所选市场一致的单一国家 GSC 快照；ALL 或不同国家的平均排名不能替代"
  ],
  [
    "The GSC property is not an owned domain of the selected brand.",
    "GSC 属性不属于所选品牌的自有域名"
  ],
  [
    "The GSC snapshot device differs from the organic-search sampling device.",
    "GSC 快照设备与自然搜索采样设备不匹配"
  ],
  [
    "GSC average positions use the saved date window. Current organic positions come separately from a live SERP observation. They are not interchangeable.",
    "GSC 查询平均排名按已保存日期窗口记录；当次自然排名单独来自实时 SERP。两者不可互换。"
  ],
  [
    "Keywords are ordered by observed performance and impressions. Business relevance and buyer intent require page comparison and do not establish sales value.",
    "选词以真实表现与展示量排序，业务相关性与买家意图仍待页面比较验证；不能视为成交价值。"
  ],
  [
    "The top three are the first three external organic pages after excluding owned domains. Different pages from the same domain are retained.",
    "前三为排除自有域名后的前三条外部自然结果页面；同一域名的不同页面均保留。"
  ],
  [
    "Reads static HTML. It does not assess site-wide internal links, backlink authority, JavaScript features or real-user performance, and does not guarantee ranking improvement.",
    "读取静态 HTML，不据此判断全站内链、外链权威、JavaScript 功能或真实用户性能；没有保证排名提升。"
  ],
  [
    "Limits per run: 5 live SERP requests, 20 public pages and 5 model analyses. Your provider accounts are billed. Unknown or failed requests are not retried automatically.",
    "本次上限 5 次实时 SERP、20 个公共页面、5 次模型分析；按你的供应商账户计费，不自动重试未知或失败请求。"
  ],
  [
    "Some keywords lack owned-URL evidence in query-and-page data. SERPs may be read, but gap analysis remains missing. Refresh a GSC snapshot with joint dimensions.",
    "部分词没有查询×页面的自有 URL 证据；可获取 SERP，但其差距分析会标为缺失。请刷新包含联合维度的 GSC 快照。"
  ],
  [
    "No keywords in this snapshot qualify at average positions 11–20. Change the date range or read more data.",
    "该快照没有平均排名 11–20 的合格关键词；请更换日期或读取更多数据"
  ],
  [
    "Add a DataForSEO login and password to read current organic positions.",
    "请先配置 DataForSEO 登录名和密码以获取当前自然排名"
  ],
  [
    "Configure the selected analysis provider's API key first.",
    "请先配置所选分析模型的 API Key"
  ],
  [
    "A keyword audit is already running. Wait for it to finish to avoid duplicate costs.",
    "已有关键词审计运行，请等待完成后再开始，避免重复费用"
  ],
  [
    "The keyword audit was not found.",
    "找不到关键词审计"
  ],
  [
    "The keyword-audit input hash check failed.",
    "关键词审计输入哈希校验失败"
  ],
  [
    "The keyword-audit report hash check failed.",
    "关键词审计报告哈希校验失败"
  ],
  [
    "The keyword-audit evidence hash check failed.",
    "关键词审计证据哈希校验失败"
  ],
  [
    "The service was interrupted. Submitted requests may have unknown provider results and costs; they were not resubmitted. Saved evidence is retained.",
    "服务已中断；已提交请求的供应商结果与费用可能未知，未自动重发。已保存证据保留。"
  ],
  [
    "The task stopped. Provider results and costs are unknown; it was not resubmitted.",
    "任务停止；供应商处理结果与费用未知，未自动重发"
  ],
  [
    "The provider could not connect or timed out. Results and costs are unknown; the request was not resubmitted.",
    "供应商连接失败或超时；结果与费用未知，未自动重发"
  ],
  [
    "The organic-search provider did not return a successful task. The raw response and missing state are retained; it was not resubmitted.",
    "自然搜索供应商未返回成功任务；保留原始响应与缺失，未自动重发"
  ],
  [
    "The organic-search provider corrected the query. The response is retained but does not establish this original keyword's position.",
    "自然搜索供应商自动纠正了查询；与原文不一致，保留响应，不作为此词排名证据"
  ],
  [
    "The provider's returned query or sampling conditions differ from the request. The response is retained but does not establish positions under the original conditions.",
    "自然搜索供应商返回的查询或采样条件与请求不匹配；保留响应，不作为原条件排名证据"
  ],
  [
    "The organic-search provider returned no results page. The raw response and missing state are retained.",
    "自然搜索供应商没有返回结果页；保留原始响应与缺失"
  ],
  [
    "The model output was incomplete or refused. Analysis for this keyword remains missing.",
    "模型输出未完成或拒绝；此词分析保留缺失"
  ],
  [
    "The model returned invalid JSON. This keyword's analysis was not accepted.",
    "模型未返回有效 JSON；此词分析未接受"
  ],
  [
    "The model output was truncated or did not end normally. This keyword's analysis remains missing.",
    "模型输出截断或未正常结束；此词分析保留缺失"
  ],
  [
    "The model's structure, positions or exact-quote checks failed. This keyword's analysis was not accepted or resubmitted.",
    "模型结构、排名或逐字证据核验未通过；此词分析未接受，未自动重发"
  ],
  [
    "The 20-public-page limit was reached.",
    "已达到 20 个公共页面上限"
  ],
  [
    "The 5-SERP-request limit was reached.",
    "已达到 5 次 SERP 请求上限"
  ],
  [
    "The owned page redirected outside the brand's domains and cannot support owned-page gap evidence.",
    "自有页面跳转到了品牌域名以外；不能作为自有页面差距证据"
  ],
  [
    "The external competing page redirected to an owned domain and is excluded from external page comparison.",
    "外部竞争页面跳转到了品牌自有域名；不作为外部页面比较"
  ],
  [
    "The owned page's body is missing. Gaps against competing pages cannot be verified.",
    "缺少已读取的自有页面正文，无法核实我们与竞争页面的差距"
  ],
  [
    "No body text could be read from the top three competing pages. Search snippets cannot support an invented analysis.",
    "没有可读取的前三竞争页面正文；无法据搜索摘要制造分析"
  ],
  [
    "The 5-model-analysis limit was reached.",
    "已达到 5 次模型分析上限"
  ],
  [
    "The task stopped or the service was interrupted. Submitted provider results and costs may be unknown; requests were not resubmitted.",
    "任务已停止或服务中断；已提交的供应商请求结果与费用可能未知，未自动重发。"
  ],
  [
    "This step is incomplete. Existing evidence is retained; the request was not resubmitted.",
    "本步骤未完成；保留已有证据，未自动重发"
  ],
  [
    "The provider returned no response body.",
    "供应商没有返回正文"
  ],
  [
    "The provider response exceeded 8 MiB.",
    "供应商正文超过 8 MiB 上限"
  ],
  [
    "The provider returned invalid or oversized JSON. The missing state is retained; the request was not resubmitted.",
    "供应商 JSON 正文无效或超过上限；保留缺失，未自动重发"
  ]
];

/** Translate only known application-authored templates; captured values stay verbatim. */
export function formatSearchMessage(message: string, language: 'en' | 'zh-CN'): string | undefined {
  const matchers: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^GSC 请求失败（HTTP (\d{3})）；请检查授权和属性权限$/, m => `GSC request failed (HTTP ${m[1]}). Check authorization and property permissions.`],
    [/^OpenAI 返回 HTTP (\d{3})；请核对账户状态，本任务不会自动重试$/, m => `OpenAI returned HTTP ${m[1]}. Check the account status. This task is not retried automatically.`],
    [/^供应商请求失败（HTTP (\d{3})）；未自动重发$/, m => `Provider request failed (HTTP ${m[1]}). It was not resubmitted.`],
    [/^每组最多 (25,000|100,000) 行，达到上限时明确标记；API 只保证部分热门行，不保证穷尽。$/, m => `Up to ${m[1]} rows per group; read limits are marked explicitly. The API guarantees only some top rows, not complete coverage.`],
    [/^GSC 平均排名覆盖 ALL 设备；本次 SERP 明确使用 (desktop|mobile)，两种范围不同。$/, m => `GSC average positions cover ALL devices. This SERP observation uses ${m[1]}; the scopes differ.`],
    [/^GSC 快照仅覆盖查询包含“([\s\S]*)”的候选，不能视为全部查询机会。$/, m => `This GSC snapshot covers candidates whose queries contain “${m[1]}”. It does not represent all query opportunities.`],
    [/^GSC 查询数据可能受热门行与分页上限限制：([\s\S]*)。$/, m => `GSC query data may be limited by top-row and pagination caps: ${m[1]}.`],
    [/^11–20 位合格查询只有 (\d+) 个，剩余 (\d+) 个位置保留为空，不从其他区间补齐。$/, m => `Only ${m[1]} queries qualify at positions 11–20. The remaining ${m[2]} slots stay empty; other position bands do not fill the gap.`],
    [/^本次接受 (\d+)\/15 组页面对比；缺少的关键词、页面或模型分析明确保留，不代表没有差距。$/, m => `${m[1]}/15 page comparisons were accepted. Missing keywords, pages or model analyses remain explicit; they do not establish an absence of gaps.`],
  ];
  for (const [pattern, english] of matchers) {
    const matched = message.match(pattern);
    if (matched) return language === 'en' ? english(matched) : message;
  }
  // Feedback generated during this session can survive an immediate language switch.
  const englishMatchers: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^GSC request failed \(HTTP (\d{3})\)\. Check authorization and property permissions\.$/, m => `GSC 请求失败（HTTP ${m[1]}）；请检查授权和属性权限`],
    [/^OpenAI returned HTTP (\d{3})\. Check the account status\. This task is not retried automatically\.$/, m => `OpenAI 返回 HTTP ${m[1]}；请核对账户状态，本任务不会自动重试`],
    [/^Provider request failed \(HTTP (\d{3})\)\. It was not resubmitted\.$/, m => `供应商请求失败（HTTP ${m[1]}）；未自动重发`],
  ];
  for (const [pattern, chinese] of englishMatchers) {
    const matched = message.match(pattern);
    if (matched) return language === 'zh-CN' ? chinese(matched) : message;
  }
  return undefined;
}
