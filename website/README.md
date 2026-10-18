# getaudit website

English-first orange-and-white showcase for an integrated SEO + GEO system, with one-click Simplified Chinese switching and real UI screenshots using fictional demonstration data.

This is the **configurable website source** distributed with the open-source project. Its privacy page is a deployment template. No operator identity, personal profiles, account bindings, customer data or API credentials are included.

## The customer workflow

Connect search data, configure local GEO scans, then choose the findings your Agent may analyze to help plan the next SEO priorities.

1. **Connect data and choose the scope.** Use a Google account to select Search Console and GA4 properties. GSC supports analysis of your site’s search visibility and performance; GA4 is intended for website-traffic analysis. Configure the brand, questions, supported AI platforms, market and language for each scan.
2. **Run configured local GEO scans.** Capture available answers, citations and collection conditions across supported AI platforms. Store scan and work records in the local workspace. Login, region, CAPTCHA and rate limits can prevent complete capture and must stay visible.
3. **Authorize Agent analysis.** Explicitly grant a compatible third-party Agent access to selected supported project findings and context. Ask it to suggest the next pages, keywords or research to prioritize. Appending its analysis requires separate permission; you decide which changes to make.

This is decision support for SEO work. It does not promise ranking, citation or traffic gains or automatically change a website.

## Local preview

Requires Node.js 22 or later. The website has no package dependencies.

```sh
npm run build
npm run check
npm run preview
```

Open http://127.0.0.1:4317. The routes are `/` and `/privacy/`; unknown paths receive a branded 404. Screenshots have a visible fictional-data disclosure. The sample-report route from the production website is excluded from this distribution; the related link returns to the product tour.

## Configuration

`src/config.mjs` keeps the origin and contributor label configurable and defaults to `https://example.com` with indexing disabled. The project contact is [deeyoung_ma@maxuod.com](mailto:deeyoung_ma@maxuod.com); all website contact links and both privacy translations use this setting. If you deploy a fork, set your own contact address and deployment facts, then review the privacy template before publishing. `SITE_ORIGIN` and `SITE_PUBLIC=1` provide explicit build overrides; a local build does not publish anything.

`src/content.mjs` authors English first and includes the Chinese adaptation. `content/privacy.json` is an example policy with a prominent template disclosure in both languages. The shared structured-data builder follows visible feature claims and deliberately makes no legal Organization, price, rating, review or download assertion.

The localized `WebSite`, homepage `WebPage` and `SoftwareApplication` descriptions use the current SEO + GEO positioning. The app’s `disambiguatingDescription` repeats the visible hero note: Google sign-in and GA4 are in testing; Bing Webmaster Tools is planned. Its active `featureList` contains only the visible benefit cards. Planned Bing Webmaster Tools is excluded from that list. Entity IDs, screenshot disclosures, privacy-template breadcrumbs and the graph-free 404 remain stable. The static build and runtime language switch use the same schema builder.

These descriptions identify the current product and its availability boundaries. They do not claim Google verification or software rich-result eligibility. The markup does not invent offers, ratings or download links.

`public/assets/` is the complete source for local artwork, font and three approved fictional screenshots. `dist/` is generated from source and ignored. There are no hosting-account bindings or repository history. `vercel.json` is a generic optional static-host configuration. It performs no deployment by itself.

## Current connection and sharing boundaries

- **Google / GSC / GA4:** connection and workspace code is implemented. A separate existing GSC connection has completed a real read. Combined Google sign-in, connection restoration and GSC/GA4 reads remain in testing, with end-to-end validation pending. Do not present this as a fully verified Google integration.
- **Bing Webmaster Tools:** planned, along with further webmaster-data connectors. The Copilot/Bing GEO collection surface is separate and still subject to platform access limits.
- **Agent access:** selected supported GSC/GEO findings and context, including citations and coverage. Current tools omit GA4 data, full original captures, screenshots, artifacts and browser sessions. Through this connection, project-scoped read access and optional append-analysis permission do not permit starting scans, spending money, editing websites or publishing.
- **Local records and external services:** work records are stored locally. Google and AI platforms receive requests selected by the user. An Agent may run locally. If it uses an external AI service, selected findings it is authorized to read may be sent to that service under its data policies.

The homepage and FAQ describe these boundaries alongside the customer benefits. The shared schema builder derives its feature descriptions from visible copy in each language. The showcase itself has no account signup, hosted Google login, payment, analytics collector or private-data collection API. The optional `/api/github` endpoint reads only the fixed public repository counts, caches successful results for five minutes, and uses no account tokens.

The project source code is licensed under [MIT](../LICENSE). The bundled Bricolage font retains its complete SIL Open Font License and required third-party notices in `public/assets/FONT-LICENSE.txt`. Do not remove those notices.


## GitHub and Mac downloads

The homepage links to the public `maxuod/getaudit` repository and fetches its star/fork counts through a same-origin endpoint. Missing or rate-limited counts remain dashes with a working GitHub link; zero is a real value. The local preview serves the same endpoint. No browser GitHub credentials, tracking or star action is added.

`src/release.mjs` holds verified immutable GitHub release metadata. A valid release enables the direct Mac ZIP link, version, architecture, size and SHA-256. Without metadata the page links to Releases and advertises no fake download. English and Chinese distinguish ad-hoc signing, Developer ID signing and notarization. Current Apple Silicon early-access builds require macOS 13+ and Google Chrome for GEO scans; the Google/GA4 connection remains in testing. A fork must use its own verified repository/release configuration before publication.


## Approved brand illustration

The website uses the owner-approved Rounded Paper evidence scout in the hero, privacy illustration, closing invitation and 404. `public/assets/getaudit-evidence-cloud.png` is copied unchanged to the runtime assets. Its source, SHA-256 and visual meaning are recorded in `content/brand-illustration-provenance.md`. The existing favicon and wordmark remain unchanged. The illustration has one brief entrance and supports reduced motion; it never represents real task progress or a verified connection.

The current three product screenshots and their conversion fingerprints are recorded in `content/product-screenshot-provenance.md` and `content/product-screenshots.json`. They show the updated real interface with the visible Synthetic demo badge.
