import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createCloudBrake} from '../public/cloud-brake.js';
import {createOwnerApi} from '../public/owner-api.js';
import {createFanoutDrafts} from '../public/fanout-draft.js';
import {createPendingWebRecovery} from '../public/pending-web-recovery.js';
import * as workspace from '../public/workspace-query.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').match(/^function applyCloudBrake\([^]*?^}/m)[0];
function harness({settings=false,signedOut=false,oversized=false,durable=true}={}){
 const nodes=new Map(),classes=new Set(),frames=[],notices=[],timers=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false});return nodes.get(id);};
 const pause={code:oversized?'local_operation_budget_exceeded':'daily_quota_exceeded',resource:oversized?'writeCredits':'d1_rows_read',instanceId:'synthetic',cloudResetAt:'2026-10-20T00:00:00.000Z',nextAttemptAt:'2026-10-20T00:00:00.000Z',remaining:{requests:9,envelopes:7,writeCredits:125},durable};
 const authPanel={hidden:settings},tasksPanel={hidden:true};
 const context=vm.createContext({cloudBrake:{status:()=>pause,isLocallySignedOut:()=>signedOut,remainingDelay:()=>12000},clearTimeout(){},cloudResumeTimer:null,cloudWasPaused:false,currentEditable:true,clearTaskTimers(){},sessionTimer:null,initialStatusMonitor:{stop(){}},lastConfirmed:null,readCache:()=>({payload:{instanceId:'synthetic'},savedAt:'saved'}),settingsRoute:settings,authPanel,tasksPanel,$:node,document:{body:{classList:{add:value=>classes.add(value)}}},renderWorkspace:(...args)=>frames.push(args),setDialogBusy(){},taskDialog:{classList:{contains:()=>false}},currentInstanceId:null,sequenceKey:'sequence',deviceId:'device',localStorage:{getItem:()=> 'synthetic-pending-envelope'},setupForm:node('setup'),recoveryForm:node('recovery'),signinActions:node('signin'),setStatus(){},setNotice:(...args)=>notices.push(args),authCopy:{},resumeCloud(){},setTimeout:(_fn,delay)=>timers.push(delay)});
 vm.runInContext(source,context);context.applyCloudBrake();return{context,frames,notices,timers,nodes,classes};
}
test('paused startup shows one cached readonly workspace, exact cloud reset and reserved/pending counts',()=>{
 const h=harness();assert.equal(h.context.tasksPanel.hidden,false);assert.equal(h.context.authPanel.hidden,true);assert.equal(h.nodes.get('#landing').hidden,true);assert.equal(h.classes.has('signed-in'),true);
 assert.equal(h.frames[0][1],'stale');assert.equal(h.context.currentEditable,false);
 const copy=h.notices[0][1];assert.match(copy,/2026-10-20T00:00:00.000Z/);assert.match(copy,/Browser pending changes: 1/);assert.match(copy,/9 requests, 7 envelopes, 125 write credits/);
 assert.equal(h.timers.length,1);assert.ok(h.timers[0]>=12500&&h.timers[0]<13000);
});
test('settings exposes pause feedback and hides authentication actions without opening cached tasks',()=>{
 const h=harness({settings:true});assert.equal(h.context.authPanel.hidden,false);assert.equal(h.frames.length,0);for(const id of ['setup','recovery','signin'])assert.equal(h.nodes.get(id).hidden,true);assert.match(h.context.authCopy.textContent,/Cloud reset:/);assert.equal(h.nodes.get('#auth-heading').textContent,'Daily cloud limit reached');
});
test('local signout does not reopen cached task data',()=>{
 const h=harness({signedOut:true});assert.equal(h.context.tasksPanel.hidden,true);assert.equal(h.frames.length,0);
});
test('over-day operation has visible retained-pending stop without an automatic timer',()=>{
 const h=harness({oversized:true,durable:false});assert.equal(h.timers.length,0);assert.match(h.notices[0][1],/Automatic retries are stopped/);assert.match(h.notices[0][1],/restart protection is unavailable/);
});
async function fullStartup(failure=null){
 const origin='https://synthetic.example',nodes=new Map(),storage=new Map();let sends=0;
 const now=new Date().toISOString(),reset=new Date();reset.setUTCHours(24,0,0,0);
 if(!failure)storage.set('openza-cloud-brake-v1:'+origin,JSON.stringify({version:1,origin,instanceId:'synthetic',day:now.slice(0,10),requests:1,envelopes:0,writeCredits:0,locallySignedOut:false,hold:{code:'daily_quota_exceeded',resource:'d1_rows_read',observedAt:now,resetAt:reset.toISOString(),cloudObservedAt:now,cloudResetAt:reset.toISOString(),offset:0,failures:0,retryAt:null}}));
 storage.set('openza-personal-cloud-last-known',JSON.stringify({savedAt:now,payload:{protocolVersion:1,product:'tasks',instanceId:'synthetic',tasks:[],spaces:[{id:'space',name:'Synthetic'}],projects:[],labels:[],serverReadAt:now}}));
 function element(){return{value:'',hidden:false,open:false,children:[],dataset:{},classList:{add(){},remove(){},toggle(){},contains:()=>false},setAttribute(){},getAttribute:()=>null,addEventListener(){},append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;},after(){},focus(){},querySelectorAll:()=>[],querySelector:()=>element()};}
 const node=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
 const localStorage={getItem:k=>{if(failure==='get')throw Error('Synthetic blocked storage');return storage.get(k)??null;},setItem:(k,v)=>{if(failure==='set')throw Error('Synthetic blocked storage');storage.set(k,v);},removeItem:k=>storage.delete(k)};
 const context=vm.createContext({...workspace,URL,Date,crypto:{randomUUID},localStorage,sessionStorage:{getItem:()=>null,removeItem(){}},location:{origin,pathname:'/',href:origin+'/',hash:''},history:{replaceState(){}},window:{addEventListener(){}},navigator:{locks:{request:async(_name,fn)=>fn({})}},document:{querySelector:node,querySelectorAll:()=>[],getElementById:id=>node('#'+id),createElement:element,addEventListener(){},body:{classList:{add(){}}}},createCloudBrake,createInitialStatusMonitor:()=>({stop(){}}),createMutationSender:()=>()=>{},createOwnerApi:()=>()=>{sends++;throw Error('HTTP forbidden during stored brake startup');},createOwnerSettings:()=>({}),createWorkspaceControls:()=>({render(){}}),createDetailAutosave:()=>({}),captureTaskRowInteraction:()=>null,restoreTaskRowInteraction(){},clearTimeout(){},setTimeout:()=>1,queueMicrotask,Option:class{constructor(text,value){this.text=text;this.value=value;}}});
 context.createFanoutDrafts=createFanoutDrafts;context.createPendingWebRecovery=createPendingWebRecovery;context.URLSearchParams=URLSearchParams;
 context.window.PublicKeyCredential=function(){};context.navigator.credentials={};node('#tasks-panel').hidden=true;
 context.createOwnerApi=options=>createOwnerApi({...options,fetch:async()=>{sends++;throw Error('HTTP forbidden during braked startup');}});
 let module=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'');
 // Keep the actual list rendering path, including its viewCopy access. These
 // unrelated layout/reference helpers are DOM-heavy and covered separately.
 for(const name of ['renderSidebar','hydrateReferences','updateWorkbenchLayout','updateToolbarLabels','renderActiveFilters']){
  module=module.replace('function '+name+'(','function unused_'+name+'(');context[name]=()=>{};
 }
 module=module.replace('start();','globalThis.startupResult=start();');
 vm.runInContext(module,context);await context.startupResult;
 return{node,sends,context};
}
test('full module startup with a stored brake renders the actual cached list after view constants initialize without HTTP',async()=>{
 const{node,sends}=await fullStartup();
 assert.equal(sends,0);assert.equal(node('#tasks-panel').hidden,false);assert.equal(node('#auth-panel').hidden,true);
 assert.equal(node('#workspace-title').textContent,'Inbox');assert.equal(node('#workspace-subtitle').textContent,'0 tasks');
 assert.equal(node('#task-list').children[0].className,'empty-state');
 assert.match(node('#notice').children[1].textContent,/Daily|Cloud requests paused/);
});
for(const failure of ['get','set'])test('full module startup with blocked storage '+failure+' shows the memory brake without HTTP or an unpersisted replica send',async()=>{
 const{node,sends}=await fullStartup(failure);assert.equal(sends,0);assert.match(node('#auth-copy').textContent,/Protection could not be saved/);assert.match(node('#auth-copy').textContent,/restart protection is unavailable/);
});
