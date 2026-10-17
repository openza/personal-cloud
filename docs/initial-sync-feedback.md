# Initial Desktop upload feedback

This optional protocol describes only the initial Desktop upload. It does not measure provider delivery, ongoing sync, or task-list freshness. Migration `0021_initial_sync_status.sql` adds one latest report per paired desktop; migration 22 adds source-history indexes and optional mutation-batch capability. The combined workspace candidate adds migrations 23–25 and reports schema 25; see [workspace contract](workspace-contract-v1.md) and [optional bounded paging](workspace-paging-v1.md). This source change does not update any Desktop artifact pin, publish a release, apply a remote migration, or deploy a cloud.

## Report

`POST /sync/initial-status` requires a device Bearer access token with `desktop_sync`. Owner browser cookies and provider-only devices cannot report. The authenticated device determines identity; no device ID, task titles, or raw errors are accepted in the payload. Query parameters are rejected, the body is limited to 2 KiB, and authenticated reports are limited to eight per minute per device.

```json
{"protocolVersion":1,"reportSequence":1,"state":"uploading","acknowledged":3,"total":12}
```

`reportSequence` is a durable positive safe integer increasing per paired device. `state` is `uploading`, `blocked`, or `complete`. Counts are nonnegative safe integers with `acknowledged <= total`, or both `null` when unavailable. The unit is **initial changes**, including seed and catch-up metadata changes, rather than tasks. Total may grow during preparation. An optional `errorCode` is accepted only for `blocked`, from `offline`, `unauthorized`, `cloud_unavailable`, `conflict`, `interrupted`, or `unknown`.

Desktop reports `complete` only when counts are known and equal, the entire initial seed and catch-up have been acknowledged, and no initial push batch remains queued or in flight. The server cannot inspect the local queue and relies on this Desktop invariant. Zero changes may complete with `0/0`. Completion is terminal for that paired device's initial upload; later ordinary sync does not reopen it. Re-pairing produces a separate device identity.

The server replies with `{protocolVersion:1, accepted:true|false, updatedAt:<server ISO timestamp>}`. One atomic conditional write ignores older or equal sequences and attempts to reopen a completed initial upload, returning `accepted:false` with HTTP 200. Reports should be serialized, sent on phase transitions, and heartbeated about every 30 seconds while uploading. Coalesce faster updates and retry HTTP 429 later. Counts and report sequence are independent of task mutation device sequence.

Reporting must remain best effort. Old clouds may reject this optional endpoint with 400 `invalid_request`, 404, 405, or 501. Progress errors, unsupported status, and timeouts must never fail or prevent task synchronization. Older desktops can keep using existing sync endpoints without reporting; the cloud represents them as unknown. Clients must not require schema 21 solely to synchronize against a compatible schema 20 cloud. Package/deployment compatibility must be validated separately before release.

## Owner read

`GET /sync/initial-status` requires an owner session cookie. It accepts no query parameters, needs no CSRF token for the read, and returns `Cache-Control: no-store`:

```json
{
  "protocolVersion":1,
  "serverReadAt":"2026-01-01T00:00:00.000Z",
  "staleAfterSeconds":120,
  "state":"uploading",
  "devices":[{
    "deviceId":"device.example",
    "displayName":"Example desktop",
    "state":"uploading",
    "acknowledged":3,
    "total":12,
    "updatedAt":"2026-01-01T00:00:00.000Z"
  }]
}
```

Only active sync-capable desktops are included. An unreported device has `state:unknown`, null counts and `updatedAt:null`. An uploading report at least 120 seconds old becomes `interrupted` using server time. Blocked remains blocked and complete remains complete. Aggregate precedence is `uploading > blocked > interrupted > unknown > complete`. No devices means unknown. A completed desktop cannot hide another active upload or falsely confirm a desktop that never reported.

No report history is retained. The latest row remains associated with its device, including after revocation, and cascades on device deletion. Revoked devices are excluded from owner status reads and cannot report.

Web polls separately from task paging every 30 seconds with a 10-second request deadline, refreshes on returning to a suspended tab, and drops late responses after sign-out. Its accessible banner explains that tasks may arrive before Spaces, projects, and labels. It shows per-device native progress bars from measured counts, or indeterminate progress while uploading when no positive total is available. Empty task views describe initial arrival or Desktop retry guidance until the upload phase changes. Refresh reads cloud status and tasks; it does not restart Desktop sync. Status failures do not disable task controls or replace the task freshness state. Count-only status updates do not rebuild task rows.
