import {env,exports} from 'cloudflare:workers';
import {describe,it,expect,beforeEach} from 'vitest';
import {parseCatchupReport,reportCatchupStatus,readCatchupStatus,webFanoutReservation} from '../src/sync-catchup-status.ts';
const t0=new Date('2026-10-20T23:55:00.000Z');let next=0;
async function device(){const id='device.catchup.'+(++next);await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic catchup','desktop',1,0,?2)").bind(id,t0.toISOString()).run();return id;}
const report=(seq:number,state='idle',pending=0)=>JSON.stringify({protocolVersion:1,reportSequence:seq,state,pending});
describe.sequential('current catchup is separate from terminal initial upload',()=>{
 beforeEach(async()=>{await env.DB.batch([env.DB.prepare('DELETE FROM web_fanout_budget'),env.DB.prepare("UPDATE devices SET can_sync=0 WHERE device_id LIKE 'device.catchup.%'")]);});
 it('validates strict reports and never accepts an unknown client error or extra field',()=>{
  for(const value of [{protocolVersion:1,reportSequence:0,state:'idle',pending:0},{protocolVersion:1,reportSequence:1,state:'complete',pending:0},{protocolVersion:1,reportSequence:1,state:'idle',pending:-1},{protocolVersion:1,reportSequence:1,state:'idle',pending:0,errorCode:'local_budget_exceeded'}])expect(()=>parseCatchupReport(JSON.stringify(value))).toThrow();
 });
 it('uses server completion time on first idle and preserves it through later idle heartbeats',async()=>{
  const id=await device();expect(await reportCatchupStatus(env.DB,id,report(1),t0)).toMatchObject({accepted:true,reportSequence:1,updatedAt:t0.toISOString()});
  expect((await readCatchupStatus(env.DB,t0)).webFanout).toMatchObject({eligible:false,notBefore:'2026-10-21T00:00:00.000Z',remainingCredits:1000});
  const midnight=new Date('2026-10-21T00:00:00.000Z');await reportCatchupStatus(env.DB,id,report(2),midnight);
  const after=await readCatchupStatus(env.DB,midnight);expect(after.webFanout).toMatchObject({eligible:true,remainingCredits:12000});expect(after.devices[0].finishedAt).toBe(t0.toISOString());
  await reportCatchupStatus(env.DB,id,report(3,'catching_up',10),midnight);expect((await readCatchupStatus(env.DB,midnight)).state).toBe('catching_up');
  await reportCatchupStatus(env.DB,id,report(4),midnight);expect((await readCatchupStatus(env.DB,midnight)).webFanout.notBefore).toBe('2026-10-22T00:00:00.000Z');
 });
 it('rejects late report replay without refreshing stale status and returns authoritative sequence',async()=>{
  const id=await device();await reportCatchupStatus(env.DB,id,report(9,'catching_up',10),t0);
  const later=new Date(t0.valueOf()+900000);
  expect(await reportCatchupStatus(env.DB,id,report(8),later)).toEqual({protocolVersion:1,accepted:false,reportSequence:9,updatedAt:t0.toISOString()});
  expect((await readCatchupStatus(env.DB,later)).state).toBe('unknown');
 });
 it('uses one shared cumulative small allowance for missing/stale reports and ordinary small work',async()=>{
  await device();const at=new Date(t0);
  await env.DB.batch([await webFanoutReservation(env.DB,600,at)]);
  expect((await readCatchupStatus(env.DB,at)).webFanout.remainingCredits).toBe(400);
  await expect(webFanoutReservation(env.DB,401,at)).rejects.toMatchObject({code:'web_fanout_deferred'});
  await expect(webFanoutReservation(env.DB,12001,at)).rejects.toMatchObject({code:'web_fanout_too_large'});
 });
 it('rechecks allowance atomically when two tabs both passed preflight',async()=>{
  await device();const a=await webFanoutReservation(env.DB,600,t0),b=await webFanoutReservation(env.DB,600,t0);
  await env.DB.batch([a]);await expect(env.DB.batch([b])).rejects.toThrow('web_fanout_cap');
  expect(await env.DB.prepare('SELECT credits FROM web_fanout_budget WHERE day=?1').bind('2026-10-20').first('credits')).toBe(600);
 });
 it('rechecks catchup eligibility atomically and replenishes the shared cap at UTC midnight',async()=>{
  const id=await device();await reportCatchupStatus(env.DB,id,report(1),new Date('2026-10-19T23:59:00.000Z'));await reportCatchupStatus(env.DB,id,report(2),t0);
  const allowed=await webFanoutReservation(env.DB,1200,t0);await reportCatchupStatus(env.DB,id,report(3,'catching_up',8),t0);
  await expect(env.DB.batch([allowed])).rejects.toThrow('web_fanout_cap');
  await env.DB.batch([await webFanoutReservation(env.DB,1000,t0)]);
  await env.DB.batch([await webFanoutReservation(env.DB,1000,new Date('2026-10-21T00:00:00.000Z'))]);
 });
 it('authenticates report ownership and exposes no report row through anonymous GET',async()=>{
  const id=await device(),token='synthetic-catchup-token',hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
  await env.DB.prepare('INSERT INTO device_access_tokens(token_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)').bind(hash,id,new Date().toISOString(),new Date(Date.now()+600000).toISOString()).run();
  const request=(headers:Record<string,string>,body:string)=>exports.default.fetch('https://personal-cloud.local/sync/catchup-status',{method:'POST',headers,body});
  expect((await request({},report(1))).status).toBe(401);
  expect((await request({authorization:'Bearer '+token},JSON.stringify({...JSON.parse(report(1)),deviceId:'other'}))).status).toBe(400);
  const accepted=await request({authorization:'Bearer '+token},report(1));expect(accepted.status).toBe(200);expect(await accepted.json()).toMatchObject({accepted:true,reportSequence:1});
  expect((await exports.default.fetch('https://personal-cloud.local/sync/catchup-status')).status).toBe(401);
 });
});
