import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {providerDeliveryLabel} from "../public/provider-status.js";
test("Openza completion is never presented as provider confirmation while pending or uncertain",()=>{
  assert.equal(providerDeliveryLabel(null),"");
  assert.equal(providerDeliveryLabel({state:"pending_desktop"}),"Waiting for Desktop to deliver to provider");
  assert.equal(providerDeliveryLabel({state:"pending_desktop",deliveryState:"started"}),"Provider delivery started; check Desktop if unfinished");
  assert.equal(providerDeliveryLabel({state:"confirmed"}),"Provider confirmed");
  assert.equal(providerDeliveryLabel({state:"rejected",errorCode:"authentication_required"}),"Provider delivery rejected (authentication required)");
});
test("polling refreshes open provider details without replacing unsaved fields",()=>{
  const source=readFileSync(new URL("../public/app.js",import.meta.url),"utf8"),nodes=new Map();
  const field={value:"Unsaved notes",disabled:false},dialog={open:true,classList:{contains:()=>false},querySelectorAll:()=>[field],close(){this.open=false;}};
  const context=vm.createContext({currentPayload:{},currentEditable:true,selectedSpaceId:null,selectedTaskId:"task_a",detailsDialog:dialog,lastUpdated:{},providerDeliveryLabel,
    $:selector=>{if(!nodes.has(selector))nodes.set(selector,{});return nodes.get(selector);},normalizePayload:value=>value,
    persistWorkspaceState(){},setStatus(){},setNotice(){},hydrateReferences(){},renderSidebar(){},renderTaskList(){},formatTime:value=>value});
  for(const name of ["renderWorkspace","refreshOpenDetailsStatus","renderSource"])vm.runInContext(source.match(new RegExp(`^function ${name}\\(.*$`,"m"))[0],context);
  const task={id:"task_a",completionState:"completed",source:{title:"Provider task"},externalCommand:{state:"confirmed"}};
  const poll=(command,state="current")=>{task.externalCommand=command;context.renderWorkspace({tasks:[task],spaces:[],serverReadAt:"now"},state,"then");return nodes.get("#source-copy").textContent;};
  assert.match(poll({state:"confirmed"}),/Provider confirmed/);
  assert.match(poll({state:"pending_desktop"}),/Waiting for Desktop/);
  assert.match(poll({state:"pending_desktop",deliveryState:"started"}),/started; check Desktop/);
  assert.match(poll({state:"rejected",errorCode:"authentication_required"}),/rejected \(authentication required\)/);
  assert.match(poll({state:"confirmed"}),/Provider confirmed/);
  assert.equal(field.value,"Unsaved notes");
  assert.match(poll({state:"confirmed"},"stale"),/Last confirmed; may be outdated/);assert.equal(field.disabled,true);
  poll({state:"pending_desktop"});assert.equal(field.disabled,false);
  dialog.classList.contains=()=>true;field.disabled=true;poll({state:"confirmed"});assert.equal(field.disabled,true);
  context.renderWorkspace({tasks:[],spaces:[],serverReadAt:"now"},"current","then");assert.equal(dialog.open,false);assert.equal(context.selectedTaskId,null);
});
