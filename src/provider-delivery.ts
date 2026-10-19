import {throwDailyQuota} from "./daily-quota.ts";
import { ContractError, parseStrictJson } from "./protocol.ts";

export type DeliveryClaim = {
  claimId:string; taskId:string; requestedChangeSeq:number; deviceId:string;
  command:"complete"|"reopen"; integrationKind:string; externalIdHash:string;
  state:"reserved"|"started"|"resolved"|"cancelled";
};
const projection=`claim_id AS claimId,task_id AS taskId,requested_change_seq AS requestedChangeSeq,
  device_id AS deviceId,command,integration_kind AS integrationKind,external_id_hash AS externalIdHash,state`;

export function parseDeliveryRequest(raw:string, instanceId:string, actor:string, claim:boolean) {
  const body=object(raw,claim?["protocolVersion","product","instanceId","deviceId","claimId","taskId","requestedChangeSeq","integrationKind","externalIdHash"]:
    ["protocolVersion","product","instanceId","deviceId","claimId"]);
  if(body.protocolVersion!==1||body.product!=="tasks")throw new ContractError("invalid_request","Invalid delivery protocol.");
  if(body.instanceId!==instanceId)throw new ContractError("instance_mismatch","The delivery targets another cloud.");
  if(body.deviceId!==actor)throw new ContractError("unauthorized","The delivery device does not match its access.");
  identifier(body.claimId);
  if(claim){identifier(body.taskId);if(!Number.isSafeInteger(body.requestedChangeSeq)||(body.requestedChangeSeq as number)<=0)
    throw new ContractError("invalid_request","Invalid requested change sequence.");
    if(typeof body.integrationKind!=="string"||body.integrationKind.length<1||body.integrationKind.length>64||
      typeof body.externalIdHash!=="string"||!/^[a-f0-9]{64}$/.test(body.externalIdHash))
      throw new ContractError("invalid_request","Invalid safe source binding.");}
  return body as unknown as DeliveryClaim;
}

export async function claimDelivery(db:D1Database, request:DeliveryClaim):Promise<DeliveryClaim> {
  const prior=await findClaim(db,request.claimId);
  if(prior){requireSame(prior,request);return prior;}
  const current=await db.prepare(`SELECT c.command,s.integration_kind AS integrationKind,s.external_id_hash AS externalIdHash
    FROM external_commands c JOIN tasks t ON t.id=c.task_id JOIN source_descriptors s ON s.task_id=t.id
    WHERE c.task_id=?1 AND c.requested_change_seq=?2 AND c.state='pending_desktop' AND t.deleted_at IS NULL`)
    .bind(request.taskId,request.requestedChangeSeq).first<{command:string;integrationKind:string;externalIdHash:string}>();
  if(!current)throw new ContractError("command_superseded","The provider request is no longer pending.");
  if(current.integrationKind!==request.integrationKind||current.externalIdHash!==request.externalIdHash)
    throw new ContractError("source_identity_conflict","The configured provider does not match this task.");
  const now=new Date().toISOString();
  try {await db.batch([
    // Only reservations which never started may be superseded automatically.
    db.prepare(`UPDATE provider_delivery_claims SET state='cancelled',resolved_at=?1
      WHERE task_id=?2 AND state='reserved' AND requested_change_seq<>?3
      AND EXISTS(SELECT 1 FROM external_commands WHERE task_id=?2 AND requested_change_seq=?3)`)
      .bind(now,request.taskId,request.requestedChangeSeq),
    db.prepare(`INSERT INTO provider_delivery_claims(claim_id,task_id,requested_change_seq,device_id,command,
      integration_kind,external_id_hash,state,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'reserved',?8)`)
      .bind(request.claimId,request.taskId,request.requestedChangeSeq,request.deviceId,current.command,
        request.integrationKind,request.externalIdHash,now),
  ]);}catch(error){throwDailyQuota(error);const raced=await findClaim(db,request.claimId);if(raced){requireSame(raced,request);return raced;}
    if(String(error).includes("provider source ambiguous"))throw new ContractError("source_identity_conflict","Multiple live Openza tasks link to this provider source.");
    if(String(error).includes("provider delivery superseded"))throw new ContractError("command_superseded","The provider request changed before it was claimed.");
    if(await db.prepare(`SELECT 1 FROM provider_delivery_claims WHERE
      (task_id=?1 OR (integration_kind=?2 AND external_id_hash=?3)) AND state IN ('reserved','started')`)
      .bind(request.taskId,request.integrationKind,request.externalIdHash).first())
      throw new ContractError("delivery_busy","Another delivery attempt owns this task or provider source.");
    throw error;}
  return (await findClaim(db,request.claimId))!;
}

export async function startDelivery(db:D1Database,claimId:string,deviceId:string):Promise<DeliveryClaim> {
  const claim=await ownedClaim(db,claimId,deviceId);
  if(claim.state!=="reserved")return claim;
  try {await db.prepare(`UPDATE provider_delivery_claims SET state='started',started_at=?1 WHERE claim_id=?2 AND state='reserved'`)
    .bind(new Date().toISOString(),claimId).run();}
  catch(error){throwDailyQuota(error);const ambiguous=String(error).includes("provider source ambiguous");
    if(!ambiguous&&!String(error).includes("provider delivery superseded"))throw error;
    await db.prepare(`UPDATE provider_delivery_claims SET state='cancelled',resolved_at=?1 WHERE claim_id=?2 AND state='reserved'`)
      .bind(new Date().toISOString(),claimId).run();
    if(ambiguous)throw new ContractError("source_identity_conflict","Multiple live Openza tasks link to this provider source.");
    throw new ContractError("command_superseded","The provider intent changed before dispatch.");}
  return (await findClaim(db,claimId))!;
}

export async function ownedClaim(db:D1Database,claimId:string,deviceId:string) {
  const claim=await findClaim(db,claimId);
  if(!claim||claim.deviceId!==deviceId)throw new ContractError("unauthorized","This device does not own the delivery.");
  return claim;
}

export async function listDeliveries(db:D1Database,cursor:string|null=null) {
  if(cursor!==null)identifier(cursor);
  const rows=(await db.prepare(`SELECT p.claim_id AS claimId,p.task_id AS taskId,t.title,p.device_id AS deviceId,
    d.display_name AS deviceName,d.revoked_at AS deviceRevokedAt,p.state,p.command,
    p.requested_change_seq AS requestedChangeSeq,p.created_at AS createdAt
    FROM provider_delivery_claims p JOIN tasks t ON t.id=p.task_id JOIN devices d ON d.device_id=p.device_id
    WHERE p.state IN ('reserved','started') AND (?1 IS NULL OR p.claim_id>?1) ORDER BY p.claim_id LIMIT 101`).bind(cursor).all<{claimId:string}>()).results;
  return {deliveries:rows.slice(0,100),hasMore:rows.length>100,nextCursor:rows.length>100?rows[99].claimId:null};
}

export async function reconcileDelivery(db:D1Database,raw:string) {
  const body=object(raw,["claimId","deliveryHostStopped","providerStateChecked"]);identifier(body.claimId);
  if(body.deliveryHostStopped!==true||body.providerStateChecked!==true)
    throw new ContractError("invalid_request","Stop the delivery host and check provider state before reconciliation.");
  const claim=await findClaim(db,body.claimId as string);
  if(!claim)throw new ContractError("command_not_found","Delivery attempt not found.");
  const result=await db.prepare(`UPDATE provider_delivery_claims SET state='resolved',resolution='owner_reconciled',resolved_at=?1
    WHERE claim_id=?2 AND state IN ('reserved','started') AND EXISTS(
      SELECT 1 FROM devices WHERE device_id=provider_delivery_claims.device_id AND revoked_at IS NOT NULL)`)
    .bind(new Date().toISOString(),body.claimId).run();
  if(!result.meta.changes&&claim.state!=="resolved"&&claim.state!=="cancelled")
    throw new ContractError("invalid_transition","Revoke the old desktop before reconciling delivery.");
  return {protocolVersion:1,claimId:body.claimId,outcome:"reconciled"};
}

export function parseRetryRequest(raw:string,instanceId:string,actor:string){
  const body=object(raw,["protocolVersion","product","instanceId","deviceId","retryId","taskId","requestedChangeSeq","integrationKind","externalIdHash"]);
  const {retryId,...rest}=body;
  return parseDeliveryRequest(JSON.stringify({...rest,claimId:retryId}),instanceId,actor,true);
}

export async function retryDelivery(db:D1Database,request:DeliveryClaim){
  type Row={taskId:string;requestedChangeSeq:number;newChangeSeq:number;deviceId:string;integrationKind:string;externalIdHash:string};
  const find=()=>db.prepare(`SELECT task_id AS taskId,requested_change_seq AS requestedChangeSeq,new_change_seq AS newChangeSeq,
    device_id AS deviceId,integration_kind AS integrationKind,external_id_hash AS externalIdHash
    FROM provider_command_retries WHERE retry_id=?1`).bind(request.claimId).first<Row>();
  const respond=(row:Row)=>{requireSame(row,request);return{retryId:request.claimId,taskId:row.taskId,requestedChangeSeq:row.newChangeSeq};};
  const existing=await find();if(existing)return respond(existing);
  const now=new Date().toISOString(),mutationId=`retry_${crypto.randomUUID().replaceAll("-","")}`;
  try{await db.batch([
    db.prepare(`INSERT INTO provider_command_retries(retry_id,task_id,requested_change_seq,device_id,integration_kind,external_id_hash,created_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7)`).bind(request.claimId,request.taskId,request.requestedChangeSeq,request.deviceId,request.integrationKind,request.externalIdHash,now),
    db.prepare(`INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at)
      SELECT cs.next_change_seq+1,1,'tasks',?1,'task.updatedOpenzaFields','task',t.id,t.entity_version,
        json_object('task',json_object('id',t.id,'externalCommand',json_object('command',c.command,'state','pending_desktop',
          'requestedChangeSeq',cs.next_change_seq+1,'errorCode',NULL))),?3
      FROM cloud_state cs JOIN tasks t ON t.id=?2 JOIN external_commands c ON c.task_id=t.id WHERE cs.singleton=1`)
      .bind(mutationId,request.taskId,now),
    db.prepare(`UPDATE external_commands SET state='pending_desktop',error_code=NULL,updated_at=?1,
      requested_change_seq=(SELECT change_seq FROM changes WHERE mutation_id=?2) WHERE task_id=?3`)
      .bind(now,mutationId,request.taskId),
    db.prepare(`UPDATE provider_command_retries SET new_change_seq=(SELECT change_seq FROM changes WHERE mutation_id=?1) WHERE retry_id=?2`)
      .bind(mutationId,request.claimId),
    db.prepare(`UPDATE cloud_state SET next_change_seq=(SELECT change_seq FROM changes WHERE mutation_id=?1) WHERE singleton=1`).bind(mutationId),
  ]);}catch(error){throwDailyQuota(error);const raced=await find();if(raced)return respond(raced);
    if(String(error).includes("provider retry superseded"))throw new ContractError("command_superseded","Only the current rejected provider request can be retried.");
    throw error;}
  return respond((await find())!);
}

function findClaim(db:D1Database,id:string){return db.prepare(`SELECT ${projection} FROM provider_delivery_claims WHERE claim_id=?1`).bind(id).first<DeliveryClaim>();}
type DeliveryIdentity=Pick<DeliveryClaim,"taskId"|"requestedChangeSeq"|"deviceId"|"integrationKind"|"externalIdHash">;
function requireSame(prior:DeliveryIdentity,request:DeliveryIdentity){if((["taskId","requestedChangeSeq","deviceId","integrationKind","externalIdHash"] as const).some(key=>prior[key]!==request[key]))
  throw new ContractError("mutation_id_reused","A delivery claim identifier was reused for another request.");}
function identifier(value:unknown){if(typeof value!=="string"||!/^[A-Za-z0-9_.:-]{1,128}$/.test(value))throw new ContractError("invalid_request","Invalid delivery identifier.");}
function object(raw:string,keys:string[]){const value=parseStrictJson(raw);if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.sort().join(","))
  throw new ContractError("invalid_request","Unexpected delivery request fields.");return value;}
