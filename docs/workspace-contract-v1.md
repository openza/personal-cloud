# Additive workspace contract v1 (schema 25)

Source-only Cloud/Desktop coordination contract. Schema 25 contains migrations
21 (initial status), 22 (history indexes / optional ordered batches), and
23 (workspace metadata / provider catalog and intents), and24 (indexed source
ownership, signed bootstrap cursors and compound response bound), and 25 (authoritative task modification timestamps). Protocol remains1.
No deployment, live provider, installed-app, or production access is authorized.

## Negotiation and compatibility

`GET /health` returns schemaVersion 25 and existing
`mutationBatch` capabilities plus
`workspace:{protocolVersion:1,path:"/v1/tasks/mutations",schemaVersion:25}` and
`providerCatalog:{protocolVersion:2,path:"/v1/provider/catalog",intentsPath:"/v1/provider/intents"}`.
Desktop accepts supported old schemas17–25. Negotiate the optional bounded
`workspacePaging` capability using [Workspace paging v1](workspace-paging-v1.md).
Missing workspace capability
uses old operations and does not send new envelopes. Schema 23 changes are
additive but old Desktop cannot consume `workspace.changed`: Desktop must
negotiate `workspace=1` on `/sync/changes` and `/sync/bootstrap` to receive new
workspace changes/snapshot metadata. Old readers receive `upgrade_required`
(409) at the first new workspace change, before advancing past it; they must
not ACK/skip it. No automatic downgrade or lossy fallback after new operations.
Existing single mutations remain compatible; optional ordered batch stays max 2,
16 KiB, full prevalidation, contiguous durable-prefix receipts, not one transaction.

## Mutation envelope and atomicity

Every operation below uses the existing exact 11-key envelope at
`POST /v1/tasks/mutations`: protocolVersion, product, instanceId, deviceId,
mutationId, deviceSequence, operation, entityId, baseEntityVersion, payload,
clientCreatedAt. UTC timestamps are canonical `yyyy-MM-ddTHH:mm:ss.fffZ`.
IDs retain existing bounded identifier syntax; allocate globally distinct IDs.
`baseEntityVersion:null` creates; update/delete supplies current positive version.
Exactly persisted canonical envelopes, immutable hash/receipt, device sequence,
entity-version claims, change and counter are committed with domain writes in
one D1 batch. Duplicate replay returns original receipt; changed reused ID fails.
No stale reference resurrection, no overwrite of provider-owned titles, no
credentials, tokens, raw private provider settings, or provider API calls in Cloud.

Operations with owner session + CSRF or `desktop_sync`:

- `space.put`: `{space:{name,color,icon,sortOrder,isArchived,createdAt}}`.
  `createdAt` is immutable after creation; updatedAt server timestamp. All names
  trimmed/nonempty, UTF8 <=512. Last active Space cannot be archived.
- `project.put`: `{project:{spaceId,name,description,color,icon,parentId,sortOrder,status,isFavorite,createdAt}}`.
  Status `active|completed|archived`; description nullable <=4096 UTF8; Space must
  be active. Project Space/createdAt immutable; provider project ownership excluded.
- `project.delete`: `{}`; versioned permanent tombstone. Atomically sets projectId
  null and workflowStatus `inbox` on its live tasks, increments each task version.
- `task.createRich`: `{task:{id,spaceId,title,workflowStatus,priority,createdAt,notes,
  plannedOn,plannedAt,deadlineOn,deadlineAt,scheduledStart,recurrenceRule,projectId,
  scheduledEnd,durationMinutes,labels:[{id,name}]}}`; completion open, parent null. All fields required; nullable
  optional values explicit null. Priority 1–4; workflow existing five values.
  plannedOn/At and deadlineOn/At mutually exclusive. scheduledStart nullable exact
  UTC timestamp; recurrenceRule nullable <=512 UTF8. Existing active Space and unarchived project
  required, labels <=32. Creates task+fields+labels atomically, never partial create.
  Optional `source` alongside task uses existing SafeSourceDescriptor and requires
  authenticated `provider_bridge` device (not owner cookie); ownership recorded.
- `task.patch`: `{fields:{...}}`, nonempty subset of title, notes, workflowStatus,
  priority, plannedOn, plannedAt, deadlineOn, deadlineAt, scheduledStart, scheduledEnd, durationMinutes,
  recurrenceRule, projectId. Same value validation. Date alternatives clear their
  counterpart; provider title is immutable. Project must be unarchived in task Space; completed projects remain assignable like Linux Desktop.
- `task.moveTree`: `{spaceId,fields:{...}}`; root detaches from outside parent;
  all live descendants move atomically, retain their internal parents, clear
  projects. Optional root fields same as patch (project assignment applies only
  to root and must match destination Space). Current descendant versions claimed
  inside the atomic transaction; no stale client enumeration / partial tree move.

New mutations append `operation:"workspace.changed",entityKind:"workspace"`,
entityId/envelope receipt version, payload
`{spaces:[],projects:[],tasks:[],scopes:[],catalog:[],intents:[],routes:[]}`; arrays contain
complete affected reference records and complete flattened task snapshots.
All seven arrays always present on new writes; immutable historical six-array changes decode scopes as empty. Task rich create includes complete task snapshot;
patch/tree/project-delete arrays carry complete snapshots of each affected task.
Concurrent uncommitted local changes are reconciled by entity version on Desktop. Consumers apply all arrays in one local transaction and
ACK only after durability. Reference records include id, entityVersion, updatedAt,
createdAt, deletedAt; Space includes name/color/icon/sortOrder/isArchived; Project
includes spaceId/name/description/color/icon/parentId/sortOrder/status/isFavorite.
Project parent must be live in the same Space; reject cycles. Deleting a project
detaches its immediate child projects atomically and increments their versions.
Task scheduledEnd nullable UTC and durationMinutes nullable integer 0–525600;
icon nullable UTF8<=128, color nullable UTF8<=64, sortOrder integer 0–2147483647.
Bootstrap workspace=1 adds metadata fields and scopes/catalog/intents/routes; task reads
expose exact deadlineAt, scheduledStart, local recurrenceRule and references.
Deleted reference rows are retained forever; old task assignment cannot rename,
unarchive or revive an existing reference. Archived Space/project task exclusion
matches Desktop; archived/completed Projects remain available in management UI.

## Provider catalog and intent bridge

`GET /v1/provider/catalog` owner-authenticated read, no query; returns protocol,
product, instance, current server read timestamp, scopes/catalog/intents/routes arrays.
`GET /v1/provider/intents` requires `provider_bridge` Bearer; no query; returns
only authenticated device's pending/started/uncertain intents (max 100 ordered),
no history scans. UI must show pending Desktop and uncertainty, never claim
local/provider completion from accepted cloud intent alone.

`provider.catalog.put` requires provider_bridge; entityId is opaque catalog ID,
base null/new or positive/update; payload
`{item:{scopeId:string,source:<existing SafeSourceDescriptor>,isSkipped:boolean,available:boolean,
 adoptedTaskId:string|null,labelNames:string[],projectChoices:[{id,name}]}}`.
Labels <=32, project choices <=32, IDs opaque locally mapped provider IDs/hashes.
Cloud pins publishing device+integrationKind+externalIdHash on first publish;
other devices / changed source identities rejected. catalog item source metadata
and choices only; credentials/private settings never uploaded. adoptedTaskId
must refer to live source-owned task of this exact bridge and hashed identity.
Unavailable entries retained; a newer observation can restore availability.
source.refreshedAt must not move backwards; equal observations with changed
scopeId/source/available/labelNames/projectChoices facts are rejected. Workflow flags
isSkipped/adoptedTaskId may change at the same observedAt under their entity
version fence; a live adopted task mapping cannot be cleared/rebound. Source identity is globally unique across bridge ownership.
No resurrection through an old catalog envelope.

`provider.intent.request` owner+CSRF or desktop_sync, base null, opaque intent ID:
`{intent:{bridgeDeviceId,action,catalogId,spaceId,route}}`.
Actions `adopt|skip|restore|route.put|route.delete`.
Source actions require live available catalogId owned by bridge; adopt requires
active target spaceId and unadopted record; skip/restore requires unadopted record.
Their route is null. Routing uses catalogId:null, spaceId:null, and route
`{id,scopeId,label,spaceId,moveToProjectId}` where scopeId names one owned Todoist
connection and label is nullable (unlabeled) or freely typed. route.put requires
an available connection, active target Space, and nullable opaque project choice
from that connection. route.delete supplies the same shape and permits unavailable
connections and archived target Spaces for cleanup. Bridge must be currently paired with provider_bridge capability.
Only one unresolved intent per catalog source or route ID; no automatic duplicate
provider action. Catalog/confirmed route facts remain unchanged until resolution.

`provider.intent.start` requires owning provider_bridge, current version,
payload `{}`: pending_desktop -> started. Persist local intent identity before
performing action. Replays use same mutation ID. Restarted started intent must
reconcile local/provider state; never repeat uncertain side effects blindly.
`provider.intent.resolve` same owner/current version:
`{state:"confirmed"|"rejected"|"uncertain",adoptedTaskId:string|null,errorCode:null|"authentication_required"|"provider_rejected"|"unsupported"|"retry_exhausted"|"delivery_uncertain"}`.
Only started/uncertain may resolve; confirmed requires null error, rejected
requires safe error (not delivery_uncertain), uncertain requires delivery_uncertain.
Confirmed adopt must reference already synchronized live source-owned task with
matching source identity and target Space; write rich task first via bridge,
then resolve. Confirmed skip/restore changes catalog flag; confirmed routing
updates/tombstones bridge route. Terminal confirmed/rejected never reopen.
Uncertain may reconcile later to confirmed/rejected; state remains visible.
Bridge catalog republish cannot silently erase unresolved intent or uncertain
state. Web receipt confirms only durable request; completion shown only from
bridge result. Local provider credentials and external-ID mapping remain Desktop.

## Acceptance

Migrations fresh+upgrades; auth scopes/CSRF/actor and ownership rejection;
canonical lost-response replay; sequence/version concurrent conflicts; atomic
multi-field creation/tree move/reference delete rollback; tombstone/no-resurrection;
rich date/recurrence query behavior; catalog ownership, request/start/recovery and
resolution; actual local Desktop/Cloud fixture without real providers; both prior
Web test sets/initial status/batch semantics, browser operations; measured query
budget for new max2 batches; source-secret scan and dry manifest verification.

## Pinned wire records and examples

All `workspace.changed.payload.tasks` entries are **complete flattened task
snapshots**, not `{fields:...}` wrappers. Affected task rows (including all moved
descendants and project-delete tasks) carry every key below. Schema 25 includes a nullable task
`updatedAt` key containing its accepted server modification time. Desktop accepts
older snapshots without that key; explicit null means historical time is unknown.
Migration 25 backfills surviving change history, and keeps the value independently
of later compaction. Missing new values from legacy migrated rows are explicit null.
Source facts are kept in `source`; local recurrenceRule is separate and source
recurrence is never written by task.patch. Provider source title is immutable.
Desktop must keep provider recurrence in the descriptor, not overwrite a local
recurrence overlay when refreshing provider snapshots.

```json
{
 "id":"task_example","spaceId":"space_default","projectId":null,"parentId":null,
 "title":"Example","completionState":"open","workflowStatus":"inbox","priority":3,
 "plannedOn":null,"plannedAt":null,"deadlineOn":null,"deadlineAt":null,
 "scheduledStart":null,"scheduledEnd":null,"durationMinutes":null,"recurrenceRule":null,
 "notes":null,"completedAt":null,"createdAt":"2026-10-13T00:00:00.000Z",
 "updatedAt":"2026-10-13T00:00:00.000Z",
 "entityVersion":1,"deletedAt":null,"labels":[],"source":null,"sourceOwnerDeviceId":null
}
```

`source` when present is the complete existing SafeSourceDescriptor (including
integrationKind/externalIdHash/sourceUrl/title/description/projectName/priority,
plannedOn/plannedAt/deadlineOn/deadlineAt/recurrenceRule/refreshedAt).
`sourceOwnerDeviceId` is the publishing device identity. Labels exactly `{id,name}`.

Space record exact keys: id,name,color,icon,sortOrder,isArchived,createdAt,
updatedAt,deletedAt,entityVersion. Boolean values are JSON booleans, not integers.
Project record exact keys: id,spaceId,name,description,color,icon,parentId,sortOrder,
status,isFavorite,createdAt,updatedAt,deletedAt,entityVersion. status as above;
no redundant isArchived key; derive from status. color/icon nullable strings.

Catalog record exact keys: id,bridgeDeviceId,scopeId,source,isSkipped,available,
adoptedTaskId,labelNames,projectChoices,entityVersion,createdAt,updatedAt.
Intent record exact keys: id,bridgeDeviceId,action,catalogId,spaceId,route,state,
adoptedTaskId,errorCode,entityVersion,createdAt,updatedAt.
Route record exact keys: id,bridgeDeviceId,scopeId,label,spaceId,moveToProjectId,
entityVersion,createdAt,updatedAt,deletedAt. route in a new intent has only the five
mutation keys id,scopeId,label,spaceId,moveToProjectId; null for source actions.
All IDs/timestamps strings, versions positive integers, nullable fields explicit
null. catalog source descriptor complete; flags booleans; choices `{id,name}`.

Catalog GET exact wrapper keys: protocolVersion,product,instanceId,serverReadAt,
scopes,catalog,intents,routes. Its intents array contains the latest intent for each
source/route target (including pending/started/uncertain) rather than historical
intent log. Routes include tombstones; catalog includes missing/unavailable
records. Provider intents GET exact wrapper keys: protocolVersion,product,
instanceId,serverReadAt,intents. Each intent has the above full record shape;
only authenticated bridge's unresolved entries, oldest first, maximum 100.

`/sync/bootstrap?workspace=1` keeps the existing outer keys
protocolVersion,product,checkpoint,snapshot. snapshot exact keys are existing
spaces,projects,tasks,labels,taskLabels,tombstones,sourceDescriptors,externalCommands
plus scopes,catalog,intents,routes. Spaces/projects are enriched complete records above;
tasks are complete task records above. taskLabels/sourceDescriptors remain in
their existing shapes as compatibility mirrors; new consumers must not double
apply relationships or recreate cleared source fields from mirror arrays.
No instanceId/serverReadAt key is added to bootstrap's outer wrapper.

`/sync/changes?after=0&limit=50&workspace=1` retains existing outer page keys.
Workspace change exact outer keys protocolVersion,product,changeSeq,mutationId,
operation,entityKind,entityId,entityVersion,payload,serverAcceptedAt; operation
workspace.changed/entityKind workspace. Payload has exactly all seven arrays
spaces,projects,tasks,scopes,catalog,intents,routes; an empty array means no affected
records of that kind. Atomic task creation example has one complete tasks entry,
all other arrays empty. Reference edits affect their reference array; project
delete also includes changed child projects and task snapshots. Bootstrap and
changes are durable within Desktop transaction before checkpoint ACK.

Routing scope is explicit even when moveToProjectId is null: the selected opaque scopeId identifies one owning Todoist connection. Never broaden to Microsoft or every bridge connection. Only the owning Desktop resolves raw provider identity.

Task title projection: source-bearing task reads and complete workspace snapshots use the current source descriptor title. The original SQL tasks.title remains creation storage, never an editable provider title. Local overlay recurrenceRule is distinct from source.recurrenceRule.

## Pinned scoped routing amendment (providerCatalog capability 2)

This section supersedes earlier unscoped catalog/routing shapes. Core envelope
protocol1 and workspace capability1 remain. Desktop accepts providerCatalog
capability1 for old Cloud browse/adopt/skip/legacy envelopes and capability2 for
scoped publication/routing. Publish new keys only after negotiating capability2.
No new unscoped routing is allowed. Historical envelopes still parse sufficiently
for exact canonical receipt replay before the new scope requirement is checked.
Historical catalog/routes missing scopeId project null/read-only for routing;
historical workspace changes with six arrays decode scopes as empty. New seven
arrays require the capability2-aware record decoder before checkpoint ACK.

provider.scope.put authenticates provider_bridge, uses an opaque scope_ entityId
and null base for create/current version for update. Exact payload:
{scope:{name,integrationKind,available,labelNames,projectChoices}}.
name is trimmed/nonempty UTF8<=512; integrationKind is nonempty <=64 and
immutable after creation; available boolean; labelNames and projectChoices use
the existing safe formats/bounds (max32 each; names UTF8<=512). Bridge owner is
immutable. Scope can exist with zero tasks and advertises cached project choices.
Exact scope record keys: id,bridgeDeviceId,name,integrationKind,available,
labelNames,projectChoices,entityVersion,createdAt,updatedAt.

provider.catalog.put item and catalog records add scopeId, required nonnull on
new capability2 publications, nullable/absent only for legacy replay/read. Scope
must belong to publishing bridge and its integrationKind must match source.
Once assigned, catalog scopeId is immutable. Initial legacy association may add
scopeId at the same observation timestamp under the entity version fence; all
existing source/availability/choice observation facts must remain identical. Existing catalog choice fields
remain for capability1 reading and source browsing.

Route exact new keys: id,scopeId,label,spaceId,moveToProjectId. New requests require
nonnull scopeId, owned Todoist scope. route.put requires available scope, active
Space and nullable project choice from THAT scope.projectChoices. label is typed
nullable/trimmed/nonempty UTF8<=512; suggestions do not restrict valid labels.
route.delete permits known owned Todoist scope even when unavailable or its
target Space archived, so stale local rules can be removed. Unknown/foreign
scopes and non-Todoist routing are rejected. Legacy unscoped requests with no
existing receipt are rejected unsupported and never sent to a provider.

GET /v1/provider/catalog adds scopes array. workspace.changed adds scopes array
(all seven arrays always present on new writes); bootstrap workspace=1 adds
snapshot.scopes. Schema23 creates provider_scopes plus nullable catalog.scope_id
FK and index. Root preserves pre-amendment synthetic states and initializes a
fresh fixture before final scoped acceptance. No production migration happened.
