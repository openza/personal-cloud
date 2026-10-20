import {requestFanoutBound,requestCredits} from './dispatch-cost.js?v=quota-1';
const fanout=operation=>operation==='project.delete'||operation==='task.moveTree';
const same=(a,b)=>a?.entityId===b.entityId&&a.baseEntityVersion===b.baseEntityVersion&&a.operation===b.operation&&JSON.stringify(a.payload)===JSON.stringify(b.payload);
export function createFanoutDrafts({storage,locks,origin,getContext,getInstance,readStatus,now=Date.now,onChange=()=>{}}){
 origin=new URL(origin).origin;
 const key='openza-web-fanout-v1:'+origin;
 function read(){
  const raw=storage.getItem(key);if(!raw)return{version:1,origin,day:null,credits:0,drafts:Object.create(null)};
  if(raw.length>1048576)throw Error('This saved change could not be read safely. Keep your browser data and contact support.');
  const s=JSON.parse(raw);
  if(s?.version!==1||s.origin!==origin||!(s.day===null||/^\d{4}-\d{2}-\d{2}$/.test(s.day))||!Number.isSafeInteger(s.credits)||s.credits<0||!s.drafts||typeof s.drafts!=='object'||Array.isArray(s.drafts)||Object.keys(s.drafts).length>32)throw Error('Your saved change or today’s allowance could not be confirmed. Keep your browser data and contact support.');
  return s;
 }
 function save(s){storage.setItem(key,JSON.stringify(s));onChange();}
 const error=(code,message)=>Object.assign(new Error(message),{code,status:503});
 async function policy(){
  const cap=getContext()?.health?.capabilities?.catchupStatus;
  if(cap?.protocolVersion!==1||cap.path!=='/sync/catchup-status'||cap.staleAfterSeconds!==900)return null;
  try{
   const status=await readStatus(),time=Date.parse(status?.serverReadAt),budget=status?.webFanout;
   if(status?.protocolVersion!==1||typeof status.serverReadAt!=='string'||!Number.isFinite(time)||new Date(time).toISOString()!==status.serverReadAt||Math.abs(time-now())>900000||budget?.dailyCredits!==12000||budget.catchupDailyCredits!==1000||typeof budget.eligible!=='boolean'||!Number.isSafeInteger(budget.remainingCredits)||budget.remainingCredits<0||budget.remainingCredits>(budget.eligible?12000:1000))return null;
   return{day:status.serverReadAt.slice(0,10),remaining:budget.remainingCredits,limit:budget.eligible?12000:1000,notBefore:budget.notBefore};
  }catch{return null;}
 }
 async function atomic(action){
  if(!locks?.request)throw error('local_storage_unavailable','This browser cannot safely save this change. Use a current browser.');
  return locks.request(key+':account',action);
 }
 function rollover(s,p){if(p&&s.day!==p.day){if(s.day&&s.day>p.day)throw error('web_fanout_deferred','Today’s allowance could not be confirmed. Try checking again later.');s.day=p.day;s.credits=0;}}
 async function prepare(intent){
  if(!fanout(intent.operation))return;
  const body={operation:intent.operation,entityId:intent.entityId,payload:intent.payload};
  const bound=requestFanoutBound('/v1/tasks/mutations',body,getContext()),credits=requestCredits('/v1/tasks/mutations',body,bound),p=await policy();
  return atomic(()=>{
   const s=read();rollover(s,p);const instance=getInstance();
   if(intent.instanceId!==undefined&&intent.instanceId!==instance)throw error('session_changed','The cloud identity changed. Review the draft from the current session.');
   if(!instance)throw error('web_fanout_deferred','Your Personal Cloud could not be confirmed. Refresh before trying this change again.');
   const existing=Object.hasOwn(s.drafts,instance)?s.drafts[instance]:null;
   if(existing?.resolution==='cancelled')throw error('web_fanout_deferred','A cancelled change is saved in this browser. Review or remove that copy before saving another large change.');
   if(existing&&!same(existing,intent))throw error('web_fanout_deferred','Review or remove the large change already saved in this browser before saving another.');
   if(p&&credits<=12000&&credits<=p.remaining&&s.credits+credits<=p.limit)return;
   const tooLarge=bound!==undefined&&credits>12000;
   Object.defineProperty(s.drafts,instance,{value:existing??JSON.parse(JSON.stringify({entityId:intent.entityId,baseEntityVersion:intent.baseEntityVersion,operation:intent.operation,payload:intent.payload,createdAt:new Date(now()).toISOString()})),writable:true,configurable:true,enumerable:true});
   Object.assign(s.drafts[instance],{needsDesktop:tooLarge,notBefore:p?.notBefore??null});save(s);
   throw error(tooLarge?'web_fanout_too_large':'web_fanout_deferred',tooLarge?'This change is saved in this browser but is too large for the website. Make it in Openza Desktop.':'This change is saved in this browser and has not been sent. Your desktop may still be syncing or today’s allowance may be used up. You can keep making ordinary edits.');
  });
 }
 async function reserve(body,credits){
  if(!fanout(body?.operation)&&!body?.mutations?.some(m=>fanout(m.operation)))return;
  const p=await policy();
  return atomic(()=>{
   const s=read();rollover(s,p);
   if(credits>12000)throw error('web_fanout_too_large','This unfinished change is too large for the website. Check its status before sending more changes. You can still view the latest tasks.');
   if(!p||credits>p.remaining||s.credits+credits>p.limit)throw error('web_fanout_deferred','This unfinished change is waiting for Desktop sync or today’s allowance. More changes must wait, but you can still view the latest tasks.');
   s.credits+=credits;save(s);
  });
 }
 function draft(){const drafts=read().drafts,instance=getInstance();return Object.hasOwn(drafts,instance)?drafts[instance]:null;}
 async function cancel(){return atomic(()=>{const s=read();delete s.drafts[getInstance()];save(s);});}
 async function confirmed(intent){return atomic(()=>{const s=read(),instance=getInstance();if(Object.hasOwn(s.drafts,instance)&&s.drafts[instance].resolution!=='cancelled'&&same(s.drafts[instance],intent)){delete s.drafts[instance];save(s);}});}
 async function preserveCancelled({body,raw,canonicalHash,cancelledAt}){return atomic(()=>{
  const s=read(),instance=getInstance(),existing=Object.hasOwn(s.drafts,instance)?s.drafts[instance]:null;
  if(existing&&(!same(existing,body)||existing.originalRaw&&existing.originalRaw!==raw))throw Error('The cloud cancellation is recorded, but another browser draft must be preserved. Keep the exact pending copy for recovery.');
  const saved={entityId:body.entityId,baseEntityVersion:body.baseEntityVersion,operation:body.operation,payload:body.payload,createdAt:body.clientCreatedAt,needsDesktop:true,resolution:'cancelled',originalRaw:raw,canonicalHash,cancelledAt};
  Object.defineProperty(s.drafts,instance,{value:saved,writable:true,configurable:true,enumerable:true});save(s);
 });}
 return{prepare,reserve,draft,cancel,confirmed,preserveCancelled};
}
