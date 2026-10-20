import {env} from 'cloudflare:workers';
import {describe,it,expect,beforeEach} from 'vitest';
import {applyWorkspaceMutation} from '../src/workspace-mutations.ts';
import {parseWorkspaceMutation} from '../src/workspace-protocol.ts';
let index=0;
async function fixture(tasks:number,ready=false){
 const n=++index,at=new Date().toISOString(),id='project.webfanout.'+n,desktop='device.webfanout.'+n;
 await env.DB.batch([
  env.DB.prepare("INSERT INTO projects(id,space_id,name,created_at,updated_at) VALUES(?1,'space_default','Synthetic',?2,?2)").bind(id,at),
  env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic','desktop',1,0,?2)").bind(desktop,at),
 ]);
 if(ready)await env.DB.prepare("INSERT INTO sync_catchup_status(device_id,report_sequence,state,pending,finished_at,updated_at) VALUES(?1,1,'idle',0,?2,?3)").bind(desktop,new Date(Date.now()-86400000).toISOString(),at).run();
 if(tasks)await env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v+1<?1)
 INSERT INTO tasks(id,product,space_id,title,completion_state,workflow_status,created_at,entity_version,created_by_mutation_id,project_id)
 SELECT ?2||'.task.'||v,'tasks','space_default','Synthetic','open','inbox',?3,1,?2||'.seed.'||v,?2 FROM n`).bind(tasks,id,at).run();
 const value={protocolVersion:1,product:'tasks',instanceId:env.INSTANCE_ID,deviceId:'web.synthetic.'+n,mutationId:'mutation.webfanout.'+n,deviceSequence:1,operation:'project.delete',entityId:id,baseEntityVersion:1,payload:{},clientCreatedAt:at};
 const raw=JSON.stringify(value),mutation=parseWorkspaceMutation(raw,env.INSTANCE_ID);
 return{id,desktop,raw,mutation};
}
describe.sequential('Web bulk eligibility shares the domain transaction',()=>{
 beforeEach(async()=>{await env.DB.batch([env.DB.prepare('DELETE FROM web_fanout_budget'),env.DB.prepare("UPDATE devices SET can_sync=0 WHERE device_id LIKE 'device.webfanout.%'")]);});
 it('allows a small deletion under unknown catchup while retaining one shared budget',async()=>{
  const f=await fixture(1);expect((await applyWorkspaceMutation(env.DB,f.mutation,f.raw,{ownerSession:true,fanoutBound:1})).outcome).toBe('accepted');
  expect(await env.DB.prepare('SELECT credits FROM web_fanout_budget WHERE day=?1').bind(new Date().toISOString().slice(0,10)).first('credits')).toBe(112);
 });
 it('defers large work under unknown status without sequence/history changes',async()=>{
  const f=await fixture(100);await expect(applyWorkspaceMutation(env.DB,f.mutation,f.raw,{ownerSession:true,fanoutBound:100})).rejects.toMatchObject({code:'web_fanout_deferred'});
  expect(await env.DB.prepare('SELECT mutation_id FROM device_sequence_claims WHERE mutation_id=?1').bind(f.mutation.mutationId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT mutation_id FROM changes WHERE mutation_id=?1').bind(f.mutation.mutationId).first()).toBeNull();
 });
 it('returns an exact accepted receipt before changed eligibility or a larger request bound',async()=>{
  const f=await fixture(100,true);await applyWorkspaceMutation(env.DB,f.mutation,f.raw,{ownerSession:true,fanoutBound:100});
  await env.DB.prepare("UPDATE sync_catchup_status SET state='catching_up',pending=10 WHERE device_id=?1").bind(f.desktop).run();
  expect((await applyWorkspaceMutation(env.DB,f.mutation,f.raw,{ownerSession:true,fanoutBound:10000})).outcome).toBe('duplicate');
  expect(await env.DB.prepare('SELECT credits FROM web_fanout_budget WHERE day=?1').bind(new Date().toISOString().slice(0,10)).first('credits')).toBe(1300);
 });
 it('rolls back the whole mutation if catchup restarts between preflight and its transaction',async()=>{
  const f=await fixture(100,true);let raced=false;
  const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{
   if(!raced){raced=true;await env.DB.prepare("UPDATE sync_catchup_status SET state='catching_up',pending=10 WHERE device_id=?1").bind(f.desktop).run();}
   return env.DB.batch(statements);
  }}as D1Database;
  await expect(applyWorkspaceMutation(db,f.mutation,f.raw,{ownerSession:true,fanoutBound:100})).rejects.toMatchObject({code:'web_fanout_deferred'});
  expect(await env.DB.prepare('SELECT deleted_at FROM projects WHERE id=?1').bind(f.id).first('deleted_at')).toBeNull();
  expect(await env.DB.prepare('SELECT mutation_id FROM device_sequence_claims WHERE mutation_id=?1').bind(f.mutation.mutationId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT credits FROM web_fanout_budget').first()).toBeNull();
 });
});
