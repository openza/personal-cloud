// HTTP owns serialization, CSRF retry and the session boundary. It never renders.
import {typedQuota,workers1027,boundedErrorText,responseTime,nextUtcReset} from './quota-errors.js?v=quota-1';
import {requestCredits,requestFanoutBound,fanoutBudget} from './dispatch-cost.js?v=quota-1';
export function sessionChanged(dispatched = false) {
  return Object.assign(new Error("The owner session changed. Retry from the current session."), {
    code: "session_changed", dispatched,
  });
}

export function createOwnerApi({ fetch, locks, getGeneration, getCsrf, setCsrf, brake, getFanoutContext=()=>({}), refreshFanout, reserveFanout }) {
  return async function api(path, options = {}) {
    const generation = getGeneration();
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    let dispatched = false;
    const assertCurrent = () => {
      if (generation !== getGeneration()) throw sessionChanged(dispatched);
    };
    const perform = async () => {
      assertCurrent();
      let csrfRetried=false,fanoutRetried=false;
      for (let attempt = 0; attempt < 3; attempt++) {
        assertCurrent();
        const headers = {};
        const fanoutBound=requestFanoutBound(path,options.body,getFanoutContext());
        if(fanoutBound!==undefined)headers[fanoutBudget.requestHeader]=String(fanoutBound);
        if (body !== undefined) headers["content-type"] = "application/json";
        if (options.csrf) {
          if (!getCsrf()) throw new Error("Sign in again to continue.");
          headers["x-openza-csrf"] = getCsrf();
        }
        let response, result;
        try {
          const send=async()=>{
            if(path==='/v1/tasks/mutations'||path==='/v1/tasks/mutations/batch')await reserveFanout?.(options.body,requestCredits(path,options.body,fanoutBound));
            assertCurrent();dispatched=true;
            const deadline=path==='/health'&&brake?.status()?AbortSignal.timeout(10000):null;
            const signal=deadline?(options.signal?AbortSignal.any([deadline,options.signal]):deadline):options.signal;
            const response=await fetch(path,{method:options.method||'GET',headers,body,credentials:'same-origin',cache:'no-store',signal});
            // Quota is origin-scoped: persist it even if the initiating session retired.
            let result;
            const type=response.headers?.get?.('content-type')?.split(';')[0].trim().toLowerCase();
            const reference=brake?.referenceTime()??Date.now(),observed=responseTime(response.headers,reference);
            if(!response.ok&&['text/html','text/plain'].includes(type)){
              const text=await boundedErrorText(response);
              if(workers1027(response.status,response.headers,text)){
                const quota={protocolVersion:1,resource:'workers_requests',resetAt:nextUtcReset(new Date(observed))};
                await brake?.pause(quota,observed);
                throw Object.assign(new Error('Personal Cloud reached its daily Cloudflare request limit.'),{code:'daily_quota_exceeded',status:503,quota});
              }
              result={};
            }else result=await response.json().catch(()=>({}));
            const quota=(!response.ok||path==='/v1/tasks/mutations/batch')?typedQuota(result,observed):null;
            if(quota)await brake?.pause(quota,observed);
            assertCurrent();
            // A successful sequential batch must retain its validated receipt prefix.
            return {response,result};
          };
          const envelopes=path==='/v1/tasks/mutations'?1:path==='/v1/tasks/mutations/batch'?options.body?.mutations?.length??0:0;
          const sent=brake?await brake.run(path,envelopes,send,requestCredits(path,options.body,fanoutBound)):await send();
          response=sent.response;result=sent.result;assertCurrent();
        } catch (error) {
          assertCurrent();
          throw error;
        }
        if (response.ok) return result;
        const error = Object.assign(new Error(result?.error?.message || "Personal Cloud rejected the request."), {
          status: response.status, code: result?.error?.code,
          ...(result?.error?.quota?{quota:result.error.quota}:{}),
        });
        if (options.csrf && !csrfRetried && response.status === 403 && error.code === "csrf_failed") {
          csrfRetried=true;
          // This attempt was definitively rejected before domain execution.
          dispatched = false;
          try {
            const session = await api("/auth/session");
            assertCurrent();
            if (typeof session.csrfToken !== "string" || !session.csrfToken)
              throw new Error("Owner token refresh was not confirmed.");
            setCsrf(session.csrfToken);
          } catch (refreshError) {
            assertCurrent();
            error.cause = refreshError;
            throw error;
          }
          continue;
        }
        if(!fanoutRetried&&response.status===409&&error.code==='fanout_bound_exceeded'&&refreshFanout){
          fanoutRetried=true;
          await refreshFanout();assertCurrent();
          continue;
        }
        throw error;
      }
    };
    return options.csrf && locks?.request
      ? locks.request("openza-owner-session-write", perform) : perform();
  };
}
