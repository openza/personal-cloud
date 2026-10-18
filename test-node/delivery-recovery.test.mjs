import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
class Element {
 children=[];textContent='';disabled=false;hidden=false;handlers={};
 replaceChildren(...items){this.children=items;this.textContent='';}append(...items){this.children.push(...items);}addEventListener(name,handler){this.handlers[name]=handler;}
}
function setup(responses=[]){
 const nodes=new Map(),get=key=>{if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key);},calls=[];let accepted=false,confirmations=0,signouts=0;
 const context=vm.createContext({ownerSessionGeneration:0,csrfToken:'synthetic',deliveryLoadInFlight:false,deliveryReconcileInFlight:false,deliveryCursor:null,$:get,document:{createElement:()=>new Element()},api:async(...args)=>{calls.push(args);const next=responses.shift();if(next instanceof Error)throw next;if(typeof next==='function')return await next(...args);return next;},confirmAction:async(_heading,message)=>{confirmations++;assert.match(message,/old desktop is stopped/);assert.match(message,/checked this task/);assert.match(message,/does not confirm provider success/);return accepted;},signOut:async()=>{signouts++;context.ownerSessionGeneration++;context.csrfToken=null;}});
 for(const name of ['loadDeliveries','reconcileDelivery'])vm.runInContext(source.match(new RegExp(`^async function ${name}\\(.*$`,'m'))[0],context);
 return{context,get,calls,confirm:value=>accepted=value,confirmations:()=>confirmations,signouts:()=>signouts};
}
const delivery=(id,revoked=true,state='started')=>({claimId:id,title:'Synthetic task',command:'complete',deviceName:'Synthetic desktop',deviceRevokedAt:revoked?'2026-10-18T00:00:00.000Z':null,state});
test('Settings restores owner delivery recovery without restoring provider intake or routing',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');for(const id of ['delivery-list','delivery-status','more-deliveries','retry-deliveries'])assert.match(html,new RegExp(`id="${id}"`));assert.match(source,/devicesPanel.hidden=false;loadDevices\(\);loadDeliveries\(\)/);assert.match(html,/check the external provider before reconciling/);assert.doesNotMatch(html,/id="connected-catalog"|id="routing-rules"/);
});
test('delivery rows gate reconciliation on revocation and preserve 100-plus-one pagination',async()=>{
 const first=Array.from({length:100},(_,i)=>delivery('claim_'+i,i!==0,i%2?'started':'reserved')),h=setup([{deliveries:first,hasMore:true,nextCursor:'claim_99'},{deliveries:[delivery('claim_100')],hasMore:false,nextCursor:null}]);await h.context.loadDeliveries();assert.equal(h.get('#delivery-list').children.length,100);assert.equal(h.get('#delivery-list').children[0].children[1].disabled,true);assert.equal(h.get('#delivery-list').children[1].children[1].disabled,false);assert.match(h.get('#delivery-list').children[0].children[0].textContent,/Reserved/);assert.equal(h.get('#more-deliveries').hidden,false);assert.equal(h.calls.length,1);await h.context.loadDeliveries(false);assert.equal(h.calls[1][0],'/auth/provider-deliveries?cursor=claim_99');assert.equal(h.get('#delivery-list').children.length,101);assert.equal(h.get('#more-deliveries').hidden,true);assert.equal(h.confirmations(),0);
});
test('load-more failure retains prior rows and cursor and reports a retryable error',async()=>{
 const h=setup([{deliveries:[delivery('claim_a')],hasMore:true,nextCursor:'claim_a'},new Error('Offline'),{deliveries:[delivery('claim_b')],hasMore:false,nextCursor:null}]);await h.context.loadDeliveries();await h.context.loadDeliveries(false);assert.equal(h.get('#delivery-list').children.length,1);assert.match(h.get('#delivery-status').textContent,/could not be loaded.*Retry/);assert.equal(h.get('#more-deliveries').disabled,false);await h.context.loadDeliveries(false);assert.equal(h.calls[1][0],h.calls[2][0]);assert.equal(h.get('#delivery-list').children.length,2);
});
test('Cancel does not reconcile; explicit confirmation sends both acknowledgements and refreshes',async()=>{
 const h=setup([{outcome:'reconciled'},{deliveries:[],hasMore:false,nextCursor:null}]);await h.context.reconcileDelivery('claim_a');assert.equal(h.calls.length,0);h.confirm(true);await h.context.reconcileDelivery('claim_a');assert.equal(h.calls[0][0],'/auth/provider-deliveries/reconcile');assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0][1])),{method:'POST',csrf:true,body:{claimId:'claim_a',deliveryHostStopped:true,providerStateChecked:true}});assert.equal(h.calls[1][0],'/auth/provider-deliveries');assert.equal(h.get('#delivery-list').textContent,'No active provider deliveries.');
});
for(const operation of ['list','reconcile'])test(`${operation}401 returns to sign-in without automatic recovery`,async()=>{
 const h=setup([Object.assign(new Error('Expired'),{status:401})]);h.confirm(true);await(operation==='list'?h.context.loadDeliveries():h.context.reconcileDelivery('claim_a'));assert.equal(h.signouts(),1);assert.equal(h.context.csrfToken,null);assert.equal(h.calls.length,1);
});
test('late list response cannot overwrite a newer owner session',async()=>{
 let release;const h=setup([()=>new Promise(resolve=>release=resolve)]),pending=h.context.loadDeliveries();h.context.ownerSessionGeneration++;release({deliveries:[delivery('old_claim')],hasMore:false,nextCursor:null});await pending;assert.equal(h.get('#delivery-list').children.length,0);
});
test('a confirmation started by an older owner session cannot submit after session change',async()=>{
 const h=setup();let confirm;h.context.confirmAction=()=>new Promise(resolve=>confirm=resolve);const pending=h.context.reconcileDelivery('claim_a');h.context.ownerSessionGeneration++;confirm(true);await pending;assert.equal(h.calls.length,0);
});
