# Quota budget validation v1

The [quota contract](quota-pause-v1.md) uses separate Desktop and Web safeguards:
45,000 workload credits, 3,000 envelopes and 10,000 API dispatch attempts per
client/day. These are conservative local reservations, not billed D1 rows or an
account-wide cap. All results below use synthetic data and actual local
D1 result metadata. Static asset loads and other traffic are excluded from API
counts; these are not exact live billed Worker invocations.

The representative synthetic profile has roughly 900 tasks, 100 projects, 30 labels,
a few hundred label links, 550 source-linked tasks and 600 catalog items across
several Spaces. Its initial seed includes parent relationships. These rounded
workload and scenario labels approximate the original measurement buckets; the
measured costs and projection results below are unchanged. This is not a rerun
with a new population. No provider account was contacted or live quota induced.
The runtime was Node 22.23.2, Miniflare 5.20261006.1-alpha and Wrangler 4.149.0.

Schema 26 introduces incremental fan-out, current catch-up telemetry and Web
allowance costs. Its projection method combines the original route measurements
below with fresh authenticated measurements of those added paths. This does not
claim a rerun of the original population. Existing artifact digests describe
their original source, not a schema 26 package.

## Measured route costs

| Synthetic scenario | API dispatches | Reads | Writes |
| --- | ---: | ---: | ---: |
| Representative initial seed, including parent relationships | 1,987 | 77,678 | 45,976 |
| One representative-profile source heartbeat cycle | 590 | 22,096 | 7,777 |
| Large note-patch stress backlog (about 9,000 envelopes) | 9,365 | 336,728 | 191,356 |
| Empty completed-profile Desktop cycle, warm token | 13 | 738 | 7 |
| Representative-profile timestamp-only catalog publications, before pull/ACK | 569 | 18,613 | 14,194 |
| One owner-session source-linked/two-label note patch | 1 | 28 | 23 |
| One owner-session native note patch | 1 | 23 | 21 |

The empty Desktop cycle includes two sync passes and bridge polling. Its explicit
24-hour projection is 288 cycles plus 144 token mints: 3,888 API dispatches,
213,120 reads and 2,880 writes. Changed catalog publication costs 25 writes for
the adopted example and 23 for the unadopted example, before pull/ACK. Repeated
unchanged catalog publications are suppressed by Desktop; six-hour task-source
heartbeats remain. Catalog timestamps describe published observations, not latest
provider contact.

## Derived normal-day totals

These cases have no initial seed/backlog, four complete source cycles, 24 visible
browser hours and 100 note edits. Edits occur over six working hours followed by
18 idle hours; evenly spaced 24-hour edits and six-hour browser use are also
evaluated. Desktop edits include 100 manual Web refreshes. Web edits use measured
owner-session cost plus immediate refresh/rotation, outside Desktop's ledger;
there is no duplicate Desktop note arrival. Completed status polls every five
minutes. Changed catalog snapshots use the already-counted source cycles.

| Note origin | Changed catalog items/day | API dispatches | Reads | Writes |
| --- | ---: | ---: | ---: | ---: |
| Desktop | 0 | 7,420 | 1,863,643 | 36,770 |
| Desktop | 100 | 7,523 | 1,868,012 | 39,270 |
| Web | 0 | 7,514 | 1,862,659 | 37,265 |
| Web | 100 | 7,617 | 1,867,028 | 39,765 |

## Queue projections and limitations

These original projections predate schema 26 control traffic. Their recorded
values remain useful baseline evidence; they are not the current combined
fan-out/telemetry ceiling.

A large synthetic legacy backlog (about 9,000 envelopes) models a mix of source
refreshes and provider confirmations in two FIFO orderings. Confirmation cost
uses the entire measured delivery workflow as a conservative bound. The original
mix clears by model day 4; the continuing queue takes longer to catch up:

| Daily notes | Catalog changes/day | Continuing queue caught up by model day |
| --- | ---: | ---: |
| 100 Desktop notes | 0 | 21 |
| 100 Desktop notes | 100 | 69 |
| 100 Web notes | 0 | 15 |
| 100 Web notes | 100 | 32 |

Fresh-seed projections also include conservative provider-confirmation work after
the measured source completion commands. Fresh seed, mixed seed/backlog, both
count-mix orders and note-only stress produce 28 combined cases. Every model day
stays below half the documented Free daily allowances: the maxima are 11,595 API
dispatches, 1,906,341 reads and 45,893 writes. A conservative ceiling across the
measured operation families is 48,456 writes with the additional Web notes.

These are projections assuming one accepted attempt per envelope. Pass overhead
is allocated from measured scenarios and totals round upward. Active/unknown
upload status conservatively polls every 30 seconds while original work remains.
Day buckets do not resolve exact dispatch times. Retries, old payload versions,
conflicts and provider failures can lengthen or block real catch-up. Existing
envelopes and IDs must remain untouched until valid receipts acknowledge them.
Other devices/apps, static loads and deliberate extra reloads are outside this
representative workload; local metadata is not a live billing guarantee.

The versioned [measurement](../scripts/measure-budget.mjs) and
[projection](../scripts/report-budget.mjs) scripts describe the method. Local
browser checks cover pause feedback, cached read-only data, pending-write retention
and no further API dispatch after reload. Next-reset recovery has deterministic
clock coverage, not a live midnight observation. These results do not establish
production deployment or provider acceptance.

## Fan-out and catch-up method

The [fan-out measurement](../scripts/measure-fanout-budget.mjs) uses synthetic
local D1 through real authenticated Desktop and owner-session Worker routes.
It separately records mutation, exact duplicate replay, pull/ACK, catch-up start,
finish, idle heartbeat and owner status-read metadata. Credential, migration and
population preparation are excluded. A failed transaction does not expose full
batch metadata; its observed preflight counters are not a zero-cost claim.

Reservations use `100 + 12 × bound` credits, with an atomic server upper-bound
check and the existing 1.9 MB compound-response limit. They include retries
without refunds. Label-heavy records, unrelated rows and child projects are
separate adversarial measurements; their full-workspace browser workload is not
implied by the representative browser population.

Combined models append Desktop bulk work behind the original FIFO, include
normal Web notes and immediate refreshes, and defer large Web work through the
UTC day when the whole Desktop queue finishes catching up. Small Web bulk work
shares a cumulative 1,000-credit allowance while catching up or unknown. The
12,000-credit allowance opens on a later UTC day with fresh completion reports.
Repeated small changes, multiple bulk operations and retries share those caps.
The model charges both catch-up reports per empty pass, plus reports on nonempty
passes and Web admission reads. A manual override or unrelated devices/apps are
outside this automatic representative workload.

## Schema 26 results

Guarded Desktop project deletion wrote 21, 27, 81, 621 and 5,421 rows for 0, 1,
10, 100 and 900 affected tasks. Subtree movement wrote 26, 98, 818 and 7,218 rows
for 1, 10, 100 and 900 tasks, including the root. A missing root is rejected.
Each mutation uses one API dispatch. The 900-task owner-session variants wrote
5,423 and 7,220 rows, including the shared Web allowance update. The same move
with 32 labels per task and 2,000 unrelated tasks read 98,912 rows and wrote 7,218;
the larger read cost is why no workspace-independent read bound is claimed.

The `100 + 12 × bound` reservation covers measured fixed overhead and the largest
observed per-entity write cost, eight per moved task. Child-project deletion costs
six writes per child. Minimal-record moves of 3,500 tasks and project deletion
with 6,100 child projects fit the existing response-size limit; larger payloads
can hit it sooner. These are measured profiles, not new count limits. An operation
above a whole-day reservation needs explicit maintainer handling in Desktop.

The [isolated confirmation measurement](../scripts/measure-confirm-budget.mjs)
separates a prepared pending confirmation from a fresh delivery workflow:

| Measured scope | API dispatches | Reads | Writes |
| --- | ---: | ---: | ---: |
| Pending confirmation request only | 1 | 31 | 17 |
| Confirmation plus a whole health/reporting/pull/ACK pass and token renewal | 9 | 237 | 29 |
| Fresh command, claim/start, confirmation, pass and token renewal | 12 | 290 | 55 |
| Warm current-catch-up report | 1 | 5 | 1 |
| First current-catch-up report | 1 | 4 | 2 |
| Owner catch-up/allowance read | 1 | 4 | 0 |
| Explicit check, cancellation and repeated check/cancel | 4 | 7 | 12 |

The full delivery workflow has **two** 50-credit envelopes. A prepared pending
confirmation has one. The 29-write bound deliberately charges an entire pass and
renewal per confirmation; it does not also charge a new command and claim/start
that are already represented by other work. Preparation and provider calls are
excluded. Duplicate confirmation replay used one request, three reads and no writes.

The updated projections retain the original queue populations and synthetic FIFO
orders. They include 576 current-status POSTs/day for two reports per five-minute
idle pass, two reports per 100-envelope nonempty pass, a cold first report, token
renewals, browser refreshes/notes, changed catalog content, Web fan-out admission
reads and one complete check/cancel/retry sequence per model day. All 130 combined
cases stayed below half the documented Free daily allowances: maxima were 12,208
API dispatches, 1,943,352 reads and 48,142 writes. This also reserves one extra
indexed read per original measured mutation for the new cancellation/receipt
exclusion guard; fresh sidecar measurements already include that probe. Heavy mixed FIFO stress cases can
take up to 162 model days to empty; this is not a live elapsed-time promise.

The conservative measured-family write ceiling while catching up is 47,021 rows
for a full Desktop reservation, normal browser/notes, the cumulative small Web
allowance, telemetry and recovery. After catch-up, the measured normal provider,
catalog and note mix plus the full 12,000-credit Web fan-out allowance has a 48,398
row ceiling. Both retain margin below 50,000 writes. These derived ceilings apply
to the stated population, operation families and concurrent-use assumptions.

The separate Desktop maintainer **allow once** action can reserve another full
allowance and is outside the automatic half-quota guarantee. Older running
binaries and already-spent usage are not retroactively bounded. Failed/rolled-back
requests do not expose complete metadata, so exceptional failure billing is not
certified by these successful measurements. Source and synthetic browser checks
do not establish package, real-provider or production acceptance.
