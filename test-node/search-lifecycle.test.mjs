import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {ALL_SPACES,searchWorkspace,queryTasks,taskComparator,groupTasks} from '../public/workspace-query.js';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
class Node {value='';checked=false;hidden=false;open=false;children=[];handlers={};append(...v){this.children.push(...v);}replaceChildren(...v){this.children=v;}addEventListener(name,fn){this.handlers[name]=fn;}showModal(){this.open=true;}setAttribute(key,value){this[key]=value;}}
function setup(){const nodes=new Map(),$=key=>{if(!nodes.has(key))nodes.set(key,new Node());return nodes.get(key);},task=(id,spaceId,completionState='open')=>({id,title:'Find '+id,spaceId,completionState,workflowStatus:'inbox',priority:3,labels:[],createdAt:'2026-01-01T00:00:00.000Z'}),payload={spaces:[{id:'a',name:'A'},{id:'b',name:'B'}],projects:[],tasks:[task('one','a'),task('two','b'),task('done','b','completed')]};
 const context=vm.createContext({$,ALL_SPACES,searchWorkspace,queryTasks,taskComparator,groupTasks,document:{createElement:()=>new Node()},currentPayload:payload,selectedSpaceId:'a',selectedProjectId:null,currentView:'inbox',settingsRoute:false,initialUploadState:null,currentEditable:true,taskList:new Node(),viewCopy:{inbox:['Inbox','Capture']},collapsedGroups:new Set(),updateWorkbenchLayout(){},updateToolbarLabels(){},groupChildren:()=>new Map(),createTaskRow:()=>new Node(),openAddTask(){},clearFilters(){}});
 vm.runInContext(source.match(/^function renderGlobalSearch\(.*$/m)[0],context);
 vm.runInContext(source.slice(source.indexOf('function renderTaskList(){'),source.indexOf('function updateToolbarLabels()')),context);
 $('#global-search-input').value='Find';$('#search-scope').value='current';$('#sort-select').value='priority';$('#group-select').value='none';$('#global-search-dialog').open=true;return{nodes,$,context,payload};
}
test('Search scope/completed choices update current results without hiding options or changing underlying view',()=>{
 const h=setup();h.context.renderGlobalSearch();assert.equal(h.$('#global-search-results').children.length,1);
 h.$('#search-scope').value='all';h.context.renderGlobalSearch();assert.equal(h.$('#global-search-results').children.length,2);
 h.$('#search-completed').checked=true;h.context.renderGlobalSearch();assert.equal(h.$('#global-search-results').children.length,3);assert.equal(h.context.currentView,'inbox');assert.equal(h.$('#search-options').hidden,false);
});
test('background workspace rendering refreshes an open Search against latest data and preserves its controls/query',()=>{
 const h=setup();h.$('#search-scope').value='all';h.$('#search-completed').checked=true;h.context.renderTaskList();assert.equal(h.$('#global-search-results').children.length,3);
 h.context.currentPayload={...h.payload,tasks:h.payload.tasks.slice(0,1)};h.context.renderTaskList();assert.equal(h.$('#global-search-results').children.length,1);assert.equal(h.$('#search-options').hidden,false);assert.equal(h.$('#search-scope').value,'all');assert.equal(h.$('#search-completed').checked,true);assert.equal(h.$('#global-search-input').value,'Find');
});
test('Settings Search redirect opens once only after authenticated workspace loading finishes',async()=>{
 let finish,opened=0;const context=vm.createContext({pendingSearchRequest:true,pendingNewTaskRequest:false,csrfToken:'owner',settingsRoute:false,loadTasks:()=>new Promise(resolve=>{finish=resolve;}),openGlobalSearch:()=>opened++});vm.runInContext(source.match(/^async function initializeWorkspace\(.*$/m)[0],context);
 const pending=context.initializeWorkspace();assert.equal(opened,0);finish();await pending;assert.equal(opened,1);assert.equal(context.pendingSearchRequest,false);
 const again=context.initializeWorkspace();finish();await again;assert.equal(opened,1);
});
test('an unauthenticated workspace cannot open the pending Search request before sign-in',async()=>{
 let opened=0;const context=vm.createContext({pendingSearchRequest:true,pendingNewTaskRequest:false,csrfToken:null,settingsRoute:false,loadTasks:async()=>{},openGlobalSearch:()=>opened++});vm.runInContext(source.match(/^async function initializeWorkspace\(.*$/m)[0],context);await context.initializeWorkspace();assert.equal(opened,0);assert.equal(context.pendingSearchRequest,true);context.csrfToken='owner';await context.initializeWorkspace();assert.equal(opened,1);
});
test('same selected task reselect does not rewrite a dirty editor; internal label refresh is explicit',()=>{
 const notes={value:'Unsaved notes'},title={value:'Unsaved title'};let lookups=0;const context=vm.createContext({detailsDialog:{open:true},selectedTaskId:'task',currentPayload:{tasks:[]},$:id=>{lookups++;return id==='#details-notes'?notes:title;}});vm.runInContext(source.match(/^function openDetails\(.*$/m)[0],context);context.openDetails('task');assert.equal(notes.value,'Unsaved notes');assert.equal(title.value,'Unsaved title');assert.equal(lookups,0);
});
test('project grouping captions retain archived project names while new assignment references remain filtered',()=>{
 const h=setup();h.context.currentView='all';h.context.viewCopy.all=['Tasks','All'];h.context.currentPayload={spaces:h.payload.spaces,projects:[],allProjects:[{id:'archived',spaceId:'a',name:'QA archived',status:'archived'}],tasks:[{...h.payload.tasks[0],projectId:'archived'},{...h.payload.tasks[0],id:'unassigned',projectId:null}]};h.$('#group-select').value='project';h.context.renderTaskList();const headings=h.context.taskList.children.filter(n=>n.className==='task-group-heading').map(n=>n.textContent);assert.deepEqual(headings.sort(),['No project (1)','QA archived (1)']);assert.equal(h.context.currentPayload.projects.length,0);
});
test('Settings Add request opens once after authenticated loading and is not consumed before sign-in',async()=>{
 let opens=0;const context=vm.createContext({pendingSearchRequest:false,pendingNewTaskRequest:true,csrfToken:null,settingsRoute:false,loadTasks:async()=>{},openAddTask:()=>opens++});extractInit(context);await context.initializeWorkspace();assert.equal(opens,0);assert.equal(context.pendingNewTaskRequest,true);context.csrfToken='owner';await context.initializeWorkspace();assert.equal(opens,1);assert.equal(context.pendingNewTaskRequest,false);await context.initializeWorkspace();assert.equal(opens,1);
});
function extractInit(context){vm.runInContext(source.match(/^async function initializeWorkspace\(.*$/m)[0],context);}
