import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import sourceLinkedFixture from "./fixtures/valid-source-linked-task-create.json?raw";
import sourceLinkedCanonical from "./fixtures/valid-source-linked-task-create.canonical.json?raw";
import sourceLinkedHash from "./fixtures/valid-source-linked-task-create.sha256?raw";
import { canonicalize, computeCanonicalHash, parseTaskMutation } from "../src/protocol.ts";

const taskId="task.source.linked",deviceId="device.source.linked",at="2026-09-13T09:00:00.000Z";
const source={integrationKind:"todoist",externalIdHash:"a".repeat(64),sourceUrl:"https://todoist.com/showTask?id=opaque",
  title:"Source title",description:"Safe description",projectName:"Operations",priority:2,plannedOn:"2026-09-20",plannedAt:null,
  deadlineOn:null,deadlineAt:null,recurrenceRule:null,refreshedAt:at};
const create={protocolVersion:1,product:"tasks",instanceId:"",deviceId,mutationId:"mutation.source.create",deviceSequence:1,
  operation:"task.create",entityId:taskId,baseEntityVersion:null,
  payload:{task:{id:taskId,spaceId:"space_default",title:"Source title",completionState:"open",workflowStatus:"inbox",createdAt:at},source},clientCreatedAt:at};

async function post(value:unknown){return exports.default.fetch("https://personal-cloud.local/v1/tasks/mutations",{method:"POST",body:JSON.stringify(value)});}

it("shares a byte-stable source-linked Openza task contract with desktop",async()=>{
  const parsed=parseTaskMutation(sourceLinkedFixture, "instance_00000000000000000000000000000001") as any;
  expect(parsed.payload.source.integrationKind).toBe("todoist");
  expect(canonicalize(sourceLinkedFixture)).toBe(sourceLinkedCanonical.trim());
  expect(await computeCanonicalHash(sourceLinkedFixture)).toBe(sourceLinkedHash.trim());
});

it("stores a source-linked row as the same Openza task using only the safe descriptor",async()=>{
  create.instanceId=env.INSTANCE_ID;
  const response=await post(create);expect(response.status).toBe(201);
  const stored=await env.DB.prepare("SELECT integration_kind,external_id_hash,source_title FROM source_descriptors WHERE task_id=?1").bind(taskId).first();
  expect(stored).toEqual({integration_kind:"todoist",external_id_hash:"a".repeat(64),source_title:"Source title"});
  const read=await (await exports.default.fetch("https://personal-cloud.local/v1/tasks",{headers:{"x-openza-test-session":env.K5_TEST_SESSION}})).json() as any;
  const task=read.tasks.find((item:any)=>item.id===taskId);
  expect(task).toMatchObject({id:taskId,title:"Source title",source:{integrationKind:"todoist",title:"Source title"},externalCommand:null});

  const complete={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId,mutationId:"mutation.source.complete",deviceSequence:2,
    operation:"task.complete",entityId:taskId,baseEntityVersion:1,payload:{completedAt:"2026-09-13T09:01:00.000Z"},clientCreatedAt:at};
  expect((await post(complete)).status).toBe(201);
  const after=await (await exports.default.fetch("https://personal-cloud.local/v1/tasks",{headers:{"x-openza-test-session":env.K5_TEST_SESSION}})).json() as any;
  expect(after.tasks.find((item:any)=>item.id===taskId).externalCommand).toMatchObject({command:"complete",state:"pending_desktop"});
  const bootstrap=await (await exports.default.fetch("https://personal-cloud.local/sync/bootstrap")).json() as any;
  expect(bootstrap.snapshot.sourceDescriptors).toHaveLength(1);
  expect(JSON.stringify(bootstrap)).not.toContain("providerConnection");
});

it("rejects raw provider payloads and connection credentials",async()=>{
  const unsafe=structuredClone(create) as any;unsafe.mutationId="mutation.source.unsafe";unsafe.deviceId="device.source.unsafe";
  unsafe.payload.source.providerConnectionId="secret-connection";unsafe.payload.source.snapshotJson="raw-secret-token";
  const response=await post(unsafe);expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).not.toContain("raw-secret-token");
});

it("refreshes safe source facts and confirms a fake desktop provider write",async()=>{
  const localTaskId=`${taskId}.confirm`,localDeviceId=`${deviceId}.confirm`;
  const localCreate=structuredClone(create);localCreate.instanceId=env.INSTANCE_ID;localCreate.entityId=localTaskId;
  localCreate.payload.task.id=localTaskId;localCreate.deviceId=localDeviceId;localCreate.mutationId="mutation.source.create.confirm";
  const created=await post(localCreate);expect(created.status).toBe(201);
  const completed=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:localDeviceId,
    mutationId:"mutation.source.complete.confirm",deviceSequence:2,operation:"task.complete",entityId:localTaskId,
    baseEntityVersion:1,payload:{completedAt:"2026-09-13T09:01:00.000Z"},clientCreatedAt:at});
  const completionReceipt=await completed.json() as any;expect(completed.status).toBe(201);

  const refreshed={...source,title:"Refreshed provider title",description:"Fresh safe description",
    refreshedAt:"2026-09-13T09:02:00.000Z"};
  const refresh=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:"desktop.provider.a.confirm",
    mutationId:"mutation.source.refresh",deviceSequence:1,operation:"source.refreshSnapshot",entityId:localTaskId,
    baseEntityVersion:null,payload:{source:refreshed},clientCreatedAt:"2026-09-13T09:02:00.000Z"});
  expect(refresh.status).toBe(201);

  const confirmMutation={protocolVersion:1 as const,product:"tasks" as const,instanceId:env.INSTANCE_ID,deviceId:"desktop.provider.a.confirm",
    mutationId:"mutation.source.confirm",deviceSequence:2,operation:"externalCommand.confirm",entityId:localTaskId,
    baseEntityVersion:null,payload:{requestedChangeSeq:completionReceipt.changeSeq,
      resolvedAt:"2026-09-13T09:03:00.000Z",errorCode:null},clientCreatedAt:"2026-09-13T09:03:00.000Z"};
  const confirm=await post(confirmMutation);
  expect(confirm.status).toBe(201);
  const duplicateConfirm=await post(confirmMutation);expect(duplicateConfirm.status).toBe(200);
  expect((await duplicateConfirm.json() as any).outcome).toBe("duplicate");
  const read=await (await exports.default.fetch("https://personal-cloud.local/v1/tasks",{headers:{"x-openza-test-session":env.K5_TEST_SESSION}})).json() as any;
  expect(read.tasks.find((item:any)=>item.id===localTaskId)).toMatchObject({
    source:{title:"Refreshed provider title",description:"Fresh safe description"},
    externalCommand:{command:"complete",state:"confirmed",errorCode:null},
  });

  const stale=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:"desktop.provider.b.confirm",
    mutationId:"mutation.source.stale",deviceSequence:1,operation:"source.refreshSnapshot",entityId:localTaskId,
    baseEntityVersion:null,payload:{source},clientCreatedAt:"2026-09-13T09:04:00.000Z"});
  expect(stale.status).toBe(409);expect((await stale.json() as any).error.code).toBe("stale_snapshot");
});

it("keeps offline intent pending, coalesces complete to reopen, and rejects only the latest command",async()=>{
  const localTaskId=`${taskId}.offline`,localDeviceId=`${deviceId}.offline`;
  const localCreate=structuredClone(create);localCreate.instanceId=env.INSTANCE_ID;localCreate.entityId=localTaskId;
  localCreate.payload.task.id=localTaskId;localCreate.deviceId=localDeviceId;localCreate.mutationId="mutation.source.create.offline";
  expect((await post(localCreate)).status).toBe(201);
  const complete=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:localDeviceId,
    mutationId:"mutation.offline.complete",deviceSequence:2,operation:"task.complete",entityId:localTaskId,
    baseEntityVersion:1,payload:{completedAt:"2026-09-13T09:01:00.000Z"},clientCreatedAt:at});
  const completeReceipt=await complete.json() as any;
  let read=await (await exports.default.fetch("https://personal-cloud.local/v1/tasks",{headers:{"x-openza-test-session":env.K5_TEST_SESSION}})).json() as any;
  expect(read.tasks.find((item:any)=>item.id===localTaskId).externalCommand).toMatchObject({command:"complete",state:"pending_desktop"});

  const reopen=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:localDeviceId,
    mutationId:"mutation.offline.reopen",deviceSequence:3,operation:"task.reopen",entityId:localTaskId,
    baseEntityVersion:2,payload:{reopenedAt:"2026-09-13T09:02:00.000Z"},clientCreatedAt:"2026-09-13T09:02:00.000Z"});
  const reopenReceipt=await reopen.json() as any;
  read=await (await exports.default.fetch("https://personal-cloud.local/v1/tasks",{headers:{"x-openza-test-session":env.K5_TEST_SESSION}})).json() as any;
  expect(read.tasks.find((item:any)=>item.id===localTaskId).externalCommand).toMatchObject({command:"reopen",state:"pending_desktop"});

  const oldConfirm=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:"desktop.provider.a.offline",
    mutationId:"mutation.offline.old-confirm",deviceSequence:1,operation:"externalCommand.confirm",entityId:localTaskId,
    baseEntityVersion:null,payload:{requestedChangeSeq:completeReceipt.changeSeq,
      resolvedAt:"2026-09-13T09:03:00.000Z",errorCode:null},clientCreatedAt:"2026-09-13T09:03:00.000Z"});
  expect(oldConfirm.status).toBe(409);expect((await oldConfirm.json() as any).error.code).toBe("command_superseded");

  const rejected=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:"desktop.provider.b.offline",
    mutationId:"mutation.offline.reject",deviceSequence:1,operation:"externalCommand.reject",entityId:localTaskId,
    baseEntityVersion:null,payload:{requestedChangeSeq:reopenReceipt.changeSeq,
      resolvedAt:"2026-09-13T09:04:00.000Z",errorCode:"retry_exhausted"},clientCreatedAt:"2026-09-13T09:04:00.000Z"});
  expect(rejected.status).toBe(201);
  read=await (await exports.default.fetch("https://personal-cloud.local/v1/tasks",{headers:{"x-openza-test-session":env.K5_TEST_SESSION}})).json() as any;
  expect(read.tasks.find((item:any)=>item.id===localTaskId).externalCommand).toMatchObject({command:"reopen",state:"rejected",errorCode:"retry_exhausted"});
  const lateConfirm=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:"desktop.provider.c.offline",
    mutationId:"mutation.offline.late-confirm",deviceSequence:1,operation:"externalCommand.confirm",entityId:localTaskId,
    baseEntityVersion:null,payload:{requestedChangeSeq:reopenReceipt.changeSeq,
      resolvedAt:"2026-09-13T09:05:00.000Z",errorCode:null},clientCreatedAt:"2026-09-13T09:05:00.000Z"});
  expect(lateConfirm.status).toBe(409);expect((await lateConfirm.json() as any).error.code).toBe("invalid_transition");
});
