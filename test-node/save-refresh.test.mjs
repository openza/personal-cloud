import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createDetailAutosave} from '../public/detail-autosave.js';
import {taskTextError,taskSaveError} from '../public/task-presentation.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const extract=(context,name)=>vm.runInContext(source.match(new RegExp(`^(?:async )?function ${name}\\(.*$`,'m'))[0],context);
class Element {
  value='';textContent='';disabled=false;hidden=false;open=false;isConnected=true;children=[];handlers={};attributes=new Set();
  classList={values:new Set(),toggle:(key,on)=>on?this.classList.values.add(key):this.classList.values.delete(key),contains:key=>this.classList.values.has(key),remove(){}};
  append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;this.textContent='';}
  addEventListener(name,action){this.handlers[name]=action;}hasAttribute(key){return this.attributes.has(key);}setAttribute(key){this.attributes.add(key);}
  querySelectorAll(){return [];}after(){}focus(){}checkValidity(){return true;}show(){this.open=true;}showModal(){this.open=true;}close(){this.open=false;}
}
function setup(){
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);},dialog=get('details-dialog');
  get('unsaved-dialog').querySelectorAll=()=>['keep-editing','discard-details','save-before-leaving'].map(get);
  dialog.querySelectorAll=()=>[...nodes].filter(([key])=>key.startsWith('details-')).map(([,node])=>node);
  const task={id:'task_a',title:'Original title',notes:'Original notes',spaceId:'space_a',projectId:null,workflowStatus:'inbox',priority:3,entityVersion:1,labels:[],plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,createdAt:'2026-10-01T00:00:00.000Z'};
  let server={...task},mode='online',writes=0,signouts=0,opens=0,error='',deferred;
  const payload=()=>({tasks:[{...server}],spaces:[{id:'space_a'}],projects:[],labels:[],instanceId:'local'}),cached=payload();
  const context=vm.createContext({cloudBrake:{status:()=>null},networkFailures:0,rotationFailures:0,ownerSessionGeneration:0,detailEditorGeneration:0,detailPendingSave:null,detailTaskUnavailable:false,detailTaskBaseline:null,detailBaseline:{},selectedTaskId:null,detailLabelBusy:false,currentEditable:true,csrfToken:'synthetic',currentPayload:cached,taskLoadInFlight:null,lastConfirmed:{payload:cached,savedAt:'before'},workspaceSupported:()=>true,taskTextError,taskSaveError,
    $:selector=>get(selector.slice(1)),detailsDialog:dialog,taskDialog:get('task-dialog'),document:{getElementById:get,activeElement:get('details-notes'),body:{classList:{remove(){}}}},localStorage:{setItem(){}},cacheKey:'cache',formatTime:v=>v,localDate:d=>d.toISOString().slice(0,10),fillSpaceSelect(){},fillProjectSelect(){},renderDetailLabels(){},renderSource(){},renderSubtasks(){},updateWorkbenchLayout(){},plannedEdit:()=>null,
    clearDialogError(){error='';},showDialogError(_dialog,message){error=message;},setNotice(){},setStatus(){},clearTaskTimers(){},scheduleTaskTimers(){},taskList:{setAttribute(){}},setTimeout:()=>0,clearTimeout(){},retryRefreshMs:1,sessionTimer:null,readCache:()=>cached,
    workspaceControls:{stop(){}},initialStatusMonitor:{stop(){}},pendingCreatedTaskId:null,deliveryCursor:null,featureHealth:null,tasksPanel:get('tasks-panel'),devicesPanel:get('devices-panel'),authPanel:get('auth-panel'),setupForm:get('setup-form'),recoveryForm:get('recovery-form'),signinActions:get('signin-actions'),authCopy:get('auth-copy'),
    api:async path=>{if(path==='/auth/signout')signouts++;return{};},rotateSession:async()=>{},readAllTasks:async()=>{if(mode==='lagging')return cached;if(mode==='offline')throw new Error('Read unavailable');if(mode==='unauthorized')throw Object.assign(new Error('Signed out'),{status:401});if(mode==='deferred')return await new Promise(resolve=>deferred=resolve);return payload();},
    sendMutation:async(id,version,operation,p)=>{writes++;assert.equal(id,task.id);assert.equal(operation,'task.patch');if(version!==server.entityVersion)throw Object.assign(new Error('Task changed'),{code:'version_conflict',status:409});server={...server,...p.fields,entityVersion:version+1};return{entityId:id,entityVersion:server.entityVersion,outcome:'accepted'};},
  });
  context.renderFanoutDraft=()=>{};context.renderPendingWebChange=()=>{};
  for(const name of ['loadTasks','loadTaskSnapshot'])vm.runInContext(source.match(new RegExp(`^async function ${name}\\([^]*?^}`,'m'))[0],context);
  for(const name of ['saveTask','finishMutations','signOut','openDetails','readDetailFields','captureDetailDraft','refreshOpenDetailsStatus','isCurrentDetail','showAcceptedDetailSave','confirmPendingDetailSave','lockWorkspaceDetailFields','setDialogBusy'])extract(context,name);
  context.renderWorkspace=(p,state)=>{context.currentPayload=p;context.currentEditable=state==='current';context.refreshOpenDetailsStatus();};
  const actualOpen=context.openDetails;context.openDetails=(...args)=>{opens++;return actualOpen(...args);};
  const autosave=createDetailAutosave({dirty:()=>dialog.open&&Object.keys(context.captureDetailDraft()).length>0,busy:()=>dialog.classList.contains('busy')||!context.currentEditable,save:()=>context.saveTask({preventDefault(){}},{keepOpen:true}),status:value=>get('details-save-status').textContent=value,delay:10_000});
  context.detailAutosave=autosave;get('auth-panel').hidden=true;context.openDetails(task.id);get('details-notes').value='Accepted draft';
  return{context,get,dialog,autosave,mode:value=>mode=value,remote:fields=>server={...server,...fields,entityVersion:server.entityVersion+1},server:()=>server,writes:()=>writes,signouts:()=>signouts,opens:()=>opens,error:()=>error,resolveRead:(extra=[])=>deferred({...payload(),tasks:[...payload().tasks,...extra]})};
}
test('accepted autosave plus failed read preserves the draft, blocks resend and confirms on read recovery',async()=>{
  const h=setup();h.mode('offline');await h.autosave.flush();
  assert.equal(h.writes(),1);assert.equal(h.server().notes,'Accepted draft');assert.equal(h.get('details-notes').value,'Accepted draft');assert.equal(h.opens(),1);assert.equal(h.dialog.open,true);assert.equal(h.get('details-notes').disabled,true);
  assert.equal(h.context.detailPendingSave.entityVersion,2);assert.match(h.get('details-save-status').textContent,/Saved · waiting for refresh/);assert.match(h.error(),/change was saved/);
  await h.autosave.flush();assert.equal(await h.context.saveTask({preventDefault(){}},{keepOpen:true}),'awaiting-refresh');assert.equal(h.writes(),1);
  h.mode('online');assert.equal(await h.context.loadTasks(),true);assert.equal(h.context.detailPendingSave,null);assert.equal(h.context.detailTaskBaseline.entityVersion,2);assert.equal(h.get('details-notes').value,'Accepted draft');assert.equal(h.get('details-notes').disabled,false);assert.equal(h.get('details-save-status').textContent,'Saved');assert.equal(h.writes(),1);
});
test('accepted save followed by actual read401 signs out without reopening, stale status, pending work or replay after login',async()=>{
  const h=setup();h.mode('unauthorized');await h.autosave.flush();
  assert.equal(h.writes(),1);assert.equal(h.signouts(),1);assert.equal(h.context.csrfToken,null);assert.equal(h.context.authPanel.hidden,false);assert.equal(h.dialog.open,false);assert.equal(h.opens(),1);assert.equal(h.context.detailPendingSave,null);assert.notEqual(h.get('details-save-status').textContent,'Saved');
  h.context.csrfToken='next-synthetic-session';h.mode('online');await h.context.loadTasks();assert.equal(h.dialog.open,false);assert.equal(h.opens(),1);assert.equal(h.writes(),1);
});
test('ordinary accepted save confirms the current task and clears the draft without a second mutation',async()=>{
  const h=setup();await h.autosave.flush();assert.equal(h.writes(),1);assert.equal(h.opens(),2);assert.equal(h.context.detailPendingSave,null);assert.equal(h.context.detailTaskBaseline.entityVersion,2);assert.deepEqual(Object.keys(h.context.captureDetailDraft()),[]);assert.equal(h.get('details-save-status').textContent,'Saved');await h.autosave.flush();assert.equal(h.writes(),1);
});
test('conflict retains the dirty draft and blocks autosave until explicit latest-task reload',async()=>{
  const h=setup();h.remote({notes:'Concurrent remote notes'});await h.autosave.flush();assert.equal(h.server().notes,'Concurrent remote notes');assert.equal(h.get('details-notes').value,'Accepted draft');assert.equal(h.context.detailPendingSave,null);assert.match(h.error(),/Copy it before loading/);assert.match(h.get('details-save-status').textContent,/Not saved/);
  await h.autosave.flush();assert.equal(h.writes(),1);await h.context.loadTasks();h.context.openDetails('task_a',{refresh:true});h.get('details-notes').value='Reviewed retry';await h.autosave.flush();assert.equal(h.writes(),2);assert.equal(h.server().notes,'Reviewed retry');assert.equal(h.get('details-save-status').textContent,'Saved');
});
test('a delayed save cannot reopen or unlock a different editor',async()=>{
  const h=setup();h.mode('deferred');const pending=h.autosave.flush();await new Promise(resolve=>setImmediate(resolve));h.dialog.close();h.context.currentPayload={tasks:[{...h.server(),id:'task_b',notes:'Other task'}]};h.context.openDetails('task_b');h.resolveRead([{...h.server(),id:'task_b',notes:'Other task'}]);await pending;assert.equal(h.context.selectedTaskId,'task_b');assert.equal(h.get('details-notes').value,'Other task');assert.equal(h.writes(),1);assert.equal(h.context.detailPendingSave,null);
});
test('accepted draft navigation describes a saved change, Cancel preserves it and confirmed close never resends',async()=>{
 const h=setup();h.mode('offline');await h.autosave.flush();extract(h.context,'requestDetailsClose');let navigate=0;h.context.confirmAction=async(title,message)=>{assert.match(title,/change is saved/);assert.match(message,/does not undo the saved change/);return false;};h.context.requestDetailsClose(()=>navigate++);await new Promise(resolve=>setImmediate(resolve));assert.equal(h.dialog.open,true);assert.notEqual(h.context.detailPendingSave,null);assert.equal(navigate,0);h.context.confirmAction=async()=>true;h.context.requestDetailsClose(()=>navigate++);await new Promise(resolve=>setImmediate(resolve));assert.equal(h.dialog.open,false);assert.equal(navigate,1);assert.equal(h.writes(),1);
});
test('an old accepted-save read cannot repaint the workspace after signout and a new owner session',async()=>{
 const h=setup();h.mode('deferred');const oldPayload=h.context.currentPayload,pending=h.autosave.flush();await new Promise(resolve=>setImmediate(resolve));await h.context.signOut();h.context.csrfToken='new-synthetic-session';h.resolveRead();await pending;assert.equal(h.context.currentPayload,oldPayload);assert.equal(h.dialog.open,false);assert.equal(h.context.detailPendingSave,null);assert.equal(h.writes(),1);assert.equal(h.opens(),1);
});
test('an already dispatched snapshot cannot re-enable the workspace after another request observes quota',async()=>{
 const h=setup();h.mode('deferred');const previous=h.context.currentPayload,pending=h.context.loadTasks();await new Promise(setImmediate);
 let paused=0;h.context.cloudBrake={status:()=>({code:'daily_quota_exceeded'})};h.context.applyCloudBrake=()=>{paused++;h.context.currentEditable=false;};
 h.resolveRead();assert.equal(await pending,false);assert.equal(h.context.currentPayload,previous);assert.equal(h.context.currentEditable,false);assert.equal(paused,1);
});
test('a read older than the accepted version cannot unlock labels, fields or completion or resend the write',async()=>{
 const h=setup();h.mode('lagging');await h.autosave.flush();assert.equal(h.context.currentEditable,true);assert.equal(h.get('details-save-status').textContent,'Saved · waiting for refresh');await h.context.loadTasks();assert.equal(h.get('details-new-label').disabled,true);assert.equal(h.get('details-notes').disabled,true);assert.equal(h.get('details-completion').disabled,true);assert.equal(h.context.detailPendingSave.entityVersion,2);assert.equal(h.writes(),1);h.mode('online');await h.context.loadTasks();assert.equal(h.context.detailPendingSave,null);assert.equal(h.get('details-notes').disabled,false);
});
test('session change during post-write rotation cannot start a confirming read in the next session',async()=>{
 const h=setup();let rotated,reads=0;h.context.rotateSession=()=>new Promise(resolve=>rotated=resolve);h.context.readAllTasks=async()=>{reads++;throw Error('Old save must not read the next session');};const pending=h.autosave.flush();await new Promise(resolve=>setImmediate(resolve));await h.context.signOut();h.context.csrfToken='next-session';rotated();await pending;assert.equal(reads,0);assert.equal(h.writes(),1);assert.equal(h.dialog.open,false);assert.equal(h.context.detailPendingSave,null);
});
for(const keepOpen of [true,false])for(const confirmed of [false,true])test(`navigation Save accepted then read failure replaces Discard with saved-draft confirmation (keepOpen=${keepOpen}, close=${confirmed})`,async()=>{
 const h=setup();for(const name of ['requestDetailsClose','saveBeforeLeaving','discardDetailChanges'])extract(h.context,name);let navigated=0,confirmations=0;h.context.confirmAction=async(title,message)=>{confirmations++;assert.equal(h.get('unsaved-dialog').open,false);assert.match(title,/change is saved/);assert.match(message,/does not undo the saved change/);return confirmed;};
 h.context.requestDetailsClose(()=>navigated++,{keepOpen});assert.equal(h.get('unsaved-dialog').open,true);h.mode('offline');await h.context.saveBeforeLeaving();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.get('unsaved-dialog').open,false);assert.equal(confirmations,1);assert.equal(h.server().notes,'Accepted draft');assert.equal(h.get('details-notes').value,'Accepted draft');assert.equal(h.writes(),1);assert.equal(navigated,confirmed?1:0);assert.equal(h.dialog.open,!confirmed);
 if(!confirmed){assert.equal(h.context.detailPendingSave.entityVersion,2);assert.equal(h.context.detailTaskBaseline.entityVersion,1);assert.equal(h.get('details-notes').disabled,true);assert.equal(h.get('details-save-status').textContent,'Saved · waiting for refresh');h.context.discardDetailChanges();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.get('details-notes').value,'Accepted draft');assert.equal(h.context.detailPendingSave.entityVersion,2);h.mode('online');await h.context.loadTasks();assert.equal(h.context.detailPendingSave,null);assert.equal(h.context.detailTaskBaseline.entityVersion,2);assert.equal(h.get('details-notes').value,'Accepted draft');assert.equal(h.get('details-save-status').textContent,'Saved');assert.equal(h.get('details-notes').disabled,false);assert.equal(h.writes(),1);}
});
test('navigation Save followed by read401 closes the navigation prompt and never executes the old action',async()=>{
 const h=setup();for(const name of ['requestDetailsClose','saveBeforeLeaving'])extract(h.context,name);let navigated=0;h.context.requestDetailsClose(()=>navigated++,{keepOpen:true});h.mode('unauthorized');await h.context.saveBeforeLeaving();assert.equal(h.get('unsaved-dialog').open,false);assert.equal(h.dialog.open,false);assert.equal(h.context.csrfToken,null);assert.equal(navigated,0);assert.equal(h.writes(),1);
});
