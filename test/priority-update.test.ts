import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  computeCanonicalHash,
  parseTaskCreateMutation,
  parseTaskUpdatePriorityMutation,
  parseTaskUpdateTitleMutation,
  parseTaskUpdateWorkflowStatusMutation,
} from "../src/protocol.ts";
import { applyTaskCreate } from "../src/task-create.ts";
import { applyTaskOpenzaFieldsUpdate } from "../src/task-title-update.ts";
import acceptedReceipt from "./fixtures/accepted-task-priority-update-receipt.json";
import canonicalUpdate from "./fixtures/valid-task-priority-update.canonical.json?raw";
import duplicateReceipt from "./fixtures/duplicate-task-priority-update-receipt.json";
import goldenCreate from "./fixtures/valid-task-create.json?raw";
import goldenPriorityUpdate from "./fixtures/valid-task-priority-update.json?raw";
import goldenTitleUpdate from "./fixtures/valid-task-title-update.json?raw";
import goldenWorkflowUpdate from "./fixtures/valid-task-workflow-status-update.json?raw";
import goldenHash from "./fixtures/valid-task-priority-update.sha256?raw";
import pulledUpdate from "./fixtures/pulled-priority-update-page.json";

type MutableMutation = Record<string, any> & { payload: Record<string, any> };

function changed(json: string, change: (value: MutableMutation) => void): string {
  const value = JSON.parse(json) as MutableMutation;
  change(value);
  return JSON.stringify(value);
}

async function post(rawRequest: string): Promise<{ response: Response; body: Record<string, any> }> {
  const response = await exports.default.fetch("https://personal-cloud.local/v1/tasks/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawRequest,
  });
  return { response, body: await response.json() as Record<string, any> };
}

describe.sequential("priority task.updateOpenzaFields", () => {
  it("matches the shared contract, applies exactly once, pulls one update, and changes the read-only view", async () => {
    expect(canonicalize(goldenPriorityUpdate)).toBe(canonicalUpdate.trim());
    expect(await computeCanonicalHash(goldenPriorityUpdate)).toBe(goldenHash.trim());

    await applyTaskCreate(
      env.DB,
      parseTaskCreateMutation(goldenCreate, env.INSTANCE_ID),
      goldenCreate,
      { now: () => new Date("2026-09-13T06:30:01.000Z") },
    );
    await applyTaskOpenzaFieldsUpdate(
      env.DB,
      parseTaskUpdateTitleMutation(goldenTitleUpdate, env.INSTANCE_ID),
      goldenTitleUpdate,
      { now: () => new Date("2026-09-13T06:32:01.000Z") },
    );
    await applyTaskOpenzaFieldsUpdate(
      env.DB,
      parseTaskUpdateWorkflowStatusMutation(goldenWorkflowUpdate, env.INSTANCE_ID),
      goldenWorkflowUpdate,
      { now: () => new Date("2026-09-13T06:34:01.000Z") },
    );
    const update = parseTaskUpdatePriorityMutation(goldenPriorityUpdate, env.INSTANCE_ID);
    const first = await applyTaskOpenzaFieldsUpdate(env.DB, update, goldenPriorityUpdate, {
      now: () => new Date("2026-09-13T06:36:01.000Z"),
    });
    expect(first).toEqual(acceptedReceipt);
    expect(await applyTaskOpenzaFieldsUpdate(env.DB, update, goldenPriorityUpdate)).toEqual(duplicateReceipt);

    expect(await env.DB.prepare(
      "SELECT title, workflow_status, priority, entity_version FROM tasks WHERE id = ?1",
    ).bind(update.entityId).first()).toEqual({
      title: "Validate one renamed task",
      workflow_status: "next",
      priority: 1,
      entity_version: 4,
    });
    const pull = await exports.default.fetch("https://personal-cloud.local/sync/changes?after=3&limit=1");
    expect(await pull.json()).toEqual(pulledUpdate);

    const web = await exports.default.fetch("https://personal-cloud.local/v1/tasks", {
      headers: { "x-openza-test-session": "k5-local-read-only" },
    });
    expect(await web.json()).toMatchObject({
      freshness: "current",
      tasks: [{
        id: update.entityId,
        title: "Validate one renamed task",
        workflowStatus: "next",
        priority: 1,
      }],
    });
  });

  it("rolls back priority, version, receipt, change, and sequence after an injected failure", async () => {
    const rawCreate = changed(goldenCreate, (value) => {
      value.deviceId = "device_priority_rollback";
      value.mutationId = "mutation_priority_rollback_create";
      value.entityId = "local_priority_rollback";
      value.payload.task.id = value.entityId;
    });
    await applyTaskCreate(env.DB, parseTaskCreateMutation(rawCreate, env.INSTANCE_ID), rawCreate);
    const rawUpdate = changed(goldenPriorityUpdate, (value) => {
      value.deviceId = "device_priority_rollback";
      value.deviceSequence = 2;
      value.mutationId = "mutation_priority_rollback_update";
      value.entityId = "local_priority_rollback";
      value.baseEntityVersion = 1;
      value.payload.priority = 4;
    });
    const update = parseTaskUpdatePriorityMutation(rawUpdate, env.INSTANCE_ID);

    await expect(applyTaskOpenzaFieldsUpdate(env.DB, update, rawUpdate, { failAfterTaskUpdate: true }))
      .rejects.toThrow();
    expect(await env.DB.prepare("SELECT priority, entity_version FROM tasks WHERE id = ?1")
      .bind(update.entityId).first()).toEqual({ priority: 2, entity_version: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE mutation_id = ?1")
      .bind(update.mutationId).first()).toEqual({ count: 0 });
    expect(await applyTaskOpenzaFieldsUpdate(env.DB, update, rawUpdate))
      .toMatchObject({ outcome: "accepted", entityVersion: 2 });
  });

  it("rejects a stale base version without changing the accepted priority", async () => {
    const rawCreate = changed(goldenCreate, (value) => {
      value.deviceId = "device_priority_stale";
      value.mutationId = "mutation_priority_stale_create";
      value.entityId = "local_priority_stale";
      value.payload.task.id = value.entityId;
    });
    await post(rawCreate);
    const accepted = changed(goldenPriorityUpdate, (value) => {
      value.deviceId = "device_priority_stale";
      value.deviceSequence = 2;
      value.mutationId = "mutation_priority_stale_accepted";
      value.entityId = "local_priority_stale";
      value.baseEntityVersion = 1;
      value.payload.priority = 1;
    });
    expect((await post(accepted)).response.status).toBe(201);
    const stale = changed(accepted, (value) => {
      value.deviceSequence = 3;
      value.mutationId = "mutation_priority_stale_rejected";
      value.payload.priority = 4;
    });
    const result = await post(stale);
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "version_conflict", retryable: false } });
    expect(await env.DB.prepare("SELECT priority, entity_version FROM tasks WHERE id = ?1")
      .bind("local_priority_stale").first()).toEqual({ priority: 1, entity_version: 2 });
  });

  it.each([1, 2, 3, 4])("accepts priority %s at the contract boundary", (priority) => {
    const raw = changed(goldenPriorityUpdate, (value) => { value.payload.priority = priority; });
    expect(parseTaskUpdatePriorityMutation(raw, env.INSTANCE_ID).payload.priority).toBe(priority);
  });

  it.each([
    ["two fields together", changed(goldenPriorityUpdate, (value) => { value.payload.title = "Not combined"; })],
    ["zero", changed(goldenPriorityUpdate, (value) => { value.payload.priority = 0; })],
    ["five", changed(goldenPriorityUpdate, (value) => { value.payload.priority = 5; })],
    ["a decimal", changed(goldenPriorityUpdate, (value) => { value.payload.priority = 1.5; })],
  ])("rejects %s without a priority effect", async (_name, raw) => {
    const before = await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE payload_json LIKE '%priority%'")
      .first();
    const result = await post(raw);
    expect(result.response.status).toBeGreaterThanOrEqual(400);
    expect(result.body).toMatchObject({ product: "tasks", error: { retryable: false } });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE payload_json LIKE '%priority%'")
      .first()).toEqual(before);
  });
});
