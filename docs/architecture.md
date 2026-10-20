# Personal Cloud architecture

Web is an online-first companion to the local-first Tasks Desktop app. This
repository contains its browser UI, Worker task/sync runtime and artifact tooling.
It uses native JavaScript modules; no framework migration is required to extend
the existing design. Shared semantics live in the [workspace contract](workspace-contract-v1.md).

## Browser ownership

| Responsibility | Current owner |
| --- | --- |
| Routes, shared task snapshot/freshness, selected Space/view/project, editor state and rendering composition | `public/app.js` |
| HTTP serialization, owner-session generation/lock and single explicit CSRF retry | `public/owner-api.js` |
| Origin-scoped quota pause, atomic daily reservations and serialized resume probe | `public/cloud-brake.js` |
| Bounded quota/edge signal parsing and shared conservative operation costs | `public/quota-errors.js`, `public/dispatch-cost.js`; canonical cost fixture in `test/fixtures/dispatch-budget-v1.json` |
| Durable mutation envelope, replica sequence/lock, exact replay and receipt confirmation | `public/mutation-queue.js` |
| Complete, revision-consistent paged task read | `public/task-pages.js`; the app publishes/caches the completed snapshot |
| Pure filtering, search, ordering, grouping and date membership | `public/workspace-query.js` |
| Pure display/validation/copy formatting and provider-delivery captions | `public/task-presentation.js`, `public/provider-status.js` |
| Pure responsive layout decisions | `public/workbench-layout.js` |
| Shared Space/project forms and row-command DOM | `public/workspace-controls.js`, `public/task-row-actions.js` |
| Pairing/device request continuations, with injected rendering | `public/owner-settings.js` |
| Autosave scheduling and optional initial-upload monitoring, with injected operations | `public/detail-autosave.js`, `public/initial-sync-status.js` |
| Local appearance preference and system-theme adapter | `public/appearance.js` |

`app.js` still owns most rendering and interaction orchestration. Its shared state
includes the current snapshot, freshness, navigation/filter preferences, selected
editor, original version/draft, pending accepted save and session/editor
generations. Feature controllers access that state through callbacks rather than
creating a second authoritative copy. Query helpers can import pure formatting
helpers; they do not access DOM, HTTP or storage.

The app stores the last confirmed task copy and view preferences in browser
storage. The mutation sender stores its replica sequence and pending envelope
through injected durable storage. CSRF stays in memory; the owner session cookie
is HttpOnly. Signout does not erase cached task data. See [security](../SECURITY.md)
and [session/upgrade invariants](cloud-upgrade-v1.md).

Quota state participates in the common HTTP boundary, including health, auth and
optional status calls. It preserves the mutation sender's pending envelope and
sequence. Desktop and Web ledgers are independent safeguards, not an account-wide
allowance. Worker D1 classification lives in `src/daily-quota.ts`; callers classify
before diagnostic SQL or generic auth/conflict translation. See the
[quota contract](quota-pause-v1.md) for polling, clocks, cost policy and evidence limits.

## Where new work belongs

- A new screen or substantial interaction gets a named feature controller in
  `public/`, with its DOM/listeners and injected state/command callbacks. Compose
  it from `app.js` and the existing HTML shell. Extend a current controller for
  its existing responsibility; do not split files merely by line count.
- Put reusable query/date/display behavior in the pure helpers. Keep DOM work
  in feature controls or the app renderer. A feature must not create its own
  `fetch`, CSRF refresh, mutation queue or parallel snapshot cache.
- Route domain writes through the semantic mutation sender. Publish a read only
  after every page is validated; cached/unconfirmed data remains read-only.
  Preserve original-version checks, accepted-save recovery and exact replay.
- Capture session/editor ownership before asynchronous work. Retire timers and
  busy dialogs explicitly; old completions cannot render into, close or unlock
  a newer interaction. A pending Create blocks native cancellation while idle
  Escape/Cancel and programmatic signout remain available.
- Agree a shared versioned contract before new wire semantics. Keep provider
  account setup, credentials, intake/routing and provider API calls on Desktop.
  Web can display safe source facts and explicit delivery-lock recovery.

## Worker and infrastructure boundary

`src/index.ts` dispatches HTTP, authorization/capability checks, binding access and
static assets. Identity belongs to `auth.ts`, `device-auth.ts` and `recovery.ts`.
`schema-readiness.ts` provides the bounded read-only health footprint check.
Protocol validation, task/workspace mutations, receipts and source/delivery
invariants belong to the corresponding `src/` modules. Task reads, bootstrap,
change pull, paging and checkpoint acknowledgement have their own modules.
Their D1 access is the runtime persistence adapter.

Cloudflare account OAuth, account/resource selection, provisioning, deployment,
backup/update/disconnect/removal are companion Desktop infrastructure concerns.
They do not belong in browser query/rendering or Worker task semantics. This
repository's `scripts/` handles artifact construction, synthetic fixtures and
offline recovery preparation; `migrations/` and Wrangler configuration describe
the runtime bundle. Building with `wrangler deploy --dry-run` packages code and
does not provision an owner's cloud.

Use Node checks for pure helpers and browser controllers, actual-function
regressions for session/draft boundaries, and Worker/D1 tests for persistence and
authorization. Verify changed visible flows in a synthetic browser. Keep runtime,
artifact-loader, browser, live-provider and deployment acceptance separate in the
[compatibility matrix](compatibility-matrix.md) and [lifecycle guide](lifecycle.md).
