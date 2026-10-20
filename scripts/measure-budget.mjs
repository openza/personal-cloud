// Local, synthetic-only benchmark through real Worker authorization/domain paths.
// No Cloudflare credentials, TEST_MODE or browser auth shortcut is accepted.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readD1Migrations} from '@cloudflare/vitest-plugin';
import worker from '../src/index.ts';
import {instrumentD1} from './d1-metrics.mjs';
import {mutationCredits} from '../public/dispatch-cost.js';

const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
if(!args.counts||!args.output)throw Error('Use --counts=<ignored-counts.json> --output=<ignored-report.json> [--sources=N] [--pending=N]');
const root=process.cwd(),output=path.resolve(args.output);
if(!output.startsWith(path.join(root,'artifacts')+path.sep))throw Error('Keep local evidence under ignored artifacts/.');
const {counts}=JSON.parse(await fs.readFile(args.counts,'utf8'));
const sources=Number(args.sources??counts.cloudProviderSources),pending=Number(args.pending??counts.pendingEnvelopes);
for(const number of [sources,pending,counts.tasks,counts.projects,counts.providerSourceItems])if(!Number.isSafeInteger(number)||number<0||number>20000)throw Error('Invalid bounded count input.');
if(sources>counts.tasks)throw Error('Source case exceeds task population.');
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("local budget fixture");}}',compatibilityDate:'2026-09-13',d1Databases:{DB:'quota-budget-synthetic'},host:'127.0.0.1',port:0}));
const sha=value=>createHash('sha256').update(value).digest('hex'),instance='instance_budget_synthetic',device='device_budget_synthetic';
let session='synthetic-budget-session',csrf='synthetic-budget-csrf';const refresh='synthetic-budget-refresh-credential';
const RealDate=Date;let virtualNow=Date.now();globalThis.Date=class extends RealDate{constructor(...values){super(...(values.length?values:[virtualNow]));}static now(){return virtualNow;}};
let scenario='preparation',sequence=0,token,tokenExpires=0,lastBody,lastD1Error,checkpoint=0,reportSequence=0,initialTotal=null,passOpen=false,passItems=0;
const passSize=Number(args['pass-envelopes']??100);
const totals={},routes={},queries={},versions=new Map(),acceptedChanges=new Map(),dispatches=[];
const stat=()=>totals[scenario]??=( {requests:0,envelopes:0,statements:0,rowsRead:0,rowsWritten:0} );
try{
 const {DB:raw}=await mf.getBindings();
 for(const migration of await readD1Migrations('migrations'))await raw.batch(migration.queries.map(sql=>raw.prepare(sql)));
 const start=new Date(),at=start.toISOString(),expires=new Date(start.valueOf()+12*3600_000).toISOString();
 await raw.batch([
  raw.prepare("INSERT INTO owner_credentials(credential_id,display_name,public_key_jwk,created_at) VALUES('synthetic-owner','Synthetic owner','{}',?1)").bind(at),
  raw.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic bridge','desktop',1,1,?2)").bind(device,at),
  raw.prepare("INSERT INTO device_refresh_credentials(credential_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)").bind(sha(refresh),device,at,expires),
  raw.prepare("INSERT INTO web_sessions(session_hash,credential_id,csrf_hash,created_at,rotated_at,expires_at,absolute_expires_at) VALUES(?1,'synthetic-owner',?2,?3,?3,?4,?4)").bind(sha(session),sha(csrf),at,expires),
 ]);
 const db=instrumentD1(raw,entry=>{
  const s=stat();s.statements++;s.rowsRead+=entry.rowsRead;s.rowsWritten+=entry.rowsWritten;
  const key=sha(entry.sql).slice(0,16),q=queries[key]??={calls:0,rowsRead:0,rowsWritten:0,sql:entry.sql};
  q.calls++;q.rowsRead+=entry.rowsRead;q.rowsWritten+=entry.rowsWritten;
 },error=>lastD1Error=String(error));
 const env={DB:db,INSTANCE_ID:instance,ARTIFACT_VERSION:'0.0.0-budget-measurement'};
 async function request(url,{body,owner=false,...options}={}){
  const key=new URL(url,'https://synthetic.example').pathname;if(!owner&&key!=='/auth/device/token'&&key!=='/health'&&token&&virtualNow>=tokenExpires)await authorize();stat().requests++;routes[scenario+':'+key]=(routes[scenario+':'+key]??0)+1;
  const response=await worker.fetch(new Request('https://synthetic.example'+url,{...options,headers:{'content-type':'application/json','origin':'https://synthetic.example',...(owner?{cookie:`__Host-openza_session=${session}`,'x-openza-csrf':csrf}:{authorization:`Bearer ${token}`})},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})}),env);
  const result=await response.json();if(!response.ok||result.error)throw Error(`Synthetic ${scenario} ${key}: ${JSON.stringify(result.error)} ${lastD1Error??''}`);if(owner&&response.headers.get('set-cookie')){session=response.headers.get('set-cookie').split(';')[0].split('=')[1];csrf=result.csrfToken??csrf;}return result;
 }
 async function authorize(){const issued=await request('/auth/device/token',{body:{deviceId:device,refreshCredential:refresh}});token=issued.accessToken;tokenExpires=Date.parse(issued.expiresAt);if(!token)throw Error('Synthetic auth did not issue token.');}
 function envelope(operation,id,payload,base){sequence++;return{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,mutationId:'mutation_synthetic_'+sequence,deviceSequence:sequence,operation,entityId:id,baseEntityVersion:base??null,payload,clientCreatedAt:at};}
 async function send(operation,id,payload,base=versions.get(id)){
  if(!passOpen)await beginPass();
  lastBody=envelope(operation,id,payload,base);stat().envelopes++;const before={...stat()};
  const receipt=await request('/v1/tasks/mutations',{body:lastBody});dispatches.push({scenario,operation,credits:mutationCredits(lastBody),requests:stat().requests-before.requests,rowsRead:stat().rowsRead-before.rowsRead,rowsWritten:stat().rowsWritten-before.rowsWritten});versions.set(id,receipt.entityVersion);acceptedChanges.set(id,receipt.changeSeq);passItems++;if(passItems>=passSize)await endPass();return receipt;
 }
 async function progressReport(){await request('/sync/initial-status',{body:{protocolVersion:1,reportSequence:++reportSequence,state:initialTotal===null?'uploading':'complete',acknowledged:initialTotal,total:initialTotal}});}
 async function pullAck(){let page=await request('/sync/changes?after='+checkpoint+'&limit=50&workspace=1&paged=1');checkpoint=page.nextCheckpoint;while(page.hasMore){page=await request('/sync/changes?after='+checkpoint+'&limit=50&workspace=1&paged=1');checkpoint=page.nextCheckpoint;}await request('/sync/checkpoints',{body:{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,checkpoint}});}
 async function beginPass(){virtualNow+=60000;await request('/health');await progressReport();passOpen=true;passItems=0;}
 async function endPass(){if(!passOpen)return;await pullAck();await progressReport();passOpen=false;passItems=0;}
 const descriptor=(i,time=at)=>({integrationKind:'todoist',externalIdHash:sha('synthetic_source_'+i),sourceUrl:null,title:'Synthetic source '+i,description:null,projectName:null,priority:null,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,recurrenceRule:null,refreshedAt:time});
 const space=i=>i===0?'space_default':'space_synthetic_'+i;
 scenario='first_upload';await authorize();await request('/health');
 for(let i=1;i<counts.spaces;i++)await send('space.put',space(i),{space:{name:'Synthetic Space '+i,color:null,icon:null,sortOrder:i,isArchived:i>=counts.activeSpaces,createdAt:at}},null);
 for(let i=0;i<counts.projects;i++)await send('project.put','project_synthetic_'+i,{project:{spaceId:space(i%counts.activeSpaces),name:'Synthetic project '+i,description:null,color:null,icon:null,parentId:null,sortOrder:i,status:i<counts.activeProjects?'active':'archived',isFavorite:false,createdAt:at}},null);
 for(let i=0;i<counts.providerConnections;i++)await send('provider.scope.put','scope_synthetic_'+i,{scope:{name:'Synthetic scope '+i,integrationKind:'todoist',available:true,labelNames:[],projectChoices:[]}},null);
 for(let i=0;i<counts.tasks;i++){
  const projectIndex=i%counts.activeProjects,projectId=i<counts.projectAssignedTasks?'project_synthetic_'+projectIndex:null;
  const primaryShared=counts.maxTasksPerSharedLabel,sharedAssignments=counts.tasksWithLabels-(counts.labels-counts.sharedLabels);
  const labelIndex=i<primaryShared?0:i<sharedAssignments?1+(i-primaryShared)%(counts.sharedLabels-1):counts.sharedLabels+(i-sharedAssignments);
  const labels=i<counts.tasksWithLabels?[{id:'label_synthetic_'+labelIndex,name:'Synthetic label '+labelIndex}]:[];
  if(i<counts.taskLabelLinks-counts.tasksWithLabels)labels.push({id:'label_synthetic_1',name:'Synthetic label 1'});
  const task={id:'task_synthetic_'+i,spaceId:space((projectId?projectIndex:i)%counts.activeSpaces),title:'Synthetic task '+i,workflowStatus:'inbox',priority:3,createdAt:at,notes:null,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,scheduledStart:null,scheduledEnd:null,durationMinutes:null,recurrenceRule:i<counts.recurringTasks?'FREQ=DAILY':null,projectId,labels};
  await send('task.createRich',task.id,{task,...(i<sources?{source:descriptor(i)}:{})},null);
  if(i%250===0)console.log(JSON.stringify({stage:scenario,acceptedTasks:i+1,metrics:stat()}));
 }
 // Eighteen child relationships are separate supported wire mutations; same-Space
 // parents already exist, without inventing unsupported createRich parent fields.
 for(let i=0;i<counts.childTasks;i++)await send('task.setParent','task_synthetic_'+i,{parentId:'task_synthetic_'+(i+30)});
 for(let i=0;i<counts.providerSourceItems;i++)await send('provider.catalog.put','catalog_synthetic_'+i,{item:{scopeId:'scope_synthetic_'+i%counts.providerConnections,source:descriptor(i),isSkipped:false,available:true,adoptedTaskId:i<sources?'task_synthetic_'+i:null,labelNames:[],projectChoices:[]}},null);
 for(let i=0;i<Math.min(counts.tasks,counts.completedTasks);i++)await send('task.complete','task_synthetic_'+i,{completedAt:at});
 // Current DTOs/receipts provide versions; no validation/count queries enter a measurement.
 async function readWeb(){await request('/health',{owner:true});let page=await request('/v1/tasks',{owner:true});while(page.hasMore)page=await request('/v1/tasks?cursor='+encodeURIComponent(page.nextCursor),{owner:true});}
 async function syncRead(){let page=await request('/sync/bootstrap?workspace=1&paged=1');while(page.hasMore)page=await request('/sync/bootstrap?workspace=1&paged=1&cursor='+encodeURIComponent(page.nextCursor));await request('/sync/changes?after='+page.checkpoint+'&limit=50&workspace=1&paged=1');await request('/sync/checkpoints',{body:{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,checkpoint:page.checkpoint}});}
 await endPass();initialTotal=sequence;virtualNow+=60000;await progressReport();await syncRead();console.log(JSON.stringify({stage:'first_upload_complete',metrics:totals.first_upload}));
 // Existing applied history is prepared separately, not charged as a new upload or inferred real payload mix.
 if(checkpoint<counts.cloudAppliedChanges){const additional=counts.cloudAppliedChanges-checkpoint;await raw.prepare(`WITH RECURSIVE n(v) AS(SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<?1) INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at) SELECT ?2+v,1,'tasks','synthetic_history_'||v,'task.updatedOpenzaFields','task','task_synthetic_0',1,'{}',?3 FROM n`).bind(additional,checkpoint,at).run();await raw.prepare('UPDATE cloud_state SET next_change_seq=?1').bind(counts.cloudAppliedChanges).run();checkpoint=counts.cloudAppliedChanges;}
 scenario='browser_refresh';await readWeb();
 scenario='initial_status_poll';await request('/sync/initial-status',{owner:true});
 scenario='session_rotation';await request('/auth/session/rotate',{owner:true,body:{}});
 // Continue with the real rotated cookie/CSRF returned by the handler.
 scenario='normal_edits_100';
 for(let i=0;i<100;i++)await send('task.patch','task_synthetic_'+i%counts.tasks,{fields:{notes:'Synthetic edit '+i}});await endPass();
 if(sources&&counts.completedTasks){
  scenario='provider_delivery_one';const claimId='claim_synthetic_budget',taskId='task_synthetic_0',requestedChangeSeq=acceptedChanges.get(taskId);
  // Read the source command through the normal pull, not a private validation query.
  // Completion's change number precedes the later note patch; retain it explicitly below.
  const complete=await send('task.reopen',taskId,{reopenedAt:new Date().toISOString()});
  await request('/v1/provider/commands/claim',{body:{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,claimId,taskId,requestedChangeSeq:complete.changeSeq,integrationKind:'todoist',externalIdHash:descriptor(0).externalIdHash}});
  await request('/v1/provider/commands/start',{body:{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,claimId}});
  await send('externalCommand.confirm',taskId,{claimId,requestedChangeSeq:complete.changeSeq,resolvedAt:new Date().toISOString(),errorCode:null},null);
  await endPass();
 }
 scenario='source_heartbeat_cycle';virtualNow+=6*3600_000;await authorize();
 const heartbeatAt=new Date().toISOString();
 for(let i=0;i<sources;i++)await send('source.refreshSnapshot','task_synthetic_'+i,{source:descriptor(i,heartbeatAt)},null);
 await endPass();
 scenario='source_duplicate_replay';stat().envelopes++;await request('/v1/tasks/mutations',{body:lastBody});
 scenario='existing_backlog';
 const slices=[];let previous={...stat()};
 for(let i=0;i<pending;i++){
  await send('task.patch','task_synthetic_'+i%counts.tasks,{fields:{notes:'Synthetic pending '+i}});
  if((i+1)%250===0||i===pending-1){const current={...stat()};slices.push({through:i+1,requests:current.requests-previous.requests,rowsRead:current.rowsRead-previous.rowsRead,rowsWritten:current.rowsWritten-previous.rowsWritten,envelopes:current.envelopes-previous.envelopes});previous=current;console.log(JSON.stringify({stage:scenario,accepted:i+1,metrics:current}));}
 }
 await endPass();
 // Projection is explicit workload arithmetic, separate from observed scenario totals.
 const scale=(value,n)=>Object.fromEntries(Object.entries(value).map(([key,v])=>[key,v*n]));
 const sum=(...values)=>values.reduce((a,v)=>{for(const[k,n]of Object.entries(v))a[k]=(a[k]??0)+n;return a;},{});
 const projection={browserOpenHours:6,editsPerDay:100,providerCyclesPerDay:4,
  scope:'Pure completed-profile idle arithmetic only. Use report-budget.mjs for edit refreshes, active upload status, independent ledgers, Desktop idle and changed catalog scenarios.',
  browserIdleSixHours:sum(scale(totals.browser_refresh,72),scale(totals.initial_status_poll,72),scale(totals.session_rotation,36)),
  providerDaily:scale(totals.source_heartbeat_cycle,4)};
 const report={formatVersion:1,syntheticOnly:true,localMeasurementNotLiveBilling:true,requestScope:'Worker-origin API dispatches only; static asset loads excluded, not exact live billed invocations.',population:counts,sourceCase:sources,pendingCase:pending,dispatches,
  assumptions:['Synthetic relationships/operation mix; counts are not actual pending payload semantics.','Measured real Worker auth/domain routes, manually prepared synthetic credentials only.','Metadata migrations/credential seed and explicit fixture restoration excluded.','Backlog case uses existing task note patches; duplicate replay is separately measured.','Synthetic completion state targets the first completed-count tasks, creating provider commands where source-linked; not a claim about real payloads.',`Modelled ${passSize}-envelope passes each include health, two authenticated status POSTs, complete changes pull and ACK; token renewals use virtual UTC expiry. Not an actual Desktop client trace.`,'No provider account calls or real passkey ceremony.'],totals,routes,queries,backlogSlices:slices,projection};
 await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({output,totals,projection}));
}finally{globalThis.Date=RealDate;await mf.dispose();}
