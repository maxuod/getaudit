<p align="center"><img src="docs/assets/readme-banner.svg" alt="getaudit — All-in-one GEO tools" width="880"></p>

<p align="center"><strong>把 SEO 数据、本地 GEO 扫描和 Agent 分析整合到一个系统。</strong><br><a href="README.md">English</a> · 简体中文</p>

> **早期源码版本 · MIT。** 保留接口集成代码，使用者自行配置账号和凭据。不包含生产凭据、客户记录或原始开发 Git 历史。

## 认识 getaudit

getaudit 是一个在本地运行的集成式 SEO 与 GEO 系统。连接 Google 数据，配置并运行多平台 GEO 扫描，再授权兼容的 Agent 分析选定的研究结果，帮助你确定下一步 SEO 优化的重点。

<img src="docs/assets/search-desk.webp" alt="getaudit 搜索工作台，展示虚构的 Northstar 搜索数据，界面保留 Synthetic demo 标记" width="880">

*真实软件界面，合成示例数据。图中数值不是客户成果，也不是实时搜索排名。*

## 可以为你带来什么

### SEO：把搜索表现和网站访问数据接起来

通过 Google 账号连接 Google Search Console（GSC）和 Google Analytics 4（GA4），在项目中查看搜索查询、页面表现和网站访问情况，找出值得进一步分析的地方。GSC 平均排名反映所选时间段，不等于实时搜索排名。

目前 SEO 数据集成围绕 Google 展开。连接器已经实现，统一 Google 登录和 GA4 流程仍在测试。**Bing Webmaster Tools 和其他数据平台的连接属于后续规划**，当前快照尚未提供。

### GEO：在自己的 Mac 上运行多平台扫描

在本地运行 getaudit，配置平台和研究条件后，即可发起多平台 GEO 扫描。把采集到的回答、品牌提及、引用和采集条件放在一起检查，受限或未完成的记录也会保留。

回答、引用、研究记录和报告保存在本地项目中。实际能采集到什么，仍取决于平台权限、地区、登录要求和频率限制。

### Agent 分析：确定下一步 SEO 优化的重点

按项目授权兼容的第三方 Agent，读取选定的 SEO/GEO 发现及相关证据上下文。通过它的分析，研究哪些页面值得改进、哪些问题需要补充内容，以及下一轮该验证什么，再由你决定如何执行。

当前 Agent 接口提供选定的 GSC 与 GEO 上下文，不包含 GA4、GEO 完整回答原文或原始采集文件。将 Agent 分析保存回项目，需要单独授权。

## 实际使用流程

1. **配置项目。** 选择网站、Google 属性、研究问题和支持的平台。
2. **采集并检查。** 读取已授权的搜索数据，在本机发起配置好的 GEO 扫描。
3. **选择 Agent 可读的内容。** 授权读取选定的已保存结果进行分析，原始证据仍可在程序内查看。
4. **安排下一步优化。** 审查建议、确定 SEO 优先级，再在合适的时间采集新证据进行比较。

工作记录保存在本地。Google 数据读取、AI 平台扫描和可选供应商调用仍会连接对应服务；授权外部 Agent 读取的内容，也可能离开设备用于分析。

界面支持一键切换英文与简体中文。支持的任务可在程序运行时后台执行，退出、休眠或关机可能中断任务。报告与证据导出保留来源和采集条件，便于日后复查判断的依据。

## 下载 Mac 版

[下载 getaudit](https://getaudit.si/#download) · [版本说明与文件校验值](https://github.com/maxuod/getaudit/releases/tag/v0.4.22-community.1)

抢先体验版支持 **macOS 13 或更新系统的 Apple 芯片 Mac**。安装包采用临时签名，**尚未经过 Apple 公证**；首次打开时可能被 macOS 阻止。打开方式与当前限制见版本说明。

浏览器 GEO 扫描需另行安装 Google Chrome，并配置数据来源。**本预览版暂不提供 Google 登录与 GA4 连接**，可选第三方服务费用另计。暂不提供 Intel Mac、Windows 或 Linux 安装包。

## 先试试本地演示

需要 **Node.js 22.19 或更新版本**和 npm。当前桌面目标平台是 macOS；其他原生平台尚未验证。

在仓库根目录运行：

```sh
npm ci
npm run console:build
npm run console:demo
```

打开终端显示的本机地址。演示使用独立的本地数据库和虚构数据，无需提供接口凭据，也不会自动调用付费采集。

打开空白工作区：

```sh
npm run console
```

在 macOS 上打开开发版桌面窗口：

```sh
npm run desktop:dev
```

社区构建使用独立的应用身份与数据目录，不读取另一安装版本的连接保险库。仓库提供源码；上方另行发布的社区预览安装包采用临时签名，尚未经过 Apple 公证。打包与兼容性说明见[社区构建指南](docs/community-build.md)。

## 连接与当前限制

| 功能 | 当前边界 |
| --- | --- |
| 本地演示、问题库、证据检查、导出 | 无需随包附带账号凭据；演示数据为合成数据。 |
| 浏览器采集 | 受平台、地区、登录状态、频率限制和验证码影响。严格免登录模式不保证所有平台都能取得完整回答与引用。 |
| 可选模型与数据 API | 保留集成源码，使用者自行配置凭据。第三方可能收费；不共享项目所有者的密钥或付费额度。 |
| Google Search Console | 提供只读连接与分析代码；账号须授权自己的站点属性。 |
| Google 登录与 GA4 | 集成仍在验证。自行构建时需注册自己的 Google Cloud 桌面 OAuth 客户端；不代表已通过 Google 公开验证或完成 GA4 全流程验收。普通用户应通过 Google 登录流程授权，无需粘贴授权码。 |
| Bing Webmaster Tools | 规划中的 SEO 数据连接，与已支持的 Microsoft Copilot GEO 采集入口分开。 |
| 第三方 Agent 访问 | 提供选定的 GSC/GEO 发现及证据上下文；不包含 GA4 或 GEO 原始回答／采集文件，保存分析需要单独授权。 |
| 后台任务 | 依赖应用保持运行，不是系统常驻服务。 |

本地保存不代表所有功能离线：浏览器采集、供应商接口和 Google 数据读取会连接对应服务。未配置这些服务时，可以先使用演示了解界面。

## 源码目录

```text
apps/console/    以英文为基础的界面与中文适配
desktop/        Electron 桌面外壳和浏览器采集
src/            证据台账、连接、分析、报告与命令行
tests/          使用合成样例的自动化测试
scripts/        构建、语言检查与本地审查工具
website/        双语展示官网和隐私政策模板
docs/           设置说明、证据边界与第三方声明
```

SEO/GEO 研究与审计核心免费开源，涵盖 AI 品牌提及与引用测量、搜索分析、竞品研究、关键词矩阵、受控智能体访问和证据导出。计划中的流程不等于全部已经实现。未来写作或发布产品不在当前仓库的功能承诺内，第三方服务费用另计。

## 构建与检查

```sh
npm run typecheck
npm run console:typecheck
npm run check:locales
npm test
npm run console:build
npm run website:build
npm run review:scan
```

官网的地址和运营方为占位设置，默认联系邮箱为下方的项目邮箱。自行部署时请修改为真实配置。隐私政策是模板，不能直接代表其他运营者的真实处理方式。详见 [官网说明](website/README.md)。

## 保管好自己的数据

数据库、采集原文、分析导出、日志、浏览器会话、OAuth 配置、令牌、签名资料和真实客户样例不应进入 Git。忽略规则和扫描工具只能辅助检查。

公开测试、截图和 issue 仅使用合成示例。请阅读 [安全说明](SECURITY.md)、[参与说明](CONTRIBUTING.md)和[发布审查边界](docs/RELEASE_REVIEW.md)。

## 联系我们

问题、反馈和非公开安全报告，请发送至 [deeyoung_ma@maxuod.com](mailto:deeyoung_ma@maxuod.com)。邮件和公开 issue 中均不要附带密钥或私人研究数据。

## 许可证

项目源码采用 [MIT 许可证](LICENSE)。第三方组件、字体及保留的上游法律文件遵循各自许可证与署名要求，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
