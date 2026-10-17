import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme } from '../public/appearance.js';
import { taskRowPresentation, formatTaskDate, taskSaveError } from '../public/task-presentation.js';
import { createDetailAutosave } from '../public/detail-autosave.js';

test('theme respects explicit preference and follows the OS only for System',()=>{
  assert.equal(resolveTheme('Dark',false),'dark');
  assert.equal(resolveTheme('Light',true),'light');
  assert.equal(resolveTheme('System',true),'dark');
  assert.equal(resolveTheme('System',false),'light');
});
test('rows show urgent priority, local labels and useful status without redundant project or Inbox badge',()=>{
  const task={projectId:'p',priority:1,workflowStatus:'inbox',completionState:'open',plannedOn:'2026-10-17',labels:[{name:'review'}]};
  const copy=taskRowPresentation(task,{view:'inbox',projectId:'p',now:new Date('2026-10-17T12:00:00')});
  assert.deepEqual(copy,{metadata:'Today · @review',status:'',priority:'Urgent'});
  assert.equal(taskRowPresentation({...task,priority:3},{view:'all'}).priority,'');
  assert.equal(taskRowPresentation({...task,workflowStatus:'waiting'},{view:'all'}).status,'Waiting');
  assert.equal(formatTaskDate('not-a-date'),'');
});
test('blur saves serialize, retain a rejected draft, and resume only after explicit reset',async()=>{
  let dirty=true,release,calls=0;const messages=[];
  const autosave=createDetailAutosave({dirty:()=>dirty,busy:()=>false,status:s=>messages.push(s),delay:1_000,
    save:()=>{calls++;return new Promise(resolve=>release=resolve);}});
  const first=autosave.flush();await autosave.flush();assert.equal(calls,1);
  release(false);await first;await autosave.flush();assert.equal(calls,1);assert.equal(dirty,true);
  assert.match(messages.at(-1),/Not saved/);
  autosave.reset();const second=autosave.flush();assert.equal(calls,2);dirty=false;release(true);await second;
  assert.equal(messages.at(-1),'Saved');autosave.cancel();
});
test('conflict copy preserves the draft and explains recovery rather than exposing a CAS error',()=>{
  assert.match(taskSaveError({code:'version_conflict',message:'entity changed'}),/Copy it before loading/);
  assert.equal(taskSaveError(new Error('Offline')),'Offline');
});
