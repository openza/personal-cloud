# Current catch-up status v1

Schema 26 adds current Desktop catch-up reports and a shared Web bulk-change
allowance. This is separate from terminal initial-upload progress. Protocol 1,
manifest format 1 and existing release pins remain unchanged. Desktop must
explicitly support schema 26 before upgrading a cloud to it.

Health advertises `capabilities.catchupStatus` with `protocolVersion: 1`,
`path: "/sync/catchup-status"` and `staleAfterSeconds: 900`.

A device with `desktop_sync` authority posts exactly:

```json
{"protocolVersion":1,"reportSequence":1,"state":"catching_up","pending":100}
```

`reportSequence` is a positive safe integer and `pending` is a nonnegative safe
integer. States are `catching_up` and `idle`. The response contains
`protocolVersion`, `accepted`, the authoritative `reportSequence` and `updatedAt`.
Only the authenticated device's row can change. Older/repeated sequences do not
refresh timestamps. A reporter recovering a lost sequence journal persists a
larger sequence and resamples current work on a later normal pass; it must never
blindly replay an old idle report.

Desktop starts catch-up for an incomplete initial upload, a legacy backlog from
an earlier UTC day, an upload-budget/oversized hold, or pending reservations above
the whole daily allowance. Routine same-day provider bursts do not alone trigger
it. Once triggered, catch-up ends only when the whole queue is empty and seed or
recovery work has finished. The catching-up report must be acknowledged before
uploading that backlog. Failed reporting holds uploads while downloads and local
work continue. Reports reuse existing passes, without a faster polling loop.

Owner-authenticated `GET /sync/catchup-status` returns current device states and
server timestamps. Any active Desktop with no report or a report at least 900
seconds old makes completion unknown. First idle records server completion time;
repeated idle heartbeats preserve it. A new catch-up phase clears it, and the next
idle records a new completion time. Initial-upload completion is never used as
proof that a current backlog has drained.

The normal Web bulk allowance opens on the UTC day after every active Desktop's
verified completion, while reports remain fresh. One shared server counter allows
12,000 fan-out credits/day then, or a cumulative 1,000 credits/day while catching
up, unknown or waiting for the next day. Small project deletions and moves can use
the smaller allowance. Repeated small changes share that same counter. Eligibility
and allowance are rechecked atomically with the mutation; accepted receipt replay
is checked first. Ordinary Web edits use their existing independent budget.

New bulk changes that cannot be admitted are saved as visible drafts on the same
browser, before a canonical mutation ID or device sequence is allocated. Downloads
and ordinary edits continue. A draft retains its original target, payload and
base version; review/retry never silently retargets or rebases it. Cancel removes
only an unallocated draft. Changes above the Web allowance direct the user to
Desktop rather than promising automatic delivery on a later day.

An already canonical pending Web change keeps its exact identity and FIFO order;
later writes wait behind it while downloads continue. Its explicit
[unfinished-change recovery](web-pending-recovery-v1.md) confirms an already-applied
receipt, or permits owner cancellation of an unapplied change while retaining a
local copy. Uncertain work stays pending. Neither checking nor cancellation undoes
an earlier accepted request.

These safeguards protect the measured workload. They are not account-global
enforcement across arbitrary Desktop devices, other applications or manual
overrides. See [quota reservations](quota-pause-v1.md) and
[measurement assumptions](quota-budget-validation-v1.md).
