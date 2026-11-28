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
  const task = await db.prepare("SELECT completion_state,completed_at,entity_version FROM tasks WHERE id=?1 AND deleted_at IS NULL").bind(mutation.entityId).first<{completion_state:string;completed_at:string|null;entity_version:number}>();
  if (!task) throw new ContractError("entity_not_found", "The task does not exist.");
  const acceptedAt = (options.now ?? (() => new Date()))().toISOString();
  const shouldReopen = task.completion_state === "completed" && task.completed_at !== null && task.completed_at < mutation.payload.observedAt;
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT INTO device_sequence_claims(device_id,device_sequence,mutation_id) VALUES(?1,?2,?3)").bind(mutation.deviceId,mutation.deviceSequence,mutation.mutationId),
  ];
  if (shouldReopen) {
    statements.push(
      db.prepare(`UPDATE tasks SET
        completion_state=CASE WHEN completion_state='completed' AND completed_at<?2 THEN 'open' ELSE completion_state END,
        completed_at=CASE WHEN completion_state='completed' AND completed_at<?2 THEN NULL ELSE completed_at END,
        entity_version=entity_version+1 WHERE id=?1 AND deleted_at IS NULL`).bind(mutation.entityId,mutation.payload.observedAt),
      db.prepare(`INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at)
        SELECT c.next_change_seq+1,1,'tasks',?1,
          CASE WHEN t.completion_state='open' THEN 'task.reopened' ELSE 'task.completed' END,'task',?2,t.entity_version,
          json_object('task',json_object('id',t.id,'completionState',t.completion_state,'completedAt',t.completed_at)),?3
        FROM cloud_state c JOIN tasks t ON t.id=?2 WHERE c.singleton=1`).bind(mutation.mutationId,mutation.entityId,acceptedAt),
      db.prepare(`INSERT INTO entity_version_claims(entity_id,base_entity_version,mutation_id)
        SELECT id,entity_version-1,?1 FROM tasks WHERE id=?2 AND EXISTS(SELECT 1 FROM changes WHERE mutation_id=?1)`).bind(mutation.mutationId,mutation.entityId),
      db.prepare("UPDATE cloud_state SET next_change_seq=(SELECT change_seq FROM changes WHERE mutation_id=?1) WHERE singleton=1 AND EXISTS(SELECT 1 FROM changes WHERE mutation_id=?1)").bind(mutation.mutationId),
      db.prepare(`INSERT INTO mutation_receipts(mutation_id,protocol_version,product,canonical_request,canonical_hash,entity_id,entity_version,change_seq,server_accepted_at)
        SELECT ?1,1,'tasks',?2,?3,t.id,t.entity_version,c.change_seq,?4
        FROM tasks t JOIN changes c ON c.mutation_id=?1 WHERE t.id=?5`).bind(mutation.mutationId,canonicalRequest,canonicalHash,acceptedAt,mutation.entityId),
    );
  } else {
    statements.push(db.prepare(`INSERT INTO provider_observed_reopen_noop_receipts
      (mutation_id,canonical_hash,entity_id,entity_version,change_seq,server_accepted_at)
      SELECT ?1,?2,t.id,t.entity_version,s.next_change_seq,?3 FROM tasks t CROSS JOIN cloud_state s
      WHERE t.id=?4 AND s.singleton=1`).bind(mutation.mutationId,canonicalHash,acceptedAt,mutation.entityId));
  }
  statements.push(db.prepare(`INSERT INTO device_sequences(device_id,last_sequence) VALUES(?1,?2)
    ON CONFLICT(device_id) DO UPDATE SET last_sequence=excluded.last_sequence WHERE device_sequences.last_sequence+1=excluded.last_sequence`).bind(mutation.deviceId,mutation.deviceSequence));
  try { await db.batch(statements); }
  catch (error) {
    throwDailyQuota(error);
    const raced = await findReceipt(db,mutation.mutationId);
    if (raced) return duplicateOrReuse(raced,canonicalHash);
    throw error;
  }
  const receipt = await findReceipt(db,mutation.mutationId);
  if (!receipt) throw new Error("The provider-observed reopen receipt was not committed.");
  return toReceipt(receipt,"accepted");
}
