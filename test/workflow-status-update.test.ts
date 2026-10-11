import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  computeCanonicalHash,
  parseTaskCreateMutation,
  parseTaskUpdateTitleMutation,
  parseTaskUpdateWorkflowStatusMutation,
} from "../src/protocol.ts";
import { applyTaskCreate } from "../src/task-create.ts";
import { applyTaskOpenzaFieldsUpdate } from "../src/task-title-update.ts";
import acceptedReceipt from "./fixtures/accepted-task-workflow-status-update-receipt.json";
import canonicalUpdate from "./fixtures/valid-task-workflow-status-update.canonical.json?raw";
import duplicateReceipt from "./fixtures/duplicate-task-workflow-status-update-receipt.json";
import goldenCreate from "./fixtures/valid-task-create.json?raw";
import goldenTitleUpdate from "./fixtures/valid-task-title-update.json?raw";
import goldenUpdate from "./fixtures/valid-task-workflow-status-update.json?raw";
import goldenHash from "./fixtures/valid-task-workflow-status-update.sha256?raw";
import pulledUpdate from "./fixtures/pulled-workflow-status-update-page.json";

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

describe.sequential("workflow-status task.updateOpenzaFields", () => {
  it("matches the shared contract, applies exactly once, pulls one update, and changes the read-only view", async () => {
    expect(canonicalize(goldenUpdate)).toBe(canonicalUpdate.trim());
    expect(await computeCanonicalHash(goldenUpdate)).toBe(goldenHash.trim());

    const create = parseTaskCreateMutation(goldenCreate, env.INSTANCE_ID);
    await applyTaskCreate(env.DB, create, goldenCreate, {
      now: () => new Date("2026-09-13T06:30:01.000Z"),
    });
    const title = parseTaskUpdateTitleMutation(goldenTitleUpdate, env.INSTANCE_ID);
    await applyTaskOpenzaFieldsUpdate(env.DB, title, goldenTitleUpdate, {
      now: () => new Date("2026-09-13T06:32:01.000Z"),
    });
    const update = parseTaskUpdateWorkflowStatusMutation(goldenUpdate, env.INSTANCE_ID);
    const first = await applyTaskOpenzaFieldsUpdate(env.DB, update, goldenUpdate, {
      now: () => new Date("2026-09-13T06:34:01.000Z"),
    });
    expect(first).toEqual(acceptedReceipt);
    expect(await applyTaskOpenzaFieldsUpdate(env.DB, update, goldenUpdate)).toEqual(duplicateReceipt);

    expect(await env.DB.prepare("SELECT title, workflow_status, entity_version FROM tasks WHERE id = ?1")
      .bind(update.entityId).first()).toEqual({
        title: "Validate one renamed task",
        workflow_status: "next",
        entity_version: 3,
      });
    const pull = await exports.default.fetch("https://personal-cloud.local/sync/changes?after=2&limit=1");
    expect(await pull.json()).toEqual(pulledUpdate);

    const web = await exports.default.fetch("https://personal-cloud.local/v1/tasks", {
      headers: { "x-openza-test-session": "k5-local-read-only" },
    });
    expect(await web.json()).toMatchObject({
      freshness: "current",
      tasks: [{ id: update.entityId, title: "Validate one renamed task", workflowStatus: "next" }],
    });
  });

  it("rolls back status, version, receipt, change, and sequence when failure follows the task update", async () => {
    const rawCreate = changed(goldenCreate, (value) => {
      value.deviceId = "device_status_rollback";
      value.mutationId = "mutation_status_rollback_create";
      value.entityId = "local_status_rollback";
      value.payload.task.id = value.entityId;
    });
    await applyTaskCreate(env.DB, parseTaskCreateMutation(rawCreate, env.INSTANCE_ID), rawCreate);
    const rawUpdate = changed(goldenUpdate, (value) => {
      value.deviceId = "device_status_rollback";
      value.deviceSequence = 2;
      value.mutationId = "mutation_status_rollback_update";
      value.entityId = "local_status_rollback";
      value.baseEntityVersion = 1;
      value.payload.workflowStatus = "waiting";
    });
    const update = parseTaskUpdateWorkflowStatusMutation(rawUpdate, env.INSTANCE_ID);

    await expect(applyTaskOpenzaFieldsUpdate(env.DB, update, rawUpdate, { failAfterTaskUpdate: true }))
      .rejects.toThrow();
    expect(await env.DB.prepare("SELECT workflow_status, entity_version FROM tasks WHERE id = ?1")
      .bind(update.entityId).first()).toEqual({ workflow_status: "inbox", entity_version: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE mutation_id = ?1")
      .bind(update.mutationId).first()).toEqual({ count: 0 });

    const recovered = await applyTaskOpenzaFieldsUpdate(env.DB, update, rawUpdate);
    expect(recovered).toMatchObject({ outcome: "accepted", entityVersion: 2 });
  });

  it("rejects a stale base version without changing the accepted workflow status", async () => {
    const rawCreate = changed(goldenCreate, (value) => {
      value.deviceId = "device_status_stale";
      value.mutationId = "mutation_status_stale_create";
      value.entityId = "local_status_stale";
      value.payload.task.id = value.entityId;
    });
    await post(rawCreate);
    const accepted = changed(goldenUpdate, (value) => {
      value.deviceId = "device_status_stale";
      value.deviceSequence = 2;
      value.mutationId = "mutation_status_stale_accepted";
      value.entityId = "local_status_stale";
      value.baseEntityVersion = 1;
      value.payload.workflowStatus = "next";
    });
    expect((await post(accepted)).response.status).toBe(201);
    const stale = changed(accepted, (value) => {
      value.deviceSequence = 3;
      value.mutationId = "mutation_status_stale_rejected";
      value.payload.workflowStatus = "waiting";
    });
    const result = await post(stale);
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "version_conflict", retryable: false } });
    expect(await env.DB.prepare("SELECT workflow_status, entity_version FROM tasks WHERE id = ?1")
      .bind("local_status_stale").first()).toEqual({ workflow_status: "next", entity_version: 2 });
  });

  it.each(["none", "inbox", "next", "waiting", "someday"])(
    "accepts the supported %s workflow value at the contract boundary",
    (workflowStatus) => {
      const raw = changed(goldenUpdate, (value) => { value.payload.workflowStatus = workflowStatus; });
      expect(parseTaskUpdateWorkflowStatusMutation(raw, env.INSTANCE_ID).payload.workflowStatus)
        .toBe(workflowStatus);
    },
  );

  it.each([
    ["two fields together", changed(goldenUpdate, (value) => { value.payload.title = "Not combined"; })],
    ["a completion state", changed(goldenUpdate, (value) => { value.payload.workflowStatus = "completed"; })],
    ["a missing task", changed(goldenUpdate, (value) => {
      value.deviceId = "device_status_missing";
      value.deviceSequence = 1;
      value.mutationId = "mutation_status_missing";
      value.entityId = "local_status_missing";
    })],
  ])("rejects %s without a workflow-status effect", async (_name, raw) => {
    const before = await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE payload_json LIKE '%workflowStatus%'")
      .first();
    const result = await post(raw);
    expect(result.response.status).toBeGreaterThanOrEqual(400);
    expect(result.body).toMatchObject({ product: "tasks", error: { retryable: false } });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE payload_json LIKE '%workflowStatus%'")
      .first()).toEqual(before);
  });
});
