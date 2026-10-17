import {env} from 'cloudflare:workers';
import {it,expect} from 'vitest';
import worker,{type Env} from '../src/index.ts';
import {hash} from '../src/auth.ts';
const at=new Date().toISOString(),expires=new Date(Date.now()+600000).toISOString();
it('enforces real owner CSRF, bridge capability, actor identity, revocation and private catalog reads',async()=>{
 const device='device.workspace.auth',token='synthetic-workspace-access',session='synthetic-workspace-session',csrf='synthetic-workspace-csrf';
 await env.DB.batch([
 env.DB.prepare("INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic','desktop',1,0,?2)").bind(device,at),
 env.DB.prepare('INSERT INTO device_access_tokens(token_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)').bind(await hash(token),device,at,expires),
 env.DB.prepare("INSERT INTO owner_credentials(credential_id,display_name,public_key_jwk,created_at) VALUES('workspace-owner','Synthetic','{}',?1)").bind(at),
 env.DB.prepare("INSERT INTO web_sessions(session_hash,credential_id,csrf_hash,created_at,rotated_at,expires_at,absolute_expires_at) VALUES(?1,'workspace-owner',?2,?3,?3,?4,?4)").bind(await hash(session),await hash(csrf),at,expires)]);
 const m={protocolVersion:1,product:'tasks',instanceId:env.INSTANCE_ID,deviceId:device,mutationId:'mutation.workspace.auth',deviceSequence:1,operation:'space.put',entityId:'space.auth',baseEntityVersion:null,payload:{space:{name:'Auth',color:null,icon:null,sortOrder:0,isArchived:false,createdAt:at}},clientCreatedAt:at};
 const send=(headers:HeadersInit={},body:any=m,path='/v1/tasks/mutations',method='POST')=>worker.fetch(new Request('https://personal-cloud.local'+path,{method,headers,body:method==='GET'?undefined:JSON.stringify(body)}),{...env,TEST_MODE:undefined} as unknown as Env);
 const owner={cookie:`__Host-openza_session=${session}`,origin:'https://personal-cloud.local','x-openza-csrf':csrf},bearer={authorization:`Bearer ${token}`};
 expect((await send()).status).toBe(401);
 expect((await send({...owner,'x-openza-csrf':'wrong'})).status).toBe(403);
 expect((await send({...owner,origin:'https://untrusted.local'})).status).toBe(403);
 expect((await send(owner)).status).toBe(201);
 expect((await send(bearer,{...m,deviceId:'forged',mutationId:'mutation.forged',entityId:'space.forged'})).status).toBe(401);
 const catalog={...m,operation:'provider.catalog.put',entityId:'catalog.auth',mutationId:'mutation.catalog.auth',payload:{item:{source:{integrationKind:'todoist',externalIdHash:'a'.repeat(64),sourceUrl:null,title:'Safe',description:null,projectName:null,priority:2,plannedOn:null,plannedAt:null,deadlineOn:null,deadlineAt:null,recurrenceRule:null,refreshedAt:at},available:true,isSkipped:false,adoptedTaskId:null,labelNames:[],projectChoices:[]}}};
 expect((await send(owner,catalog)).status).toBe(401);expect((await send(bearer,catalog)).status).toBe(401);
 const scope={...m,operation:'provider.scope.put',entityId:'scope_auth',mutationId:'mutation.scope.auth',deviceSequence:2,payload:{scope:{name:'Todoist',integrationKind:'todoist',available:true,labelNames:[],projectChoices:[]}}};
 expect((await send(owner,scope)).status).toBe(401);expect((await send(bearer,scope)).status).toBe(401);
 await env.DB.prepare('UPDATE devices SET can_bridge_provider=1 WHERE device_id=?1').bind(device).run();
 expect((await send(bearer,scope)).status).toBe(201);
 expect((await send(bearer,{...catalog,deviceSequence:3,payload:{item:{...catalog.payload.item,scopeId:'scope_auth'}}})).status).toBe(201);
 expect((await send({},null,'/v1/provider/catalog','GET')).status).toBe(401);
 expect((await send(bearer,null,'/v1/provider/catalog','GET')).status).toBe(401);
 expect((await send(owner,null,'/v1/provider/catalog','GET')).status).toBe(200);
 await env.DB.prepare('UPDATE devices SET revoked_at=?1 WHERE device_id=?2').bind(at,device).run();
 expect((await send(bearer,{...m,deviceSequence:2,mutationId:'mutation.revoked',entityId:'space.revoked'})).status).toBe(401);
});

it('authenticates every bootstrap page and binds its cursor to the paired device across token rotation',async()=>{
 const a='device.paging.auth.a',b='device.paging.auth.b',ta='synthetic-paging-access-a',tb='synthetic-paging-access-b',rotated='synthetic-paging-rotated';
 for(const [device,token] of [[a,ta],[b,tb],[a,rotated]]){
  await env.DB.prepare("INSERT OR IGNORE INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at) VALUES(?1,'Synthetic','desktop',1,0,?2)").bind(device,at).run();
  await env.DB.prepare('INSERT INTO device_access_tokens(token_hash,device_id,created_at,expires_at) VALUES(?1,?2,?3,?4)').bind(await hash(token),device,at,expires).run();
 }
 const read=(token:string|null,cursor?:string)=>worker.fetch(new Request('https://personal-cloud.local/sync/bootstrap?workspace=1&paged=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''),{headers:token?{authorization:`Bearer ${token}`}:{}}),{...env,TEST_MODE:undefined} as unknown as Env);
 expect((await read(null)).status).toBe(401);
 const first=await read(ta),body=await first.json() as any;expect(first.status).toBe(200);expect(typeof body.nextCursor).toBe('string');
 expect((await read(tb,body.nextCursor)).status).toBe(400);expect((await read(rotated,body.nextCursor)).status).toBe(200);
 await env.DB.prepare('UPDATE devices SET revoked_at=?1 WHERE device_id=?2').bind(at,a).run();expect((await read(ta,body.nextCursor)).status).toBe(401);
});
