import {env,exports} from 'cloudflare:workers';
import {it,expect,vi} from 'vitest';
import {bootstrapPage,maximumSyncResponseBytes,utf8Bytes} from '../src/workspace-paging.ts';
import {bootstrap} from '../src/bootstrap.ts';
import {pullChanges} from '../src/change-pull.ts';
import {applyWorkspaceMutation} from '../src/workspace-mutations.ts';
import {parseWorkspaceMutation} from '../src/workspace-protocol.ts';
import {taskJson} from '../src/workspace-records.ts';
const at='2026-10-15T00:00:00.000Z';let counter=0;
function spaceMutation(id:string,device=`device.paging.${++counter}`,sequence=1){return {protocolVersion:1,product:'tasks',instanceId:env.INSTANCE_ID,deviceId:device,mutationId:`mutation.paging.${++counter}`,deviceSequence:sequence,operation:'space.put',entityId:id,baseEntityVersion:null,clientCreatedAt:at,payload:{space:{name:'Synthetic',color:null,icon:null,sortOrder:0,isArchived:false,createdAt:at}}};}
async function apply(m:any){const raw=JSON.stringify(m);return applyWorkspaceMutation(env.DB,parseWorkspaceMutation(raw,env.INSTANCE_ID),raw);}
async function dense(prefix:string,count:number,project:string|null=null){await env.DB.prepare("WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?1) INSERT INTO tasks(id,product,space_id,project_id,title,completion_state,workflow_status,created_at,entity_version,created_by_mutation_id,notes,deadline_at,scheduled_start,source_owner_device_id) SELECT ?2||i,'tasks','space_default',?3,'Synthetic','open','inbox',?4,1,'mutation.'||?2||i,?5,?4,?4,'device.synthetic' FROM n").bind(count,prefix,project,at,'文'.repeat(1365)).run();}
it('downloads a dense valid baseline in bounded complete pages without losing exact fields or source mirrors',async()=>{
 await dense('task.paging.dense.',600);
 await env.DB.prepare("INSERT INTO source_descriptors(task_id,integration_kind,external_id_hash,source_title,source_description,refreshed_at) SELECT id,'todoist',printf('%064x',rowid),'Provider title',?1,?2 FROM tasks WHERE id LIKE 'task.paging.dense.%'").bind('s'.repeat(12000),at).run();
 await env.DB.prepare("WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<32) INSERT INTO labels(id,name) SELECT 'label.paging.'||i,printf('%0512d',i) FROM n").run();
 await env.DB.prepare("INSERT INTO task_labels(task_id,label_id) SELECT t.id,l.id FROM tasks t CROSS JOIN labels l WHERE t.id LIKE 'task.paging.dense.%' AND l.id LIKE 'label.paging.%'").run();
 await expect(bootstrap(env.DB,true)).rejects.toMatchObject({code:'upgrade_required'});
 let cursor:string|null=null,checkpoint:number|undefined,pages=0,taskPages=0;const tasks:any[]=[],sources:any[]=[];
 do{const page=await bootstrapPage(env.DB,env.INSTANCE_ID,'device.reader',cursor);expect(utf8Bytes(page)).toBeLessThanOrEqual(maximumSyncResponseBytes);expect(Object.keys(page.snapshot)).toHaveLength(12);expect(Object.values(page.snapshot).reduce((n,a)=>n+a.length,0)).toBeLessThanOrEqual(100);expect(page.hasMore).toBe(page.nextCursor!==null);checkpoint??=page.checkpoint;expect(page.checkpoint).toBe(checkpoint);tasks.push(...page.snapshot.tasks);sources.push(...page.snapshot.sourceDescriptors);if(page.snapshot.tasks.length)taskPages++;cursor=page.nextCursor;expect(++pages).toBeLessThan(250);}while(cursor);
 expect(tasks).toHaveLength(600);expect(taskPages).toBeGreaterThan(6);expect(new Set(tasks.map(t=>t.id)).size).toBe(600);expect(sources).toHaveLength(600);expect(tasks[0].labels).toHaveLength(32);expect(tasks[0]).toMatchObject({title:'Provider title',notes:'文'.repeat(1365),deadlineAt:at,scheduledStart:at,sourceOwnerDeviceId:'device.synthetic',source:{description:'s'.repeat(12000),refreshedAt:at}});
});
it('binds cursors to actor and instance, rejects tampering/expiry and detects concurrent writes',async()=>{
 const page=await bootstrapPage(env.DB,env.INSTANCE_ID,'device.reader.a',null),cursor=page.nextCursor!;
 for(const [instance,actor,value] of [[env.INSTANCE_ID,'device.reader.b',cursor],['other.instance','device.reader.a',cursor],[env.INSTANCE_ID,'device.reader.a',cursor.slice(0,-4)+'AAAA']])await expect(bootstrapPage(env.DB,instance,actor,value)).rejects.toMatchObject({code:'invalid_request'});
 vi.useFakeTimers({toFake:['Date']});try{vi.setSystemTime(Date.now()+11*60_000);await expect(bootstrapPage(env.DB,env.INSTANCE_ID,'device.reader.a',cursor)).rejects.toMatchObject({code:'invalid_request'});}finally{vi.useRealTimers();}
 await apply(spaceMutation('space.paging.changed'));await expect(bootstrapPage(env.DB,env.INSTANCE_ID,'device.reader.a',cursor)).rejects.toMatchObject({code:'bootstrap_changed'});
 const restarted=await bootstrapPage(env.DB,env.INSTANCE_ID,'device.reader.a',null);expect(restarted.checkpoint).toBeGreaterThan(page.checkpoint);
});
it('validates query negotiation and duplicate parameters before reading baseline pages',async()=>{
 for(const query of ['paged=1','workspace=1&paged=0','workspace=1&cursor=x','workspace=1&paged=1&cursor=','workspace=1&paged=1&paged=1','workspace=1&paged=1&extra=x'])expect((await exports.default.fetch(`https://personal-cloud.local/sync/bootstrap?${query}`)).status).toBe(400);
 const response=await exports.default.fetch('https://personal-cloud.local/sync/bootstrap?workspace=1&paged=1');expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
});
it('uses UTF-8 byte pagination and explicit hasMore for a contiguous compound feed prefix',async()=>{
 const start=(await env.DB.prepare('SELECT next_change_seq FROM cloud_state WHERE singleton=1').first<{next_change_seq:number}>())!.next_change_seq;
 const payload={spaces:[],projects:[],tasks:Array.from({length:10},(_,n)=>({id:`task.feed.${n}`,notes:'文'.repeat(1365),source:{description:'s'.repeat(1536)}})),scopes:[],catalog:[],intents:[],routes:[]};
 await env.DB.batch(Array.from({length:50},(_,n)=>env.DB.prepare("INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at) VALUES(?1,1,'tasks',?2,'workspace.changed','workspace',?3,1,?4,?5)").bind(start+n+1,`mutation.paging.feed.${n}`,`task.feed.${n}`,JSON.stringify(payload),at)));
 await env.DB.prepare('UPDATE cloud_state SET next_change_seq=?1 WHERE singleton=1').bind(start+50).run();
 await expect(pullChanges(env.DB,start,50,true)).rejects.toMatchObject({code:'upgrade_required'});
 let after=start,more=true;const sequences:number[]=[];let pages=0;
 while(more){const page=await pullChanges(env.DB,after,50,true,true);expect(utf8Bytes(page)).toBeLessThanOrEqual(maximumSyncResponseBytes);expect(page.changes.length).toBeGreaterThan(0);if(!pages){expect(page.changes.length).toBeLessThan(50);expect(page.hasMore).toBe(true);}sequences.push(...page.changes.map(c=>c.changeSeq));after=page.nextCheckpoint;more=page.hasMore!;expect(++pages).toBeLessThan(5);}
 expect(sequences).toEqual(Array.from({length:50},(_,n)=>start+n+1));
 const empty=await pullChanges(env.DB,after,50,true,true);expect(empty).toMatchObject({changes:[],nextCheckpoint:after,hasMore:false});
});
it('rejects an oversized historical single change explicitly without advancing or skipping it',async()=>{
 const seq=900001,payload={spaces:[],projects:[],tasks:[{id:'task.oversized',notes:'x'.repeat(maximumSyncResponseBytes)}],scopes:[],catalog:[],intents:[],routes:[]};
 await env.DB.prepare("INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at) VALUES(?1,1,'tasks','mutation.oversized','workspace.changed','workspace','task.oversized',1,'{}',?2)").bind(seq,at).run();
 // Model historical data predating the new insertion bound, without disabling guards.
 await env.DB.prepare('UPDATE changes SET payload_json=?1 WHERE change_seq=?2').bind(JSON.stringify(payload),seq).run();
 await env.DB.prepare('UPDATE cloud_state SET next_change_seq=?1 WHERE singleton=1').bind(seq).run();
 await expect(pullChanges(env.DB,seq-1,50,true,true)).rejects.toMatchObject({code:'response_too_large'});
});
it('rolls back an oversized project cascade instead of inserting an undownloadable change',async()=>{
 const project='project.paging.oversized',device='device.paging.oversized',m={...spaceMutation(project,device),operation:'project.put',payload:{project:{spaceId:'space_default',name:'Synthetic',description:null,color:null,icon:null,parentId:null,sortOrder:0,status:'active',isFavorite:false,createdAt:at}}};await apply(m);await dense('task.paging.cascade.',500,project);
 const deletion={...spaceMutation(project,device,2),operation:'project.delete',baseEntityVersion:1,payload:{}};await expect(apply(deletion)).rejects.toMatchObject({code:'response_too_large'});
 expect(await env.DB.prepare('SELECT deleted_at FROM projects WHERE id=?1').bind(project).first()).toEqual({deleted_at:null});expect(await env.DB.prepare('SELECT count(*) AS count FROM tasks WHERE project_id=?1').bind(project).first()).toEqual({count:500});expect(await env.DB.prepare('SELECT last_sequence FROM device_sequences WHERE device_id=?1').bind(device).first()).toEqual({last_sequence:1});expect(await env.DB.prepare('SELECT mutation_id FROM mutation_receipts WHERE mutation_id=?1').bind(deletion.mutationId).first()).toBeNull();
});
it('normalizes D1 size errors before the insertion trigger to a nonretryable size conflict',async()=>{
 const m=spaceMutation('space.paging.toobig'),raw=JSON.stringify(m),db=new Proxy(env.DB,{get(target,key){if(key==='batch')return async()=>{throw Error('D1_ERROR: string or blob too big: SQLITE_TOOBIG')};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
 await expect(applyWorkspaceMutation(db,parseWorkspaceMutation(raw,env.INSTANCE_ID),raw)).rejects.toMatchObject({code:'response_too_large'});expect(await env.DB.prepare('SELECT id FROM spaces WHERE id=?1').bind(m.entityId).first()).toBeNull();
});
it('materializes only the byte-bounded prefix when fifty near-maximum compound rows exist',async()=>{
 const record=JSON.parse((await env.DB.prepare(`SELECT ${taskJson} AS record FROM tasks t WHERE t.id LIKE 'task.paging.dense.%' LIMIT 1`).first<{record:string}>())!.record),payload={spaces:[],projects:[],tasks:[] as any[],scopes:[],catalog:[],intents:[],routes:[]};
 do{payload.tasks.push({...record,id:`task.nearmax.${payload.tasks.length}`})}while(utf8Bytes(payload)<1850000);
 const raw=JSON.stringify(payload);expect(utf8Bytes(payload)).toBeLessThan(1900000);
 const start=1000000;await env.DB.prepare("WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50) INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at) SELECT ?1+i,1,'tasks','mutation.nearmax.'||i,'workspace.changed','workspace','task.nearmax.'||i,1,?2,?3 FROM n").bind(start,raw,at).run();
 let materialized=0,bytes=0;const wrap=(stmt:D1PreparedStatement):D1PreparedStatement=>new Proxy(stmt,{get(target,key){if(key==='bind')return(...args:any[])=>wrap(target.bind(...args));if(key==='all')return async()=>{const result=await target.all<any>();materialized+=result.results.length;bytes+=result.results.reduce((n,row)=>n+new TextEncoder().encode(row.payload_json??'').length,0);expect(result.meta.rows_read).toBeLessThan(500);return result};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}}),db=new Proxy(env.DB,{get(target,key){if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql));const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
 const page=await pullChanges(db,start,50,true,true);expect(materialized).toBe(1);expect(bytes).toBeLessThan(1900000);expect(page).toMatchObject({nextCheckpoint:start+1,hasMore:true});expect(page.changes).toHaveLength(1);expect(utf8Bytes(page)).toBeLessThanOrEqual(maximumSyncResponseBytes);
});
