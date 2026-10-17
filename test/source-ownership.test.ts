import {env} from 'cloudflare:workers';
import {it,expect} from 'vitest';
import {applyWorkspaceMutation} from '../src/workspace-mutations.ts';
import {applyTaskCreate} from '../src/task-create.ts';
import {parseWorkspaceMutation} from '../src/workspace-protocol.ts';
import {parseTaskMutation} from '../src/protocol.ts';

const at='2026-10-15T00:00:00.000Z';let number=0;
const source=(hash:string)=>({integrationKind:'todoist',externalIdHash:hash.repeat(64),sourceUrl:null,title:'Synthetic source',description:null,projectName:null,priority:2,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,recurrenceRule:null,refreshedAt:at});
function mutation(operation:string,id:string,device:string,sequence:number,payload:any){return {protocolVersion:1,product:'tasks',instanceId:env.INSTANCE_ID,deviceId:device,mutationId:`mutation.owner.${++number}`,deviceSequence:sequence,operation,entityId:id,baseEntityVersion:null,clientCreatedAt:at,payload};}
function rich(id:string,s:any){return {task:{id,spaceId:'space_default',title:'Synthetic',workflowStatus:'inbox',priority:3,createdAt:at,notes:null,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,scheduledStart:null,scheduledEnd:null,durationMinutes:null,recurrenceRule:null,projectId:null,labels:[]},source:s};}
function legacy(id:string,s:any){return {task:{id,spaceId:'space_default',title:'Synthetic',completionState:'open',workflowStatus:'inbox',createdAt:at},source:s};}
async function apply(m:any,db=env.DB){const raw=JSON.stringify(m);return m.operation==='task.create'?applyTaskCreate(db,parseTaskMutation(raw,env.INSTANCE_ID) as any,raw):applyWorkspaceMutation(db,parseWorkspaceMutation(raw,env.INSTANCE_ID),raw);}
async function bridge(device:string){await env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic','desktop',1,1,?2)").bind(device,at).run();await apply(mutation('provider.scope.put',`scope.${device}`,device,1,{scope:{name:'Synthetic',integrationKind:'todoist',available:true,labelNames:[],projectChoices:[]}}));}
function catalog(device:string,s:any,seq=2){return mutation('provider.catalog.put',`catalog.${device}.${number}`,device,seq,{item:{scopeId:`scope.${device}`,source:s,isSkipped:false,available:true,adoptedTaskId:null,labelNames:[],projectChoices:[]}});}

it('rejects foreign unadopted catalog publication without burning sequence; rightful owner can publish',async()=>{
 const a='device.owner.a',b='device.owner.b',s=source('1');await bridge(a);await bridge(b);
 await apply(mutation('task.createRich','task.owner.a',a,2,rich('task.owner.a',s)));
 const bad=catalog(b,s);await expect(apply(bad)).rejects.toMatchObject({code:'source_identity_conflict'});
 expect(await env.DB.prepare('SELECT mutation_id FROM mutation_receipts WHERE mutation_id=?1').bind(bad.mutationId).first()).toBeNull();
 expect(await env.DB.prepare('SELECT last_sequence FROM device_sequences WHERE device_id=?1').bind(b).first()).toEqual({last_sequence:1});
 await expect(apply(catalog(a,s,3))).resolves.toMatchObject({outcome:'accepted'});
});
for(const operation of ['task.create','task.createRich'])it(`rejects foreign ${operation} after catalog publication and permits own source`,async()=>{
 const suffix=operation==='task.create'?'legacy':'rich',a=`device.owner.${suffix}.a`,b=`device.owner.${suffix}.b`,s=source(operation==='task.create'?'2':'3');await bridge(a);await bridge(b);await apply(catalog(a,s));
 const id=`task.owner.${suffix}`,payload=operation==='task.create'?legacy(id,s):rich(id,s);
 await expect(apply(mutation(operation,id,b,2,payload))).rejects.toMatchObject({code:'source_identity_conflict'});
 await expect(apply(mutation(operation,id,a,3,payload))).resolves.toMatchObject({outcome:'accepted'});
});
it('does not grant a source whose imported live task owner is unknown',async()=>{
 const a='device.owner.unknown',s=source('4');await bridge(a);await apply(mutation('task.createRich','task.owner.unknown',a,2,rich('task.owner.unknown',s)));await env.DB.prepare('UPDATE tasks SET source_owner_device_id=NULL WHERE id=?1').bind('task.owner.unknown').run();
 await expect(apply(catalog(a,s,3))).rejects.toMatchObject({code:'source_identity_conflict'});
});
for(const operation of ['task.create','task.createRich'])it(`atomically prevents split bridge ownership when catalog races ${operation}`,async()=>{
 const suffix=operation==='task.create'?'legacy':'rich',a=`device.race.${suffix}.a`,b=`device.race.${suffix}.b`,s=source(operation==='task.create'?'5':'6');await bridge(a);await bridge(b);
 let arrived=0,release!:()=>void;const barrier=new Promise<void>(resolve=>release=resolve);
 const db=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(++arrived===2)release();await barrier;return target.batch(statements)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
 const id=`task.race.${suffix}`,m=mutation(operation,id,b,2,operation==='task.create'?legacy(id,s):rich(id,s));
 const outcomes=await Promise.allSettled([apply(catalog(a,s),db),apply(m,db)]);expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const task=await env.DB.prepare('SELECT source_owner_device_id AS owner FROM tasks WHERE id=?1').bind(id).first<{owner:string}>(),entry=await env.DB.prepare('SELECT bridge_device_id AS owner FROM provider_catalog WHERE integration_kind=?1 AND external_id_hash=?2').bind(s.integrationKind,s.externalIdHash).first<{owner:string}>();
 expect(Boolean(task)!==Boolean(entry)).toBe(true);
 const loser=task?a:b;expect(await env.DB.prepare('SELECT last_sequence FROM device_sequences WHERE device_id=?1').bind(loser).first()).toEqual({last_sequence:1});
});
