import {
  ContractError,
  canonicalize,
  computeCanonicalHash,
  type TaskOpenzaFieldsMutation,
  type TaskUpdateTitleMutation,
} from "./protocol.ts";
import { duplicateOrReuse, findReceipt, toReceipt, type Receipt } from "./mutation-receipt.ts";

type TaskVersionRow = {
  deadline_on: string | null;
  entity_version: number;
  notes: string | null;
  planned_at: string | null;
  planned_on: string | null;
  priority: number;
  title: string;
  workflow_status: string;
};

export type UpdateOptions = {
  failAfterTaskUpdate?: boolean;
  now?: () => Date;
};

export async function applyTaskTitleUpdate(
  db: D1Database,
  mutation: TaskUpdateTitleMutation,
  rawRequest: string,
  options: UpdateOptions = {},
): Promise<Receipt> {
  return applyTaskOpenzaFieldsUpdate(db, mutation, rawRequest, options);
}

export async function applyTaskOpenzaFieldsUpdate(
  db: D1Database,
  mutation: TaskOpenzaFieldsMutation,
  rawRequest: string,
  options: UpdateOptions = {},
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
    throw new ContractError("version_conflict", "The task changed after this title update was prepared.");
  }
  if ("title" in mutation.payload && task.title === mutation.payload.title) {
    throw new ContractError("invalid_request", "The new task title must differ from the current title.");
  }
  if ("workflowStatus" in mutation.payload && task.workflow_status === mutation.payload.workflowStatus) {
    throw new ContractError("invalid_request", "The new workflow status must differ from the current workflow status.");
  }
  if ("priority" in mutation.payload && task.priority === mutation.payload.priority) {
    throw new ContractError("invalid_request", "The new priority must differ from the current priority.");
  }
  if ("plannedOn" in mutation.payload && task.planned_on === mutation.payload.plannedOn) {
    throw new ContractError("invalid_request", "The new planned date must differ from the current planned date.");
  }
  if ("plannedAt" in mutation.payload && task.planned_at === mutation.payload.plannedAt) {
    throw new ContractError("invalid_request", "The new planned time must differ from the current planned time.");
  }
  if ("notes" in mutation.payload && task.notes === mutation.payload.notes) {
    throw new ContractError("invalid_request", "The new task notes must differ from the current notes.");
  }
  if ("deadlineOn" in mutation.payload && task.deadline_on === mutation.payload.deadlineOn) {
    throw new ContractError("invalid_request", "The new deadline must differ from the current deadline.");
  }

  const entityVersion = mutation.baseEntityVersion + 1;
  const acceptedAt = (options.now ?? (() => new Date()))().toISOString();
  const [fieldName, fieldValue] = "title" in mutation.payload
    ? ["title", mutation.payload.title]
    : "workflowStatus" in mutation.payload
      ? ["workflowStatus", mutation.payload.workflowStatus]
      : "priority" in mutation.payload
        ? ["priority", mutation.payload.priority]
        : "plannedOn" in mutation.payload
          ? ["plannedOn", mutation.payload.plannedOn]
          : "plannedAt" in mutation.payload
            ? ["plannedAt", mutation.payload.plannedAt]
            : "notes" in mutation.payload
              ? ["notes", mutation.payload.notes]
              : ["deadlineOn", mutation.payload.deadlineOn];
  const changePayload = canonicalize(JSON.stringify({ task: {
    id: mutation.entityId,
    [fieldName]: fieldValue,
  } }));
  const updateStatement = "title" in mutation.payload
    ? db.prepare(`
        UPDATE tasks
        SET title = ?1, entity_version = ?2
        WHERE id = ?3 AND entity_version = ?4
      `).bind(mutation.payload.title, entityVersion, mutation.entityId, mutation.baseEntityVersion)
    : "workflowStatus" in mutation.payload
      ? db.prepare(`
          UPDATE tasks
          SET workflow_status = ?1, entity_version = ?2
          WHERE id = ?3 AND entity_version = ?4
        `).bind(mutation.payload.workflowStatus, entityVersion, mutation.entityId, mutation.baseEntityVersion)
      : "priority" in mutation.payload
        ? db.prepare(`
            UPDATE tasks
            SET priority = ?1, entity_version = ?2
            WHERE id = ?3 AND entity_version = ?4
          `).bind(mutation.payload.priority, entityVersion, mutation.entityId, mutation.baseEntityVersion)
        : "plannedOn" in mutation.payload
          ? db.prepare(`
              UPDATE tasks
              SET planned_on = ?1, planned_at = NULL, entity_version = ?2
              WHERE id = ?3 AND entity_version = ?4
            `).bind(mutation.payload.plannedOn, entityVersion, mutation.entityId, mutation.baseEntityVersion)
          : "plannedAt" in mutation.payload
            ? db.prepare(`
              UPDATE tasks
              SET planned_at = ?1, planned_on = NULL, entity_version = ?2
              WHERE id = ?3 AND entity_version = ?4
            `).bind(mutation.payload.plannedAt, entityVersion, mutation.entityId, mutation.baseEntityVersion)
            : "notes" in mutation.payload
              ? db.prepare(`
                  UPDATE tasks SET notes = ?1, entity_version = ?2
                  WHERE id = ?3 AND entity_version = ?4
                `).bind(mutation.payload.notes, entityVersion, mutation.entityId, mutation.baseEntityVersion)
              : db.prepare(`
                  UPDATE tasks SET deadline_on = ?1, entity_version = ?2
                  WHERE id = ?3 AND entity_version = ?4
                `).bind(mutation.payload.deadlineOn, entityVersion, mutation.entityId, mutation.baseEntityVersion);
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO device_sequence_claims (device_id, device_sequence, mutation_id)
      VALUES (?1, ?2, ?3)
    `).bind(mutation.deviceId, mutation.deviceSequence, mutation.mutationId),
    db.prepare(`
      INSERT INTO entity_version_claims (entity_id, base_entity_version, mutation_id)
      VALUES (?1, ?2, ?3)
    `).bind(mutation.entityId, mutation.baseEntityVersion, mutation.mutationId),
    updateStatement,
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
      SELECT next_change_seq + 1, 1, 'tasks', ?1, 'task.updatedOpenzaFields',
             'task', ?2, ?3, ?4, ?5
      FROM cloud_state WHERE singleton = 1
    `).bind(mutation.mutationId, mutation.entityId, entityVersion, changePayload, acceptedAt),
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
  } catch (error) {
    const racedReceipt = await findReceipt(db, mutation.mutationId);
    if (racedReceipt) return duplicateOrReuse(racedReceipt, canonicalHash);
    const currentTask = await findTask(db, mutation.entityId);
    if (!currentTask) throw new ContractError("entity_not_found", "The task does not exist.");
    if (currentTask.entity_version !== mutation.baseEntityVersion) {
      throw new ContractError("version_conflict", "The task changed after this title update was prepared.");
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
  if (!receipt) throw new Error("The atomic Openza field update completed without a durable receipt.");
  return toReceipt(receipt, "accepted");
}

async function findTask(db: D1Database, entityId: string): Promise<TaskVersionRow | null> {
  return db.prepare("SELECT title, workflow_status, priority, planned_on, planned_at, notes, deadline_on, entity_version FROM tasks WHERE id = ?1")
    .bind(entityId).first<TaskVersionRow>();
}
