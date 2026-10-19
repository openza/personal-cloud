# Openza Personal Cloud

Openza Personal Cloud is the optional Web companion and sync service for Openza Tasks. It runs as one Cloudflare Worker with Static Assets and one D1 database in each user's own Cloudflare account. Desktop remains local-first and works offline. Tasks is the only product currently supported. This is a technical preview, not a general-availability release.

Every synchronized row belongs to the same Openza `tasks` collection. A task may optionally retain a safe source descriptor after adoption, but Personal Cloud has no provider-task collection and Web has no provider connection or credential access. Provider credentials and provider API calls remain on capable desktop devices.

## Implemented

- Typed, idempotent task mutations with device ordering, entity versions, receipts, ordered change pages, checkpoints, bootstrap/re-bootstrap, tombstones, retention, and compaction gates.
- Openza task title, workflow status, priority, planning, completion/reopen, deletion, project, Space, label, and parent operations.
- Safe source-linked tasks, source refresh, pending desktop commands, provider confirmation/rejection, coalescing, stale refresh rejection, and multi-desktop resolution.
- A Web task experience that uses the same semantic operations and becomes read-only when only stale cached data is available.
- Typed daily-limit pauses, durable local dispatch reservations and bounded idle polling. See the [quota contract and measurement limits](docs/quota-pause-v1.md).
- Task views, add/edit, completion/reopen, deletion, search, sorting, grouping, Spaces, projects, labels and responsive navigation. Native subtask creation is not offered; adopted provider task hierarchies are preserved.
- Full-list Web loading in bounded pages, with restart on concurrent changes rather than publishing a truncated or mixed task list. Search and filters operate on the completed read.
- Owner WebAuthn passkey setup and sign-in, secure opaque sessions, rotation, expiry, CSRF/origin enforcement, sign-out, recovery-code rotation, and revocation of lost credentials.
- One-use desktop pairing grants, capability-scoped short access tokens, immediate device revocation, and re-pairing.
- A desktop identity client that stores only the refresh credential through Openza's existing OS credential abstraction; pairing grants and short access tokens are not persisted.
- Rate limits, strict JSON parsing, hashed server-side token/grant verifiers, and an offline review-only emergency rebootstrap SQL generator.

## Local verification

```sh
npm install
npm run typecheck
npm run test:rebootstrap
npm run test:web
npm run test:quota
npm test
npx wrangler d1 migrations apply DB --local
npx wrangler dev --local
```

The Vitest environment supplies an isolated test-only actor and bootstrap grant. Neither value is present in deployable Static Assets or `wrangler.jsonc`.

To exercise the browser flow manually, place a strong one-time `OWNER_BOOTSTRAP_GRANT` in an ignored `.dev.vars` file before starting the local Worker, then open `http://localhost:8787/`. Use the `localhost` hostname rather than its `127.0.0.1` address because WebAuthn requires a valid relying-party domain. The browser creates the first owner passkey and shows the initial recovery code once.

## Identity boundaries

- Browser sessions use a Secure, HttpOnly, SameSite=Strict host cookie. State-changing browser requests also require the in-memory CSRF token and the exact request origin.
- Desktop refresh credentials are returned once at pairing and stored by the desktop credential store. D1 stores only their hashes.
- Desktop access tokens expire after ten minutes and carry `desktop_sync` and, only when explicitly paired for it, `provider_bridge` authority.
- Device revocation invalidates both refresh and access credentials immediately.
- Recovery replaces the active owner passkey, rotates the recovery code, and revokes every Web session.
- The emergency rebootstrap script reads a new grant from standard input and only prints reviewed SQL. It never connects to D1 or executes the reset. The SQL revokes all app credentials without deleting tasks or synchronization history.

## Deployment boundary

The local checks above do not create or modify Cloudflare account resources. Desktop guided OAuth setup, provisioning, backup, update, disconnect and removal are implemented in the companion Tasks repository. Any live rehearsal or deployment requires separate authorization; source tests are not proof that a deployed cloud runs this version. Check `/health` for artifact/schema versions.

See the [architecture and extension rules](docs/architecture.md) for module/state ownership and the [compatibility matrix](docs/compatibility-matrix.md) for exact source support, artifact pins and tested local pairs.

The permanent Desktop provisioning flow consumes a versioned, checksum-manifested artifact. Build one locally without contacting a Cloudflare account:

```sh
npm run build:artifact -- 0.1.0-preview.7
```

The output under `dist/openza-personal-cloud-<version>/` contains the bundled Worker, Web assets, ordered migrations, and `artifact-manifest.json`. Desktop verifies every recorded size and SHA-256 hash before enabling deployment. Release packaging must place this directory at `PersonalCloudArtifact` in the app output and supply the approved public OAuth client ID and exact scope IDs; no client secret is accepted or embedded.

The `_headers` file is checksum-recorded artifact metadata, not a public downloadable asset. Desktop's direct uploader must pass its raw contents as `assets.config._headers` and omit it from the public upload manifest. This keeps browser security headers consistent with Wrangler deployments. Older Desktop uploaders need the matching update before deploying this artifact.

## Privacy and operations

Read [security and privacy](SECURITY.md), [setup/lifecycle/rollback precautions](docs/lifecycle.md), and [public release preparation](docs/public-release.md). Task data is access-controlled but not end-to-end encrypted. The browser retains a local cached task copy, including after sign-out. Provider tokens are never uploaded.

The original Linux handoff and subsequent Windows evidence are distinguished in [Windows continuation](docs/windows-continuation.md) and [local validation](docs/local-parity-validation.md). They do not establish WinUI feature parity, comprehensive native accessibility or fresh Snap acceptance. Live lifecycle rehearsals, public OAuth availability and release acceptance remain separate gates; building, committing or pushing source does not deploy it.
