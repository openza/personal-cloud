import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  computeCanonicalHash,
  parseTaskCompleteMutation,
  parseTaskCreateMutation,
  parseTaskReopenMutation,
  parseTaskUpdatePlannedAtMutation,
  parseTaskUpdatePlannedOnMutation,
  parseTaskUpdatePriorityMutation,
  parseTaskUpdateTitleMutation,
  parseTaskUpdateWorkflowStatusMutation,
} from "../src/protocol.ts";
import { applyTaskComplete } from "../src/task-complete.ts";
import { applyTaskCreate } from "../src/task-create.ts";
import { applyTaskReopen } from "../src/task-reopen.ts";
import { applyTaskOpenzaFieldsUpdate } from "../src/task-title-update.ts";
import goldenComplete from "./fixtures/valid-task-complete.json?raw";
import goldenCreate from "./fixtures/valid-task-create.json?raw";
import goldenPlannedAt from "./fixtures/valid-task-planned-at-update.json?raw";
import canonicalPlannedAt from "./fixtures/valid-task-planned-at-update.canonical.json?raw";
import hashPlannedAt from "./fixtures/valid-task-planned-at-update.sha256?raw";
import goldenPlannedOn from "./fixtures/valid-task-planned-on-update.json?raw";
import canonicalPlannedOn from "./fixtures/valid-task-planned-on-update.canonical.json?raw";
import hashPlannedOn from "./fixtures/valid-task-planned-on-update.sha256?raw";
import goldenPriority from "./fixtures/valid-task-priority-update.json?raw";
import goldenReopen from "./fixtures/valid-task-reopen.json?raw";
import goldenTitle from "./fixtures/valid-task-title-update.json?raw";
import goldenWorkflow from "./fixtures/valid-task-workflow-status-update.json?raw";
import pulledPlannedAt from "./fixtures/pulled-task-planned-at-update-page.json";
import pulledPlannedOn from "./fixtures/pulled-task-planned-on-update-page.json";

type MutableMutation = Record<string, any> & { payload: Record<string, any> };

function changed(json: string, change: (value: MutableMutation) => void): string {
  const value = JSON.parse(json) as MutableMutation;
  change(value);
  return JSON.stringify(value);
}

async function applyGoldenChainThroughReopen(): Promise<void> {
  await applyTaskCreate(env.DB, parseTaskCreateMutation(goldenCreate, env.INSTANCE_ID), goldenCreate);
  await applyTaskOpenzaFieldsUpdate(env.DB, parseTaskUpdateTitleMutation(goldenTitle, env.INSTANCE_ID), goldenTitle);
  await applyTaskOpenzaFieldsUpdate(env.DB, parseTaskUpdateWorkflowStatusMutation(goldenWorkflow, env.INSTANCE_ID), goldenWorkflow);
  await applyTaskOpenzaFieldsUpdate(env.DB, parseTaskUpdatePriorityMutation(goldenPriority, env.INSTANCE_ID), goldenPriority);
  await applyTaskComplete(env.DB, parseTaskCompleteMutation(goldenComplete, env.INSTANCE_ID), goldenComplete);
  await applyTaskReopen(env.DB, parseTaskReopenMutation(goldenReopen, env.INSTANCE_ID), goldenReopen);
}

describe.sequential("task planning fields", () => {
  it("stores a date without timezone conversion, then replaces it with a UTC instant", async () => {
    expect(canonicalize(goldenPlannedOn)).toBe(canonicalPlannedOn.trim());
    expect(await computeCanonicalHash(goldenPlannedOn)).toBe(hashPlannedOn.trim());
    expect(canonicalize(goldenPlannedAt)).toBe(canonicalPlannedAt.trim());
    expect(await computeCanonicalHash(goldenPlannedAt)).toBe(hashPlannedAt.trim());
    await applyGoldenChainThroughReopen();

    await applyTaskOpenzaFieldsUpdate(
      env.DB,
      parseTaskUpdatePlannedOnMutation(goldenPlannedOn, env.INSTANCE_ID),
      goldenPlannedOn,
      { now: () => new Date("2026-09-13T06:42:01.000Z") },
    );
    expect(await env.DB.prepare("SELECT planned_on, planned_at, entity_version FROM tasks LIMIT 1").first())
      .toEqual({ planned_on: "2026-09-20", planned_at: null, entity_version: 7 });
    expect(await (await exports.default.fetch(
      "https://personal-cloud.local/sync/changes?after=6&limit=1",
    )).json()).toEqual(pulledPlannedOn);

    await applyTaskOpenzaFieldsUpdate(
      env.DB,
      parseTaskUpdatePlannedAtMutation(goldenPlannedAt, env.INSTANCE_ID),
      goldenPlannedAt,
      { now: () => new Date("2026-09-13T06:44:01.000Z") },
    );
    expect(await env.DB.prepare("SELECT planned_on, planned_at, entity_version FROM tasks LIMIT 1").first())
      .toEqual({ planned_on: null, planned_at: "2026-09-20T04:00:00.000Z", entity_version: 8 });
    expect(await (await exports.default.fetch(
      "https://personal-cloud.local/sync/changes?after=7&limit=1",
    )).json()).toEqual(pulledPlannedAt);
    const web = await exports.default.fetch("https://personal-cloud.local/v1/tasks", {
      headers: { "x-openza-test-session": "k5-local-read-only" },
    });
    expect(await web.json()).toMatchObject({
      tasks: [{ plannedOn: null, plannedAt: "2026-09-20T04:00:00.000Z" }],
    });
  });

  it("rolls back the date field with its receipt and sequence", async () => {
    const create = changed(goldenCreate, (value) => {
      value.deviceId = "device_planning_rollback";
      value.mutationId = "mutation_planning_rollback_create";
      value.entityId = "local_planning_rollback";
      value.payload.task.id = value.entityId;
    });
    await applyTaskCreate(env.DB, parseTaskCreateMutation(create, env.INSTANCE_ID), create);
    const planned = changed(goldenPlannedOn, (value) => {
      value.deviceId = "device_planning_rollback";
      value.deviceSequence = 2;
      value.mutationId = "mutation_planning_rollback";
      value.entityId = "local_planning_rollback";
      value.baseEntityVersion = 1;
    });
    const mutation = parseTaskUpdatePlannedOnMutation(planned, env.INSTANCE_ID);
    await expect(applyTaskOpenzaFieldsUpdate(env.DB, mutation, planned, { failAfterTaskUpdate: true }))
      .rejects.toThrow();
    expect(await env.DB.prepare(
      "SELECT planned_on, planned_at, entity_version FROM tasks WHERE id = ?1",
    ).bind(mutation.entityId).first()).toEqual({ planned_on: null, planned_at: null, entity_version: 1 });
    expect(await applyTaskOpenzaFieldsUpdate(env.DB, mutation, planned))
      .toMatchObject({ outcome: "accepted", entityVersion: 2 });
  });

  it("rejects impossible dates, non-UTC exact times, and combined date fields", () => {
    const invalidDate = goldenPlannedOn.replace("2026-09-20", "2026-02-30");
    expect(() => parseTaskUpdatePlannedOnMutation(invalidDate, env.INSTANCE_ID)).toThrow();
    const offsetTime = goldenPlannedAt.replace("2026-09-20T04:00:00.000Z", "2026-09-20T09:30:00.000+05:30");
    expect(() => parseTaskUpdatePlannedAtMutation(offsetTime, env.INSTANCE_ID)).toThrow();
    const combined = goldenPlannedOn.replace(
      "\"plannedOn\": \"2026-09-20\"",
      "\"plannedOn\": \"2026-09-20\", \"plannedAt\": null",
    );
    expect(() => parseTaskUpdatePlannedOnMutation(combined, env.INSTANCE_ID)).toThrow();
  });
});
