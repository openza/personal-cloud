import {ContractError,parseStrictJson,parseTaskMutation,canonicalize,computeCanonicalHash} from './protocol.ts';
import {findReceipt,duplicateOrReuse} from './mutation-receipt.ts';
import {throwDailyQuota} from './daily-quota.ts';
export const webPendingRecoveryCapability={protocolVersion:1,path:'/auth/web-pending-change'} as const;
type Identity={mutationId:string;deviceId:string;deviceSequence:number};
type Resolution={mutation_id:string;device_id:string;device_sequence:number;canonical_hash:string;cancelled_at:string};
export async function findWebResolution(db:D1Database,id:Identity,hash:string){
 const row=await db.prepare('SELECT mutation_id,device_id,device_sequence,canonical_hash,cancelled_at FROM web_pending_resolutions WHERE mutation_id=?1').bind(id.mutationId).first<Resolution>();
 if(row&&(row.canonical_hash!==hash||row.device_id!==id.deviceId||row.device_sequence!==id.deviceSequence))throw new ContractError('mutation_id_reused','The mutation ID was already used for different content.');
 return row;
}
export async function assertWebNotCancelled(db:D1Database,id:Identity,hash:string){
 if(await findWebResolution(db,id,hash))throw new ContractError('web_pending_cancelled','This exact unfinished Web change was explicitly cancelled and retained as a browser draft. Check its resolution before sending later changes.');
}
export async function recoverWebPending(db:D1Database,instance:string,raw:string){
 const value=parseStrictJson(raw);
 if(!value||typeof value!=='object'||Array.isArray(value)||value.protocolVersion!==1||!['check','cancel'].includes(String(value.action))||Object.keys(value).sort().join(',')!==(Object.hasOwn(value,'canonicalHash')?'action,canonicalHash,mutation,protocolVersion':'action,mutation,protocolVersion'))throw new ContractError('invalid_request','Invalid unfinished Web change request.');
 const body=JSON.stringify(value.mutation),m=parseTaskMutation(body,instance);
 if(!['project.delete','task.moveTree'].includes(m.operation)||!/^web_[A-Za-z0-9_.:-]+$/.test(m.deviceId)||await db.prepare('SELECT device_id FROM devices WHERE device_id=?1').bind(m.deviceId).first())throw new ContractError('invalid_request','Recovery is limited to an exact Web bulk change.');
 const hash=await computeCanonicalHash(body);
 if((value.action==='cancel'||Object.hasOwn(value,'canonicalHash'))&&(typeof value.canonicalHash!=='string'||value.canonicalHash!==hash))throw new ContractError('invalid_request','The unfinished change hash did not match.');
 const identity={protocolVersion:1,canonicalHash:hash,mutationId:m.mutationId,deviceId:m.deviceId,deviceSequence:m.deviceSequence};
 async function terminal(){
  const receipt=await findReceipt(db,m.mutationId);
  if(receipt)return{...identity,state:'applied',canCancel:false,receipt:duplicateOrReuse(receipt,hash)};
  const cancelled=await findWebResolution(db,m,hash);
  return cancelled?{...identity,state:'cancelled',canCancel:false,cancelledAt:cancelled.cancelled_at}:null;
 }
 const resolved=await terminal();if(resolved)return resolved;
 const last=(await db.prepare('SELECT last_sequence FROM device_sequences WHERE device_id=?1').bind(m.deviceId).first<number>('last_sequence'))??0;
 if(last!==m.deviceSequence-1||m.deviceSequence===Number.MAX_SAFE_INTEGER)return{...identity,state:'unknown',canCancel:false};
 if(value.action==='check')return{...identity,state:'unapplied',canCancel:true};
 const at=new Date().toISOString();
 try{
  await db.batch([
   db.prepare('INSERT INTO device_sequence_claims(device_id,device_sequence,mutation_id) VALUES(?1,?2,?3)').bind(m.deviceId,m.deviceSequence,m.mutationId),
   db.prepare(`INSERT INTO workspace_guards(id,valid) SELECT ?1,CASE WHEN coalesce((SELECT last_sequence FROM device_sequences WHERE device_id=?2),0)=?3-1 AND NOT EXISTS(SELECT 1 FROM mutation_receipts WHERE mutation_id=?4) THEN 1 ELSE 0 END`).bind(m.mutationId+':cancel-next',m.deviceId,m.deviceSequence,m.mutationId),
   db.prepare('INSERT INTO web_pending_resolutions(mutation_id,device_id,device_sequence,canonical_hash,canonical_request,cancelled_at) VALUES(?1,?2,?3,?4,?5,?6)').bind(m.mutationId,m.deviceId,m.deviceSequence,hash,canonicalize(body),at),
   db.prepare('INSERT INTO device_sequences(device_id,last_sequence) VALUES(?1,?2) ON CONFLICT(device_id) DO UPDATE SET last_sequence=excluded.last_sequence WHERE device_sequences.last_sequence=excluded.last_sequence-1').bind(m.deviceId,m.deviceSequence),
   db.prepare('INSERT INTO workspace_guards(id,valid) SELECT ?1,CASE WHEN (SELECT last_sequence FROM device_sequences WHERE device_id=?2)=?3 THEN 1 ELSE 0 END').bind(m.mutationId+':cancel-advanced',m.deviceId,m.deviceSequence),
  ]);
 }catch(error){
  throwDailyQuota(error);
  const raced=await terminal();if(raced)return raced;
  return{...identity,state:'unknown',canCancel:false};
 }
 return{...identity,state:'cancelled',canCancel:false,cancelledAt:at};
}
