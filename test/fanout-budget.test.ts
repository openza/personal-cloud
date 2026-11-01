import {env,exports} from 'cloudflare:workers';
import {describe,it,expect} from 'vitest';
import {applyWorkspaceMutation} from '../src/workspace-mutations.ts';
import {parseWorkspaceMutation} from '../src/workspace-protocol.ts';
import {parseFanoutBound} from '../src/fanout-budget.ts';
const at='2026-10-20T00:00:00.000Z';let number=0;
async function fixture(operation='project.delete',tasks=1,children=0){
 const suffix=++number,project='project.fanout.'+suffix,root='task.fanout.'+suffix+'.0';
 await env.DB.prepare('INSERT INTO projects(id,space_id,name,created_at,updated_at) VALUES(?1,\'space_default\',\'Synthetic\',?2,?2)').bind(project,at).run();
 for(let i=0;i<tasks;i++)await env.DB.prepare("INSERT INTO tasks(id,product,space_id,title,completion_state,workflow_status,created_at,entity_version,created_by_mutation_id,project_id,parent_id) VALUES(?1,'tasks','space_default','Synthetic','open','inbox',?2,1,?1,?3,?4)").bind(`task.fanout.${suffix}.${i}`,at,project,operation==='task.moveTree'&&i?root:null).run();
 for(let i=0;i<children;i++)await env.DB.prepare("INSERT INTO projects(id,space_id,name,parent_id,created_at,updated_at) VALUES(?1,'space_default','Synthetic child',?2,?3,?3)").bind(`project.child.${suffix}.${i}`,project,at).run();
 const m={protocolVersion:1,product:'tasks',instanceId:env.INSTANCE_ID,deviceId:'device.fanout.'+suffix,mutationId:'mutation.fanout.'+suffix,deviceSequence:1,operation,entityId:operation==='project.delete'?project:root,baseEntityVersion:1,payload:operation==='project.delete'?{}:{spaceId:'space_default',fields:{}},clientCreatedAt:at};
 return{m,project,root,raw:JSON.stringify(m)};
}
async function post(m:any,bound?:string){const response=await exports.default.fetch('https://personal-cloud.local/v1/tasks/mutations',{method:'POST',headers:bound===undefined?{}:{'x-openza-fanout-bound':bound},body:JSON.stringify(m)});return{status:response.status,body:await response.json() as any};}
describe.sequential('request-local fanout budget v1',()=>{
 it('advertises the fanout capability with schema26 catchup enforcement',async()=>{const body=await(await exports.default.fetch('https://personal-cloud.local/health')).json()as any;expect(body.schemaVersion).toBe(26);expect(body.capabilities.fanoutBudget).toEqual({protocolVersion:1,requestHeader:'x-openza-fanout-bound'});expect(body.capabilities.catchupStatus).toEqual({protocolVersion:1,path:'/sync/catchup-status',staleAfterSeconds:900});expect(body.capabilities.desktopCompatibility).toEqual({protocolVersion:1,minDesktopVersion:'1.3.0'});});
 it('rejects malformed or negative bounds without adding a count cap',()=>{
  for(const value of ['-1','01','1.0','1e3',' 1','9007199254740992','a'])expect(()=>parseFanoutBound(value)).toThrow();
  expect(parseFanoutBound(null)).toBeUndefined();expect(parseFanoutBound('0')).toBe(0);expect(parseFanoutBound('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
 });
 it('counts affected tasks and direct child projects and preserves the original request on rejection',async()=>{
  const f=await fixture('project.delete',2,1),before=await env.DB.prepare('SELECT next_change_seq FROM cloud_state WHERE singleton=1').first();
  const rejected=await post(f.m,'2');expect(rejected.status).toBe(409);expect(rejected.body.error).toMatchObject({code:'fanout_bound_exceeded',retryable:true});expect(JSON.stringify(rejected.body)).not.toMatch(/SELECT|NOT NULL|workspace_guards/);
  expect(await env.DB.prepare('SELECT next_change_seq FROM cloud_state WHERE singleton=1').first()).toEqual(before);
  expect(await env.DB.prepare('SELECT mutation_id FROM mutation_receipts WHERE mutation_id=?1').bind(f.m.mutationId).first()).toBeNull();
  expect((await post(f.m,'3')).status).toBe(201);
  expect((await post(f.m,'0')).body.outcome).toBe('duplicate');
 });
 it('counts the whole task subtree including its root and leaves legacy requests supported',async()=>{
  const f=await fixture('task.moveTree',3);expect((await post(f.m,'2')).body.error.code).toBe('fanout_bound_exceeded');expect((await post(f.m,'3')).status).toBe(201);
  const legacy=await fixture('task.moveTree',3);expect((await post(legacy.m)).status).toBe(201);
 });
 it('checks the exact accepted receipt before any fanout count even with a changed bound',async()=>{
  const f=await fixture();await post(f.m,'1');
  const db={prepare:(sql:string)=>{if(sql.includes('count(*)'))throw Error('Unexpected count after receipt');return env.DB.prepare(sql);},batch:env.DB.batch.bind(env.DB)}as D1Database;
  expect((await applyWorkspaceMutation(db,parseWorkspaceMutation(f.raw,env.INSTANCE_ID),f.raw,{fanoutBound:0})).outcome).toBe('duplicate');
 });
 it('atomically rejects fanout growth between preflight and commit without consuming sequence or history',async()=>{
  const f=await fixture('project.delete',0);let raced=false;
  const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{
   if(!raced){raced=true;await env.DB.prepare("INSERT INTO tasks(id,product,space_id,title,completion_state,workflow_status,created_at,entity_version,created_by_mutation_id,project_id) VALUES(?1,'tasks','space_default','Concurrent synthetic','open','inbox',?2,1,?1,?3)").bind(f.root,at,f.project).run();}
   return env.DB.batch(statements);
  }}as D1Database;
  await expect(applyWorkspaceMutation(db,parseWorkspaceMutation(f.raw,env.INSTANCE_ID),f.raw,{fanoutBound:0})).rejects.toMatchObject({code:'fanout_bound_exceeded'});
  expect(await env.DB.prepare('SELECT deleted_at FROM projects WHERE id=?1').bind(f.project).first('deleted_at')).toBeNull();
  expect(await env.DB.prepare('SELECT mutation_id FROM device_sequence_claims WHERE mutation_id=?1').bind(f.m.mutationId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT mutation_id FROM changes WHERE mutation_id=?1').bind(f.m.mutationId).first()).toBeNull();
  expect((await post(f.m,'1')).status).toBe(201);
 });
 it('does not misclassify other NOT NULL failures',async()=>{
  const f=await fixture(),db={prepare:env.DB.prepare.bind(env.DB),batch:async()=>{throw Error('D1_ERROR: NOT NULL constraint failed: projects.name');}}as unknown as D1Database;
  await expect(applyWorkspaceMutation(db,parseWorkspaceMutation(f.raw,env.INSTANCE_ID),f.raw,{fanoutBound:1})).rejects.toThrow('projects.name');
 });
 it('retains an accepted sequential batch prefix when the next bound is stale',async()=>{
  const first=await fixture('project.delete',0),second=await fixture('project.delete',1);
  second.m.deviceId=first.m.deviceId;second.m.deviceSequence=2;
  const token='synthetic-fanout-batch-token',hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
  await env.DB.batch([
   env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic fanout','desktop',1,0,?2)").bind(first.m.deviceId,at),
   env.DB.prepare('INSERT INTO device_access_tokens(token_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)').bind(hash,first.m.deviceId,at,new Date(Date.now()+600000).toISOString()),
  ]);
  const response=await exports.default.fetch('https://personal-cloud.local/v1/tasks/mutations/batch',{method:'POST',headers:{'x-openza-fanout-bound':'0',authorization:'Bearer '+token},body:JSON.stringify({protocolVersion:1,mutations:[first.m,second.m]})});
  const body=await response.json()as any;expect(response.status).toBe(200);expect(body.processedCount).toBe(1);expect(body.receipts[0].mutationId).toBe(first.m.mutationId);expect(body.error).toMatchObject({code:'fanout_bound_exceeded',retryable:true});
  expect((await post(second.m,'1')).status).toBe(201);
 });
});
