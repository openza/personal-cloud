import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMutationSender} from '../public/mutation-queue.js';

function harness(send, shared = {}, getGeneration = () => 0) {
  const map=shared.map||new Map();
  const storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
  let tail=Promise.resolve();
  const locks=shared.locks||{request:(_key,action)=>{const p=tail.then(action);tail=p.catch(()=>{});return p;}};
  let id=0;
  const sender=createMutationSender({storage,locks,send,getGeneration,sequenceKey:'sequence',makeId:()=>`mutation_${++id}`,now:()=>new Date(0).toISOString()});
  return {sender:(payload={notes:'change'},entity='task')=>sender('instance','web_device',entity,1,'task.updateOpenzaFields',payload),map,locks};
}
const receipt=b=>({outcome:'accepted',mutationId:b.mutationId,entityId:b.entityId,entityVersion:2});

test('lost accepted response replays the exact durable envelope across reload',async()=>{
  let committed;
  const first=harness(async b=>{committed=structuredClone(b);throw new TypeError('response lost');});
  await assert.rejects(first.sender(),/response lost/);
  assert.equal(first.map.get('sequence:instance:web_device'),undefined);
  const reloaded=harness(async b=>{assert.deepEqual(b,committed);return {...receipt(b),outcome:'duplicate'};},first);
  assert.equal((await reloaded.sender()).outcome,'duplicate');
  assert.equal(first.map.get('sequence:instance:web_device'),'2');
  assert.equal(first.map.has('sequence:instance:web_device:pending'),false);
});

test('replica-lock wait cancels before allocating or dispatching an old-session envelope',async()=>{
 let generation=0,release,calls=0;
 const locks={request:(_key,action)=>new Promise(resolve=>release=()=>resolve(action()))};
 const h=harness(async body=>{calls++;return receipt(body);},{locks},()=>generation);
 const pending=h.sender();generation++;release();await assert.rejects(pending,e=>e.code==='session_changed'&&!e.dispatched);
 assert.equal(calls,0);assert.equal(h.map.size,0);
});
test('cancellation at the owner lock removes only a new unsubmitted envelope',async()=>{
 const h=harness(async()=>{throw Object.assign(Error('session changed'),{code:'session_changed',dispatched:false});});
 await assert.rejects(h.sender());assert.equal(h.map.has('sequence:instance:web_device:pending'),false);
 let fail=true;const uncertain=harness(async()=>{throw fail?new TypeError('lost'):Object.assign(Error('session changed'),{code:'session_changed',dispatched:false});});
 await assert.rejects(uncertain.sender());const saved=uncertain.map.get('sequence:instance:web_device:pending');fail=false;
 await assert.rejects(uncertain.sender());assert.equal(uncertain.map.get('sequence:instance:web_device:pending'),saved);
});
test('a dispatched old-session write retains its exact envelope for reconciliation',async()=>{
 let generation=0;
 const h=harness(async body=>{generation++;return receipt(body);},{},()=>generation);
 await assert.rejects(h.sender(),e=>e.code==='session_changed'&&e.dispatched);
 const saved=JSON.parse(h.map.get('sequence:instance:web_device:pending'));
 const next=harness(async body=>{assert.deepEqual(body,saved);return {...receipt(body),outcome:'duplicate'};},h,()=>generation);
 await next.sender();assert.equal(h.map.has('sequence:instance:web_device:pending'),false);assert.equal(h.map.get('sequence:instance:web_device'),'2');
});
test('tabs sharing an actor serialize envelopes and allocate distinct sequences',async()=>{
  const seen=[];
  const a=harness(async b=>{seen.push(b);await Promise.resolve();return receipt(b);});
  const b=harness(async body=>{seen.push(body);return receipt(body);},a);
  await Promise.all([a.sender({notes:'a'}),b.sender({notes:'b'})]);
  assert.deepEqual(seen.map(b=>b.deviceSequence),[1,2]);
});
test('a different next action first reconciles pending write and requests refresh',async()=>{
  let count=0;
  const h=harness(async b=>{if(++count===1)throw new TypeError('lost');return receipt(b);});
  await assert.rejects(h.sender(),/lost/);
  await assert.rejects(h.sender({notes:'next'},'another'),e=>e.code==='pending_reconciled');
  assert.equal(count,2);
  assert.equal(h.map.get('sequence:instance:web_device'),'2');
});
test('auth failures retain pending envelopes; definitive rejection releases them',async()=>{
  let status=401;
  const h=harness(async()=>{throw Object.assign(new Error('rejected'),{status});});
  await assert.rejects(h.sender());assert.equal(h.map.has('sequence:instance:web_device:pending'),true);
  status=409;await assert.rejects(h.sender());assert.equal(h.map.has('sequence:instance:web_device:pending'),false);
  assert.equal(h.map.get('sequence:instance:web_device'),undefined);
});
test('explicit CSRF rejection cannot leave a cancelled task queued for a later action',async()=>{
 let rejected=true,accepted;
 const h=harness(async body=>{if(rejected)throw Object.assign(new Error('CSRF rejected before mutation'),{status:403,code:'csrf_failed'});accepted=body;return receipt(body);});
 await assert.rejects(h.sender({notes:'cancelled'},'first'));assert.equal(h.map.has('sequence:instance:web_device:pending'),false);
 rejected=false;await h.sender({notes:'next'},'second');assert.equal(accepted.entityId,'second');assert.equal(accepted.deviceSequence,1);
});
