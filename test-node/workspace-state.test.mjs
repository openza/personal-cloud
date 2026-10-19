import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import {taskTextError,taskSaveError} from "../public/task-presentation.js";

const source = readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
const workspaceStateKey = "workspace";
const controlIds = ["sort-select","sort-direction","group-select","status-filter","priority-filter","label-filter","source-filter","repeat-filter"];
class Select {
  constructor(values) { this.options=values.map(value=>({value}));this.value=values[0]; }
}
function setup() {
  const nodes=new Map(controlIds.map(id=>[id,new Select(id==="sort-select"?["priority","date","created","title","project"]:id==="sort-direction"?["default","reverse"]:id==="group-select"?["none","date","project","completed","label"]:["","selected"])]));
  nodes.set("details-save-status",{textContent:"",hasAttribute(){return false;}});
  nodes.set("details-conflict-actions",{hidden:true,hasAttribute(){return false;}});
  const local=new Map(),session=new Map();
  const storage=map=>({getItem:key=>map.get(key)||null,setItem:(key,value)=>map.set(key,value)});
  const context=vm.createContext({ownerSessionGeneration:0,detailPendingSave:null,detailEditorGeneration:0,ownerSessionGeneration:0,openDetails(){},collapsedGroups:new Set(),taskTextError,taskSaveError,detailAutosave:{cancel(){},reset(){}},TextEncoder,clearDialogError(){},workspaceStateKey,controlIds,localStorage:storage(local),sessionStorage:storage(session),selectedSpaceId:"*",selectedProjectId:null,currentView:"all",viewCopySafe:{all:1,inbox:1,completed:1,search:1},restoredControls:{},detailBaseline:{},detailTaskBaseline:null,detailTaskUnavailable:false,viewPreferences:{},sharedGroups:{},HTMLSelectElement:Select,document:{getElementById:id=>nodes.get(id)},$:selector=>nodes.get(selector.slice(1))});
  for(const name of ["contextKey","applyContextPreferences","persistWorkspaceState","restoreWorkspaceState","readDetailFields","captureDetailDraft","restoreDetailDraft","isCurrentDetail","confirmPendingDetailSave","showAcceptedDetailSave"]) vm.runInContext(source.match(new RegExp(`^function ${name}\\(.*$`,"m"))[0],context);
  return {context,nodes,local,session};
}

test("preferences persist by Space/view/project; Tasks and project grouping is shared", () => {
  const {context,nodes,local}=setup();nodes.get("sort-select").value="date";nodes.get("group-select").value="label";context.persistWorkspaceState();
  context.currentView="completed";context.applyContextPreferences();assert.equal(nodes.get("group-select").value,"completed");assert.equal(nodes.get("sort-select").value,"priority");
  context.currentView="all";context.selectedProjectId="project_a";context.applyContextPreferences();assert.equal(nodes.get("group-select").value,"label");
  context.selectedProjectId=null;context.applyContextPreferences();assert.equal(nodes.get("sort-select").value,"date");
  assert.equal(JSON.parse(local.get(workspaceStateKey)).spaceId,"*");
});

test("collapsed task groups survive reload and are isolated by view context", () => {
  const {context,local}=setup();context.collapsedGroups.add('project:launch');context.persistWorkspaceState();
  context.collapsedGroups.clear();context.restoreWorkspaceState();
  assert.equal(context.collapsedGroups.has('project:launch'),true);
  context.currentView='inbox';context.applyContextPreferences();assert.equal(context.collapsedGroups.size,0);
  context.currentView='all';context.applyContextPreferences();assert.equal(context.collapsedGroups.has('project:launch'),true);
  assert.deepEqual(JSON.parse(local.get(workspaceStateKey)).viewPreferences['*|view:all'].collapsedGroups,['project:launch']);
});

test("restore migrates legacy session preferences and delays dynamic reference selections", () => {
  const {context,nodes,session}=setup();session.set(workspaceStateKey,JSON.stringify({spaceId:"space_other",view:"completed",controls:{"sort-select":"title","label-filter":"label_later"}}));
  context.restoreWorkspaceState();assert.equal(context.selectedSpaceId,"space_other");assert.equal(context.currentView,"completed");assert.equal(nodes.get("sort-select").value,"title");assert.equal(context.restoredControls["label-filter"],"label_later");
});

test("restore rejects unsupported views/control values", () => {
  const {context,nodes,local}=setup();local.set(workspaceStateKey,JSON.stringify({spaceId:"*",view:"unsupported",controls:{"sort-select":"unsupported"}}));context.restoreWorkspaceState();assert.equal(context.currentView,"all");assert.equal(nodes.get("sort-select").value,"priority");
});

test("label updates preserve unsaved field drafts and target project choices", () => {
  const {context,nodes}=setup();for(const id of ["details-title","details-notes","details-space","details-project","details-status","details-priority","details-planned","details-deadline"])nodes.set(id,{value:id});
  const draft=context.captureDetailDraft();nodes.get("details-notes").value="Server notes";let target;context.fillProjectSelect=(select,spaceId,projectId)=>{target=[spaceId,projectId];};context.restoreDetailDraft(draft);
  assert.equal(nodes.get("details-notes").value,"details-notes");assert.deepEqual(target,["details-space","details-project"]);
});

test("label draft restoration leaves untouched fields at their newly confirmed server values",()=>{const {context,nodes}=setup();for(const id of ["details-title","details-notes","details-space","details-project","details-status","details-priority","details-planned","details-deadline"])nodes.set(id,{value:"before"});context.detailBaseline=context.readDetailFields();nodes.get("details-notes").value="Edited notes";const draft=context.captureDetailDraft();nodes.get("details-title").value="Concurrent server title";context.restoreDetailDraft(draft);assert.equal(nodes.get("details-title").value,"Concurrent server title");assert.equal(nodes.get("details-notes").value,"Edited notes");});

function labelSetup() {
  const {context,nodes}=setup();
  for(const id of ["details-title","details-notes","details-space","details-project","details-status","details-priority","details-planned","details-deadline","details-new-label","details-add-label","details-save","details-upgrade-message"]) nodes.set(id,{value:"before",disabled:false,hasAttribute:()=>false});
  const navigation={disabled:false,hasAttribute:key=>key==="data-readonly-navigation"};
  nodes.get("details-new-label").value="New label";nodes.get("details-add-label").value="label_existing";
  context.detailBaseline=context.readDetailFields();nodes.get("details-notes").value="Intentional draft";
  context.currentEditable=true;context.detailLabelBusy=false;context.selectedTaskId="task_a";
  context.workspaceSupported=()=>true;
  context.currentPayload={tasks:[{id:"task_a",entityVersion:1,labels:[]}],labels:[{id:"label_existing",name:"Existing"}]};
  let busy=false,resolveWrite,rejectWrite,resolveRefresh,writes=0,opens=0;
  context.detailsDialog={open:true,querySelectorAll:()=>[...nodes.entries()].filter(([id])=>id.startsWith("details-")).map(([,node])=>node).concat(navigation),classList:{toggle:(name,value)=>{busy=value;}}};
  context.crypto={randomUUID:()=>"synthetic-uuid"};context.sendMutation=()=>{writes++;return new Promise((resolve,reject)=>{resolveWrite=resolve;rejectWrite=reject;});};
  context.finishMutations=()=>new Promise(resolve=>{resolveRefresh=resolve;});context.openDetails=(_id,options)=>{assert.equal(options?.refresh,true);opens++;nodes.get("details-notes").value="Server notes";};context.showDialogError=()=>{};context.setNotice=()=>{};context.renderDetailLabels=()=>{};
  for(const name of ["lockWorkspaceDetailFields","setDialogBusy","updateSelectedLabel","addNamedLabel","addSelectedLabel","removeSelectedLabel"]) vm.runInContext(source.match(new RegExp(`^(?:async )?function ${name}\\(.*$`,"m"))[0],context);
  return {context,nodes,navigation,resolve:async()=>{resolveWrite();await new Promise(resolve=>setImmediate(resolve));},refresh:()=>resolveRefresh(),reject:()=>rejectWrite(new Error("synthetic failure")),writes:()=>writes,opens:()=>opens,busy:()=>busy};
}

test('unsupported workspace keeps field edits disabled across refresh/unlock while legacy label actions remain available',()=>{
 const {context,nodes}=labelSetup();context.workspaceSupported=()=>false;context.setDialogBusy(context.detailsDialog,false);
 assert.equal(nodes.get('details-notes').disabled,true);assert.equal(nodes.get('details-save').disabled,true);assert.equal(nodes.get('details-upgrade-message').hidden,false);assert.equal(nodes.get('details-new-label').disabled,false);
 context.workspaceSupported=()=>true;context.lockWorkspaceDetailFields();assert.equal(nodes.get('details-save').disabled,false);assert.equal(nodes.get('details-upgrade-message').hidden,true);
 context.currentEditable=false;context.lockWorkspaceDetailFields();assert.equal(nodes.get('details-save').disabled,true);assert.equal(nodes.get('details-upgrade-message').hidden,true);
});

for(const action of ["create","attach","remove"])test(`pending ${action} label serializes changes and locks edits/navigation through refresh`,async()=>{
  const state=labelSetup(),{context,nodes,navigation}=state;
  const pending=action==="create"?context.addNamedLabel():action==="attach"?context.addSelectedLabel():context.removeSelectedLabel("label_existing");
  assert.equal(nodes.get("details-notes").disabled,true);assert.equal(navigation.disabled,true);assert.equal(state.busy(),true);
  await context.addSelectedLabel();assert.equal(state.writes(),1);
  await state.resolve();assert.equal(nodes.get("details-notes").disabled,true);assert.equal(navigation.disabled,true);assert.equal(state.busy(),true);
  state.refresh();await pending;
  assert.equal(nodes.get("details-notes").value,"Intentional draft");assert.equal(nodes.get("details-notes").disabled,false);assert.equal(navigation.disabled,false);assert.equal(state.busy(),false);
});

test("pending label never reopens a dialog closed with Escape or a different selected task",async()=>{
  for(const change of ["closed","different"]){const state=labelSetup(),pending=state.context.addNamedLabel();if(change==="closed")state.context.detailsDialog.open=false;else state.context.selectedTaskId="task_b";await state.resolve();state.refresh();await pending;assert.equal(state.opens(),0);assert.equal(state.context.detailLabelBusy,false);}
});

test("label failure releases its lock and retains stale read-only controls",async()=>{
  const state=labelSetup(),pending=state.context.addNamedLabel();state.context.currentEditable=false;state.reject();await pending;
  assert.equal(state.context.detailLabelBusy,false);assert.equal(state.nodes.get("details-notes").disabled,true);assert.equal(state.navigation.disabled,false);
});

test('notes-only save retains assigned archived or unavailable project; explicit clearing still works',async()=>{
 for(const unavailable of [false,true]){
  const {context,nodes}=setup(),assigned={id:'project_archived',spaceId:'space_a',name:'Archived',status:'archived'},task={id:'task_a',spaceId:'space_a',projectId:assigned.id,title:'Task',notes:null,workflowStatus:'inbox',priority:3,deadlineOn:null,deadlineAt:null,entityVersion:1};
  class BrowserSelect {options=[];replaceChildren(...options){this.options=options;this.value=options[0]?.value??'';}set value(v){this.selected=this.options.some(o=>o.value===v)?v:'';}get value(){return this.selected;}}
  context.Option=class {constructor(text,value){this.text=text;this.value=value;this.disabled=false;}};
  context.currentPayload={projects:[],allProjects:unavailable?[]:[assigned],tasks:[task]};context.selectedTaskId=task.id;context.currentEditable=true;context.workspaceSupported=()=>true;
  context.detailsDialog={open:true,close(){}};context.setDialogBusy=()=>{};context.plannedEdit=()=>null;context.finishMutations=async()=>true;
  for(const [id,value] of Object.entries({'details-title':'Task','details-notes':'Edited notes','details-status':'inbox','details-priority':'3','details-planned':'','details-deadline':'','details-space':'space_a'}))nodes.set(id,{value});
  const select=new BrowserSelect();nodes.set('details-project',select);let payload;context.sendMutation=async(...args)=>{payload=args[3];context.currentPayload.tasks[0].entityVersion++;return{entityVersion:context.currentPayload.tasks[0].entityVersion};};
  for(const name of ['fillProjectSelect','saveTask'])vm.runInContext(source.match(new RegExp(`^(?:async )?function ${name}\\(.*$`,'m'))[0],context);
  context.fillProjectSelect(select,'space_a',assigned.id);assert.equal(select.value,assigned.id);assert.equal(select.options.at(-1).disabled,true);
  await context.saveTask({preventDefault(){}});assert.deepEqual(JSON.parse(JSON.stringify(payload)),{fields:{notes:'Edited notes'}});
  select.value='';await context.saveTask({preventDefault(){}});assert.equal(payload.fields.projectId,null);
  context.fillProjectSelect(select,'space_a');assert.equal(select.options.some(o=>o.value===assigned.id),false);
 }
});
test('a background update cannot promote a dirty editor to the latest version or overwrite untouched remote fields',async()=>{
 const {context,nodes}=setup(),baseline={id:'task_a',spaceId:'space_a',projectId:null,title:'Original title',notes:null,workflowStatus:'inbox',priority:3,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,entityVersion:1};
 context.detailTaskBaseline=baseline;context.currentPayload={tasks:[{...baseline,title:'Remote title',entityVersion:2}]};context.selectedTaskId=baseline.id;context.currentEditable=true;context.workspaceSupported=()=>true;context.setDialogBusy=()=>{};context.plannedEdit=()=>null;
 let submitted,closed=false,reported;context.detailsDialog={open:true,close(){closed=true;}};context.showDialogError=(_dialog,message)=>{reported=message;};context.sendMutation=async(...args)=>{submitted=args;throw Object.assign(new Error('Task changed remotely'),{status:409});};
 for(const [id,value]of Object.entries({'details-title':'Original title','details-notes':'Unsaved notes','details-status':'inbox','details-priority':'3','details-planned':'','details-deadline':'','details-space':'space_a','details-project':''}))nodes.set(id,{value});
 vm.runInContext(source.match(/^async function saveTask\(.*$/m)[0],context);assert.equal(await context.saveTask({preventDefault(){}}),false);assert.equal(submitted[1],1);assert.deepEqual(JSON.parse(JSON.stringify(submitted[3])),{fields:{notes:'Unsaved notes'}});assert.equal(nodes.get('details-notes').value,'Unsaved notes');assert.equal(closed,false);assert.equal(reported,'Task changed remotely');
});

for(const remote of ['before-label','during-refresh','none'])test(`label changes preserve dirty-field provenance with remote update ${remote}`,async()=>{
 const state=labelSetup(),{context,nodes}=state,task={id:'task_a',spaceId:'space_a',projectId:null,title:'Original title',notes:'Original notes',workflowStatus:'inbox',priority:3,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,entityVersion:1,labels:[]};
 const values={'details-title':task.title,'details-notes':task.notes,'details-status':'inbox','details-priority':'3','details-planned':'','details-deadline':'','details-space':'space_a','details-project':''};
 for(const [id,value]of Object.entries(values))nodes.get(id).value=value;
 context.detailBaseline=context.readDetailFields();context.detailTaskBaseline={...task};nodes.get('details-notes').value='Intentional draft';
 let current={...task,...(remote==='before-label'?{notes:'Remote notes',entityVersion:2}:{})};context.currentPayload.tasks=[current];
 context.sendMutation=async(id,base,operation,payload)=>{assert.equal(id,task.id);if(operation==='task.addLabel'){assert.equal(base,current.entityVersion);current={...current,entityVersion:base+1,labels:[payload.label]};return{entityId:id,entityVersion:current.entityVersion,outcome:'accepted'};}assert.equal(operation,'task.patch');if(base!==current.entityVersion)throw Object.assign(new Error('Task changed remotely'),{status:409});current={...current,...payload.fields,entityVersion:base+1};return{entityId:id,entityVersion:current.entityVersion,outcome:'accepted'};};
 context.finishMutations=async()=>{if(remote==='during-refresh')current={...current,title:'Remote title',notes:'Remote notes',entityVersion:current.entityVersion+1};context.currentPayload.tasks=[current];return true;};
 context.plannedEdit=()=>null;context.detailsDialog.close=()=>{context.detailsDialog.open=false;};let error;context.showDialogError=(_dialog,message)=>{error=message;};
 vm.runInContext(source.match(/^async function saveTask\(.*$/m)[0],context);
 await context.addSelectedLabel();
 assert.equal(context.detailTaskBaseline.entityVersion,remote==='before-label'?1:2);assert.equal(context.detailTaskBaseline.notes,'Original notes');assert.equal(nodes.get('details-title').value,'Original title');assert.equal(nodes.get('details-notes').value,'Intentional draft');
 assert.equal(await context.saveTask({preventDefault(){}}),remote==='none');
 if(remote==='none'){assert.equal(current.notes,'Intentional draft');assert.equal(context.detailsDialog.open,false);}else{assert.equal(current.notes,'Remote notes');assert.equal(nodes.get('details-notes').value,'Intentional draft');assert.equal(context.detailsDialog.open,true);assert.equal(error,'Task changed remotely');}
});
