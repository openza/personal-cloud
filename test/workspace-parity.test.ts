import {env,exports} from 'cloudflare:workers';
import {describe,it,expect} from 'vitest';
import {applyWorkspaceMutation} from '../src/workspace-mutations.ts';
import {parseWorkspaceMutation} from '../src/workspace-protocol.ts';
import {canonicalize,computeCanonicalHash} from '../src/protocol.ts';
const at='2026-10-13T00:00:00.000Z';let counter=0;
function envelope(operation:string,entityId:string,base:number|null,payload:any,deviceId?:string,sequence=1){return {protocolVersion:1,product:'tasks',instanceId:env.INSTANCE_ID,deviceId:deviceId??`device.workspace.${++counter}`,mutationId:`mutation.workspace.${++counter}`,deviceSequence:sequence,operation,entityId,baseEntityVersion:base,payload,clientCreatedAt:at};}
async function post(m:any){const response=await exports.default.fetch('https://personal-cloud.local/v1/tasks/mutations',{method:'POST',body:JSON.stringify(m)});return {status:response.status,body:await response.json() as any};}
function rich(id:string,fields:any={}){return {task:{id,spaceId:'space_default',title:'Example',workflowStatus:'inbox',priority:3,createdAt:at,notes:null,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,scheduledStart:null,scheduledEnd:null,durationMinutes:null,recurrenceRule:null,projectId:null,labels:[],...fields}};}
const space=(name:string,isArchived=false)=>({space:{name,color:null,icon:null,sortOrder:0,isArchived,createdAt:at}});
const project=(name:string)=>({project:{spaceId:'space_default',name,description:'Project notes',color:null,icon:null,parentId:null,sortOrder:0,status:'active',isFavorite:true,createdAt:at}});
const source={integrationKind:'todoist',externalIdHash:'f'.repeat(64),sourceUrl:null,title:'Provider task',description:null,projectName:null,priority:2,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,recurrenceRule:'weekly',refreshedAt:at};
const scopePayload=(integrationKind='todoist',available=true)=>({scope:{name:'Synthetic connection',integrationKind,available,labelNames:['Observed'],projectChoices:[{id:'choice.scoped',name:'Cached zero-task project'}]}});
describe.sequential('workspace v1 atomic local contract',()=>{
 it('creates versioned references, replays identically, rejects changed IDs and stale versions',async()=>{const m=envelope('space.put','space.workspace',null,space('Workspace'));expect((await post(m)).status).toBe(201);expect((await post(m)).body.outcome).toBe('duplicate');expect((await post({...m,payload:space('Changed')})).body.error.code).toBe('mutation_id_reused');expect((await post(envelope('space.put',m.entityId,1,space('Renamed')))).status).toBe(201);expect((await post(envelope('space.put',m.entityId,1,space('Stale')))).body.error.code).toBe('version_conflict');});
 it('rolls all fields/labels/sequence/history back on failed rich create then exact replay succeeds',async()=>{const id='task.workspace.rollback',m=envelope('task.createRich',id,null,rich(id,{notes:'Atomic',labels:[{id:'label.workspace',name:'Focus'}]}));await expect(applyWorkspaceMutation(env.DB,parseWorkspaceMutation(JSON.stringify(m),env.INSTANCE_ID),JSON.stringify(m),{failBeforeReceipt:true})).rejects.toThrow();expect(await env.DB.prepare('SELECT id FROM tasks WHERE id=?1').bind(id).first()).toBeNull();expect(await env.DB.prepare('SELECT mutation_id FROM device_sequence_claims WHERE mutation_id=?1').bind(m.mutationId).first()).toBeNull();expect((await post(m)).status).toBe(201);expect((await post(m)).body.outcome).toBe('duplicate');});
 it('patches multiple fields atomically with date/exact clear semantics and enriched reads',async()=>{const id='task.workspace.fields';expect((await post(envelope('task.createRich',id,null,rich(id,{deadlineAt:at,scheduledStart:at,recurrenceRule:'daily'})))).status).toBe(201);expect((await post(envelope('task.patch',id,1,{fields:{notes:'Edited',priority:1,deadlineOn:'2026-10-14'}}))).status).toBe(201);const read=await exports.default.fetch('https://personal-cloud.local/v1/tasks',{headers:{'x-openza-test-session':'k5-local-read-only'}});const t=(await read.json() as any).tasks.find((t:any)=>t.id===id);expect(t).toMatchObject({notes:'Edited',priority:1,deadlineOn:'2026-10-14',deadlineAt:null,scheduledStart:at,recurrenceRule:'daily',entityVersion:2});});
 it('moves whole tree with internal parent preserved, one version per task, one durable change',async()=>{const root='task.workspace.tree',child=root+'.child';await post(envelope('task.createRich',root,null,rich(root)));await post(envelope('task.createRich',child,null,rich(child)));await post(envelope('task.setParent',child,1,{parentId:root}));const moved=await post(envelope('task.moveTree',root,1,{spaceId:'space.workspace',fields:{notes:'Moved'}}));expect(moved.status).toBe(201);const rows=(await env.DB.prepare('SELECT id,space_id,parent_id,notes,entity_version FROM tasks WHERE id IN(?1,?2) ORDER BY id').bind(root,child).all()).results;expect(rows).toEqual([{id:root,space_id:'space.workspace',parent_id:null,notes:'Moved',entity_version:2},{id:child,space_id:'space.workspace',parent_id:root,notes:null,entity_version:3}]);const payload=await env.DB.prepare('SELECT payload_json FROM changes WHERE change_seq=?1').bind(moved.body.changeSeq).first<{payload_json:string}>();expect(JSON.parse(payload!.payload_json).tasks).toHaveLength(2);});
 it('project deletion atomically moves tasks to Inbox, retains tombstone and rejects resurrection',async()=>{const id='project.workspace';expect((await post(envelope('project.put',id,null,project('Release')))).status).toBe(201);const task='task.workspace.project';await post(envelope('task.createRich',task,null,rich(task,{projectId:id,workflowStatus:'next'})));expect((await post(envelope('project.delete',id,1,{}))).status).toBe(201);expect(await env.DB.prepare('SELECT project_id,workflow_status,entity_version FROM tasks WHERE id=?1').bind(task).first()).toEqual({project_id:null,workflow_status:'inbox',entity_version:2});expect((await post(envelope('project.put',id,null,project('Resurrect')))).body.error.code).toBe('entity_exists');});
 it('old readers cannot advance past workspace changes; negotiated feed/bootstrap have exact full records',async()=>{const legacy=await exports.default.fetch('https://personal-cloud.local/sync/changes?after=0&limit=50');expect(legacy.status).toBe(409);expect((await legacy.json() as any).error.code).toBe('upgrade_required');const read=await exports.default.fetch('https://personal-cloud.local/sync/changes?after=0&limit=50&workspace=1');expect(read.status).toBe(200);const feed=await read.json() as any;const change=feed.changes.find((c:any)=>c.operation==='workspace.changed');expect(Object.keys(change.payload).sort()).toEqual(['catalog','intents','projects','routes','scopes','spaces','tasks']);const boot=await exports.default.fetch('https://personal-cloud.local/sync/bootstrap?workspace=1');expect(boot.status).toBe(200);const b=await boot.json() as any;expect(b.snapshot.tasks.find((t:any)=>t.id==='task.workspace.fields')).toMatchObject({deadlineAt:null,scheduledStart:at,sourceOwnerDeviceId:null,labels:[]});expect(b.snapshot.projects.find((p:any)=>p.id==='project.workspace').deletedAt).toBeTruthy();expect((await exports.default.fetch('https://personal-cloud.local/sync/bootstrap')).status).toBe(409);});
 it('owned provider catalog and durable adopt request/start/result separate receipt from confirmation',async()=>{const device='device.workspace.bridge';await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic bridge','desktop',1,1,?2)").bind(device,at).run();let seq=1;const catalog='catalog.workspace';expect((await post(envelope('provider.scope.put','scope_workspace',null,{scope:{name:'Todoist',integrationKind:'todoist',available:true,labelNames:['Focus'],projectChoices:[]}},device,seq++))).status).toBe(201);const item={scopeId:'scope_workspace',source,isSkipped:false,available:true,adoptedTaskId:null,labelNames:['Focus'],projectChoices:[]};expect((await post(envelope('provider.catalog.put',catalog,null,{item},device,seq++))).status).toBe(201);expect((await post(envelope('provider.catalog.put',catalog,1,{item:{...item,source:{...source,refreshedAt:'2026-10-12T00:00:00.000Z'}}},device,seq))).body.error.code).toBe('invalid_transition');expect((await post(envelope('provider.catalog.put',catalog,1,{item}))).body.error.code).toBe('source_identity_conflict');const id='intent.workspace';expect((await post(envelope('provider.intent.request',id,null,{intent:{bridgeDeviceId:device,action:'adopt',catalogId:catalog,spaceId:'space_default',route:null}}))).status).toBe(201);const pending=await exports.default.fetch('https://personal-cloud.local/v1/provider/intents',{headers:{'x-openza-test-device':device}});expect((await pending.json() as any).intents[0]).toMatchObject({id,state:'pending_desktop',entityVersion:1});expect((await post(envelope('provider.intent.start',id,1,{},device,seq++))).status).toBe(201);expect((await post(envelope('provider.intent.resolve',id,2,{state:'confirmed',adoptedTaskId:'task.notyet',errorCode:null},device,seq))).body.error.code).toBe('source_identity_conflict');const task='task.workspace.adopt';expect((await post(envelope('task.createRich',task,null,{...rich(task),source},device,seq++))).status).toBe(201);expect((await post(envelope('provider.intent.resolve',id,2,{state:'confirmed',adoptedTaskId:task,errorCode:null},device,seq++))).status).toBe(201);expect((await post(envelope('provider.intent.start',id,3,{},device,seq))).body.error.code).toBe('invalid_transition');const read=await exports.default.fetch('https://personal-cloud.local/v1/provider/catalog');expect((await read.json() as any).catalog[0]).toMatchObject({id:catalog,adoptedTaskId:task,entityVersion:2});expect((await post(envelope('task.patch',task,1,{fields:{title:'Forbidden'}}))).body.error.code).toBe('invalid_request');});
});

it('rejects conflicting concurrent metadata versions and preserves both accepted sequence and prior values',async()=>{
 const id='space.concurrent';await post(envelope('space.put',id,null,space('Before')));
 const outcomes=await Promise.all(['First','Second'].map(name=>post(envelope('space.put',id,1,space(name)))));
 expect(outcomes.map(x=>x.status).sort()).toEqual([201,409]);
 expect(await env.DB.prepare('SELECT entity_version FROM spaces WHERE id=?1').bind(id).first()).toEqual({entity_version:2});
});
it('rolls tree mutation, claims, versions and receipt back together on a transaction failure',async()=>{
 const id='task.rollback.tree';await post(envelope('task.createRich',id,null,rich(id)));
 const m=envelope('task.moveTree',id,1,{spaceId:'space_default',fields:{notes:'Never persisted'}}),raw=JSON.stringify(m);
 await expect(applyWorkspaceMutation(env.DB,parseWorkspaceMutation(raw,env.INSTANCE_ID),raw,{failBeforeReceipt:true})).rejects.toThrow();
 expect(await env.DB.prepare('SELECT notes,entity_version FROM tasks WHERE id=?1').bind(id).first()).toEqual({notes:null,entity_version:1});
 expect(await env.DB.prepare('SELECT mutation_id FROM entity_version_claims WHERE mutation_id=?1').bind(m.mutationId).first()).toBeNull();
 expect((await post(m)).status).toBe(201);
});
it('last active Space cannot be archived, including serialized guard rejection',async()=>{
 const rows=(await env.DB.prepare('SELECT id,created_at,entity_version FROM spaces WHERE is_archived=0').all<any>()).results;
 for(const row of rows.slice(1))expect((await post(envelope('space.put',row.id,row.entity_version,{space:{...space('Archived',true).space,createdAt:row.created_at}}))).status).toBe(201);
 const row=rows[0];expect((await post(envelope('space.put',row.id,row.entity_version,{space:{...space('Last',true).space,createdAt:row.created_at}}))).body.error.code).toBe('invalid_transition');
});
it('strict rich create rejects null source, unsafe URLs, unknown fields and contradictory dates',()=>{
 const id='task.validation';for(const payload of [{...rich(id),source:null},{...rich(id),source:{...source,sourceUrl:'javascript:alert(1)'}},{...rich(id),source:{...source,sourceUrl:'https://user:password@example.com/task'}},rich(id,{unexpected:'secret'}),rich(id,{deadlineOn:'2026-10-13',deadlineAt:at})])expect(()=>parseWorkspaceMutation(JSON.stringify(envelope('task.createRich',id,null,payload)),env.INSTANCE_ID)).toThrow();
});
it('reconciles uncertain skip/restore and confirms/tombstones bridge-owned routing without guessing provider success',async()=>{
 const device='device.workspace.routes',catalogId='catalog.workspace.routes',item={scopeId:'scope_routes',source:{...source,externalIdHash:'c'.repeat(64)},isSkipped:false,available:true,adoptedTaskId:null,labelNames:['Focus'],projectChoices:[{id:'choice.opaque',name:'Provider project'}]};
 await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic routing','desktop',1,1,?2)").bind(device,at).run();let seq=1;
 expect((await post(envelope('provider.scope.put',item.scopeId,null,{scope:{name:'Routing',integrationKind:'todoist',available:true,labelNames:item.labelNames,projectChoices:item.projectChoices}},device,seq++))).status).toBe(201);
 expect((await post(envelope('provider.catalog.put',catalogId,null,{item},device,seq++))).status).toBe(201);
 const request=async(id:string,action:string,route:any=null)=>post(envelope('provider.intent.request',id,null,{intent:{bridgeDeviceId:device,action,catalogId:route?null:catalogId,spaceId:null,route}}));
 const id='intent.routes.skip';expect((await request(id,'skip')).status).toBe(201);expect((await request(id+'.duplicate','skip')).body.error.code).toBe('invalid_transition');
 expect((await post(envelope('provider.intent.start',id,1,{}))).body.error.code).toBe('source_identity_conflict');
 expect((await post(envelope('provider.intent.start',id,1,{},device,seq++))).status).toBe(201);
 expect((await post(envelope('provider.intent.resolve',id,2,{state:'uncertain',adoptedTaskId:null,errorCode:'delivery_uncertain'},device,seq++))).status).toBe(201);
 expect(JSON.parse((await env.DB.prepare('SELECT item_json FROM provider_catalog WHERE id=?1').bind(catalogId).first<any>()).item_json).isSkipped).toBe(false);
 expect((await post(envelope('provider.intent.resolve',id,3,{state:'confirmed',adoptedTaskId:null,errorCode:null},device,seq++))).status).toBe(201);
 const restore=id+'.restore';expect((await request(restore,'restore')).status).toBe(201);expect((await post(envelope('provider.intent.start',restore,1,{},device,seq++))).status).toBe(201);expect((await post(envelope('provider.intent.resolve',restore,2,{state:'confirmed',adoptedTaskId:null,errorCode:null},device,seq++))).status).toBe(201);
 const route={id:'route.workspace',scopeId:item.scopeId,label:'Focus',spaceId:'space_default',moveToProjectId:'choice.opaque'},put=id+'.route';expect((await request(put,'route.put',route)).status).toBe(201);expect(await env.DB.prepare('SELECT id FROM provider_routes WHERE id=?1').bind(route.id).first()).toBeNull();
 expect((await post(envelope('provider.intent.start',put,1,{},device,seq++))).status).toBe(201);expect((await post(envelope('provider.intent.resolve',put,2,{state:'confirmed',adoptedTaskId:null,errorCode:null},device,seq++))).status).toBe(201);
 const del=id+'.delete';expect((await request(del,'route.delete',route)).status).toBe(201);expect((await post(envelope('provider.intent.start',del,1,{},device,seq++))).status).toBe(201);expect((await post(envelope('provider.intent.resolve',del,2,{state:'confirmed',adoptedTaskId:null,errorCode:null},device,seq++))).status).toBe(201);
 const read=await exports.default.fetch('https://personal-cloud.local/v1/provider/catalog'),data=await read.json() as any;expect(data.routes.find((r:any)=>r.id===route.id)).toMatchObject({entityVersion:2,deletedAt:expect.any(String)});expect(data.intents.filter((i:any)=>i.route?.id===route.id)).toHaveLength(1);
});
it('completed projects remain assignable like Linux while archived projects cannot receive new tasks',async()=>{
 const id='project.completed';expect((await post(envelope('project.put',id,null,{project:{...project('Completed').project,status:'completed'}}))).status).toBe(201);
 expect((await post(envelope('task.createRich','task.completed.project',null,rich('task.completed.project',{projectId:id})))).status).toBe(201);
 expect((await post(envelope('project.put',id,1,{project:{...project('Archived').project,status:'archived'}}))).status).toBe(201);
 expect((await post(envelope('task.createRich','task.archived.project',null,rich('task.archived.project',{projectId:id})))).body.error.code).toBe('parent_not_found');
});
it('projects refreshed provider titles into Web reads and full workspace records without editing creation storage',async()=>{
 const id='task.workspace.title',device='device.title',descriptor={...source,externalIdHash:'e'.repeat(64)};
 await post(envelope('task.createRich',id,null,{...rich(id),source:descriptor},device,1));
 await post(envelope('source.refreshSnapshot',id,null,{source:{...descriptor,title:'Latest provider title',refreshedAt:'2026-10-14T00:00:00.000Z'}},device,2));
 const response=await exports.default.fetch('https://personal-cloud.local/v1/tasks',{headers:{'x-openza-test-session':env.K5_TEST_SESSION}}),data=await response.json() as any;
 expect(data.tasks.find((t:any)=>t.id===id).title).toBe('Latest provider title');
 await post(envelope('task.patch',id,1,{fields:{notes:'Overlay only'}}));
 const snapshot=await exports.default.fetch('https://personal-cloud.local/sync/bootstrap?workspace=1'),boot=await snapshot.json() as any;
 expect(boot.snapshot.tasks.find((t:any)=>t.id===id).title).toBe('Latest provider title');
 expect(await env.DB.prepare('SELECT title FROM tasks WHERE id=?1').bind(id).first()).toEqual({title:'Provider task'});
});
it('routes only within an owned Todoist connection, including zero-task cached projects and unavailable cleanup',async()=>{
 const bridge='device.scoped',scopeId='scope_zero_tasks';await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Scoped synthetic','desktop',1,1,?2)").bind(bridge,at).run();
 expect((await post(envelope('provider.scope.put',scopeId,null,scopePayload(),bridge,1))).status).toBe(201);
 expect((await post(envelope('provider.scope.put','scope_microsoft',null,scopePayload('microsoft-todo'),bridge,2))).status).toBe(201);
 const route={id:'route.zero',scopeId,label:'Unobserved typed label',spaceId:'space_default',moveToProjectId:'choice.scoped'};
 const request=(id:string,r:any,action='route.put',device=bridge)=>post(envelope('provider.intent.request',id,null,{intent:{bridgeDeviceId:device,action,catalogId:null,spaceId:null,route:r}}));
 expect((await request('intent.unscoped',{id:'route.old',label:null,spaceId:'space_default',moveToProjectId:null})).body.error.code).toBe('unsupported');
 expect((await request('intent.unknown',{...route,scopeId:'scope_missing'})).body.error.code).toBe('source_identity_conflict');
 expect((await request('intent.foreign',route,'route.put','device.workspace.bridge')).body.error.code).toBe('source_identity_conflict');
 expect((await request('intent.microsoft',{...route,scopeId:'scope_microsoft'})).body.error.code).toBe('unsupported');
 expect((await request('intent.project.foreign',{...route,moveToProjectId:'choice.other'})).body.error.code).toBe('parent_not_found');
 expect((await request('intent.zero',route)).status).toBe(201);
 expect((await post(envelope('provider.intent.start','intent.zero',1,{},bridge,3))).status).toBe(201);
 expect((await post(envelope('provider.intent.resolve','intent.zero',2,{state:'confirmed',adoptedTaskId:null,errorCode:null},bridge,4))).status).toBe(201);
 expect((await post(envelope('provider.scope.put',scopeId,1,scopePayload('todoist',false),bridge,5))).status).toBe(201);
 expect((await request('intent.unavailable',route)).body.error.code).toBe('invalid_transition');
 expect((await request('intent.cleanup',{...route,spaceId:'space.archived.synthetic'},'route.delete')).status).toBe(201);
 expect((await post(envelope('provider.intent.start','intent.cleanup',1,{},bridge,6))).status).toBe(201);
 expect((await post(envelope('provider.intent.resolve','intent.cleanup',2,{state:'confirmed',adoptedTaskId:null,errorCode:null},bridge,7))).status).toBe(201);
 const catalog=await (await exports.default.fetch('https://personal-cloud.local/v1/provider/catalog')).json() as any;expect(catalog.scopes.find((s:any)=>s.id===scopeId)).toMatchObject({bridgeDeviceId:bridge,available:false,projectChoices:scopePayload().scope.projectChoices,entityVersion:2});expect(catalog.catalog.some((c:any)=>c.scopeId===scopeId)).toBe(false);
 const boot=await (await exports.default.fetch('https://personal-cloud.local/sync/bootstrap?workspace=1')).json() as any;expect(boot.snapshot.scopes.find((s:any)=>s.id===scopeId)).toMatchObject({id:scopeId,integrationKind:'todoist'});
});
it('preserves old exact receipts and six-array history while refusing new unscoped publication',async()=>{
 // Static pre-capability-2 upgrade fixture; no live provider or device sequence is fabricated for acceptance.
 const bridge='device.legacy.fixture',id='catalog.legacy.fixture',item={source:{...source,externalIdHash:'b'.repeat(64)},isSkipped:false,available:true,adoptedTaskId:null,labelNames:[],projectChoices:[]},m=envelope('provider.catalog.put',id,null,{item},bridge,1),raw=JSON.stringify(m),canonical=canonicalize(raw),hash=await computeCanonicalHash(raw);
 const seq=(await env.DB.prepare('SELECT next_change_seq FROM cloud_state WHERE singleton=1').first<{next_change_seq:number}>())!.next_change_seq+1,payload={spaces:[],projects:[],tasks:[],catalog:[],intents:[],routes:[]};
 await env.DB.batch([
 env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Legacy fixture','desktop',1,1,?2)").bind(bridge,at),
 env.DB.prepare('INSERT INTO provider_catalog(id,bridge_device_id,integration_kind,external_id_hash,item_json,entity_version,refreshed_at,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,1,?6,?6,?6)').bind(id,bridge,source.integrationKind,item.source.externalIdHash,JSON.stringify(item),at),
 env.DB.prepare("INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at) VALUES(?1,1,'tasks',?2,'workspace.changed','workspace',?3,1,?4,?5)").bind(seq,m.mutationId,id,JSON.stringify(payload),at),
 env.DB.prepare("INSERT INTO mutation_receipts(mutation_id,protocol_version,product,canonical_request,canonical_hash,entity_id,entity_version,change_seq,server_accepted_at) VALUES(?1,1,'tasks',?2,?3,?4,1,?5,?6)").bind(m.mutationId,canonical,hash,id,seq,at),
 env.DB.prepare('UPDATE cloud_state SET next_change_seq=?1 WHERE singleton=1').bind(seq)]);
 expect((await post(m)).body.outcome).toBe('duplicate');expect((await post({...m,payload:{item:{...item,isSkipped:true}}})).body.error.code).toBe('mutation_id_reused');
 expect((await post(envelope('provider.catalog.put','catalog.new.unscoped',null,{item},bridge,1))).body.error.code).toBe('unsupported');
 const feed=await (await exports.default.fetch(`https://personal-cloud.local/sync/changes?after=${seq-1}&limit=50&workspace=1`)).json() as any;expect(feed.changes[0].payload.scopes).toEqual([]);
 expect(JSON.parse((await env.DB.prepare('SELECT payload_json FROM changes WHERE change_seq=?1').bind(seq).first<{payload_json:string}>())!.payload_json)).toEqual(payload);
 const data=await (await exports.default.fetch('https://personal-cloud.local/v1/provider/catalog')).json() as any;expect(data.catalog.find((c:any)=>c.id===id).scopeId).toBeNull();
});
it('recovers a purged rich source identity without borrowing the first descendant in a workspace tree change',async()=>{
 const device='device.history.rich',root='task.zzz.history.root',child='task.aaa.history.child',rootSource={...source,externalIdHash:'9'.repeat(64)},childSource={...source,externalIdHash:'8'.repeat(64)};let seq=1;
 expect((await post(envelope('task.createRich',root,null,{...rich(root),source:rootSource},device,seq++))).status).toBe(201);
 expect((await post(envelope('task.createRich',child,null,{...rich(child),source:childSource},device,seq++))).status).toBe(201);
 expect((await post(envelope('task.setParent',child,1,{parentId:root},device,seq++))).status).toBe(201);
 const moved=await post(envelope('task.moveTree',root,1,{spaceId:'space_default',fields:{}},device,seq++));expect(moved.status).toBe(201);
 const tree=JSON.parse((await env.DB.prepare('SELECT payload_json FROM changes WHERE change_seq=?1').bind(moved.body.changeSeq).first<{payload_json:string}>())!.payload_json);expect(tree.tasks[0].id).toBe(child);
 expect((await post(envelope('task.delete',child,3,{deletedAt:at},device,seq++))).status).toBe(201);
 expect((await post(envelope('task.delete',root,2,{deletedAt:at},device,seq++))).status).toBe(201);
 // Simulate retention compaction of the deleted child/root rows, preserving immutable history.
 await env.DB.batch([env.DB.prepare('DELETE FROM tasks WHERE id=?1').bind(child),env.DB.prepare('DELETE FROM tasks WHERE id=?1').bind(root)]);
 expect((await post(envelope('source.refreshSnapshot',root,null,{source:childSource},device,seq))).body.error.code).toBe('source_identity_conflict');
 const refresh=envelope('source.refreshSnapshot',root,null,{source:rootSource},device,seq++);expect((await post(refresh)).body).toMatchObject({outcome:'accepted',entityVersion:3});expect((await post(refresh)).body.outcome).toBe('duplicate');
 expect(await env.DB.prepare('SELECT id FROM tasks WHERE id=?1').bind(root).first()).toBeNull();
});
