# Workspace paging v1 (schema 24)

Core protocol and workspace record shapes remain version 1. Health adds
`workspacePaging:{protocolVersion:1,bootstrapPath:"/sync/bootstrap",changesPath:"/sync/changes",maxResponseUtf8Bytes:2097152,maxPageRecords:100}`.
Negotiate this capability before sending `paged=1`. Schema24 includes the source
identity index and a singleton random HMAC key for stateless baseline cursors.
No new deployment secret or setup input is required.

## Baseline

Start with `GET /sync/bootstrap?workspace=1&paged=1`. Continue with the same
parameters and `cursor=<URL-encoded opaque nextCursor>`. Each response has exactly
`protocolVersion,product,checkpoint,snapshot,hasMore,nextCursor`. Snapshot has all
12 existing arrays, with records from one section per page; other arrays are
empty. Section order is spaces, projects, tasks, labels, taskLabels, tombstones,
sourceDescriptors, externalCommands, scopes, catalog, intents, routes.

Each page contains at most100 records and the complete UTF-8 JSON envelope is at
most2,097,152 bytes. Empty section pages are valid. Records are never split.
`hasMore` is true exactly when `nextCursor` is a nonempty string. Final page has
`hasMore:false,nextCursor:null`. All pages have the same checkpoint. Cursor
signature binds instance, authenticated device (or owner identity), section,
keyset position, checkpoint, and initial ten-minute expiry. Refreshing the same
device access token is permitted. Cursor tampering, cross-device reuse, or
expiry returns400 `invalid_request` and no snapshot. A changed cloud head
returns409 `bootstrap_changed` and no snapshot.

Desktop stages pages separately from its committed replica. Only a complete
consistent baseline is passed to the existing atomic bootstrap replacement;
failure/cancellation never replaces any partial arrays or advances a checkpoint.
On `bootstrap_changed`, discard staged pages and restart from the first request,
at most three baseline attempts per Sync call. If exhausted, preserve the prior
replica/outbox/metadata and report an actionable retry. Bound accumulated pages
(maximum100,000 records,128MiB JSON,10,000 pages per attempt); exceeding a bound
preserves the prior replica and returns a safe sync failure. Do not guess total
progress from page count. Normal change pull follows the completed baseline.

## Changes

Use `GET /sync/changes?after=N&limit=50&workspace=1&paged=1`.
Response has exactly `protocolVersion,product,changes,nextCheckpoint,hasMore`.
`changes` contains an ordered contiguous prefix, at most the requested limit,
and the complete UTF-8 envelope is at most2,097,152 bytes. Whole compound changes
are never split or skipped. `nextCheckpoint` is the last returned sequence, or
the requested checkpoint for an empty page. Continue while `hasMore` is true,
including when the returned count is below the limit. A single change that
cannot fit returns409 `response_too_large` and no checkpoint/changes. No ACK
follows a failed or incomplete pull. Existing per-Sync page limits remain a
bounded retry boundary; a partial successful prefix may be committed locally,
then the next Sync resumes from that committed prefix.

## Compatibility and limits

Unpaged endpoints and historical records remain supported. An unpaged response
that would exceed2MiB returns409 `upgrade_required`, requiring paging instead of
returning an oversized document. Old six-array workspace changes still decode
with scopes empty. New oversized compound mutations are atomically rejected
with409 `response_too_large` before any receipt/sequence/domain commit, so they
cannot insert an undownloadable feed item. Existing oversized historical items
fail explicitly and preserve the checkpoint. No migration rewrites receipts,
history, provider state, task content, or source ownership.

The stored compound payload has a separate conservative1,900,000-byte bound,
leaving100,000 bytes for bounded change-row columns below D1's
[2,000,000-byte string/BLOB/row limit](https://developers.cloudflare.com/d1/platform/limits/).
The HTTP envelope limit remains2,097,152 bytes. A SQLite size error occurring
while constructing a larger payload before its insertion trigger is also
normalized to nonretryable `response_too_large`, with the whole mutation rolled
back. Local Miniflare does not enforce every deployed D1 limit; a separate SQLite
probe sets the documented length and SQL argument limits explicitly.
