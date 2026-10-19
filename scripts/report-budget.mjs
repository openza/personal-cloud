// Derived workload arithmetic from measured local metadata; no account access.
import fs from 'node:fs/promises';
import {dispatchLimits} from '../public/dispatch-cost.js';
const [input,output,idleInput,pendingCountsInput]=process.argv.slice(2);
if(!input||!idleInput||!output?.startsWith('artifacts/'))throw Error('Use measured-report.json artifacts/<day-report.json> measured-idle.json');
const report=JSON.parse(await fs.readFile(input,'utf8'));
const idle=JSON.parse(await fs.readFile(idleInput,'utf8'));
if(report.syntheticOnly!==true||idle.syntheticOnly!==true||report.sourceCase!==idle.sourceCase||['tasks','spaces','projects','labels','providerSourceItems'].some(k=>report.population?.[k]!==idle.population?.[k]))throw Error('Combine only synthetic measurements of the same population and source case.');
const pendingCounts=pendingCountsInput?JSON.parse(await fs.readFile(pendingCountsInput,'utf8')):null;
if(pendingCounts&&(pendingCounts.total!==report.pendingCase||Object.keys(pendingCounts.operations).sort().join(',')!=='externalCommand.confirm,source.refreshSnapshot'||Object.values(pendingCounts.operations).some(n=>!Number.isSafeInteger(n)||n<0)||Object.values(pendingCounts.operations).reduce((a,b)=>a+b,0)!==report.pendingCase))throw Error('Pending operation counts must reconcile exactly without narrowing the queue.');
const keys=['requests','rowsRead','rowsWritten'];
const zero=()=>Object.fromEntries(keys.map(k=>[k,0]));
const add=(a,b,n=1)=>{for(const k of keys)a[k]+=b[k]*n;return a;};
const average=s=>Object.fromEntries(keys.map(k=>[k,report.totals[s][k]/report.totals[s].envelopes]));
// Uniformly attribute measured pass/auth/checkpoint overhead to its measured
// scenario's envelopes. This is an explicit derivation, not per-query billing.
function entries(s){
 const items=report.dispatches.filter(d=>d.scenario===s),sum=items.reduce((a,d)=>add(a,d),zero());
 return items.map(d=>({...d,...Object.fromEntries(keys.map(k=>[k,d[k]+(report.totals[s][k]-sum[k])/items.length]))}));
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
 add(value,report.totals.initial_status_poll,Math.ceil(hours*3600/statusSeconds));
 add(value,report.totals.session_rotation,Math.ceil(hours*6)+(editOrigin==='web'?100:0));
 return{hours,editHours,statusSeconds,editOrigin,immediateRefreshes:100,snapshotReads:reads,...value};
}
const browserCases=['desktop','web'].flatMap(origin=>[browserDay(6,6,300,origin),browserDay(24,6,300,origin),browserDay(24,24,300,origin)]);
const worstBrowser=origin=>browserCases.filter(b=>b.editOrigin===origin).reduce((a,b)=>a.rowsRead>b.rowsRead?a:b);
const uploadBrowser=['desktop','web'].map(origin=>browserDay(24,6,30,origin));
const heartbeat=average('source_heartbeat_cycle'),note=average('existing_backlog');
const ownerNote=Object.fromEntries(keys.map(k=>[k,Math.max(idle.totals.owner_note_adopted[k],idle.totals.owner_note_native[k])]));
const catalog={credits:50,...Object.fromEntries(keys.map(k=>[k,Math.max(idle.totals.catalog_content_change_adopted[k],idle.totals.catalog_content_change_unadopted[k])+idle.totals.catalog_full_cycle_pull_ack[k]/report.population.providerSourceItems]))};
const arrival=(catalogChanges,editOrigin)=>{
 const items=[];
 for(let cycle=0;cycle<4;cycle++)for(let n=0;n<report.sourceCase;n++)items.push({at:cycle*6*3600,operation:'source.refreshSnapshot',credits:16,...heartbeat});
 if(editOrigin==='desktop')for(let n=0;n<100;n++)items.push({at:(n+.5)*6*3600/100,operation:'task.patch',credits:25,...average('normal_edits_100')});
 for(let n=0;n<catalogChanges;n++)items.push({at:(n+.5)*6*3600/catalogChanges,operation:'provider.catalog.put',...catalog});
 return items.sort((a,b)=>a.at-b.at);
};
function simulate(name,seed,catalogChangesPerDay=0,editOrigin='desktop'){
 const queue=seed.map(d=>({...d,arrived:0,original:true})),days=[];let head=0,originalLeft=seed.length,originalDrainedDay=null,maxWaitDays=0;
 for(let day=0;day<200;day++){
  queue.push(...arrival(catalogChangesPerDay,editOrigin).map(d=>({...d,arrived:day,original:false})));
  const browser=originalLeft>0?uploadBrowser.find(b=>b.editOrigin===editOrigin):worstBrowser(editOrigin);
  const value={day:day+1,envelopes:0,writeCredits:0,desktopRequests:idle.dailyIdle.requests,webEnvelopes:editOrigin==='web'?100:0,webWriteCredits:editOrigin==='web'?2500:0,...zero()};
  add(value,browser);if(editOrigin==='web')add(value,ownerNote,100);value.webRequests=value.requests;add(value,idle.dailyIdle);
  while(head<queue.length){const item=queue[head];
   if(item.credits>dispatchLimits.writeCredits)throw Error('Whole-day overflow must be visibly blocked, not retried.');
   if(value.writeCredits+item.credits>dispatchLimits.writeCredits||value.envelopes+1>dispatchLimits.envelopes||value.desktopRequests+item.requests>dispatchLimits.requests)break;
   head++;value.envelopes++;value.writeCredits+=item.credits;value.desktopRequests+=item.requests;add(value,item);maxWaitDays=Math.max(maxWaitDays,day-item.arrived);
   if(item.original&&--originalLeft===0)originalDrainedDay=day+1;
  }
  for(const k of [...keys,'desktopRequests','webRequests'])value[k]=Math.ceil(value[k]);
  value.pending=queue.length-head;value.originalPending=originalLeft;
  value.belowHalfFreeDaily=value.requests<50000&&value.rowsRead<2500000&&value.rowsWritten<50000;
  value.independentLedgersWithinCaps=value.desktopRequests<=dispatchLimits.requests&&value.webRequests<=dispatchLimits.requests&&value.webWriteCredits<=dispatchLimits.writeCredits;
  days.push(value);if(value.pending===0)return{name,editOrigin,catalogChangesPerDay,daysToNoBacklog:day+1,originalDrainedDay,maxWaitDays,maxElapsedDaysUpperBound:maxWaitDays+1,days};
 }
 throw Error('Representative arrivals do not converge within 200 days.');
}
const backlog=Array.from({length:report.pendingCase},()=>({operation:'task.patch',credits:25,...note}));
const seedConfirmationCount=Number.isSafeInteger(report.population?.completedTasks)?Math.min(report.population.completedTasks,report.sourceCase):0;
const seedConfirmations=Array.from({length:seedConfirmationCount},()=>({operation:'externalCommand.confirm',credits:50,...report.totals.provider_delivery_one}));
const firstSeed=[...entries('first_upload'),...seedConfirmations];
const seeds=[['existing_note_patch_stress',backlog],['fresh_seed',firstSeed],['mixed_seed_then_note_patch_stress',[...firstSeed,...backlog]],['normal_day',[]]];
if(pendingCounts){
 const sources=Array.from({length:pendingCounts.operations['source.refreshSnapshot']},()=>({operation:'source.refreshSnapshot',credits:16,...heartbeat}));
 // Entire measured reopen/claim/start/confirm workflow is an upper bound for an
 // isolated pending confirmation. No need to inspect old payloads or claim IDs.
 const confirms=Array.from({length:pendingCounts.operations['externalCommand.confirm']},()=>({operation:'externalCommand.confirm',credits:50,...report.totals.provider_delivery_one}));
 seeds.unshift(['count_mix_sources_then_confirms',[...sources,...confirms]],['count_mix_confirms_then_sources',[...confirms,...sources]],['mixed_seed_then_count_mix',[...firstSeed,...sources,...confirms]]);
}
const scenarios=['desktop','web'].flatMap(origin=>[0,100].flatMap(changed=>seeds.map(([name,seed])=>simulate(name,seed,changed,origin))));
const ratios=[...entries('first_upload'),{credits:25,...note},{credits:16,...heartbeat},catalog,...(pendingCounts||seedConfirmationCount>0?[{credits:50,...report.totals.provider_delivery_one}]:[])];
const maximumMeasuredWriteRatio=Math.max(...ratios.map(d=>d.rowsWritten/d.credits));
const measuredFamilyWriteCeiling=['desktop','web'].map(origin=>({editOrigin:origin,maximumMeasuredWriteRatio,
 rowsWritten:Math.ceil(dispatchLimits.writeCredits*maximumMeasuredWriteRatio+idle.dailyIdle.rowsWritten+worstBrowser(origin).rowsWritten+(origin==='web'?ownerNote.rowsWritten*100:0)),
 scope:'Conservative ceiling for measured operation families/allocated pass overhead only; not a billing or arbitrary-operation guarantee.'}));
const result={formatVersion:1,syntheticOnly:true,derivedNotLiveBilling:true,requestScope:'Worker-origin API dispatches only; static HTML/JS/CSS/asset loads and other traffic excluded. Not exact live billed Worker invocations.',input,idleInput,pendingCountsInput,pendingCounts,seedConfirmationCount,dailyLimits:dispatchLimits,browserCases,uploadBrowser,desktopIdle:idle.dailyIdle,measuredFamilyWriteCeiling,
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
 scenarios,allModelledDaysBelowHalf:scenarios.every(s=>s.days.every(d=>d.belowHalfFreeDaily&&d.independentLedgersWithinCaps))};
await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({browserCases,measuredFamilyWriteCeiling,scenarios:scenarios.map(({days,...s})=>({...s,maxRowsRead:Math.max(...days.map(d=>d.rowsRead)),maxRowsWritten:Math.max(...days.map(d=>d.rowsWritten)),maxRequests:Math.max(...days.map(d=>d.requests))})),allModelledDaysBelowHalf:result.allModelledDaysBelowHalf}));
if(!result.allModelledDaysBelowHalf)process.exitCode=1;
