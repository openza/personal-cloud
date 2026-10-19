import {env} from 'cloudflare:workers';
import {describe,expect,it} from 'vitest';
import worker,{type Env} from '../src/index.ts';
import {schemaReady} from '../src/schema-readiness.ts';

const healthEnv = {...env, ARTIFACT_VERSION:'0.0.0-test'} satisfies Env;
const health=()=>worker.fetch(new Request('https://cloud.example/health'),healthEnv);
async function assertNotReady(){
 const response=await health();
 expect(response.status).toBe(503);expect(response.headers.get('cache-control')).toBe('no-store');
 const body=await response.json() as {error:{code:string,message:string}};
 expect(body.error.code).toBe('schema_not_ready');
 expect(JSON.stringify(body)).not.toMatch(/SELECT|sqlite|updated_at|trigger|table|database_id/);
}
describe.sequential('schema25 health readiness',()=>{
 it('accepts the fully migrated binding without changing the success shape',async()=>{
  expect(await schemaReady(env.DB)).toBe(true);
  const response=await health();expect(response.status).toBe(200);
  const body=await response.json() as {schemaVersion:number};expect(body.schemaVersion).toBe(25);
 });
 for(const name of ['tasks_initial_updated_at','tasks_accepted_updated_at','changes_workspace_response_limit',
   'workspace_task_project_insert','provider_delivery_result_owned','mutation_receipts_are_immutable_before_update',
   'provider_delivery_one_active_source','source_descriptors_identity']){
  it(`fails closed when required object ${name} is missing`,async()=>{
   const original=await env.DB.prepare('SELECT type,sql FROM sqlite_master WHERE name=?1').bind(name).first<{type:string,sql:string}>();
   if(!original)throw Error('Missing test fixture object');
   await env.DB.prepare(`DROP ${original.type} ${name}`).run();
   try{await assertNotReady();}finally{await env.DB.prepare(original.sql).run();}
   expect(await schemaReady(env.DB)).toBe(true);
  });
 }
 it('rejects a schema24 column footprint even when the latest trigger names remain',async()=>{
  await env.DB.prepare('ALTER TABLE tasks RENAME COLUMN updated_at TO synthetic_old_column').run();
  try{await assertNotReady();}finally{await env.DB.prepare('ALTER TABLE tasks RENAME COLUMN synthetic_old_column TO updated_at').run();}
 });
 it('keeps health reads bounded and independent of populated tasks and history',async()=>{
  const measurements: {rowsRead:number;rowsWritten:number}[]=[];
  const traced={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{
   const results=await env.DB.batch(statements);
   measurements.push({rowsRead:results.reduce((sum,r)=>sum+r.meta.rows_read,0),rowsWritten:results.reduce((sum,r)=>sum+r.meta.rows_written,0)});
   return results;
  }} as D1Database;
  expect(await schemaReady(traced)).toBe(true);
  await env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<200)
   INSERT INTO tasks(id,product,space_id,title,completion_state,workflow_status,priority,created_at,entity_version,created_by_mutation_id)
   SELECT 'read_budget_'||v,'tasks','space_default','Synthetic task','open','inbox',3,'2026-10-19T00:00:00Z',1,'read_budget_'||v FROM n`).run();
  try{
   await env.DB.prepare(`WITH RECURSIVE n(v) AS(SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<200)
    INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at)
    SELECT 100000+v,1,'tasks','read_budget_'||v,'task.created','task','read_budget_'||v,1,'{}','2026-10-19T00:00:00Z' FROM n`).run();
   expect(await schemaReady(traced)).toBe(true);
  }finally{
   await env.DB.prepare("DELETE FROM changes WHERE mutation_id LIKE 'read_budget_%'").run();
   await env.DB.prepare("DELETE FROM tasks WHERE id LIKE 'read_budget_%'").run();
  }
  expect(measurements).toHaveLength(2);expect(measurements[0]).toEqual(measurements[1]);
  expect(measurements[0].rowsRead).toBeLessThanOrEqual(250);expect(measurements[0].rowsWritten).toBe(0);
 });
 it('never reports healthy for an empty, unavailable or malformed binding result',async()=>{
  for(const db of [
   {prepare:()=>{throw Error('private SQL or resource detail');}},
   {prepare:()=>({first:async()=>null})},
   {prepare:()=>({first:async()=>({missing:1})})},
  ]){
   const response=await worker.fetch(new Request('https://cloud.example/health'),{...healthEnv,DB:db as unknown as D1Database});
   expect(response.status).toBe(503);expect(response.headers.get('cache-control')).toBe('no-store');
   expect(await response.text()).not.toContain('private');
  }
 });
});
