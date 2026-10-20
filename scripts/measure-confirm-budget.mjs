// Fresh local metadata for one already-prepared pending provider confirmation.
// Preparation uses real Worker routes but is excluded; no provider is contacted.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readD1Migrations} from '@cloudflare/vitest-plugin';
import worker from '../src/index.ts';
import {instrumentD1} from './d1-metrics.mjs';
const output=path.resolve(process.argv[2]??'artifacts/confirmation-budget.json');
if(!output.startsWith(path.join(process.cwd(),'artifacts')+path.sep))throw Error('Keep local measurements under ignored artifacts/.');
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("synthetic confirmation");}}',compatibilityDate:'2026-09-13',d1Databases:{DB:'pending_confirmation_synthetic'},host:'127.0.0.1',port:0}));
const hash=s=>createHash('sha256').update(s).digest('hex'),at=new Date().toISOString(),device='device_confirmation_synthetic',instance='instance_confirmation_synthetic',refresh='synthetic-confirm-refresh';
let stage='preparation',token,sequence=0,statusSequence=0,catchupSequence=0;const totals={};
const stat=()=>totals[stage]??={requests:0,statements:0,rowsRead:0,rowsWritten:0};
try{
 const {DB:raw}=await mf.getBindings();for(const migration of await readD1Migrations('migrations'))await raw.batch(migration.queries.map(sql=>raw.prepare(sql)));
 await raw.batch([
  raw.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic bridge','desktop',1,1,?2)").bind(device,at),
  raw.prepare('INSERT INTO device_refresh_credentials(credential_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)').bind(hash(refresh),device,at,new Date(Date.now()+86400000).toISOString()),
  raw.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v<898)
   INSERT INTO tasks(id,product,space_id,title,completion_state,workflow_status,created_at,entity_version,created_by_mutation_id)
   SELECT 'background_'||v,'tasks','space_default','Synthetic background','open','inbox',?1,1,'background_seed_'||v FROM n`).bind(at),
 ]);
 const db=instrumentD1(raw,entry=>{const s=stat();s.statements++;s.rowsRead+=entry.rowsRead;s.rowsWritten+=entry.rowsWritten;});
 const env={DB:db,INSTANCE_ID:instance,ARTIFACT_VERSION:'0.0.0-confirmation-budget'};
 async function request(url,body){stat().requests++;const response=await worker.fetch(new Request('https://synthetic.example'+url,{headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})}),env);const result=await response.json();if(!response.ok||result.error)throw Error('Synthetic confirmation route rejected: '+url+' '+JSON.stringify(result.error));return result;}
 const renew=async()=>{token=(await request('/auth/device/token',{deviceId:device,refreshCredential:refresh})).accessToken;};await renew();
 function mutation(operation,id,payload,base){return{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,mutationId:'mutation_confirm_'+(++sequence),deviceSequence:sequence,operation,entityId:id,baseEntityVersion:base,payload,clientCreatedAt:at};}
 const source={integrationKind:'todoist',externalIdHash:hash('synthetic-source'),sourceUrl:null,title:'Synthetic source',description:null,projectName:null,priority:null,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,recurrenceRule:null,refreshedAt:at};
 const task={id:'task_confirmation',spaceId:'space_default',title:'Synthetic source',workflowStatus:'inbox',priority:3,createdAt:at,notes:null,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,scheduledStart:null,scheduledEnd:null,durationMinutes:null,recurrenceRule:null,projectId:null,labels:[]};
 await request('/v1/tasks/mutations',mutation('task.createRich',task.id,{task,source},null));
 stage='fresh_delivery_command';
 const complete=await request('/v1/tasks/mutations',mutation('task.complete',task.id,{completedAt:at},1));
 stage='fresh_delivery_claim_start';
 await request('/v1/provider/commands/claim',{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,claimId:'claim_confirmation_synthetic',taskId:task.id,requestedChangeSeq:complete.changeSeq,integrationKind:'todoist',externalIdHash:source.externalIdHash});
 await request('/v1/provider/commands/start',{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,claimId:'claim_confirmation_synthetic'});
 async function initial(){return request('/sync/initial-status',{protocolVersion:1,reportSequence:++statusSequence,state:'complete',acknowledged:2,total:2});}
 async function catchup(){return request('/sync/catchup-status',{protocolVersion:1,reportSequence:++catchupSequence,state:'idle',pending:0});}
 async function pullAck(){const page=await request('/sync/changes?after=0&limit=50&workspace=1&paged=1');await request('/sync/checkpoints',{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,checkpoint:page.nextCheckpoint});}
 stage='preparation';await initial();stage='catchup_initial_report';await catchup();stage='preparation';await pullAck();
 const pending=mutation('externalCommand.confirm',task.id,{claimId:'claim_confirmation_synthetic',requestedChangeSeq:complete.changeSeq,resolvedAt:at,errorCode:null},null);
 stage='pass_before';await request('/health');await initial();await catchup();
 stage='pending_confirmation';await request('/v1/tasks/mutations',pending);
 stage='pass_after';await pullAck();await initial();await catchup();
 stage='exact_duplicate';await request('/v1/tasks/mutations',pending);
 stage='token_renewal';await renew();
 stage='native_note_patch';await request('/v1/tasks/mutations',mutation('task.patch','background_0',{fields:{notes:'Synthetic current-schema note'}},1));
 stage='source_heartbeat';await request('/v1/tasks/mutations',mutation('source.refreshSnapshot',task.id,{source:{...source,refreshedAt:new Date(Date.now()+6*3600000).toISOString()}},null));
 const keys=['requests','rowsRead','rowsWritten'];
 const conservativeSingleConfirmation=Object.fromEntries(keys.map(k=>[k,totals.pending_confirmation[k]+totals.pass_before[k]+totals.pass_after[k]+totals.token_renewal[k]]));
 const fullDeliveryWorkflow=Object.fromEntries(keys.map(k=>[k,conservativeSingleConfirmation[k]+totals.fresh_delivery_command[k]+totals.fresh_delivery_claim_start[k]]));
 const report={formatVersion:1,syntheticOnly:true,localMetadataNotLiveBilling:true,population:{tasks:900},totals,conservativeSingleConfirmation,credits:50,fullDeliveryWorkflow,fullDeliveryCredits:100,scope:'Already-prepared valid confirmation only. A whole fresh health/initial+catchup reporting/pull/ACK pass and token renewal are charged per confirmation as a conservative bound. The separate fresh delivery workflow adds its own command envelope and claim/start routes, with two 50-credit envelopes; no provider calls.',failedBatchMetadata:'Unavailable for failures; successful metadata is not an exceptional-failure billing guarantee.'};
 await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await mf.dispose();}
