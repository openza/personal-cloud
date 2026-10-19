// Disposable acceptance environment. Uses the repository's existing TEST_MODE
// contract and synthetic owner fixture, never the owner's real cloud or passkey.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
const root=process.cwd(),publicRoot=path.join(root,'public'),origin='http://127.0.0.1:8788';
const artifact=process.argv[2];
if(!artifact)throw Error('Usage: node scripts/shared-parity-fixture.mjs dist/openza-personal-cloud-<validation-version>');
const artifactRoot=path.resolve(root,artifact);
if(!artifactRoot.startsWith(path.join(root,'dist')+path.sep))throw Error('Use a local validation artifact under dist/.');
const artifactManifest=JSON.parse(await fs.readFile(path.join(artifactRoot,'artifact-manifest.json'),'utf8'));
const instance='instance_'+randomUUID().replaceAll('-','');
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:path.join(artifactRoot,'worker.js'),compatibilityDate:'2026-09-13',d1Databases:{DB:'parity-browser-fixture'},bindings:{INSTANCE_ID:instance,ARTIFACT_VERSION:artifactManifest.artifactVersion,TEST_MODE:'true',K5_TEST_SESSION:'k5-local-read-only'},host:'127.0.0.1',port:0}));
const {DB:db}=await mf.getBindings();
for(const migration of await readD1Migrations(path.join(root,'migrations')))await db.batch(migration.queries.map(query=>db.prepare(query)));
const readinessTrigger=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='tasks_accepted_updated_at'").first();
const now=new Date().toISOString(),expires=new Date(Date.now()+12*60*60*1000).toISOString(),session='synthetic-browser-session',hash=value=>createHash('sha256').update(value).digest('hex');
await db.prepare("INSERT INTO owner_credentials(credential_id,display_name,public_key_jwk,created_at) VALUES('browser-fixture','Synthetic owner','{}',?1)").bind(now).run();
await db.prepare("INSERT INTO web_sessions(session_hash,credential_id,csrf_hash,created_at,rotated_at,expires_at,absolute_expires_at) VALUES(?1,'browser-fixture',?2,?3,?3,?4,?4)").bind(hash(session),hash('synthetic-csrf'),now,expires).run();
await db.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES('fixture-desktop','Synthetic desktop','desktop',1,0,?1)").bind(now).run();
await db.prepare("INSERT INTO initial_sync_status(device_id,report_sequence,state,acknowledged,total,updated_at) VALUES('fixture-desktop',1,'complete',5,5,?1)").bind(now).run();
let sequence=0;
async function mutate(operation,entityId,payload,baseEntityVersion=null){sequence++;const response=await mf.dispatchFetch('https://personal-cloud.local/v1/tasks/mutations',{method:'POST',body:JSON.stringify({protocolVersion:1,product:'tasks',instanceId:instance,deviceId:'fixture-desktop',deviceSequence:sequence,mutationId:`fixture_${sequence}`,operation,entityId,baseEntityVersion,payload,clientCreatedAt:now})});const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));return result;}
await mutate('space.put','space_studio',{space:{name:'Studio',color:null,icon:null,sortOrder:1,isArchived:false,createdAt:now}});
await mutate('project.put','project_launch',{project:{spaceId:'space_default',name:'Launch checklist',description:'Synthetic parity validation',color:null,icon:null,parentId:null,sortOrder:0,status:'active',isFavorite:true,createdAt:now}});
const today='2026-10-17';
for(const [index,title,status,priority,plannedOn,spaceId] of [[1,'Review keyboard focus','next',1,today,'space_default'],[2,'A deliberately long task title to verify consistent wrapping and readable metadata across both Openza apps','inbox',3,null,'space_default'],[3,'Waiting for design feedback','waiting',2,null,'space_default'],[4,'Explore mobile layout','someday',4,null,'space_studio'],[5,'Prepare release notes','next',2,'2026-10-16','space_default']]){
 const id=`fixture_task_${index}`;await mutate('task.createRich',id,{task:{id,spaceId,title,workflowStatus:status,priority,createdAt:now,notes:'Synthetic test notes.\nUnicode: नमस्ते ✓',plannedOn,plannedAt:null,deadlineOn:index===1?'2026-10-18':null,deadlineAt:null,scheduledStart:null,scheduledEnd:null,durationMinutes:null,recurrenceRule:null,projectId:index===1?'project_launch':null,labels:[{id:'label_review',name:'review'}]}});
}
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
let quotaMode='ready',apiRequests=0;
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,origin);let response;
 if(url.pathname==='/__synthetic-fixture')response=Response.json({fixture:'openza-shared-parity',protocolVersion:1});
 else if(url.pathname==='/__synthetic-fixture/quota/stats')response=Response.json({syntheticOnly:true,quotaMode,apiRequests});
 else if(/^\/__synthetic-fixture\/quota\/(ready|read|write|edge|mutation-write)$/.test(url.pathname)){
  quotaMode=url.pathname.split('/').at(-1);response=Response.json({syntheticOnly:true,quotaMode,apiRequests});
 }
 else if(url.pathname==='/__synthetic-fixture/quota/controls'){
  const spent={version:1,origin,instanceId:instance,day:new Date().toISOString().slice(0,10),requests:10000,envelopes:0,writeCredits:0,hold:null,locallySignedOut:false};
  response=new Response(`<!doctype html><title>Synthetic quota controls</title><h1>Synthetic local fixture only</h1><p>This affects this disposable localhost browser fixture.</p><button id="budget">Spend local HTTP budget and open tasks</button><button id="clear">Clear synthetic local brake and open tasks</button><script>const key='openza-cloud-brake-v1:'+location.origin,spent=${JSON.stringify(spent)};spent.origin=location.origin;document.querySelector('#budget').onclick=()=>{localStorage.setItem(key,JSON.stringify(spent));location.href='/';};document.querySelector('#clear').onclick=()=>{localStorage.removeItem(key);location.href='/';};</script>`,{headers:{'content-type':'text/html; charset=utf-8'}});
 }
 else if(url.pathname==='/__synthetic-fixture/health/unready'){
  await db.prepare('DROP TRIGGER IF EXISTS tasks_accepted_updated_at').run();
  response=Response.json({fixture:'openza-shared-parity',health:'unready'});
 }
 else if(url.pathname==='/__synthetic-fixture/health/ready'){
  await db.prepare(readinessTrigger.sql.replace('CREATE TRIGGER','CREATE TRIGGER IF NOT EXISTS')).run();
  response=Response.json({fixture:'openza-shared-parity',health:'ready'});
 }
 else if((url.pathname==='/health'||/^\/(auth|v1|sync|devices)\//.test(url.pathname))&&quotaMode!=='ready'&&(quotaMode!=='mutation-write'||req.method==='POST'&&url.pathname.startsWith('/v1/tasks/mutations'))){
  apiRequests++;
  const mode=quotaMode;if(mode==='mutation-write')quotaMode='ready';
  if(mode==='edge')response=new Response('<html><head><title>Cloudflare Error</title></head><body><span class="cf-error-code">1027</span></body></html>',{status:503,headers:{'content-type':'text/html','server':'cloudflare','cf-ray':'synthetic-quota'}});
  else{const reset=new Date();reset.setUTCHours(24,0,0,0);response=Response.json({protocolVersion:1,product:'tasks',error:{code:'daily_quota_exceeded',message:'Synthetic daily cloud limit.',retryable:true,requestId:'request_synthetic_browser',quota:{protocolVersion:1,resource:mode==='read'?'d1_rows_read':'d1_rows_written',resetAt:reset.toISOString()}}},{status:503,headers:{date:new Date().toUTCString(),'retry-after':String(Math.ceil((reset-Date.now())/1000))}});}
 }
 else if(url.pathname.startsWith('/v1/tasks')&&await fs.stat(path.join(root,'artifacts/parity-service-unavailable')).then(()=>true,()=>false))response=Response.json({error:{code:'service_unavailable',message:'Synthetic service interruption'}},{status:503});
 else if(['/auth/status','/auth/session','/auth/session/rotate'].includes(url.pathname)){apiRequests++;response=Response.json(url.pathname==='/auth/status'?{protocolVersion:1,initialized:true}:{protocolVersion:1,csrfToken:'synthetic-csrf'});}
 else if(url.pathname==='/health'||url.pathname.startsWith('/auth/')||url.pathname.startsWith('/v1/')||url.pathname.startsWith('/sync/')||url.pathname.startsWith('/devices')){apiRequests++;const chunks=[];for await(const chunk of req)chunks.push(chunk);const headers=new Headers(req.headers);headers.set('origin','https://personal-cloud.local');headers.set('x-openza-test-session','k5-local-read-only');headers.set('cookie',`__Host-openza_session=${session}`);response=await mf.dispatchFetch('https://personal-cloud.local'+url.pathname+url.search,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});}
 else {const file=path.resolve(publicRoot,url.pathname==='/'||url.pathname==='/settings'?'index.html':'.'+url.pathname);if(!file.startsWith(publicRoot+path.sep))throw Error('Invalid path');response=new Response(await fs.readFile(file),{headers:{'content-type':types[path.extname(file)]||'application/octet-stream'}});}
 res.writeHead(response.status,{'cache-control':'no-store',...Object.fromEntries(response.headers)});res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){const missing=error?.code==='ENOENT';res.writeHead(missing?404:500,{'content-type':'text/plain'});res.end(missing?'Not found':String(error));}});
server.listen(8788,'127.0.0.1',()=>console.log('Synthetic acceptance fixture ready at '+origin));
process.on('SIGINT',async()=>{server.close();await mf.dispose();process.exit(0);});
