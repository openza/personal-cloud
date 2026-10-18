import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { applyTaskRelationship } from "../src/task-relationships.ts";
import { parseTaskRelationshipMutation } from "../src/protocol.ts";

const taskId = "task.relationships";
const timestamp = "2026-09-13T07:00:00.000Z";

function mutation(deviceId: string, mutationId: string, sequence: number, operation: string, entityId: string, base: number | null, payload: unknown) {
  return JSON.stringify({ protocolVersion:1, product:"tasks", instanceId:env.INSTANCE_ID, deviceId, mutationId,
    deviceSequence:sequence, operation, entityId, baseEntityVersion:base, payload, clientCreatedAt:timestamp });
}

async function post(body: string) {
  return exports.default.fetch("https://personal-cloud.local/v1/tasks/mutations", { method:"POST", body });
}

it("persists project, Space, label and parent semantics and emits a bounded multi-change page", async () => {
  const create = mutation("device.relationships", "mutation.rel.create", 1, "task.create", taskId, null,
    {task:{id:taskId,spaceId:"space_default",title:"Relationship task",completionState:"open",workflowStatus:"inbox",createdAt:timestamp}});
  expect((await post(create)).status).toBe(201);
  const project = mutation("device.relationships", "mutation.rel.project", 2, "task.setProject", taskId, 1,
    {project:{id:"project.rel",name:"Launch"}});
  expect((await post(project)).status).toBe(201);
  expect(await env.DB.prepare("SELECT project_id FROM tasks WHERE id=?1").bind(taskId).first()).toEqual({project_id:"project.rel"});
  const move = mutation("device.relationships", "mutation.rel.move", 3, "task.move", taskId, 2,
    {space:{id:"space.rel.two",name:"Personal"}});
  expect((await post(move)).status).toBe(201);
  expect(await env.DB.prepare("SELECT space_id,project_id FROM tasks WHERE id=?1").bind(taskId).first()).toEqual({space_id:"space.rel.two",project_id:null});
  const add = mutation("device.relationships", "mutation.rel.label.add", 4, "task.addLabel", taskId, 3,
    {label:{id:"label.rel",name:"Focus"}});
  expect((await post(add)).status).toBe(201);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM task_labels WHERE task_id=?1").bind(taskId).first()).toEqual({count:1});
  const remove = mutation("device.relationships", "mutation.rel.label.remove", 5, "task.removeLabel", taskId, 4,
    {labelId:"label.rel"});
  expect((await post(remove)).status).toBe(201);
  const parentCreate = mutation("device.parent", "mutation.rel.parent.create", 1, "task.create", "task.rel.parent", null,
    {task:{id:"task.rel.parent",spaceId:"space.rel.two",title:"Parent",completionState:"open",workflowStatus:"inbox",createdAt:timestamp}});
  expect((await post(parentCreate)).status).toBe(201);
  const parent = mutation("device.relationships", "mutation.rel.parent", 6, "task.setParent", taskId, 5,
    {parentId:"task.rel.parent"});
  expect((await post(parent)).status).toBe(201);

  const read = await exports.default.fetch("https://personal-cloud.local/v1/tasks", {headers:{"x-openza-test-session":env.K5_TEST_SESSION}});
  const readJson = await read.json() as {tasks:{id:string;spaceId:string;projectId:string|null;parentId:string|null;labels:unknown[]}[]};
  expect(readJson.tasks.find(task=>task.id===taskId)).toMatchObject({
    id:taskId, spaceId:"space.rel.two", projectId:null, parentId:"task.rel.parent", labels:[],
  });
  const page = await exports.default.fetch("https://personal-cloud.local/sync/changes?after=0&limit=50");
  const json = await page.json() as {changes:{operation:string}[];nextCheckpoint:number};
  expect(json.changes).toHaveLength(7);
  expect(json.changes.map(change=>change.operation)).toEqual([
    "task.created","task.projectSet","task.moved","task.labelAdded","task.labelRemoved","task.created","task.parentSet",
  ]);
  expect(json.nextCheckpoint).toBe(7);
  expect((await post(project)).status).toBe(200);
});

it("rejects a stale same-field write from a second device", async () => {
  const create = mutation("device.conflict.a", "mutation.conflict.create", 1, "task.create", "task.conflict", null,
    {task:{id:"task.conflict",spaceId:"space_default",title:"Original",completionState:"open",workflowStatus:"inbox",createdAt:timestamp}});
  expect((await post(create)).status).toBe(201);
  const first = mutation("device.conflict.a", "mutation.conflict.first", 2, "task.updateOpenzaFields", "task.conflict", 1, {title:"Device A"});
  expect((await post(first)).status).toBe(201);
  const stale = mutation("device.conflict.b", "mutation.conflict.stale", 1, "task.updateOpenzaFields", "task.conflict", 1, {title:"Device B"});
  const response = await post(stale);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({error:{code:"version_conflict",retryable:false}});
});

it("clears a project with the same versioned relationship operation", async () => {
  const id = "task.project.clear";
  const create = mutation("device.project.clear", "mutation.project.clear.create", 1, "task.create", id, null,
    {task:{id,spaceId:"space_default",title:"Clear project",completionState:"open",workflowStatus:"inbox",createdAt:timestamp}});
  expect((await post(create)).status).toBe(201);
  const assign = mutation("device.project.clear", "mutation.project.clear.assign", 2, "task.setProject", id, 1,
    {project:{id:"project.clear",name:"Temporary"}});
  expect((await post(assign)).status).toBe(201);
  const clear = mutation("device.project.clear", "mutation.project.clear.remove", 3, "task.setProject", id, 2,
    {project:null});
  expect((await post(clear)).status).toBe(201);
  expect(await env.DB.prepare("SELECT project_id,entity_version FROM tasks WHERE id=?1").bind(id).first())
    .toEqual({project_id:null,entity_version:3});
  const page = await exports.default.fetch("https://personal-cloud.local/sync/changes?after=0&limit=50");
  const body = await page.json() as {changes:{entityId:string;payload:unknown}[]};
  expect(body.changes.filter(change=>change.entityId===id).at(-1)?.payload)
    .toEqual({task:{id,projectId:null,project:null}});
});

it("reconstructs a desktop parent move by moving children before restoring their links", async () => {
  const device = "device.move.tree";
  const parentId = "task.move.tree.parent";
  const childId = "task.move.tree.child";
  expect((await post(mutation(device, "mutation.move.tree.parent.create", 1, "task.create", parentId, null,
    {task:{id:parentId,spaceId:"space_default",title:"Parent",completionState:"open",workflowStatus:"inbox",createdAt:timestamp}}))).status).toBe(201);
  expect((await post(mutation(device, "mutation.move.tree.child.create", 2, "task.create", childId, null,
    {task:{id:childId,spaceId:"space_default",title:"Child",completionState:"open",workflowStatus:"inbox",createdAt:timestamp}}))).status).toBe(201);
  expect((await post(mutation(device, "mutation.move.tree.parent.move", 3, "task.move", parentId, 1,
    {space:{id:"space.move.tree",name:"Moved together"}}))).status).toBe(201);
  expect((await post(mutation(device, "mutation.move.tree.child.move", 4, "task.move", childId, 1,
    {space:{id:"space.move.tree",name:"Moved together"}}))).status).toBe(201);
  expect((await post(mutation(device, "mutation.move.tree.child.parent", 5, "task.setParent", childId, 2,
    {parentId}))).status).toBe(201);

  expect(await env.DB.prepare("SELECT space_id,parent_id,entity_version FROM tasks WHERE id=?1").bind(parentId).first())
    .toEqual({space_id:"space.move.tree",parent_id:null,entity_version:2});
  expect(await env.DB.prepare("SELECT space_id,parent_id,entity_version FROM tasks WHERE id=?1").bind(childId).first())
    .toEqual({space_id:"space.move.tree",parent_id:parentId,entity_version:3});
});

for (const kind of ["project", "space"] as const) for (const existing of [false, true]) {
  it(`emits the stored ${kind} name for ${existing ? "stale existing" : "new"} legacy references and keeps replay immutable`, async () => {
    const suffix=existing?"existing":"new",id=`task.names.${kind}.${suffix}`,referenceId=`${kind}.names.${suffix}`,device=`device.names.${kind}.${suffix}`,table=kind==="project"?"projects":"spaces";
    expect((await post(mutation(device,`${device}.create`,1,"task.create",id,null,
      {task:{id,spaceId:"space_default",title:"Reference names",completionState:"open",workflowStatus:"inbox",createdAt:timestamp}}))).status).toBe(201);
    if(existing) await env.DB.prepare(kind==="project"?"INSERT INTO projects(id,space_id,name) VALUES(?1,'space_default','Stored current name')":"INSERT INTO spaces(id,name) VALUES(?1,'Stored current name')").bind(referenceId).run();
    const raw=mutation(device,`${device}.set`,2,kind==="project"?"task.setProject":"task.move",id,1,{[kind]:{id:referenceId,name:"Incoming name"}});
    const response=await post(raw),receipt=await response.json() as any;expect(response.status).toBe(201);
    const change=await env.DB.prepare("SELECT payload_json FROM changes WHERE change_seq=?1").bind(receipt.changeSeq).first<{payload_json:string}>();
    const payload=JSON.parse(change!.payload_json),expectedName=existing?"Stored current name":"Incoming name";
    expect(payload).toEqual({task:kind==="project"?{id,projectId:referenceId,project:{id:referenceId,name:expectedName}}:{id,spaceId:referenceId,space:{id:referenceId,name:expectedName},projectId:null,parentId:null}});
    expect(await env.DB.prepare(`SELECT name FROM ${table} WHERE id=?1`).bind(referenceId).first()).toEqual({name:expectedName});
    const storedReceipt=await env.DB.prepare("SELECT canonical_request,canonical_hash FROM mutation_receipts WHERE mutation_id=?1").bind(receipt.mutationId).first<{canonical_request:string,canonical_hash:string}>();
    expect(JSON.parse(storedReceipt!.canonical_request).payload[kind].name).toBe("Incoming name");
    await env.DB.prepare(`UPDATE ${table} SET name='Later name' WHERE id=?1`).bind(referenceId).run();
    const replay=await post(raw);expect(replay.status).toBe(200);expect(await replay.json()).toEqual({...receipt,outcome:"duplicate"});
    expect(await env.DB.prepare("SELECT payload_json FROM changes WHERE change_seq=?1").bind(receipt.changeSeq).first()).toEqual(change);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM changes WHERE mutation_id=?1").bind(receipt.mutationId).first()).toEqual({count:1});
    expect(await env.DB.prepare("SELECT canonical_request,canonical_hash FROM mutation_receipts WHERE mutation_id=?1").bind(receipt.mutationId).first()).toEqual(storedReceipt);
    const reused=JSON.parse(raw);reused.payload[kind].name="Changed request";const rejected=await post(JSON.stringify(reused));expect(rejected.status).toBe(409);expect(await rejected.json()).toMatchObject({error:{code:"mutation_id_reused"}});
  });
}

for (const kind of ["project", "space"] as const) for (const existing of [false, true]) {
  it(`captures a ${kind} ${existing ? "rename" : "creation"} between preflight and atomic acceptance`, async () => {
    const suffix=existing?"existing":"new",id=`task.racing.${kind}.${suffix}`,referenceId=`${kind}.racing.${suffix}`,device=`device.racing.${kind}.${suffix}`,table=kind==="project"?"projects":"spaces";
    expect((await post(mutation(device,`${device}.create`,1,"task.create",id,null,
      {task:{id,spaceId:"space_default",title:"Concurrent names",completionState:"open",workflowStatus:"inbox",createdAt:timestamp}}))).status).toBe(201);
    const insert=()=>env.DB.prepare(kind==="project"?"INSERT INTO projects(id,space_id,name) VALUES(?1,'space_default','Concurrent name')":"INSERT INTO spaces(id,name) VALUES(?1,'Concurrent name')").bind(referenceId).run();
    if(existing)await insert();
    let batches=0;const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{
      batches++;if(existing)await env.DB.prepare(`UPDATE ${table} SET name='Renamed before acceptance' WHERE id=?1`).bind(referenceId).run();else await insert();
      return env.DB.batch(statements);
    }} as D1Database;
    const raw=mutation(device,`${device}.set`,2,kind==="project"?"task.setProject":"task.move",id,1,{[kind]:{id:referenceId,name:"Stale caller name"}});
    const receipt=await applyTaskRelationship(db,parseTaskRelationshipMutation(raw,env.INSTANCE_ID),raw);
    expect(receipt.outcome).toBe("accepted");expect(batches).toBe(1);
    const change=await env.DB.prepare("SELECT payload_json FROM changes WHERE change_seq=?1").bind(receipt.changeSeq).first<{payload_json:string}>();
    expect(JSON.parse(change!.payload_json).task[kind]).toEqual({id:referenceId,name:existing?"Renamed before acceptance":"Concurrent name"});
    expect(await env.DB.prepare(`SELECT name FROM ${table} WHERE id=?1`).bind(referenceId).first()).toEqual({name:existing?"Renamed before acceptance":"Concurrent name"});
  });
}
