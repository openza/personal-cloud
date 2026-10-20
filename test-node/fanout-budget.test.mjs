import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mutationCredits,requestCredits,requestFanoutBound,fanoutBudget} from '../public/dispatch-cost.js';
import {createOwnerApi} from '../public/owner-api.js';
import {createMutationSender} from '../public/mutation-queue.js';
import {createCloudBrake} from '../public/cloud-brake.js';
const fixture=JSON.parse(readFileSync(new URL('../test/fixtures/fanout-budget-v1.json',import.meta.url)));
const capability=fixture.capability,health={capabilities:{fanoutBudget:capability}};
const mutation={operation:'project.delete',entityId:'p',mutationId:'unchanged',deviceSequence:1,payload:{}};
test('shared fanout fixture is additive and does not clamp over-day costs',()=>{
 assert.deepEqual(fanoutBudget,{...capability,baseCredits:fixture.baseCredits,perEntityCredits:fixture.perEntityCredits});
 for(const operation of ['project.delete','task.moveTree']){
  for(const item of fixture.cases)assert.equal(mutationCredits({operation},item.bound),item.credits);
  assert.equal(mutationCredits({operation}),45000);
 }
 assert.equal(requestCredits('/v1/tasks/mutations/batch',{mutations:[mutation,mutation]},10),440);
});
test('only a verified matching capability and complete workspace enable request-local scaling',()=>{
 const payload={tasks:[{id:'a',projectId:'p'},{id:'b',parentId:'a',projectId:null}],projects:[{id:'p'},{id:'c',parentId:'p'}]};
 assert.equal(requestFanoutBound('/v1/tasks/mutations',mutation,{health,payload}),2);
 assert.equal(requestFanoutBound('/v1/tasks/mutations',{operation:'task.moveTree',entityId:'a'},{health,payload}),2);
 assert.equal(requestFanoutBound('/v1/tasks/mutations',{...mutation,entityId:'already-detached'},{health,payload}),4);
 for(const context of [{payload},{health:{capabilities:{fanoutBudget:{...capability,requestHeader:'different'}}},payload},{health,payload:{...payload,hasMore:true}}])assert.equal(requestFanoutBound('/v1/tasks/mutations',mutation,context),undefined);
});
const locks={request:async(_name,options,callback)=>(typeof options==='function'?options:callback)({})};
test('stale bound refreshes once, reestimates and retries identical serialized mutation with full attempt reservations',async()=>{
 let tasks=[{id:'a',projectId:'p'}],refreshes=0;const calls=[],reservations=[];
 const api=createOwnerApi({locks,getGeneration:()=>0,getCsrf:()=> 'csrf',setCsrf(){},getFanoutContext:()=>({health,payload:{tasks,projects:[{id:'p'}]}}),refreshFanout:async()=>{refreshes++;tasks.push({id:'b',projectId:'p'});},brake:{referenceTime:()=>Date.now(),run:async(_p,_n,send,credits)=>{reservations.push(credits);return send();}},fetch:async(path,options)=>{
  calls.push({path,...options});return calls.length===1?Response.json({error:fixture.error},{status:409}):Response.json({outcome:'accepted'});
 }});
 await api('/v1/tasks/mutations',{method:'POST',csrf:true,body:mutation});
 assert.equal(refreshes,1);assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);
 assert.deepEqual(calls.map(c=>c.headers[capability.requestHeader]),['1','2']);assert.deepEqual(reservations,[112,124]);
});
test('repeated stale bounds retain the exact browser pending envelope and stop the retry loop',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};let calls=0,refreshes=0;
 const api=createOwnerApi({locks,getGeneration:()=>0,getCsrf:()=> 'csrf',setCsrf(){},getFanoutContext:()=>({health,payload:{tasks:[],projects:[{id:'p'}]}}),refreshFanout:async()=>{refreshes++;},fetch:async()=>{calls++;return Response.json({error:fixture.error},{status:409});}});
 const sender=createMutationSender({storage,locks,sequenceKey:'sequence',makeId:()=> 'stable-id',now:()=> '2026-10-20T00:00:00.000Z',send:body=>api('/v1/tasks/mutations',{method:'POST',csrf:true,body})});
 await assert.rejects(sender('instance','device','p',1,'project.delete',{}),e=>e.code==='fanout_bound_exceeded');
 const saved=values.get('sequence:instance:device:pending');assert.equal(JSON.parse(saved).mutationId,'stable-id');assert.equal(calls,2);assert.equal(refreshes,1);
 await assert.rejects(sender('instance','device','p',1,'project.delete',{}));assert.equal(values.get('sequence:instance:device:pending'),saved);
});
test('legacy cloud sends no hint and reserves the conservative whole-day cost',async()=>{
 let sent;const costs=[];
 const api=createOwnerApi({locks,getGeneration:()=>0,getCsrf:()=> 'csrf',setCsrf(){},brake:{referenceTime:()=>Date.now(),run:async(_p,_n,action,cost)=>{costs.push(cost);return action();}},fetch:async(_p,options)=>{sent=options;return Response.json({outcome:'accepted'});}});
 await api('/v1/tasks/mutations',{method:'POST',body:mutation});assert.equal(sent.headers[capability.requestHeader],undefined);assert.deepEqual(costs,[45000]);
});
test('upload-only holds permit metered health/auth/task reads while HTTP, storage and actual daily quota remain brakes',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};let time=Date.parse('2026-10-20T12:00:00.000Z');
 const brake=createCloudBrake({origin:'https://synthetic.example',storage,locks,now:()=>time,monotonic:()=>time,limits:{requests:4,envelopes:10,writeCredits:100}});
 await assert.rejects(brake.run('/v1/tasks/mutations',1,async()=>{},112));assert.equal(brake.status().code,'local_operation_budget_exceeded');
 let reads=0;for(const path of ['/health','/auth/session','/v1/tasks','/sync/checkpoints'])await brake.run(path,0,async()=>{reads++;return{response:{ok:true},result:{status:'ok',protocolVersion:1,product:'tasks'}};});
 assert.equal(reads,4);assert.equal(brake.status().remaining.requests,0);
 await assert.rejects(brake.run('/v1/tasks',0,async()=>{reads++;}));assert.equal(reads,4);assert.equal(brake.status().resource,'requests');
 time+=86400000;await brake.run('/health',0,async()=>({response:{ok:true},result:{status:'ok',protocolVersion:1,product:'tasks'}}));
 await brake.pause({protocolVersion:1,resource:'d1_rows_read',resetAt:'2026-10-22T00:00:00.000Z'},time);
 await assert.rejects(brake.run('/v1/tasks',0,async()=>{reads++;}));assert.equal(reads,4);
});
