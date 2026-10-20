# Unfinished Web change recovery v1

Schema 26 health advertises `capabilities.webPendingRecovery` as
`{"protocolVersion":1,"path":"/auth/web-pending-change"}`. Recovery is an explicit
owner action for one saved `project.delete` or `task.moveTree` Web mutation. It is
not a quota override or a general outbox-compaction API.

The POST requires a live owner session, exact origin and CSRF token. Its body has
`protocolVersion: 1`, `action: "check" | "cancel"` and `mutation`, the full original
envelope. A cancel also requires the `canonicalHash` returned by check. Scope is
the current instance and an unregistered `web_` replica; registered Desktop
identities are refused.

Every response includes `protocolVersion`, `state`, `canonicalHash`, `mutationId`,
`deviceId` and `deviceSequence`. States are:

| State | Meaning and client action |
| --- | --- |
| `applied` | A validated existing receipt is returned. Confirm it locally; do not undo or cancel the change. |
| `unapplied` | `canCancel: true` only when this is the replica's next sequence. Ask for explicit cancellation; check alone saves nothing. |
| `cancelled` | `cancelledAt` identifies the durable cancellation. Keep the original as a visible local copy, then advance local progress and release the pending slot. |
| `unknown` | `canCancel: false`. Keep the exact pending envelope; never guess or release it. |

Exact accepted receipts take precedence. Cancellation inserts the original
per-device sequence claim, an immutable `web_pending_resolutions` record containing
the full canonical request/hash, and the advanced device sequence in one D1 batch.
The next-sequence condition is checked inside that transaction before and after
advancement. No task change, change-feed event or fake accepted receipt is created.

An in-flight original transaction competes for the same sequence claim. If the
original wins, recovery returns its applied receipt; if cancellation wins, the
late original rolls back. Mutual insert guards on receipts and cancellations
protect global mutation IDs even across different devices or operations, including
older handlers already in flight. A conflicting hash is never treated as the same
change. Quota failures are classified before diagnostic reads, and SQL is not
returned to the browser.

The browser holds the same replica Web Lock, checks session generation and exact
saved bytes, and validates the returned identity/hash. For cancellation it saves
the full original as a visible cancelled copy **before** advancing local progress
and removing the pending slot. Storage failure keeps the pending copy; a later
check reconciles idempotently. An unchanged pending envelope can remain alongside
an already advanced local counter after a failed remove, without moving backward.
Another saved draft is never overwritten silently.

The UI uses **Check unfinished change**, then explicit **Cancel change and keep
a copy**. New changes deferred before sequence allocation have separate saved-change
controls. Neither path automatically rebases an old target/version or cancels
uncertain work. Normal request, storage and actual cloud-quota brakes still apply.
