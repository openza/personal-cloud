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
