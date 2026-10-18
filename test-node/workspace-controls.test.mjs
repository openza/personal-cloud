import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceControls} from '../public/workspace-controls.js';

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
test('Manage workspace edits shared references without requesting a provider catalog',()=>setup(async nodes=>{
 const payload={spaces:[{id:'space_default',name:'Inbox'}],projects:[]},sent=[];
 createWorkspaceControls({getState:()=>({payload,selectedSpaceId:'space_default',editable:true,supported:true}),sendMutation:async(...args)=>sent.push(args),refresh:async()=>{}});
 await nodes.get('#manage-workspace').handlers.click();
 assert.equal(nodes.get('#workspace-dialog').open,true);
 assert.equal(nodes.get('#workspace-message').textContent,'');
 assert.equal(nodes.has('#connected-list'),false);
 assert.equal(nodes.has('#routing-form'),false);
 nodes.get('#create-space').handlers.click();nodes.get('#reference-name').value='Shared Space';
 await nodes.get('#reference-form').handlers.submit({preventDefault(){}});
 // Event handlers start asynchronous mutations; wait for the save to settle.
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(sent.length,1);assert.equal(sent[0][2],'space.put');
 assert.equal(sent[0][3].space.name,'Shared Space');
 assert.equal(nodes.get('#settings-create-space').disabled,false);
 assert.equal(nodes.get('#settings-spaces').children[0].disabled,false);
}));
