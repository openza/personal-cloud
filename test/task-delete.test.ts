import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseTaskDeleteMutation } from "../src/protocol.ts";
import { applyTaskDelete } from "../src/task-delete.ts";
import goldenDelete from "./fixtures/valid-task-delete.json?raw";
import pulledDelete from "./fixtures/pulled-task-deleted-page.json";
import goldenCreate from "./fixtures/valid-task-create.json?raw";
import { applyTaskCreate } from "../src/task-create.ts";
import { parseTaskCreateMutation } from "../src/protocol.ts";

describe.sequential("task.delete tombstone", () => {
  it("hides the task while retaining an ordered tombstone", async () => {
    const create = JSON.parse(goldenCreate);
    create.deviceId = "device_delete_main";
    create.mutationId = "mutation_delete_create";
    create.entityId = "local_delete_main";
    create.payload.task.id = create.entityId;
    const createRaw = JSON.stringify(create);
    await applyTaskCreate(env.DB, parseTaskCreateMutation(createRaw, env.INSTANCE_ID), createRaw);
    const deletion = JSON.parse(goldenDelete);
    deletion.deviceId = create.deviceId;
    deletion.deviceSequence = 2;
    deletion.mutationId = "mutation_delete_main";
    deletion.entityId = create.entityId;
    deletion.baseEntityVersion = 1;
    const raw = JSON.stringify(deletion);
    const mutation = parseTaskDeleteMutation(raw, env.INSTANCE_ID);
    expect(await applyTaskDelete(env.DB, mutation, raw, { now: () => new Date("2026-09-13T06:46:01.000Z") }))
      .toMatchObject({ outcome: "accepted", entityVersion: 2 });
    expect(await applyTaskDelete(env.DB, mutation, raw)).toMatchObject({ outcome: "duplicate" });
    expect(await env.DB.prepare("SELECT entity_version,deleted_at,purge_after FROM tombstones WHERE entity_id=?1")
      .bind(mutation.entityId).first()).toEqual({ entity_version: 2, deleted_at: deletion.payload.deletedAt, purge_after: "2026-10-13T06:46:00.000Z" });
    const web = await exports.default.fetch("https://personal-cloud.local/v1/tasks", {
      headers: { "x-openza-test-session": "k5-local-read-only" },
    });
    expect((await web.json() as any).tasks).toEqual([]);
  });

  it("rolls task and tombstone back together after failure", async () => {
    const create = JSON.parse(goldenCreate);
    create.deviceId = "device_delete_rollback";
    create.mutationId = "mutation_delete_rollback_create";
    create.entityId = "local_delete_rollback";
    create.payload.task.id = create.entityId;
    const createRaw = JSON.stringify(create);
    await applyTaskCreate(env.DB, parseTaskCreateMutation(createRaw, env.INSTANCE_ID), createRaw);
    const deletion = JSON.parse(goldenDelete);
    deletion.deviceId = create.deviceId; deletion.deviceSequence = 2;
    deletion.mutationId = "mutation_delete_rollback"; deletion.entityId = create.entityId; deletion.baseEntityVersion = 1;
    const raw = JSON.stringify(deletion);
    const mutation = parseTaskDeleteMutation(raw, env.INSTANCE_ID);
    await expect(applyTaskDelete(env.DB, mutation, raw, { failAfterTaskUpdate: true })).rejects.toThrow();
    expect(await env.DB.prepare("SELECT deleted_at,entity_version FROM tasks WHERE id=?1").bind(create.entityId).first())
      .toEqual({ deleted_at: null, entity_version: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM tombstones WHERE entity_id=?1").bind(create.entityId).first())
      .toEqual({ count: 0 });
  });
});
