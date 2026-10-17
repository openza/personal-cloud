# Source refresh history cost

Migration `0022_source_history_indexes.sql` adds an `(entity_id,operation,change_seq DESC)` index for latest deletion and a partial `(entity_id,change_seq DESC)` index restricted to source-bearing history. Migration23 rebuilds that partial index for the combined workspace contract: it retains both old source payload shapes and also recognizes `workspace.changed.payload.tasks[0].source` only when that task's ID equals the change entity ID. Rich creation has one complete task snapshot; a different first descendant in a tree/cascade change cannot replace the root's source identity. The recovery query and partial index use the same predicate, so source-less history remains excluded and rich-created tasks can be safely refreshed after purge without resurrection.

The source-refresh acceptance transaction queries historical deletion/identity only when the task no longer exists. Live and soft-deleted rows use current authoritative task/descriptor data. A task purged between preflight and acceptance still recovers its deletion and original source identity inside the transaction, emits a deletion acknowledgement, and is not resurrected. Existing source identity, device claim, durable receipt, and compaction/race invariants remain in force.

Synthetic local D1 counters for the actual append statement, compared with the frozen pre-change SQL:

| Historical changes | Live before | Live after | Purged before | Purged after |
| --- | ---: | ---: | ---: | ---: |
|10,000|20,010|10|10,009|8|
|100,000|200,010|10|100,009|8|

Values are `meta.rows_read`. Before EXPLAIN showed two `SCAN changes` operations; after shows indexed entity/deletion and partial-source `SEARCH`. Live append `rows_written` rose2→4 and purged append2→3 because indexes are maintained. Index creation also has a one-time history cost during a future migration.

`test/source-history-performance.test.ts` reproduces10k/100k history scaling, both query plans and D1 counters, and no-resurrection acceptance after synthetic purge. `test/fixtures/source-refresh-before.sql` is the frozen baseline statement. Existing real compaction and concurrent deletion tests exercise the production mutation path separately.

These numbers isolate history-query work in a local synthetic database; provider delivery/command tables are empty. They do not claim full production billing savings, end-to-end upload speed, or Worker Free CPU acceptance. Other invariant-trigger work is included in the emitted plans and can vary with provider state. No remote migration, database write, or deployment is performed by these tests.

Migration24 separately adds a covering descriptor identity index for atomic
source ownership checks on legacy/rich task creation and catalog publication.
At10,000 and100,000 distinct source descriptors, the actual D1 foreign-owner
predicate reads2 rows at each scale. EXPLAIN uses the descriptor identity index,
task primary key and catalog unique identity index; it does not scan all tasks
or history. Cost can depend on the number of historical aliases for one identity;
those aliases are preserved and provider delivery continues to reject ambiguity.
