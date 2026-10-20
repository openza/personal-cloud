// Synthetic local D1 metadata through the real authenticated Worker routes.
// Fixture preparation is excluded; no provider or Cloudflare account is used.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readD1Migrations} from '@cloudflare/vitest-plugin';
import worker from '../src/index.ts';
import {instrumentD1} from './d1-metrics.mjs';

const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
const output=path.resolve(args.output??'artifacts/fanout-budget.json');
if(!output.startsWith(path.join(process.cwd(),'artifacts')+path.sep))throw Error('Keep local evidence under ignored artifacts/.');
const sizes=(args.sizes??'0,1,10,100,900,1000,2000,3000').split(',').map(Number);
if(sizes.some(n=>!Number.isSafeInteger(n)||n<0||n>10000))throw Error('Invalid synthetic size.');
const labels=Number(args.labels??0),background=Number(args.background??0);
if(!Number.isSafeInteger(labels)||labels<0||labels>32||!Number.isSafeInteger(background)||background<0||background>20000)throw Error('Invalid synthetic dimensions.');
const cases=['project.delete','task.moveTree'].flatMap(operation=>sizes.map(size=>({operation,size})));
const bindings=Object.fromEntries(cases.map((_,i)=>['DB'+i,'fanout-synthetic-'+i]));
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("synthetic fanout");}}',compatibilityDate:'2026-09-13',d1Databases:bindings,host:'127.0.0.1',port:0}));
const hash=value=>createHash('sha256').update(value).digest('hex');
const at=new Date().toISOString(),device='device_fanout_synthetic',token='synthetic-fanout-access-token',instance='instance_fanout_synthetic';
const migrations=await readD1Migrations('migrations'),results=[];
try{
 const databases=await mf.getBindings();
 for(const [index,item]of cases.entries()){
  const raw=databases['DB'+index];
  for(const migration of migrations)await raw.batch(migration.queries.map(sql=>raw.prepare(sql)));
  await raw.batch([
   raw.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic fanout','desktop',1,0,?2)").bind(device,at),
   raw.prepare('INSERT INTO device_access_tokens(token_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)').bind(hash(token),device,at,new Date(Date.now()+3600_000).toISOString()),
   raw.prepare("INSERT INTO projects(id,space_id,name,created_at,updated_at) VALUES('project_fanout','space_default','Synthetic project',?1,?1)").bind(at),
  ]);
  if(args.owner==='true')await raw.batch([
   raw.prepare("INSERT INTO owner_credentials(credential_id,display_name,public_key_jwk,created_at) VALUES('synthetic-owner','Synthetic owner','{}',?1)").bind(at),
   raw.prepare("INSERT INTO web_sessions(session_hash,credential_id,csrf_hash,created_at,rotated_at,expires_at,absolute_expires_at) VALUES(?1,'synthetic-owner',?2,?3,?3,?4,?4)").bind(hash('synthetic-fanout-session'),hash('synthetic-fanout-csrf'),at,new Date(Date.now()+3600_000).toISOString()),
   raw.prepare("INSERT INTO sync_catchup_status(device_id,report_sequence,state,pending,finished_at,updated_at) VALUES(?1,1,'idle',0,?2,?3)").bind(device,new Date(Date.now()-86400000).toISOString(),at),
  ]);
  // A star tree avoids making depth an accidental population limit. All task
  // records use the same minimal shape; large fields/labels are separate risks.
  if(item.size&&args.tasks!=='false')await raw.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v+1<?1)
   INSERT INTO tasks(id,product,space_id,title,completion_state,workflow_status,created_at,entity_version,created_by_mutation_id,project_id,parent_id)
   SELECT 'task_fanout_'||v,'tasks','space_default','Synthetic task','open','inbox',?2,1,'seed_'||v,'project_fanout',NULL FROM n`).bind(item.size,at).run();
  if(item.operation==='task.moveTree'&&item.size>1)await raw.prepare("UPDATE tasks SET parent_id='task_fanout_0' WHERE id<>'task_fanout_0'").run();
  if(args.childProjects==='true'&&item.operation==='project.delete'&&item.size)await raw.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v+1<?1)
   INSERT INTO projects(id,space_id,name,parent_id,created_at,updated_at) SELECT 'child_project_'||v,'space_default','Synthetic child project','project_fanout',?2,?2 FROM n`).bind(item.size,at).run();
  if(labels&&item.size){
   await raw.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v+1<?1) INSERT INTO labels(id,name) SELECT 'label_'||v,'Synthetic label' FROM n`).bind(labels).run();
   await raw.prepare('INSERT INTO task_labels(task_id,label_id) SELECT t.id,l.id FROM tasks t CROSS JOIN labels l').run();
  }
  if(background)await raw.prepare(`WITH RECURSIVE n(v) AS(SELECT 0 UNION ALL SELECT v+1 FROM n WHERE v+1<?1)
   INSERT INTO tasks(id,product,space_id,title,completion_state,workflow_status,created_at,entity_version,created_by_mutation_id) SELECT 'background_'||v,'tasks','space_default','Synthetic unrelated task','open','inbox',?2,1,'background_seed_'||v FROM n`).bind(background,at).run();
  const totals={};let stage='health';
  const metric=()=>totals[stage]??={requests:0,statements:0,rowsRead:0,rowsWritten:0};
  const db=instrumentD1(raw,entry=>{const s=metric();s.statements++;s.rowsRead+=entry.rowsRead;s.rowsWritten+=entry.rowsWritten;});
  const env={DB:db,INSTANCE_ID:instance,ARTIFACT_VERSION:'0.0.0-fanout-measurement'};
  async function request(url,body){metric().requests++;const response=await worker.fetch(new Request('https://synthetic.example'+url,{headers:{authorization:'Bearer '+token,'content-type':'application/json',origin:'https://synthetic.example',...(args.owner==='true'&&['/v1/tasks/mutations','/sync/catchup-status','/auth/web-pending-change'].includes(url)?{cookie:'__Host-openza_session=synthetic-fanout-session','x-openza-csrf':'synthetic-fanout-csrf'}:{}),...(args.guarded==='true'&&url==='/v1/tasks/mutations'?{'x-openza-fanout-bound':String((args.tasks==='false'?0:item.size)+(args.childProjects==='true'&&item.operation==='project.delete'?item.size:0))}:{})},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})}),env);return{status:response.status,body:await response.json()};}
  await request('/health');
  const mutation={protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,mutationId:'mutation_fanout_synthetic',deviceSequence:1,operation:item.operation,entityId:item.operation==='project.delete'?'project_fanout':'task_fanout_0',baseEntityVersion:1,payload:item.operation==='project.delete'?{}:{spaceId:'space_default',fields:{}},clientCreatedAt:at};
  stage='operation';const accepted=await request('/v1/tasks/mutations',mutation);
  stage='duplicateRetry';const retry=await request('/v1/tasks/mutations',mutation);
  let payloadBytes=null;
  if(accepted.status===201){
   payloadBytes=await raw.prepare('SELECT length(CAST(payload_json AS BLOB)) AS n FROM changes WHERE mutation_id=?1').bind(mutation.mutationId).first('n');
   stage='pullAck';const changes=await request('/sync/changes?after=0&limit=50&workspace=1&paged=1');
   if(changes.status!==200)throw Error('Synthetic pull failed.');
   await request('/sync/checkpoints',{protocolVersion:1,product:'tasks',instanceId:instance,deviceId:device,checkpoint:changes.body.nextCheckpoint});
  }
  if(args.owner==='true'&&item.size===900){
   for(const [name,state,seq]of [['catchup_start','catching_up',2],['catchup_finish','idle',3],['catchup_idle_heartbeat','idle',4]]){
    stage=name;const response=await request('/sync/catchup-status',{protocolVersion:1,reportSequence:seq,state,pending:state==='idle'?0:900});
    if(response.status!==200||!response.body.accepted)throw Error('Synthetic catchup report failed.');
   }
   stage='catchup_read';if((await request('/sync/catchup-status')).status!==200)throw Error('Synthetic catchup read failed.');
   await raw.prepare("INSERT INTO projects(id,space_id,name,created_at,updated_at) VALUES('project_recovery','space_default','Synthetic recovery',?1,?1)").bind(at).run();
   const unfinished={...mutation,deviceId:'web_recovery_synthetic',mutationId:'mutation_recovery_synthetic',operation:'project.delete',entityId:'project_recovery',payload:{}};
   stage='recovery_check';const checked=await request('/auth/web-pending-change',{protocolVersion:1,action:'check',mutation:unfinished});
   if(checked.status!==200||checked.body.state!=='unapplied')throw Error('Synthetic recovery check failed.');
   const cancel={protocolVersion:1,action:'cancel',mutation:unfinished,canonicalHash:checked.body.canonicalHash};
   stage='recovery_cancel';const cancelled=await request('/auth/web-pending-change',cancel);
   if(cancelled.status!==200||cancelled.body.state!=='cancelled')throw Error('Synthetic recovery cancel failed.');
   stage='recovery_duplicate_check';if((await request('/auth/web-pending-change',{protocolVersion:1,action:'check',mutation:unfinished})).body.state!=='cancelled')throw Error('Synthetic recovery replay failed.');
   stage='recovery_duplicate_cancel';if((await request('/auth/web-pending-change',cancel)).body.state!=='cancelled')throw Error('Synthetic recovery cancel replay failed.');
  }
  const row={...item,ownerSession:args.owner==='true',guarded:args.guarded==='true',taskCount:args.tasks==='false'?0:item.size,labelsPerTask:labels,backgroundTasks:background,childProjects:args.childProjects==='true'&&item.operation==='project.delete'?item.size:0,status:accepted.status,error:accepted.body.error?.code??null,retryStatus:retry.status,retryOutcome:retry.body.outcome??retry.body.error?.code,payloadBytes,failedBatchMetadataUnavailable:accepted.status!==201&&item.size>0,totals};
  results.push(row);console.log(JSON.stringify(row));
 }
 await fs.mkdir(path.dirname(output),{recursive:true});
 await fs.writeFile(output,JSON.stringify({formatVersion:1,syntheticOnly:true,localMetadataNotLiveBilling:true,source:'real authenticated Worker mutations; raw synthetic fixture seed excluded',results},null,2)+'\n');
}finally{await mf.dispose();}
