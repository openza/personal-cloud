// Derived workload arithmetic from measured local metadata; no account access.
import fs from 'node:fs/promises';
import {dispatchLimits,mutationCredits} from '../public/dispatch-cost.js';
const [input,output,idleInput,pendingCountsInput,fanoutInput,ownerFanoutInput,confirmationInput]=process.argv.slice(2);
if(!input||!idleInput||!output?.startsWith('artifacts/'))throw Error('Use measured-report.json artifacts/<day-report.json> measured-idle.json');
const report=JSON.parse(await fs.readFile(input,'utf8'));
const idle=JSON.parse(await fs.readFile(idleInput,'utf8'));
if(report.syntheticOnly!==true||idle.syntheticOnly!==true||report.sourceCase!==idle.sourceCase||['tasks','spaces','projects','labels','providerSourceItems'].some(k=>report.population?.[k]!==idle.population?.[k]))throw Error('Combine only synthetic measurements of the same population and source case.');
const pendingCounts=pendingCountsInput?JSON.parse(await fs.readFile(pendingCountsInput,'utf8')):null;
if(pendingCounts&&(pendingCounts.total!==report.pendingCase||Object.keys(pendingCounts.operations).sort().join(',')!=='externalCommand.confirm,source.refreshSnapshot'||Object.values(pendingCounts.operations).some(n=>!Number.isSafeInteger(n)||n<0)||Object.values(pendingCounts.operations).reduce((a,b)=>a+b,0)!==report.pendingCase))throw Error('Pending operation counts must reconcile exactly without narrowing the queue.');
const keys=['requests','rowsRead','rowsWritten'];
const zero=()=>Object.fromEntries(keys.map(k=>[k,0]));
const resourceCost=value=>Object.fromEntries(keys.map(k=>[k,value[k]]));
const add=(a,b,n=1)=>{for(const k of keys)a[k]+=b[k]*n;return a;};
const ownerFanoutEvidence=ownerFanoutInput?JSON.parse(await fs.readFile(ownerFanoutInput,'utf8')):null;
const desktopFanoutEvidence=fanoutInput?JSON.parse(await fs.readFile(fanoutInput,'utf8')):null;
if(ownerFanoutEvidence&&!ownerFanoutEvidence.results.some(r=>r.ownerSession&&r.size===900&&r.status===201&&r.totals.catchup_idle_heartbeat&&r.totals.catchup_read))throw Error('Fresh schema26 catchup telemetry measurements are required.');
const telemetry=ownerFanoutEvidence?.results.find(r=>r.ownerSession&&r.size===900&&r.status===201)?.totals.catchup_idle_heartbeat??zero();
const desktopIdle=add(resourceCost(idle.dailyIdle),telemetry,576);
const priorHealth=Object.values(report.queries??{}).find(q=>q.sql.includes('FROM sqlite_master')&&q.sql.includes('WHERE name IN'));
const healthReadDelta=priorHealth&&desktopFanoutEvidence?Math.max(0,desktopFanoutEvidence.results[0].totals.health.rowsRead-priorHealth.rowsRead/priorHealth.calls):0;
desktopIdle.rowsRead+=healthReadDelta*288;
const confirmationEvidence=confirmationInput?JSON.parse(await fs.readFile(confirmationInput,'utf8')):null;
if(confirmationEvidence&&(confirmationEvidence.syntheticOnly!==true||confirmationEvidence.credits!==50||!keys.every(k=>Number.isFinite(confirmationEvidence.conservativeSingleConfirmation?.[k])&&confirmationEvidence.conservativeSingleConfirmation[k]>=0)))throw Error('Valid isolated pending-confirmation metadata required.');
const deliveryBound=confirmationEvidence?.conservativeSingleConfirmation??(report.totals.provider_delivery_one?add({...report.totals.provider_delivery_one},telemetry,2):null);
const coldCatchup=confirmationEvidence?.totals.catchup_initial_report;
if(coldCatchup)for(const k of keys)desktopIdle[k]+=Math.max(0,coldCatchup[k]-telemetry[k]);
const recoveryEvidence=ownerFanoutEvidence?.results.find(r=>r.ownerSession&&r.size===900&&r.totals.recovery_cancel);
const recoveryCost=zero();
if(recoveryEvidence)for(const name of ['recovery_check','recovery_cancel','recovery_duplicate_check','recovery_duplicate_cancel'])add(recoveryCost,recoveryEvidence.totals[name]);
// The new global cancellation/receipt exclusion trigger adds one bounded PK
// probe to each original measured mutation. Fresh schema26 sidecars include it.
const withPassTelemetry=value=>{add(value,telemetry,2/100);value.rowsRead+=healthReadDelta/100+(fanoutInput?1:0);return value;};
const average=s=>withPassTelemetry(Object.fromEntries(keys.map(k=>[k,report.totals[s][k]/report.totals[s].envelopes])));
// Uniformly attribute measured pass/auth/checkpoint overhead to its measured
// scenario's envelopes. This is an explicit derivation, not per-query billing.
function entries(s){
 const items=report.dispatches.filter(d=>d.scenario===s),sum=items.reduce((a,d)=>add(a,d),zero());
 return items.map(d=>withPassTelemetry({...d,...Object.fromEntries(keys.map(k=>[k,d[k]+(report.totals[s][k]-sum[k])/items.length]))}));
}
function browserReads(hours,editHours){
 const end=hours*3600,edits=Array.from({length:100},(_,i)=>(i+.5)*editHours*3600/100);
 let next=300,count=1;
 for(const edit of edits){while(next<=edit&&next<end){count++;next+=300;}count++;next=edit+300;}
 while(next<end){count++;next+=300;}return count;
}
function browserDay(hours,editHours,statusSeconds=300,editOrigin='desktop'){
 const reads=browserReads(hours,editHours),value=zero();
 add(value,report.totals.browser_refresh,reads);
 value.rowsRead+=healthReadDelta*reads;
 add(value,report.totals.initial_status_poll,Math.ceil(hours*3600/statusSeconds));
 add(value,report.totals.session_rotation,Math.ceil(hours*6)+(editOrigin==='web'?100:0));
 return{hours,editHours,statusSeconds,editOrigin,immediateRefreshes:100,snapshotReads:reads,...value};
}
const browserCases=['desktop','web'].flatMap(origin=>[browserDay(6,6,300,origin),browserDay(24,6,300,origin),browserDay(24,24,300,origin)]);
const worstBrowser=origin=>browserCases.filter(b=>b.editOrigin===origin).reduce((a,b)=>a.rowsRead>b.rowsRead?a:b);
const uploadBrowser=['desktop','web'].map(origin=>browserDay(24,6,30,origin));
const heartbeat=average('source_heartbeat_cycle'),note=average('existing_backlog');
const ownerNote=Object.fromEntries(keys.map(k=>[k,Math.max(idle.totals.owner_note_adopted[k],idle.totals.owner_note_native[k])]));
if(fanoutInput)ownerNote.rowsRead++;
const catalog={credits:50,...Object.fromEntries(keys.map(k=>[k,Math.max(idle.totals.catalog_content_change_adopted[k],idle.totals.catalog_content_change_unadopted[k])+idle.totals.catalog_full_cycle_pull_ack[k]/report.population.providerSourceItems]))};
if(fanoutInput)catalog.rowsRead++;
const arrival=(catalogChanges,editOrigin)=>{
 const items=[];
 for(let cycle=0;cycle<4;cycle++)for(let n=0;n<report.sourceCase;n++)items.push({at:cycle*6*3600,operation:'source.refreshSnapshot',credits:16,...heartbeat});
 if(editOrigin==='desktop')for(let n=0;n<100;n++)items.push({at:(n+.5)*6*3600/100,operation:'task.patch',credits:25,...average('normal_edits_100')});
 for(let n=0;n<catalogChanges;n++)items.push({at:(n+.5)*6*3600/catalogChanges,operation:'provider.catalog.put',...catalog});
 return items.sort((a,b)=>a.at-b.at);
};
function simulate(name,seed,catalogChangesPerDay=0,editOrigin='desktop',webFanout=[]){
 const queue=seed.map(d=>({...d,arrived:0,original:true})),days=[];let head=0,originalLeft=seed.length,originalDrainedDay=null,maxWaitDays=0;
 const webPending=webFanout.map(d=>({...d}));let fanoutReleaseDay=seed.length?null:0;
 for(let day=0;day<200;day++){
  queue.push(...arrival(catalogChangesPerDay,editOrigin).map(d=>({...d,arrived:day,original:false})));
  const browser=originalLeft>0?uploadBrowser.find(b=>b.editOrigin===editOrigin):worstBrowser(editOrigin);
  const value={day:day+1,envelopes:0,writeCredits:0,desktopRequests:desktopIdle.requests,webEnvelopes:editOrigin==='web'?100:0,webWriteCredits:editOrigin==='web'?2500:0,webFanoutCredits:0,...zero()};
  add(value,browser);if(editOrigin==='web')add(value,ownerNote,100);add(value,recoveryCost);value.webRequests=value.requests;add(value,desktopIdle);
  while(head<queue.length){const item=queue[head];
   if(item.credits>dispatchLimits.writeCredits)throw Error('Whole-day overflow must be visibly blocked, not retried.');
   if(value.writeCredits+item.credits>dispatchLimits.writeCredits||value.envelopes+1>dispatchLimits.envelopes||value.desktopRequests+item.requests>dispatchLimits.requests)break;
   head++;value.envelopes++;value.writeCredits+=item.credits;value.desktopRequests+=item.requests;add(value,item);maxWaitDays=Math.max(maxWaitDays,day-item.arrived);
   if(item.original&&--originalLeft===0)originalDrainedDay=day+1;
  }
  // Bulk Web changes are deferred through the catch-up completion UTC day.
  // This models a verified current-catchup signal, not initial-only telemetry.
  if(fanoutReleaseDay===null&&head===queue.length)fanoutReleaseDay=day+1;
  const webFanoutLimit=fanoutReleaseDay!==null&&day>=fanoutReleaseDay?12000:1000;
  while(webPending.length){
   const item=webPending[0];
   if(item.credits>12000)throw Error('Use Desktop or an explicit manual path above the Web fanout subbudget.');
   if(value.webFanoutCredits+item.credits>webFanoutLimit||value.webWriteCredits+item.credits>dispatchLimits.writeCredits||value.webRequests+item.requests>dispatchLimits.requests||value.webEnvelopes+1>dispatchLimits.envelopes)break;
   webPending.shift();value.webFanoutCredits+=item.credits;value.webWriteCredits+=item.credits;value.webRequests+=item.requests;value.webEnvelopes++;add(value,item);
  }
  for(const k of [...keys,'desktopRequests','webRequests'])value[k]=Math.ceil(value[k]);
  value.pending=queue.length-head;value.originalPending=originalLeft;
  value.belowHalfFreeDaily=value.requests<50000&&value.rowsRead<2500000&&value.rowsWritten<50000;
  value.independentLedgersWithinCaps=value.desktopRequests<=dispatchLimits.requests&&value.webRequests<=dispatchLimits.requests&&value.webWriteCredits<=dispatchLimits.writeCredits;
  value.webFanoutPending=webPending.length;
  days.push(value);if(value.pending===0&&!webPending.length)return{name,editOrigin,catalogChangesPerDay,daysToNoBacklog:day+1,originalDrainedDay,maxWaitDays,maxElapsedDaysUpperBound:maxWaitDays+1,webFanoutReleaseModelDay:fanoutReleaseDay===null?null:fanoutReleaseDay+1,days};
 }
 throw Error('Representative arrivals do not converge within 200 days.');
}
const backlog=Array.from({length:report.pendingCase},()=>({operation:'task.patch',credits:25,...note}));
const seedConfirmationCount=Number.isSafeInteger(report.population?.completedTasks)?Math.min(report.population.completedTasks,report.sourceCase):0;
const seedConfirmations=Array.from({length:seedConfirmationCount},()=>({operation:'externalCommand.confirm',credits:50,...deliveryBound}));
const firstSeed=[...entries('first_upload'),...seedConfirmations];
const seeds=[['existing_note_patch_stress',backlog],['fresh_seed',firstSeed],['mixed_seed_then_note_patch_stress',[...firstSeed,...backlog]],['normal_day',[]]];
if(pendingCounts){
 const sources=Array.from({length:pendingCounts.operations['source.refreshSnapshot']},()=>({operation:'source.refreshSnapshot',credits:16,...heartbeat}));
 // Entire measured reopen/claim/start/confirm workflow is an upper bound for an
 // isolated pending confirmation. No need to inspect old payloads or claim IDs.
 const confirms=Array.from({length:pendingCounts.operations['externalCommand.confirm']},()=>({operation:'externalCommand.confirm',credits:50,...deliveryBound}));
 seeds.unshift(['count_mix_sources_then_confirms',[...sources,...confirms]],['count_mix_confirms_then_sources',[...confirms,...sources]],['mixed_seed_then_count_mix',[...firstSeed,...sources,...confirms]]);
}
const scenarios=['desktop','web'].flatMap(origin=>[0,100].flatMap(changed=>seeds.map(([name,seed])=>simulate(name,seed,changed,origin))));
const fanoutRatios=[];
if(confirmationEvidence){
 if(confirmationEvidence.fullDeliveryCredits!==100||!confirmationEvidence.totals.fresh_delivery_command||!confirmationEvidence.totals.fresh_delivery_claim_start)throw Error('Full delivery measurements must keep both command envelopes.');
 const command=add({operation:'task.complete',credits:50,...resourceCost(confirmationEvidence.totals.fresh_delivery_command)},confirmationEvidence.totals.fresh_delivery_claim_start);
 const confirmation={operation:'externalCommand.confirm',credits:50,...deliveryBound};
 fanoutRatios.push(command,confirmation);
 for(const changed of [0,100])for(const [name,seed]of seeds)scenarios.push(simulate(name+'_full_delivery_workflow',[...seed,command,confirmation],changed,'web'));
}
if(fanoutInput||ownerFanoutInput){
 if(!fanoutInput||!ownerFanoutInput)throw Error('Supply both authenticated Desktop and owner-session fanout measurements.');
 const desktopFanout=desktopFanoutEvidence,ownerFanout=ownerFanoutEvidence;
 if(!desktopFanout.syntheticOnly||!ownerFanout.syntheticOnly)throw Error('Synthetic fanout evidence required.');
 for(const row of ownerFanout.results.filter(r=>r.status===201)){
  const bound=row.taskCount+row.childProjects,credits=mutationCredits({operation:row.operation},bound);
  if((row.totals.operation.rowsWritten+report.totals.session_rotation.rowsWritten)/credits>2/3)throw Error('Measured Web fanout exceeds its conservative 2/3 write ratio.');
 }
 function item(measurement,operation,owner,retry=false,size=900){
  const row=measurement.results.find(r=>r.guarded===true&&r.ownerSession===owner&&r.operation===operation&&r.size===size&&r.status===201);
  if(!row)throw Error('Missing guarded representative fanout measurement.');
  const cost={operation,credits:mutationCredits({operation},size),...resourceCost(row.totals[retry?'duplicateRetry':'operation'])};
  if(owner){add(cost,report.totals.browser_refresh);cost.rowsRead+=healthReadDelta;add(cost,report.totals.session_rotation);add(cost,ownerFanoutEvidence.results.find(r=>r.size===900&&r.totals.catchup_read)?.totals.catchup_read??zero(),2);}
  else{add(cost,row.totals.health);add(cost,row.totals.pullAck);add(cost,idle.totals.warm_idle_cycle);add(cost,telemetry,2);}
  fanoutRatios.push(cost);return cost;
 }
 for(const operation of ['project.delete','task.moveTree']){
  const desktop=item(desktopFanout,operation,false),retry=item(desktopFanout,operation,false,true),web=item(ownerFanout,operation,true),webRetry=item(ownerFanout,operation,true,true),smallWeb=item(ownerFanout,operation,true,false,10);
  for(const changed of [0,100]){
   for(const [name,seed]of seeds){
    // Append behind every original envelope. Never prioritize or compact it.
    scenarios.push(simulate(name+'_desktop_'+operation,[...seed,desktop,retry],changed,'web'));
    scenarios.push(simulate(name+'_deferred_web_'+operation,seed,changed,'web',[web,webRetry]));
    scenarios.push(simulate(name+'_small_then_deferred_web_'+operation,seed,changed,'web',[...Array.from({length:5},()=>smallWeb),web]));
   }
   scenarios.push(simulate('normal_day_multiple_web_'+operation,[],changed,'web',Array.from({length:4},()=>web)));
  }
 }
}
const ratios=[...entries('first_upload'),{credits:25,...note},{credits:16,...heartbeat},catalog,...(pendingCounts||seedConfirmationCount>0?[{credits:50,...deliveryBound}]:[])];
const maximumMeasuredWriteRatio=Math.max(...[...ratios,...fanoutRatios].map(d=>d.rowsWritten/d.credits));
const measuredFamilyWriteCeiling=['desktop','web'].map(origin=>({editOrigin:origin,maximumMeasuredWriteRatio,
 rowsWritten:Math.ceil(dispatchLimits.writeCredits*maximumMeasuredWriteRatio+desktopIdle.rowsWritten+worstBrowser(origin).rowsWritten+(origin==='web'?ownerNote.rowsWritten*100:0)+(fanoutInput?1000*2/3:0)+recoveryCost.rowsWritten),
 scope:'Full Desktop measured-family credit ceiling, browser/notes, catchup telemetry, 1000-credit small Web fanout allowance and one measured check/cancel/retry sequence. Large Web fanout waits through catchup completion day. Not an account-global or arbitrary-workspace guarantee.'}));
const readyWebFanoutCeiling=fanoutInput?{
 rowsWritten:Math.ceil(Math.max(...scenarios.filter(s=>s.name==='normal_day').flatMap(s=>s.days.map(d=>d.rowsWritten)))+12000*2/3),
 scope:'Measured normal Desktop/provider/catalog/100-note mix after catchup, plus the 12000-credit Web fanout lane at conservative 2/3 writes/credit, telemetry and recovery already in normal-day totals.'}:null;
const result={formatVersion:1,syntheticOnly:true,derivedNotLiveBilling:true,requestScope:'Worker-origin API dispatches only; static HTML/JS/CSS/asset loads and other traffic excluded. Not exact live billed Worker invocations.',input,idleInput,pendingCountsInput,fanoutInput,ownerFanoutInput,confirmationInput,fanoutRatios,confirmationBound:deliveryBound,recoveryCostPerModelDay:recoveryCost,catchupTelemetry:{measuredIdleReport:telemetry,coldFirstReport:coldCatchup,emptyPassReportsPerDay:576,nonemptyPassReportsPer100Envelopes:2},pendingCounts,seedConfirmationCount,dailyLimits:dispatchLimits,browserCases,uploadBrowser,desktopIdle,measuredFamilyWriteCeiling,readyWebFanoutCeiling,
 assumptions:['Separate origin cases: (1) 100 Desktop note edits plus 100 manual Web refreshes, (2) 100 measured owner-session Web note edits plus immediate refresh/rotation, with no duplicate Desktop note arrival. Four complete source refresh cycles/day. Separate 0 and 100 changed-catalog-item/day variants. These are explicit assumptions, not observed behavior.',
 'Count-only pending operation mix, when supplied, uses two illustrative synthetic orders; real FIFO order/payloads were not inspected. Source refresh uses measured heartbeat averages; confirmation uses the entire measured delivery workflow as a conservative bound. Original runtime envelopes and order must remain untouched.',
 'The all-note backlog remains a separate stress case. Fresh seed and mixed seed-then-backlog are illustrative sequences, never a proposal to regenerate existing pending work. Acceptance assumes one successful attempt per original envelope; retries, old payload versions, conflicts or rejected/replayed items can lengthen or block real drain.',
 'The measured synthetic seed completes source-linked tasks. Its derived queue also appends one conservative whole-workflow confirmation per source-linked seed completion; these extra confirmations are projected, not an observed provider run. No provider account was contacted.',
 'Daily arrivals append behind all older work, in time order. Original IDs/order preserved; no priority reservation, drop or compaction.',
 'The day-bucket model does not resolve within-day dispatch timing. maxWaitDays is a day-index lag; maxElapsedDaysUpperBound adds one calendar day conservatively, not a promised elapsed completion time.',
 'Desktop pass/auth/checkpoint overhead allocated uniformly from measured totals; day values rounded up. Web writes use the larger actual owner-session adopted/native note cost. Their 2500 credits/day and HTTP attempts are OUTSIDE the independent Desktop 45000-credit ledger; neither is an account-global cap.',
 'Five-minute visible snapshots; hidden full snapshots suppressed. Both 6h working edits plus18h visible idle and evenly spaced24h edits simulated. Status30s until original backlog/seed drains,300s afterward. Additional deliberate focus/manual reloads are outside the representative100-edit model.',
 'Desktop actual measured empty13-request cycle projected288/day plus144 token renewals; this conservatively adds complete empty-pass overhead even on nonempty mutation days. Changed catalog uses the larger measured adopted/unadopted item cost plus uniform measured full-cycle pull/ACK overhead.',
 'These per-origin credits are not Cloudflare billing or shared account enforcement. Other devices/apps and a different real pending operation mix require reassessment.'],
 scenarios,allModelledDaysBelowHalf:scenarios.every(s=>s.days.every(d=>d.belowHalfFreeDaily&&d.independentLedgersWithinCaps))&&(!fanoutInput||measuredFamilyWriteCeiling.every(c=>c.rowsWritten<50000)&&readyWebFanoutCeiling.rowsWritten<50000)};
await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({browserCases,measuredFamilyWriteCeiling,scenarios:scenarios.map(({days,...s})=>({...s,maxRowsRead:Math.max(...days.map(d=>d.rowsRead)),maxRowsWritten:Math.max(...days.map(d=>d.rowsWritten)),maxRequests:Math.max(...days.map(d=>d.requests))})),allModelledDaysBelowHalf:result.allModelledDaysBelowHalf}));
if(!result.allModelledDaysBelowHalf)process.exitCode=1;
