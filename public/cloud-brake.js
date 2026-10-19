import {nextUtcReset} from './quota-errors.js?v=quota-1';
import {dispatchLimits} from './dispatch-cost.js?v=quota-1';

export const webDispatchLimits=dispatchLimits;
const resources=new Set(['d1_rows_read','d1_rows_written','workers_requests','requests','envelopes','writeCredits','storage']);
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export function createCloudBrake({storage,locks,origin,getInstance=()=>null,now=Date.now,monotonic=()=>performance.now(),limits=webDispatchLimits,onChange=()=>{}}){
  origin=new URL(origin).origin;
  limits={...dispatchLimits,...limits};
  const key='openza-cloud-brake-v1:'+origin,wall=now(),tick=monotonic();
  const clock=()=>wall+Math.max(0,monotonic()-tick);
  let memory=null,durable=true,readable=true,lastNotice='';
  const fresh=()=>({version:1,origin,instanceId:getInstance()??null,day:new Date(clock()).toISOString().slice(0,10),requests:0,envelopes:0,writeCredits:0,hold:null,locallySignedOut:false});
  function valid(s){return s?.version===1&&s.origin===origin&&iso(s.day+'T00:00:00.000Z')&&
    (s.instanceId===null||typeof s.instanceId==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(s.instanceId))&&
    (s.locallySignedOut===undefined||typeof s.locallySignedOut==='boolean')&&['requests','envelopes','writeCredits'].every(k=>Number.isSafeInteger(s[k])&&s[k]>=0)&&(!s.hold||
      (validHoldIdentity(s.hold)&&resources.has(s.hold.resource)&&iso(s.hold.observedAt)&&iso(s.hold.resetAt)&&Date.parse(s.hold.resetAt)>Date.parse(s.hold.observedAt)&&Date.parse(s.hold.resetAt)-Date.parse(s.hold.observedAt)<=86400000&&
       Number.isFinite(s.hold.offset)&&Math.abs(s.hold.offset)<=300000&&Number.isInteger(s.hold.failures)&&s.hold.failures>=0&&s.hold.failures<=20&&
       (s.hold.retryAt===null||iso(s.hold.retryAt)&&Date.parse(s.hold.retryAt)<=Math.max(Date.parse(s.hold.resetAt),clock()+s.hold.offset)+305000)));}
  function validHoldIdentity(h){
    if(h.code==='daily_quota_exceeded')return ['d1_rows_read','d1_rows_written','workers_requests'].includes(h.resource)&&iso(h.cloudObservedAt)&&iso(h.cloudResetAt)&&h.cloudResetAt===nextUtcReset(new Date(h.cloudObservedAt))&&Date.parse(h.resetAt)-Date.parse(h.observedAt)===Date.parse(h.cloudResetAt)-Date.parse(h.cloudObservedAt);
    if(h.code==='local_operation_budget_exceeded')return h.resource==='writeCredits';
    if(h.code==='local_budget_exceeded')return ['requests','envelopes','writeCredits'].includes(h.resource);
    return ['local_storage_unavailable','local_budget_state_invalid'].includes(h.code)&&h.resource==='storage';
  }
  function localHold(code,resource){return{code,resource,observedAt:new Date(clock()).toISOString(),resetAt:nextUtcReset(new Date(clock())),offset:0,failures:0,retryAt:null};}
  function read(){
    if(!durable&&memory){
      // A failed write can recover while other tabs keep reserving. Merge the
      // latest shared counters before admission; never overwrite them with a
      // stale in-memory ledger. Keep this tab's memory brake until its probe.
      try{const value=storage.getItem(key),shared=value?JSON.parse(value):null;readable=!value||valid(shared);
        if(readable&&shared){
          if(shared.day>memory.day){memory.day=shared.day;for(const k of ['requests','envelopes','writeCredits'])memory[k]=shared[k];}
          else if(shared.day===memory.day)for(const k of ['requests','envelopes','writeCredits'])memory[k]=Math.max(memory[k],shared[k]);
          memory.instanceId??=shared.instanceId;memory.locallySignedOut=memory.locallySignedOut||shared.locallySignedOut;
          if(shared.hold&&(!memory.hold||Date.parse(shared.hold.resetAt)>Date.parse(memory.hold.resetAt)||Date.parse(shared.hold.retryAt??shared.hold.resetAt)>Date.parse(memory.hold.retryAt??memory.hold.resetAt)))memory.hold=shared.hold;
        }
      }catch{readable=false;}return memory;
    }
    try{const value=storage.getItem(key);if(value){const state=JSON.parse(value);if(valid(state)){memory=state;return state;}
      const closed=fresh();closed.hold=localHold('local_budget_state_invalid','storage');memory=closed;durable=false;readable=false;return closed;}}
    catch{const closed=memory??fresh();closed.hold??=localHold('local_storage_unavailable','storage');memory=closed;durable=false;readable=false;return closed;}
    return memory??=fresh();
  }
  const effective=(s)=>clock()+(s.hold?.offset??0);
  function status(){const s=read();if(!s.hold)return null;return{...s.hold,durable,instanceId:s.instanceId,
    nextAttemptAt:new Date(Math.max(Date.parse(s.hold.resetAt),Date.parse(s.hold.retryAt??s.hold.resetAt))).toISOString(),
    remaining:{requests:Math.max(0,limits.requests-s.requests),envelopes:Math.max(0,limits.envelopes-s.envelopes),writeCredits:Math.max(0,limits.writeCredits-s.writeCredits)}};}
  function notify(){const current=status(),signature=JSON.stringify(current);if(signature!==lastNotice){lastNotice=signature;onChange(current);}}
  function save(s){memory=s;if(!readable){durable=false;notify();return false;}try{storage.setItem(key,JSON.stringify(s));durable=true;}catch{durable=false;}notify();return durable;}
  const failure=()=>Object.assign(new Error(status()?.resource==='storage'?'Cloud protection could not be saved. Restart protection is unavailable.':status()?.code==='local_operation_budget_exceeded'?'This pending operation exceeds a whole daily reservation. Automatic retries are stopped; the pending change is retained.':'Cloud requests are paused until the reset or retry shown.'),{status:503,code:status()?.code??'cloud_paused',pause:status()});
  async function atomic(fn){if(!locks?.request){const s=read();s.hold??=localHold('local_storage_unavailable','storage');if(effective(s)>=Math.max(Date.parse(s.hold.resetAt),Date.parse(s.hold.retryAt??s.hold.resetAt)))backoff(s);durable=false;notify();throw failure();}
    return locks.request(key+':account',fn);}
  async function pause(quota,observedAt){return atomic(()=>{
    const s=read(),localNow=clock();
    if(quota.protocolVersion!==1||!['d1_rows_read','d1_rows_written','workers_requests'].includes(quota.resource)||Math.abs(observedAt-localNow)>2*86400000)return false;
    const cloudReset=quota.resetAt===nextUtcReset(new Date(observedAt))?quota.resetAt:nextUtcReset(new Date(observedAt));
    const remaining=Date.parse(cloudReset)-observedAt;
    s.hold={code:'daily_quota_exceeded',resource:quota.resource,observedAt:new Date(localNow).toISOString(),cloudObservedAt:new Date(observedAt).toISOString(),cloudResetAt:cloudReset,resetAt:new Date(localNow+remaining).toISOString(),offset:0,failures:0,retryAt:null};
    s.instanceId=getInstance()??s.instanceId;save(s);return true;
  });}
  async function run(path,envelopes,action,writeCredits=0){
    if(!Number.isSafeInteger(envelopes)||envelopes<0||!Number.isSafeInteger(writeCredits)||writeCredits<0)throw Error('Invalid dispatch reservation.');
    const initial=read(),isResume=Boolean(initial.hold);
    if(isResume){const earliest=Math.max(Date.parse(initial.hold.resetAt),Date.parse(initial.hold.retryAt??initial.hold.resetAt));
      if(initial.hold.code==='local_operation_budget_exceeded'||effective(initial)<earliest||path!=='/health')throw failure();}
    const execute=async()=>{
      let held;
      await atomic(()=>{
        const s=read();if(s.hold){const earliest=Math.max(Date.parse(s.hold.resetAt),Date.parse(s.hold.retryAt??s.hold.resetAt));
          if(!isResume||path!=='/health'||effective(s)<earliest)throw failure();held=JSON.stringify(s.hold);}
        const day=new Date(effective(s)).toISOString().slice(0,10);if(s.day<day){s.day=day;s.requests=0;s.envelopes=0;s.writeCredits=0;}
        if(writeCredits>limits.writeCredits||envelopes>limits.envelopes){s.hold=localHold('local_operation_budget_exceeded','writeCredits');save(s);throw failure();}
        const exceeded=s.requests+1>limits.requests?'requests':s.envelopes+envelopes>limits.envelopes?'envelopes':s.writeCredits+writeCredits>limits.writeCredits?'writeCredits':null;
        if(exceeded){s.hold=localHold('local_budget_exceeded',exceeded);save(s);throw failure();}
        s.requests++;s.envelopes+=envelopes;s.writeCredits+=writeCredits;s.instanceId=getInstance()??s.instanceId;
        if(!save(s)){s.hold??=localHold('local_storage_unavailable','storage');if(held)backoff(s);notify();throw failure();}
      });
      try{
        // Another tab may have persisted a pause while this reservation's lock
        // was being released. A reservation never grants permission past it.
        const latest=read();if(held?JSON.stringify(latest.hold)!==held:Boolean(latest.hold))throw failure();
        const value=await action();
        if(held)await atomic(()=>{const s=read();if(JSON.stringify(s.hold)!==held)return;
          if(value.response.ok&&value.result?.status==='ok'&&value.result.protocolVersion===1&&value.result.product==='tasks')s.hold=null;
          else backoff(s);save(s);});
        return value;
      }catch(error){if(held)await atomic(()=>{const s=read();if(JSON.stringify(s.hold)===held){backoff(s);save(s);}});throw error;}
    };
    if(!isResume||!locks?.request)return execute();
    // ifAvailable avoids queued reset probes becoming a cross-tab request burst.
    return locks.request(key+':resume',{ifAvailable:true},async lock=>{if(!lock)throw failure();
      const current=read();if(!current.hold)throw failure();return execute();});
  }
  function backoff(s){s.hold.failures=Math.min(20,s.hold.failures+1);s.hold.retryAt=new Date(effective(s)+Math.min(300000,30000*2**(s.hold.failures-1))).toISOString();}
  const rememberAuth=locallySignedOut=>atomic(()=>{const s=read();s.locallySignedOut=locallySignedOut;if(!save(s)){s.hold??=localHold('local_storage_unavailable','storage');notify();}});
  return{run,pause,status,refresh:notify,referenceTime:clock,isLocallySignedOut:()=>read().locallySignedOut===true,
    rememberSignOut:()=>rememberAuth(true),rememberSignIn:()=>rememberAuth(false),remainingDelay:()=>{const s=read();return s.hold?Math.max(0,Math.max(Date.parse(s.hold.resetAt),Date.parse(s.hold.retryAt??s.hold.resetAt))-effective(s)):null;},
    canSend:()=>!read().hold};
}
