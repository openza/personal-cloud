# Optional ordered mutation batches

Schema 22 introduced `capabilities.mutationBatch`; the combined workspace candidate reports schema 25 with the same optional capability:

```json
{"protocolVersion":1,"path":"/v1/tasks/mutations/batch","maxMutations":2,"maxRequestUtf8Bytes":16384}
```

Clients negotiate this capability; missing capability uses the existing single `POST /v1/tasks/mutations`. Old clients can continue using the single endpoint. Desktop health verification accepts schemas 17–25 before using this cloud candidate. Workspace records have separate negotiation requirements in the [workspace contract](workspace-contract-v1.md). No deployment or artifact pin is changed by this source change.

`POST /v1/tasks/mutations/batch` accepts only a device Bearer token and no query parameters:

```json
{
  "protocolVersion":1,
  "mutations":[{
    "protocolVersion":1,"product":"tasks","instanceId":"instance.example",
    "deviceId":"device.example","mutationId":"mutation.example","deviceSequence":1,
    "operation":"task.create","entityId":"task.example","baseEntityVersion":null,
    "payload":{"task":{"id":"task.example","spaceId":"space_default","title":"Example task",
      "completionState":"open","workflowStatus":"inbox","createdAt":"2026-01-01T00:00:00.000Z"}},
    "clientCreatedAt":"2026-01-01T00:00:00.000Z"
  }]
}
```

Send1–2 full envelope objects and at most16384UTF8 bytes for the complete wrapper. Use one device, distinct mutation IDs, consecutive ascending device sequences, and the per-envelope operation/payload contracts. Persist exact envelopes before sending. Serialize requests for the same device. Source refresh, external command results, source-bearing rich creates, provider scope/catalog publication and intent start/results require `provider_bridge`; other mutations require `desktop_sync`. A mixed-operation request needs every required capability. Owner cookies cannot send batches.

The server validates the entire wrapper, every envelope, device identity, and all scopes before executing anything. Such validation/auth failures return normal HTTP400/401 without writes. It then awaits each existing atomic mutation handler in order. The wrapper is not one transaction. Processing stops at the first application error; nothing after that item executes.

Authorized valid batches return HTTP200 with:

```json
{
  "protocolVersion":1,
  "product":"tasks",
  "instanceId":"instance.example",
  "receipts":[],
  "processedCount":0,
  "stoppedAt":0,
  "error":{"code":"sequence_gap","message":"The device sequence is not the next expected value.","retryable":true,"requestId":"request_example"}
}
```

Receipts retain the single endpoint's `accepted`/`duplicate` format and cover only a contiguous durable prefix. `processedCount` equals receipt count. Success has count equal to submitted item count and `stoppedAt:null,error:null`; failure has zero-based `stoppedAt==processedCount` and the existing public-safe error object. Raw server exceptions are never returned.

Validate the entire response and all receipt IDs/order/version/product/instance/counts before ACKing any prefix item. Retain the failed item and suffix. Reconcile sequence/version errors using the existing client rules. After a lost or invalid response, ACK nothing and replay the original persisted envelopes; durable duplicates preserve exactly-once behavior. A failed item may have committed during an infrastructure or response-loss failure, so absence of a receipt is not proof of rollback. Keep its identity and resolve it by exact replay.

An advertised route returning404/405/501 may fall back to exact single envelopes. HTTP400 is ambiguous invalid input and must not be treated as unsupported batching. A semantic per-item404 is inside HTTP200 and is not a route fallback. Preserve pending intents on401 and refresh credentials. Do not replace IDs or allocate new sequences for retries.

Chunk size2 is deliberately conservative. Count each SQL statement in `D1.batch()`, plus reads and authentication, toward the [D1 Free50-query invocation limit](https://developers.cloudflare.com/d1/platform/limits/). [Workers Free10ms CPU](https://developers.cloudflare.com/workers/platform/limits/) still requires separate deployed-tier acceptance; local tests do not prove live CPU usage. Batching reduces HTTP/authentication round trips, while each mutation retains its original durability and statements.

Synthetic local checks through the actual authenticated endpoint counted23SQL queries for two live source refreshes (including both six-statement write batches),27 for label/project changes,25 for source completion/reopen, and29 for two purged source refreshes. Injected second-write failure/recovery counted27, exact retry14, and concurrent exact wrappers23 each. These are invocation-query counts, including attempted failed statements as a conservative bound; trigger row work is separate. Every measured case stayed below50. Correctness tests separately cover the partial prefix and exact replay; local counters do not certify production CPU limits.
