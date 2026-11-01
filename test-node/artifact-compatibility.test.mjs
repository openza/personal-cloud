import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readD1Migrations} from '@cloudflare/vitest-plugin';

// Build explicitly first. This suite consumes an ignored local artifact only.
const directory=process.env.OPENZA_TEST_ARTIFACT;
const enabled={skip:!directory&&'Set OPENZA_TEST_ARTIFACT to a locally built artifact directory.'};
async function manifest(){return JSON.parse(await fs.readFile(path.join(directory,'artifact-manifest.json'),'utf8'));}
test('emitted Web transport and mutation modules cancel queued work without borrowing a new session',enabled,async()=>{
 const {createOwnerApi}=await import(pathToFileURL(path.resolve(directory,'assets/owner-api.js')));
 const {createMutationSender}=await import(pathToFileURL(path.resolve(directory,'assets/mutation-queue.js')));
 let generation=0,csrf='old',release,requests=0;
 let locked;
 const lockEntered=new Promise(resolve=>locked=resolve);
 const storage=new Map(),locks={request:(name,action)=>name==='openza-owner-session-write'?new Promise((resolve,reject)=>{
  release=()=>Promise.resolve().then(action).then(resolve,reject);locked();
 }):action()};
 const api=createOwnerApi({fetch:async()=>requests++,locks,getGeneration:()=>generation,getCsrf:()=>csrf,setCsrf:value=>csrf=value});
 const sender=createMutationSender({storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
  locks,getGeneration:()=>generation,sequenceKey:'emitted',makeId:()=> 'synthetic_mutation',now:()=>new Date(0).toISOString(),send:body=>api('/v1/tasks/mutations',{method:'POST',csrf:true,body})});
 const pending=sender('synthetic','web','task',1,'task.delete',{});
 const rejected=assert.rejects(pending,error=>error.code==='session_changed'&&error.dispatched===false);
 await lockEntered;generation++;csrf='next';release();
 await rejected;
 assert.equal(requests,0);assert.equal(storage.size,0);assert.equal(csrf,'next');
});
test('format1 artifact retains the exact Desktop fields, ordered migrations and verified source files',enabled,async()=>{
 const m=await manifest();
 assert.deepEqual(Object.keys(m).sort(),['artifactVersion','assets','compatibilityDate','formatVersion','migrations','worker'].sort());
 assert.equal(m.formatVersion,1);
 assert.equal(m.worker.file,'worker.js');
 const entries=[m.worker,...m.assets,...m.migrations],names=new Set();
 for(const entry of entries){
  assert.equal(names.has(entry.file),false);names.add(entry.file);
  const content=await fs.readFile(path.join(directory,entry.file));
  assert.equal(content.length,entry.size);assert.equal(createHash('sha256').update(content).digest('hex'),entry.sha256);
  assert.deepEqual(Object.keys(entry).sort(),(entry.file.startsWith('assets/')?['file','size','sha256','path','contentType']:['file','size','sha256']).sort());
  if(entry.file.startsWith('assets/'))assert.equal(entry.path,'/'+entry.file.slice('assets/'.length));
 }
 const migrations=(await fs.readdir('migrations')).filter(n=>n.endsWith('.sql')).sort();
 assert.equal(migrations.length,26);assert.deepEqual(m.migrations.map(e=>path.basename(e.file)),migrations);
 for(const [i,name]of migrations.entries()){
  assert.equal(Number(name.slice(0,4)),i+1);
  assert.equal(await fs.readFile(path.join(directory,'migrations',name),'utf8'),(await fs.readFile(path.join('migrations',name),'utf8')).replaceAll('\r\n','\n'));
 }
 for(const name of ['owner-api.js','owner-settings.js','app.js','mutation-queue.js','workspace-controls.js','fanout-draft.js','_headers']){
  assert.equal(await fs.readFile(path.join(directory,'assets',name),'utf8'),await fs.readFile(path.join('public',name),'utf8'));
 }
});

test('built Worker health rejects schema17/20/22/24/25, then accepts populated schema26 without losing receipts',enabled,async()=>{
 const m=await manifest(),mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:path.resolve(directory,'worker.js'),compatibilityDate:m.compatibilityDate,
  d1Databases:{DB:'artifact-health-upgrade'},bindings:{INSTANCE_ID:'synthetic_artifact',ARTIFACT_VERSION:m.artifactVersion},host:'127.0.0.1',port:0}));
 try{
  const {DB}=await mf.getBindings();
  const health=()=>mf.dispatchFetch('https://cloud.example/health');
  async function unavailable(){const r=await health();assert.equal(r.status,503);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal((await r.json()).error.code,'schema_not_ready');}
  await unavailable();
  for(const [i,migration]of (await readD1Migrations(path.join(directory,'migrations'))).entries()){
   await DB.batch(migration.queries.map(sql=>DB.prepare(sql)));
   if([17,20,22,24,25].includes(i+1))await unavailable();
   if(i+1===22)await DB.batch([
    DB.prepare("INSERT INTO tasks(id,product,space_id,title,completion_state,workflow_status,priority,created_at,entity_version,created_by_mutation_id) VALUES('synthetic_task','tasks','space_default','Synthetic upgrade','open','inbox',3,'2026-10-19T00:00:00Z',1,'synthetic_created')"),
    DB.prepare("INSERT INTO changes VALUES(1,1,'tasks','synthetic_created','task.created','task','synthetic_task',1,'{}','2026-10-19T00:00:00Z')"),
    DB.prepare("INSERT INTO mutation_receipts VALUES('synthetic_created',1,'tasks','{}','hash','synthetic_task',1,1,'2026-10-19T00:00:00Z')"),
    DB.prepare("INSERT INTO entity_version_claims VALUES('synthetic_task',1,'synthetic_claim')"),
   ]);
  }
  const response=await health();assert.equal(response.status,200);const body=await response.json();
  assert.deepEqual(Object.keys(body).sort(),['status','protocolVersion','product','artifactVersion','schemaVersion','capabilities'].sort());
  assert.equal(body.schemaVersion,26);assert.equal(body.artifactVersion,m.artifactVersion);assert.equal(body.capabilities.workspace.schemaVersion,26);
  assert.equal((await DB.prepare("SELECT change_seq FROM mutation_receipts WHERE mutation_id='synthetic_created'").first()).change_seq,1);
  assert.equal((await DB.prepare("SELECT mutation_id FROM entity_version_claims WHERE entity_id='synthetic_task'").first()).mutation_id,'synthetic_claim');
  assert.equal((await DB.prepare("SELECT updated_at FROM tasks WHERE id='synthetic_task'").first()).updated_at,'2026-10-19T00:00:00Z');
  assert.deepEqual((await DB.prepare('PRAGMA foreign_key_check').all()).results,[]);
  await assert.rejects(DB.prepare("UPDATE mutation_receipts SET canonical_hash='changed' WHERE mutation_id='synthetic_created'").run(),/immutable/);
 }finally{await mf.dispose();}
});
