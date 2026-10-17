import {ContractError} from './protocol.ts';

type SourceIdentity={integrationKind:string;externalIdHash:string};
// Both publication directions use this predicate inside their atomic batch.
// Migration24 indexes the descriptor identity; catalog has its unique identity index.
export const sourceOwnershipCondition=`NOT EXISTS(
 SELECT 1 FROM provider_catalog WHERE integration_kind=? AND external_id_hash=? AND bridge_device_id<>?
) AND NOT EXISTS(
 SELECT 1 FROM source_descriptors sd JOIN tasks t ON t.id=sd.task_id
 WHERE sd.integration_kind=? AND sd.external_id_hash=? AND t.deleted_at IS NULL
 AND (t.source_owner_device_id IS NULL OR t.source_owner_device_id<>?)
)`;
export function sourceOwnershipValues(source:SourceIdentity,deviceId:string){return [source.integrationKind,source.externalIdHash,deviceId,source.integrationKind,source.externalIdHash,deviceId];}
export async function assertSourceOwnership(db:D1Database,source:SourceIdentity,deviceId:string){
 const row=await db.prepare(`SELECT (${sourceOwnershipCondition}) AS allowed`).bind(...sourceOwnershipValues(source,deviceId)).first<{allowed:number}>();
 if(!row?.allowed)throw new ContractError('source_identity_conflict','Source identity belongs to another bridge or has no established owner.');
}
