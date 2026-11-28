import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  computeCanonicalHash,
  parseTaskCompleteMutation,
  parseTaskCreateMutation,
  parseTaskDeleteMutation,
  parseTaskHistoricalCompletionImportMutation,
  parseExternalCommandCancelMutation,
  parseTaskReopenMutation,
  parseTaskProviderObservedReopenMutation,
  parseTaskUpdatePriorityMutation,
  parseTaskUpdateTitleMutation,
  parseTaskUpdateWorkflowStatusMutation,
} from "../src/protocol.ts";
import { applyTaskComplete } from "../src/task-complete.ts";
import { applyTaskCreate } from "../src/task-create.ts";
import { applyTaskDelete } from "../src/task-delete.ts";
import { applyTaskReopen } from "../src/task-reopen.ts";
import { applyTaskProviderObservedReopen } from "../src/task-provider-observed-reopen.ts";
import { applyExternalCommandCancel } from "../src/source-lifecycle.ts";
import { bootstrap } from "../src/bootstrap.ts";
import { applyTaskOpenzaFieldsUpdate } from "../src/task-title-update.ts";
import acceptedReceipt from "./fixtures/accepted-task-reopen-receipt.json";
import canonicalReopen from "./fixtures/valid-task-reopen.canonical.json?raw";
import duplicateReceipt from "./fixtures/duplicate-task-reopen-receipt.json";
import goldenComplete from "./fixtures/valid-task-complete.json?raw";
import goldenCreate from "./fixtures/valid-task-create.json?raw";
import goldenDelete from "./fixtures/valid-task-delete.json?raw";
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

async function createHistoricallyCompletedTask(deviceId: string, taskId: string, mutationPrefix: string): Promise<string> {
  await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic historical progression','desktop',1,1,'2026-11-27T12:00:00.000Z')")
    .bind(deviceId).run();
  const create = JSON.parse(goldenCreate) as MutableMutation;
  Object.assign(create, { deviceId, mutationId: `${mutationPrefix}_create`, deviceSequence: 1, entityId: taskId,
    clientCreatedAt: "2026-11-27T12:00:00.000Z" });
  Object.assign(create.payload.task, { id: taskId, title: "Synthetic historical progression", createdAt: "2026-11-20T12:00:00.000Z" });
  const createRaw = JSON.stringify(create);
  await applyTaskCreate(env.DB, parseTaskCreateMutation(createRaw, env.INSTANCE_ID), createRaw);

  const completedAt = "2026-11-26T12:00:00.000Z";
  const historical = { protocolVersion: 1, product: "tasks", instanceId: env.INSTANCE_ID, deviceId,
    mutationId: `${mutationPrefix}_historical`, deviceSequence: 2, operation: "task.createHistoricalCompletion",
    entityId: taskId, baseEntityVersion: 1, payload: { completedAt }, clientCreatedAt: "2026-11-27T12:00:01.000Z" };
  const historicalRaw = JSON.stringify(historical);
  await applyTaskCreate(env.DB, parseTaskHistoricalCompletionImportMutation(historicalRaw, env.INSTANCE_ID), historicalRaw);
  const repeated = { ...historical, mutationId: `${mutationPrefix}_reimport`, deviceSequence: 3,
    clientCreatedAt: "2026-11-27T12:00:02.000Z" };
  const repeatedRaw = JSON.stringify(repeated);
  await applyTaskCreate(env.DB, parseTaskHistoricalCompletionImportMutation(repeatedRaw, env.INSTANCE_ID), repeatedRaw);
  return completedAt;
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

  it("applies provider-observed reopen idempotently without creating a provider command", async () => {
    const deviceId = "device_provider_observed_reopen";
    const taskId = "local_provider_observed_reopen";
    await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic provider reopen','desktop',1,0,'2026-11-27T12:00:00.000Z')")
      .bind(deviceId).run();
    const create = JSON.parse(goldenCreate) as MutableMutation;
    Object.assign(create,{deviceId,mutationId:"mutation_provider_observed_create",deviceSequence:1,entityId:taskId,clientCreatedAt:"2026-11-27T12:00:00.000Z"});
    Object.assign(create.payload.task,{id:taskId,title:"Synthetic linked task",createdAt:"2026-11-27T12:00:00.000Z"});
    const createRaw = JSON.stringify(create);
    await applyTaskCreate(env.DB,parseTaskCreateMutation(createRaw,env.INSTANCE_ID),createRaw);
    const complete = JSON.parse(goldenComplete) as MutableMutation;
    Object.assign(complete,{deviceId,mutationId:"mutation_provider_observed_complete",deviceSequence:2,entityId:taskId,baseEntityVersion:1,clientCreatedAt:"2026-11-27T12:00:01.000Z"});
    complete.payload.completedAt = "2026-11-27T12:00:01.000Z";
    const completeRaw = JSON.stringify(complete);
    const completion = await applyTaskComplete(env.DB,parseTaskCompleteMutation(completeRaw,env.INSTANCE_ID),completeRaw);
    const task = await env.DB.prepare("SELECT id,entity_version FROM tasks WHERE id=?1").bind(taskId).first<{id:string;entity_version:number}>();
    await env.DB.prepare("UPDATE tasks SET title='Synthetic renamed task',entity_version=entity_version+1 WHERE id=?1").bind(taskId).run();
    await env.DB.prepare("INSERT INTO source_descriptors(task_id,integration_kind,external_id_hash,source_title,refreshed_at) VALUES(?1,'todoist',?2,'Synthetic linked task','2026-11-27T12:00:00.000Z')")
      .bind(taskId,"a".repeat(64)).run();
    await env.DB.prepare("INSERT INTO external_commands(task_id,command,state,requested_change_seq,updated_at,error_code) VALUES(?1,'complete','confirmed',?2,'2026-11-27T12:00:00.000Z',NULL)")
      .bind(taskId,completion.changeSeq).run();
    const mutation = {protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId,mutationId:"mutation_provider_observed_reopen",deviceSequence:3,operation:"task.providerObservedReopen",entityId:taskId,baseEntityVersion:task!.entity_version,payload:{observedAt:"2026-11-27T12:00:02.000Z"},clientCreatedAt:"2026-11-27T12:00:02.000Z"};
    const raw = JSON.stringify(mutation);
    const parsed = parseTaskProviderObservedReopenMutation(raw,env.INSTANCE_ID);
    const commandCount = await env.DB.prepare("SELECT count(*) AS count FROM external_commands WHERE task_id=?1").bind(taskId).first<{count:number}>();
    const accepted = await applyTaskProviderObservedReopen(env.DB,parsed,raw,{now:()=>new Date("2026-11-27T12:00:03.000Z")});
    expect(await applyTaskProviderObservedReopen(env.DB,parsed,raw)).toMatchObject({outcome:"duplicate"});
    expect(await env.DB.prepare("SELECT completion_state,completed_at FROM tasks WHERE id=?1").bind(taskId).first())
      .toEqual({completion_state:"open",completed_at:null});
    expect(await env.DB.prepare("SELECT title,entity_version FROM tasks WHERE id=?1").bind(taskId).first())
      .toEqual({title:"Synthetic renamed task",entity_version:4});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE operation='task.reopened' AND entity_id=?1").bind(taskId).first())
      .toEqual({count:1});
    const feed = await exports.default.fetch(`https://personal-cloud.local/sync/changes?after=${accepted.changeSeq-1}&limit=1`);
    expect((await feed.json() as any).changes[0]).toMatchObject({operation:"task.reopened",entityId:taskId});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM external_commands WHERE task_id=?1").bind(taskId).first())
      .toEqual(commandCount);
    const snapshot = await bootstrap(env.DB,true) as {snapshot:{tasks:Array<{id:string;completionState:string;completedAt:string|null}>}};
    expect(snapshot.snapshot.tasks.find(value=>value.id===taskId)).toMatchObject({completionState:"open",completedAt:null});

    const alreadyOpen = {...mutation,mutationId:"mutation_provider_observed_already_open",deviceSequence:4,baseEntityVersion:accepted.entityVersion};
    const alreadyOpenRaw = JSON.stringify(alreadyOpen);
    const alreadyOpenReceipt = await applyTaskProviderObservedReopen(env.DB,parseTaskProviderObservedReopenMutation(alreadyOpenRaw,env.INSTANCE_ID),alreadyOpenRaw);
    expect(alreadyOpenReceipt).toMatchObject({outcome:"accepted",entityVersion:accepted.entityVersion+1,changeSeq:accepted.changeSeq+1});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE operation='task.reopened' AND entity_id=?1").bind(taskId).first()).toEqual({count:2});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM external_commands WHERE task_id=?1").bind(taskId).first()).toEqual(commandCount);

    const laterComplete = JSON.parse(JSON.stringify(complete)) as MutableMutation;
    Object.assign(laterComplete,{mutationId:"mutation_provider_observed_later_complete",deviceSequence:5,baseEntityVersion:alreadyOpenReceipt.entityVersion});
    laterComplete.payload.completedAt = "2026-11-27T12:00:05.000Z";
    const laterCompleteRaw = JSON.stringify(laterComplete);
    await applyTaskComplete(env.DB,parseTaskCompleteMutation(laterCompleteRaw,env.INSTANCE_ID),laterCompleteRaw);
    const boundaryObservation = {...alreadyOpen,mutationId:"mutation_provider_observed_equal_boundary",deviceSequence:6,
      payload:{observedAt:"2026-11-27T12:00:05.000Z"}};
    const boundaryRaw = JSON.stringify(boundaryObservation);
    await applyTaskProviderObservedReopen(env.DB,parseTaskProviderObservedReopenMutation(boundaryRaw,env.INSTANCE_ID),boundaryRaw);
    const delayedObservation = {...alreadyOpen,mutationId:"mutation_provider_observed_delayed",deviceSequence:7,
      payload:{observedAt:"2026-11-27T12:00:04.000Z"}};
    const delayedRaw = JSON.stringify(delayedObservation);
    await applyTaskProviderObservedReopen(env.DB,parseTaskProviderObservedReopenMutation(delayedRaw,env.INSTANCE_ID),delayedRaw);
    expect(await env.DB.prepare("SELECT completion_state,completed_at FROM tasks WHERE id=?1").bind(taskId).first())
      .toEqual({completion_state:"completed",completed_at:"2026-11-27T12:00:05.000Z"});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE operation='task.reopened' AND entity_id=?1").bind(taskId).first()).toEqual({count:2});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE operation='task.completed' AND entity_id=?1").bind(taskId).first()).toEqual({count:4});
    expect(await env.DB.prepare("SELECT entity_version FROM tasks WHERE id=?1").bind(taskId).first()).toEqual({entity_version:8});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM external_commands WHERE task_id=?1 AND command='reopen'").bind(taskId).first())
      .toEqual({count:0});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM external_commands WHERE task_id=?1").bind(taskId).first())
      .toEqual(commandCount);
  });

  it("imports completed history without a live provider command", async () => {
    const deviceId = "device_historical_completion_import";
    const taskId = "local_historical_completion_import";
    await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic historical import','desktop',1,1,'2026-11-27T12:00:00.000Z')")
      .bind(deviceId).run();
    const completedAt = "2026-11-26T12:00:00.000Z";
    const mutation = {
      protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId,
      mutationId:"mutation_historical_completion_import",deviceSequence:1,
      operation:"task.createHistoricalCompletion",entityId:taskId,baseEntityVersion:null,
      payload:{task:{id:taskId,spaceId:"space_default",title:"Synthetic completed history",workflowStatus:"inbox",
        createdAt:"2026-11-20T12:00:00.000Z",completedAt},
        source:{integrationKind:"todoist",externalIdHash:"b".repeat(64),sourceUrl:null,title:"Synthetic completed history",
          description:null,projectName:null,priority:null,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,
          recurrenceRule:null,refreshedAt:"2026-11-27T12:00:00.000Z"}},
      clientCreatedAt:"2026-11-27T12:00:00.000Z",
    };
    const raw=JSON.stringify(mutation);
    const receipt=await applyTaskCreate(env.DB,parseTaskHistoricalCompletionImportMutation(raw,env.INSTANCE_ID),raw);
    expect(await env.DB.prepare("SELECT completion_state,completed_at FROM tasks WHERE id=?1").bind(taskId).first())
      .toEqual({completion_state:"completed",completed_at:completedAt});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM external_commands WHERE task_id=?1").bind(taskId).first())
      .toEqual({count:0});
    const change=await exports.default.fetch(`https://personal-cloud.local/sync/changes?after=${receipt.changeSeq-1}&limit=1&workspace=1`);
    const pulled=await change.json() as any;
    expect(pulled.changes[0]).toMatchObject({operation:"workspace.changed",entityId:taskId,
      payload:{tasks:[{id:taskId,completionState:"completed",completedAt}]}});
    const snapshot=await bootstrap(env.DB,true) as {snapshot:{tasks:Array<{id:string;completionState:string;completedAt:string|null;updatedAt:string}>;externalCommands:Array<{taskId:string;state:string}>}};
    const snapshotTask=snapshot.snapshot.tasks.find(task=>task.id===taskId)!;
    expect(snapshotTask).toMatchObject({completionState:"completed",completedAt});
    expect(pulled.changes[0].payload.tasks[0].updatedAt).toBe(snapshotTask.updatedAt);
    expect(snapshot.snapshot.externalCommands.find(command=>command.taskId===taskId)).toBeUndefined();
  });

  it("applies historical completion to an existing open task through the supported workspace feed", async () => {
    const deviceId="device_historical_completion_update";
    const taskId="local_historical_completion_update";
    await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic historical update','desktop',1,1,'2026-11-27T12:00:00.000Z')")
      .bind(deviceId).run();
    const create=JSON.parse(goldenCreate) as MutableMutation;
    Object.assign(create,{deviceId,mutationId:"mutation_historical_update_create",deviceSequence:1,entityId:taskId,clientCreatedAt:"2026-11-27T12:00:00.000Z"});
    Object.assign(create.payload.task,{id:taskId,title:"Synthetic rich historical completion",createdAt:"2026-11-20T12:00:00.000Z"});
    const createRaw=JSON.stringify(create);
    await applyTaskCreate(env.DB,parseTaskCreateMutation(createRaw,env.INSTANCE_ID),createRaw);
    const completedAt="2026-11-26T12:00:00.000Z";
    const mutation={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId,mutationId:"mutation_historical_update_complete",
      deviceSequence:2,operation:"task.createHistoricalCompletion",entityId:taskId,baseEntityVersion:1,
      payload:{completedAt},clientCreatedAt:"2026-11-27T12:00:01.000Z"};
    const raw=JSON.stringify(mutation);
    const parsed=parseTaskHistoricalCompletionImportMutation(raw,env.INSTANCE_ID);
    const receipt=await applyTaskCreate(env.DB,parsed,raw);
    expect(await env.DB.prepare("SELECT completion_state,completed_at,entity_version FROM tasks WHERE id=?1").bind(taskId).first())
      .toEqual({completion_state:"completed",completed_at:completedAt,entity_version:2});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM external_commands WHERE task_id=?1").bind(taskId).first()).toEqual({count:0});
    const feed=await exports.default.fetch(`https://personal-cloud.local/sync/changes?after=${receipt.changeSeq-1}&limit=1&workspace=1`);
    const pulled=await feed.json() as any;
    expect(pulled.changes[0]).toMatchObject({operation:"workspace.changed",entityId:taskId,
      payload:{tasks:[{id:taskId,completionState:"completed",completedAt}]}});
    const snapshot=await bootstrap(env.DB,true) as {snapshot:{tasks:Array<{id:string;completionState:string;completedAt:string|null;updatedAt:string}>}};
    const snapshotTask=snapshot.snapshot.tasks.find(task=>task.id===taskId)!;
    expect(snapshotTask).toMatchObject({completionState:"completed",completedAt});
    expect(pulled.changes[0].payload.tasks[0].updatedAt).toBe(snapshotTask.updatedAt);

    const repeated={...mutation,mutationId:"mutation_historical_update_already_completed",deviceSequence:3,
      clientCreatedAt:"2026-11-27T12:00:02.000Z"};
    const repeatedRaw=JSON.stringify(repeated);
    const repeatedReceipt=await applyTaskCreate(env.DB,parseTaskHistoricalCompletionImportMutation(repeatedRaw,env.INSTANCE_ID),repeatedRaw);
    const repeatedFeed=await exports.default.fetch(`https://personal-cloud.local/sync/changes?after=${repeatedReceipt.changeSeq-1}&limit=1&workspace=1`);
    const repeatedChange=(await repeatedFeed.json() as any).changes[0];
    const repeatedSnapshot=await bootstrap(env.DB,true) as {snapshot:{tasks:Array<{id:string;updatedAt:string}>}};
    expect(repeatedChange.payload.tasks[0].updatedAt).toBe(repeatedSnapshot.snapshot.tasks.find(task=>task.id===taskId)!.updatedAt);
  });

  it("does not consume the entity version on a same-timestamp historical reimport", async () => {
    for (const action of ["edit", "reopen", "delete"] as const) {
      const suffix = `${action}_${crypto.randomUUID()}`;
      const deviceId = `device_historical_noop_${suffix}`;
      const taskId = `local_historical_noop_${suffix}`;
      const completedAt = await createHistoricallyCompletedTask(deviceId, taskId, suffix);
      const template = action === "edit" ? goldenTitle : action === "reopen" ? goldenReopen : goldenDelete;
      const mutation = JSON.parse(template) as MutableMutation;
      Object.assign(mutation, { deviceId, mutationId: `${suffix}_after_reimport`, deviceSequence: 4, entityId: taskId,
        baseEntityVersion: 2, clientCreatedAt: "2026-11-27T12:00:03.000Z" });
      if (action === "edit") mutation.payload.title = "Edited after historical reimport";
      if (action === "reopen") mutation.payload.reopenedAt = "2026-11-27T12:00:03.000Z";
      if (action === "delete") mutation.payload.deletedAt = "2026-11-27T12:00:03.000Z";
      const raw = JSON.stringify(mutation);
      if (action === "edit")
        await applyTaskOpenzaFieldsUpdate(env.DB, parseTaskUpdateTitleMutation(raw, env.INSTANCE_ID), raw);
      else if (action === "reopen")
        await applyTaskReopen(env.DB, parseTaskReopenMutation(raw, env.INSTANCE_ID), raw);
      else
        await applyTaskDelete(env.DB, parseTaskDeleteMutation(raw, env.INSTANCE_ID), raw);

      const state = await env.DB.prepare("SELECT title,completion_state,completed_at,deleted_at,entity_version FROM tasks WHERE id=?1")
        .bind(taskId).first<{ title: string; completion_state: string; completed_at: string | null; deleted_at: string | null; entity_version: number }>();
      expect(state?.entity_version).toBe(3);
      if (action === "edit") expect(state).toMatchObject({ title: "Edited after historical reimport", completion_state: "completed", completed_at: completedAt });
      if (action === "reopen") expect(state).toMatchObject({ completion_state: "open", completed_at: null });
      if (action === "delete") expect(state?.deleted_at).toBe("2026-11-27T12:00:03.000Z");
    }
  });

  it("still rejects a same-timestamp historical reimport if a concurrent delete wins", async () => {
    const suffix = crypto.randomUUID();
    const deviceId = `device_historical_noop_delete_${suffix}`;
    const taskId = `local_historical_noop_delete_${suffix}`;
    const completedAt = await createHistoricallyCompletedTask(deviceId, taskId, `noop_delete_${suffix}`);
    const deleteDeviceId = `device_historical_noop_delete_winner_${suffix}`;
    await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic concurrent delete','desktop',1,1,'2026-11-27T12:00:00.000Z')")
      .bind(deleteDeviceId).run();
    const deletion = JSON.parse(goldenDelete) as MutableMutation;
    Object.assign(deletion, { deviceId: deleteDeviceId, mutationId: `noop_delete_winner_${suffix}`, deviceSequence: 1,
      entityId: taskId, baseEntityVersion: 2, clientCreatedAt: "2026-11-27T12:00:03.000Z" });
    deletion.payload.deletedAt = "2026-11-27T12:00:03.000Z";
    const deleteRaw = JSON.stringify(deletion);
    const mutation = { protocolVersion: 1, product: "tasks", instanceId: env.INSTANCE_ID, deviceId,
      mutationId: `noop_delete_loser_${suffix}`, deviceSequence: 4, operation: "task.createHistoricalCompletion",
      entityId: taskId, baseEntityVersion: 2, payload: { completedAt }, clientCreatedAt: "2026-11-27T12:00:03.000Z" };
    const raw = JSON.stringify(mutation);
    await expect(applyTaskCreate(env.DB, parseTaskHistoricalCompletionImportMutation(raw, env.INSTANCE_ID), raw, {
      beforeHistoricalCompletionBatch: async () => {
        await applyTaskDelete(env.DB, parseTaskDeleteMutation(deleteRaw, env.INSTANCE_ID), deleteRaw);
      },
    })).rejects.toMatchObject({ code: "entity_not_found" });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM mutation_receipts WHERE mutation_id=?1").bind(mutation.mutationId).first())
      .toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT count(*) AS count FROM mutation_receipts WHERE mutation_id=?1").bind(deletion.mutationId).first())
      .toEqual({ count: 1 });
  });

  it("rejects historical completion when a concurrent task edit wins after the read", async () => {
    const deviceId=`device_historical_completion_race_${crypto.randomUUID()}`;
    const taskId=`local_historical_completion_race_${deviceId}`;
    await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic history race','desktop',1,1,'2026-11-27T12:00:00.000Z')")
      .bind(deviceId).run();
    const create=JSON.parse(goldenCreate) as MutableMutation;
    Object.assign(create,{deviceId,mutationId:`${deviceId}_create`,deviceSequence:1,entityId:taskId,clientCreatedAt:"2026-11-27T12:00:00.000Z"});
    Object.assign(create.payload.task,{id:taskId,title:"Synthetic before concurrent edit",createdAt:"2026-11-20T12:00:00.000Z"});
    const createRaw=JSON.stringify(create);
    await applyTaskCreate(env.DB,parseTaskCreateMutation(createRaw,env.INSTANCE_ID),createRaw);
    const mutation={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId,mutationId:`${deviceId}_complete`,
      deviceSequence:2,operation:"task.createHistoricalCompletion",entityId:taskId,baseEntityVersion:1,
      payload:{completedAt:"2026-11-26T12:00:00.000Z"},clientCreatedAt:"2026-11-27T12:00:01.000Z"};
    const raw=JSON.stringify(mutation);
    await expect(applyTaskCreate(env.DB,parseTaskHistoricalCompletionImportMutation(raw,env.INSTANCE_ID),raw,{
      beforeHistoricalCompletionBatch:async()=>{
        await env.DB.prepare("UPDATE tasks SET title='Synthetic concurrent edit',entity_version=2 WHERE id=?1").bind(taskId).run();
      },
    })).rejects.toMatchObject({code:"version_conflict"});
    expect(await env.DB.prepare("SELECT title,completion_state,entity_version FROM tasks WHERE id=?1").bind(taskId).first())
      .toEqual({title:"Synthetic concurrent edit",completion_state:"open",entity_version:2});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM mutation_receipts WHERE mutation_id=?1").bind(mutation.mutationId).first())
      .toEqual({count:0});
    expect(await env.DB.prepare("SELECT last_sequence FROM device_sequences WHERE device_id=?1").bind(deviceId).first())
      .toEqual({last_sequence:1});
  });

  it("does not accept historical completion after a concurrent delete claims the prior version", async () => {
    const deviceId=`device_historical_completion_delete_race_${crypto.randomUUID()}`;
    const taskId=`local_historical_completion_delete_race_${deviceId}`;
    await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic history delete race','desktop',1,1,'2026-11-27T12:00:00.000Z')")
      .bind(deviceId).run();
    const create=JSON.parse(goldenCreate) as MutableMutation;
    Object.assign(create,{deviceId,mutationId:`${deviceId}_create`,deviceSequence:1,entityId:taskId,clientCreatedAt:"2026-11-27T12:00:00.000Z"});
    Object.assign(create.payload.task,{id:taskId,title:"Synthetic before concurrent delete",createdAt:"2026-11-20T12:00:00.000Z"});
    const createRaw=JSON.stringify(create);
    await applyTaskCreate(env.DB,parseTaskCreateMutation(createRaw,env.INSTANCE_ID),createRaw);
    const mutation={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId,mutationId:`${deviceId}_complete`,
      deviceSequence:2,operation:"task.createHistoricalCompletion",entityId:taskId,baseEntityVersion:1,
      payload:{completedAt:"2026-11-26T12:00:00.000Z"},clientCreatedAt:"2026-11-27T12:00:01.000Z"};
    const raw=JSON.stringify(mutation);
    await expect(applyTaskCreate(env.DB,parseTaskHistoricalCompletionImportMutation(raw,env.INSTANCE_ID),raw,{
      beforeHistoricalCompletionBatch:async()=>{
        const deletion={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:`${deviceId}_delete`,
          mutationId:`${deviceId}_delete`,deviceSequence:1,operation:"task.delete",entityId:taskId,baseEntityVersion:1,
          payload:{deletedAt:"2026-11-27T12:00:02.000Z"},clientCreatedAt:"2026-11-27T12:00:02.000Z"};
        const deleteRaw=JSON.stringify(deletion);
        await applyTaskDelete(env.DB,parseTaskDeleteMutation(deleteRaw,env.INSTANCE_ID),deleteRaw);
      },
    })).rejects.toMatchObject({code:"entity_not_found"});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM changes WHERE mutation_id=?1").bind(mutation.mutationId).first())
      .toEqual({count:0});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM mutation_receipts WHERE mutation_id=?1").bind(mutation.mutationId).first())
      .toEqual({count:0});
    expect(await env.DB.prepare("SELECT last_sequence FROM device_sequences WHERE device_id=?1").bind(deviceId).first())
      .toEqual({last_sequence:1});
  });

  it("cancels only the matching command sequence without creating a delivery claim", async () => {
    const deviceId="device_external_command_cancel";
    const taskId="local_external_command_cancel";
    await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic command cancellation','desktop',1,1,'2026-11-27T12:00:00.000Z')")
      .bind(deviceId).run();
    const create=JSON.parse(goldenCreate) as MutableMutation;
    Object.assign(create,{deviceId,mutationId:"mutation_cancel_create",deviceSequence:1,entityId:taskId,clientCreatedAt:"2026-11-27T12:00:00.000Z"});
    Object.assign(create.payload.task,{id:taskId,title:"Synthetic pending provider command",createdAt:"2026-11-27T12:00:00.000Z"});
    const createRaw=JSON.stringify(create);
    await applyTaskCreate(env.DB,parseTaskCreateMutation(createRaw,env.INSTANCE_ID),createRaw);
    await env.DB.prepare(`INSERT INTO source_descriptors(task_id,integration_kind,external_id_hash,source_title,refreshed_at)
      VALUES(?1,'todoist',?2,'Synthetic pending provider command','2026-11-27T12:00:00.000Z')`).bind(taskId,"c".repeat(64)).run();
    const complete=JSON.parse(goldenComplete) as MutableMutation;
    Object.assign(complete,{deviceId,mutationId:"mutation_cancel_complete",deviceSequence:2,entityId:taskId,baseEntityVersion:1,clientCreatedAt:"2026-11-27T12:00:01.000Z"});
    complete.payload.completedAt="2026-11-27T12:00:01.000Z";
    const completeRaw=JSON.stringify(complete);
    const completion=await applyTaskComplete(env.DB,parseTaskCompleteMutation(completeRaw,env.INSTANCE_ID),completeRaw);
    const cancel={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId,mutationId:"mutation_cancel_provider_command",
      deviceSequence:3,operation:"externalCommand.cancel",entityId:taskId,baseEntityVersion:null,
      payload:{requestedChangeSeq:completion.changeSeq,reason:"initial_seed"},clientCreatedAt:"2026-11-27T12:00:02.000Z"};
    const staleRaw=JSON.stringify({...cancel,mutationId:"mutation_cancel_stale_sequence",payload:{...cancel.payload,requestedChangeSeq:completion.changeSeq-1}});
    await expect(applyExternalCommandCancel(env.DB,parseExternalCommandCancelMutation(staleRaw,env.INSTANCE_ID),staleRaw))
      .rejects.toMatchObject({code:"command_superseded"});
    const raw=JSON.stringify(cancel);
    const parsed=parseExternalCommandCancelMutation(raw,env.INSTANCE_ID);
    const cancelled=await applyExternalCommandCancel(env.DB,parsed,raw,()=>new Date("2026-11-27T12:00:03.000Z"));
    expect(await applyExternalCommandCancel(env.DB,parsed,raw)).toMatchObject({outcome:"duplicate"});
    expect(await env.DB.prepare("SELECT state,requested_change_seq,error_code FROM external_commands WHERE task_id=?1").bind(taskId).first())
      .toEqual({state:"cancelled",requested_change_seq:completion.changeSeq,error_code:"initial_seed"});
    expect(await env.DB.prepare("SELECT count(*) AS count FROM provider_delivery_claims WHERE task_id=?1").bind(taskId).first())
      .toEqual({count:0});
    const feed=await exports.default.fetch(`https://personal-cloud.local/sync/changes?after=${cancelled.changeSeq-1}&limit=1&workspace=1`);
    const pulled=(await feed.json() as any).changes[0];
    expect(pulled).toMatchObject({operation:"workspace.changed",entityId:taskId,
      payload:{tasks:[{id:taskId,completionState:"completed"}]}});
    const snapshot=await bootstrap(env.DB,true) as {snapshot:{tasks:Array<{id:string;updatedAt:string}>;externalCommands:Array<{taskId:string;state:string;requestedChangeSeq:number}>}};
    expect(pulled.payload.tasks[0].updatedAt).toBe(snapshot.snapshot.tasks.find(task=>task.id===taskId)!.updatedAt);
    expect(snapshot.snapshot.externalCommands.find(command=>command.taskId===taskId)).toMatchObject({state:"cancelled",requestedChangeSeq:completion.changeSeq});
  });
});
