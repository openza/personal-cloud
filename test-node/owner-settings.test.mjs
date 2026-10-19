import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerSettings} from '../public/owner-settings.js';

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
