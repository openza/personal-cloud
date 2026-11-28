import {throwDailyQuota} from "./daily-quota.ts";
import {ContractError, canonicalize, computeCanonicalHash, type TaskProviderObservedReopenMutation} from "./protocol.ts";
import {duplicateOrReuse, findReceipt, toReceipt, type Receipt} from "./mutation-receipt.ts";

export async function applyTaskProviderObservedReopen(
  db: D1Database,
  mutation: TaskProviderObservedReopenMutation,
  rawRequest: string,
  options: { now?: () => Date } = {},
): Promise<Receipt> {
  const canonicalRequest = canonicalize(rawRequest);
  const canonicalHash = await computeCanonicalHash(rawRequest);
  const existingReceipt = await findReceipt(db, mutation.mutationId);
  if (existingReceipt) return duplicateOrReuse(existingReceipt, canonicalHash);
  const sequence = await db.prepare("SELECT last_sequence FROM device_sequences WHERE device_id = ?1").bind(mutation.deviceId).first<{last_sequence:number}>();
  if (mutation.deviceSequence !== (sequence?.last_sequence ?? 0) + 1)
    throw new ContractError("sequence_gap", "The device sequence is not the next expected value.");
  const acceptedAt = (options.now ?? (() => new Date()))().toISOString();
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO device_sequence_claims(device_id,device_sequence,mutation_id)
      SELECT ?1,?2,?3 FROM tasks WHERE id=?4 AND deleted_at IS NULL`)
      .bind(mutation.deviceId,mutation.deviceSequence,mutation.mutationId,mutation.entityId),
    db.prepare(`INSERT INTO entity_version_claims(entity_id,base_entity_version,mutation_id)
      SELECT id,entity_version,?1 FROM tasks
      WHERE id=?2 AND deleted_at IS NULL AND completion_state='completed' AND completed_at<?3
        AND EXISTS(SELECT 1 FROM device_sequence_claims
          WHERE device_id=?4 AND device_sequence=?5 AND mutation_id=?1)`)
      .bind(mutation.mutationId,mutation.entityId,mutation.payload.observedAt,mutation.deviceId,mutation.deviceSequence),
    db.prepare(`UPDATE tasks SET completion_state='open',completed_at=NULL,entity_version=entity_version+1
      WHERE id=?1 AND deleted_at IS NULL AND completion_state='completed' AND completed_at<?2
        AND EXISTS(SELECT 1 FROM entity_version_claims claim
          WHERE claim.entity_id=tasks.id AND claim.base_entity_version=tasks.entity_version AND claim.mutation_id=?3)`)
      .bind(mutation.entityId,mutation.payload.observedAt,mutation.mutationId),
    db.prepare(`INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at)
      SELECT c.next_change_seq+1,1,'tasks',?1,'task.reopened','task',t.id,t.entity_version,
        json_object('task',json_object('id',t.id,'completionState',t.completion_state,'completedAt',t.completed_at)),?2
      FROM cloud_state c JOIN tasks t ON t.id=?3 AND t.deleted_at IS NULL
      JOIN entity_version_claims claim ON claim.entity_id=t.id AND claim.mutation_id=?1
        AND claim.base_entity_version+1=t.entity_version
      WHERE c.singleton=1 AND t.completion_state='open' AND t.completed_at IS NULL AND changes()=1`)
      .bind(mutation.mutationId,acceptedAt,mutation.entityId),
    db.prepare(`DELETE FROM entity_version_claims WHERE mutation_id=?1
      AND NOT EXISTS(SELECT 1 FROM changes WHERE mutation_id=?1)`)
      .bind(mutation.mutationId),
    db.prepare("UPDATE cloud_state SET next_change_seq=(SELECT change_seq FROM changes WHERE mutation_id=?1) WHERE singleton=1 AND EXISTS(SELECT 1 FROM changes WHERE mutation_id=?1)")
      .bind(mutation.mutationId),
    db.prepare(`INSERT INTO mutation_receipts(mutation_id,protocol_version,product,canonical_request,canonical_hash,entity_id,entity_version,change_seq,server_accepted_at)
      SELECT ?1,1,'tasks',?2,?3,t.id,t.entity_version,c.change_seq,?4
      FROM tasks t JOIN changes c ON c.mutation_id=?1 WHERE t.id=?5`)
      .bind(mutation.mutationId,canonicalRequest,canonicalHash,acceptedAt,mutation.entityId),
    db.prepare(`INSERT INTO provider_observed_reopen_noop_receipts
      (mutation_id,canonical_hash,entity_id,entity_version,change_seq,server_accepted_at)
      SELECT ?1,?2,t.id,t.entity_version,s.next_change_seq,?3 FROM tasks t CROSS JOIN cloud_state s
      WHERE t.id=?4 AND t.deleted_at IS NULL AND s.singleton=1
        AND NOT EXISTS(SELECT 1 FROM changes WHERE mutation_id=?1)`)
      .bind(mutation.mutationId,canonicalHash,acceptedAt,mutation.entityId),
    db.prepare(`INSERT INTO device_sequences(device_id,last_sequence)
      SELECT ?1,?2 WHERE EXISTS(SELECT 1 FROM mutation_receipts WHERE mutation_id=?3)
        OR EXISTS(SELECT 1 FROM provider_observed_reopen_noop_receipts WHERE mutation_id=?3)
      ON CONFLICT(device_id) DO UPDATE SET last_sequence=excluded.last_sequence
      WHERE device_sequences.last_sequence+1=excluded.last_sequence`)
      .bind(mutation.deviceId,mutation.deviceSequence,mutation.mutationId),
  ];
  try { await db.batch(statements); }
  catch (error) {
    throwDailyQuota(error);
    const raced = await findReceipt(db,mutation.mutationId);
    if (raced) return duplicateOrReuse(raced,canonicalHash);
    throw error;
  }
  const receipt = await findReceipt(db,mutation.mutationId);
  if (!receipt) {
    const currentTask = await db.prepare("SELECT id FROM tasks WHERE id=?1 AND deleted_at IS NULL").bind(mutation.entityId).first<{id:string}>();
    if (!currentTask) throw new ContractError("entity_not_found", "The task does not exist.");
    throw new Error("The provider-observed reopen receipt was not committed.");
  }
  return toReceipt(receipt,"accepted");
}
