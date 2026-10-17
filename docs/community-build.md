# Community desktop builds

The community packaging path is separate from private or Developer ID builds. It packages the public source and does not read local signing configuration, an app-owner Google client, saved connections, or an installed application's data.

## Platform and release status

The first community format targets **Apple Silicon Macs running macOS 13 or later**, matching the locked Electron runtime. Intel Macs, Windows and Linux are not validated download targets.

Community early-access builds use an ad-hoc signature and are **not Apple notarized**. macOS may block a downloaded copy. Review the source, release notes and checksum before deciding whether to open it; follow [Apple's application security guidance](https://support.apple.com/guide/mac-help/open-an-app-by-overriding-security-settings-mh40617/mac). Do not disable system-wide security controls.

An ad-hoc signature does not provide a stable publisher identity. macOS may ask for Keychain access again after an update, and encrypted connections may need to be configured again. Back up local research before upgrading. This workflow does not claim automatic updates or production signing continuity. See [Electron's signing guidance](https://www.electronjs.org/docs/latest/tutorial/code-signing).

## Build from source

On a compatible Mac, use the Node.js version required in the repository README:

```sh
npm ci
npm run desktop:community
```

The script builds the interface and runtime, runs both type checks and locale checks, and verifies the staged files. A final build requires reviewed runtime inputs committed to Git. `--preview` is for local checks before those inputs are committed and must not be published as a final release.

The output directory contains the application ZIP, SHA-256 file and build receipt. Build output remains outside Git. The app carries a payload manifest and release metadata identifying its source revision, platform and early-access status.

## What the package includes

- The getaudit application and its embedded Electron browser runtime.
- Application MIT license, dependency notices, exact Electron license and Chromium runtime notices.
- English and Simplified Chinese interfaces.
- A separate `getaudit Community` data directory and community application identity.

The package does not include a user's databases, browser sessions, API credentials, signing material or app-owner Google OAuth client. It does not import connections from another installed edition.

**Install Google Chrome separately for GEO browser scans.** The embedded Electron browser displays the app; the collector uses an installed Chrome browser. Platform login, region and rate limits still apply. Collection and paid providers run only when explicitly configured and requested.

Google sign-in and GA4 remain in testing. This community package has no bundled app-owner OAuth client, so its ordinary Google connection is not ready for public use. Bing Webmaster Tools remains planned. Keep those limits visible in the release notes and beside a download link.

## Before publishing a release

Inspect the actual packaged files and exact runtime notices, verify the ad-hoc signature without claiming notarization, and run a fresh-data launch and shutdown check. Do not test against a private installed workspace. Scan the extracted application payload for credentials, personal data, private paths and unexpected files.

Publish the reviewed ZIP and SHA-256 file as an explicitly labelled GitHub prerelease. The website must use the confirmed asset URL, architecture, minimum OS, byte size and checksum. A missing or unavailable asset must retain a Releases fallback rather than a fabricated download button.
