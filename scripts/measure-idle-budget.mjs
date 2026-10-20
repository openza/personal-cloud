// Synthetic steady-state fixture prepared outside measurement. Real Worker
// authorization/domain routes and D1 result metadata; no TEST_MODE or account.
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readD1Migrations} from '@cloudflare/vitest-plugin';
import worker from '../src/index.ts';
import {instrumentD1} from './d1-metrics.mjs';
const [input,output,sourceArgument]=process.argv.slice(2);
if(!input||!output?.startsWith('artifacts/'))throw Error('Use counts.json artifacts/<idle-report.json>');
const {counts}=JSON.parse(await fs.readFile(input,'utf8')),sources=Number(sourceArgument??counts.adoptedProviderSourceItems);
if(!Number.isSafeInteger(sources)||sources<1||sources>=counts.tasks||sources>=counts.providerSourceItems)throw Error('This sample needs source-linked and native/unadopted examples within the supplied population.');
const initialCount=counts.spaces-1+counts.projects+counts.providerConnections+counts.tasks+counts.childTasks+counts.providerSourceItems+counts.completedTasks;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("synthetic idle fixture");}}',compatibilityDate:'2026-09-13',d1Databases:{DB:'quota-idle-synthetic'},host:'127.0.0.1',port:0}));
const sha=s=>createHash('sha256').update(s).digest('hex'),device='device_idle_synthetic',instance='instance_idle_synthetic',refresh='synthetic-idle-refresh';
const now=new Date().toISOString(),before=new Date(Date.now()-6*3600_000).toISOString();
const descriptor=(i,refreshedAt=before)=>({integrationKind:'todoist',externalIdHash:sha('synthetic_idle_source_'+i),sourceUrl:null,title:'Synthetic source '+i,description:null,projectName:null,priority:null,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,recurrenceRule:null,refreshedAt});
let scenario='preparation',token,reportSequence=1,checkpoint=counts.cloudAppliedChanges,sequence=0;
let session='synthetic-idle-owner-session',csrf='synthetic-idle-owner-csrf';
const totals={},routes={},queries=[];
const stat=()=>totals[scenario]??={requests:0,rowsRead:0,rowsWritten:0,statements:0};
try{
 const {DB:raw}=await mf.getBindings();for(const migration of await readD1Migrations('migrations'))await raw.batch(migration.queries.map(q=>raw.prepare(q)));
 await raw.batch([
  raw.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic bridge','desktop',1,1,?2)").bind(device,now),
  raw.prepare("INSERT INTO owner_credentials(credential_id,display_name,public_key_jwk,created_at) VALUES('synthetic-idle-owner','Synthetic owner','{}',?1)").bind(now),
  raw.prepare("INSERT INTO web_sessions(session_hash,credential_id,csrf_hash,created_at,rotated_at,expires_at,absolute_expires_at) VALUES(?1,'synthetic-idle-owner',?2,?3,?3,?4,?4)").bind(sha(session),sha(csrf),now,new Date(Date.now()+12*3600_000).toISOString()),
  raw.prepare('INSERT INTO device_refresh_credentials(credential_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)').bind(sha(refresh),device,now,new Date(Date.now()+12*3600_000).toISOString()),
  raw.prepare("INSERT INTO initial_sync_status(device_id,report_sequence,state,acknowledged,total,updated_at) VALUES(?1,1,'complete',?2,?2,?3)").bind(device,initialCount,now),
  raw.prepare("WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v+1<?1) INSERT INTO tasks(id,product,space_id,title,completion_state,workflow_status,priority,created_at,entity_version,created_by_mutation_id,source_owner_device_id) SELECT 'task_idle_'||v,'tasks','space_default','Synthetic task '||v,'open','inbox',3,?2,1,'synthetic_fixture_'||v,CASE WHEN v<?3 THEN ?4 ELSE NULL END FROM n").bind(counts.tasks,now,sources,device),
  raw.prepare("WITH RECURSIVE n(v) AS(SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<?1) INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at) SELECT v,1,'tasks','synthetic_history_'||v,'task.updatedOpenzaFields','task','task_idle_0',1,'{}',?2 FROM n").bind(checkpoint,now),
  raw.prepare('UPDATE cloud_state SET next_change_seq=?1 WHERE singleton=1').bind(checkpoint),
 ]);
 await raw.prepare("WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v+1<?1) INSERT INTO labels(id,name) SELECT 'label_idle_'||v,'Synthetic label '||v FROM n").bind(counts.labels).run();
 const primaryShared=counts.maxTasksPerSharedLabel,sharedAssignments=counts.tasksWithLabels-(counts.labels-counts.sharedLabels);
 const links=[];for(let i=0;i<counts.tasksWithLabels;i++){const label=i<primaryShared?0:i<sharedAssignments?1+(i-primaryShared)%(counts.sharedLabels-1):counts.sharedLabels+i-sharedAssignments;links.push({task:'task_idle_'+i,label:'label_idle_'+label});if(i<counts.taskLabelLinks-counts.tasksWithLabels)links.push({task:'task_idle_'+i,label:'label_idle_1'});}
 await raw.prepare("INSERT INTO task_labels(task_id,label_id) SELECT json_extract(value,'$.task'),json_extract(value,'$.label') FROM json_each(?1)").bind(JSON.stringify(links)).run();
 const sourceItems=Array.from({length:sources},(_,i)=>({id:'task_idle_'+i,source:descriptor(i)}));
 await raw.prepare("INSERT INTO source_descriptors(task_id,integration_kind,external_id_hash,source_title,refreshed_at) SELECT json_extract(value,'$.id'),'todoist',json_extract(value,'$.source.externalIdHash'),json_extract(value,'$.source.title'),?2 FROM json_each(?1)").bind(JSON.stringify(sourceItems),before).run();
 for(let i=0;i<counts.providerConnections;i++)await raw.prepare("INSERT INTO provider_scopes(id,bridge_device_id,integration_kind,available,scope_json,entity_version,created_at,updated_at) VALUES(?1,?2,'todoist',1,?3,1,?4,?4)").bind('scope_idle_'+i,device,JSON.stringify({name:'Synthetic scope '+i,integrationKind:'todoist',available:true,labelNames:[],projectChoices:[]}),now).run();
 const items=Array.from({length:counts.providerSourceItems},(_,i)=>({id:'catalog_idle_'+i,item:{scopeId:'scope_idle_'+i%counts.providerConnections,source:descriptor(i),isSkipped:false,available:true,adoptedTaskId:i<sources?'task_idle_'+i:null,labelNames:[],projectChoices:[]}}));
 await raw.prepare("INSERT INTO provider_catalog(id,bridge_device_id,scope_id,integration_kind,external_id_hash,item_json,entity_version,refreshed_at,created_at,updated_at) SELECT json_extract(value,'$.id'),?2,json_extract(value,'$.item.scopeId'),'todoist',json_extract(value,'$.item.source.externalIdHash'),json_extract(value,'$.item'),1,?3,?3,?3 FROM json_each(?1)").bind(JSON.stringify(items),device,before).run();
 const db=instrumentD1(raw,e=>{stat().statements++;stat().rowsRead+=e.rowsRead;stat().rowsWritten+=e.rowsWritten;queries.push({scenario,sqlHash:sha(e.sql).slice(0,16),rowsRead:e.rowsRead,rowsWritten:e.rowsWritten});});
 const env={DB:db,INSTANCE_ID:instance,ARTIFACT_VERSION:'0.0.0-idle-budget'};
 async function request(path,body,owner=false){stat().requests++;routes[scenario+':'+path.split('?')[0]]=(routes[scenario+':'+path.split('?')[0]]??0)+1;
  const response=await worker.fetch(new Request('https://synthetic.example'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',origin:'https://synthetic.example',...(owner?{cookie:'__Host-openza_session='+session,'x-openza-csrf':csrf}:{authorization:'Bearer '+token})},...(body?{body:JSON.stringify(body)}:{})}),env);const result=await response.json();if(!response.ok||result.error)throw Error(JSON.stringify(result.error));if(owner&&response.headers.get('set-cookie')){session=response.headers.get('set-cookie').split(';')[0].split('=')[1];csrf=result.csrfToken??csrf;}return result;
 }
 async function authorize(){token=(await request('/auth/device/token',{deviceId:device,refreshCredential:refresh})).accessToken;}
 async function pass(){await request('/health');await request('/sync/initial-status',{protocolVersion:1,reportSequence:++reportSequence,state:'complete',acknowledged:initialCount,total:initialCount});await request('/health');let page=await request('/sync/changes?after='+checkpoint+'&limit=50&workspace=1&paged=1');checkpoint=page.nextCheckpoint;while(page.hasMore){page=await request('/sync/changes?after='+checkpoint+'&limit=50&workspace=1&paged=1');checkpoint=page.nextCheckpoint;}await request('/sync/checkpoints',{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,checkpoint});}
 scenario='cold_token';await authorize();
 scenario='warm_idle_cycle';await pass();await request('/health');await request('/health');await request('/v1/provider/intents');await pass();
 async function publish(i,base,source){
  const item={...items[i].item,source};
  await request('/v1/tasks/mutations',{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,mutationId:'mutation_idle_'+(++sequence),deviceSequence:sequence,operation:'provider.catalog.put',entityId:items[i].id,baseEntityVersion:base,payload:{item},clientCreatedAt:now});
 }
 scenario='catalog_timestamp_only_full_cycle';
 for(let i=0;i<items.length;i++){await publish(i,1,descriptor(i,now));if((i+1)%100===0)console.log(JSON.stringify({scenario,through:i+1,metrics:stat()}));}
 scenario='catalog_full_cycle_pull_ack';await pass();
 const changedAt=new Date(Date.now()+1000).toISOString();
 for(const [name,i]of [['catalog_content_change_adopted',0],['catalog_content_change_unadopted',sources]]){
  scenario=name;await publish(i,2,{...descriptor(i,changedAt),title:'Synthetic changed source '+i});
 }
 scenario='catalog_two_changes_pull_ack';await pass();
 let webSequence=0;
 for(const[name,i]of [['owner_note_adopted',0],['owner_note_native',sources]]){
  scenario=name;await request('/v1/tasks/mutations',{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:'web_idle_synthetic',mutationId:'mutation_web_idle_'+(++webSequence),deviceSequence:webSequence,operation:'task.patch',entityId:'task_idle_'+i,baseEntityVersion:1,payload:{fields:{notes:'Synthetic owner note '+i}},clientCreatedAt:now},true);
 }
 scenario='owner_rotation_after_note';await request('/auth/session/rotate',{},true);
 const scale=(v,n)=>Object.fromEntries(Object.entries(v).map(([k,x])=>[k,x*n]));
 const daily=scale(totals.warm_idle_cycle,288);for(const[k,x]of Object.entries(totals.cold_token))daily[k]+=x*144;
 const result={formatVersion:1,syntheticOnly:true,localMeasurementNotLiveBilling:true,requestScope:'Worker-origin API dispatches only; static asset loads excluded, not exact live billed invocations.',population:counts,sourceCase:sources,totals,routes,queries,dailyIdle:daily,
 assumptions:['Raw synthetic population/history/credentials prepared outside measurement; actual Worker auth/domain paths measured without TEST_MODE.',
 'One configured provider or more, provider_bridge enabled, workspace baseline present, completed initial journal, no pending commands/intents: two cloud passes plus bridge per five-minute cycle.',
 'Warm cycle: health6,status2,changes2,checkpoints2,intents1; token renewals separately measured and projected144/day for ten-minute tokens.',
 'Full569 timestamp-only catalog publications measured, followed by separate adopted/unadopted content changes and real change pulls/ACKs. No provider account calls. Change-only client suppression is coordinated separately.',
 'Owner-session note patches measured separately on source-linked/two-label and native tasks, with actual cookie/CSRF rotation. Browser and Desktop reservations are separate; owner writes are not silently included in a shared Desktop cap.']};
 await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({totals,dailyIdle:daily}));
}finally{await mf.dispose();}
