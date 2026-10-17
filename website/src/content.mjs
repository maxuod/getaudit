import {configureContent} from './config.mjs';
const authoredCopy = {
  "en": {
    "title": "getaudit — All-in-one GEO tools",
    "description": "An SEO + GEO system for Google performance analysis, local AI visibility scans, and authorized Agent research. Use selected findings to plan your next SEO priorities.",
    "skip": "Skip to content",
    "product": "The product",
    "how": "How it works",
    "privacy": "Privacy",
    "contact": "Say hello",
    "home": "Home",
    "breadcrumbs": "Breadcrumb",
    "developerLine": "Made by {{contributorLabel}}.",
    "language": "切换为简体中文",
    "languageShort": "中",
    "menu": "Open navigation",
    "close": "Close",
    "headline": "All-in-one<br>GEO tools.",
    "heroLead": "See your SEO and GEO together.<br>Know what to work on next.",
    "heroBody": "Connect Google data and run configured GEO scans from your Mac. Then authorize your Agent to analyze selected SEO/GEO findings and help prioritize your next improvements.",
    "heroCta": "Explore the SEO + GEO workflow",
    "heroSecondary": "See how it works",
    "heroNote": "Google sign-in and GA4 are in testing. Bing Webmaster Tools is planned.",
    "dotNote": "Dot is on the case.",
    "tourHeading": "Search performance.<br>AI visibility. One workflow.",
    "tourIntro": "See which queries bring search interest, where AI answers mention your brand, and which findings deserve a closer look. Keep the recorded conditions with each result.",
    "tourAria": "Explore the product",
    "screenshot": "A look inside getaudit",
    "zoom": "Enlarge screenshot",
    "sample": "Actual product interface · Fictional sample data",
    "workflowTitle": "Connect your data.<br>Turn findings into SEO priorities.",
    "workflowIntro": "Configure your sources and scan conditions. Run the checks you need, then choose which supported findings your Agent may analyze.",
    "steps": [
      {
        "title": "Connect your data and choose your scope.",
        "body": "Use your Google account to select your GSC and GA4 properties. Set your brand, questions, platforms, and collection conditions. The combined Google connection is in testing."
      },
      {
        "title": "Run your configured GEO scans locally.",
        "body": "Capture answers, citations, and collection conditions across supported AI platforms. Keep scan records in your local workspace and review any access limits or incomplete results."
      },
      {
        "title": "Ask your Agent what to work on next.",
        "body": "Explicitly authorize a compatible Agent to read selected supported SEO/GEO findings. Let it help prioritize pages, keywords, and follow-up research. Saving its analysis requires separate permission."
      }
    ],
    "jobsTitle": "A clearer view of performance.<br>A useful plan for the work ahead.",
    "jobsIntro": "Bring search research and AI visibility into one system, with the evidence you need to decide your next SEO actions.",
    "jobs": [
      {
        "title": "Understand your search visibility and website traffic.",
        "body": "Use GSC queries and performance to investigate how people find you. The GA4 workspace adds traffic analysis; its combined Google connection is still being tested.",
        "icon": "search"
      },
      {
        "title": "See how AI answers present your brand.",
        "body": "Run configured local GEO scans across supported platforms. Inspect captured answers and citations, with market, language, timing, and access conditions recorded.",
        "icon": "spark"
      },
      {
        "title": "Give your Agent the findings you choose.",
        "body": "Authorize project-scoped read access to supported SEO/GEO findings and context. Allow appending an analysis separately when you want to keep its recommendations with the project.",
        "icon": "folder"
      },
      {
        "title": "Choose which page or keyword to improve next.",
        "body": "Combine saved search observations with GEO findings and Agent recommendations. Prioritize follow-up work and export a report that keeps sources and conditions available.",
        "icon": "paper"
      }
    ],
    "privacyTitle": "Keep work records local.<br>Choose what your Agent receives.",
    "privacyBody": "Scan records and work history are stored in your local workspace. Collection sends requests to your chosen platforms. If your Agent uses an external AI service, the selected findings it is authorized to read may be sent to that service.",
    "privacyCta": "Read our privacy policy",
    "privacyStamp": "Stored locally.<br>Shared with permission.",
    "faqTitle": "A few good questions.",
    "faqs": [
      {
        "q": "What does combining SEO and GEO help me do?",
        "a": "Use search performance to see which queries and pages need attention, then inspect how supported AI platforms answer questions about your brand. An authorized Agent can analyze selected supported findings to help you choose the next SEO tasks."
      },
      {
        "q": "What is the status of Google, GSC and GA4?",
        "a": "Connect your Google account to choose the Search Console and GA4 properties you want to use. The combined Google connection, including GA4 traffic analysis, is currently in testing. Access is optional and read-only."
      },
      {
        "q": "What can my Agent actually access?",
        "a": "You explicitly authorize a compatible Agent to read selected project findings and supporting context. Current tools include supported GSC and GEO findings, citations, and coverage. They exclude GA4 data, complete original captures, screenshots, and browser sessions. Separate permission allows appending analysis. Through this connection, the Agent cannot start scans, spend money, edit your site, or publish."
      },
      {
        "q": "Does my research stay on my computer?",
        "a": "Work records are stored locally. Google and AI platforms receive the requests you choose to make. Your Agent can run locally; if it uses an external AI service, selected findings may be sent to that service. Choose the client and its permissions before sharing."
      },
      {
        "q": "Does every AI platform work without a login?",
        "a": "Supported platforms have different login, region, CAPTCHA, and rate limits. getaudit keeps blocked and incomplete checks visible. A failed capture does not establish that your brand was absent."
      },
      {
        "q": "Can I connect Bing Webmaster Tools?",
        "a": "Bing Webmaster Tools and further webmaster-data connectors are planned. They are not available as data connections yet. The Copilot/Bing GEO surface is a separate collection option, subject to its own access limits."
      },
      {
        "q": "Will this improve rankings or get my brand cited?",
        "a": "getaudit helps you inspect evidence and prioritize work. Results still depend on the changes you make, the platforms, and other factors. We do not promise a ranking, citation, or traffic increase."
      },
      {
        "q": "How can I try getaudit?",
        "a": "The repository contains the free, open-source audit and research core under MIT. Review its README for local setup and current limitations. Third-party data and model costs remain separate. This showcase does not create an account or connect your Google data."
      }
    ],
    "ctaTitle": "Plan your next<br>SEO improvement.",
    "ctaBody": "Start with your website and the questions your customers ask. Explore how connected search data, local GEO scans, and authorized Agent analysis fit into your workflow.",
    "cta": "Say hello to getaudit",
    "ctaNote": "A real inbox for your questions. No form, no mailing list.",
    "footerLine": "SEO + GEO evidence for your next decision.",
    "availability": "Mac app · Early access",
    "footerLanguage": "English + 简体中文",
    "back": "Back to the product",
    "policySummary": "The short version",
    "policyQuick": "Work records are local. Connecting Google or sharing selected findings with an Agent requires your permission. The combined Google/GSC/GA4 workflow is still in testing.",
    "policyDate": "Last updated",
    "policyContents": "On this page",
    "policyContact": "A question about your data?",
    "policyContactBody": "Email the getaudit team. Please don’t send passwords, tokens, or private account exports.",
    "privacyMeta": "How getaudit handles local work records, Google connections, configured GEO scans, and findings you choose to share with third-party Agents.",
    "notFoundTitle": "This clue wandered off.",
    "notFoundBody": "We couldn’t find that page. Your research desk is this way.",
    "notFoundAction": "Back to getaudit",
    "notFoundMeta": "Page not found — getaudit"
  },
  "zh-CN": {
    "title": "getaudit — 一站式 GEO 工具",
    "description": "把 Google 效果分析、本地 GEO 扫描和经授权的 Agent 研究接成一套 SEO + GEO 系统，用选定的研究结果，判断下一步优先做什么。",
    "skip": "跳到正文",
    "product": "看看产品",
    "how": "如何使用",
    "privacy": "隐私政策",
    "contact": "聊一聊",
    "home": "主页",
    "breadcrumbs": "页面位置",
    "developerLine": "由 {{contributorLabel}} 开发。",
    "language": "Switch to English",
    "languageShort": "EN",
    "menu": "打开导航",
    "close": "关闭",
    "headline": "GEO 工具，<br>一站到位。",
    "heroLead": "把 SEO 和 GEO 放在一起看，<br>下一步做什么，更清楚。",
    "heroBody": "连接 Google 数据，在 Mac 上运行配置好的 GEO 扫描。再由你授权 Agent 分析选定的 SEO/GEO 研究结果，帮助确定下一步的改进重点。",
    "heroCta": "看看 SEO + GEO 工作流程",
    "heroSecondary": "了解使用流程",
    "heroNote": "Google 登录和 GA4 仍在测试。Bing Webmaster Tools 尚在规划。",
    "dotNote": "Dot 开始找线索啦。",
    "tourHeading": "搜索表现、AI 可见性，<br>接成一套工作流程。",
    "tourIntro": "看看哪些查询带来搜索关注、AI 回答如何提及你的品牌，以及哪些发现值得继续研究。每项结果都保留当时的采集条件。",
    "tourAria": "探索产品界面",
    "screenshot": "看看 getaudit 的工作台",
    "zoom": "放大截图",
    "sample": "真实产品界面 · 虚构示例数据",
    "workflowTitle": "接好数据，<br>排清下一步的 SEO 工作。",
    "workflowIntro": "配置好数据来源和扫描条件，按需运行检查，再选择允许 Agent 分析的结果范围。",
    "steps": [
      {
        "title": "连接数据，选好研究范围。",
        "body": "使用自己的 Google 账户选择 GSC 和 GA4 资源，再配置品牌、问题、平台及采集条件。统一 Google 连接仍在测试。"
      },
      {
        "title": "在本机运行配置好的 GEO 扫描。",
        "body": "在支持的 AI 平台采集回答、引用和采集条件，工作记录保存在本地。平台访问受限或采集不完整时，会保留对应状态供你检查。"
      },
      {
        "title": "让你的 Agent 帮忙判断下一步。",
        "body": "由你明确授权兼容的 Agent，读取选定且受支持的 SEO/GEO 研究结果，帮助梳理页面、关键词和后续研究的优先级。需要把分析写回项目时，再单独授权。"
      }
    ],
    "jobsTitle": "看清现在的表现，<br>也排清接下来的工作。",
    "jobsIntro": "把搜索研究和 AI 可见性放进一套系统，用看得见来源的结果，决定下一步的 SEO 行动。",
    "jobs": [
      {
        "title": "了解你的网站搜索表现和流量。",
        "body": "通过 GSC 查询词和效果数据，研究用户如何找到你。GA4 工作区用于流量分析，相关统一 Google 连接仍在测试。",
        "icon": "search"
      },
      {
        "title": "看清 AI 回答如何介绍你的品牌。",
        "body": "在本机运行配置好的 GEO 扫描，检查支持平台上采集到的回答与引用，同时保留市场、语言、时间和访问条件。",
        "icon": "spark"
      },
      {
        "title": "把你选定的结果交给 Agent。",
        "body": "按项目授权 Agent 读取受支持的 SEO/GEO 研究结果和相关上下文。需要把建议保留在项目中时，再单独允许追加分析。",
        "icon": "folder"
      },
      {
        "title": "选出下一步要改的页面或关键词。",
        "body": "结合已保存的搜索观察、GEO 研究结果和 Agent 建议，排出后续工作的优先级，也能导出保留来源和条件的报告。",
        "icon": "paper"
      }
    ],
    "privacyTitle": "工作记录存在本地，<br>交给 Agent 的内容由你选。",
    "privacyBody": "扫描和工作记录保存在本地工作空间。采集时会向你选定的平台发送请求。Agent 使用外部 AI 服务时，获准读取的内容可能发送到该服务。",
    "privacyCta": "阅读隐私政策",
    "privacyStamp": "本地保存，<br>授权后分享。",
    "faqTitle": "几个值得问的问题。",
    "faqs": [
      {
        "q": "SEO 和 GEO 放在一起，能帮我做什么？",
        "a": "先从搜索表现看哪些查询词和页面需要关注，再检查支持的 AI 平台如何回答与你品牌相关的问题。经你授权，Agent 可以分析选定且受支持的研究结果，帮助判断下一步优先做哪些 SEO 工作。"
      },
      {
        "q": "Google、GSC 和 GA4 目前做到哪一步了？",
        "a": "使用自己的 Google 账户，选择要连接的 Search Console 和 GA4 资源。包括 GA4 流量分析在内的统一 Google 连接目前仍在测试。连接是可选的，只申请读取权限。"
      },
      {
        "q": "Agent 实际能读取和执行什么？",
        "a": "需要你明确授权兼容的 Agent，才能读取选定项目中的研究结果和相关上下文。当前工具支持部分 GSC 与 GEO 研究结果、引用及覆盖情况，不提供 GA4 数据、完整原始采集内容、截图或浏览器会话。另行授权后可以追加分析；通过这项连接，Agent 不能启动扫描、产生付费调用、修改网站或发布内容。"
      },
      {
        "q": "研究数据都会留在电脑里吗？",
        "a": "工作记录保存在本地。你发起连接或采集时，Google 和 AI 平台会收到对应请求。Agent 可以在本机运行；使用外部 AI 服务时，获准读取的内容可能发送到该服务。分享前可以自行选择客户端并控制权限。"
      },
      {
        "q": "所有 AI 平台都能免登录扫描吗？",
        "a": "各平台的登录要求、地区限制、验证码和频率限制不同。getaudit 会保留受限和采集不完整的状态，不会把一次没有成功采集的结果当成品牌未出现的证据。"
      },
      {
        "q": "能接入 Bing Webmaster Tools 吗？",
        "a": "Bing Webmaster Tools 及更多站长数据连接正在规划，目前尚未开放。Copilot/Bing 的 GEO 采集入口是另一项功能，可用性仍受对应平台访问条件限制。"
      },
      {
        "q": "用了就能提高排名或获得 AI 引用吗？",
        "a": "getaudit 帮你检查证据、安排工作重点。最终表现还取决于实际改动、平台和其他因素，我们不承诺排名、引用或流量提升。"
      },
      {
        "q": "怎么体验 getaudit？",
        "a": "仓库提供免费开源的审计与研究核心，采用 MIT 许可证。请查看仓库说明，了解本地安装方法和当前限制。第三方数据和模型调用费用另计。这个展示网站不会创建账号或连接 Google 数据。"
      }
    ],
    "ctaTitle": "排清下一步<br>要做的 SEO 改进。",
    "ctaBody": "从你的网站和客户会问的问题开始，看看搜索数据、本地 GEO 扫描和经授权的 Agent 分析，如何接入你的工作流程。",
    "cta": "和 getaudit 打个招呼",
    "ctaNote": "有问题，直接给我们发邮件。无需填表，也不会自动订阅。",
    "footerLine": "用 SEO + GEO 研究结果，做好下一步判断。",
    "availability": "Mac 版 · 抢先体验",
    "footerLanguage": "English + 简体中文",
    "back": "回到产品介绍",
    "policySummary": "先说几个重点",
    "policyQuick": "工作记录保存在本地。连接 Google 或把选定结果分享给 Agent，都需要你的授权。统一 Google/GSC/GA4 流程仍在测试。",
    "policyDate": "最后更新",
    "policyContents": "本页内容",
    "policyContact": "对数据处理有疑问？",
    "policyContactBody": "欢迎联系 getaudit 团队。请不要在邮件中发送密码、令牌或私人账号导出文件。",
    "privacyMeta": "了解 getaudit 如何处理本地工作记录、Google 连接、配置好的 GEO 扫描，以及你选择分享给第三方 Agent 的研究结果。",
    "notFoundTitle": "这条线索走丢了。",
    "notFoundBody": "没有找到这个页面。不过，工作台就在这边。",
    "notFoundAction": "回到 getaudit",
    "notFoundMeta": "没有找到页面 — getaudit"
  }
};

export const tours = {
  "en": [
    {
      "id": "ai",
      "label": "GEO scans",
      "image": "ai-visibility.webp",
      "title": "Run the questions your customers might ask.",
      "body": "Configure local scans across supported AI platforms. Inspect captured answers, citations, and collection conditions. Login, regional, and other access limits remain visible.",
      "alt": "The getaudit question library showing fictional research questions and collection controls."
    },
    {
      "id": "search",
      "label": "Search performance",
      "image": "search-desk.webp",
      "title": "Connect search performance with your next SEO task.",
      "body": "Review GSC queries, clicks, impressions, and dated average positions. GA4 traffic analysis is part of the Google integration currently being tested.",
      "alt": "The getaudit Search desk showing fictional Search Console trends and query opportunities."
    },
    {
      "id": "keywords",
      "label": "Keyword opportunities",
      "image": "keyword-opportunities.webp",
      "title": "Choose the next page or keyword to investigate.",
      "body": "Review saved query performance and GEO findings. An authorized Agent can analyze selected supported results to suggest priorities. You decide which changes to make.",
      "alt": "The getaudit Search desk showing illustrative opportunities based on dated Search Console average positions."
    }
  ],
  "zh-CN": [
    {
      "id": "ai",
      "label": "GEO 扫描",
      "image": "ai-visibility.webp",
      "title": "扫描客户可能会问的那些问题。",
      "body": "配置本地扫描，在支持的 AI 平台检查采集到的回答、引用和采集条件。登录、地区等访问限制会保留在结果中。",
      "alt": "getaudit 问题库，显示虚构示例研究问题和采集设置。"
    },
    {
      "id": "search",
      "label": "搜索表现",
      "image": "search-desk.webp",
      "title": "从搜索表现，找到下一步的 SEO 工作。",
      "body": "查看 GSC 查询词、点击、展示和带日期的平均排名。GA4 流量分析也在统一 Google 连接范围内，目前仍在测试。",
      "alt": "getaudit 搜索工作台，显示虚构的 Search Console 趋势和查询机会。"
    },
    {
      "id": "keywords",
      "label": "关键词机会",
      "image": "keyword-opportunities.webp",
      "title": "选出下一步值得研究的页面或关键词。",
      "body": "结合已保存的查询表现与 GEO 研究结果。经你授权，Agent 可以分析选定且受支持的结果，帮助排出优先级。具体怎么改，由你决定。",
      "alt": "getaudit 搜索工作台，依据带日期的 Search Console 平均排名展示虚构示例查询机会。"
    }
  ]
};

export const copy = configureContent(authoredCopy);
