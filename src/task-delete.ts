import { ContractError, canonicalize, computeCanonicalHash, type TaskDeleteMutation } from "./protocol.ts";
import { duplicateOrReuse, findReceipt, toReceipt, type Receipt } from "./mutation-receipt.ts";

type TaskState = { deleted_at: string | null; entity_version: number };
export type DeleteOptions = { failAfterTaskUpdate?: boolean; now?: () => Date };

export async function applyTaskDelete(
  db: D1Database, mutation: TaskDeleteMutation, rawRequest: string, options: DeleteOptions = {},
): Promise<Receipt> {
  const canonicalRequest = canonicalize(rawRequest);
  const canonicalHash = await computeCanonicalHash(rawRequest);
  const existing = await findReceipt(db, mutation.mutationId);
  if (existing) return duplicateOrReuse(existing, canonicalHash);
  const sequence = await db.prepare("SELECT last_sequence FROM device_sequences WHERE device_id=?1")
    .bind(mutation.deviceId).first<{ last_sequence: number }>();
  if (mutation.deviceSequence !== (sequence?.last_sequence ?? 0) + 1)
    throw new ContractError("sequence_gap", "The device sequence is not the next expected value.");
  const task = await findTask(db, mutation.entityId);
  if (!task) throw new ContractError("entity_not_found", "The task does not exist.");
  if (task.entity_version !== mutation.baseEntityVersion)
    throw new ContractError("version_conflict", "The task changed after deletion was prepared.");
  if (task.deleted_at !== null) throw new ContractError("invalid_transition", "The task is already deleted.");

  const entityVersion = mutation.baseEntityVersion + 1;
  const acceptedAt = (options.now ?? (() => new Date()))().toISOString();
  const changePayload = canonicalize(JSON.stringify({ task: { id: mutation.entityId, deletedAt: mutation.payload.deletedAt } }));
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT INTO device_sequence_claims (device_id,device_sequence,mutation_id) VALUES (?1,?2,?3)")
      .bind(mutation.deviceId, mutation.deviceSequence, mutation.mutationId),
    db.prepare("INSERT INTO entity_version_claims (entity_id,base_entity_version,mutation_id) VALUES (?1,?2,?3)")
      .bind(mutation.entityId, mutation.baseEntityVersion, mutation.mutationId),
    db.prepare("UPDATE tasks SET deleted_at=?1,entity_version=?2 WHERE id=?3 AND entity_version=?4 AND deleted_at IS NULL")
      .bind(mutation.payload.deletedAt, entityVersion, mutation.entityId, mutation.baseEntityVersion),
    db.prepare("INSERT INTO tombstones (entity_kind,entity_id,entity_version,deleted_at,purge_after) VALUES ('task',?1,?2,?3,NULL)")
      .bind(mutation.entityId, entityVersion, mutation.payload.deletedAt),
  ];
  if (options.failAfterTaskUpdate) statements.push(db.prepare("INSERT INTO cloud_state (singleton,next_change_seq) VALUES (1,0)"));
  statements.push(
    db.prepare(`INSERT INTO changes (change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at)
      SELECT next_change_seq+1,1,'tasks',?1,'task.deleted','task',?2,?3,?4,?5 FROM cloud_state WHERE singleton=1`)
      .bind(mutation.mutationId, mutation.entityId, entityVersion, changePayload, acceptedAt),
    db.prepare(`INSERT INTO mutation_receipts (mutation_id,protocol_version,product,canonical_request,canonical_hash,entity_id,entity_version,change_seq,server_accepted_at)
      SELECT ?1,1,'tasks',?2,?3,?4,?5,change_seq,?6 FROM changes WHERE mutation_id=?1`)
      .bind(mutation.mutationId, canonicalRequest, canonicalHash, mutation.entityId, entityVersion, acceptedAt),
    db.prepare("UPDATE cloud_state SET next_change_seq=(SELECT change_seq FROM changes WHERE mutation_id=?1) WHERE singleton=1")
      .bind(mutation.mutationId),
    db.prepare(`INSERT INTO device_sequences (device_id,last_sequence) VALUES (?1,?2)
      ON CONFLICT(device_id) DO UPDATE SET last_sequence=excluded.last_sequence
      WHERE device_sequences.last_sequence+1=excluded.last_sequence`).bind(mutation.deviceId, mutation.deviceSequence),
  );
  try { await db.batch(statements); }
  catch (error) {
    const raced = await findReceipt(db, mutation.mutationId);
    if (raced) return duplicateOrReuse(raced, canonicalHash);
    const current = await findTask(db, mutation.entityId);
    if (!current) throw new ContractError("entity_not_found", "The task does not exist.");
    if (current.entity_version !== mutation.baseEntityVersion) throw new ContractError("version_conflict", "The task changed after deletion was prepared.");
    if (current.deleted_at !== null) throw new ContractError("invalid_transition", "The task is already deleted.");
    throw error;
  }
  const receipt = await findReceipt(db, mutation.mutationId);
  if (!receipt) throw new Error("The atomic deletion finished without a durable receipt.");
  return toReceipt(receipt, "accepted");
}

async function findTask(db: D1Database, id: string): Promise<TaskState | null> {
  return db.prepare("SELECT deleted_at,entity_version FROM tasks WHERE id=?1").bind(id).first<TaskState>();
}
