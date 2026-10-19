# Personal Cloud / Desktop compatibility

Recorded 19 October 2026. These are exact source and local-validation snapshots,
not mappings to installed Desktop release numbers. A later documentation-only
commit does not change the runtime revision or rebuild the recorded artifact.

## Source support and pins

| Desktop source | Health support in source | Artifact pin / interpretation |
| --- | --- | --- |
| Local tag `v1.1.0`, `f45fbe1314f9e6c767cbc3aefe8b64711e4525e4` | No Personal Cloud implementation | Predates Personal Cloud; the version label is not evidence of cloud support or of an installed app. |
| First Personal Cloud integration, `3e2a3f923452d461f4228bb3ee65fc8ae1f79796` | Explicit schemas 17–20; health response model has no capabilities field | No per-pass capability negotiation. This source is not proof of forward compatibility with workspace clouds. |
| Main snapshot `5637e3adc7ea6a57b2a7fdfa44bf2b9de93c5201` | Explicit schemas 17–25, with capability validation | Predates the `e7378d7` health/preflight corrections; source support is not upgrade-safety acceptance. |
| Integration snapshot `83d60890dd24ead67d08d8d45cd246bc3d3e3610` | Explicit schemas 17–25, with capability validation | Same safety limitation as the earlier main snapshot; the allowlist alone does not establish every mixed-version workflow. |
| `e7378d7060ed8812eb3608890e25d53633a94f1e` | Explicit schemas 17–25; fail-closed health and migration preflight | Reviewed upgrade candidate. Its checked-in lock selects preview.9/schema 20 below; it does not automatically package the local schema 25 candidate. |

At the inspected Desktop candidate, `scripts/personal-cloud/artifact-lock.json`
pins cloud source `be1691402129d7a571f9bd881a91d93bafe28ef1`, artifact
`0.1.0-preview.9`, manifest SHA-256
`5eb0d68377c12f9f5a1f12f82f7f2330ff61d1c58689dae625f4c7fdbf02153d`.
That source advertises schema 20. A pin is a packaging input, not proof of an
installed package or deployed cloud's current state.

The historical 11 October handoff selected schema 17 source
`23f15e915bcd69d6901d4c4be58cc26c476427da`, artifact `0.1.0-preview.7`, digest
`d3df7cca1d6f747334eca0fb17a557251be1d6a2988c876958ac3296165c70b9`.
Its [release-preparation evidence](public-release.md) is retained as historical.

## Cloud schemas and capability boundaries

The main/integration/upgrade candidate allowlists above include every schema in
this table; the first integration accepts only 17–20. Schema acceptance is only
the first gate: capable clients must negotiate the advertised optional capability
and validate its fields before using the associated operation.

| Schema | Exact cloud source or versioned evidence | Added behavior / consumer boundary |
| --- | --- | --- |
| 17 | `23f15e915bcd69d6901d4c4be58cc26c476427da` | Task notes/deadline baseline; historical preview.7 pin. |
| 18 | `fa762a16df2b7028252e81ecb47120d0ab6d46de` | Parent-cycle invariant and recovery/replica hardening. |
| 19 | `1148a914dc2dce05388fbfcd0d29538785fc9c74` | Durable provider-delivery claim ownership. |
| 20 | `be1691402129d7a571f9bd881a91d93bafe28ef1`; source-alias invariant introduced at `8a9464ca1928ac2c9dd6fad123519247b979f83a` | One active delivery owner per provider source; inspected preview.9 pin. |
| 21 | `0021_initial_sync_status.sql`, [initial-status contract](initial-sync-feedback.md) | Optional initial-upload reporting; absence is unknown and cannot block task sync. |
| 22 | `0022_source_history_indexes.sql`, [batch contract](mutation-batches.md) | History indexes and optional ordered bounded mutation batches. |
| 23 | `0023_workspace_parity.sql`, [workspace contract](workspace-contract-v1.md) | Workspace metadata and provider catalog/intents/routes. Readers without workspace support stop at `workspace.changed` before advancing/acknowledging it. |
| 24 | `0024_source_identity_lookup.sql`, [paging contract](workspace-paging-v1.md) | Source identity index, signed bounded bootstrap paging and compound payload bound. Negotiate paging explicitly. |
| 25 | Main source `c77e2d966cd25077c1bb8bb6ab1995b6def7a07c`; reviewed runtime `853551f8d31f30535ba40fbc490240e8243b6620` | Authoritative task modification time. Reviewed runtime also adds fail-closed schema readiness and session/dialog guards without a schema bump. |

No independently pinned release for each intermediate schema 21–24 is asserted
here. Those rows identify ordered migration/contract evidence. Capability version
and response shape matter: workspace, catalog and paging are separately
negotiated; a schema number does not authorize lossy fallback or a guessed API.

## What was tested

| Exact scope | Local evidence | Limit |
| --- | --- | --- |
| Desktop `e7378d7` with cloud runtime `853551f`, schema 25 local artifact | Cross-repository artifact-loader/contract verification, Cloud Worker tests and synthetic Web acceptance | Local source/artifact pair; not a real-cloud pairing, final distributable or deployment rehearsal. |
| Desktop `e7378d7`, health schemas 17–25 | Health parser theory cases using synthetic responses | Parser acceptance, not binary-by-schema end-to-end validation. |
| Desktop `e7378d7`, schemas 17–23 | Fake-HTTP lifecycle cases | Mocked cloud responses; not historical Worker/database deployment tests. |
| Desktop `e7378d7`, schema 24 | Mocked bounded paging cases | Paging contract coverage, not a real schema 24 cloud pairing rehearsal. |
| Desktop `e7378d7`, schema 25 | Parser/store cases and the current schema 25 artifact-loader check | Record decoding, persistence and artifact validation; not installed-app or live-provider acceptance. |
| Cloud runtime `853551f` browser behavior | 170 Web tests; synthetic Chrome task creation/editing, labels, Settings, readiness loss/recovery and idle Escape | Busy/session races use deterministic actual-function tests; synthetic authentication is not real passkey acceptance. |
| Cloud readiness and domain runtime | 179 Worker tests; fixed readiness cost with empty and populated task/history data | Local D1 implementation, not a live account quota measurement. |
| Built schema 25 Worker over incomplete D1 | Actual artifact rejects empty and schema 17/20/22/24 fixtures with 503; populated schema 22 upgrades to 25 preserving receipts, version claims, timestamps and foreign keys | Negative upgrade-readiness cases, not successful Desktop compatibility tests against historical Workers. |
| Historical schemas 17–24 with each Desktop snapshot | Source allowlists, versioned contracts and specific regression evidence | No complete nine-schema, end-to-end mixed-version rehearsal is claimed. |

The local artifact is `0.0.0-local-upgrade-v1`, format 1/schema 25, built from the
reviewed runtime. Its verified manifest SHA-256 is
`c97990d0e5a1ac224e5748ca214f6be341905356db761ce72f4857a6d7cf3eb3`.
It is separate from the preview.9 pin. Do not reuse this digest for a rebuilt
artifact; verify the actual output, even when source changes are documentation
only. The checks above did not change any pin, merge, deploy or replace an app.

## Readiness, provenance and recovery are separate

The current schema 25 Worker needs its complete expected D1 footprint; historical
schema compatibility does not mean that Worker can run on an older database.
Health checks required tables/columns and named invariant objects without scanning
task/history rows. A successful footprint check does not prove historical
checksums, object definitions, every stored row or future-schema compatibility.

Desktop separately validates the ordered exact-prefix checksum migration journal
before update; Wrangler's names-only migration ledger is distinct. Failures retain
negotiated capabilities, intents and checkpoints. Only an explicitly unsupported
health endpoint can permit a safe legacy path. See the authoritative
[upgrade contract](cloud-upgrade-v1.md), [workspace contract](workspace-contract-v1.md)
and [lifecycle/recovery guide](lifecycle.md). Live state still requires current
health, exact artifact provenance, private backup and authorized acceptance.
