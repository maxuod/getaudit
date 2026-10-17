# Source release boundary

The initial public source release was authorized on 2026-10-17 after review of an isolated clean-source snapshot. This document records its boundaries and the checks required for later updates.

## Included

- Current application, Console, desktop shell, collection adapters, analysis, evidence exports, and synthetic automated tests.
- English and Simplified Chinese UI catalogs.
- A configurable showcase website with fictional example screenshots and a clearly labelled privacy template.
- Required third-party legal notices.

## Excluded

- Original Git history, author metadata, remotes, local snapshot references, hosting bindings, and account/deployment identifiers.
- Databases, backups, saved answers, client reports, research output, conversations, browser state, logs, and real customer fixtures.
- Environment values, provider keys, registered OAuth client envelopes, access/refresh tokens, signing certificates, private keys, and built installers.
- The original operator's private identity, company attribution, social profiles, private contact details, filesystem locations, and embedded company logo. The explicitly approved public project contact in the README and website configuration is intentional.

## Community build separation

The desktop build uses an independent community identity and data directory. The legacy local-grant discovery method is disabled. No company property is preselected and automatic Google reads require an explicit project preference. Report tools require an explicit evidence configuration. These changes do not migrate or alter an existing installed application.

Optional third-party integration code remains. Users configure their own accounts; no usable account entitlement is distributed. Provider names, protocol endpoints, and required dependency copyright notices are necessary technical/legal references, not private operator information.

## Before each public update

Review the README, source changes, MIT license, repository destination and public commit identity before each public update. The initial release starts fresh Git history with the project identity getaudit contributors and a non-personal .invalid email. Never publish the original development history or change the visibility of a private development repository as a substitute.

Re-run privacy and credential scans on the actual files and commits immediately before an authorized push. Do not assume that a previously reviewed snapshot clears later edits. Source publication does not create a package or installer and does not trigger website deployment.

## Initial source release decisions

The owner selected MIT for the project source and confirmed that integration functionality must remain, while their credentials and account information must be excluded. Community binary releases are a separate distribution step: follow the [community build checks](community-build.md), retain the exact runtime notices, and label ad-hoc signing, missing notarization and connection limits accurately. Private signing identities, installed workspaces and app-owner OAuth credentials remain excluded.
