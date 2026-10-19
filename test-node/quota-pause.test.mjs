import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCloudBrake} from '../public/cloud-brake.js';
import {createOwnerApi} from '../public/owner-api.js';
import {createMutationSender} from '../public/mutation-queue.js';
import {workers1027,typedQuota} from '../public/quota-errors.js';
import {dailyQuotaError} from '../src/daily-quota.ts';
import {instrumentD1} from '../scripts/d1-metrics.mjs';
import {dispatchLimits,operationCredits,mutationCredits,requestCredits} from '../public/dispatch-cost.js';
const fixture=JSON.parse(readFileSync(new URL('../test/fixtures/quota-pause-v1.json',import.meta.url)));
const costFixture=JSON.parse(readFileSync(new URL('../test/fixtures/dispatch-budget-v1.json',import.meta.url)));
test('canonical workload table and representative operation costs stay in sync',()=>{
 assert.deepEqual(dispatchLimits,costFixture.dailyLimits);assert.deepEqual(operationCredits,costFixture.operations);
 for(const item of costFixture.cases)assert.equal(mutationCredits(item),item.credits);
 assert.equal(requestCredits('/v1/tasks/mutations/batch',{mutations:costFixture.cases.slice(0,2)}),41);
});
function locks(){const tails=new Map(),busy=new Set();return{request(name,options,fn){if(typeof options==='function'){fn=options;options={};}
 if(options.ifAvailable&&busy.has(name))return Promise.resolve(fn(null));
 const current=(tails.get(name)??Promise.resolve()).then(async()=>{busy.add(name);try{return await fn({name});}finally{busy.delete(name);}});
 tails.set(name,current.catch(()=>{}));return current;}};}
function harness(shared={},limits={requests:100,envelopes:20}){
 const values=shared.values??new Map(),mutex=shared.mutex??locks();let time=shared.startAt??Date.parse(fixture.observedAt),ticks=time,broken=false;
 const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{if(broken)throw Error('storage unavailable');values.set(key,value);},removeItem:key=>values.delete(key)};
 const brake=createCloudBrake({origin:'https://synthetic.example',storage,locks:mutex,now:()=>time,monotonic:()=>ticks,limits});
 return{brake,storage,values,mutex,advance:ms=>{time+=ms;ticks+=ms;},wallJump:ms=>time+=ms,breakStorage:()=>broken=true,recoverStorage:()=>broken=false,time:()=>time,
  run:(path='/v1/tasks',envelopes=0,action=async()=>({response:{ok:true},result:{}}))=>brake.run(path,envelopes,action)};
}
for(const item of fixture.edgeCases)test('edge fixture: '+item.name,()=>{
 assert.equal(workers1027(item.status,new Headers(item.headers),item.body+' '.repeat(item.paddingBytes??0)),item.daily);
});
for(const item of fixture.d1Cases)test('D1 fixture: '+item.message.slice(0,70),()=>{
 assert.equal(dailyQuotaError(new Error(item.message),new Date(fixture.observedAt))?.quota.resource??null,item.resource);
});
test('typed quota validates protocol/resource/reset; successful task text cannot activate it',()=>{
 const payload={protocolVersion:1,product:'tasks',error:fixture.quotaError};assert.equal(typedQuota(payload,Date.parse(fixture.observedAt)).resource,'d1_rows_read');
 for(const resetAt of ['2026-10-21T00:00:00.000Z','2026-10-19T00:00:00.000Z','nonsense',undefined])assert.equal(typedQuota({...payload,error:{...fixture.quotaError,quota:{...fixture.quotaError.quota,resetAt}}},Date.parse(fixture.observedAt)).resetAt,fixture.resetAt);
 assert.equal(typedQuota({tasks:[{title:'daily_quota_exceeded'}]},Date.parse(fixture.observedAt)),null);
});
for(const skew of [-86400000,86400000])test('trusted UTC remaining duration survives local clock skew '+skew,async()=>{
 const h=harness({startAt:Date.parse(fixture.observedAt)+skew});const observed=Date.parse(fixture.observedAt);
 await h.brake.pause(fixture.quotaError.quota,observed);
 assert.equal(h.brake.remainingDelay(),12*3600_000);assert.equal(h.brake.status().cloudResetAt,fixture.resetAt);
 assert.equal(Date.parse(h.brake.status().resetAt),h.time()+12*3600_000);
});
test('clock rollback across restart cannot grant a fresh daily budget',async()=>{
 const a=harness({}, {requests:2,envelopes:5});await a.run();await a.run();
 const restarted=harness({...a,startAt:Date.parse(fixture.observedAt)-86400000},{requests:2,envelopes:5});
 await assert.rejects(restarted.run(),e=>e.code==='local_budget_exceeded');assert.equal(restarted.brake.status().remaining.requests,0);
});
for(const corrupt of [s=>s.instanceId={},s=>s.hold={code:'anything',resource:'requests',observedAt:fixture.observedAt,resetAt:fixture.resetAt,offset:0,failures:0,retryAt:null}])test('corrupt ledger identity cannot become a bypass',async()=>{
 const h=harness();await h.run();const key=[...h.values.keys()][0],state=JSON.parse(h.values.get(key));corrupt(state);h.values.set(key,JSON.stringify(state));
 const reloaded=harness(h);await assert.rejects(reloaded.run());assert.equal(reloaded.brake.status().code,'local_budget_state_invalid');
});
test('every common HTTP route is blocked while paused, including optional reporting and owner retries',async()=>{
 const h=harness();await h.brake.pause(fixture.quotaError.quota,h.time());let sends=0;
 const api=createOwnerApi({fetch:async()=>{sends++;return Response.json({});},locks:h.mutex,getGeneration:()=>0,getCsrf:()=> 'synthetic',setCsrf(){},brake:h.brake});
 for(const path of ['/health','/auth/status','/auth/session','/auth/session/rotate','/auth/pairing-grants','/auth/devices','/auth/recovery/begin','/sync/initial-status','/sync/checkpoints','/v1/provider/commands/claim','/v1/tasks/mutations'])await assert.rejects(api(path,{method:'POST',csrf:true,body:{}}));
 assert.equal(sends,0);
});
test('near UTC midnight brakes for remaining seconds and local signout survives reset/reload',async()=>{
 const h=harness();h.advance(12*3600_000-1000);await h.brake.pause(fixture.quotaError.quota,h.time());
 assert.equal(h.brake.remainingDelay(),1000);await h.brake.rememberSignOut();h.advance(1000);
 await h.run('/health',0,async()=>({response:{ok:true},result:{status:'ok',protocolVersion:1,product:'tasks'}}));
 assert.equal(h.brake.status(),null);assert.equal(h.brake.isLocallySignedOut(),true);
 const reload=harness(h);assert.equal(reload.brake.isLocallySignedOut(),true);await reload.brake.rememberSignIn();assert.equal(reload.brake.isLocallySignedOut(),false);
});
test('origin pause survives reload and blocked calls do not extend reset or spend dispatches',async()=>{
 const h=harness();await h.brake.pause(fixture.quotaError.quota,h.time());const stored=[...h.values.values()][0];
 const reloaded=harness(h);for(const path of ['/auth/status','/auth/session','/sync/initial-status','/v1/tasks','/v1/tasks/mutations'])await assert.rejects(reloaded.run(path),e=>e.code==='daily_quota_exceeded');
 assert.equal([...h.values.values()][0],stored);assert.equal(reloaded.brake.status().resetAt,fixture.resetAt);
});
test('a pause persisted while the accounting lock releases prevents the reserved send',async()=>{
 const h=harness(),request=h.mutex.request.bind(h.mutex);let inject=true,sends=0;
 h.mutex.request=(name,...args)=>request(name,...args).then(async result=>{
  if(name.endsWith(':account')&&inject){inject=false;await h.brake.pause(fixture.quotaError.quota,h.time());}return result;
 });
 await assert.rejects(h.run('/v1/tasks',0,async()=>{sends++;}),e=>e.code==='daily_quota_exceeded');
 assert.equal(sends,0);assert.equal(h.brake.status().remaining.requests,99);
});
test('atomic day reservations serialize tabs, charge retries/crashes and stop at independent envelope/request caps',async()=>{
 const a=harness({}, {requests:4,envelopes:2}),b=harness(a,{requests:4,envelopes:2});
 await Promise.all([a.run('/write',1),b.run('/write',1)]);await assert.rejects(a.run('/write',1),e=>e.code==='local_budget_exceeded');
 assert.equal(a.brake.status().remaining.envelopes,0);assert.equal(a.brake.status().remaining.requests,2);
 const retry=harness({}, {requests:2,envelopes:20});for(let i=0;i<2;i++)await assert.rejects(retry.run('/write',1,async()=>{throw Error('unknown result');}));
 await assert.rejects(retry.run(),e=>e.code==='local_budget_exceeded');assert.equal(retry.brake.status().remaining.requests,0);
});
test('reset uses monotonic elapsed time despite wall-clock jumps, one probe and capped backoff',async()=>{
 const h=harness();await h.brake.pause(fixture.quotaError.quota,h.time());h.wallJump(3*86400000);
 assert.equal(h.brake.remainingDelay(),12*3600_000);h.advance(12*3600_000);let release,calls=0;
 const pending=h.run('/health',0,()=>{calls++;return new Promise(resolve=>release=resolve);});await new Promise(setImmediate);
 await assert.rejects(h.run('/health'),e=>e.status===503);assert.equal(calls,1);
 release({response:{ok:false},result:{}});await pending;assert.equal(h.brake.remainingDelay(),30000);
 await assert.rejects(h.run('/health'));h.advance(30000);
 await h.run('/health',0,async()=>({response:{ok:true},result:{status:'ok',protocolVersion:1,product:'tasks'}}));assert.equal(h.brake.status(),null);
});
test('corrupt storage and persistence failure stop sends and report missing restart protection',async()=>{
 const h=harness();h.values.set('openza-cloud-brake-v1:https://synthetic.example','broken');let sent=0;
 await assert.rejects(h.run('/v1/tasks',0,async()=>{sent++;}));assert.equal(sent,0);assert.equal(h.brake.status().durable,false);
 const failed=harness();failed.breakStorage();await assert.rejects(failed.run('/v1/tasks',0,async()=>{sent++;}));assert.equal(sent,0);assert.equal(failed.brake.status().resource,'storage');
});
test('persistent storage failure at reset backs off without dispatching instead of scheduling a short retry loop',async()=>{
 const h=harness();let sends=0;h.breakStorage();await assert.rejects(h.run());h.advance(12*3600_000);
 for(const delay of [30000,60000,120000,240000,300000]){
  await assert.rejects(h.run('/health',0,async()=>{sends++;}));assert.equal(h.brake.remainingDelay(),delay);h.advance(delay);
 }
 assert.equal(sends,0);assert.equal(h.brake.status().durable,false);
});
test('missing Web Locks keeps a visible memory brake and bounded reset retries',async()=>{
 let time=Date.parse(fixture.observedAt),ticks=0,sends=0;
 const brake=createCloudBrake({origin:'https://synthetic.example',storage:{getItem:()=>null,setItem(){}},now:()=>time,monotonic:()=>ticks});
 await assert.rejects(brake.run('/health',0,async()=>{sends++;}));time+=12*3600_000;ticks+=12*3600_000;
 await assert.rejects(brake.run('/health',0,async()=>{sends++;}));assert.equal(brake.remainingDelay(),30000);assert.equal(sends,0);
});
test('storage recovery merges newer shared-day reservations before the resume probe and subsequent sends',async()=>{
 const limits={requests:5,envelopes:20,writeCredits:100},a=harness({},limits);await a.run();a.breakStorage();await assert.rejects(a.run());
 const b=harness(a,limits);a.advance(12*3600_000);b.advance(12*3600_000);
 for(let n=0;n<2;n++)await b.brake.run('/write',1,async()=>({}),25);
 a.recoverStorage();await a.run('/health',0,async()=>({response:{ok:true},result:{status:'ok',protocolVersion:1,product:'tasks'}}));
 await a.brake.run('/write',1,async()=>({}),25);await b.brake.run('/write',1,async()=>({}),25);
 await assert.rejects(a.run(),e=>e.code==='local_budget_exceeded');
 assert.equal(a.brake.status().remaining.requests,0);assert.equal(a.brake.status().remaining.writeCredits,0);
 const ledger=JSON.parse([...a.values.values()][0]);assert.equal(ledger.requests,5);assert.equal(ledger.writeCredits,100);
});
test('auth persistence during recovery cannot overwrite another tab same-day counters',async()=>{
 const a=harness();await a.run();a.breakStorage();await assert.rejects(a.run());const b=harness(a);
 await b.run();await b.run();a.recoverStorage();await a.brake.rememberSignOut();
 const ledger=JSON.parse([...a.values.values()][0]);assert.equal(ledger.requests,3);assert.equal(ledger.locallySignedOut,true);assert.equal(ledger.hold.resource,'storage');
});
test('a recovering memory brake never overwrites newly corrupt shared accounting',async()=>{
 const h=harness();h.breakStorage();await assert.rejects(h.run());h.recoverStorage();const key=[...h.values.keys()][0]??'openza-cloud-brake-v1:https://synthetic.example';h.values.set(key,'false');h.advance(12*3600_000);let sends=0;
 await assert.rejects(h.run('/health',0,async()=>{sends++;}));assert.equal(sends,0);assert.equal(h.values.get(key),'false');assert.equal(h.brake.remainingDelay(),30000);
});
test('HTTP200 quota batch persists gate while returning the receipt prefix unchanged',async()=>{
 const h=harness(),api=createOwnerApi({fetch:async()=>Response.json(fixture.batch,{headers:{date:new Date(h.time()).toUTCString()}}),locks:h.mutex,getGeneration:()=>0,getCsrf:()=> 'synthetic',setCsrf(){},brake:h.brake});
 const result=await api('/v1/tasks/mutations/batch',{method:'POST',csrf:true,body:{mutations:[{operation:'task.patch'},{operation:'task.patch'}]}});
 assert.deepEqual(result,fixture.batch);assert.equal(result.receipts.length,1);assert.equal(h.brake.status().resource,'d1_rows_written');
});
test('weighted reservations are atomic, retries/crashes spend credits, and whole-budget fanout waits for a fresh day',async()=>{
 const a=harness({}, {requests:100,envelopes:100,writeCredits:50}),b=harness(a,{requests:100,envelopes:100,writeCredits:50});
 await Promise.all([a.brake.run('/write',1,async()=>({}),25),b.brake.run('/write',1,async()=>({}),25)]);
 await assert.rejects(a.brake.run('/write',1,async()=>({}),16));assert.equal(a.brake.status().remaining.writeCredits,0);
 a.advance(12*3600_000);await a.run('/health',0,async()=>({response:{ok:true},result:{status:'ok',protocolVersion:1,product:'tasks'}}));
 await assert.rejects(a.brake.run('/write',1,async()=>{throw Error('unknown result');},50));
 await assert.rejects(a.brake.run('/write',1,async()=>({}),1));assert.equal(a.brake.status().remaining.writeCredits,0);
});
test('unknown or over-day compound operations stop visibly without automatic next-day retries or a send',async()=>{
 const h=harness();let sends=0;
 await assert.rejects(h.brake.run('/write',1,async()=>{sends++;},45001),e=>e.code==='local_operation_budget_exceeded');
 h.advance(4*86400000);await assert.rejects(h.run('/health'),e=>e.code==='local_operation_budget_exceeded');assert.equal(sends,0);
 const before=JSON.parse([...h.values.values()][0]);assert.equal(before.requests,0);assert.equal(before.writeCredits,0);
});
test('a quota response from a retired session still persists origin brake and keeps exact pending envelope',async()=>{
 const h=harness();let generation=0,release;
 const api=createOwnerApi({fetch:()=>new Promise(resolve=>release=resolve),locks:h.mutex,getGeneration:()=>generation,getCsrf:()=> 'synthetic',setCsrf(){},brake:h.brake});
 const sender=createMutationSender({storage:h.storage,locks:h.mutex,send:body=>api('/v1/tasks/mutations',{method:'POST',csrf:true,body}),getGeneration:()=>generation,sequenceKey:'synthetic-sequence',makeId:()=> 'mutation_synthetic',now:()=>fixture.observedAt});
 const pending=sender('instance','web','task',1,'task.delete',{});await new Promise(setImmediate);const before=h.values.get('synthetic-sequence:instance:web:pending');generation++;
 release(Response.json({protocolVersion:1,product:'tasks',error:fixture.quotaError},{status:503,headers:{date:new Date(h.time()).toUTCString()}}));
 await assert.rejects(pending,e=>e.code==='session_changed');assert.equal(h.brake.status().resource,'d1_rows_read');assert.equal(h.values.get('synthetic-sequence:instance:web:pending'),before);
});
test('instrumentation preserves first/batch values and records each real result once',async()=>{
 const events=[],result={success:true,results:[{value:7}],meta:{rows_read:3,rows_written:0}},statement={bind(){return this;},all:async()=>result,run:async()=>result};
 const db=instrumentD1({prepare:()=>statement,batch:async statements=>statements.map(()=>result)},e=>events.push(e));
 assert.equal(await db.prepare('SELECT').first('value'),7);await db.batch([db.prepare('A'),db.prepare('B')]);assert.equal(events.length,3);assert.equal(events.reduce((n,e)=>n+e.rowsRead,0),9);
});
