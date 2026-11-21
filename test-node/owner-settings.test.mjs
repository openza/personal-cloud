import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerSettings} from '../public/owner-settings.js';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const appSource=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function setupHarness({recoveryCode='openza-test-recovery-code',copyFails=false,finishFails=false}={}){
  const element=()=>({hidden:false,children:[],listeners:{},textContent:'',value:'test setup value',append(...nodes){this.children.push(...nodes);},replaceChildren(){this.children=[];},setAttribute(){},focus(){this.focused=true;},reset(){this.wasReset=true;},addEventListener(name,fn){this.listeners[name]=fn;}});
  const recoveryResult=element(),authPanel=element(),setupForm=element(),authCopy=element(),calls=[],copied=[],errors=[];let signedIn=0;
  recoveryResult.hidden=true;
  const context=vm.createContext({recoveryResult,authPanel,setupForm,authCopy,csrfToken:null,$:()=>element(),document:{createElement:element},navigator:{credentials:{create:async()=>({})},clipboard:{writeText:async value=>{if(copyFails)throw Error('denied');copied.push(value);}}},registrationOptions:x=>x,registrationCredential:x=>x,api:async path=>{calls.push(path);if(path.endsWith('/begin'))return{challenge:'challenge'};if(finishFails)throw Error('setup failed');return{csrfToken:'csrf',recoveryCode};},showSignedIn:()=>signedIn++,showAuthError:message=>errors.push(message)});
  context.recoveryAcknowledgmentPending=false;
  for(const name of ['setupOwner','runAuth'])vm.runInContext(appSource.match(new RegExp('^async function '+name+'\\(.*$','m'))[0],context);
  vm.runInContext(appSource.match(/^function showOneTimeSecret\([^]*?^}/m)[0],context);
  return{context,recoveryResult,authPanel,setupForm,calls,copied,errors,signedIn:()=>signedIn,setup:()=>context.setupOwner({preventDefault(){}})};
}
test('bootstrap displays the returned recovery code and waits for explicit acknowledgment before entering tasks',async()=>{
  const h=setupHarness();await h.setup();
  assert.deepEqual(h.calls,['/auth/bootstrap/begin','/auth/bootstrap/finish']);
  assert.equal(h.recoveryResult.hidden,false);assert.equal(h.authPanel.hidden,true);assert.equal(h.setupForm.wasReset,true);assert.equal(h.signedIn(),0);
  const [title,code,copy,status,saved]=h.recoveryResult.children;
  assert.match(title.textContent,/will not be shown again/);assert.equal(code.textContent,'openza-test-recovery-code');assert.equal(code.focused,true);
  assert.equal(copy.textContent,'Copy recovery code');await copy.listeners.click();assert.deepEqual(h.copied,['openza-test-recovery-code']);assert.match(status.textContent,/copied/);assert.equal(h.signedIn(),0);
  assert.match(saved.textContent,/I've saved it/);saved.listeners.click();assert.equal(h.signedIn(),1);assert.equal(h.recoveryResult.hidden,true);assert.equal(h.recoveryResult.children.length,0);
});
test('clipboard failure keeps the code visible with a manual-copy fallback and does not continue',async()=>{
  const h=setupHarness({copyFails:true});await h.setup();await h.recoveryResult.children[2].listeners.click();
  assert.match(h.recoveryResult.children[3].textContent,/copy it manually/);assert.equal(h.recoveryResult.children[1].textContent,'openza-test-recovery-code');assert.equal(h.recoveryResult.hidden,false);assert.equal(h.signedIn(),0);
});
for(const settingsRoute of [false,true])for(const metaKey of [false,true])test(`workspace shortcuts wait for recovery acknowledgment (settings=${settingsRoute}, meta=${metaKey})`,async()=>{
  const h=setupHarness(),actions=[];
  Object.assign(h.context,{settingsRoute,document:{...h.context.document,querySelector:()=>null},detailLabelBusy:false,detailsDialog:{open:false,classList:{contains:()=>false}},sessionStorage:{setItem(){}},location:{assign:url=>actions.push(url)},openAddTask:()=>actions.push('new-task'),openGlobalSearch:()=>actions.push('search')});
  vm.runInContext(appSource.match(/^function handleWorkspaceShortcut\(.*$/m)[0],h.context);
  const shortcut=key=>h.context.handleWorkspaceShortcut({key,ctrlKey:!metaKey,metaKey,preventDefault(){}});
  await h.setup();assert.equal(h.context.recoveryAcknowledgmentPending,true);assert.equal(h.context.csrfToken,'csrf');
  for(const key of ['k','n','f','s'])shortcut(key);
  assert.deepEqual(actions,[]);assert.equal(h.recoveryResult.hidden,false);assert.equal(h.signedIn(),0);
  h.recoveryResult.children[4].listeners.click();assert.equal(h.context.recoveryAcknowledgmentPending,false);
  shortcut('k');shortcut('n');assert.deepEqual(actions,['search',settingsRoute?'/?view=inbox':'new-task']);
});
for(const recoveryCode of [undefined,null,'',' '])test(`missing recovery code (${String(recoveryCode)}) cannot enter the workspace`,async()=>{
  const h=setupHarness({recoveryCode:null});h.context.api=async()=>({challenge:'challenge',recoveryCode});await h.setup();
  assert.equal(h.signedIn(),0);assert.equal(h.authPanel.hidden,false);assert.equal(h.recoveryResult.hidden,true);assert.match(h.errors[0],/recovery code was not returned/);
  assert.equal(h.context.recoveryAcknowledgmentPending,true);
});
test('failed bootstrap does not show a secret or enter the workspace',async()=>{
  const h=setupHarness({finishFails:true});await h.setup();assert.deepEqual(h.errors,['setup failed']);assert.equal(h.recoveryResult.hidden,true);assert.equal(h.signedIn(),0);
});

for(const action of ['createPairingGrant','loadDevices'])for(const failed of [false,true]) {
  test(`${action} suppresses late ${failed?'unauthorized':'success'} after signout and a new session`,async()=>{
    let generation=0,resolve,reject,rendered=0,signouts=0;
    const settings=createOwnerSettings({api:()=>new Promise((yes,no)=>{resolve=yes;reject=no;}),
      getGeneration:()=>generation,isSignedIn:()=>true,renderPairing:()=>rendered++,renderDevices:()=>rendered++,
      pairingError:()=>rendered++,devicesError:()=>rendered++,onUnauthorized:()=>signouts++});
    const pending=settings[action]();generation++;
    if(failed)reject(Object.assign(Error('old session'),{status:401}));else resolve({});
    await pending;assert.equal(rendered,0);assert.equal(signouts,0);
  });
}
test('current settings responses render and current unauthorized response signs out',async()=>{
  let failed=false,renders=0,signouts=0;
  const settings=createOwnerSettings({api:async()=>{if(failed)throw Object.assign(Error('expired'),{status:401});return{};},
    getGeneration:()=>0,isSignedIn:()=>true,renderPairing:()=>renders++,renderDevices:()=>renders++,
    pairingError:()=>assert.fail(),devicesError:()=>assert.fail(),onUnauthorized:()=>signouts++});
  await settings.loadDevices();await settings.createPairingGrant();failed=true;await settings.loadDevices();
  assert.equal(renders,2);assert.equal(signouts,1);
});
