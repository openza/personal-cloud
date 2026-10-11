import {env,exports} from "cloudflare:workers";
import {expect,it} from "vitest";

const timestamp="2026-10-11T00:00:00.000Z";
function mutation(id:string,sequence:number,operation:string,base:number|null,payload:unknown,device=`device.${id}`){return JSON.stringify({protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:device,mutationId:`mutation.${id}.${sequence}.${operation}`,deviceSequence:sequence,operation,entityId:id,baseEntityVersion:base,payload,clientCreatedAt:timestamp});}
const post=(body:string)=>exports.default.fetch("https://personal-cloud.local/v1/tasks/mutations",{method:"POST",body});
const create=(id:string,sequence=1,device=`device.${id}`)=>mutation(id,sequence,"task.create",null,{task:{id,spaceId:"space_default",title:id,completionState:"open",workflowStatus:"inbox",createdAt:timestamp}},device);

it("rejects all new edits on tombstones but preserves accepted duplicate receipts",async()=>{
  for(const operation of ["task.updateOpenzaFields","task.complete","task.reopen"]){
    const id=`task.deleted.${operation}`;
    const original=create(id);expect((await post(original)).status).toBe(201);
    let version=1,sequence=2;
    if(operation==="task.reopen"){expect((await post(mutation(id,sequence++,"task.complete",version++,{completedAt:timestamp}))).status).toBe(201);}
    expect((await post(mutation(id,sequence++,"task.delete",version++,{deletedAt:timestamp}))).status).toBe(201);
    const payload=operation==="task.updateOpenzaFields"?{notes:"Must not persist"}:operation==="task.complete"?{completedAt:timestamp}:{reopenedAt:timestamp};
    const rejected=await post(mutation(id,sequence,operation,version,payload));
    expect(rejected.status).toBe(404);expect(await rejected.json()).toMatchObject({error:{code:"entity_not_found"}});
    expect(await env.DB.prepare("SELECT entity_version FROM tasks WHERE id=?1").bind(id).first()).toEqual({entity_version:version});
    expect((await post(original)).status).toBe(200);
  }
});

it("rejects three-node parent cycles and enforces the same invariant in atomic database writes",async()=>{
  const ids=["task.cycle.a","task.cycle.b","task.cycle.c"];
  for(const id of ids)expect((await post(create(id))).status).toBe(201);
  expect((await post(mutation(ids[0],2,"task.setParent",1,{parentId:ids[1]}))).status).toBe(201);
  expect((await post(mutation(ids[1],2,"task.setParent",1,{parentId:ids[2]}))).status).toBe(201);
  const rejected=await post(mutation(ids[2],2,"task.setParent",1,{parentId:ids[0]}));
  expect(rejected.status).toBe(400);expect(await rejected.json()).toMatchObject({error:{code:"invalid_request"}});
  await expect(env.DB.prepare("UPDATE tasks SET parent_id=?1 WHERE id=?2").bind(ids[0],ids[2]).run()).rejects.toThrow("task parent cycle");
  expect(await env.DB.prepare("SELECT parent_id FROM tasks WHERE id=?1").bind(ids[2]).first()).toEqual({parent_id:null});
});
