import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {workbenchLayout} from '../public/workbench-layout.js';
const base={width:1250,view:'inbox',projectId:null,detailsOpen:false,settings:false,narrowProjectsOpen:false};
for(const view of ['inbox','next','today','calendar','overdue','waiting','someday','completed'])test(`${view}: two panes closed and three with selected details`,()=>{
 const closed=workbenchLayout({...base,view}),opened=workbenchLayout({...base,view,detailsOpen:true});
 assert.equal(closed.showProjects,false);assert.equal(closed.showList,true);assert.equal(closed.showDetails,false);
 assert.equal(opened.showProjects,false);assert.equal(opened.showList,true);assert.equal(opened.showDetails,true);
});
test('Tasks and selected projects add the fourth pane only when details are open',()=>{
 for(const context of [{view:'all'},{view:'inbox',projectId:'project'}])for(const detailsOpen of [false,true]){
  const layout=workbenchLayout({...base,...context,detailsOpen});assert.equal(layout.showProjects,true);assert.equal(layout.showList,true);assert.equal(layout.showDetails,detailsOpen);
 }
});
test('remaining-workbench width controls narrow replacement, optional Projects and boundaries',()=>{
 for(const width of [320,680,899]){
  const editor=workbenchLayout({...base,width,view:'all',detailsOpen:true,narrowProjectsOpen:true});
  assert.equal(editor.showProjects,false);assert.equal(editor.showList,false);assert.equal(editor.showDetails,true);assert.equal(editor.projectsCommand,false);
  const list=workbenchLayout({...base,width,view:'all'});assert.equal(list.showList,true);assert.equal(list.showProjects,false);assert.equal(list.projectsCommand,true);
  assert.equal(workbenchLayout({...base,width,view:'all',narrowProjectsOpen:true}).showProjects,true);
 }
 const wide=workbenchLayout({...base,width:900,view:'all',detailsOpen:true});assert.equal(wide.narrow,false);assert.equal(wide.showProjects,true);assert.equal(wide.showList,true);
 assert.equal(workbenchLayout({...base,width:1249}).wideProjects,false);assert.equal(workbenchLayout(base).wideProjects,true);
});
test('Settings never exposes task projects or editor',()=>{
 const layout=workbenchLayout({...base,view:'all',projectId:'project',detailsOpen:true,settings:true});assert.equal(layout.showProjects,false);assert.equal(layout.showDetails,false);assert.equal(layout.showList,true);
});
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('one-time view request is consumed so reload preserves subsequent project selection',()=>{
 let replaced;
 const context=vm.createContext({URL,location:{href:'http://localhost/?view=inbox&keep=1#anchor'},history:{state:{existing:true},replaceState:(state,title,url)=>{replaced={state,url};}}});vm.runInContext(source.match(/^function consumeViewRequest\(.*$/m)[0],context);
 assert.equal(context.consumeViewRequest(),'inbox');assert.equal(replaced.url,'/?keep=1#anchor');assert.equal(replaced.state.existing,true);
 context.location.href='http://localhost/?keep=1';replaced=null;assert.equal(context.consumeViewRequest(),null);assert.equal(replaced,null);
});
test('dirty close defers navigation; clean close retains caller context; pending edits cannot leave',()=>{
 let dirty=true,busy=false,closed=0,prompted=0,navigated=0;
 const context=vm.createContext({detailsDialog:{open:true,classList:{contains:()=>busy},close(){this.open=false;closed++;}},detailAutosave:{cancel(){}},detailLabelBusy:false,pendingDetailsAction:null,captureDetailDraft:()=>dirty?{notes:'draft'}:{},$:()=>({showModal(){prompted++;}})});
 vm.runInContext(source.match(/^function requestDetailsClose\(.*$/m)[0],context);
 context.requestDetailsClose(()=>navigated++);assert.equal(prompted,1);assert.equal(closed,0);assert.equal(navigated,0);assert.equal(typeof context.pendingDetailsAction,'function');
 dirty=false;busy=true;context.requestDetailsClose(()=>navigated++);assert.equal(closed,0);
 busy=false;context.requestDetailsClose(()=>navigated++);assert.equal(closed,1);assert.equal(navigated,1);
});
