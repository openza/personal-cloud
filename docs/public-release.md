# Public release preparation

Personal Cloud ships with Openza Tasks. Openza does not operate a shared task-hosting service: each owner provisions a Worker and D1 database in their own Cloudflare account. The project website and OAuth publisher domain identify Openza; they do not replace the owner's cloud address.

## Current preparation snapshot

Checked on 11 October 2026 against cloud source `23f15e9`:

- Type checking passed; 85 Worker tests, four Web paging tests and three emergency recovery-generator tests passed.
- The existing `0.1.0-preview.7` bundle has 24 checksum-verified files: Worker code, six asset entries (including security-header metadata), and 17 migrations. Its assets and migrations match source.
- The cloud Git history passed secret scanning. These results do not certify a future release artifact or constitute deployment acceptance.
- This repository has no GitHub Actions release/deployment workflow. Desktop consumes the checksum-manifested bundle; publishing source alone does not update an owner's Worker.
- The cloud feature branch is not merged into `main`. Release integration and final version selection remain pending.
- Companion Desktop checks confirmed that supplying `PersonalCloudArtifactDirectory` copies the artifact into both build and publish output. A pinned staging helper and maintainer publish helper now build and verify the bundle; Linux CI validation invokes the same path. This is a framework-dependent publish intermediate, not a new public distribution channel or a certified Snap package.
- The existing reviewed Desktop fix snapshot retains 494 passing tests and a successful direct host build. Reusing that unchanged snapshot's evidence is distinct from testing a future release package.
- The owner selected `openza.org` as the publisher domain. Purchase is not DNS verification or authorization to promote OAuth.
- The public website now lives in the separate [openza/website](https://github.com/openza/website) repository. The product page, logos, setup guide and privacy guide are deployed at `https://openza.org/`. After explicit owner approval on 11 October 2026, Cloudflare's dashboard confirms the existing OAuth client is Public and Verified. This enables authorization by other Cloudflare users; it does not publish their tasks or certify the final Desktop release.
- Source access is now public with the owner's explicit approval. Anonymous Git access and the pinned source revision both return HTTP 200. A fresh credential-free staging build passed, with the expected manifest and all 24 entries verified. This removes the previously confirmed private-repository blocker; hosted CI acceptance remains a distinct unperformed check.
- The existing OAuth client has the Openza logo and `https://openza.org/privacy/` policy URL, retaining its original callback, PKCE flow and three required scopes. Public promotion is complete; authorization outside the publisher account still requires acceptance testing. Website visibility wording has been corrected separately; that copy update has not yet been deployed.

## Reproducible Desktop handoff

From the companion Tasks checkout:

```sh
node scripts/personal-cloud/stage-artifact.mjs
node scripts/personal-cloud/publish-desktop.mjs 1.1.0
```

The checked-in lock selects source `23f15e915bcd69d6901d4c4be58cc26c476427da`, artifact `0.1.0-preview.7`, and expected manifest SHA-256 `d3df7cca1d6f747334eca0fb17a557251be1d6a2988c876958ac3296165c70b9`. Staging fetches that exact public revision into ignored operational storage, installs locked dependencies, builds locally and verifies the manifest and all entries. It does not require GitHub or Cloudflare credentials and does not deploy.

The local fresh-source staging and Production-profile publish validation passed on 11 October 2026. The existing `1.1.0` version above is a validation example, not a newly approved release version. The output was not launched or installed. See Tasks' `docs/personal-cloud-desktop-publish.md` for exact prerequisites, output paths and maintainer-only boundaries. Hosted CI execution and final public distribution acceptance remain separate checks.

## Release order

1. Preserve and verify the companion Desktop fixes, excluding the separately deferred Settings redesign. Confirm both repositories' release changes are committed, reviewed as required, and integrated into their release bases before tagging.
2. Choose the permanent OAuth publisher domain and publish a product page, logo, setup instructions and privacy/recovery guidance. Do not substitute a domain purchase for DNS ownership verification.
3. Verify the client URL domain and confirm the exact existing client, scopes and callback before public promotion. Cloudflare documents that the verified client URL domain cannot subsequently change and that public visibility cannot revert to private. Promotion requires separate owner approval.
4. Select matching Desktop and cloud release versions. Establish a reproducible handoff from an exact cloud source revision to the Desktop release job; do not silently download an unpinned branch or rely on ignored local files. Build the cloud artifact and package it as `PersonalCloudArtifact` beside Desktop using the supported packaging project/profile. Verify every manifest entry in the final distributable, not just the source tree or local build output. Include the public client ID, exact scopes and registered callback; never embed a client secret, bootstrap grant, database or personal task data.
5. Test the final distributable on the isolated Dev channel: setup is enabled, browser authorization opens, owner security setup completes, Desktop pairs, and Web/Desktop changes round-trip. A public client must also be validated for authorization outside the publisher account; a private-client test cannot establish this.
6. Close remaining lifecycle acceptance gaps with an approved disposable cloud. A successful local SQL restore is not live D1 recovery. Destructive removal requires fresh confirmation and verification of both Worker and database absence; preserve local tasks and a private backup. Do not use an active personal cloud as an assumed disposable target.
7. Publish only through the explicitly approved release channel after acceptance. Snap and Windows remain deferred for this preparation; their exclusion does not certify those packages.

## Honest user-facing promises

- Desktop continues to work offline. Cloud is optional and user-owned Cloudflare hosting, not independence from Cloudflare.
- Task content is access-controlled, not end-to-end encrypted. Provider credentials remain on Desktop.
- Browser sign-out does not erase its cached task copy. Explain shared-browser precautions.
- Explain Cloudflare plan usage and limits without promising free hosting forever.
- Explain passkeys, private recovery-code storage, lost-device revocation, backup and update procedures.
- Do not advertise automatic schema downgrade or a one-click disaster restore that the product does not provide.

See [security and privacy](../SECURITY.md) and [lifecycle precautions](lifecycle.md). Cloudflare's current [OAuth client requirements](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) are authoritative for verification and promotion.
