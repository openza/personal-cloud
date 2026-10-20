import {throwDailyQuota} from "./daily-quota.ts";
import {
  ContractError,
  canonicalize,
  computeCanonicalHash,
  type TaskReopenMutation,
} from "./protocol.ts";
import { duplicateOrReuse, findReceipt, toReceipt, type Receipt } from "./mutation-receipt.ts";

type TaskStateRow = {
  completion_state: string;
  entity_version: number;
};

export type ReopenOptions = {
  failAfterTaskUpdate?: boolean;
  now?: () => Date;
};

export async function applyTaskReopen(
  db: D1Database,
  mutation: TaskReopenMutation,
  rawRequest: string,
  options: ReopenOptions = {},
): Promise<Receipt> {
  const canonicalRequest = canonicalize(rawRequest);
  const canonicalHash = await computeCanonicalHash(rawRequest);
  const existingReceipt = await findReceipt(db, mutation.mutationId);
  if (existingReceipt) return duplicateOrReuse(existingReceipt, canonicalHash);

  const sequence = await db.prepare(
    "SELECT last_sequence FROM device_sequences WHERE device_id = ?1",
  ).bind(mutation.deviceId).first<{ last_sequence: number }>();
  if (mutation.deviceSequence !== (sequence?.last_sequence ?? 0) + 1) {
    throw new ContractError("sequence_gap", "The device sequence is not the next expected value.");
  }

  const task = await findTask(db, mutation.entityId);
  if (!task) throw new ContractError("entity_not_found", "The task does not exist.");
  if (task.entity_version !== mutation.baseEntityVersion) {
    throw new ContractError("version_conflict", "The task changed after reopening was prepared.");
  }
  if (task.completion_state !== "completed") {
    throw new ContractError("invalid_transition", "Only a completed task can be reopened.");
  }

  const entityVersion = mutation.baseEntityVersion + 1;
  const acceptedAt = (options.now ?? (() => new Date()))().toISOString();
  const changePayload = canonicalize(JSON.stringify({
    task: {
      id: mutation.entityId,
      completionState: "open",
      completedAt: null,
    },
  }));
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO device_sequence_claims (device_id, device_sequence, mutation_id)
      VALUES (?1, ?2, ?3)
    `).bind(mutation.deviceId, mutation.deviceSequence, mutation.mutationId),
    db.prepare(`
      INSERT INTO entity_version_claims (entity_id, base_entity_version, mutation_id)
      VALUES (?1, ?2, ?3)
    `).bind(mutation.entityId, mutation.baseEntityVersion, mutation.mutationId),
    db.prepare(`
      UPDATE tasks
      SET completion_state = 'open', completed_at = NULL, entity_version = ?1
      WHERE id = ?2 AND entity_version = ?3 AND completion_state = 'completed' AND deleted_at IS NULL
    `).bind(entityVersion, mutation.entityId, mutation.baseEntityVersion),
  ];

  if (options.failAfterTaskUpdate) {
    statements.push(db.prepare(
      "INSERT INTO cloud_state (singleton, next_change_seq) VALUES (1, 0)",
    ));
  }

  statements.push(
    db.prepare(`
      INSERT INTO changes (
        change_seq, protocol_version, product, mutation_id, operation, entity_kind,
        entity_id, entity_version, payload_json, server_accepted_at
      )
      SELECT next_change_seq + 1, 1, 'tasks', ?1, 'task.reopened',
             'task', ?2, ?3, ?4, ?5
      FROM cloud_state WHERE singleton = 1
    `).bind(mutation.mutationId, mutation.entityId, entityVersion, changePayload, acceptedAt),
    db.prepare(`INSERT INTO external_commands(task_id,command,state,requested_change_seq,updated_at,error_code)
      SELECT ?1,'reopen','pending_desktop',change_seq,?2,NULL FROM changes
      WHERE mutation_id=?3 AND EXISTS(SELECT 1 FROM source_descriptors WHERE task_id=?1)
      ON CONFLICT(task_id) DO UPDATE SET command='reopen',state='pending_desktop',
        requested_change_seq=excluded.requested_change_seq,updated_at=excluded.updated_at,error_code=NULL`)
      .bind(mutation.entityId,acceptedAt,mutation.mutationId),
    db.prepare(`
      INSERT INTO mutation_receipts (
        mutation_id, protocol_version, product, canonical_request, canonical_hash,
        entity_id, entity_version, change_seq, server_accepted_at
      )
      SELECT ?1, 1, 'tasks', ?2, ?3, ?4, ?5, change_seq, ?6
      FROM changes WHERE mutation_id = ?1
    `).bind(
      mutation.mutationId,
      canonicalRequest,
      canonicalHash,
      mutation.entityId,
      entityVersion,
      acceptedAt,
    ),
    db.prepare(`
      UPDATE cloud_state
      SET next_change_seq = (SELECT change_seq FROM changes WHERE mutation_id = ?1)
      WHERE singleton = 1
    `).bind(mutation.mutationId),
    db.prepare(`
      INSERT INTO device_sequences (device_id, last_sequence) VALUES (?1, ?2)
      ON CONFLICT(device_id) DO UPDATE SET last_sequence = excluded.last_sequence
      WHERE device_sequences.last_sequence + 1 = excluded.last_sequence
    `).bind(mutation.deviceId, mutation.deviceSequence),
  );

  try {
    await db.batch(statements);
  } catch (error) {throwDailyQuota(error);
    const racedReceipt = await findReceipt(db, mutation.mutationId);
    if (racedReceipt) return duplicateOrReuse(racedReceipt, canonicalHash);
    const currentTask = await findTask(db, mutation.entityId);
    if (!currentTask) throw new ContractError("entity_not_found", "The task does not exist.");
    if (currentTask.entity_version !== mutation.baseEntityVersion) {
      throw new ContractError("version_conflict", "The task changed after reopening was prepared.");
    }
    if (currentTask.completion_state !== "completed") {
      throw new ContractError("invalid_transition", "Only a completed task can be reopened.");
    }
    const racedSequence = await db.prepare(
      "SELECT last_sequence FROM device_sequences WHERE device_id = ?1",
    ).bind(mutation.deviceId).first<{ last_sequence: number }>();
    if ((racedSequence?.last_sequence ?? 0) + 1 !== mutation.deviceSequence) {
      throw new ContractError("sequence_gap", "The device sequence is not the next expected value.");
    }
    throw error;
  }

  const receipt = await findReceipt(db, mutation.mutationId);
  if (!receipt) throw new Error("The atomic reopening finished without a durable receipt.");
  return toReceipt(receipt, "accepted");
}

async function findTask(db: D1Database, entityId: string): Promise<TaskStateRow | null> {
  return db.prepare("SELECT completion_state, entity_version FROM tasks WHERE id = ?1 AND deleted_at IS NULL")
    .bind(entityId).first<TaskStateRow>();
}
