import {
  ContractError,
  canonicalize,
  computeCanonicalHash,
  type ExternalCommandResultMutation,
  type SourceRefreshMutation,
} from "./protocol.ts";
import { duplicateOrReuse, findReceipt, toReceipt, type Receipt } from "./mutation-receipt.ts";
import { ownedClaim } from "./provider-delivery.ts";

type TaskRow = { entity_version: number };
type SourceRow = { integration_kind: string; external_id_hash: string; refreshed_at: string };
type CommandRow = { command: "complete" | "reopen"; state: string; requested_change_seq: number };

export async function applySourceRefresh(
  db: D1Database,
  mutation: SourceRefreshMutation,
  rawRequest: string,
  now: () => Date = () => new Date(),
): Promise<Receipt> {
  const duplicate = await findDuplicate(db, mutation.mutationId, rawRequest);
  if (duplicate) return duplicate;
  await requireNextSequence(db, mutation.deviceId, mutation.deviceSequence);
  const task = await db.prepare("SELECT entity_version FROM tasks WHERE id=?1 AND deleted_at IS NULL")
    .bind(mutation.entityId).first<TaskRow>();
  if (!task) throw new ContractError("entity_not_found", "The Openza task does not exist.");
  const current = await db.prepare(`SELECT integration_kind,external_id_hash,refreshed_at
    FROM source_descriptors WHERE task_id=?1`).bind(mutation.entityId).first<SourceRow>();
  if (!current) throw new ContractError("source_not_found", "The Openza task has no source link.");
  if (current.integration_kind !== mutation.payload.source.integrationKind ||
      current.external_id_hash !== mutation.payload.source.externalIdHash) {
    throw new ContractError("source_identity_conflict", "A source refresh cannot replace the linked source identity.");
  }
  const acceptedAt = now().toISOString();
  const canonicalRequest = canonicalize(rawRequest);
  const canonicalHash = await computeCanonicalHash(rawRequest);
  try {
    await db.batch([
      deviceClaim(db, mutation.deviceId, mutation.deviceSequence, mutation.mutationId),
      db.prepare(`UPDATE source_descriptors SET source_url=?1,source_title=?2,source_description=?3,
      source_project_name=?4,source_priority=?5,source_planned_on=?6,source_planned_at=?7,
      source_deadline_on=?8,source_deadline_at=?9,recurrence_rule=?10,refreshed_at=?11
      WHERE task_id=?12 AND integration_kind=?13 AND external_id_hash=?14 AND refreshed_at<?11
        AND EXISTS(SELECT 1 FROM tasks WHERE id=?12 AND deleted_at IS NULL)`)
      .bind(mutation.payload.source.sourceUrl, mutation.payload.source.title, mutation.payload.source.description,
        mutation.payload.source.projectName, mutation.payload.source.priority, mutation.payload.source.plannedOn,
        mutation.payload.source.plannedAt, mutation.payload.source.deadlineOn, mutation.payload.source.deadlineAt,
        mutation.payload.source.recurrenceRule, mutation.payload.source.refreshedAt, mutation.entityId,
        mutation.payload.source.integrationKind, mutation.payload.source.externalIdHash),
    appendSourceChange(db, mutation, acceptedAt),
    insertReceipt(db, mutation, canonicalRequest, canonicalHash, acceptedAt),
    advanceCloudState(db, mutation.mutationId),
      advanceDevice(db, mutation.deviceId, mutation.deviceSequence),
    ]);
  } catch (error) {
    const raced = await findReceipt(db, mutation.mutationId);
    if (raced) return duplicateOrReuse(raced, canonicalHash);
    const latestTask=await db.prepare("SELECT entity_version FROM tasks WHERE id=?1 AND deleted_at IS NULL").bind(mutation.entityId).first<TaskRow>();
    if(!latestTask)throw new ContractError("entity_not_found","The Openza task does not exist.");
    throw error;
  }
  return requireAcceptedReceipt(db, mutation.mutationId);
}

export async function applyExternalCommandResult(
  db: D1Database,
  mutation: ExternalCommandResultMutation,
  rawRequest: string,
  now: () => Date = () => new Date(),
): Promise<Receipt> {
  const duplicate = await findDuplicate(db, mutation.mutationId, rawRequest);
  if (duplicate) return duplicate;
  await requireNextSequence(db, mutation.deviceId, mutation.deviceSequence);
  const task = await db.prepare("SELECT entity_version FROM tasks WHERE id=?1")
    .bind(mutation.entityId).first<TaskRow>();
  if (!task) throw new ContractError("entity_not_found", "The Openza task does not exist.");
  const command = await db.prepare(`SELECT command,state,requested_change_seq FROM external_commands WHERE task_id=?1`)
    .bind(mutation.entityId).first<CommandRow>();
  if (!command) throw new ContractError("command_not_found", "The Openza task has no pending external command.");
  const claim=await ownedClaim(db,mutation.payload.claimId,mutation.deviceId);
  if(claim.taskId!==mutation.entityId||claim.requestedChangeSeq!==mutation.payload.requestedChangeSeq)
    throw new ContractError("command_superseded","The result does not match its claimed request.");
  if(claim.state!=="started")throw new ContractError("invalid_transition","Only a started delivery can be resolved.");

  const state = mutation.operation === "externalCommand.confirm" ? "confirmed" : "rejected";
  const acceptedAt = now().toISOString();
  const canonicalRequest = canonicalize(rawRequest);
  const canonicalHash = await computeCanonicalHash(rawRequest);
  try {
    await db.batch([
      deviceClaim(db, mutation.deviceId, mutation.deviceSequence, mutation.mutationId),
      db.prepare(`INSERT INTO external_command_resolutions
        (task_id,requested_change_seq,mutation_id,state,resolved_at,error_code,claim_id,resolving_device_id)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`)
        .bind(mutation.entityId, mutation.payload.requestedChangeSeq, mutation.mutationId, state,
          mutation.payload.resolvedAt, mutation.payload.errorCode,mutation.payload.claimId,mutation.deviceId),
      db.prepare(`UPDATE provider_delivery_claims SET state='resolved',resolution=?1,resolved_at=?2
        WHERE claim_id=?3 AND device_id=?4 AND state='started'`)
        .bind(state,mutation.payload.resolvedAt,mutation.payload.claimId,mutation.deviceId),
      db.prepare(`UPDATE external_commands SET state=?1,updated_at=?2,error_code=?3
      WHERE task_id=?4 AND requested_change_seq=?5 AND state='pending_desktop'`)
      .bind(state, mutation.payload.resolvedAt, mutation.payload.errorCode, mutation.entityId,
        mutation.payload.requestedChangeSeq),
      db.prepare(`INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,
        entity_id,entity_version,payload_json,server_accepted_at)
        SELECT cs.next_change_seq+1,1,'tasks',?1,'task.updatedOpenzaFields','task',t.id,t.entity_version,
          json_object('task',json_object('id',t.id,'externalCommand',json_object('command',c.command,
            'requestedChangeSeq',c.requested_change_seq,'state',c.state,'errorCode',c.error_code))),?3
        FROM cloud_state cs JOIN tasks t ON t.id=?2 JOIN external_commands c ON c.task_id=t.id WHERE cs.singleton=1`)
        .bind(mutation.mutationId,mutation.entityId,acceptedAt),
      insertReceipt(db, mutation, canonicalRequest, canonicalHash, acceptedAt),
    advanceCloudState(db, mutation.mutationId),
      advanceDevice(db, mutation.deviceId, mutation.deviceSequence),
    ]);
  } catch (error) {
    const raced = await findReceipt(db, mutation.mutationId);
    if (raced) return duplicateOrReuse(raced, canonicalHash);
    if(String(error).includes("provider delivery not owned"))throw new ContractError("invalid_transition","The delivery was already reconciled.");
    const latest = await db.prepare(`SELECT state,requested_change_seq FROM external_commands WHERE task_id=?1`)
      .bind(mutation.entityId).first<{ state: string; requested_change_seq: number }>();
    if (latest?.requested_change_seq !== mutation.payload.requestedChangeSeq) {
      throw new ContractError("command_superseded", "The external command was superseded by newer Openza intent.");
    }
    if (latest?.state !== "pending_desktop") {
      throw new ContractError("invalid_transition", "Only a pending external command can be resolved.");
    }
    throw error;
  }
  return requireAcceptedReceipt(db, mutation.mutationId);
}

async function findDuplicate(db: D1Database, mutationId: string, rawRequest: string): Promise<Receipt | null> {
  const receipt = await findReceipt(db, mutationId);
  return receipt ? duplicateOrReuse(receipt, await computeCanonicalHash(rawRequest)) : null;
}

async function requireNextSequence(db: D1Database, deviceId: string, sequence: number): Promise<void> {
  const row = await db.prepare("SELECT last_sequence FROM device_sequences WHERE device_id=?1")
    .bind(deviceId).first<{ last_sequence: number }>();
  if (sequence !== (row?.last_sequence ?? 0) + 1) {
    throw new ContractError("sequence_gap", "The device sequence is not the next expected value.");
  }
}

function deviceClaim(db: D1Database, deviceId: string, sequence: number, mutationId: string) {
  return db.prepare(`INSERT INTO device_sequence_claims(device_id,device_sequence,mutation_id) VALUES(?1,?2,?3)`)
    .bind(deviceId, sequence, mutationId);
}

function appendSourceChange(db: D1Database, mutation: SourceRefreshMutation, acceptedAt: string) {
  return db.prepare(`INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,
    entity_id,entity_version,payload_json,server_accepted_at)
    SELECT cs.next_change_seq+1,1,'tasks',?1,'task.updatedOpenzaFields','task',t.id,
      CASE WHEN s.task_id IS NOT NULL THEN t.entity_version ELSE NULL END,
      json_object('task',json_object('id',t.id,'source',json_object(
        'integrationKind',s.integration_kind,'externalIdHash',s.external_id_hash,'sourceUrl',s.source_url,
        'title',s.source_title,'description',s.source_description,'projectName',s.source_project_name,
        'priority',s.source_priority,'plannedOn',s.source_planned_on,'plannedAt',s.source_planned_at,
        'deadlineOn',s.source_deadline_on,'deadlineAt',s.source_deadline_at,'recurrenceRule',s.recurrence_rule,
        'refreshedAt',s.refreshed_at))),?3
    FROM cloud_state cs LEFT JOIN tasks t ON t.id=?2 AND t.deleted_at IS NULL
      LEFT JOIN source_descriptors s ON s.task_id=t.id AND s.integration_kind=?4 AND s.external_id_hash=?5
    WHERE cs.singleton=1`)
    .bind(mutation.mutationId,mutation.entityId,acceptedAt,mutation.payload.source.integrationKind,mutation.payload.source.externalIdHash);
}

function insertReceipt(
  db: D1Database,
  mutation: SourceRefreshMutation | ExternalCommandResultMutation,
  canonicalRequest: string,
  canonicalHash: string,
  acceptedAt: string,
) {
  return db.prepare(`INSERT INTO mutation_receipts(mutation_id,protocol_version,product,canonical_request,canonical_hash,
    entity_id,entity_version,change_seq,server_accepted_at)
    SELECT ?1,1,'tasks',?2,?3,?4,entity_version,change_seq,?5 FROM changes WHERE mutation_id=?1`)
    .bind(mutation.mutationId, canonicalRequest, canonicalHash, mutation.entityId, acceptedAt);
}

function advanceCloudState(db: D1Database, mutationId: string) {
  return db.prepare(`UPDATE cloud_state SET next_change_seq=(SELECT change_seq FROM changes WHERE mutation_id=?1)
    WHERE singleton=1`).bind(mutationId);
}

function advanceDevice(db: D1Database, deviceId: string, sequence: number) {
  return db.prepare(`INSERT INTO device_sequences(device_id,last_sequence) VALUES(?1,?2)
    ON CONFLICT(device_id) DO UPDATE SET last_sequence=excluded.last_sequence
    WHERE device_sequences.last_sequence+1=excluded.last_sequence`).bind(deviceId, sequence);
}

async function requireAcceptedReceipt(db: D1Database, mutationId: string): Promise<Receipt> {
  const receipt = await findReceipt(db, mutationId);
  if (!receipt) throw new Error("The desktop source mutation finished without a durable receipt.");
  return toReceipt(receipt, "accepted");
}
