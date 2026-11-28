import {throwDailyQuota} from "./daily-quota.ts";
import {
  ContractError,
  canonicalize,
  computeCanonicalHash,
  type TaskCreateMutation,
  type TaskHistoricalCompletionImportMutation,
} from "./protocol.ts";
import { duplicateOrReuse, findReceipt, toReceipt, type Receipt } from "./mutation-receipt.ts";
import {assertSourceOwnership,sourceOwnershipCondition,sourceOwnershipValues} from './source-ownership.ts';
import {arraySql,taskRecordJson} from './workspace-records.ts';

export type ApplyOptions = {
  failAfterTaskInsert?: boolean;
  beforeHistoricalCompletionBatch?: () => Promise<void>;
  now?: () => Date;
};

export async function applyTaskCreate(
  db: D1Database,
  mutation: TaskCreateMutation | TaskHistoricalCompletionImportMutation,
  rawRequest: string,
  options: ApplyOptions = {},
): Promise<Receipt> {
  const canonicalRequest = canonicalize(rawRequest);
  const canonicalHash = await computeCanonicalHash(rawRequest);
  const existingReceipt = await findReceipt(db, mutation.mutationId);
  if (existingReceipt) return duplicateOrReuse(existingReceipt, canonicalHash);

  const sequence = await db.prepare(
    "SELECT last_sequence FROM device_sequences WHERE device_id = ?1",
  ).bind(mutation.deviceId).first<{ last_sequence: number }>();
  const expectedSequence = (sequence?.last_sequence ?? 0) + 1;
  if (mutation.deviceSequence !== expectedSequence) {
    throw new ContractError("sequence_gap", "The device sequence is not the next expected value.");
  }

  if (mutation.operation === "task.createHistoricalCompletion" && !("task" in mutation.payload))
    return applyHistoricalCompletionUpdate(db, mutation as HistoricalCompletionUpdateMutation, canonicalRequest, canonicalHash, options);

  const payload = mutation.payload as unknown as TaskCreateMutation["payload"] & {
    completedAt?: string;
    task: TaskCreateMutation["payload"]["task"] & { completedAt?: string };
  };

  const space = await db.prepare(
    "SELECT id,is_archived FROM spaces WHERE id = ?1 AND deleted_at IS NULL",
  ).bind(payload.task.spaceId).first<{ id: string; is_archived: number }>();
  if (!space) throw new ContractError("parent_not_found", "The task Space does not exist.");
  if (space.is_archived) throw new ContractError("invalid_request", "An active target Space is required.");

  const existingTask = await db.prepare("SELECT id FROM tasks WHERE id = ?1")
    .bind(mutation.entityId)
    .first<{ id: string }>();
  if (existingTask) throw new ContractError("entity_exists", "The task ID already exists.");

  const acceptedAt = (options.now ?? (() => new Date()))().toISOString();
  const task = payload.task;
  const historical = mutation.operation === "task.createHistoricalCompletion";
  const completionState = historical ? "completed" : "open";
  const completedAt = mutation.operation === "task.createHistoricalCompletion" ? payload.completedAt ?? payload.task.completedAt : null;
  if(payload.source)await assertSourceOwnership(db,payload.source,mutation.deviceId);
  const changePayload = canonicalize(JSON.stringify({
    ...payload,
    task: historical ? { ...task, completionState, completedAt } : task,
  }));
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO device_sequence_claims (device_id, device_sequence, mutation_id)
      VALUES (?1, ?2, ?3)
    `).bind(mutation.deviceId, mutation.deviceSequence, mutation.mutationId),
    db.prepare(`
      INSERT INTO tasks (
        id, product, space_id, title, completion_state, completed_at, workflow_status,
        created_at, entity_version, created_by_mutation_id, source_owner_device_id
      ) VALUES (?1, 'tasks', ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)
    `).bind(task.id, task.spaceId, task.title, completionState, completedAt, task.workflowStatus, task.createdAt, mutation.mutationId,payload.source?mutation.deviceId:null),
  ];
  if (payload.source) {
    const source=payload.source;
    statements.splice(1,0,db.prepare(`INSERT INTO workspace_guards(id,valid) SELECT ?,CASE WHEN (${sourceOwnershipCondition}) THEN 1 ELSE 0 END`).bind(`${mutation.mutationId}:source-owner`,...sourceOwnershipValues(source,mutation.deviceId)));
    statements.push(db.prepare(`INSERT INTO source_descriptors(
      task_id,integration_kind,external_id_hash,source_url,source_title,source_description,source_project_name,
      source_priority,source_planned_on,source_planned_at,source_deadline_on,source_deadline_at,recurrence_rule,refreshed_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`)
      .bind(task.id,source.integrationKind,source.externalIdHash,source.sourceUrl,source.title,source.description,source.projectName,
        source.priority,source.plannedOn,source.plannedAt,source.deadlineOn,source.deadlineAt,source.recurrenceRule,source.refreshedAt));
  }

  if (options.failAfterTaskInsert) {
    statements.push(db.prepare(
      "INSERT INTO cloud_state (singleton, next_change_seq) VALUES (1, 0)",
    ));
  }

  const createChange = historical
    ? db.prepare(`
        INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at)
        SELECT next_change_seq+1,1,'tasks',?1,'workspace.changed','workspace',?2,1,
          json_object('spaces',json('[]'),'projects',json('[]'),'tasks',json(${arraySql('tasks t', taskRecordJson('?4'), 't.id=?5')}),
            'scopes',json('[]'),'catalog',json('[]'),'intents',json('[]'),'routes',json('[]')),
          ?4 FROM cloud_state WHERE singleton=1
      `).bind(mutation.mutationId, mutation.entityId, 1, acceptedAt, mutation.entityId)
    : db.prepare(`
        INSERT INTO changes (
          change_seq, protocol_version, product, mutation_id, operation, entity_kind,
          entity_id, entity_version, payload_json, server_accepted_at
        )
        SELECT next_change_seq + 1, 1, 'tasks', ?1, 'task.created', 'task', ?2, 1, ?3, ?4
        FROM cloud_state WHERE singleton = 1
      `).bind(mutation.mutationId, mutation.entityId, changePayload, acceptedAt);
  statements.push(
    createChange,
    db.prepare(`
      INSERT INTO mutation_receipts (
        mutation_id, protocol_version, product, canonical_request, canonical_hash,
        entity_id, entity_version, change_seq, server_accepted_at
      )
      SELECT ?1, 1, 'tasks', ?2, ?3, ?4, 1, change_seq, ?5
      FROM changes WHERE mutation_id = ?1
    `).bind(mutation.mutationId, canonicalRequest, canonicalHash, mutation.entityId, acceptedAt),
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
    if (await db.prepare("SELECT id FROM tasks WHERE id = ?1").bind(mutation.entityId).first()) {
      throw new ContractError("entity_exists", "The task ID already exists.");
    }
    const racedSequence = await db.prepare(
      "SELECT last_sequence FROM device_sequences WHERE device_id = ?1",
    ).bind(mutation.deviceId).first<{ last_sequence: number }>();
    if ((racedSequence?.last_sequence ?? 0) + 1 !== mutation.deviceSequence) {
      throw new ContractError("sequence_gap", "The device sequence is not the next expected value.");
    }
    if(String(error).includes('active target Space required')||String(error).includes('active target project required'))throw new ContractError('invalid_request','An active target Space and unarchived project are required.');
    if(String(error).includes('workspace_guards')||String(error).includes('CHECK constraint failed: valid=1'))throw new ContractError('source_identity_conflict','Source ownership changed; refresh and retry.');
    throw error;
  }

  const receipt = await findReceipt(db, mutation.mutationId);
  if (!receipt) throw new Error("The atomic write completed without a durable receipt.");
  return toReceipt(receipt, "accepted");
}

async function applyHistoricalCompletionUpdate(
  db: D1Database,
  mutation: HistoricalCompletionUpdateMutation,
  canonicalRequest: string,
  canonicalHash: string,
  options: ApplyOptions,
): Promise<Receipt> {
  const completedAt = mutation.payload.completedAt;
  const current = await db.prepare("SELECT completion_state,completed_at,entity_version FROM tasks WHERE id=?1 AND deleted_at IS NULL")
    .bind(mutation.entityId).first<{ completion_state: string; completed_at: string | null; entity_version: number }>();
  if (!current) throw new ContractError("entity_not_found", "The task does not exist.");
  if (current.completion_state !== "open" &&
      !(current.completion_state === "completed" && Date.parse(current.completed_at ?? "") === Date.parse(completedAt)))
    throw new ContractError("invalid_transition", "Historical completion cannot replace a different task completion.");
  if (current.completion_state === "open" && current.entity_version !== mutation.baseEntityVersion)
    throw new ContractError("version_conflict", "The task changed before its historical completion was imported.");

  const acceptedAt = (options.now ?? (() => new Date()))().toISOString();
  const version = current.completion_state === "open" ? current.entity_version + 1 : current.entity_version;
  const versionGuardId = `${mutation.mutationId}:historical-version`;
  const resultGuardId = `${mutation.mutationId}:historical-result`;
  const payloadSql = `json_object('spaces',json('[]'),'projects',json('[]'),'tasks',json(${arraySql('tasks t', taskRecordJson('?4'), 't.id=?6')}),'scopes',json('[]'),'catalog',json('[]'),'intents',json('[]'),'routes',json('[]'))`;
  const statements: D1PreparedStatement[] = [
    db.prepare("INSERT INTO device_sequence_claims(device_id,device_sequence,mutation_id) VALUES(?1,?2,?3)")
      .bind(mutation.deviceId, mutation.deviceSequence, mutation.mutationId),
  ];
  if (current.completion_state === "open")
    statements.push(db.prepare("INSERT INTO entity_version_claims(entity_id,base_entity_version,mutation_id) VALUES(?1,?2,?3)")
      .bind(mutation.entityId, current.entity_version, mutation.mutationId));
  statements.push(
    db.prepare(`INSERT INTO workspace_guards(id,valid)
      SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM tasks WHERE id=?2 AND deleted_at IS NULL AND entity_version=?3
        AND ((completion_state='open' AND entity_version=?4) OR (completion_state='completed' AND completed_at=?5)))
        THEN 1 ELSE 0 END`)
      .bind(versionGuardId, mutation.entityId, current.entity_version, mutation.baseEntityVersion, completedAt),
  );
  if (current.completion_state === "open")
    statements.push(db.prepare("UPDATE tasks SET completion_state='completed',completed_at=?1,entity_version=?2,updated_at=?3 WHERE id=?4 AND entity_version=?5 AND completion_state='open'")
      .bind(completedAt, version, acceptedAt, mutation.entityId, mutation.baseEntityVersion));
  statements.push(db.prepare(`INSERT INTO workspace_guards(id,valid)
    SELECT ?1,CASE WHEN EXISTS(SELECT 1 FROM tasks WHERE id=?2 AND deleted_at IS NULL AND entity_version=?3
      AND completion_state='completed' AND completed_at=?4) THEN 1 ELSE 0 END`)
    .bind(resultGuardId, mutation.entityId, version, completedAt));
  statements.push(
    db.prepare(`INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at)
      SELECT c.next_change_seq+1,1,'tasks',?1,'workspace.changed','workspace',?2,?3,${payloadSql},?4
      FROM cloud_state c WHERE c.singleton=1 AND EXISTS(SELECT 1 FROM workspace_guards WHERE id=?7 AND valid=1)`)
      .bind(mutation.mutationId, mutation.entityId, version, acceptedAt, mutation.entityId, mutation.entityId, resultGuardId),
    db.prepare(`INSERT INTO mutation_receipts(mutation_id,protocol_version,product,canonical_request,canonical_hash,entity_id,entity_version,change_seq,server_accepted_at)
      SELECT ?1,1,'tasks',?2,?3,?4,?5,change_seq,?6 FROM changes WHERE mutation_id=?1`)
      .bind(mutation.mutationId, canonicalRequest, canonicalHash, mutation.entityId, version, acceptedAt),
    db.prepare("UPDATE cloud_state SET next_change_seq=(SELECT change_seq FROM changes WHERE mutation_id=?1) WHERE singleton=1")
      .bind(mutation.mutationId),
    db.prepare("INSERT INTO device_sequences(device_id,last_sequence) VALUES(?1,?2) ON CONFLICT(device_id) DO UPDATE SET last_sequence=excluded.last_sequence WHERE device_sequences.last_sequence+1=excluded.last_sequence")
      .bind(mutation.deviceId, mutation.deviceSequence),
  );
  try {
    await options.beforeHistoricalCompletionBatch?.();
    await db.batch(statements);
  }
  catch (error) {
    throwDailyQuota(error);
    const receipt = await findReceipt(db, mutation.mutationId);
    if (receipt) return duplicateOrReuse(receipt, canonicalHash);
    const latest = await db.prepare("SELECT completion_state,completed_at,entity_version FROM tasks WHERE id=?1 AND deleted_at IS NULL")
      .bind(mutation.entityId).first<{ completion_state: string; completed_at: string | null; entity_version: number }>();
    if (!latest) throw new ContractError("entity_not_found", "The task does not exist.");
    if (latest.entity_version !== current.entity_version || latest.completion_state !== current.completion_state ||
        latest.completed_at !== current.completed_at)
      throw new ContractError("version_conflict", "The task changed before its historical completion was imported.");
    if (String(error).includes("entity_version_claims"))
      throw new ContractError("version_conflict", "The task changed before its historical completion was imported.");
    throw error;
  }
  const receipt = await findReceipt(db, mutation.mutationId);
  if (!receipt) throw new Error("Historical completion update completed without a durable receipt.");
  return toReceipt(receipt, "accepted");
}

type HistoricalCompletionUpdateMutation = TaskHistoricalCompletionImportMutation & {
  baseEntityVersion: number;
  payload: { completedAt: string };
};
