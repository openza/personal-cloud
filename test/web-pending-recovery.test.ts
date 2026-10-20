import {env,exports} from 'cloudflare:workers';
import {describe,it,expect} from 'vitest';
import {recoverWebPending} from '../src/web-pending-recovery.ts';
import {applyWorkspaceMutation} from '../src/workspace-mutations.ts';
import {applyMutation} from '../src/mutation-apply.ts';
import {parseWorkspaceMutation} from '../src/workspace-protocol.ts';
import {parseTaskMutation,canonicalize,computeCanonicalHash} from '../src/protocol.ts';
import rawCreate from './fixtures/valid-task-create.json?raw';
let next=0;const at='2026-10-20T00:00:00.000Z';
async function fixture(){const n=++next,id='project.recovery.'+n;await env.DB.prepare("INSERT INTO projects(id,space_id,name,created_at,updated_at) VALUES(?1,'space_default','Synthetic recovery',?2,?2)").bind(id,at).run();const m={protocolVersion:1,product:'tasks',instanceId:env.INSTANCE_ID,deviceId:'web_recovery_'+n,mutationId:'mutation.recovery.'+n,deviceSequence:1,operation:'project.delete',entityId:id,baseEntityVersion:1,payload:{},clientCreatedAt:at};const raw=JSON.stringify(m);return{m,raw,parsed:parseWorkspaceMutation(raw,env.INSTANCE_ID),hash:await computeCanonicalHash(raw)};}
const request=(m:any,action='check',hash?:string)=>JSON.stringify({protocolVersion:1,action,mutation:m,...(hash?{canonicalHash:hash}:{})});
const recover=(f:any,action='check',db=env.DB)=>recoverWebPending(db,env.INSTANCE_ID,request(f.m,action,action==='cancel'?f.hash:undefined));
function otherCreate(f:any){const m=JSON.parse(rawCreate);Object.assign(m,{instanceId:env.INSTANCE_ID,deviceId:'device.other.'+(++next),mutationId:f.m.mutationId,entityId:'task.other.'+next});m.payload.task.id=m.entityId;return{m,raw:JSON.stringify(m)};}
describe.sequential('explicit owner Web pending recovery',()=>{
 it('checks and cancels an unapplied exact envelope without task/history changes, preserving immutable proof',async()=>{
  const f=await fixture();expect(await recover(f)).toMatchObject({state:'unapplied',canCancel:true,canonicalHash:f.hash});
  const cancelled=await recover(f,'cancel');expect(cancelled).toMatchObject({state:'cancelled',canonicalHash:f.hash});expect(await recover(f,'cancel')).toEqual(cancelled);
  expect(await env.DB.prepare('SELECT deleted_at FROM projects WHERE id=?1').bind(f.m.entityId).first('deleted_at')).toBeNull();
  expect(await env.DB.prepare('SELECT mutation_id FROM mutation_receipts WHERE mutation_id=?1').bind(f.m.mutationId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT mutation_id FROM changes WHERE mutation_id=?1').bind(f.m.mutationId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT canonical_request FROM web_pending_resolutions WHERE mutation_id=?1').bind(f.m.mutationId).first('canonical_request')).toBe(canonicalize(f.raw));
  expect(await env.DB.prepare('SELECT last_sequence FROM device_sequences WHERE device_id=?1').bind(f.m.deviceId).first('last_sequence')).toBe(1);
  await expect(env.DB.prepare('DELETE FROM web_pending_resolutions WHERE mutation_id=?1').bind(f.m.mutationId).run()).rejects.toThrow('immutable');
  await expect(applyWorkspaceMutation(env.DB,f.parsed,f.raw)).rejects.toMatchObject({code:'web_pending_cancelled'});
  const ordinary=otherCreate(f);Object.assign(ordinary.m,{deviceId:f.m.deviceId,deviceSequence:2,mutationId:'after.cancel.'+next});const raw=JSON.stringify(ordinary.m);expect((await applyMutation(env.DB,parseTaskMutation(raw,env.INSTANCE_ID),raw)).outcome).toBe('accepted');
 });
 it('confirms an already applied receipt and never undoes it',async()=>{
  const f=await fixture();await applyWorkspaceMutation(env.DB,f.parsed,f.raw);
  expect(await recover(f,'cancel')).toMatchObject({state:'applied',receipt:{mutationId:f.m.mutationId,outcome:'duplicate'}});
  expect(await env.DB.prepare('SELECT deleted_at FROM projects WHERE id=?1').bind(f.m.entityId).first('deleted_at')).not.toBeNull();
  expect(await env.DB.prepare('SELECT mutation_id FROM web_pending_resolutions WHERE mutation_id=?1').bind(f.m.mutationId).first()).toBeNull();
 });
 it('lets cancellation win before an already-preflighted original domain batch',async()=>{
  const f=await fixture();let raced=false;
  const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{if(!raced){raced=true;expect((await recover(f,'cancel')).state).toBe('cancelled');}return env.DB.batch(statements);}}as D1Database;
  await expect(applyWorkspaceMutation(db,f.parsed,f.raw)).rejects.toMatchObject({code:'web_pending_cancelled'});
  expect(await env.DB.prepare('SELECT deleted_at FROM projects WHERE id=?1').bind(f.m.entityId).first('deleted_at')).toBeNull();
 });
 it('lets the original win after a stale check and before the cancellation transaction',async()=>{
  const f=await fixture();let raced=false;
  const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{if(!raced){raced=true;await applyWorkspaceMutation(env.DB,f.parsed,f.raw);}return env.DB.batch(statements);}}as D1Database;
  expect(await recover(f,'cancel',db)).toMatchObject({state:'applied',receipt:{mutationId:f.m.mutationId}});
  expect(await env.DB.prepare('SELECT mutation_id FROM web_pending_resolutions WHERE mutation_id=?1').bind(f.m.mutationId).first()).toBeNull();
 });
 it('rolls back a different device/operation using the cancelled global mutation ID even if already in flight',async()=>{
  const f=await fixture(),other=otherCreate(f);let raced=false;
  const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{if(!raced){raced=true;await recover(f,'cancel');}return env.DB.batch(statements);}}as D1Database;
  await expect(applyMutation(db,parseTaskMutation(other.raw,env.INSTANCE_ID),other.raw)).rejects.toThrow();
  expect(await env.DB.prepare('SELECT id FROM tasks WHERE id=?1').bind(other.m.entityId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT last_sequence FROM device_sequences WHERE device_id=?1').bind(other.m.deviceId).first()).toBeNull();
 });
 it('rolls back cancellation when another device already committed the same global ID with different content',async()=>{
  const f=await fixture(),other=otherCreate(f);let raced=false;
  const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{if(!raced){raced=true;await applyMutation(env.DB,parseTaskMutation(other.raw,env.INSTANCE_ID),other.raw);}return env.DB.batch(statements);}}as D1Database;
  await expect(recover(f,'cancel',db)).rejects.toMatchObject({code:'mutation_id_reused'});
  expect(await env.DB.prepare('SELECT mutation_id FROM device_sequence_claims WHERE device_id=?1').bind(f.m.deviceId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT mutation_id FROM web_pending_resolutions WHERE mutation_id=?1').bind(f.m.mutationId).first()).toBeNull();
 });
 it('requires exact check hash, Web scope, current instance and a next sequence',async()=>{
  const f=await fixture();await expect(recoverWebPending(env.DB,env.INSTANCE_ID,request(f.m,'cancel'))).rejects.toMatchObject({code:'invalid_request'});
  await expect(recoverWebPending(env.DB,env.INSTANCE_ID,request(f.m,'cancel','0'.repeat(64)))).rejects.toMatchObject({code:'invalid_request'});
  await expect(recoverWebPending(env.DB,'other',request(f.m))).rejects.toMatchObject({code:'instance_mismatch'});
  await expect(recoverWebPending(env.DB,env.INSTANCE_ID,request({...f.m,deviceId:'device.desktop'}))).rejects.toMatchObject({code:'invalid_request'});
  expect(await recoverWebPending(env.DB,env.INSTANCE_ID,request({...f.m,deviceSequence:3},'check'))).toMatchObject({state:'unknown',canCancel:false});
 });
 it('rechecks next sequence inside the transaction and rolls back an otherwise successful claim',async()=>{
  const f=await fixture();let raced=false;
  const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{if(!raced){raced=true;await env.DB.prepare('INSERT INTO device_sequences(device_id,last_sequence) VALUES(?1,2)').bind(f.m.deviceId).run();}return env.DB.batch(statements);}}as D1Database;
  expect(await recover(f,'cancel',db)).toMatchObject({state:'unknown',canCancel:false});
  expect(await env.DB.prepare('SELECT mutation_id FROM device_sequence_claims WHERE device_id=?1').bind(f.m.deviceId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT mutation_id FROM web_pending_resolutions WHERE mutation_id=?1').bind(f.m.mutationId).first()).toBeNull();
 });
 it('requires a live owner session and CSRF for the endpoint',async()=>{
  const f=await fixture(),url='https://personal-cloud.local/auth/web-pending-change';
  expect((await exports.default.fetch(url,{method:'POST',body:request(f.m)})).status).toBe(401);
  // A device access token cannot substitute for the owner session either.
  expect((await exports.default.fetch(url,{method:'POST',headers:{authorization:'Bearer synthetic'},body:request(f.m)})).status).toBe(401);
  const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
  const now=new Date().toISOString(),expires=new Date(Date.now()+600000).toISOString(),owner='owner.recovery.'+next,session='synthetic-recovery-session-'+next,csrf='synthetic-recovery-csrf-'+next;
  await env.DB.batch([
   env.DB.prepare("INSERT INTO owner_credentials(credential_id,display_name,public_key_jwk,created_at) VALUES(?1,'Synthetic recovery','{}',?2)").bind(owner,now),
   env.DB.prepare('INSERT INTO web_sessions(session_hash,credential_id,csrf_hash,created_at,rotated_at,expires_at,absolute_expires_at) VALUES(?1,?2,?3,?4,?4,?5,?5)').bind(await hash(session),owner,await hash(csrf),now,expires),
   env.DB.prepare('INSERT INTO web_sessions(session_hash,credential_id,csrf_hash,created_at,rotated_at,expires_at,absolute_expires_at) VALUES(?1,?2,?3,?4,?4,?4,?4)').bind(await hash(session+'-expired'),owner,await hash(csrf),new Date(Date.now()-1000).toISOString()),
  ]);
  const post=(cookie:string,token?:string,origin='https://personal-cloud.local',action='check')=>exports.default.fetch(url,{method:'POST',headers:{cookie:'__Host-openza_session='+cookie,origin,...(token?{'x-openza-csrf':token}:{})},body:request(f.m,action,action==='cancel'?f.hash:undefined)});
  expect((await post(session)).status).toBe(403);expect((await post(session+'-expired',csrf)).status).toBe(401);expect((await post(session,csrf,'https://other.example')).status).toBe(403);
  const checked=await post(session,csrf);expect(checked.status).toBe(200);expect(await checked.json()).toMatchObject({state:'unapplied',canCancel:true,canonicalHash:f.hash});
  const cancelled=await post(session,csrf,'https://personal-cloud.local','cancel');expect(cancelled.status).toBe(200);const body=await cancelled.json()as any;expect(body.state).toBe('cancelled');expect(JSON.stringify(body)).not.toMatch(/SELECT|workspace_guards|canonical_request/);
 });
});
