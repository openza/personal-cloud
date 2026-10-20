function canonical(value){
 if(value===null||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){if(!Number.isSafeInteger(value))throw Error('Invalid pending number.');return String(value);}
 if(typeof value==='string'){for(const char of value){const code=char.codePointAt(0);if(code>=0xd800&&code<=0xdfff)throw Error('Invalid pending text.');}return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>canonical(key)+':'+canonical(value[key])).join(',')+'}';
}
export async function pendingCanonicalHash(raw){
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(JSON.parse(raw))));
 return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export function createPendingWebRecovery({storage,locks,sequenceKey,getInstance,getDevice,getGeneration,getCapability,api,preserveCancelled,onApplied=async()=>{}}){
 function assertCurrent(s){if(s.generation!==getGeneration()||s.instance!==getInstance()||s.device!==getDevice()||storage.getItem(s.key+':pending')!==s.raw)throw Error('The owner session or exact unfinished change changed. Check it again.');}
 async function snapshot(){
  const capability=getCapability();if(capability?.protocolVersion!==1||capability.path!=='/auth/web-pending-change')throw Error('This cloud cannot safely check the unfinished change. Update it with compatible Desktop first.');
  const generation=getGeneration(),instance=getInstance(),device=getDevice(),key=`${sequenceKey}:${instance}:${device}`,raw=storage.getItem(key+':pending');
  if(!raw||raw.length>16384)throw Error('The saved unfinished change could not be read safely. Keep your browser data.');
  const body=JSON.parse(raw);
  if(body.instanceId!==instance||body.deviceId!==device||body.protocolVersion!==1||body.product!=='tasks'||!['project.delete','task.moveTree'].includes(body.operation)||!Number.isSafeInteger(body.deviceSequence)||body.deviceSequence<1||body.deviceSequence>=Number.MAX_SAFE_INTEGER)throw Error('This unfinished change could not be checked safely. Keep your browser data and contact support.');
  const s={instance,device,key,raw,body,generation,canonicalHash:await pendingCanonicalHash(raw)};assertCurrent(s);return s;
 }
 function validate(s,result){
  if(result?.protocolVersion!==1||result.canonicalHash!==s.canonicalHash||result.mutationId!==s.body.mutationId||result.deviceId!==s.device||result.deviceSequence!==s.body.deviceSequence||!['applied','unapplied','cancelled','unknown'].includes(result.state))throw Error('The unfinished change result could not be verified. Keep it pending.');
  if(result.state==='unapplied'&&result.canCancel!==true||result.state==='unknown'&&result.canCancel!==false)throw Error('The unfinished change status is incomplete. Keep it pending.');
  if(result.state==='cancelled'&&(typeof result.cancelledAt!=='string'||!Number.isFinite(Date.parse(result.cancelledAt))))throw Error('The cancellation proof could not be verified.');
  if(result.state==='applied'){
   const r=result.receipt;
   if(r?.protocolVersion!==1||r.product!=='tasks'||!['accepted','duplicate'].includes(r.outcome)||r.mutationId!==s.body.mutationId||r.entityId!==s.body.entityId||!Number.isSafeInteger(r.entityVersion)||r.entityVersion<1||!Number.isSafeInteger(r.changeSeq)||r.changeSeq<1||!Number.isFinite(Date.parse(r.serverAcceptedAt)))throw Error('The already-applied receipt could not be verified.');
  }
  return result;
 }
 async function reconcile(s,result){
  if(!['applied','cancelled'].includes(result.state))return;
  assertCurrent(s);
  const current=Number(storage.getItem(s.key)??'1');
  if(current!==s.body.deviceSequence&&current!==s.body.deviceSequence+1)throw Error('The browser’s saved progress could not be confirmed. Keep the unfinished change.');
  if(result.state==='cancelled')await preserveCancelled({...s,cancelledAt:result.cancelledAt});
  else await onApplied(s.body,result.receipt);
  assertCurrent(s);
  storage.setItem(s.key,String(s.body.deviceSequence+1));
  storage.removeItem(s.key+':pending');
 }
 async function lock(action){if(!locks?.request)throw Error('Browser coordination is required for unfinished change recovery.');const key=`${sequenceKey}:${getInstance()}:${getDevice()}:write`;return locks.request(key,action);}
 async function check(){return lock(async()=>{
  const s=await snapshot();
  const result=validate(s,await api('/auth/web-pending-change',{method:'POST',csrf:true,body:{protocolVersion:1,action:'check',mutation:s.body}}));
  assertCurrent(s);await reconcile(s,result);return{...s,result};
 });}
 async function cancel(ticket){return lock(async()=>{
  assertCurrent(ticket);if(ticket.result?.state!=='unapplied'||ticket.result.canCancel!==true)throw Error('Only a checked unapplied change can be cancelled.');
  const result=validate(ticket,await api('/auth/web-pending-change',{method:'POST',csrf:true,body:{protocolVersion:1,action:'cancel',mutation:ticket.body,canonicalHash:ticket.result.canonicalHash}}));
  assertCurrent(ticket);await reconcile(ticket,result);return result;
 });}
 return{check,cancel};
}
