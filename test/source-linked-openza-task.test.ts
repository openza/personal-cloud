import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import sourceLinkedFixture from "./fixtures/valid-source-linked-task-create.json?raw";
import sourceLinkedCanonical from "./fixtures/valid-source-linked-task-create.canonical.json?raw";
import sourceLinkedHash from "./fixtures/valid-source-linked-task-create.sha256?raw";
import { canonicalize, computeCanonicalHash, parseTaskMutation } from "../src/protocol.ts";
import {applySourceRefresh} from "../src/source-lifecycle.ts";
import {compact} from "../src/bootstrap.ts";

const taskId="task.source.linked",deviceId="device.source.linked",at="2026-09-13T09:00:00.000Z";
const source={integrationKind:"todoist",externalIdHash:"a".repeat(64),sourceUrl:"https://todoist.com/showTask?id=opaque",
  title:"Source title",description:"Safe description",projectName:"Operations",priority:2,plannedOn:"2026-09-20",plannedAt:null,
  deadlineOn:null,deadlineAt:null,recurrenceRule:null,refreshedAt:at};
const create={protocolVersion:1,product:"tasks",instanceId:"",deviceId,mutationId:"mutation.source.create",deviceSequence:1,
  operation:"task.create",entityId:taskId,baseEntityVersion:null,
  payload:{task:{id:taskId,spaceId:"space_default",title:"Source title",completionState:"open",workflowStatus:"inbox",createdAt:at},source},clientCreatedAt:at};

async function post(value:unknown){return exports.default.fetch("https://personal-cloud.local/v1/tasks/mutations",{method:"POST",body:JSON.stringify(value)});}
function afterSourceRead(hook:()=>Promise<void>,afterTaskRead=false):D1Database{
  let injected=false;
  return new Proxy(env.DB,{get(target,key){
    if(key!=="prepare"){const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}
    return(sql:string)=>{
      const statement=target.prepare(sql);if(!sql.includes(afterTaskRead?"SELECT entity_version,deleted_at FROM tasks":"SELECT integration_kind,external_id_hash,refreshed_at"))return statement;
      return new Proxy(statement,{get(stmt,method){
        if(method!=="bind"){const value=Reflect.get(stmt,method);return typeof value==="function"?value.bind(stmt):value;}
        return(...values:any[])=>new Proxy(stmt.bind(...values),{get(bound,call){
          if(call==="first")return async()=>{const old=await bound.first();if(!injected){injected=true;await hook();}return old;};
          const value=Reflect.get(bound,call);return typeof value==="function"?value.bind(bound):value;
        }});
      }});
    };
  }}) as D1Database;
}
async function delivery(taskId:string,requestedChangeSeq:number,deviceId:string){
  await env.DB.prepare(`INSERT OR IGNORE INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at)
    VALUES(?1,'Fake provider desktop','desktop',1,1,?2)`).bind(deviceId,at).run();
  const claimId=`claim.${taskId}`;
  const binding=await env.DB.prepare("SELECT integration_kind,external_id_hash FROM source_descriptors WHERE task_id=?1").bind(taskId).first<{integration_kind:string;external_id_hash:string}>();
  const body={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId,claimId,taskId,requestedChangeSeq,integrationKind:binding!.integration_kind,externalIdHash:binding!.external_id_hash};
  const headers={"x-openza-test-device":deviceId};
  const claimed=await exports.default.fetch("https://personal-cloud.local/v1/provider/commands/claim",{method:"POST",headers,body:JSON.stringify(body)});expect(claimed.status).toBe(200);
  const started=await exports.default.fetch("https://personal-cloud.local/v1/provider/commands/start",{method:"POST",headers,body:JSON.stringify({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId,claimId})});expect(started.status).toBe(200);
  return claimId;
}

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
  localCreate.payload.source.externalIdHash="d".repeat(64);
  const created=await post(localCreate);expect(created.status).toBe(201);
  const completed=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:localDeviceId,
    mutationId:"mutation.source.complete.confirm",deviceSequence:2,operation:"task.complete",entityId:localTaskId,
    baseEntityVersion:1,payload:{completedAt:"2026-09-13T09:01:00.000Z"},clientCreatedAt:at});
  const completionReceipt=await completed.json() as any;expect(completed.status).toBe(201);

  const refreshed={...localCreate.payload.source,title:"Refreshed provider title",description:"Fresh safe description",
    refreshedAt:"2026-09-13T09:02:00.000Z"};
  const refresh=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:"desktop.provider.a.confirm",
    mutationId:"mutation.source.refresh",deviceSequence:1,operation:"source.refreshSnapshot",entityId:localTaskId,
    baseEntityVersion:null,payload:{source:refreshed},clientCreatedAt:"2026-09-13T09:02:00.000Z"});
  expect(refresh.status).toBe(201);

  const claimId=await delivery(localTaskId,completionReceipt.changeSeq,"desktop.provider.a.confirm");
  const confirmMutation={protocolVersion:1 as const,product:"tasks" as const,instanceId:env.INSTANCE_ID,deviceId:"desktop.provider.a.confirm",
    mutationId:"mutation.source.confirm",deviceSequence:2,operation:"externalCommand.confirm",entityId:localTaskId,
    baseEntityVersion:null,payload:{claimId,requestedChangeSeq:completionReceipt.changeSeq,
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
    baseEntityVersion:null,payload:{source:localCreate.payload.source},clientCreatedAt:"2026-09-13T09:04:00.000Z"});
  expect(stale.status).toBe(201);expect((await stale.json() as any).outcome).toBe("accepted");
});

it("acknowledges stale and equal source snapshots durably without changing current facts or blocking later edits",async()=>{
  const id=crypto.randomUUID(),localCreate=structuredClone(create);localCreate.instanceId=env.INSTANCE_ID;
  localCreate.entityId=`task.${id}`;localCreate.payload.task.id=localCreate.entityId;localCreate.deviceId=`device.${id}`;localCreate.mutationId=`create.${id}`;
  expect((await post(localCreate)).status).toBe(201);
  const newer={...source,title:"Newest source",refreshedAt:"2026-10-11T06:00:00.000Z"};
  const refresh={...localCreate,deviceId:`device.other.${id}`,mutationId:`refresh.new.${id}`,operation:"source.refreshSnapshot",baseEntityVersion:null,payload:{source:newer}};
  expect((await post(refresh)).status).toBe(201);
  const stale={...refresh,deviceId:localCreate.deviceId,deviceSequence:2,mutationId:`refresh.old.${id}`,payload:{source}};
  const response=await post(stale),receipt=await response.json() as any;expect(response.status).toBe(201);expect(receipt.entityVersion).toBe(1);
  const replay=await post(stale);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({outcome:"duplicate",changeSeq:receipt.changeSeq});
  const feed=await env.DB.prepare("SELECT payload_json FROM changes WHERE mutation_id=?1").bind(stale.mutationId).first<{payload_json:string}>();
  expect(JSON.parse(feed!.payload_json)).toMatchObject({task:{source:newer}});
  expect((await post({...localCreate,deviceSequence:3,mutationId:`notes.${id}`,operation:"task.updateOpenzaFields",baseEntityVersion:1,payload:{notes:"User intent preserved"}})).status).toBe(201);
  const equal={...refresh,deviceId:`device.equal.${id}`,mutationId:`refresh.equal.${id}`};expect((await post(equal)).status).toBe(201);
  expect(await env.DB.prepare("SELECT notes,entity_version FROM tasks WHERE id=?1").bind(localCreate.entityId).first()).toEqual({notes:"User intent preserved",entity_version:2});
  const mismatch={...equal,deviceId:`device.wrong.${id}`,mutationId:`refresh.wrong.${id}`,payload:{source:{...newer,externalIdHash:"c".repeat(64)}}};
  expect((await post(mismatch)).status).toBe(409);
  expect(await env.DB.prepare("SELECT last_sequence FROM device_sequences WHERE device_id=?1").bind(mismatch.deviceId).first()).toBeNull();
});

it("reads the authoritative source and task version inside the acceptance transaction after a concurrent refresh",async()=>{
  const id=crypto.randomUUID(),localCreate=structuredClone(create);localCreate.instanceId=env.INSTANCE_ID;localCreate.entityId=`task.${id}`;
  localCreate.payload.task.id=localCreate.entityId;localCreate.deviceId=`device.${id}`;localCreate.mutationId=`create.${id}`;expect((await post(localCreate)).status).toBe(201);
  const refreshed={...source,title:"Older queued source",refreshedAt:"2026-10-11T06:00:00.000Z"};
  const refresh={...localCreate,deviceSequence:2,mutationId:`refresh.raced.${id}`,operation:"source.refreshSnapshot",baseEntityVersion:null,payload:{source:refreshed}};
  const db=afterSourceRead(async()=>{
      expect((await post({...refresh,deviceId:`device.newer.${id}`,deviceSequence:1,mutationId:`newer.${id}`,payload:{source:{...refreshed,title:"Newer raced source",refreshedAt:"2026-10-11T07:00:00.000Z"}}})).status).toBe(201);
      expect((await post({...localCreate,deviceId:`device.editor.${id}`,deviceSequence:1,mutationId:`notes.race.${id}`,operation:"task.updateOpenzaFields",baseEntityVersion:1,payload:{notes:"Concurrent user edit"}})).status).toBe(201);
  });
  const receipt=await applySourceRefresh(db,refresh as any,JSON.stringify(refresh));expect(receipt.entityVersion).toBe(2);
  const feed=await env.DB.prepare("SELECT payload_json FROM changes WHERE mutation_id=?1").bind(refresh.mutationId).first<{payload_json:string}>();
  expect(JSON.parse(feed!.payload_json)).toMatchObject({task:{source:{title:"Newer raced source",refreshedAt:"2026-10-11T07:00:00.000Z"}}});
  expect(await env.DB.prepare("SELECT notes,entity_version FROM tasks WHERE id=?1").bind(localCreate.entityId).first()).toEqual({notes:"Concurrent user edit",entity_version:2});
});

it("acknowledges queued, raced, and compacted deleted source facts without resurrection or sequence blockage",async()=>{
  for(const raced of["queued","afterTaskRead","afterSourceRead"])for(const purged of[false,true]){
    const id=crypto.randomUUID(),localCreate=structuredClone(create);localCreate.instanceId=env.INSTANCE_ID;localCreate.entityId=`task.${id}`;
    localCreate.payload.task.id=localCreate.entityId;localCreate.deviceId=`device.${id}`;localCreate.mutationId=`create.${id}`;expect((await post(localCreate)).status).toBe(201);
    const deleteTask=async()=>{
      expect((await post({...localCreate,deviceId:`web.delete.${id}`,deviceSequence:1,mutationId:`delete.${id}`,operation:"task.delete",baseEntityVersion:1,payload:{deletedAt:at}})).status).toBe(201);
      if(purged){
        await env.DB.prepare(`INSERT INTO device_checkpoints(instance_id,product,device_id,last_change_seq,updated_at)
          SELECT ?1,'tasks',device_id,(SELECT next_change_seq FROM cloud_state WHERE singleton=1),?2 FROM device_sequences WHERE 1
          ON CONFLICT(instance_id,product,device_id) DO UPDATE SET last_change_seq=excluded.last_change_seq,updated_at=excluded.updated_at`).bind(env.INSTANCE_ID,at).run();
        expect((await compact(env.DB,"2030-01-01T00:00:00.000Z")).purgedEntityIds).toContain(localCreate.entityId);
      }
    };
    if(raced==="queued")await deleteTask();
    const refresh={...localCreate,deviceSequence:2,mutationId:`refresh.deleted.${id}`,operation:"source.refreshSnapshot",baseEntityVersion:null,
      payload:{source:{...source,title:"Must not resurrect",refreshedAt:"2026-10-11T06:00:00.000Z"}}};
    const receipt=await applySourceRefresh(raced!=="queued"?afterSourceRead(deleteTask,raced==="afterTaskRead"):env.DB,refresh as any,JSON.stringify(refresh));
    expect(receipt.entityVersion).toBe(2);expect(receipt.outcome).toBe("accepted");
    const replay=await post(refresh);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({outcome:"duplicate",changeSeq:receipt.changeSeq});
    const feed=await env.DB.prepare("SELECT operation,payload_json FROM changes WHERE mutation_id=?1").bind(refresh.mutationId).first<{operation:string,payload_json:string}>();
    expect(feed!.operation).toBe("task.deleted");expect(JSON.parse(feed!.payload_json)).toEqual({task:{id:localCreate.entityId,deletedAt:at}});
    const stored=await env.DB.prepare("SELECT title,deleted_at,entity_version FROM tasks WHERE id=?1").bind(localCreate.entityId).first();
    expect(stored).toEqual(purged?null:{title:"Source title",deleted_at:at,entity_version:2});
    if(!purged)expect(await env.DB.prepare("SELECT source_title FROM source_descriptors WHERE task_id=?1").bind(localCreate.entityId).first()).toEqual({source_title:"Source title"});
    const next=structuredClone(localCreate);next.deviceSequence=3;next.entityId=`task.after.${id}`;next.payload.task.id=next.entityId;next.mutationId=`create.after.${id}`;
    expect((await post(next)).status).toBe(201);
    const wrong={...refresh,deviceId:`device.wrong.deleted.${id}`,deviceSequence:1,mutationId:`wrong.deleted.${id}`,payload:{source:{...source,externalIdHash:"c".repeat(64)}}};
    expect((await(await post(wrong)).json() as any).error.code).toBe("source_identity_conflict");
    const unknown={...wrong,entityId:`task.never.${id}`,mutationId:`unknown.deleted.${id}`};
    expect((await(await post(unknown)).json() as any).error.code).toBe("entity_not_found");
    expect(await env.DB.prepare("SELECT last_sequence FROM device_sequences WHERE device_id=?1").bind(wrong.deviceId).first()).toBeNull();
  }
});

it("keeps offline intent pending, coalesces complete to reopen, and rejects only the latest command",async()=>{
  const localTaskId=`${taskId}.offline`,localDeviceId=`${deviceId}.offline`;
  const localCreate=structuredClone(create);localCreate.instanceId=env.INSTANCE_ID;localCreate.entityId=localTaskId;
  localCreate.payload.task.id=localTaskId;localCreate.deviceId=localDeviceId;localCreate.mutationId="mutation.source.create.offline";
  localCreate.payload.source.externalIdHash="e".repeat(64);
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

  const claimId=await delivery(localTaskId,reopenReceipt.changeSeq,"desktop.provider.b.offline");
  const oldConfirm=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:"desktop.provider.b.offline",
    mutationId:"mutation.offline.old-confirm",deviceSequence:1,operation:"externalCommand.confirm",entityId:localTaskId,
    baseEntityVersion:null,payload:{claimId,requestedChangeSeq:completeReceipt.changeSeq,
      resolvedAt:"2026-09-13T09:03:00.000Z",errorCode:null},clientCreatedAt:"2026-09-13T09:03:00.000Z"});
  expect(oldConfirm.status).toBe(409);expect((await oldConfirm.json() as any).error.code).toBe("command_superseded");

  const rejected=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:"desktop.provider.b.offline",
    mutationId:"mutation.offline.reject",deviceSequence:1,operation:"externalCommand.reject",entityId:localTaskId,
    baseEntityVersion:null,payload:{claimId,requestedChangeSeq:reopenReceipt.changeSeq,
      resolvedAt:"2026-09-13T09:04:00.000Z",errorCode:"retry_exhausted"},clientCreatedAt:"2026-09-13T09:04:00.000Z"});
  expect(rejected.status).toBe(201);
  read=await (await exports.default.fetch("https://personal-cloud.local/v1/tasks",{headers:{"x-openza-test-session":env.K5_TEST_SESSION}})).json() as any;
  expect(read.tasks.find((item:any)=>item.id===localTaskId).externalCommand).toMatchObject({command:"reopen",state:"rejected",errorCode:"retry_exhausted"});
  const lateConfirm=await post({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:"desktop.provider.b.offline",
    mutationId:"mutation.offline.late-confirm",deviceSequence:2,operation:"externalCommand.confirm",entityId:localTaskId,
    baseEntityVersion:null,payload:{claimId,requestedChangeSeq:reopenReceipt.changeSeq,
      resolvedAt:"2026-09-13T09:05:00.000Z",errorCode:null},clientCreatedAt:"2026-09-13T09:05:00.000Z"});
  expect(lateConfirm.status).toBe(409);expect((await lateConfirm.json() as any).error.code).toBe("invalid_transition");
});
