import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import beforeSql from "./fixtures/source-refresh-before.sql?raw";
import fixture from "./fixtures/valid-source-linked-task-create.json?raw";
import { appendSourceChange, applySourceRefresh } from "../src/source-lifecycle.ts";
import { applyMutation } from "../src/mutation-apply.ts";
import { parseTaskMutation, type SourceRefreshMutation } from "../src/protocol.ts";

const at = "2026-10-13T00:00:00.000Z";

function currentQuery(mutation: SourceRefreshMutation) {
  let sql = "";
  const capture = { prepare(value: string) { sql = value; return { bind() { return null; } }; } } as unknown as D1Database;
  appendSourceChange(capture, mutation, at);
  return sql;
}

async function seed(historySize: number) {
  const create = JSON.parse(fixture);
  create.instanceId = env.INSTANCE_ID;
  create.deviceId = `device.performance.${historySize}`; create.mutationId = `mutation.performance.${historySize}.create`;
  create.entityId = `task.performance.${historySize}`; create.payload.task.id = create.entityId;
  const created = await applyMutation(env.DB, parseTaskMutation(JSON.stringify(create), env.INSTANCE_ID), JSON.stringify(create));
  // 1,000 entity histories, including many source-less updates to the target.
  // Direct synthetic history rows avoid unrelated setup receipt/auth overhead.
  await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?1)
    INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,
      entity_id,entity_version,payload_json,server_accepted_at)
    SELECT i+?4,1,'tasks','synthetic.history.'||?5||'.'||i,'task.updatedOpenzaFields','task',
      CASE WHEN i%100=0 THEN ?5 ELSE 'synthetic.entity.'||(i%1000) END,
      1,CASE WHEN i%5=0 AND i%100!=0 THEN json_object('task',json_object('id','synthetic.entity.'||(i%1000),
        'source',json_object('integrationKind','todoist','externalIdHash',?2)))
      ELSE json_object('task',json_object('id',CASE WHEN i%100=0 THEN ?5 ELSE 'synthetic.entity.'||(i%1000) END,'notes','Synthetic metadata')) END,?3
    FROM n`).bind(historySize, "b".repeat(64), at, created.changeSeq, create.entityId).run();
  await env.DB.prepare("UPDATE cloud_state SET next_change_seq=?1 WHERE singleton=1").bind(created.changeSeq+historySize).run();
  return { ...create, deviceSequence: 2, mutationId: `mutation.performance.${historySize}.refresh`, operation: "source.refreshSnapshot",
    payload: { source: { ...create.payload.source, refreshedAt: at } } } as SourceRefreshMutation;
}

async function restoreIndexes() {
  // Use the already officially parsed test migration statements, not D1.exec's line splitter.
  const migration = env.TEST_MIGRATIONS.find(item => item.name.includes("workspace_parity"));
  if (!migration) throw new Error("Missing synthetic test index migration");
  await env.DB.batch(migration.queries.filter(sql=>/\bCREATE INDEX changes_(?:by_entity_operation|source_history_by_entity)\b/.test(sql)).map(sql => env.DB.prepare(sql)));
}

async function dropIndexes() {
  await env.DB.batch([env.DB.prepare("DROP INDEX changes_by_entity_operation"),env.DB.prepare("DROP INDEX changes_source_history_by_entity")]);
}

async function measure(sql: string, mutation: SourceRefreshMutation, label: string) {
  const args = [mutation.mutationId+"."+label, mutation.entityId, at, mutation.payload.source.integrationKind,
    mutation.payload.source.externalIdHash];
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN "+sql).bind(...args).all<{detail:string}>();
  const result = await env.DB.prepare(sql).bind(...args).run();
  // Remove only this synthetic measurement's unreferenced append. Otherwise a
  // live measurement adds a new source-bearing history row and masks the later
  // purged lookup's old-source case. Real mutation receipts are never removed.
  await env.DB.prepare("DELETE FROM changes WHERE mutation_id=?1").bind(args[0]).run();
  return { rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written,
    plan: plan.results.map(row => row.detail) };
}

describe("synthetic D1 source history scaling", () => {
  for (const historySize of [10_000, 100_000]) it(`keeps live and purged recovery bounded with ${historySize} historical changes`, async () => {
    const mutation = await seed(historySize);
    const afterSql = currentQuery(mutation);
    await dropIndexes();
    const beforeLive = await measure(beforeSql, mutation, "before.live");
    await restoreIndexes();
    const afterLive = await measure(afterSql, mutation, "after.live");
    expect(beforeLive.plan.some(line => /SCAN changes/.test(line))).toBe(true);
    expect(afterLive.plan.some(line => /SCAN changes/.test(line))).toBe(false);
    expect(afterLive.plan.join("\n")).toContain("changes_by_entity_operation");
    expect(afterLive.plan.join("\n")).toContain("changes_source_history_by_entity");
    expect(beforeLive.rowsRead).toBeGreaterThanOrEqual(historySize);
    expect(afterLive.rowsRead).toBeLessThan(50);

    // Simulate a valid deletion followed by retention compaction, leaving immutable history.
    await env.DB.prepare(`INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,
      entity_id,entity_version,payload_json,server_accepted_at)
      SELECT next_change_seq+1,1,'tasks','synthetic.deletion.'||?1,'task.deleted','task',?1,2,
        json_object('task',json_object('id',?1,'deletedAt',?2)),?2 FROM cloud_state WHERE singleton=1`)
      .bind(mutation.entityId,at).run();
    await env.DB.prepare("UPDATE cloud_state SET next_change_seq=next_change_seq+1 WHERE singleton=1").run();
    await env.DB.prepare("DELETE FROM tasks WHERE id=?1").bind(mutation.entityId).run();
    await dropIndexes();
    const beforePurged = await measure(beforeSql, mutation, "before.purged");
    await restoreIndexes();
    const afterPurged = await measure(afterSql, mutation, "after.purged");
    expect(afterPurged.plan.some(line => /SCAN changes/.test(line))).toBe(false);
    expect(beforePurged.rowsRead).toBeGreaterThanOrEqual(historySize);
    expect(afterPurged.rowsRead).toBeLessThan(50);
    const receipt = await applySourceRefresh(env.DB, mutation, JSON.stringify(mutation));
    expect(receipt).toMatchObject({ outcome: "accepted", entityVersion: 2 });
    expect(await env.DB.prepare("SELECT id FROM tasks WHERE id=?1").bind(mutation.entityId).first()).toBeNull();
    console.log("SOURCE_HISTORY_PERFORMANCE "+JSON.stringify({historySize,beforeLive,afterLive,beforePurged,afterPurged}));
  }, 30_000);
});
