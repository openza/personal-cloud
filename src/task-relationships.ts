import { ContractError, canonicalize, computeCanonicalHash, type TaskRelationshipMutation } from "./protocol.ts";
import { duplicateOrReuse, findReceipt, toReceipt, type Receipt } from "./mutation-receipt.ts";

type TaskRow = { entity_version: number; space_id: string; project_id: string | null; parent_id: string | null };

export async function applyTaskRelationship(db: D1Database, mutation: TaskRelationshipMutation, raw: string): Promise<Receipt> {
  const hash = await computeCanonicalHash(raw); const existing = await findReceipt(db, mutation.mutationId);
  if (existing) return duplicateOrReuse(existing, hash);
  const sequence = await db.prepare("SELECT last_sequence FROM device_sequences WHERE device_id=?1").bind(mutation.deviceId).first<{last_sequence:number}>();
  if (mutation.deviceSequence !== (sequence?.last_sequence ?? 0) + 1) throw new ContractError("sequence_gap", "The device sequence is not the next expected value.");
  const task = await db.prepare("SELECT entity_version,space_id,project_id,parent_id FROM tasks WHERE id=?1 AND deleted_at IS NULL").bind(mutation.entityId).first<TaskRow>();
  if (!task) throw new ContractError("entity_not_found", "The task does not exist.");
  if (task.entity_version !== mutation.baseEntityVersion) throw new ContractError("version_conflict", "The task changed after this mutation was prepared.");

  const version = task.entity_version + 1; const acceptedAt = new Date().toISOString();
  let changeOperation: string; let payload: unknown; const domain: D1PreparedStatement[] = [];
  if (mutation.operation === "task.setProject") {
    if (task.project_id === mutation.payload.project?.id || (task.project_id === null && mutation.payload.project === null)) {
      throw new ContractError("invalid_request", "The task project is unchanged.");
    }
    if (mutation.payload.project !== null) {
      const reference=await db.prepare("SELECT space_id,deleted_at,status FROM projects WHERE id=?1").bind(mutation.payload.project.id).first<{space_id:string,deleted_at:string|null,status:string}>();
      if(reference&&(reference.space_id!==task.space_id||reference.deleted_at||reference.status==="archived"))throw new ContractError("invalid_request","An unarchived project in the task Space is required.");
      domain.push(db.prepare("INSERT INTO projects(id,space_id,name) VALUES(?1,?2,?3) ON CONFLICT(id) DO NOTHING").bind(mutation.payload.project.id, task.space_id, mutation.payload.project.name));
    }
    domain.push(db.prepare("UPDATE tasks SET project_id=?1,entity_version=?2 WHERE id=?3 AND entity_version=?4").bind(mutation.payload.project?.id ?? null,version,mutation.entityId,task.entity_version));
    changeOperation="task.projectSet"; payload={task:{id:mutation.entityId,projectId:mutation.payload.project?.id ?? null,project:mutation.payload.project}};
  } else if (mutation.operation === "task.move") {
    const reference=await db.prepare("SELECT deleted_at,is_archived FROM spaces WHERE id=?1").bind(mutation.payload.space.id).first<{deleted_at:string|null,is_archived:number}>();
    if(reference&&(reference.deleted_at||reference.is_archived))throw new ContractError("invalid_request","An active target Space is required.");
    if (task.space_id === mutation.payload.space.id) throw new ContractError("invalid_request", "The task is already in this Space.");
    domain.push(db.prepare("INSERT INTO spaces(id,name,deleted_at) VALUES(?1,?2,NULL) ON CONFLICT(id) DO NOTHING").bind(mutation.payload.space.id,mutation.payload.space.name));
    domain.push(db.prepare("UPDATE tasks SET space_id=?1,project_id=NULL,parent_id=NULL,entity_version=?2 WHERE id=?3 AND entity_version=?4").bind(mutation.payload.space.id,version,mutation.entityId,task.entity_version));
    changeOperation="task.moved"; payload={task:{id:mutation.entityId,spaceId:mutation.payload.space.id,space:mutation.payload.space,projectId:null,parentId:null}};
  } else if (mutation.operation === "task.addLabel") {
    const linked=await db.prepare("SELECT 1 AS found FROM task_labels WHERE task_id=?1 AND label_id=?2").bind(mutation.entityId,mutation.payload.label.id).first();
    if(linked) throw new ContractError("invalid_request","The label is already attached.");
    domain.push(db.prepare("INSERT INTO labels(id,name) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET name=excluded.name").bind(mutation.payload.label.id,mutation.payload.label.name));
    domain.push(db.prepare("INSERT INTO task_labels(task_id,label_id) VALUES(?1,?2)").bind(mutation.entityId,mutation.payload.label.id));
    domain.push(db.prepare("UPDATE tasks SET entity_version=?1 WHERE id=?2 AND entity_version=?3").bind(version,mutation.entityId,task.entity_version));
    changeOperation="task.labelAdded"; payload={task:{id:mutation.entityId,label:mutation.payload.label}};
  } else if (mutation.operation === "task.removeLabel") {
    const linked=await db.prepare("SELECT 1 AS found FROM task_labels WHERE task_id=?1 AND label_id=?2").bind(mutation.entityId,mutation.payload.labelId).first();
    if(!linked) throw new ContractError("invalid_request","The label is not attached.");
    domain.push(db.prepare("DELETE FROM task_labels WHERE task_id=?1 AND label_id=?2").bind(mutation.entityId,mutation.payload.labelId));
    domain.push(db.prepare("UPDATE tasks SET entity_version=?1 WHERE id=?2 AND entity_version=?3").bind(version,mutation.entityId,task.entity_version));
    changeOperation="task.labelRemoved"; payload={task:{id:mutation.entityId,labelId:mutation.payload.labelId}};
  } else {
    if (mutation.payload.parentId === mutation.entityId) throw new ContractError("invalid_request", "A task cannot parent itself.");
    if (mutation.payload.parentId !== null) {
      const parent=await db.prepare("SELECT space_id,parent_id FROM tasks WHERE id=?1 AND deleted_at IS NULL").bind(mutation.payload.parentId).first<{space_id:string,parent_id:string|null}>();
      if(!parent || parent.space_id!==task.space_id) throw new ContractError("parent_not_found","The parent must exist in the same Space.");
      const cycle = await db.prepare(`WITH RECURSIVE ancestors(id,parent_id) AS (
        SELECT id,parent_id FROM tasks WHERE id=?1
        UNION SELECT t.id,t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id
      ) SELECT 1 AS found FROM ancestors WHERE id=?2 LIMIT 1`)
        .bind(mutation.payload.parentId, mutation.entityId).first();
      if(cycle) throw new ContractError("invalid_request","The parent relationship would create a cycle.");
    }
    if(task.parent_id===mutation.payload.parentId) throw new ContractError("invalid_request","The parent is unchanged.");
    domain.push(db.prepare("UPDATE tasks SET parent_id=?1,entity_version=?2 WHERE id=?3 AND entity_version=?4").bind(mutation.payload.parentId,version,mutation.entityId,task.entity_version));
    changeOperation="task.parentSet"; payload={task:{id:mutation.entityId,parentId:mutation.payload.parentId}};
  }
  const payloadJson=canonicalize(JSON.stringify(payload));
  const statements=[
    db.prepare("INSERT INTO device_sequence_claims(device_id,device_sequence,mutation_id) VALUES(?1,?2,?3)").bind(mutation.deviceId,mutation.deviceSequence,mutation.mutationId),
    db.prepare("INSERT INTO entity_version_claims(entity_id,base_entity_version,mutation_id) VALUES(?1,?2,?3)").bind(mutation.entityId,task.entity_version,mutation.mutationId),
    ...domain,
    db.prepare("INSERT INTO changes(change_seq,protocol_version,product,mutation_id,operation,entity_kind,entity_id,entity_version,payload_json,server_accepted_at) SELECT next_change_seq+1,1,'tasks',?1,?2,'task',?3,?4,?5,?6 FROM cloud_state WHERE singleton=1").bind(mutation.mutationId,changeOperation,mutation.entityId,version,payloadJson,acceptedAt),
    db.prepare("INSERT INTO mutation_receipts(mutation_id,protocol_version,product,canonical_request,canonical_hash,entity_id,entity_version,change_seq,server_accepted_at) SELECT ?1,1,'tasks',?2,?3,?4,?5,change_seq,?6 FROM changes WHERE mutation_id=?1").bind(mutation.mutationId,canonicalize(raw),hash,mutation.entityId,version,acceptedAt),
    db.prepare("UPDATE cloud_state SET next_change_seq=(SELECT change_seq FROM changes WHERE mutation_id=?1) WHERE singleton=1").bind(mutation.mutationId),
    db.prepare("INSERT INTO device_sequences(device_id,last_sequence) VALUES(?1,?2) ON CONFLICT(device_id) DO UPDATE SET last_sequence=excluded.last_sequence WHERE device_sequences.last_sequence+1=excluded.last_sequence").bind(mutation.deviceId,mutation.deviceSequence),
  ];
  try { await db.batch(statements); } catch(error) {
    const raced=await findReceipt(db,mutation.mutationId); if(raced) return duplicateOrReuse(raced,hash);
    if (String(error).includes("task parent cycle")) throw new ContractError("invalid_request", "The parent relationship would create a cycle.");
    if(String(error).includes('active target Space required')||String(error).includes('active target project required'))throw new ContractError('invalid_request','An active target Space and unarchived project are required.');
    throw error;
  }
  const receipt=await findReceipt(db,mutation.mutationId); if(!receipt) throw new Error("Relationship mutation completed without a receipt.");
  return toReceipt(receipt,"accepted");
}
