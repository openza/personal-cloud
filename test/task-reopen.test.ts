import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  computeCanonicalHash,
  parseTaskCompleteMutation,
  parseTaskCreateMutation,
  parseTaskReopenMutation,
  parseTaskUpdatePriorityMutation,
  parseTaskUpdateTitleMutation,
  parseTaskUpdateWorkflowStatusMutation,
} from "../src/protocol.ts";
import { applyTaskComplete } from "../src/task-complete.ts";
import { applyTaskCreate } from "../src/task-create.ts";
import { applyTaskReopen } from "../src/task-reopen.ts";
import { applyTaskOpenzaFieldsUpdate } from "../src/task-title-update.ts";
import acceptedReceipt from "./fixtures/accepted-task-reopen-receipt.json";
import canonicalReopen from "./fixtures/valid-task-reopen.canonical.json?raw";
import duplicateReceipt from "./fixtures/duplicate-task-reopen-receipt.json";
import goldenComplete from "./fixtures/valid-task-complete.json?raw";
import goldenCreate from "./fixtures/valid-task-create.json?raw";
import goldenPriority from "./fixtures/valid-task-priority-update.json?raw";
import goldenReopen from "./fixtures/valid-task-reopen.json?raw";
import goldenTitle from "./fixtures/valid-task-title-update.json?raw";
import goldenWorkflow from "./fixtures/valid-task-workflow-status-update.json?raw";
import goldenHash from "./fixtures/valid-task-reopen.sha256?raw";
import pulledReopen from "./fixtures/pulled-task-reopened-page.json";

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

async function applyGoldenChainThroughCompletion(): Promise<void> {
  await applyTaskCreate(env.DB, parseTaskCreateMutation(goldenCreate, env.INSTANCE_ID), goldenCreate);
  await applyTaskOpenzaFieldsUpdate(
    env.DB, parseTaskUpdateTitleMutation(goldenTitle, env.INSTANCE_ID), goldenTitle,
  );
  await applyTaskOpenzaFieldsUpdate(
    env.DB, parseTaskUpdateWorkflowStatusMutation(goldenWorkflow, env.INSTANCE_ID), goldenWorkflow,
  );
  await applyTaskOpenzaFieldsUpdate(
    env.DB, parseTaskUpdatePriorityMutation(goldenPriority, env.INSTANCE_ID), goldenPriority,
  );
  await applyTaskComplete(env.DB, parseTaskCompleteMutation(goldenComplete, env.INSTANCE_ID), goldenComplete);
}

describe.sequential("task.reopen", () => {
  it("matches the shared contract, reopens exactly once, pulls the lifecycle change, and updates Web", async () => {
    expect(canonicalize(goldenReopen)).toBe(canonicalReopen.trim());
    expect(await computeCanonicalHash(goldenReopen)).toBe(goldenHash.trim());
    await applyGoldenChainThroughCompletion();

    const mutation = parseTaskReopenMutation(goldenReopen, env.INSTANCE_ID);
    const first = await applyTaskReopen(env.DB, mutation, goldenReopen, {
      now: () => new Date("2026-09-13T06:40:01.000Z"),
    });
    expect(first).toEqual(acceptedReceipt);
    expect(await applyTaskReopen(env.DB, mutation, goldenReopen)).toEqual(duplicateReceipt);
    expect(await env.DB.prepare(`
      SELECT title, workflow_status, priority, completion_state, completed_at, entity_version
      FROM tasks WHERE id = ?1
    `).bind(mutation.entityId).first()).toEqual({
      title: "Validate one renamed task",
      workflow_status: "next",
      priority: 1,
      completion_state: "open",
      completed_at: null,
      entity_version: 6,
    });
    const pull = await exports.default.fetch("https://personal-cloud.local/sync/changes?after=5&limit=1");
    expect(await pull.json()).toEqual(pulledReopen);
    const web = await exports.default.fetch("https://personal-cloud.local/v1/tasks", {
      headers: { "x-openza-test-session": "k5-local-read-only" },
    });
    expect(await web.json()).toMatchObject({
      tasks: [{ completionState: "open", completedAt: null, workflowStatus: "next", priority: 1 }],
    });
  });

  it("rolls back reopening, version, receipt, change, and sequence after an injected failure", async () => {
    const create = changed(goldenCreate, (value) => {
      value.deviceId = "device_reopen_rollback";
      value.mutationId = "mutation_reopen_rollback_create";
      value.entityId = "local_reopen_rollback";
      value.payload.task.id = value.entityId;
    });
    await applyTaskCreate(env.DB, parseTaskCreateMutation(create, env.INSTANCE_ID), create);
    const complete = changed(goldenComplete, (value) => {
      value.deviceId = "device_reopen_rollback";
      value.deviceSequence = 2;
      value.mutationId = "mutation_reopen_rollback_complete";
      value.entityId = "local_reopen_rollback";
      value.baseEntityVersion = 1;
    });
    await applyTaskComplete(env.DB, parseTaskCompleteMutation(complete, env.INSTANCE_ID), complete);
    const reopen = changed(goldenReopen, (value) => {
      value.deviceId = "device_reopen_rollback";
      value.deviceSequence = 3;
      value.mutationId = "mutation_reopen_rollback";
      value.entityId = "local_reopen_rollback";
      value.baseEntityVersion = 2;
    });
    const mutation = parseTaskReopenMutation(reopen, env.INSTANCE_ID);

    await expect(applyTaskReopen(env.DB, mutation, reopen, { failAfterTaskUpdate: true })).rejects.toThrow();
    expect(await env.DB.prepare(
      "SELECT completion_state, completed_at, entity_version FROM tasks WHERE id = ?1",
    ).bind(mutation.entityId).first()).toEqual({
      completion_state: "completed",
      completed_at: "2026-09-13T06:38:00.000Z",
      entity_version: 2,
    });
    expect(await applyTaskReopen(env.DB, mutation, reopen)).toMatchObject({
      outcome: "accepted", entityVersion: 3,
    });
  });

  it("rejects stale reopening and reopening an already-open task", async () => {
    const create = changed(goldenCreate, (value) => {
      value.deviceId = "device_reopen_conflict";
      value.mutationId = "mutation_reopen_conflict_create";
      value.entityId = "local_reopen_conflict";
      value.payload.task.id = value.entityId;
    });
    await post(create);
    const complete = changed(goldenComplete, (value) => {
      value.deviceId = "device_reopen_conflict";
      value.deviceSequence = 2;
      value.mutationId = "mutation_reopen_conflict_complete";
      value.entityId = "local_reopen_conflict";
      value.baseEntityVersion = 1;
    });
    await post(complete);
    const accepted = changed(goldenReopen, (value) => {
      value.deviceId = "device_reopen_conflict";
      value.deviceSequence = 3;
      value.mutationId = "mutation_reopen_accepted";
      value.entityId = "local_reopen_conflict";
      value.baseEntityVersion = 2;
    });
    expect((await post(accepted)).response.status).toBe(201);

    const stale = changed(accepted, (value) => {
      value.deviceSequence = 4;
      value.mutationId = "mutation_reopen_stale";
    });
    expect((await post(stale)).body).toMatchObject({ error: { code: "version_conflict" } });
    const again = changed(stale, (value) => {
      value.mutationId = "mutation_reopen_again";
      value.baseEntityVersion = 3;
    });
    expect((await post(again)).body).toMatchObject({ error: { code: "invalid_transition" } });
  });

  it.each([
    ["an extra field", changed(goldenReopen, (value) => { value.payload.completedAt = null; })],
    ["an invalid reopen timestamp", changed(goldenReopen, (value) => { value.payload.reopenedAt = "today"; })],
    ["a missing task", changed(goldenReopen, (value) => {
      value.deviceId = "device_reopen_missing";
      value.deviceSequence = 1;
      value.mutationId = "mutation_reopen_missing";
      value.entityId = "local_reopen_missing";
    })],
  ])("rejects %s without a reopening effect", async (_name, raw) => {
    const before = await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE operation = 'task.reopened'")
      .first();
    const result = await post(raw);
    expect(result.response.status).toBeGreaterThanOrEqual(400);
    expect(result.body).toMatchObject({ product: "tasks", error: { retryable: false } });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE operation = 'task.reopened'")
      .first()).toEqual(before);
  });
});
