import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";

const taskId = "task.web.scheduled-times";
const targetSpaceId = "space.web.scheduled-times";
const sourceProjectId = "project.web.scheduled-times.source";
const targetProjectId = "project.web.scheduled-times.target";
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

function project(spaceId: string) {
  return {
    project: {
      spaceId,
      name: "Scheduled project",
      description: null,
      color: null,
      icon: null,
      parentId: null,
      sortOrder: 0,
      status: "active",
      isFavorite: false,
      createdAt,
    },
  };
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

  expect((await post(mutation("project.put", sourceProjectId, null, project("space_default")))).status).toBe(201);
  expect((await post(mutation("project.put", targetProjectId, null, project(targetSpaceId)))).status).toBe(201);

  expect((await post(mutation("task.createRich", taskId, null, {
    task: {
      id: taskId,
      spaceId: "space_default",
      title: "Scheduled task",
      workflowStatus: "next",
      priority: 3,
      createdAt,
      notes: null,
      plannedOn: "2026-10-14",
      plannedAt: null,
      deadlineOn: "2026-10-20",
      deadlineAt: null,
      scheduledStart,
      scheduledEnd,
      durationMinutes: null,
      recurrenceRule: null,
      projectId: null,
      labels: [],
    },
  }))).status).toBe(201);
  let entityVersion = 1;
  const patches = [
    [{ title: "Edited scheduled task" }, { title: "Edited scheduled task" }],
    [{ notes: "Edited notes" }, { notes: "Edited notes" }],
    [{ notes: null }, { notes: null }],
    [{ workflowStatus: "waiting" }, { workflowStatus: "waiting" }],
    [{ workflowStatus: "none" }, { workflowStatus: "none" }],
    [{ priority: 1 }, { priority: 1 }],
    [{ plannedOn: "2026-10-15" }, { plannedOn: "2026-10-15", plannedAt: null }],
    [{ deadlineOn: "2026-10-21" }, { deadlineOn: "2026-10-21", deadlineAt: null }],
    [{ projectId: sourceProjectId }, { projectId: sourceProjectId }],
    [{ plannedOn: null }, { plannedOn: null, plannedAt: null }],
    [{ deadlineOn: null }, { deadlineOn: null, deadlineAt: null }],
    [{ projectId: null }, { projectId: null }],
  ] as const;
  for (const [fields, expected] of patches) {
    expect((await post(mutation("task.patch", taskId, entityVersion, { fields }))).status).toBe(201);
    entityVersion++;
    await expectTask({ spaceId: "space_default", completionState: "open", ...expected });
  }

  const movedFields = {
    title: "Moved scheduled task",
    notes: "Updated while moving",
    workflowStatus: "next",
    priority: 2,
    plannedOn: "2026-11-01",
    deadlineOn: "2026-11-05",
    projectId: targetProjectId,
  };
  expect((await post(mutation("task.moveTree", taskId, entityVersion, {
    spaceId: targetSpaceId,
    fields: movedFields,
  }))).status).toBe(201);
  entityVersion++;
  await expectTask({ ...movedFields, spaceId: targetSpaceId, completionState: "open" });

  expect((await post(mutation("task.complete", taskId, entityVersion, {
    completedAt: "2026-10-13T11:00:00.000Z",
  }))).status).toBe(201);
  entityVersion++;
  await expectTask({ spaceId: targetSpaceId, completionState: "completed" });

  expect((await post(mutation("task.reopen", taskId, entityVersion, {
    reopenedAt: "2026-10-13T11:10:00.000Z",
  }))).status).toBe(201);
  entityVersion++;
  await expectTask({ spaceId: targetSpaceId, completionState: "open", completedAt: null });
});
