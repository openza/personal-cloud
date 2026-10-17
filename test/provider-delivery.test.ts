import { env } from "cloudflare:workers";
import { expect,it } from "vitest";
import worker,{type Env} from "../src/index.ts";
import { hash as tokenHash } from "../src/auth.ts";
import { claimDelivery,startDelivery,reconcileDelivery,retryDelivery,parseDeliveryRequest } from "../src/provider-delivery.ts";
import {parseExternalCommandResultMutation} from "../src/protocol.ts";
import claimFixture from "./fixtures/provider-delivery-claim-request.json?raw";
import startFixture from "./fixtures/provider-delivery-start-request.json?raw";
import confirmFixture from "./fixtures/valid-external-command-confirm.json?raw";
import { applyExternalCommandResult } from "../src/source-lifecycle.ts";
const at="2026-10-11T06:00:00.000Z";
it("shares explicit language-neutral claim/start/owned-result fixtures with Desktop",()=>{
  const instance="instance_00000000000000000000000000000001",device="device_00000000000000000000000000000001";
  const claim=parseDeliveryRequest(claimFixture,instance,device,true);
  expect(parseDeliveryRequest(startFixture,instance,device,false).claimId).toBe(claim.claimId);
  const confirm=parseExternalCommandResultMutation(confirmFixture,instance);
  expect(confirm.payload.claimId).toBe(claim.claimId);expect(confirm.payload.requestedChangeSeq).toBe(claim.requestedChangeSeq);
  const unowned=JSON.parse(confirmFixture);delete unowned.payload.claimId;
  expect(()=>parseExternalCommandResultMutation(JSON.stringify(unowned),instance)).toThrow();
});

async function fixture(integrationKind="todoist"){
  const id=crypto.randomUUID().replaceAll("-",""),taskId=`task.${id}`,a=`device.a.${id}`,b=`device.b.${id}`;
  const hash=id.repeat(2);
  for(const deviceId of[a,b])await env.DB.prepare(`INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at)
    VALUES(?1,'Fake desktop','desktop',1,1,?2)`).bind(deviceId,at).run();
  const source={integrationKind,externalIdHash:hash,sourceUrl:null,title:"Synthetic provider task",description:null,projectName:null,priority:null,
    plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,recurrenceRule:null,refreshedAt:at};
  const envelope={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:a,mutationId:`create.${id}`,deviceSequence:1,
    operation:"task.create",entityId:taskId,baseEntityVersion:null,payload:{task:{id:taskId,spaceId:"space_default",title:"Synthetic",completionState:"open",workflowStatus:"inbox",createdAt:at},source},clientCreatedAt:at};
  expect((await post(envelope)).status).toBe(201);
  const complete={...envelope,mutationId:`complete.${id}`,deviceSequence:2,operation:"task.complete",baseEntityVersion:1,payload:{completedAt:at}};
  const receipt=await(await post(complete)).json() as any;
  const request={claimId:`claim.${id}`,taskId,deviceId:a,requestedChangeSeq:receipt.changeSeq,integrationKind,externalIdHash:hash} as any;
  return {id,taskId,a,b,request,envelope};
}
function post(body:unknown){return worker.fetch(new Request("https://personal-cloud.local/v1/tasks/mutations",{method:"POST",body:JSON.stringify(body)}),env as unknown as Env);}
async function alias(f:Awaited<ReturnType<typeof fixture>>){
  const id=crypto.randomUUID().replaceAll("-",""),taskId=`alias.${id}`,deviceId=`web.alias.${id}`;
  const create={...f.envelope,entityId:taskId,deviceId,mutationId:`alias.create.${id}`,
    payload:{...f.envelope.payload,task:{...f.envelope.payload.task,id:taskId}}};
  // Preserve pre-existing cross-device aliases in this delivery-safety fixture.
  // New source creation rejects foreign ownership; historical ambiguity must
  // still block delivery without merging or losing either task.
  expect((await post({...create,payload:{task:create.payload.task}})).status).toBe(201);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO source_descriptors SELECT ?1,integration_kind,external_id_hash,source_url,source_title,source_description,source_project_name,source_priority,source_planned_on,source_planned_at,source_deadline_on,source_deadline_at,recurrence_rule,refreshed_at FROM source_descriptors WHERE task_id=?2').bind(taskId,f.taskId),
    env.DB.prepare('UPDATE tasks SET source_owner_device_id=?1 WHERE id=?2').bind(deviceId,taskId),
  ]);
  const response=await post({...create,deviceSequence:2,mutationId:`alias.complete.${id}`,operation:"task.complete",baseEntityVersion:1,payload:{completedAt:at}});
  expect(response.status).toBe(201);const receipt=await response.json() as any;
  return{create,request:{...f.request,taskId,claimId:`alias.claim.${id}`,requestedChangeSeq:receipt.changeSeq}};
}
it("blocks claims for ambiguous physical sources without merging or consuming either task",async()=>{
  const f=await fixture(),other=await alias(f);
  for(const request of[f.request,other.request])await expect(claimDelivery(env.DB,request)).rejects.toMatchObject({code:"source_identity_conflict"});
  expect((await env.DB.prepare("SELECT count(*) AS n FROM provider_delivery_claims WHERE integration_kind=?1 AND external_id_hash=?2")
    .bind(f.request.integrationKind,f.request.externalIdHash).first<{n:number}>())!.n).toBe(0);
  expect((await env.DB.prepare("SELECT count(*) AS n FROM tasks WHERE id IN (?1,?2) AND deleted_at IS NULL").bind(f.taskId,other.request.taskId).first<{n:number}>())!.n).toBe(2);
});
it("atomically stops an already reserved delivery if an alias appears before start",async()=>{
  const f=await fixture();await claimDelivery(env.DB,f.request);const other=await alias(f);
  await expect(startDelivery(env.DB,f.request.claimId,f.a)).rejects.toMatchObject({code:"source_identity_conflict"});
  expect((await env.DB.prepare("SELECT state FROM provider_delivery_claims WHERE claim_id=?1").bind(f.request.claimId).first())!.state).toBe("cancelled");
  expect((await post({...other.create,deviceSequence:3,mutationId:`alias.delete.${f.id}`,operation:"task.delete",baseEntityVersion:2,payload:{deletedAt:at}})).status).toBe(201);
  const next={...f.request,claimId:`unambiguous.${f.id}`};expect((await claimDelivery(env.DB,next)).state).toBe("reserved");
  expect((await startDelivery(env.DB,next.claimId,f.a)).state).toBe("started");
});
it("keeps a deleted started source locked against replacement aliases until its owned result",async()=>{
  const f=await fixture();await claimDelivery(env.DB,f.request);await startDelivery(env.DB,f.request.claimId,f.a);
  const other=await alias(f);
  expect((await post({...f.envelope,deviceId:`web.delete.${f.id}`,mutationId:`delete.${f.id}`,operation:"task.delete",baseEntityVersion:2,payload:{deletedAt:at}})).status).toBe(201);
  await expect(claimDelivery(env.DB,other.request)).rejects.toMatchObject({code:"delivery_busy"});
  const body=result(f);expect((await applyExternalCommandResult(env.DB,body,JSON.stringify(body))).outcome).toBe("accepted");
  expect((await claimDelivery(env.DB,other.request)).state).toBe("reserved");
});
it("preserves Microsoft's existing msToDo source kind through claim, result, and explicit retry",async()=>{
  const f=await fixture("msToDo"),body={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,...f.request};
  const call=(path:string,value:unknown)=>worker.fetch(new Request(`https://personal-cloud.local/v1/provider/commands/${path}`,{method:"POST",headers:{"x-openza-test-device":f.a},body:JSON.stringify(value)}),env as unknown as Env);
  for(const integrationKind of["", "x".repeat(65)])expect((await call("claim",{...body,integrationKind})).status).toBe(400);
  expect((await call("claim",{...body,integrationKind:"mstodo"})).status).toBe(409);
  const claimed=await call("claim",body);expect(claimed.status).toBe(200);expect((await claimed.json() as any).claim.integrationKind).toBe("msToDo");
  expect((await call("start",{protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:f.a,claimId:f.request.claimId})).status).toBe(200);
  const rejected=result(f,{operation:"externalCommand.reject",payload:{claimId:f.request.claimId,requestedChangeSeq:f.request.requestedChangeSeq,resolvedAt:at,errorCode:"authentication_required"}});
  expect((await post(rejected)).status).toBe(201);
  const {claimId,...retryBody}=body;
  const retried=await call("retry",{...retryBody,retryId:`retry.ms.${f.id}`});expect(retried.status).toBe(200);
  const requestedChangeSeq=(await retried.json() as any).requestedChangeSeq;
  expect((await call("claim",{...body,claimId:`claim.ms.retry.${f.id}`,requestedChangeSeq})).status).toBe(200);
});
function result(f:Awaited<ReturnType<typeof fixture>>,extra:Record<string,unknown>={}){return{protocolVersion:1 as const,product:"tasks" as const,instanceId:env.INSTANCE_ID,
  deviceId:f.a,mutationId:`result.${f.id}`,deviceSequence:3,operation:"externalCommand.confirm" as const,entityId:f.taskId,baseEntityVersion:null,
  payload:{claimId:f.request.claimId,requestedChangeSeq:f.request.requestedChangeSeq,resolvedAt:at,errorCode:null},clientCreatedAt:at,...extra};}

it("atomically admits one capable desktop and retains exact claim identity across lost responses",async()=>{
  const f=await fixture();
  const attempts=await Promise.allSettled([claimDelivery(env.DB,f.request),claimDelivery(env.DB,{...f.request,claimId:`other.${f.id}`,deviceId:f.b})]);
  expect(attempts.filter(x=>x.status==="fulfilled")).toHaveLength(1);
  expect((attempts.find(x=>x.status==="rejected") as PromiseRejectedResult).reason.code).toBe("delivery_busy");
  const accepted=(attempts.find(x=>x.status==="fulfilled") as PromiseFulfilledResult<any>).value;
  expect(await claimDelivery(env.DB,{...f.request,claimId:accepted.claimId,deviceId:accepted.deviceId})).toEqual(accepted);
  await expect(claimDelivery(env.DB,{...f.request,claimId:accepted.claimId,deviceId:accepted.deviceId,externalIdHash:"c".repeat(64)})).rejects.toMatchObject({code:"mutation_id_reused"});
});
it("coalesces an unstarted completion but never hands a started attempt to another desktop",async()=>{
  const f=await fixture();await claimDelivery(env.DB,f.request);
  const reopened=await(await post({...f.envelope,mutationId:`reopen.${f.id}`,deviceSequence:3,operation:"task.reopen",baseEntityVersion:2,payload:{reopenedAt:at}})).json() as any;
  await expect(startDelivery(env.DB,f.request.claimId,f.a)).rejects.toMatchObject({code:"command_superseded"});
  const next={...f.request,claimId:`next.${f.id}`,requestedChangeSeq:reopened.changeSeq,deviceId:f.b};
  expect((await claimDelivery(env.DB,next)).command).toBe("reopen");await startDelivery(env.DB,next.claimId,f.b);
  await expect(claimDelivery(env.DB,{...next,claimId:`third.${f.id}`,deviceId:f.a})).rejects.toMatchObject({code:"delivery_busy"});
});
it("only the owning started attempt can resolve; duplicate results retrieve their receipt",async()=>{
  const f=await fixture();await claimDelivery(env.DB,f.request);
  const body=result(f);
  await expect(applyExternalCommandResult(env.DB,body,JSON.stringify(body))).rejects.toMatchObject({code:"invalid_transition"});
  await startDelivery(env.DB,f.request.claimId,f.a);
  const forged=result(f,{deviceId:f.b,deviceSequence:1});
  await expect(applyExternalCommandResult(env.DB,forged,JSON.stringify(forged))).rejects.toMatchObject({code:"unauthorized"});
  expect((await applyExternalCommandResult(env.DB,body,JSON.stringify(body))).outcome).toBe("accepted");
  expect((await applyExternalCommandResult(env.DB,body,JSON.stringify(body))).outcome).toBe("duplicate");
  expect(await env.DB.prepare("SELECT state FROM provider_delivery_claims WHERE claim_id=?1").bind(f.request.claimId).first()).toEqual({state:"resolved"});
});
it("pulls owned results and explicit retry feeds through the actual sync route",async()=>{
  const f=await fixture();await claimDelivery(env.DB,f.request);await startDelivery(env.DB,f.request.claimId,f.a);
  const body=result(f,{operation:"externalCommand.reject",payload:{claimId:f.request.claimId,requestedChangeSeq:f.request.requestedChangeSeq,resolvedAt:at,errorCode:"provider_rejected"}});
  expect((await applyExternalCommandResult(env.DB,body as any,JSON.stringify(body))).outcome).toBe("accepted");
  const retry=await retryDelivery(env.DB,{...f.request,claimId:`feed.retry.${f.id}`});
  const response=await worker.fetch(new Request(`https://personal-cloud.local/sync/changes?after=${f.request.requestedChangeSeq}&limit=50`),env as unknown as Env);
  expect(response.status).toBe(200);const page=await response.json() as any;
  expect(page.changes.find((change:any)=>change.mutationId===body.mutationId).payload.task.externalCommand)
    .toEqual({command:"complete",state:"rejected",errorCode:"provider_rejected",requestedChangeSeq:f.request.requestedChangeSeq});
  expect(page.changes.find((change:any)=>change.changeSeq===retry.requestedChangeSeq).payload.task.externalCommand)
    .toEqual({command:"complete",state:"pending_desktop",errorCode:null,requestedChangeSeq:retry.requestedChangeSeq});
});
it("a late result releases its old attempt without confirming newer intent",async()=>{
  const f=await fixture();await claimDelivery(env.DB,f.request);await startDelivery(env.DB,f.request.claimId,f.a);
  const reopen=await(await post({...f.envelope,mutationId:`reopen.${f.id}`,deviceSequence:3,operation:"task.reopen",baseEntityVersion:2,payload:{reopenedAt:at}})).json() as any;
  const next={...f.request,claimId:`next.${f.id}`,requestedChangeSeq:reopen.changeSeq,deviceId:f.b};
  await expect(claimDelivery(env.DB,next)).rejects.toMatchObject({code:"delivery_busy"});
  const body=result(f,{deviceSequence:4});const receipt=await applyExternalCommandResult(env.DB,body,JSON.stringify(body));
  expect(receipt.entityVersion).toBe(3);
  expect(await env.DB.prepare("SELECT command,state FROM external_commands WHERE task_id=?1").bind(f.taskId).first()).toEqual({command:"reopen",state:"pending_desktop"});
  expect((await claimDelivery(env.DB,next)).command).toBe("reopen");
});
it("manual uncertainty reconciliation requires stopped host, provider check and revoked credential",async()=>{
  const f=await fixture();await claimDelivery(env.DB,f.request);await startDelivery(env.DB,f.request.claimId,f.a);
  const body=JSON.stringify({claimId:f.request.claimId,deliveryHostStopped:true,providerStateChecked:true});
  await expect(reconcileDelivery(env.DB,body)).rejects.toMatchObject({code:"invalid_transition"});
  await env.DB.prepare("UPDATE devices SET revoked_at=?1 WHERE device_id=?2").bind(at,f.a).run();
  await expect(reconcileDelivery(env.DB,JSON.stringify({claimId:f.request.claimId,deliveryHostStopped:false,providerStateChecked:true}))).rejects.toMatchObject({code:"invalid_request"});
  expect((await reconcileDelivery(env.DB,body)).outcome).toBe("reconciled");
  const late=result(f);await expect(applyExternalCommandResult(env.DB,late,JSON.stringify(late))).rejects.toMatchObject({code:"invalid_transition"});
  expect((await claimDelivery(env.DB,{...f.request,claimId:`new.${f.id}`,deviceId:f.b})).state).toBe("reserved");
});
it("claim/start routes enforce provider capability, bearer identity and revocation in production mode",async()=>{
  const f=await fixture(),token=`access-${crypto.randomUUID()}`;
  await env.DB.prepare(`INSERT INTO device_access_tokens(token_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)`)
    .bind(await tokenHash(token),f.a,new Date().toISOString(),new Date(Date.now()+600000).toISOString()).run();
  const body={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,...f.request};
  const call=(value:unknown,headers:Record<string,string>={authorization:`Bearer ${token}`})=>worker.fetch(new Request("https://personal-cloud.local/v1/provider/commands/claim",{method:"POST",headers,body:JSON.stringify(value)}),{...env,TEST_MODE:"false"} as unknown as Env);
  expect((await call(body,{cookie:"__Host-openza_session=fake"})).status).toBe(401);
  expect((await call({...body,deviceId:f.b})).status).toBe(401);
  expect((await call({...body,rawProviderId:"private"})).status).toBe(400);
  await env.DB.prepare("UPDATE devices SET can_bridge_provider=0 WHERE device_id=?1").bind(f.a).run();
  expect((await call(body)).status).toBe(401);
  await env.DB.prepare("UPDATE devices SET can_bridge_provider=1 WHERE device_id=?1").bind(f.a).run();
  expect((await call(body)).status).toBe(200);
  await env.DB.prepare("UPDATE devices SET revoked_at=?1 WHERE device_id=?2").bind(at,f.a).run();
  expect((await call(body)).status).toBe(401);
});
it("explicit retry allocates one new request without flipping Openza intent or bypassing uncertainty",async()=>{
  const f=await fixture();await claimDelivery(env.DB,f.request);await startDelivery(env.DB,f.request.claimId,f.a);
  const retry={...f.request,claimId:`retry.${f.id}`,deviceId:f.b};
  await expect(retryDelivery(env.DB,retry)).rejects.toMatchObject({code:"command_superseded"});
  const rejection={...result(f),operation:"externalCommand.reject" as const,payload:{...result(f).payload,errorCode:"provider_rejected" as const}};
  await applyExternalCommandResult(env.DB,rejection,JSON.stringify(rejection));
  const accepted=await retryDelivery(env.DB,retry);
  expect(accepted.requestedChangeSeq).toBeGreaterThan(f.request.requestedChangeSeq);
  expect(await retryDelivery(env.DB,retry)).toEqual(accepted);
  await expect(retryDelivery(env.DB,{...retry,claimId:`second.${f.id}`})).rejects.toMatchObject({code:"command_superseded"});
  expect(await env.DB.prepare("SELECT completion_state,entity_version FROM tasks WHERE id=?1").bind(f.taskId).first()).toEqual({completion_state:"completed",entity_version:2});
  expect((await claimDelivery(env.DB,{...retry,claimId:`newclaim.${f.id}`,requestedChangeSeq:accepted.requestedChangeSeq})).state).toBe("reserved");
});
it("owner recovery is session/CSRF protected and cannot impersonate provider delivery",async()=>{
  const f=await fixture();await claimDelivery(env.DB,f.request);await startDelivery(env.DB,f.request.claimId,f.a);
  const token=`session-${crypto.randomUUID()}`,csrf=`csrf-${crypto.randomUUID()}`,now=new Date().toISOString();
  const current=await env.DB.prepare("SELECT credential_id FROM owner_credentials WHERE revoked_at IS NULL").first<{credential_id:string}>();
  const credential=current?.credential_id??`credential.${f.id}`;
  await env.DB.prepare("INSERT OR IGNORE INTO owner_credentials(credential_id,display_name,public_key_jwk,created_at) VALUES(?1,'Synthetic owner','{}',?2)").bind(credential,now).run();
  await env.DB.prepare(`INSERT INTO web_sessions(session_hash,credential_id,csrf_hash,created_at,rotated_at,expires_at,absolute_expires_at)
    VALUES(?1,?2,?3,?4,?4,?5,?5)`).bind(await tokenHash(token),credential,await tokenHash(csrf),now,new Date(Date.now()+600000).toISOString()).run();
  const headers={cookie:`__Host-openza_session=${token}`,origin:"https://personal-cloud.local","x-openza-csrf":csrf};
  const call=(path:string,init:RequestInit={})=>worker.fetch(new Request(`https://personal-cloud.local${path}`,init),{...env,TEST_MODE:"false"} as unknown as Env);
  expect((await call("/auth/provider-deliveries")).status).toBe(401);
  const listed=await call("/auth/provider-deliveries",{headers});expect(listed.status).toBe(200);
  expect((await listed.json() as any).deliveries.find((d:any)=>d.claimId===f.request.claimId)).toMatchObject({state:"started",deviceRevokedAt:null});
  const body=JSON.stringify({claimId:f.request.claimId,deliveryHostStopped:true,providerStateChecked:true});
  expect((await call("/auth/provider-deliveries/reconcile",{method:"POST",headers:{cookie:headers.cookie,origin:headers.origin},body})).status).toBe(403);
  expect((await call("/auth/provider-deliveries/reconcile",{method:"POST",headers,body})).status).toBe(409);
  const refresh={...result(f),operation:"source.refreshSnapshot",payload:{source:{}}};
  expect((await call("/v1/tasks/mutations",{method:"POST",headers,body:JSON.stringify(result(f))})).status).toBe(401);
  // The actual supported source fixture still cannot be sent by an owner Web actor.
  refresh.payload.source=(f.envelope.payload.source as any);
  expect((await call("/v1/tasks/mutations",{method:"POST",headers,body:JSON.stringify(refresh)})).status).toBe(401);
  await env.DB.prepare("UPDATE devices SET revoked_at=?1 WHERE device_id=?2").bind(now,f.a).run();
  expect((await call("/auth/provider-deliveries/reconcile",{method:"POST",headers,body})).status).toBe(200);
});
it("database ownership guard rejects forged resolution and rolls back all side effects",async()=>{
  const f=await fixture();await claimDelivery(env.DB,f.request);await startDelivery(env.DB,f.request.claimId,f.a);
  await expect(env.DB.batch([
    env.DB.prepare("UPDATE tasks SET notes='must rollback' WHERE id=?1").bind(f.taskId),
    env.DB.prepare(`INSERT INTO external_command_resolutions(task_id,requested_change_seq,mutation_id,state,resolved_at,claim_id,resolving_device_id)
      VALUES(?1,?2,?3,'confirmed',?4,?5,?6)`).bind(f.taskId,f.request.requestedChangeSeq,`forged.${f.id}`,at,f.request.claimId,f.b),
  ])).rejects.toThrow("provider delivery not owned");
  expect(await env.DB.prepare("SELECT notes FROM tasks WHERE id=?1").bind(f.taskId).first()).toEqual({notes:null});
  expect(await env.DB.prepare("SELECT state FROM provider_delivery_claims WHERE claim_id=?1").bind(f.request.claimId).first()).toEqual({state:"started"});
});
