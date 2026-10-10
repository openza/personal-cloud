import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";

const taskId = "task.notes.deadline";
const timestamp = "2026-09-15T05:30:00.000Z";

function mutation(sequence: number, mutationId: string, baseEntityVersion: number | null, operation: string, payload: unknown) {
  return JSON.stringify({
    protocolVersion: 1, product: "tasks", instanceId: env.INSTANCE_ID,
    deviceId: "device.notes.deadline", mutationId, deviceSequence: sequence,
    operation, entityId: taskId, baseEntityVersion, payload, clientCreatedAt: timestamp,
  });
}

async function post(body: string) {
  return exports.default.fetch("https://personal-cloud.local/v1/tasks/mutations", { method: "POST", body });
}

it("stores notes and deadline updates and exposes them through read, pull, and bootstrap", async () => {
  expect((await post(mutation(1, "mutation.notes.create", null, "task.create", {
    task: { id: taskId, spaceId: "space_default", title: "Write release notes", completionState: "open", workflowStatus: "inbox", createdAt: timestamp },
  }))).status).toBe(201);
  expect((await post(mutation(2, "mutation.notes.update", 1, "task.updateOpenzaFields", {
    notes: "Include the migration and rollback notes.",
  }))).status).toBe(201);
  expect((await post(mutation(3, "mutation.deadline.update", 2, "task.updateOpenzaFields", {
    deadlineOn: "2026-09-22",
  }))).status).toBe(201);

  const read = await exports.default.fetch("https://personal-cloud.local/v1/tasks", {
    headers: { "x-openza-test-session": env.K5_TEST_SESSION },
  });
  expect((await read.json() as { tasks: unknown[] }).tasks).toContainEqual(expect.objectContaining({
    id: taskId, notes: "Include the migration and rollback notes.", deadlineOn: "2026-09-22", entityVersion: 3,
  }));

  const changes = await exports.default.fetch("https://personal-cloud.local/sync/changes?after=0&limit=50");
  const changeBody = await changes.json() as { changes: { entityId: string; payload: unknown }[] };
  expect(changeBody.changes.filter(change => change.entityId === taskId).map(change => change.payload)).toEqual([
    { task: { id: taskId, spaceId: "space_default", title: "Write release notes", completionState: "open", workflowStatus: "inbox", createdAt: timestamp } },
    { task: { id: taskId, notes: "Include the migration and rollback notes." } },
    { task: { id: taskId, deadlineOn: "2026-09-22" } },
  ]);

  const bootstrap = await exports.default.fetch("https://personal-cloud.local/sync/bootstrap");
  const snapshot = await bootstrap.json() as { snapshot: { tasks: unknown[] } };
  expect(snapshot.snapshot.tasks).toContainEqual(expect.objectContaining({
    id: taskId, notes: "Include the migration and rollback notes.", deadlineOn: "2026-09-22", entityVersion: 3,
  }));
});

it("rejects combining notes and deadline in one mutation", async () => {
  const response = await post(mutation(1, "mutation.notes.invalid", 1, "task.updateOpenzaFields", {
    notes: "Not atomic", deadlineOn: null,
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
});
