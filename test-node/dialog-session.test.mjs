import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {taskTextError,uniqueLabelNames} from '../public/task-presentation.js';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
class Element {
 value='';disabled=false;hidden=false;open=false;closes=0;attributes=new Set();handlers={};
 classList={values:new Set(),contains:name=>this.classList.values.has(name),remove:name=>this.classList.values.delete(name),
  toggle:(name,on)=>on?this.classList.values.add(name):this.classList.values.delete(name)};
 hasAttribute(name){return this.attributes.has(name);}querySelectorAll(){return [];}reset(){}focus(){}after(){}
 addEventListener(name,handler){this.handlers[name]=handler;}
 escape(){let prevented=false;this.handlers.cancel?.({preventDefault(){prevented=true;}});if(!prevented)this.close();return prevented;}
 show(){this.open=true;}showModal(){this.open=true;}close(){this.open=false;this.closes++;}
}
function setup(){
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
 const taskDialog=get('task-dialog'),detailsDialog=get('details-dialog'),writes=[];
 const newFields=['new-title','new-notes','new-labels','new-space','new-project','new-status','new-priority','new-planned','new-deadline','new-save'];
 const detailFields=['details-title','details-notes','details-space','details-project','details-status','details-priority','details-planned','details-deadline','details-save','details-new-label','details-add-label'];
 taskDialog.querySelectorAll=()=>newFields.map(get);detailsDialog.querySelectorAll=()=>detailFields.map(get);
 const task={id:'task_a',title:'Synthetic task',notes:null,spaceId:'space_a',projectId:null,workflowStatus:'inbox',priority:3,
  plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,labels:[],entityVersion:1,createdAt:'2026-10-19T00:00:00Z'};
 const context=vm.createContext({ownerSessionGeneration:0,currentEditable:true,csrfToken:'old',workspaceSupported:()=>true,
  taskDialog,detailsDialog,currentPayload:{tasks:[task],spaces:[{id:'space_a'}],projects:[],labels:[]},selectedTaskId:null,selectedSpaceId:'space_a',selectedProjectId:null,currentView:'inbox',
  detailEditorGeneration:0,detailPendingSave:null,detailLabelBusy:false,detailTaskUnavailable:false,detailBaseline:{},detailTaskBaseline:null,
  detailAutosave:{reset(){}},taskTextError,parseLabels:uniqueLabelNames,crypto:{randomUUID:()=> 'synthetic-id'},
  $:selector=>get(selector.slice(1)),document:{getElementById:get,activeElement:get('new-title'),body:{classList:{remove(){}}}},
  clearDialogError(){},showDialogError(){},fillSpaceSelect(){},fillProjectSelect(){},creationSpace:()=> 'space_a',localDate:d=>d.toISOString().slice(0,10),
  formatTime:v=>v,renderDetailLabels(){},renderSource(){},renderSubtasks(){},updateWorkbenchLayout(){},requestDetailsClose:fn=>fn(),
  sendMutation:()=>new Promise((resolve,reject)=>writes.push({resolve,reject})),finishMutations:async()=>true,setNotice(){},loadTasks(){},openCreatedTask(){},
  workspaceControls:{stop(){}},initialStatusMonitor:{stop(){}},api:async()=>({}),clearTaskTimers(){},clearTimeout(){},sessionTimer:null,
  tasksPanel:get('tasks-panel'),devicesPanel:get('devices-panel'),authPanel:get('auth-panel'),setupForm:get('setup-form'),recoveryForm:get('recovery-form'),signinActions:get('signin-actions'),authCopy:get('auth-copy'),
 });
 for(const name of ['signOut','openAddTask','createTask','openDetails','updateSelectedLabel','setDialogBusy','lockWorkspaceDetailFields','readDetailFields','captureDetailDraft'])
  vm.runInContext(source.match(new RegExp(`^(?:async )?function ${name}\\(.*$`,'m'))[0],context);
 // Register the real application's native dialog-cancel listener.
 vm.runInContext(source.match(/^  taskDialog\.addEventListener\("cancel".*$/m)[0],context);
 const open=action=>{if(action==='create'){context.openAddTask();get('new-title').value='Synthetic create';get('new-space').value='space_a';get('new-priority').value='3';}else context.openDetails(task.id);};
 const save=action=>action==='create'?context.createTask({preventDefault(){}}):context.updateSelectedLabel('task.addLabel',{label:{id:'synthetic_label',name:'Synthetic'}});
 const login=()=>{context.currentEditable=true;context.csrfToken='next';};
 return{context,get,writes,open,save,login,dialog:action=>action==='create'?taskDialog:detailsDialog};
}
for(const action of ['create','label'])for(const outcome of ['success','failure'])for(const nextBusy of [false,true]){
 test(`signout during ${action}: reopen is usable and old ${outcome} preserves next dialog busy=${nextBusy}`,async()=>{
  const h=setup();h.open(action);const old=h.save(action),dialog=h.dialog(action),field=h.get(action==='create'?'new-title':'details-notes');
  assert.equal(dialog.classList.contains('busy'),true);assert.equal(field.disabled,true);
  const signingOut=h.context.signOut();
  // Teardown happens before the signout HTTP request finishes.
  assert.equal(dialog.open,false);assert.equal(dialog.classList.contains('busy'),false);await signingOut;
  h.login();h.open(action);assert.equal(dialog.open,true);assert.equal(dialog.classList.contains('busy'),false);assert.equal(field.disabled,false);
  const next=nextBusy?h.save(action):null;
  if(outcome==='failure')h.writes[0].reject(Object.assign(Error('retired request'),{code:'session_changed'}));
  else h.writes[0].resolve({entityId:'task_a',entityVersion:2});
  await old;assert.equal(dialog.open,true);assert.equal(dialog.classList.contains('busy'),nextBusy);assert.equal(field.disabled,nextBusy);
  if(next){h.writes[1].resolve({entityId:'task_a',entityVersion:2});await next;}
 });
}
test('accepted create refresh finishing in a retired session cannot close the newly busy create dialog',async()=>{
 const h=setup();let finish;
 h.context.finishMutations=()=>new Promise(resolve=>finish=resolve);h.open('create');const old=h.save('create');
 h.writes[0].resolve({entityVersion:1});await new Promise(setImmediate);assert.equal(typeof finish,'function');
 await h.context.signOut();h.login();h.open('create');const next=h.save('create'),dialog=h.dialog('create');
 finish(true);await old;assert.equal(dialog.open,true);assert.equal(dialog.classList.contains('busy'),true);assert.equal(h.get('new-title').disabled,true);
 h.writes[1].reject(Error('synthetic cleanup'));await next;
});
for(const outcome of ['success','failure'])test(`native Escape cannot dismiss or reopen a busy Create; ${outcome} restores ordinary cancellation`,async()=>{
 const h=setup();h.open('create');const dialog=h.dialog('create');
 assert.equal(dialog.escape(),false);assert.equal(dialog.open,false);
 h.open('create');const pending=h.save('create');
 assert.equal(dialog.escape(),true);assert.equal(dialog.open,true);assert.equal(h.get('new-title').disabled,true);
 h.get('new-title').value='Pending create draft';h.context.openAddTask();
 assert.equal(h.get('new-title').value,'Pending create draft');assert.equal(dialog.classList.contains('busy'),true);assert.equal(h.get('new-title').disabled,true);
 if(outcome==='success')h.writes[0].resolve({entityVersion:1});else h.writes[0].reject(Error('synthetic failure'));
 await pending;
 if(outcome==='success')h.open('create');
 assert.equal(dialog.open,true);assert.equal(dialog.classList.contains('busy'),false);assert.equal(h.get('new-title').disabled,false);
 assert.equal(dialog.escape(),false);assert.equal(dialog.open,false);
});
test('signout programmatically retires a busy Create even when native Escape is blocked',async()=>{
 const h=setup();h.open('create');const pending=h.save('create'),dialog=h.dialog('create');
 assert.equal(dialog.escape(),true);await h.context.signOut();
 assert.equal(dialog.open,false);assert.equal(dialog.classList.contains('busy'),false);
 h.writes[0].reject(Object.assign(Error('retired request'),{code:'session_changed'}));await pending;
 h.login();h.open('create');assert.equal(h.get('new-title').disabled,false);assert.equal(dialog.escape(),false);
});
