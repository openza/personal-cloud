import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";
import { hash } from "../src/auth.ts";
import sourceFixture from "./fixtures/valid-source-linked-task-create.json?raw";

const origin = "https://personal-cloud.local";
const at = "2026-10-13T00:00:00.000Z";
function create(deviceId: string, sequence: number, id = `task.${deviceId}.${sequence}`) {
  return { protocolVersion:1, product:"tasks", instanceId:env.INSTANCE_ID, deviceId,
    mutationId:`mutation.${deviceId}.${sequence}`, deviceSequence:sequence, operation:"task.create", entityId:id,
    baseEntityVersion:null, payload:{task:{id,spaceId:"space_default",title:"Synthetic batch task",completionState:"open",workflowStatus:"inbox",createdAt:at}},clientCreatedAt:at };
}
async function auth(deviceId: string, canSync = 1, canBridge = 1) {
  const token=`synthetic-batch-${deviceId}`,now=new Date().toISOString(),expires=new Date(Date.now()+600000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic desktop','desktop',?2,?3,?4)").bind(deviceId,canSync,canBridge,now),
    env.DB.prepare("INSERT INTO device_access_tokens(token_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)").bind(await hash(token),deviceId,now,expires),
  ]);
  return { authorization:`Bearer ${token}` };
}
function send(headers: HeadersInit, mutations: unknown[], db = env.DB, path = "/v1/tasks/mutations/batch") {
  return worker.fetch(new Request(origin+path,{method:"POST",headers,body:JSON.stringify({protocolVersion:1,mutations})}),
    {...env, DB:db, TEST_MODE:undefined} as unknown as Env);
}
function countQueries(db: D1Database) {
  let statements=0;
  const wrapped = new Proxy(db,{get(target,key){
    if(key==="batch")return async(items:D1PreparedStatement[])=>{statements+=items.length;return target.batch(items);};
    if(key==="prepare")return(sql:string)=>wrapStatement(target.prepare(sql));
    const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  }}) as D1Database;
  function wrapStatement(statement:D1PreparedStatement):D1PreparedStatement {
    return new Proxy(statement,{get(target,key){
      if(key==="bind")return(...args:unknown[])=>wrapStatement(target.bind(...args));
      const value=Reflect.get(target,key);
      if(["first","all","raw","run"].includes(String(key)))return(...args:unknown[])=>{statements++;return value.apply(target,args);};
      return typeof value==="function"?value.bind(target):value;
    }});
  }
  return { db:wrapped, count:()=>statements };
}

describe("ordered durable mutation batches",()=>{
  it("accepts ordered changes, replays lost response as exact duplicates and keeps single POST compatible",async()=>{
    const id="batch.replay",headers=await auth(id),items=[create(id,1),create(id,2)];
    const response=await send(headers,items);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
    const first=await response.json() as any;
    expect(first).toMatchObject({processedCount:2,stoppedAt:null,error:null});
    expect(first.receipts.map((r:any)=>[r.mutationId,r.outcome])).toEqual(items.map(item=>[item.mutationId,"accepted"]));
    const repeated=await(await send(headers,items)).json() as any;
    expect(repeated.receipts.map((r:any)=>r.outcome)).toEqual(["duplicate","duplicate"]);
    expect(repeated.receipts.map((r:any)=>r.changeSeq)).toEqual(first.receipts.map((r:any)=>r.changeSeq));
    const single=create(id,3);
    expect((await worker.fetch(new Request(origin+"/v1/tasks/mutations",{method:"POST",headers,body:JSON.stringify(single)}),{...env,TEST_MODE:undefined} as unknown as Env)).status).toBe(201);
  });
  it("reports a durable prefix before a version error and never executes or ACKs the failing suffix",async()=>{
    const id="batch.partial",headers=await auth(id),first=create(id,1);
    const failing={...create(id,2,first.entityId),operation:"task.updateOpenzaFields",baseEntityVersion:9,payload:{notes:"Synthetic failed update"}};
    const result=await(await send(headers,[first,failing])).json() as any;
    expect(result).toMatchObject({processedCount:1,stoppedAt:1,error:{code:"version_conflict",retryable:false}});
    expect(result.receipts).toHaveLength(1);
    expect(await env.DB.prepare("SELECT last_sequence FROM device_sequences WHERE device_id=?1").bind(id).first()).toEqual({last_sequence:1});
    const retry=await(await send(headers,[first,failing])).json() as any;
    expect(retry.receipts[0].outcome).toBe("duplicate");expect(retry.stoppedAt).toBe(1);
    expect(await env.DB.prepare("SELECT notes FROM tasks WHERE id=?1").bind(first.entityId).first()).toEqual({notes:null});
  });
  it("rejects all envelope/order/size/actor/scope errors before any write",async()=>{
    const id="batch.invalid",headers=await auth(id,1,0),first=create(id,1),second=create(id,2);
    const source=JSON.parse(sourceFixture);source.instanceId=env.INSTANCE_ID;source.deviceId=id;source.deviceSequence=2;
    const refresh={...source,operation:"source.refreshSnapshot",payload:{source:source.payload.source}};
    for(const items of [[],[first,second,create(id,3)],[first,{...second,deviceId:"forged"}],
      [first,{...second,deviceSequence:3}],[first,{...second,mutationId:first.mutationId}],
      [first,{...second,unknown:"field"}],[first,{...second,payload:{...second.payload,secret:"raw"}}],
      [first,{...second,payload:{task:{...second.payload.task,title:"x".repeat(17000)}}}]]) {
      expect((await send(headers,items)).status).toBe(400);
    }
    expect((await send(headers,[first,refresh])).status).toBe(401);
    expect((await send({},[first])).status).toBe(401);
    expect((await send({cookie:"__Host-openza_session=synthetic"},[first])).status).toBe(401);
    expect((await send(headers,[create("forged",1)])).status).toBe(401);
    expect((await send(headers,[first],env.DB,"/v1/tasks/mutations/batch?extra=1")).status).toBe(400);
    expect(await env.DB.prepare("SELECT id FROM tasks WHERE id=?1").bind(first.entityId).first()).toBeNull();
  });
  it("does not skip a failed first sequence or mutation ID reuse",async()=>{
    const id="batch.sequence",headers=await auth(id),items=[create(id,3),create(id,4)];
    const gap=await(await send(headers,items)).json() as any;
    expect(gap).toMatchObject({processedCount:0,stoppedAt:0,receipts:[],error:{code:"sequence_gap",retryable:true}});
    const accepted=create(id,1);expect((await(await send(headers,[accepted])).json() as any).processedCount).toBe(1);
    const reuse={...accepted,payload:{task:{...accepted.payload.task,title:"Changed content"}}};
    const rejected=await(await send(headers,[reuse,create(id,2)])).json() as any;
    expect(rejected).toMatchObject({processedCount:0,stoppedAt:0,error:{code:"mutation_id_reused",retryable:false}});
    expect(await env.DB.prepare("SELECT id FROM tasks WHERE id=?1").bind(create(id,2).entityId).first()).toBeNull();
  });
  it("concurrent exact wrappers yield one durable change per envelope",async()=>{
    const id="batch.concurrent",headers=await auth(id),items=[create(id,1),create(id,2)];
    const responses=await Promise.all([send(headers,items),send(headers,items)]);
    for(const response of responses)expect((await response.json() as any).processedCount).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE mutation_id IN (?1,?2)").bind(items[0].mutationId,items[1].mutationId).first()).toEqual({count:2});
  });
  it("keeps internal failures generic and prefix durable when the next write fails",async()=>{
    const id="batch.outage",headers=await auth(id),items=[create(id,1),create(id,2)];let calls=0;
    const db=new Proxy(env.DB,{get(target,key){
      if(key==="batch")return(items:D1PreparedStatement[])=>{if(++calls===2)throw new Error("Synthetic outage with private raw detail");return target.batch(items);};
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }}) as D1Database;
    const result=await(await send(headers,items,db)).json() as any;
    expect(result).toMatchObject({processedCount:1,stoppedAt:1,error:{code:"internal_error",retryable:true}});
    expect(JSON.stringify(result)).not.toContain("private raw detail");
    expect((await(await send(headers,items)).json() as any).receipts.map((r:any)=>r.outcome)).toEqual(["duplicate","accepted"]);
  });
  it("counts all SQL statements in worst normal source and relationship chunks below the Free50-query budget",async()=>{
    const id="batch.budget",headers=await auth(id),base=JSON.parse(sourceFixture);base.instanceId=env.INSTANCE_ID;
    base.deviceId=id;base.mutationId="mutation.batch.budget.create";
    expect((await(await send(headers,[base])).json() as any).processedCount).toBe(1);
    const source=base.payload.source;
    const refresh=(sequence:number)=>({...base,mutationId:`mutation.batch.budget.${sequence}`,deviceSequence:sequence,
      operation:"source.refreshSnapshot",payload:{source:{...source,refreshedAt:at}}});
    let counted=countQueries(env.DB);
    expect((await(await send(headers,[refresh(2),refresh(3)],counted.db)).json() as any).processedCount).toBe(2);
    expect(counted.count()).toBeLessThan(50);
    const sourceQueries=counted.count();
    counted=countQueries(env.DB);
    const label={...base,mutationId:"mutation.batch.budget.label",deviceSequence:4,operation:"task.addLabel",baseEntityVersion:1,payload:{label:{id:"synthetic.label",name:"Synthetic"}}};
    const project={...label,mutationId:"mutation.batch.budget.project",deviceSequence:5,operation:"task.setProject",baseEntityVersion:2,payload:{project:{id:"synthetic.project",name:"Synthetic"}}};
    expect((await(await send(headers,[label,project],counted.db)).json() as any).processedCount).toBe(2);
    expect(counted.count()).toBeLessThan(50);
    console.log("MUTATION_BATCH_QUERY_BUDGET "+JSON.stringify({maxMutations:2,sourceQueries,relationshipQueries:counted.count(),freeLimit:50}));
  });
});
