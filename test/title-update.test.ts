import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  computeCanonicalHash,
  parseTaskCreateMutation,
  parseTaskUpdateTitleMutation,
} from "../src/protocol.ts";
import { applyTaskCreate } from "../src/task-create.ts";
import { applyTaskTitleUpdate } from "../src/task-title-update.ts";
import acceptedReceipt from "./fixtures/accepted-task-title-update-receipt.json";
import canonicalUpdate from "./fixtures/valid-task-title-update.canonical.json?raw";
import duplicateReceipt from "./fixtures/duplicate-task-title-update-receipt.json";
import goldenCreate from "./fixtures/valid-task-create.json?raw";
import goldenUpdate from "./fixtures/valid-task-title-update.json?raw";
import goldenHash from "./fixtures/valid-task-title-update.sha256?raw";
import pulledUpdate from "./fixtures/pulled-title-update-page.json";

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

describe.sequential("title-only task.updateOpenzaFields", () => {
  it("matches the shared contract, applies exactly once, pulls one update, and changes the read-only view", async () => {
    expect(canonicalize(goldenUpdate)).toBe(canonicalUpdate.trim());
    expect(await computeCanonicalHash(goldenUpdate)).toBe(goldenHash.trim());

    const create = parseTaskCreateMutation(goldenCreate, env.INSTANCE_ID);
    await applyTaskCreate(env.DB, create, goldenCreate, {
      now: () => new Date("2026-09-13T06:30:01.000Z"),
    });
    const update = parseTaskUpdateTitleMutation(goldenUpdate, env.INSTANCE_ID);
    const first = await applyTaskTitleUpdate(env.DB, update, goldenUpdate, {
      now: () => new Date("2026-09-13T06:32:01.000Z"),
    });
    expect(first).toEqual(acceptedReceipt);
    expect(await applyTaskTitleUpdate(env.DB, update, goldenUpdate)).toEqual(duplicateReceipt);

    const stored = await env.DB.prepare("SELECT title, entity_version FROM tasks WHERE id = ?1")
      .bind(update.entityId).first();
    expect(stored).toEqual({ title: "Validate one renamed task", entity_version: 2 });

    const pull = await exports.default.fetch("https://personal-cloud.local/sync/changes?after=1&limit=1");
    expect(await pull.json()).toEqual(pulledUpdate);

    const web = await exports.default.fetch("https://personal-cloud.local/v1/tasks", {
      headers: { "x-openza-test-session": "k5-local-read-only" },
    });
    expect(await web.json()).toMatchObject({
      freshness: "current",
      tasks: [{ id: update.entityId, title: "Validate one renamed task" }],
    });
  });

  it("rolls back title, version, receipt, change, and sequence when failure follows the task update", async () => {
    const rawCreate = changed(goldenCreate, (value) => {
      value.deviceId = "device_title_rollback";
      value.mutationId = "mutation_title_rollback_create";
      value.entityId = "local_title_rollback";
      value.payload.task.id = value.entityId;
    });
    await applyTaskCreate(env.DB, parseTaskCreateMutation(rawCreate, env.INSTANCE_ID), rawCreate);
    const rawUpdate = changed(goldenUpdate, (value) => {
      value.deviceId = "device_title_rollback";
      value.mutationId = "mutation_title_rollback_update";
      value.entityId = "local_title_rollback";
      value.payload.title = "Title after recovery";
    });
    const update = parseTaskUpdateTitleMutation(rawUpdate, env.INSTANCE_ID);

    await expect(applyTaskTitleUpdate(env.DB, update, rawUpdate, { failAfterTaskUpdate: true }))
      .rejects.toThrow();
    expect(await env.DB.prepare("SELECT title, entity_version FROM tasks WHERE id = ?1")
      .bind(update.entityId).first()).toEqual({ title: "Validate one task", entity_version: 1 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE mutation_id = ?1")
      .bind(update.mutationId).first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT last_sequence FROM device_sequences WHERE device_id = ?1")
      .bind(update.deviceId).first()).toEqual({ last_sequence: 1 });

    const recovered = await applyTaskTitleUpdate(env.DB, update, rawUpdate);
    expect(recovered).toMatchObject({ outcome: "accepted", entityVersion: 2 });
  });

  it("rejects a stale base version without changing the accepted task", async () => {
    const stale = changed(goldenUpdate, (value) => {
      value.mutationId = "mutation_title_stale";
      value.deviceSequence = 3;
      value.payload.title = "Must not overwrite";
    });
    const result = await post(stale);
    expect(result.response.status).toBe(409);
    expect(result.body).toMatchObject({ error: { code: "version_conflict", retryable: false } });
    expect(await env.DB.prepare("SELECT title, entity_version FROM tasks WHERE id = ?1")
      .bind("local_00000000000000000000000000000001").first())
      .toEqual({ title: "Validate one renamed task", entity_version: 2 });
  });

  it.each([
    ["an extra field", changed(goldenUpdate, (value) => { value.payload.workflowStatus = "next"; })],
    ["an oversized title", changed(goldenUpdate, (value) => { value.payload.title = "x".repeat(513); })],
    ["a missing task", changed(goldenUpdate, (value) => {
      value.deviceId = "device_title_missing";
      value.deviceSequence = 1;
      value.mutationId = "mutation_title_missing";
      value.entityId = "local_title_missing";
    })],
  ])("rejects %s without a title-update effect", async (_name, raw) => {
    const before = await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE operation = 'task.updatedOpenzaFields'")
      .first();
    const result = await post(raw);
    expect(result.response.status).toBeGreaterThanOrEqual(400);
    expect(result.body).toMatchObject({ product: "tasks", error: { retryable: false } });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE operation = 'task.updatedOpenzaFields'")
      .first()).toEqual(before);
  });
});
