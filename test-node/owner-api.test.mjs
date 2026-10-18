import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createMutationSender} from '../public/mutation-queue.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function harness(responses){const calls=[],locks=[],context=vm.createContext({csrfToken:'stale',navigator:{locks:{request:async(name,action)=>{locks.push(name);return action();}}},fetch:async(path,options)=>{calls.push({path,...options});let next=responses.shift();if(next instanceof Error)throw next;if(typeof next==='function')next=next(path,options);return{status:next.status,ok:next.status<400,json:async()=>next.body};}});vm.runInContext(source.match(/^async function api\(.*$/m)[0],context);return{context,calls,locks};}
test('explicit stale-CSRF rejection refreshes once and replays the identical mutation body under the owner lock',async()=>{
 const h=harness([{status:403,body:{error:{code:'csrf_failed'}}},{status:200,body:{csrfToken:'fresh'}},{status:201,body:{outcome:'accepted'}}]);
 assert.equal((await h.context.api('/v1/tasks/mutations',{method:'POST',csrf:true,body:{mutationId:'same',deviceSequence:4}})).outcome,'accepted');
 assert.deepEqual(h.calls.map(c=>c.path),['/v1/tasks/mutations','/auth/session','/v1/tasks/mutations']);assert.equal(h.calls[0].body,h.calls[2].body);assert.equal(h.calls[2].headers['x-openza-csrf'],'fresh');assert.deepEqual(h.locks,['openza-owner-session-write']);
});
for(const [status,code]of [[401,'unauthorized'],[403,'origin_failed'],[409,'version_conflict'],[500,'internal_error']])test(`${code} never triggers CSRF refresh or automatic mutation replay`,async()=>{
 const h=harness([{status,body:{error:{code}}}]);await assert.rejects(h.context.api('/write',{method:'POST',csrf:true,body:{}}),e=>e.code===code);assert.equal(h.calls.length,1);
});
test('a repeated CSRF rejection stops after one retry and preserves the exact failure',async()=>{
 const rejection={status:403,body:{error:{code:'csrf_failed'}}},h=harness([rejection,{status:200,body:{csrfToken:'fresh'}},rejection]);await assert.rejects(h.context.api('/write',{method:'POST',csrf:true,body:{}}),e=>e.code==='csrf_failed');assert.equal(h.calls.length,3);
});
test('failed saves replace Saving with an explicit unconfirmed outcome',async()=>{
 const seen=[],context=vm.createContext({currentInstanceId:'local',deviceId:'web',setStatus:(...a)=>seen.push(a),setNotice:(...a)=>seen.push(a),submitMutation:async()=>{throw Object.assign(new Error('Rejected'),{status:409});}});vm.runInContext(source.match(/^async function sendMutation\(.*$/m)[0],context);await assert.rejects(context.sendMutation('task',1,'task.patch',{}));assert.deepEqual(seen[1],['unavailable','Save not confirmed']);assert.equal(seen[2][0],'Change not confirmed');
});
function queuedApi(responses){const h=harness(responses),map=new Map();let id=0;const sender=createMutationSender({storage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)},locks:h.context.navigator.locks,sequenceKey:'sequence',makeId:()=>`mutation_${++id}`,now:()=>new Date(0).toISOString(),send:body=>h.context.api('/write',{method:'POST',csrf:true,body})});return{...h,map,send:entity=>sender('local','web',entity,1,'task.delete',{})};}
const acceptBody=(_path,options)=>{const body=JSON.parse(options.body);return{status:201,body:{outcome:'accepted',mutationId:body.mutationId,entityId:body.entityId}};};
for(const [name,failure]of [['network',new TypeError('offline')],['expired session',{status:401,body:{error:{code:'unauthorized'}}}],['server',{status:500,body:{error:{code:'internal_error'}}}],['malformed session',{status:200,body:{authenticated:true}}]])test(`CSRF rejection followed by ${name} refresh failure cannot queue a cancelled delete`,async()=>{
 const h=queuedApi([{status:403,body:{error:{code:'csrf_failed'}}},failure,acceptBody]);
 await assert.rejects(h.send('cancelled-task'),e=>e.status===403&&e.code==='csrf_failed');assert.equal(h.map.has('sequence:local:web:pending'),false);
 await h.send('intended-task');const last=JSON.parse(h.calls.at(-1).body);assert.equal(last.entityId,'intended-task');assert.equal(last.deviceSequence,1);
});
test('an uncertain retried mutation retains its exact envelope even though the earlier attempt was CSRF-rejected',async()=>{
 const h=queuedApi([{status:403,body:{error:{code:'csrf_failed'}}},{status:200,body:{csrfToken:'fresh'}},new TypeError('response lost'),acceptBody]);
 await assert.rejects(h.send('uncertain-task'),/response lost/);assert.equal(h.map.has('sequence:local:web:pending'),true);
 await assert.rejects(h.send('different-task'),e=>e.code==='pending_reconciled');assert.equal(h.calls[2].body,h.calls[3].body);assert.equal(JSON.parse(h.calls[3].body).entityId,'uncertain-task');
});
