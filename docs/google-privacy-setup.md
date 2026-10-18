# Google connection privacy setup

The getaudit website publishes its English-first policy at **https://getaudit.si/privacy/**, with an immediate Simplified Chinese switch. The policy covers the website, local desktop workspace, Google data and optional research/Agent transfers. It is separate from the homepage and readable without signing in.

## Maintainer configuration

For the getaudit-managed application, keep the Google Auth Platform branding consistent with the product:

| Field | Value |
| --- | --- |
| App name | getaudit |
| Homepage | https://getaudit.si/ |
| Privacy policy | https://getaudit.si/privacy/ |
| Authorized domain | getaudit.si |
| Public support contact | deeyoung_ma@maxuod.com |

Google’s support-email selector may require an eligible project owner or group address. A public contact mailbox does not automatically become an eligible Cloud selector option. Confirm the account and project before changing branding.

The project owner must establish domain ownership through Search Console and configure the domain in Google Auth Platform. HTTPS availability alone does not prove ownership to Google. Do not edit an unrelated project or use a website callback in place of the native Desktop loopback flow.

## Requested permissions

| Scope | Implemented purpose |
| --- | --- |
| `openid` | Associate a verified Google account identity with its connection. |
| `email` | Show which Google account is connected. |
| `profile` | Display the connected account’s name. |
| `https://www.googleapis.com/auth/webmasters.readonly` | List accessible Search Console properties and read their search-performance, sitemap and inspection data. |
| `https://www.googleapis.com/auth/analytics.readonly` | List accessible Analytics accounts/properties and read aggregate GA4 reports. |

These data permissions are read-only. Google’s account grant can cover accessible resources; selecting properties inside getaudit controls project use, not the scope of the Google grant. Do not request Gmail, Drive, Contacts or write permissions for this workflow.

## User controls

- The Google connection and Settings screens link to the public privacy policy before authorization.
- Google sign-out clears the managed local session. It does not revoke Google’s grant, delete saved research or disable separately authorized Agents/shares.
- Remove the grant at [Google Account connections](https://myaccount.google.com/connections). Manage legacy GSC connections, Agent keys and shares separately.
- Read the policy’s [deletion and retention controls](https://getaudit.si/privacy/#controls) before removing local application data or backups. No deletion is performed automatically by reading the policy.

## Verification boundaries

A published policy, a working link and passing source checks do not constitute Google approval. The app owner must separately verify the domain, save the branding URLs, justify the requested scopes and demonstrate the actual consent and data features Google asks to review. The demonstration must preserve real access limitations; do not substitute synthetic screenshots for a live consent/data demonstration.

The community download has no bundled app-owner OAuth client. Its Google sign-in/GA4 flow remains unavailable to ordinary users; this privacy update does not claim a successful combined Google login or new data read. Optional AI analysis must stay within the disclosed user-facing purpose and Google’s Limited Use requirements, including restrictions on general-purpose model training. This repository does not certify a user’s independently configured external provider.

## Official references

- [Google app privacy-policy requirements](https://support.google.com/cloud/answer/13806988?hl=en)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
- [OAuth production readiness and brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)
- [Desktop OAuth loopback flow](https://developers.google.com/identity/protocols/oauth2/native-app)
