import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFanoutDrafts} from '../public/fanout-draft.js';
import {createMutationSender} from '../public/mutation-queue.js';
const locks={request:async(_name,fn)=>fn({})};
function harness(shared=new Map()){
 let time=Date.parse('2026-10-20T23:59:00.000Z'),eligible=false,available=true,missing=false,stale=false;
 const storage={getItem:key=>shared.get(key)??null,setItem:(key,value)=>shared.set(key,value),removeItem:key=>shared.delete(key)};
 const intent={instanceId:'instance',deviceId:'web',entityId:'p',baseEntityVersion:7,operation:'project.delete',payload:{}};
 const context={health:{capabilities:{fanoutBudget:{protocolVersion:1,requestHeader:'x-openza-fanout-bound'},catchupStatus:{protocolVersion:1,path:'/sync/catchup-status',staleAfterSeconds:900}}},payload:{tasks:Array.from({length:900},(_,i)=>({id:'task'+i,projectId:'p'})),projects:[{id:'p'}]}};
 const make=()=>createFanoutDrafts({storage,locks,origin:'https://synthetic.example',getContext:()=>missing?{}:context,getInstance:()=> 'instance',now:()=>time,readStatus:async()=>{
  if(!available)throw Error('Synthetic status failure');
  return{protocolVersion:1,serverReadAt:new Date(time-(stale?901000:0)).toISOString(),webFanout:{eligible,notBefore:'2026-10-21T00:00:00.000Z',dailyCredits:12000,catchupDailyCredits:1000,remainingCredits:eligible?12000:1000}};
 }});
 return{storage,shared,intent,make,setReady:()=>eligible=true,setTaskCount:n=>context.payload.tasks=Array.from({length:n},(_,i)=>({id:'task'+i,projectId:'p'})),advance:ms=>time+=ms,missing:()=>missing=true,stale:()=>stale=true,failStatus:()=>available=false};
}
test('new large work becomes a durable draft before canonical identity or sequence allocation, leaving ordinary edits available',async()=>{
 const h=harness(),gate=h.make();let identities=0;const sent=[];
 const sender=createMutationSender({storage:h.storage,locks,sequenceKey:'seq',makeId:()=> 'mutation'+(++identities),now:()=> '2026-10-20T23:59:00.000Z',beforeCreate:intent=>gate.prepare(intent),send:async body=>{sent.push(body);return{mutationId:body.mutationId,entityId:body.entityId,outcome:'accepted'};}});
 const i=h.intent;await assert.rejects(sender(i.instanceId,i.deviceId,i.entityId,i.baseEntityVersion,i.operation,i.payload),e=>e.code==='web_fanout_deferred');
 assert.equal(identities,0);assert.equal(h.storage.getItem('seq:instance:web:pending'),null);assert.equal(gate.draft().baseEntityVersion,7);
 await sender('instance','web','ordinary',1,'task.patch',{fields:{notes:'Synthetic'}});assert.equal(sent.length,1);assert.equal(sent[0].deviceSequence,1);assert.equal(gate.draft().entityId,'p');
});
test('draft reload keeps original target/version/payload; retry and explicit cancel never retarget it',async()=>{
 const h=harness(),gate=h.make();await assert.rejects(gate.prepare(h.intent));
 const original=JSON.stringify(gate.draft()),reload=h.make();assert.equal(JSON.stringify(reload.draft()),original);
 await assert.rejects(reload.prepare({...h.intent,entityId:'other'}));assert.equal(JSON.stringify(reload.draft()),original);
 h.advance(60000);h.setReady();await reload.prepare(h.intent);assert.equal(reload.draft().baseEntityVersion,7);
 await reload.confirmed({...h.intent,baseEntityVersion:8});assert.equal(JSON.stringify(reload.draft()),original);
 await reload.cancel();assert.equal(reload.draft(),null);
});
test('UTC allowance and cumulative small reservations survive reload without refunds or bypass by many small operations',async()=>{
 const h=harness(),gate=h.make(),small={operation:'project.delete'};
 for(let i=0;i<4;i++)await gate.reserve(small,220);
 await assert.rejects(h.make().reserve(small,220),e=>e.code==='web_fanout_deferred');
 h.advance(60000);await h.make().reserve(small,220);
 h.setReady();await h.make().reserve(small,10900);await assert.rejects(h.make().reserve(small,1000));
});
for(const scenario of ['missing','stale','failStatus'])test('unknown or unavailable status retains the large draft: '+scenario,async()=>{
 const h=harness();h[scenario]();const gate=h.make();await assert.rejects(gate.prepare(h.intent));assert.equal(gate.draft().entityId,'p');
});
test('canonical pending work stays exact and FIFO even when a new bulk draft gate would deny admission',async()=>{
 const h=harness();let prepare=0;
 const body={protocolVersion:1,product:'tasks',instanceId:'instance',deviceId:'web',mutationId:'original',deviceSequence:4,entityId:'p',baseEntityVersion:7,operation:'project.delete',payload:{},clientCreatedAt:'2026-10-19T00:00:00.000Z'};
 const exact=JSON.stringify(body);h.storage.setItem('seq:instance:web:pending',exact);
 const sender=createMutationSender({storage:h.storage,locks,sequenceKey:'seq',makeId:()=>{throw Error('Must not allocate');},now:()=>'',beforeCreate:()=>prepare++,send:async sent=>{assert.equal(JSON.stringify(sent),exact);throw Object.assign(new Error('Waiting for catchup; later writes wait'),{code:'web_fanout_deferred',status:409});}});
 await assert.rejects(sender('instance','web','ordinary',1,'task.patch',{}));assert.equal(prepare,0);assert.equal(h.storage.getItem('seq:instance:web:pending'),exact);
});
test('above-cap drafts give a Desktop route without consuming a canonical slot; corrupt durable state is preserved',async()=>{
 const h=harness();h.setReady();h.setTaskCount(1100);const contextIntent={...h.intent,payload:{}};
 const gate=h.make();await assert.rejects(gate.prepare(contextIntent),e=>e.code==='web_fanout_too_large');assert.equal(gate.draft().needsDesktop,true);
 const key=[...h.shared.keys()][0];h.shared.set(key,'corrupt');await assert.rejects(gate.prepare(contextIntent));assert.equal(h.shared.get(key),'corrupt');
});
test('confirming another applied change cannot silently erase a retained cancelled original',async()=>{
 const h=harness(),gate=h.make();await assert.rejects(gate.prepare(h.intent));
 const body={...h.intent,protocolVersion:1,product:'tasks',mutationId:'cancelled-original',deviceSequence:1,clientCreatedAt:'2026-10-20T00:00:00.000Z'},raw=JSON.stringify(body);
 await gate.preserveCancelled({body,raw,canonicalHash:'a'.repeat(64),cancelledAt:'2026-10-20T23:59:00.000Z'});
 await gate.confirmed(h.intent);assert.equal(gate.draft().originalRaw,raw);assert.equal(gate.draft().resolution,'cancelled');
 await gate.cancel();assert.equal(gate.draft(),null);
});
