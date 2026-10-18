<p align="center">
  <img src="docs/assets/getaudit-evidence-cloud.png" alt="The getaudit research companion with source cards in a cloud-shaped desk tray." width="320">
</p>

<p align="center">
  <strong>getaudit</strong><br>
  All-in-one GEO tools.<br>
  <strong>Open-source GEO monitoring, on your own computer.</strong><br>
  English · <a href="README.zh-CN.md">简体中文</a>
</p>

> **Early-access source release · MIT.** Integration code is included; configure your own accounts and credentials. No production credentials, customer records, or original development Git history are included.

## Meet getaudit

getaudit is open-source GEO auditing software for people who need to track how AI platforms mention and cite their brand. Run it on your own computer, configure supported platforms and research questions, and inspect the answers and evidence they return.

Keep your research in local storage, export the findings, or let a compatible Agent analyze selected saved results. Optional Google Search Console and GA4 connections add SEO context to your GEO research.

## Who it is for

For brand owners, marketers, SEO/GEO practitioners, and agencies who want to check their visibility in AI answers and keep control of the evidence. Start with the questions that matter to your audience, then repeat configured scans to compare recorded results over time.

<img src="docs/assets/search-desk.webp" alt="getaudit Search desk, showing fictional Northstar search data and a dated chart with a Synthetic demo badge" width="880">

*Actual getaudit interface. Synthetic example data. These figures are not customer results or a live ranking check.*

## What you get

### GEO: scan supported AI platforms from your Mac

Run getaudit locally, configure the platforms and research conditions, and start a multi-platform GEO scan. Review captured answers, brand mentions, and citations alongside the conditions under which they were collected. Blocked or incomplete attempts remain visible.

Your project keeps the collected answers, citations, research records, and reports in local storage. Platform access, region, login requirements, and rate limits still affect what can be captured.

### Optional SEO context: connect your search and traffic data

Use your Google account to connect Google Search Console (GSC) and Google Analytics 4 (GA4). Review search queries, page performance, and website traffic within your project to investigate which areas need attention. GSC average positions describe a reporting window; they are not a fresh live rank check.

Google Search Console and GA4 are the current SEO data integrations. The combined Google sign-in and GA4 workflow are still in testing. **Bing Webmaster Tools and other data connections are planned.**

### Agent analysis: turn saved findings into your next steps

Authorize a compatible third-party Agent to read selected SEO/GEO findings and evidence context from your project. Use its analysis to investigate which pages to improve, which questions need coverage, and what to check next. Review the recommendations before making changes.

The current Agent interface provides selected GSC and GEO context. It does not expose GA4, full GEO answer text, or raw capture files. Saving an Agent's analysis back to the project requires a separate permission.

## How the workflow fits together

1. **Configure your GEO project.** Add your brand, research questions, and supported platforms. Connect Google properties only if you want the extra SEO context.
2. **Run a scan locally.** Review captured answers, brand mentions, citations, and any access limits together.
3. **Use your results.** Export saved findings, or authorize a compatible Agent to read selected results.
4. **Decide what to improve.** Review the recommendations and run another configured scan when you are ready to compare.

Your work is saved locally. Google reads, AI-platform scans, and optional provider calls still contact their respective services. Evidence you authorize an external Agent to read can leave your device for analysis.

The interface supports English and 简体中文 in one click. Supported jobs can continue in the background while the app is running; quitting, sleep, or shutdown can interrupt them. Reports and evidence exports keep sources and collection conditions attached, so you can return to the basis of a finding.

## Download for Mac

[Download getaudit](https://getaudit.si/#download) · [Release notes and checksums](https://github.com/maxuod/getaudit/releases/tag/v0.4.22-community.3)

The early-access desktop package supports **Apple Silicon Macs running macOS 13 or newer**. It uses an ad-hoc signature and has **not been notarized by Apple**; macOS may block it at first launch. Follow the release notes for opening instructions and current limitations.

Install Google Chrome separately for browser-based GEO scans and configure your sources. **Google sign-in and GA4 connections are not available in this preview.** Optional third-party service costs are separate. Intel Mac, Windows, and Linux installers are not currently provided.

## Try the local demo

Use **Node.js 22.19 or newer** and npm. macOS is the current desktop target; other native platforms have not been validated.

From the repository root:

```sh
npm ci
npm run console:build
npm run console:demo
```

Open the loopback URL printed in the terminal. The demo seeds a separate local database with fictional records and needs no provider credentials. It does not make paid collection calls automatically.

For an empty local workspace:

```sh
npm run console
```

For the development desktop window on macOS:

```sh
npm run desktop:dev
```

The community desktop build uses its own application identity and data directory. It does not open another installed edition's connection vault. Source is available here; the separate community prerelease above is ad-hoc signed and is not Apple-notarized. See the [community build guide](docs/community-build.md) for packaging and compatibility details.

## Connections and current limits

| Capability | What to expect |
| --- | --- |
| Local demo, question library, evidence inspection, exports | Available without bundled account credentials. Demo records are synthetic. |
| Browser-based collection | Platform, region, session, rate limits, and CAPTCHA affect availability. Strict guest mode does not promise every platform's full answer or citations. |
| Optional model and data APIs | Integration source is included. Supply your own credentials explicitly; third-party usage can cost money. No owner keys or paid account entitlements are shared. |
| Google Search Console | Read-only connection and analysis code are included. Your account must authorize its own properties. |
| Google sign-in and GA4 | Integration is in validation. Register your own Google Cloud Desktop OAuth client for a self-built app. This is not a Google-verified public client or a claim of completed end-to-end GA4 validation. Ordinary app users should follow the Google sign-in flow, not paste authorization codes. |
| Bing Webmaster Tools | Planned SEO data connection. This is separate from the supported Microsoft Copilot GEO collection surface. |
| Third-party Agent access | Selected saved GSC/GEO findings and evidence context. GA4 and raw GEO answers/captures are outside this interface; saving an analysis requires separate permission. |
| Background jobs | Run while the application is open; this is not an operating-system daemon. |

Local storage does not make external research offline: provider requests, browser collection, and connected Google reads contact the selected services. The demo is the place to explore without configuring them.

## What is in the source

```text
apps/console/    English-first React interface and Chinese translations
desktop/        Electron shell and browser collectors
src/            Evidence ledger, connectors, analysis, reports, and CLI
tests/          Automated tests with synthetic fixtures
scripts/        Build, locale, and local review tools
website/        Bilingual showcase website and privacy-policy template
docs/           Setup, evidence boundaries, and required third-party notices
```

The SEO/GEO research and audit core is free and open source, including AI mention/citation measurement, search analysis, competitor research, keyword matrices, scoped agent access, and evidence export. Not every planned workflow is implemented. Future content-writing or publishing products are outside this repository's current promise. Third-party service charges remain separate.

## Build and check

```sh
npm run typecheck
npm run console:typecheck
npm run check:locales
npm test
npm run console:build
npm run website:build
npm run review:scan
```

The showcase has its own [setup notes](website/README.md). Its origin and operator fields are placeholders; the default contact is the project email below. Its privacy policy is a template for the eventual operator, not a representation that another person's deployment is covered.

## Keep your clues private

Keep databases, answer captures, analytics exports, logs, browser sessions, OAuth metadata, tokens, signing material, and real customer fixtures outside Git. The supplied ignore rules and review scanner are guardrails, not permission to commit those files.

Only synthetic examples belong in public tests, screenshots, and issues. See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [the release boundary](docs/RELEASE_REVIEW.md).

## Contact

Questions, feedback, and private security reports: [deeyoung_ma@maxuod.com](mailto:deeyoung_ma@maxuod.com). Please keep credentials and private research data out of email and public issues.

## License

Project source: [MIT License](LICENSE). Third-party components, the bundled font, and retained upstream legal material keep their own licenses and required attribution; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

