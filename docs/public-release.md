# Public release preparation

Personal Cloud ships as [signed cloud releases](cloud-releases.md), separate from Openza Tasks releases; Openza Desktop downloads, verifies and installs them. Earlier releases bundled one cloud artifact inside each Desktop build, as the historical sections below describe. Openza does not operate a shared task-hosting service: each owner provisions a Worker and D1 database in their own Cloudflare account. The project website and OAuth publisher domain identify Openza; they do not replace the owner's cloud address.

## Current source and packaging evidence

The [compatibility matrix](compatibility-matrix.md) records the source/pin evidence
checked on 19 October 2026. The inspected Desktop candidate pins schema 20
`0.1.0-preview.9`; the schema 25 source and local validation artifact
remain separate. No installed/deployed version, new release pin or fresh live
OAuth acceptance is inferred from that source inspection.

Schema 26 source adds [current catch-up and Web bulk safeguards](catchup-status-v1.md).
The recorded schema 25 artifact does not contain that migration or behavior.
Package and verify a schema 26 artifact with its matching Desktop consumer before
an approved upgrade; existing artifact pins are unchanged.

## Historical preparation snapshot — 11 October 2026

The following statements record checks on 11 October 2026 against cloud source
`23f15e9`. They describe historical artifact, packaging and publisher state, not
current deployment state:

- The existing `0.1.0-preview.7` bundle has 24 checksum-verified files: Worker code, six asset entries (including security-header metadata), and 17 migrations. Its assets and migrations match source.
- This repository has no GitHub Actions release/deployment workflow. Desktop consumes the checksum-manifested bundle; publishing source alone does not update an owner's Worker.
- Companion Desktop checks confirmed that supplying `PersonalCloudArtifactDirectory` copies the artifact into both build and publish output. A pinned staging helper and maintainer publish helper now build and verify the bundle; Linux CI validation invokes the same path. This is a framework-dependent publish intermediate, not a new public distribution channel or a certified Snap package.
- The public [openza/website](https://github.com/openza/website) repository supplied the product, setup and privacy pages at `https://openza.org/`. On 11 October 2026, the existing OAuth client was confirmed Public and Verified, with the Openza logo and `https://openza.org/privacy/` policy URL. Its callback, PKCE flow and three required scopes were unchanged. Cross-account authorization still required acceptance testing; website publication did not update task clouds.

### Historical preview.8 candidate

The `0.1.0-preview.8` candidate adds authenticated replica identity checks, durable serialized browser mutation retries, recovery continuity, deleted-task protection and atomic full-chain parent-cycle validation. Migration 0018 adds the parent invariant; its schema health is 18. That snapshot's packaging baseline was preview.7.

Local checks exercised generated administrative recovery SQL followed by replacement passkey bootstrap in isolated memory. Packaged Desktop, live D1 recovery and cross-account OAuth acceptance are separate integration checks. That snapshot did not cover Snap or Windows native packages.

## Historical Desktop packaging snapshot — 11 October 2026

From the companion Tasks checkout:

```sh
node scripts/personal-cloud/stage-artifact.mjs
node scripts/personal-cloud/publish-desktop.mjs 1.1.0
```

The lock for that snapshot selected source `23f15e915bcd69d6901d4c4be58cc26c476427da`, artifact `0.1.0-preview.7`, and expected manifest SHA-256 `d3df7cca1d6f747334eca0fb17a557251be1d6a2988c876958ac3296165c70b9`. The current inspected pin is recorded separately in the [compatibility matrix](compatibility-matrix.md). The staging workflow fetches its exact locked public revision into ignored operational storage, installs locked dependencies, builds locally and verifies the manifest and all entries. It does not require GitHub or Cloudflare credentials and does not deploy.

The local fresh-source staging and Production-profile publish validation passed on 11 October 2026. The existing `1.1.0` version above is a validation example, not a newly approved release version. The output was not launched or installed. See Tasks' `docs/personal-cloud-desktop-publish.md` for exact prerequisites, output paths and maintainer-only boundaries. Hosted CI execution and final public distribution acceptance remain separate checks.

## Release order

1. Integrate matching Desktop and cloud source revisions before choosing release versions and tags.
2. Verify the existing `openza.org` product page, logo, setup instructions and privacy/recovery guidance. For a new publisher, choose its permanent domain and publish that content; domain purchase alone does not verify DNS ownership.
3. Verify the existing client's Public/Verified state, scopes and callback. For a new publisher, verify the client URL domain before public promotion. Cloudflare documents that the verified client URL domain cannot subsequently change and that public visibility cannot revert to private. Promotion requires separate owner approval.
4. Select matching Desktop and cloud release versions. Establish a reproducible build from an exact cloud source revision in the Desktop release job; do not silently download an unpinned branch or rely on ignored local files. Build the cloud artifact and package it as `PersonalCloudArtifact` beside Desktop using the supported packaging project/profile. Verify every manifest entry in the final distributable, not just the source tree or local build output. Include the public client ID, exact scopes and registered callback; never embed a client secret, bootstrap grant, database or personal task data.
5. Test the final distributable on the isolated Dev channel: setup is enabled, browser authorization opens, owner security setup completes, Desktop pairs, and Web/Desktop changes round-trip. A public client must also be validated for authorization outside the publisher account; a private-client test cannot establish this.
6. Close remaining lifecycle acceptance gaps with an approved disposable cloud. A successful local SQL restore is not live D1 recovery. Destructive removal requires fresh confirmation and verification of both Worker and database absence; preserve local tasks and a private backup. Do not use an active personal cloud as an assumed disposable target.
7. Publish through the release channel after its package acceptance. Snap and Windows native distribution require their own package/channel validation; source checks alone do not certify a distributable. The companion Desktop release plan defines the package scope for each release.

## Honest user-facing promises

- Desktop continues to work offline. Cloud is optional and user-owned Cloudflare hosting, not independence from Cloudflare.
- Task content is access-controlled, not end-to-end encrypted. Provider credentials remain on Desktop.
- Browser sign-out does not erase its cached task copy. Explain shared-browser precautions.
- Explain Cloudflare plan usage and limits without promising free hosting forever.
- Explain passkeys, private recovery-code storage, lost-device revocation, backup and update procedures.
- Do not advertise automatic schema downgrade or a one-click disaster restore that the product does not provide.

See [security and privacy](../SECURITY.md) and [lifecycle precautions](lifecycle.md). Cloudflare's current [OAuth client requirements](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) are authoritative for verification and promotion.
