import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceControls,connectedCatalogItems,eligibleCatalogItems} from '../public/workspace-controls.js';

class Node {
 value='';checked=false;hidden=false;children=[];handlers={};options=[];open=true;attributes={};classes=new Set();
 classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name)};
 addEventListener(name,fn){this.handlers[name]=fn;}
 replaceChildren(...children){this.children=children;this.options=children;this.value=children[0]?.value??'';}
 append(...children){this.children.push(...children);}
 querySelectorAll(){return [];}
 matches(){return false;}
 setAttribute(name,value){this.attributes[name]=value;}
 focus(){this.focused=true;}
 showModal(){this.open=true;}
 close(){this.open=false;}
}
function setup(run){
 const nodes=new Map(),previousDocument=globalThis.document,previousOption=globalThis.Option;
 globalThis.document={querySelector(id){if(!nodes.has(id))nodes.set(id,new Node());return nodes.get(id)},createElement(){return new Node()}};
 globalThis.Option=class {constructor(text,value){this.text=text;this.value=value;}};
 const restore=()=>{globalThis.document=previousDocument;globalThis.Option=previousOption;};try{const result=run(nodes);if(result?.then)return result.finally(restore);restore();return result;}catch(error){restore();throw error;}
}
const controls=(payload,selectedSpaceId)=>createWorkspaceControls({getState:()=>({payload,selectedSpaceId,editable:true,supported:true}),api:async()=>({}),sendMutation:async()=>{},refresh:async()=>{},selectSpace(){}});

test('background refresh preserves a new project draft and its selected Space',()=>setup(nodes=>{
 const payload={spaces:[{id:'space_a',name:'A'},{id:'space_b',name:'B'}],projects:[]},controller=controls(payload);
 controller.render();nodes.get('#create-project').handlers.click();nodes.get('#reference-space').value='space_b';nodes.get('#reference-name').value='Unsaved project';nodes.get('#reference-description').value='Unsaved description';
 assert.doesNotThrow(()=>controller.render());assert.equal(nodes.get('#reference-space').value,'space_b');assert.equal(nodes.get('#reference-name').value,'Unsaved project');assert.equal(nodes.get('#reference-description').value,'Unsaved description');
 payload.spaces=payload.spaces.slice(0,1);controller.render();assert.equal(nodes.get('#reference-space').value,'space_a');
}));
test('project pane opens a focused editor in the selected Space and Cancel returns to its origin',()=>setup(nodes=>{
 const payload={spaces:[{id:'archive',name:'Archive'},{id:'space_default',name:'Inbox'},{id:'studio',name:'Studio'}],projects:[]},controller=controls(payload,'studio');
 controller.render();nodes.get('#pane-create-project').handlers.click();
 const dialog=nodes.get('#workspace-dialog');assert.equal(dialog.open,true);assert.equal(dialog.classes.has('reference-editing'),true);assert.equal(nodes.get('#workspace-dialog-title').textContent,'Create project');assert.equal(nodes.get('#reference-space').value,'studio');assert.equal(nodes.get('#reference-name').focused,true);
 nodes.get('#reference-cancel').handlers.click();assert.equal(dialog.open,false);assert.equal(dialog.classes.has('reference-editing'),false);assert.equal(nodes.get('#reference-form').hidden,true);
}));
test('All Spaces project creation prefers the default Space; overview editing returns to the overview',()=>setup(nodes=>{
 const payload={spaces:[{id:'archive',name:'Archive'},{id:'space_default',name:'Inbox'}],projects:[]},controller=controls(payload,'*');controller.render();
 nodes.get('#create-project').handlers.click();assert.equal(nodes.get('#reference-space').value,'space_default');
 nodes.get('#reference-cancel').handlers.click();assert.equal(nodes.get('#workspace-dialog').open,true);assert.equal(nodes.get('#reference-form').hidden,true);assert.equal(nodes.get('#workspace-dialog-title').textContent,'Manage workspace');
}));
function catalogFixture(){const item=(id,fields={})=>({id,bridgeDeviceId:'bridge',isSkipped:false,available:true,adoptedTaskId:null,source:{title:'Task '+id,integrationKind:id==='two'?'microsoft-todo':'todoist',projectName:id==='two'?'Second':'First'},...fields});return{protocolVersion:1,product:'tasks',instanceId:'local',scopes:[],catalog:[item('one'),item('two'),item('skip',{isSkipped:true}),item('missing',{available:false}),item('pending'),item('adopted',{adoptedTaskId:'task'})],intents:[{id:'existing',action:'adopt',catalogId:'pending',state:'uncertain'}],routes:[]};}
test('connected filters search/source/project are presentation only; bulk eligibility excludes unavailable/skipped/adopted/unresolved',()=>{
 const catalog=catalogFixture();assert.deepEqual(connectedCatalogItems(catalog,{source:'microsoft-todo'}).map(i=>i.id),['two']);assert.deepEqual(connectedCatalogItems(catalog,{search:'Task two',project:JSON.stringify('Second')}).map(i=>i.id),['two']);assert.equal(connectedCatalogItems(catalog,{showSkipped:true}).some(i=>i.id==='skip'),true);assert.deepEqual(eligibleCatalogItems(catalog).map(i=>i.id),['one','two']);
});
for(const failSecond of [false,true])test(`Add all queues individual owned intents across hidden filters and reports ${failSecond?'partial failure':'pending confirmation'}`,()=>setup(async nodes=>{
 const data=catalogFixture(),sent=[],payload={spaces:[{id:'space_default',name:'Inbox'},{id:'studio',name:'Studio'}],projects:[]};
 createWorkspaceControls({getState:()=>({payload,selectedSpaceId:'studio',editable:true,supported:true,instanceId:'local',scopedRouting:false}),api:async()=>data,sendMutation:async(id,_version,operation,payload)=>{if(failSecond&&sent.length===1)throw new Error('Synthetic network failure');sent.push({id,operation,intent:payload.intent});data.intents.push({id,...payload.intent,state:'pending_desktop'});},refresh:async()=>{},selectSpace(){}});
 await nodes.get('#manage-workspace').handlers.click();nodes.get('#connected-search').value='Nothing visible';nodes.get('#connected-source').value='microsoft-todo';nodes.get('#connected-source').handlers.change();assert.equal(nodes.get('#adopt-all-connected').disabled,false);
 await nodes.get('#adopt-all-connected').handlers.click();assert.equal(sent.length,failSecond?1:2);assert.equal(sent[0].intent.catalogId,'one');assert.ok(sent.every(s=>s.operation==='provider.intent.request'&&s.intent.spaceId==='studio'&&s.intent.action==='adopt'));if(!failSecond)assert.equal(sent[1].intent.catalogId,'two');const notice=nodes.get('#workspace-message').textContent;assert.match(notice,new RegExp(`${failSecond?1:2} of 2 adoption requests saved`));assert.match(notice,/provider success is not confirmed/);if(failSecond)assert.match(notice,/Synthetic network failure/);assert.equal(nodes.get('#adopt-all-connected').disabled,!failSecond);
}));
