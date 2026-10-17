import {ContractError} from './protocol.ts';
import {spaceJson,projectJson,taskJson,scopeJson,catalogJson,intentJson,routeJson} from './workspace-records.ts';

export const maximumSyncResponseBytes=2*1024*1024;
export const workspacePagingCapability={protocolVersion:1,bootstrapPath:'/sync/bootstrap',changesPath:'/sync/changes',maxResponseUtf8Bytes:maximumSyncResponseBytes,maxPageRecords:100} as const;
export const utf8Bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
export function oversizedResponse():never{throw new ContractError('response_too_large','A workspace record exceeds the sync page limit. The prior replica and checkpoint are preserved.');}

const sections=[
 ['spaces','spaces s','s.id',spaceJson],
 ['projects','projects p','p.id',projectJson],
 ['tasks','tasks t','t.id',taskJson],
 ['labels','labels l','l.id',"json_object('id',l.id,'name',l.name,'deletedAt',l.deleted_at)"],
 ['taskLabels','task_labels tl',"tl.task_id||char(31)||tl.label_id","json_object('taskId',tl.task_id,'labelId',tl.label_id)"],
 ['tombstones','tombstones ts','ts.entity_id',"json_object('entityKind',ts.entity_kind,'entityId',ts.entity_id,'entityVersion',ts.entity_version,'deletedAt',ts.deleted_at,'purgeAfter',ts.purge_after)"],
 ['sourceDescriptors','source_descriptors sd','sd.task_id',"json_object('taskId',sd.task_id,'integrationKind',sd.integration_kind,'externalIdHash',sd.external_id_hash,'sourceUrl',sd.source_url,'title',sd.source_title,'description',sd.source_description,'projectName',sd.source_project_name,'priority',sd.source_priority,'plannedOn',sd.source_planned_on,'plannedAt',sd.source_planned_at,'deadlineOn',sd.source_deadline_on,'deadlineAt',sd.source_deadline_at,'recurrenceRule',sd.recurrence_rule,'refreshedAt',sd.refreshed_at)"],
 ['externalCommands','external_commands ec','ec.task_id',"json_object('taskId',ec.task_id,'command',ec.command,'state',ec.state,'requestedChangeSeq',ec.requested_change_seq,'updatedAt',ec.updated_at,'errorCode',ec.error_code)"],
 ['scopes','provider_scopes sc','sc.id',scopeJson],
 ['catalog','provider_catalog c','c.id',catalogJson],
 ['intents','provider_intents i','i.id',intentJson],
 ['routes','provider_routes r','r.id',routeJson],
] as const;
type Cursor={version:1;instance:string;actor:string;checkpoint:number;section:number;after:string;expires:number};
const encoder=new TextEncoder();
const toBase64=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const fromBase64=(text:string)=>{if(!/^[A-Za-z0-9_-]+$/.test(text))throw Error();return Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));};
async function cursorKey(db:D1Database){const row=await db.prepare('SELECT key_hex FROM workspace_cursor_key WHERE singleton=1').first<{key_hex:string}>();if(!row||!/^[a-f0-9]{64}$/.test(row.key_hex))throw Error('Workspace cursor key unavailable.');return crypto.subtle.importKey('raw',Uint8Array.from(row.key_hex.match(/../g)!,b=>parseInt(b,16)),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
async function encodeCursor(value:Cursor,key:CryptoKey){const bytes=encoder.encode(JSON.stringify(value));return `${toBase64(bytes)}.${toBase64(new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes)))}`;}
async function decodeCursor(raw:string,key:CryptoKey,instance:string,actor:string):Promise<Cursor>{
 try{if(raw.length>2048)throw Error();const parts=raw.split('.');if(parts.length!==2)throw Error();const bytes=fromBase64(parts[0]);if(!await crypto.subtle.verify('HMAC',key,fromBase64(parts[1]),bytes))throw Error();const c=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));if(!c||Object.keys(c).sort().join(',')!=='actor,after,checkpoint,expires,instance,section,version'||c.version!==1||c.instance!==instance||c.actor!==actor||!Number.isSafeInteger(c.checkpoint)||c.checkpoint<0||!Number.isInteger(c.section)||c.section<0||c.section>=sections.length||typeof c.after!=='string'||c.after.length>257||!Number.isSafeInteger(c.expires)||c.expires<=Date.now())throw Error();return c;}catch{throw new ContractError('invalid_request','The workspace bootstrap cursor is invalid or expired. Restart the baseline.');}
}
export async function bootstrapPage(db:D1Database,instance:string,actor:string,rawCursor:string|null){
 const key=await cursorKey(db),cursor=rawCursor===null?null:await decodeCursor(rawCursor,key,instance,actor),section=cursor?.section??0,[name,table,id,record]=sections[section];
 // The composite relationship key uses its primary-key pair for indexed seeking.
 let where=`${id}>?1`,order:string=id,values:unknown[]=[cursor?.after??''];
 if(name==='taskLabels'){const [task='',label='']=(cursor?.after??'').split('\u001f');where='(tl.task_id,tl.label_id)>(?1,?2)';order='tl.task_id,tl.label_id';values=[task,label];}
 if(name==='intents')where+=` AND NOT EXISTS(SELECT 1 FROM provider_intents n WHERE n.target_key=i.target_key AND (n.created_at>i.created_at OR (n.created_at=i.created_at AND n.rowid>i.rowid)))`;
 const results=await db.batch([db.prepare('SELECT next_change_seq FROM cloud_state WHERE singleton=1'),db.prepare(`SELECT ${id} AS cursor_key,${record} AS record FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT 101`).bind(...values)]),checkpoint=(results[0].results[0] as {next_change_seq:number}).next_change_seq;
 if(cursor&&cursor.checkpoint!==checkpoint)throw new ContractError('bootstrap_changed','The cloud changed during the baseline. Discard staged pages and restart.');
 const state:Cursor=cursor??{version:1,instance,actor,checkpoint,section:0,after:'',expires:Date.now()+10*60_000},rows=results[1].results as {cursor_key:string;record:string}[],snapshot=Object.fromEntries(sections.map(([name])=>[name,[] as unknown[]]));
 const page={protocolVersion:1 as const,product:'tasks' as const,checkpoint,snapshot,hasMore:true,nextCursor:null as string|null};
 // Reserve the largest cursor, then account for every serialized record including commas.
 const reserve=await encodeCursor({...state,after:'x'.repeat(262)},key),baseBytes=utf8Bytes({...page,nextCursor:reserve});let used=baseBytes,taken=0;
 for(const row of rows.slice(0,100)){const value=JSON.parse(row.record),bytes=utf8Bytes(value)+(taken?1:0);if(used+bytes>maximumSyncResponseBytes){if(!taken)oversizedResponse();break;}snapshot[name].push(value);used+=bytes;taken++;}
 const moreInSection=rows.length>taken,nextSection=moreInSection?section:section+1;
 page.hasMore=nextSection<sections.length;page.nextCursor=page.hasMore?await encodeCursor({...state,section:nextSection,after:moreInSection?rows[taken-1].cursor_key:''},key):null;
 if(utf8Bytes(page)>maximumSyncResponseBytes)oversizedResponse();return page;
}
