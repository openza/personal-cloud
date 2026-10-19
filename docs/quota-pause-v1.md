# Quota pause v1

See [anonymous budget validation](quota-budget-validation-v1.md) for measured route
costs and the derived workload assumptions.

This additive error/client-state contract preserves protocol 1, schema 25,
manifest 1, healthy capabilities and release pins. Upgrading an older installed
profile requires a compatible newer Desktop plus the candidate artifact. No live
quota was triggered to validate this contract.

## D1 and Workers errors

Recognized daily D1 reads/writes return HTTP 503, `Cache-Control: no-store` and
`Retry-After` seconds until the next 00:00 UTC. The existing error envelope adds:

```json
{"protocolVersion":1,"product":"tasks","error":{"code":"daily_quota_exceeded","message":"Personal Cloud reached a daily Cloudflare limit. Sync can resume after the next UTC reset.","retryable":true,"requestId":"request_<opaque>","quota":{"protocolVersion":1,"resource":"d1_rows_read","resetAt":"2026-10-20T00:00:00.000Z"}}}
```

Worker resources are `d1_rows_read|d1_rows_written`. Match only the exact documented
daily D1 phrases, allowing ASCII/curly apostrophes and a bounded exception cause
chain. Classify before auth, readiness or conflict translation and diagnostic
queries. Never expose SQL/source exceptions. Storage, overload, CPU, network,
ordinary 429 and other errors are not daily exhaustion.

Sequential batch HTTP 200 preserves receipts, processedCount and stoppedAt; its
error can contain the same quota object. The HTTP reader may persist a pause but
must return the successful batch payload. Consumers validate and acknowledge the
confirmed prefix before handling the error and retain the original suffix. A
quota in prebatch authorization is ordinary 503 without confirmed receipts.

Workers 1027 may be generated before the Worker executes. Clients recognize only
an unsuccessful HTTP 400–599 response with Cloudflare context (`Server` exactly
`cloudflare`, trimmed/case-insensitive, or nonempty `cf-ray`), media type text/html
or text/plain, and body at most 64 KiB. Plain text must trim-match
`/^error code:\s*1027$/i`. HTML needs a dedicated `span` with class token
`cf-error-code` and text 1027, plus Cloudflare/Error page title context. Other
attributes/classes and single/double quotes are permitted. Arbitrary mentions,
successful data, missing context and other edge codes do not qualify. The local
resource is `workers_requests`; clients do not invent Worker JSON. Edge formats
are not guaranteed, so unmatched pages remain transient failures with backoff.

The shared [synthetic fixture](../test/fixtures/quota-pause-v1.json) is mirrored
by Tasks. It is representative format evidence, not a captured live quota page.
[D1 errors](https://developers.cloudflare.com/d1/observability/debug-d1/),
[D1 enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)
and [Workers errors](https://developers.cloudflare.com/workers/observability/errors/)
describe the platform signals.

## Durable local brake and daily accounting

Persist an origin-scoped versioned pause, associated with a known instance.
Pairing, login, reload and restart do not erase it. All Worker-origin API sends
and retries, including optional status, auth, health, bridge and checkpoints,
check the gate before dispatch. Authorized control-plane OAuth/repair is separate.
Local edits/provider work, outbox, credentials, capabilities, seed and checkpoints
are preserved; uncertain mutations retain their IDs and canonical envelopes.
Persistence failure retains an in-memory brake and visibly reports that restart
protection could not be saved.

Validate canonical resetAt against next midnight UTC using trustworthy response
Date when available. A valid quota code/resource with a malformed, stale or absurd
hint falls back to that observation's next UTC midnight. Translate the remaining
duration to a local deadline; retain the external cloud reset separately for
display. Store observedAt/resetAt and test clocks one day ahead/behind.
Locally blocked calls never extend the pause. At reset, one serialized bounded
resume attempt uses small jitter; failures retain exponential capped backoff.
Automatic sync stays disabled when the user disabled it. Web remains cached and
read-only, with the exact reset time shown. Startup assets may themselves be
edge-blocked; this is not an offline/PWA guarantee.

Full task snapshots stop while hidden and run every five minutes while visible.
Focus, manual refresh and confirmed writes read immediately and restart that
timer. Every snapshot includes provider delivery fields even when the change
sequence is unchanged; there is no revision-only cache. Idle remote changes can
therefore take up to five minutes to appear. Freshness
expires 15 seconds after the selected next-read deadline; failed confirmations
immediately use the last confirmed data read only.

Completed-upload status checks also use five minutes; active or unconfirmed upload
progress stays at 30 seconds. Desktop publishes catalog content only when its
semantic observation changes. Catalog `source.refreshedAt` records that last
published observation, not the latest provider contact. Worker eligibility uses
availability/ownership, not a catalog age cutoff. Existing queued catalog records
remain charged and ordered. Separate task-source snapshots retain six-hour
heartbeats; this suppression creates no new schema or protocol field.

Daily UTC accounting reserves dispatches durably and atomically **before** sends.
Count envelopes and HTTP attempts separately, including retries, unknown outcomes
and crash reservations. A local budget pause is distinct from platform quota.
Pause cloud loops, show counts/reset truthfully, and retain ordered prefixes and
IDs until valid receipts acknowledge them. Existing pending backlogs participate
in the budget; they are not replaced by fresh seed envelopes.

The shared [cost table](../test/fixtures/dispatch-budget-v1.json) reserves 45,000
write credits, 3,000 envelopes and 10,000 Worker-origin API attempts per UTC day. Credits are
conservative workload units, not billed D1 rows or an account-global guarantee.
Each patch costs 25, source refresh 16, known single-entity operation 50; rich
creation adds 10 per label and creation with a source adds 16. Project deletion
and subtree movement reserve the whole 45,000 because their fanout is not bounded
by the envelope. A transmitted batch sums every original ordered envelope.
Unknown or over-whole-day operations remain pending with a visible permanent
local stop, without automatic next-day retries. Retries and unknown results spend
the complete reservation; only new UTC days replenish it, never clock rollback.

Numeric defaults are validated from synthetic real-query metadata before release,
not inferred from task counts. Measure first upload per-day/total, existing
backlog catch-up, normal edits, six-hour provider cycles and browser idle against
less than half the documented Free daily request/read/write allowances. State
edits/day and open-hours assumptions explicitly. Other account apps/devices
consume shared allowances; local measurements do not prove live billing or global
capacity. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
and [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Web and Desktop have independent ledgers. In a combined workload, owner-session
Web writes are added outside Desktop's reservation ceiling. A shared account can
therefore consume more than either client's allowance. Scenario reports must
include idle Desktop cycles, token renewals, active/completed status polling,
immediate Web confirmations, changed catalog content and all original pending
operation counts. Unknown original FIFO order is modeled explicitly with
synthetic orders; it never authorizes reordering or replacing pending envelopes.
First-seed scenarios must also account for follow-up provider confirmations.

The local synthetic measurement scripts were verified with Node 22.23.2:

```sh
node scripts/measure-budget.mjs --counts=artifacts/counts.json --sources=100 --output=artifacts/measured.json
node scripts/measure-idle-budget.mjs artifacts/counts.json artifacts/idle.json 100
node scripts/report-budget.mjs artifacts/measured.json artifacts/days.json artifacts/idle.json artifacts/pending-operation-counts.json
```

Counts and operation-mix files stay ignored and contain no task content or IDs.
Use the same source count and population in both measurements; the example uses 100.
The full job measures actual authenticated Worker routes and D1 result metadata;
the idle job measures empty Desktop cycles, catalog publications and owner writes.
Day totals and queue latency are derived projections. They assume accepted
one-attempt envelopes; retries, conflicts and older payload versions can lengthen
or block real catch-up. Neither the scripts nor synthetic UI checks contact a
provider account, induce live exhaustion or establish production acceptance.
Request counters measure API dispatches. Static HTML/JS/CSS and other traffic are
excluded; they do not equal exact live billed Worker invocations.
