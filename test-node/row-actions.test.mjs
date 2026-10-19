import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {appendTaskRowActions,captureTaskRowInteraction,restoreTaskRowInteraction} from '../public/task-row-actions.js';

class Element {
  children=[];attributes={};handlers={};hiddenPopover=false;
  append(...items){this.children.push(...items);}
  setAttribute(key,value){this.attributes[key]=value;}
  addEventListener(event,handler){this.handlers[event]=handler;}
  hidePopover(){this.hiddenPopover=true;}
}
test('row commands target the task inspector, separate repeated label groups and respect source ownership',()=>{
  const previous=globalThis.document;
  globalThis.document={createElement:()=>new Element()};
  try {
    const edits=[],deletes=[],task={id:'task_a',title:'Review',source:null};
    const render=(task,editable=true)=>{const row=new Element();appendTaskRowActions({row,task,editable,onEdit:(...args)=>edits.push(args),onDelete:id=>deletes.push(id)});return row.children;};
    const [trigger,actions]=render(task),[,duplicate]=render(task);
    assert.notEqual(actions.id,duplicate.id);
    assert.equal(trigger.attributes.popovertarget,actions.id);
    assert.equal(actions.children.length,7);
    actions.children[0].handlers.click();
    assert.deepEqual(edits,[['task_a','details-planned']]);assert.equal(actions.hiddenPopover,true);
    actions.children.at(-1).handlers.click();assert.deepEqual(deletes,['task_a']);
    assert.equal(render({...task,source:{integrationKind:'todoist'}})[1].children.length,6);
    assert.equal(render(task,false)[0].disabled,true);
  }finally{globalThis.document=previous;}
});

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
for(const rejected of [false,true])test(`repeated completion is ignored until mutation and refresh settle (${rejected?'rejected':'accepted'})`,async()=>{
  let resolveWrite,resolveRefresh,writes=0,notices=0;const states=[],completionInFlight=new Set();
  const context=vm.createContext({ownerSessionGeneration:0,detailPendingSave:null,currentEditable:true,completionInFlight,refreshCompletionButtons:id=>states.push([id,completionInFlight.has(id)]),sendMutation:()=>{writes++;return new Promise(resolve=>{resolveWrite=resolve;});},finishMutations:()=>new Promise((resolve,reject)=>{resolveRefresh=()=>rejected?reject(new Error('Synthetic failure')):resolve();}),setNotice:()=>notices++,setStatus(){}});
  vm.runInContext(source.match(/^async function toggleCompletion\(.*$/m)[0],context);
  const task={id:'task_a',entityVersion:1,completionState:'open'},first=context.toggleCompletion(task);
  await context.toggleCompletion(task);assert.equal(writes,1);resolveWrite();await new Promise(resolve=>setImmediate(resolve));
  await context.toggleCompletion(task);assert.equal(writes,1);assert.equal(completionInFlight.has(task.id),true);
  resolveRefresh();await first;assert.equal(completionInFlight.size,0);assert.equal(notices,rejected?1:0);assert.deepEqual(states,[['task_a',true],['task_a',false]]);
});
test('cancelling completion of a dirty selected task leaves its checkbox at the confirmed state',async()=>{
  const checkbox={checked:true};let writes=0,guarded=0;
  const context=vm.createContext({ownerSessionGeneration:0,detailPendingSave:null,selectedTaskId:'task_a',currentPayload:{tasks:[{id:'task_a',completionState:'open'}]},$:()=>checkbox,requestDetailsClose:()=>{guarded++;},toggleCompletion:()=>{writes++;}});
  vm.runInContext(source.match(/^async function toggleSelectedCompletion\(.*$/m)[0],context);
  await context.toggleSelectedCompletion();assert.equal(guarded,1);assert.equal(writes,0);assert.equal(checkbox.checked,false);
});
test('row completion respects the selected editor guard and reads the latest accepted version',()=>{
  let pending,written;
  const context=vm.createContext({ownerSessionGeneration:0,detailPendingSave:null,detailsDialog:{open:true},selectedTaskId:'task_a',currentPayload:{tasks:[{id:'task_a',entityVersion:1}]},requestDetailsClose:action=>{pending=action;},toggleCompletion:task=>{written=task.entityVersion;}});
  vm.runInContext(source.match(/^function requestRowCompletion\(.*$/m)[0],context);
  context.requestRowCompletion('task_a');assert.equal(written,undefined);
  context.currentPayload.tasks[0].entityVersion=2;pending();assert.equal(written,2);
});
test('a navigation prompt pauses pending autosave until the user resolves the draft',()=>{
  let cancelled=0,prompts=0,actions=0;
  const context=vm.createContext({ownerSessionGeneration:0,detailPendingSave:null,detailsDialog:{open:true,classList:{contains:()=>false}},detailLabelBusy:false,captureDetailDraft:()=>({notes:'Unsaved draft'}),detailAutosave:{cancel(){cancelled++;}},$:id=>id==='#unsaved-dialog'?{showModal(){prompts++;}}:{},pendingDetailsAction:null,pendingDetailsKeepOpen:false});
  vm.runInContext(source.match(/^function requestDetailsClose\(.*$/m)[0],context);
  context.requestDetailsClose(()=>{actions++;});assert.equal(cancelled,1);assert.equal(prompts,1);assert.equal(actions,0);
});
test('a background list refresh preserves the open row actions and keyboard focus',()=>{
  const previous=globalThis.document;let opens=0,focused=0;
  const active={textContent:'Change labels',getAttribute:()=>null};
  const row={dataset:{taskId:'task_a'},contains:node=>node===active};
  const menu={closest:()=>row};
  const host={querySelector:()=>menu,contains:()=>true};
  globalThis.document={activeElement:active};
  try {
    const state=captureTaskRowInteraction(host);
    const trigger={click(){opens++;}},target={textContent:'Change labels',getAttribute:()=>null,focus(){focused++;}};
    const replacement={dataset:{taskId:'task_a'},querySelector:()=>trigger,querySelectorAll:()=>[target]};
    restoreTaskRowInteraction({querySelectorAll:()=>[replacement]},state);
    assert.equal(opens,1);assert.equal(focused,1);
    trigger.disabled=true;restoreTaskRowInteraction({querySelectorAll:()=>[replacement]},state);
    assert.equal(opens,1);
    assert.doesNotThrow(()=>restoreTaskRowInteraction({querySelectorAll:()=>[]},state));
  }finally{globalThis.document=previous;}
});
