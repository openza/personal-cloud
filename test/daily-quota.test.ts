import {env} from 'cloudflare:workers';
import {describe,it,expect} from 'vitest';
import worker,{type Env} from '../src/index.ts';
import {dailyQuotaError} from '../src/daily-quota.ts';
import rawFixture from './fixtures/quota-pause-v1.json?raw';
import rawCreate from './fixtures/valid-task-create.json?raw';
const fixture=JSON.parse(rawFixture);
const quota=()=>new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.");
const baseEnv={...env,ARTIFACT_VERSION:'0.0.0-test'} satisfies Env;
async function assertQuota(response:Response){
 expect(response.status).toBe(503);expect(response.headers.get('cache-control')).toBe('no-store');
 expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
 const body=await response.json() as any;expect(body.error).toMatchObject({code:'daily_quota_exceeded',retryable:true,quota:{protocolVersion:1,resource:'d1_rows_written'}});
 expect(body.error.quota.resetAt).toMatch(/T00:00:00\.000Z$/);expect(JSON.stringify(body)).not.toMatch(/D1_ERROR|SQLITE|INSERT|SELECT/);
}
describe.sequential('daily quota preserves error identity and accepted prefixes',()=>{
 for(const item of fixture.d1Cases)it('classifies documented D1 signal: '+item.message.slice(0,55),()=>{
  expect(dailyQuotaError(new Error(item.message),new Date(fixture.observedAt))?.quota.resource??null).toBe(item.resource);
 });
 it('bounds causes and preserves the first computed reset timestamp',()=>{
  const first=dailyQuotaError(quota(),new Date('2026-10-19T23:59:59.999Z'))!;
  expect(dailyQuotaError(first,new Date('2026-10-20T01:00:00.000Z'))).toBe(first);
  expect(first.quota.resetAt).toBe('2026-10-20T00:00:00.000Z');
  expect(dailyQuotaError(new Error('outer',{cause:quota()}))).not.toBeNull();
  let deep:Error=quota();for(let i=0;i<5;i++)deep=new Error('wrap',{cause:deep});expect(dailyQuotaError(deep)).toBeNull();
 });
 it('health quota stays typed instead of becoming schema_not_ready',async()=>{
  const db={prepare:()=>{throw quota();}} as unknown as D1Database;
  await assertQuota(await worker.fetch(new Request('https://cloud.example/health'),{...baseEnv,DB:db}));
 });
 it('generic auth/status read quota becomes safe503',async()=>{
  const db={prepare:()=>{throw quota();}} as unknown as D1Database;
  await assertQuota(await worker.fetch(new Request('https://cloud.example/auth/status'),{...baseEnv,DB:db}));
 });
 it('pairing D1 write failure cannot be translated into unauthorized',async()=>{
  const grant='synthetic-quota-pairing-grant-long',hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(grant));
  const hex=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  await env.DB.prepare('INSERT INTO pairing_grants(grant_hash,expires_at,created_at) VALUES(?1,?2,?3)').bind(hex,new Date(Date.now()+600000).toISOString(),new Date().toISOString()).run();
  const db={prepare:env.DB.prepare.bind(env.DB),batch:async()=>{throw quota();}} as unknown as D1Database;
  await assertQuota(await worker.fetch(new Request('https://cloud.example/auth/pair',{method:'POST',body:JSON.stringify({grant,deviceName:'Synthetic quota device',capabilities:['desktop_sync']})}),{...baseEnv,DB:db}));
 });
 it('HTTP200 sequential quota preserves confirmed prefix and stops without diagnostic queries',async()=>{
  const device='device_quota_batch',token='synthetic-quota-batch-token';
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
  await env.DB.batch([
   env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic device','desktop',1,0,?2)").bind(device,new Date().toISOString()),
   env.DB.prepare('INSERT INTO device_access_tokens(token_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)').bind(hash,device,new Date().toISOString(),new Date(Date.now()+600000).toISOString()),
  ]);
  let batches=0,blocked=false,diagnostics=0;
  const db={prepare:(sql:string)=>{if(blocked)diagnostics++;return env.DB.prepare(sql);},batch:async(statements:D1PreparedStatement[])=>{if(++batches===2){blocked=true;throw quota();}return env.DB.batch(statements);}} as D1Database;
  const mutations=[1,2].map(n=>{const m=JSON.parse(rawCreate);m.deviceId=device;m.deviceSequence=n;m.mutationId='mutation_quota_batch_'+n;m.entityId='task_quota_batch_'+n;m.payload.task.id=m.entityId;return m;});
  const response=await worker.fetch(new Request('https://cloud.example/v1/tasks/mutations/batch',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({protocolVersion:1,mutations})}),{...baseEnv,DB:db});
  expect(response.status).toBe(200);const result=await response.json() as any;
  expect(result.receipts).toHaveLength(1);expect(result.receipts[0].mutationId).toBe(mutations[0].mutationId);
  expect(result.processedCount).toBe(1);expect(result.stoppedAt).toBe(1);expect(result.error.quota.resource).toBe('d1_rows_written');expect(diagnostics).toBe(0);
  expect(await env.DB.prepare('SELECT last_sequence FROM device_sequences WHERE device_id=?1').bind(device).first('last_sequence')).toBe(1);
 });
});
