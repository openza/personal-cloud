import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  computeCanonicalHash,
  parseTaskCompleteMutation,
  parseTaskCreateMutation,
  parseTaskUpdatePriorityMutation,
  parseTaskUpdateTitleMutation,
  parseTaskUpdateWorkflowStatusMutation,
} from "../src/protocol.ts";
import { applyTaskComplete } from "../src/task-complete.ts";
import { applyTaskCreate } from "../src/task-create.ts";
import { applyTaskOpenzaFieldsUpdate } from "../src/task-title-update.ts";
import acceptedReceipt from "./fixtures/accepted-task-complete-receipt.json";
import canonicalComplete from "./fixtures/valid-task-complete.canonical.json?raw";
import duplicateReceipt from "./fixtures/duplicate-task-complete-receipt.json";
import goldenComplete from "./fixtures/valid-task-complete.json?raw";
import goldenCreate from "./fixtures/valid-task-create.json?raw";
import goldenPriority from "./fixtures/valid-task-priority-update.json?raw";
import goldenTitle from "./fixtures/valid-task-title-update.json?raw";
import goldenWorkflow from "./fixtures/valid-task-workflow-status-update.json?raw";
import goldenHash from "./fixtures/valid-task-complete.sha256?raw";
import pulledComplete from "./fixtures/pulled-task-completed-page.json";

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

describe.sequential("task.complete", () => {
  it("matches the shared contract, completes exactly once, pulls the lifecycle change, and updates Web", async () => {
    expect(canonicalize(goldenComplete)).toBe(canonicalComplete.trim());
    expect(await computeCanonicalHash(goldenComplete)).toBe(goldenHash.trim());

    await applyTaskCreate(env.DB, parseTaskCreateMutation(goldenCreate, env.INSTANCE_ID), goldenCreate, {
      now: () => new Date("2026-09-13T06:30:01.000Z"),
    });
    await applyTaskOpenzaFieldsUpdate(
      env.DB,
      parseTaskUpdateTitleMutation(goldenTitle, env.INSTANCE_ID),
      goldenTitle,
      { now: () => new Date("2026-09-13T06:32:01.000Z") },
    );
    await applyTaskOpenzaFieldsUpdate(
      env.DB,
      parseTaskUpdateWorkflowStatusMutation(goldenWorkflow, env.INSTANCE_ID),
      goldenWorkflow,
      { now: () => new Date("2026-09-13T06:34:01.000Z") },
    );
    await applyTaskOpenzaFieldsUpdate(
      env.DB,
      parseTaskUpdatePriorityMutation(goldenPriority, env.INSTANCE_ID),
      goldenPriority,
      { now: () => new Date("2026-09-13T06:36:01.000Z") },
    );
    const mutation = parseTaskCompleteMutation(goldenComplete, env.INSTANCE_ID);
    const first = await applyTaskComplete(env.DB, mutation, goldenComplete, {
      now: () => new Date("2026-09-13T06:38:01.000Z"),
    });
    expect(first).toEqual(acceptedReceipt);
    expect(await applyTaskComplete(env.DB, mutation, goldenComplete)).toEqual(duplicateReceipt);

    expect(await env.DB.prepare(`
      SELECT title, workflow_status, priority, completion_state, completed_at, entity_version
      FROM tasks WHERE id = ?1
    `).bind(mutation.entityId).first()).toEqual({
      title: "Validate one renamed task",
      workflow_status: "next",
      priority: 1,
      completion_state: "completed",
      completed_at: "2026-09-13T06:38:00.000Z",
      entity_version: 5,
    });
    const pull = await exports.default.fetch("https://personal-cloud.local/sync/changes?after=4&limit=1");
    expect(await pull.json()).toEqual(pulledComplete);

    const web = await exports.default.fetch("https://personal-cloud.local/v1/tasks", {
      headers: { "x-openza-test-session": "k5-local-read-only" },
    });
    expect(await web.json()).toMatchObject({
      freshness: "current",
      tasks: [{
        id: mutation.entityId,
        completionState: "completed",
        completedAt: "2026-09-13T06:38:00.000Z",
        workflowStatus: "next",
        priority: 1,
      }],
    });
  });

  it("rolls back completion, timestamp, version, receipt, change, and sequence after an injected failure", async () => {
    const rawCreate = changed(goldenCreate, (value) => {
      value.deviceId = "device_complete_rollback";
      value.mutationId = "mutation_complete_rollback_create";
      value.entityId = "local_complete_rollback";
      value.payload.task.id = value.entityId;
    });
    await applyTaskCreate(env.DB, parseTaskCreateMutation(rawCreate, env.INSTANCE_ID), rawCreate);
    const rawComplete = changed(goldenComplete, (value) => {
      value.deviceId = "device_complete_rollback";
      value.deviceSequence = 2;
      value.mutationId = "mutation_complete_rollback";
      value.entityId = "local_complete_rollback";
      value.baseEntityVersion = 1;
    });
    const mutation = parseTaskCompleteMutation(rawComplete, env.INSTANCE_ID);

    await expect(applyTaskComplete(env.DB, mutation, rawComplete, { failAfterTaskUpdate: true }))
      .rejects.toThrow();
    expect(await env.DB.prepare("SELECT completion_state, completed_at, entity_version FROM tasks WHERE id = ?1")
      .bind(mutation.entityId).first()).toEqual({
        completion_state: "open",
        completed_at: null,
        entity_version: 1,
      });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE mutation_id = ?1")
      .bind(mutation.mutationId).first()).toEqual({ count: 0 });
    expect(await applyTaskComplete(env.DB, mutation, rawComplete))
      .toMatchObject({ outcome: "accepted", entityVersion: 2 });
  });
  it("rejects stale completion and a second completion without changing the accepted lifecycle", async () => {
    const rawCreate = changed(goldenCreate, (value) => {
      value.deviceId = "device_complete_conflict";
      value.mutationId = "mutation_complete_conflict_create";
      value.entityId = "local_complete_conflict";
      value.payload.task.id = value.entityId;
    });
    await post(rawCreate);
    const accepted = changed(goldenComplete, (value) => {
      value.deviceId = "device_complete_conflict";
      value.deviceSequence = 2;
      value.mutationId = "mutation_complete_accepted";
      value.entityId = "local_complete_conflict";
      value.baseEntityVersion = 1;
    });
    expect((await post(accepted)).response.status).toBe(201);

    const stale = changed(accepted, (value) => {
      value.deviceSequence = 3;
      value.mutationId = "mutation_complete_stale";
      value.payload.completedAt = "2026-09-13T06:39:00.000Z";
    });
    const staleResult = await post(stale);
    expect(staleResult.response.status).toBe(409);
    expect(staleResult.body).toMatchObject({ error: { code: "version_conflict", retryable: false } });

    const again = changed(stale, (value) => {
      value.mutationId = "mutation_complete_again";
      value.baseEntityVersion = 2;
    });
    const againResult = await post(again);
    expect(againResult.response.status).toBe(409);
    expect(againResult.body).toMatchObject({ error: { code: "invalid_transition", retryable: false } });
    expect(await env.DB.prepare("SELECT completion_state, completed_at, entity_version FROM tasks WHERE id = ?1")
      .bind("local_complete_conflict").first()).toEqual({
        completion_state: "completed",
        completed_at: "2026-09-13T06:38:00.000Z",
        entity_version: 2,
      });
  });

  it.each([
    ["an extra field", changed(goldenComplete, (value) => { value.payload.workflowStatus = "inbox"; })],
    ["an invalid completion timestamp", changed(goldenComplete, (value) => { value.payload.completedAt = "today"; })],
    ["a missing task", changed(goldenComplete, (value) => {
      value.deviceId = "device_complete_missing";
      value.deviceSequence = 1;
      value.mutationId = "mutation_complete_missing";
      value.entityId = "local_complete_missing";
    })],
  ])("rejects %s without a completion effect", async (_name, raw) => {
    const before = await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE operation = 'task.completed'")
      .first();
    const result = await post(raw);
    expect(result.response.status).toBeGreaterThanOrEqual(400);
    expect(result.body).toMatchObject({ product: "tasks", error: { retryable: false } });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE operation = 'task.completed'")
      .first()).toEqual(before);
  });
});
