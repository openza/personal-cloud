import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const payload={instanceId:'synthetic',tasks:[{id:'task',providerDelivery:{state:'pending'}}],serverReadAt:'observation'};
function harness(){
 const timers=new Map();let next=0,reads=0,mode='visible',readOnly=0;
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 const context=vm.createContext({clearTaskTimers(){timers.clear();},cloudBrake:{status:()=>null},proactiveRefreshMs:300000,document:{get visibilityState(){return mode;}},setTimeout:(fn,delay)=>{timers.set(++next,{fn,delay});return next;},refreshTimer:null,freshnessTimer:null,loadTasks:()=>reads++,renderWorkspace:(_p,state)=>{if(state==='stale')readOnly++;},setStatus(){},setNotice(){}});
 vm.runInContext(source.match(/^function scheduleTaskTimers\([^]*?^function clearTaskTimers/m)[0].replace(/function clearTaskTimers$/,''),context);
 return{schedule:options=>context.scheduleTaskTimers(payload,'saved',options),timers,hide:()=>mode='hidden',reads:()=>reads,readOnly:()=>readOnly};
}
test('hidden completion schedules no full read; an already queued callback checks visibility again',()=>{
 const h=harness();h.schedule({background:true});const scheduled=[...h.timers.values()];h.hide();scheduled[0].fn();assert.equal(h.reads(),0);
 h.schedule({background:true});assert.equal(h.timers.size,1);[...h.timers.values()][0].fn();assert.equal(h.readOnly(),1);
});
test('five-minute idle cadence and aligned freshness deadline expire to read only',()=>{
 const h=harness();for(let n=0;n<4;n++)h.schedule({background:true});const scheduled=[...h.timers.values()];assert.deepEqual(scheduled.map(t=>t.delay),[300000,315000]);scheduled[1].fn();assert.equal(h.readOnly(),1);
 h.schedule({afterMutation:true});assert.deepEqual([...h.timers.values()].map(t=>t.delay),[300000,315000]);
});
test('focus/manual refresh and post-mutation confirmation still request current state immediately',()=>{
 const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(source,/window\.addEventListener\("focus",[^\n]+loadTasks\(/);
 assert.match(source,/\$\("#retry"\)\.addEventListener\("click",\(\)=>\{loadTasks\(\)/);
 assert.match(source,/async function finishMutations\([^\n]+await loadTasks\(\{afterMutation:true\}\)/);
});
