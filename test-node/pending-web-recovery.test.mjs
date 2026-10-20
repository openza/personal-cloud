import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPendingWebRecovery,pendingCanonicalHash} from '../public/pending-web-recovery.js';
import {computeCanonicalHash} from '../src/protocol.ts';
const at='2026-10-20T00:00:00.000Z';
const original={protocolVersion:1,product:'tasks',instanceId:'instance',deviceId:'web_recovery',mutationId:'mutation.original',deviceSequence:1,operation:'project.delete',entityId:'p',baseEntityVersion:7,payload:{},clientCreatedAt:at};
async function harness(){
 const raw=JSON.stringify(original),key='seq:instance:web_recovery',values=new Map([[key,'1'],[key+':pending',raw]]),events=[];let generation=0,state='unapplied',broken=null,failDraft=false;
 const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>{if(broken===k)throw Error('Storage unavailable');events.push(['set',k,v]);values.set(k,v);},removeItem:k=>{if(broken===k)throw Error('Storage unavailable');events.push(['remove',k]);values.delete(k);}};
 const hash=await pendingCanonicalHash(raw),calls=[];
 const reply=()=>({protocolVersion:1,state,canonicalHash:hash,mutationId:original.mutationId,deviceId:original.deviceId,deviceSequence:1,canCancel:state==='unapplied',...(state==='cancelled'?{cancelledAt:at}:{}),...(state==='applied'?{receipt:{protocolVersion:1,product:'tasks',mutationId:original.mutationId,entityId:'p',entityVersion:8,changeSeq:9,serverAcceptedAt:at,outcome:'duplicate'}}:{})});
 const config={storage,sequenceKey:'seq',locks:{request:async(_k,fn)=>fn({})},getInstance:()=> 'instance',getDevice:()=> 'web_recovery',getGeneration:()=>generation,getCapability:()=>({protocolVersion:1,path:'/auth/web-pending-change'}),api:async(path,options)=>{calls.push({path,...options});if(options.body.action==='cancel')state='cancelled';return reply();},preserveCancelled:async s=>{if(failDraft)throw Error('Draft storage unavailable');events.push(['draft',s.raw,s.canonicalHash]);values.set('draft',JSON.stringify({raw:s.raw,hash:s.canonicalHash,cancelledAt:s.cancelledAt}));},onApplied:async()=>events.push(['applied'])};
 return{raw,key,values,events,calls,config,make:()=>createPendingWebRecovery(config),setState:s=>state=s,retire:()=>generation++,breakKey:k=>broken=k,failDraft:()=>failDraft=true,recoverStorage:()=>{broken=null;failDraft=false;},reply};
}
test('browser pending hash matches the canonical server hash for real ordering/unicode shapes',async()=>{
 for(const value of [original,{z:[null,true,1,'Synthetic 😀'],a:{b:2,a:'é'}},{'1':'numeric key','01':'text'}]){const raw=JSON.stringify(value);assert.equal(await pendingCanonicalHash(raw),await computeCanonicalHash(raw));}
 await assert.rejects(pendingCanonicalHash('{"bad":"\ud800"}'));
});
test('check does not cancel; explicit cancel preserves the complete original first, then advances and releases its slot',async()=>{
 const h=await harness(),recovery=h.make(),ticket=await recovery.check();assert.equal(ticket.result.state,'unapplied');assert.equal(h.calls.length,1);assert.equal(h.values.get(h.key+':pending'),h.raw);
 const result=await recovery.cancel(ticket);assert.equal(result.state,'cancelled');assert.equal(h.calls[1].body.canonicalHash,ticket.result.canonicalHash);assert.deepEqual(h.calls[1].body.mutation,original);
 assert.equal(h.events[0][0],'draft');assert.equal(h.events[1][1],h.key);assert.equal(h.events[2][0],'remove');assert.equal(h.values.get(h.key),'2');assert.equal(h.values.get(h.key+':pending'),undefined);assert.equal(JSON.parse(h.values.get('draft')).raw,h.raw);
});
test('already-applied and applied-after-a-stale-check are confirmed without cancellation or undo',async()=>{
 const h=await harness();h.setState('applied');const ticket=await h.make().check();assert.equal(ticket.result.state,'applied');assert.equal(h.values.get(h.key+':pending'),undefined);assert.equal(h.values.has('draft'),false);assert.equal(h.calls.length,1);
 const race=await harness(),recovery=race.make(),checked=await recovery.check();race.config.api=async()=>{race.setState('applied');return race.reply();};
 // Recreate the coordinator after swapping the simulated server transport.
 const result=await race.make().cancel(checked);assert.equal(result.state,'applied');assert.equal(race.values.has('draft'),false);assert.equal(race.values.get(race.key),'2');
});
test('unknown or mismatched proof keeps the exact pending envelope untouched',async()=>{
 const h=await harness();h.setState('unknown');await h.make().check();assert.equal(h.values.get(h.key+':pending'),h.raw);assert.deepEqual(h.events,[]);
 h.config.api=async()=>({...h.reply(),canonicalHash:'0'.repeat(64)});await assert.rejects(h.make().check());assert.equal(h.values.get(h.key+':pending'),h.raw);
});
test('draft storage failure preserves pending and a later check idempotently reconciles a server cancellation',async()=>{
 const h=await harness(),recovery=h.make(),ticket=await recovery.check();h.failDraft();await assert.rejects(recovery.cancel(ticket));assert.equal(h.values.get(h.key+':pending'),h.raw);assert.equal(h.values.get(h.key),'1');
 h.recoverStorage();await h.make().check();assert.equal(JSON.parse(h.values.get('draft')).raw,h.raw);assert.equal(h.values.get(h.key+':pending'),undefined);
});
test('partial local sequence/remove failure keeps full proof and safely resumes without decrementing sequence',async()=>{
 const h=await harness(),recovery=h.make(),ticket=await recovery.check();h.breakKey(h.key+':pending');await assert.rejects(recovery.cancel(ticket));assert.equal(h.values.get(h.key),'2');assert.equal(h.values.get(h.key+':pending'),h.raw);assert.equal(JSON.parse(h.values.get('draft')).raw,h.raw);
 h.recoverStorage();await h.make().check();assert.equal(h.values.get(h.key),'2');assert.equal(h.values.get(h.key+':pending'),undefined);
});
test('session retirement or changed pending bytes prevents stale cancellation and local release',async()=>{
 const h=await harness(),recovery=h.make(),ticket=await recovery.check();h.retire();await assert.rejects(recovery.cancel(ticket));assert.equal(h.calls.length,1);assert.equal(h.values.get(h.key+':pending'),h.raw);
 const changed=await harness(),checked=await changed.make().check();changed.values.set(changed.key+':pending',JSON.stringify({...original,entityId:'other'}));await assert.rejects(changed.make().cancel(checked));assert.equal(changed.calls.length,1);assert.equal(changed.values.get(changed.key),'1');
});
test('an invalid applied receipt or an uncertain local counter cannot release pending work',async()=>{
 const h=await harness();h.setState('applied');h.config.api=async()=>({...h.reply(),receipt:{...h.reply().receipt,entityVersion:0}});await assert.rejects(h.make().check());assert.equal(h.values.get(h.key+':pending'),h.raw);
 const counter=await harness();counter.setState('cancelled');counter.values.set(counter.key,'3');await assert.rejects(counter.make().check());assert.equal(counter.values.get(counter.key),'3');assert.equal(counter.values.get(counter.key+':pending'),counter.raw);
});
