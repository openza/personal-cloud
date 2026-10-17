# Combined Personal Cloud/Web functional parity

Desktop is the core app and owns all third-party integrations. Web is its
Personal Cloud companion. Shared task behavior and visual language are the
parity target; provider account setup, intake, routing and delivery recovery
are intentionally absent from Web. Reproducible local acceptance is documented
in [Local shared-workflow validation](local-parity-validation.md).

Source-only implementation of Linux task-workspace functionality and the frozen
initial-sync feedback/efficiency change. Shared wire contract and exact records:
[workspace contract v1](workspace-contract-v1.md), schema25, protocol1, with
[bounded workspace paging](workspace-paging-v1.md).
Linux references: MainWindowViewModel.cs/Parity.cs, Shell/MainWindow.axaml,
SqliteTaskStore.cs, TaskQuery.cs, TaskGroupAssignment.cs, TaskDateValues.cs.

| Linux surfaced workflow | Combined Web/Cloud behavior |
| --- | --- |
| Spaces and scope | All Spaces or one active Space, counts and durable selection; standalone versioned create/rename/archive with a last-active-Space guard. |
| Projects | Create/edit name, description, favorite, status, archive/restore and delete. Description/name search, navigation/counts, favorite-first sorting, default/name/count/created/updated sort with persisted direction. Active/Completed/Archived/All projects navigation retains historical assignments and captions. Completed projects remain assignable; archived projects are excluded from new assignment and global search. Delete atomically detaches tasks to Inbox and child projects from their parent, retaining tombstones. |
| Task creation and editing | A single rich create saves local fields, labels and project together; Create and open selects the new task after acceptance. Multi-field patches commit together against the editor's original version, so a background refresh cannot promote a stale draft into an overwrite. Existing durable replay, completion/reopen, deletion and label attach/create/remove behavior retained. |
| Tree move | Worker atomically enumerates and moves the live descendant tree, preserves internal parents, clears incompatible projects, detaches root from its outside parent and applies root fields in the same transaction. |
| Subtasks | Existing provider subtasks and completion/details remain available. Native subtask create/detach/reparent is explicitly excluded. |
| Labels | Suggestions, create/attach/remove, filters and all-label group membership. Standalone label rename/delete excluded because not surfaced in inspected Linux UI. |
| Views and dates | Inbox excludes project tasks; Next/Waiting/Someday/open/completed retained. Today/Calendar/Overdue and sorting include date-only/exact plans, exact deadlines and scheduled start. Unchanged exact plan/deadline values survive date-only picker saves; scheduled end/duration and local recurrence are retained/shown. |
| Query controls | Status/priority/label/source/repeat filters; local recurrence or source recurrence counts as repeating. Priority/date/created/title/project sorting; groups by date/project/status/priority/every label/source/repeat/created/completed and collapse state. Dates use the same local and relative captions as Desktop while matching membership/order. |
| Search | Current-list search with ancestor context; ranked global task/project search with current/all-Space scope, completed option and direct-child results, bounded to25. Project descriptions and archive exclusions included. |
| Preferences | Durable Space/view/project plus per-context task controls, shared All Tasks/project grouping, and project sort/direction/favorite-first preference; session-state migration retained. |
| Provider facts | Source title/details read-only, local overlays editable, provider completion status remains distinct from provider confirmation. Refreshed descriptor title is authoritative in task reads/full workspace snapshots. Local recurrence is separate from source recurrence. |
| Third-party integrations | Desktop-only. Web does not expose provider sign-in, catalog adoption/skipping, routing or delivery recovery. Cloud retains synchronization protocols for Desktop. Source descriptors and provider completion status remain visible on synchronized tasks. |
| Initial upload | Imported ordered per-device status endpoint, truthful nullable counts, no invented percentage, precedence/staleness/unknown handling, independent polling/abort/resume/signout guards and phase-specific empty states. Telemetry failure does not disable current task controls. |
| Efficiency | Imported indexed source/deletion history and optional ordered max2 mutation batch. New atomic workspace operations retain bounded SQL invocation count; no native/provider credentials enter Cloud. |

Desktop-only local/OS workflows remain on Desktop: provider accounts/polling,
local SQLite/backup/restore/import/export, tray/window/launch settings, setup and
GitHub account integration. Snap/installed applications, live providers,
production/cloud requests and deployment/release remain outside local acceptance.

## Web workbench layout

The Web shell follows the current Desktop workbench: expanded navigation is
220px (64px when collapsed), followed by the task list and a selected task's
inline editor. Tasks or a selected project inserts the Projects pane between
navigation and list. Closing the editor removes its column. Each pane scrolls
independently; list headers and commands stay above the scrolling task rows.

The responsive decision uses the remaining workbench width after navigation.
At 900px or more, Projects uses 300px (360px from 1250px), the editor uses
42% clamped to 460–620px, and the list takes the remainder. Below 900px, a
selected editor replaces the list and Projects; without an editor, a Projects
command toggles the optional inline project list. Narrow editor fields stack
using the editor's own width. On phone-width screens, navigation becomes a
horizontal disclosure above the workbench.

Global Search is an owner modal and leaves the underlying task context intact
when cancelled. Settings uses the same navigation and a compact scrollable
content area. Add task, Search, workspace management and unsaved-edit prompts
share the Desktop color, type, spacing and corner tokens. Navigation and project
creation icons are from Microsoft's MIT-licensed Fluent System Icons; their
license is shipped with the Web assets.

Task edits autosave on field blur without closing the inspector or moving focus. Explicit Save remains available as a fallback. Row actions reach Date, Project, Labels, Status, Priority and Space through the same guarded inspector. Project rows open their edit dialog directly; Settings lists Spaces and supports create/rename/archive. Closing or navigating away from a dirty editor
offers Save, Discard, or Keep editing; resizing does not recreate the editor.
The same guard applies before completing a task. If refresh removes the selected
task, a dirty draft remains available read only for copying instead of being
silently closed; it cannot write back to the unavailable task. Search preserves the underlying
editor; Save or Discard resolves its draft before opening the owner modal.
Reloading preserves the selected Space/view/project and query preferences. A
one-time `view` URL parameter is consumed so it cannot override later selection.

Copy title/notes uses current trimmed draft text; source and task-information
copy use reported safe metadata. Created is available. Schema 25 reports the accepted task UpdatedAt; historical unknown values stay explicit instead of being inferred from read time or version.
Desktop also exposes only date pickers, so exact timestamps and schedule/duration/
recurrence remain preserved metadata rather than new editable time controls.

Ctrl/Cmd+K opens Search, Ctrl/Cmd+N opens Add task (including a one-time request
after leaving Settings), and Ctrl/Cmd+F focuses the current-list search. A selected
editor supports Ctrl/Cmd+S without invoking provider sync. Active owner modals
retain their own keyboard handling. Browser-reserved accelerators may take
precedence; the corresponding visible actions remain available.

Created-date ordering retains the existing newest-first default and oldest-first
reverse preference, with contextual labels describing that ordering. Other sort
directions retain their ascending/descending meaning. Destructive task/device
confirmations use the shared in-page dialog and default to Cancel;
Provider delivery recovery belongs to Desktop; the Cloud guards remain intact.

Owner writes recover once from an explicit `csrf_failed` response by reading a
fresh token and replaying the identical request body under a shared Web Lock.
Other authorization, origin, contract and server failures are not automatically
replayed by this recovery. Explicit CSRF rejection precedes domain mutation and
does not leave a cancelled change queued; uncertain responses retain exact
durable replay. Failed writes replace the Saving status with an unconfirmed
outcome. Server authentication, CSRF checks and actor authorization are unchanged.

## Compatibility and delivery

Apply migrations21–25 before deploying this Worker/assets together in a future
approved release. Health reports schema25; this source artifact is not evidence
that any deployed database has those migrations. New Desktop readers negotiate
workspace=1 for bootstrap/pull and apply complete workspace arrays atomically.
Paging-capable readers stage a checkpoint-pinned baseline, restart if its head
changes, and replace the replica only after the final page. Byte-bounded feeds
use explicit hasMore; a short page is not necessarily the end. Oversized new
compound changes roll back before receipt/sequence commit. Stored payloads are
bounded separately below the documented D1 row limit.
Older readers stop with upgrade_required before crossing new change records;
they cannot silently advance a checkpoint past unsupported operations. Old Cloud
uses its existing operation contracts; Web gates new workspace writes by health
capability. No partial multi-call fallback is used for rich create or tree move.
Provider catalog capability2 enables scoped publication/routing, seven-array
changes and snapshot.scopes. Historical six-array changes decode scopes empty;
old exact receipts remain replayable and legacy routing stays read-only.

The initial-sync source was imported from a recorded patch and per-file
manifest, with overlapping Web files integrated semantically. The original
recovery source remains unchanged. Import and validation evidence is retained
locally outside the source artifact.

## Verification record

Both Web test sets and every shipped JavaScript syntax check are included in
test:web. Worker tests cover auth/CSRF/actor capabilities, metadata CAS races,
rollback/replay, rich fields, atomic tree/cascade behavior, tombstones, old-reader
upgrade rejection, full records, catalog ownership, uncertainty reconciliation,
confirmed skip/restore and routing/tombstones. Rebootstrap tests remain included.

Actual authenticated local Worker/Miniflare query counts include every D1 batch
statement and bearer authentication:45 for two rich source creates with32 labels
and project each;32 for tree/root patch plus cascade delete;29 for two patches.
All are within D1 Free50 per invocation. Workers Free CPU10ms remains unmeasured;
local CPU timing would not establish live acceptance.
Scoped two-mutation measurements use23 queries for connection publications,
31 for catalog publications and41 for routing requests with project guards.
Two purged rich-created source refreshes use29 queries and retain source identity
without recreating a deleted task. The guarded workspace-source history shape
is covered by the same partial index as the legacy source shapes.
The synthetic100,000-row regression checks indexed live and purged recovery
without a changes-table scan and requires fewer than50 rows read per append.
The new live-source ownership lookup reads2 rows at both10k and100k descriptors
with the identity index. Both legacy/rich creation and catalog publication guard
foreign or unknown ownership inside their atomic transaction. Historical aliases
remain intact and retain provider-delivery ambiguity protection.
Authenticated paged baseline requests use4 SQL statements and feeds use2.
Fifty near-limit compound feed rows materialize only one payload for the first
page, avoiding allocation of all50 payloads. A separate real SQLite probe sets
the D1 length2,000,000 and function-argument32 limits: the25-key task record
retains nulls, near-bound records succeed, larger changes reject/roll back, and
pre-trigger SQLITE_TOOBIG maps to a nonretryable size conflict.

Historical combined-contract checks before its correction review:153 Worker tests across28
files,45 Web tests (including both prior suites and all JavaScript syntax), four
rebootstrap tests, one SQLite platform-limit probe, typecheck, diff check and
gitleaks history plus current public/src/migrations/docs/test/test-node scans
passed. The dry artifact's36
manifest files and source asset/migration hashes match; all23 frozen input files
and recorded import copies remain hash-identical. The generated Worker executes
with its own24 migrations in isolated Miniflare: authenticated scope publication,
seven-array changes, and rich-source create/delete/purge/refresh without
resurrection and complete12-page baseline/explicit feed hasMore pass.

Historical browser acceptance before the desktop-only integration boundary
used the actual local Worker/D1 fixture through a localhost
adapter with synthetic auth facade and an actual seeded synthetic owner session
for initial-status. Space create/rename, project lifecycle/metadata/search/sort,
rich task creation, multi-field patch and atomic tree move verified. Seven new
browser intents were confirmed by the retained Desktop bridge: adopt, skip,
restore, and scoped routing put/delete with and without a provider project.
The browser also confirmed a new-project draft retains Space/name/description
across an automatic background refresh, and a notes-only save retains its
assigned archived project while the option stays unavailable for new selection.
The browser showed zero-task connection choices, disabled duplicate pending
actions, and read-only cached controls during unavailability. Initial upload
status remained truthfully unknown when the synthetic bridges had not reported.
These checks use disposable local data and fake providers; they do not establish
production or real-provider acceptance.

The subsequent local UI completion pass adds deterministic checks for shared
commands, current-draft copy, local validation, archived navigation/group captions,
editor concurrency, and connected filtering/bulk-request partial failure. Its
current Web suite has109 passing tests, with current typecheck/diff checks passing.
Correction regressions cover remote writes before/during label refresh, causal
own-label version advancement, and Create and open across delayed reads or
post-acceptance refresh/session-rotation failures without duplicate creation.
A signout generation also prevents delayed create/open continuations from
restoring pending navigation after session expiry or a subsequent login.
Focused provider-delivery/auth Worker checks pass17 tests; the unchanged backend's
153-test result above remains the retained full-suite baseline. Local protocol
fixtures separately verify stale CAS, exact-field preservation, source-tree moves,
archived assignment, bridge-intent transitions/duplicate rejection, unavailable
route cleanup, and authenticated delivery pagination100+1 with acknowledgement
guards. Those API results are not browser, hardware or real-provider acceptance.

The normal Desktop release workflow retains its existing pinned Cloud artifact.
This source candidate is a separate local bundle. A future release must publish
and pin the matching Cloud artifact before claiming these features in the
default packaged product; local bundle validation does not change that pin.
