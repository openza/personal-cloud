import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";

const taskId = "task.web.scheduled-times";
const targetSpaceId = "space.web.scheduled-times";
const createdAt = "2026-10-13T00:00:00.000Z";
const scheduledStart = "2026-10-13T09:00:00.000Z";
const scheduledEnd = "2026-10-13T10:30:00.000Z";
const deviceId = "web_scheduled_times";
let sequence = 0;

function mutation(operation: string, entityId: string, baseEntityVersion: number | null, payload: Record<string, unknown>) {
  sequence += 1;
  return {
    protocolVersion: 1,
    product: "tasks",
    instanceId: env.INSTANCE_ID,
    deviceId,
    mutationId: `mutation.web.scheduled-times.${sequence}`,
    deviceSequence: sequence,
    operation,
    entityId,
    baseEntityVersion,
    payload,
    clientCreatedAt: createdAt,
  };
}

async function post(value: ReturnType<typeof mutation>) {
  return exports.default.fetch("https://personal-cloud.local/v1/tasks/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

async function expectTask(fields: Record<string, unknown>) {
  const response = await exports.default.fetch("https://personal-cloud.local/v1/tasks", {
    headers: { "x-openza-test-session": env.K5_TEST_SESSION },
  });
  const body = await response.json() as { tasks: Record<string, unknown>[] };
  expect(response.status).toBe(200);
  expect(body.tasks.find(task => task.id === taskId)).toMatchObject({
    scheduledStart,
    scheduledEnd,
    ...fields,
  });
}

it("keeps both scheduled times through Web edits, a Space move, completion, and reopening", async () => {
  expect((await post(mutation("space.put", targetSpaceId, null, {
    space: {
      name: "Scheduled target",
      color: null,
      icon: null,
      sortOrder: 0,
      isArchived: false,
      createdAt,
    },
  }))).status).toBe(201);

  expect((await post(mutation("task.createRich", taskId, null, {
    task: {
      id: taskId,
      spaceId: "space_default",
      title: "Scheduled task",
      workflowStatus: "next",
      priority: 3,
      createdAt,
      notes: null,
      plannedOn: null,
      plannedAt: null,
      deadlineOn: null,
      deadlineAt: null,
      scheduledStart,
      scheduledEnd,
      durationMinutes: null,
      recurrenceRule: null,
      projectId: null,
      labels: [],
    },
  }))).status).toBe(201);
  await expectTask({ title: "Scheduled task", spaceId: "space_default", completionState: "open" });

  expect((await post(mutation("task.patch", taskId, 1, {
    fields: { title: "Edited scheduled task" },
  }))).status).toBe(201);
  await expectTask({ title: "Edited scheduled task", spaceId: "space_default", completionState: "open" });

  expect((await post(mutation("task.moveTree", taskId, 2, {
    spaceId: targetSpaceId,
    fields: {},
  }))).status).toBe(201);
  await expectTask({ title: "Edited scheduled task", spaceId: targetSpaceId, completionState: "open" });

  expect((await post(mutation("task.complete", taskId, 3, {
    completedAt: "2026-10-13T11:00:00.000Z",
  }))).status).toBe(201);
  await expectTask({ spaceId: targetSpaceId, completionState: "completed" });

  expect((await post(mutation("task.reopen", taskId, 4, {
    reopenedAt: "2026-10-13T11:10:00.000Z",
  }))).status).toBe(201);
  await expectTask({ spaceId: targetSpaceId, completionState: "open", completedAt: null });
});
