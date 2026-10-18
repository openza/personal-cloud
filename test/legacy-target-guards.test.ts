import {env,exports} from 'cloudflare:workers';
import {expect,it} from 'vitest';
import {applyTaskCreate} from '../src/task-create.ts';
import {applyTaskRelationship} from '../src/task-relationships.ts';
import {parseTaskCreateMutation,parseTaskRelationshipMutation} from '../src/protocol.ts';

const at='2026-10-17T00:00:00.000Z';
const envelope=(id:string,operation:string,payload:unknown,base:number|null=null,sequence=1)=>JSON.stringify({protocolVersion:1,product:'tasks',instanceId:env.INSTANCE_ID,deviceId:`device.${id}`,deviceSequence:sequence,mutationId:`mutation.${id}.${operation}`,operation,entityId:`task.${id}`,baseEntityVersion:base,payload,clientCreatedAt:at});
const create=(id:string,spaceId='space_default')=>envelope(id,'task.create',{task:{id:`task.${id}`,spaceId,title:'Synthetic guard task',completionState:'open',workflowStatus:'inbox',createdAt:at}});
function beforeBatch(action:()=>Promise<unknown>):D1Database {
  return new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{await action();return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
}

it('rejects legacy task creation in an archived Space without a retryable error or sequence claim',async()=>{
  await env.DB.prepare("INSERT INTO spaces(id,name,is_archived) VALUES('space.guard.archived','Archived',1)").run();
  const response=await exports.default.fetch('https://personal-cloud.local/v1/tasks/mutations',{method:'POST',body:create('guard.archived','space.guard.archived')});
  expect(response.status).toBe(400);expect(await response.json()).toMatchObject({error:{code:'invalid_request',retryable:false}});
  expect(await env.DB.prepare("SELECT * FROM device_sequence_claims WHERE device_id='device.guard.archived'").all()).toMatchObject({results:[]});
});

it('maps an archive between the legacy create precheck and transaction to a nonretryable error',async()=>{
  await env.DB.prepare("INSERT INTO spaces(id,name) VALUES('space.guard.race','Race')").run();
  const raw=create('guard.create.race','space.guard.race'),db=beforeBatch(()=>env.DB.prepare("UPDATE spaces SET is_archived=1 WHERE id='space.guard.race'").run());
  await expect(applyTaskCreate(db,parseTaskCreateMutation(raw,env.INSTANCE_ID),raw)).rejects.toMatchObject({code:'invalid_request'});
  expect(await env.DB.prepare("SELECT id FROM tasks WHERE id='task.guard.create.race'").first()).toBeNull();
});

for(const kind of ['Space','project'])it(`maps a concurrent archived ${kind} in legacy relationships and rolls back its claim`,async()=>{
  const id=`guard.relationship.${kind.toLowerCase()}`,raw=create(id);
  await applyTaskCreate(env.DB,parseTaskCreateMutation(raw,env.INSTANCE_ID),raw);
  await env.DB.prepare("INSERT INTO spaces(id,name) VALUES(?1,'Target')").bind(`space.${id}`).run();
  await env.DB.prepare("INSERT INTO projects(id,space_id,name) VALUES(?1,'space_default','Target')").bind(`project.${id}`).run();
  const relationship=envelope(id,kind==='Space'?'task.move':'task.setProject',kind==='Space'?{space:{id:`space.${id}`,name:'Target'}}:{project:{id:`project.${id}`,name:'Target'}},1,2);
  const db=beforeBatch(()=>kind==='Space'?env.DB.prepare('UPDATE spaces SET is_archived=1 WHERE id=?1').bind(`space.${id}`).run():env.DB.prepare("UPDATE projects SET status='archived' WHERE id=?1").bind(`project.${id}`).run());
  await expect(applyTaskRelationship(db,parseTaskRelationshipMutation(relationship,env.INSTANCE_ID),relationship)).rejects.toMatchObject({code:'invalid_request'});
  expect(await env.DB.prepare('SELECT entity_version,space_id,project_id FROM tasks WHERE id=?1').bind(`task.${id}`).first()).toEqual({entity_version:1,space_id:'space_default',project_id:null});
  expect(await env.DB.prepare('SELECT * FROM entity_version_claims WHERE entity_id=?1').bind(`task.${id}`).all()).toMatchObject({results:[]});
});
