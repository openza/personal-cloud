import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";

const at="2026-09-13T06:46:00.000Z";
async function post(path:string, body:unknown, headers:Record<string,string>={}) {
  return exports.default.fetch(`https://personal-cloud.local${path}`,{method:"POST",body:JSON.stringify(body),headers});
}

it("repeats bootstrap consistently and compacts only after retention and device acknowledgement", async()=>{
  const common={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:"device.bootstrap",clientCreatedAt:at};
  const taskId="task.bootstrap";
  const create={...common,mutationId:"mutation.bootstrap.create",deviceSequence:1,operation:"task.create",entityId:taskId,baseEntityVersion:null,
    payload:{task:{id:taskId,spaceId:"space_default",title:"Bootstrap",completionState:"open",workflowStatus:"inbox",createdAt:at}}};
  expect((await post("/v1/tasks/mutations",create)).status).toBe(201);
  const deletion={...common,mutationId:"mutation.bootstrap.delete",deviceSequence:2,operation:"task.delete",entityId:taskId,baseEntityVersion:1,payload:{deletedAt:at}};
  expect((await post("/v1/tasks/mutations",deletion)).status).toBe(201);
  const first=await (await exports.default.fetch("https://personal-cloud.local/sync/bootstrap")).json();
  const repeated=await (await exports.default.fetch("https://personal-cloud.local/sync/bootstrap")).json();
  expect(repeated).toEqual(first);
  expect(first).toMatchObject({checkpoint:2,snapshot:{tasks:[{id:taskId,deletedAt:at}],tombstones:[{entityId:taskId}]}});

  const early=await post("/sync/compact",{now:"2026-10-14T00:00:00.000Z"},{"x-openza-test-session":env.K5_TEST_SESSION});
  expect(await early.json()).toMatchObject({purgedEntityIds:[]});
  const ack={protocolVersion:1,product:"tasks",instanceId:env.INSTANCE_ID,deviceId:"device.bootstrap",checkpoint:2};
  expect((await post("/sync/checkpoints",ack)).status).toBe(200);
  const compacted=await post("/sync/compact",{now:"2026-10-14T00:00:00.000Z"},{"x-openza-test-session":env.K5_TEST_SESSION});
  expect(await compacted.json()).toMatchObject({purgedEntityIds:[taskId]});
  const rebuilt=await (await exports.default.fetch("https://personal-cloud.local/sync/bootstrap")).json() as any;
  expect(rebuilt.checkpoint).toBe(2);
  expect(rebuilt.snapshot.tasks).toEqual([]);
  expect(rebuilt.snapshot.tombstones).toEqual([]);
});
