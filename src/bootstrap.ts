import { ContractError } from "./protocol.ts";
import {spaceJson,projectJson,taskJson,scopeJson,catalogJson,intentJson,routeJson} from './workspace-records.ts';
import {maximumSyncResponseBytes,utf8Bytes} from './workspace-paging.ts';

export async function bootstrap(db:D1Database,workspace=false){
 const statements=[
  db.prepare('SELECT next_change_seq FROM cloud_state WHERE singleton=1'),
  db.prepare(workspace?`SELECT ${spaceJson} AS record FROM spaces s ORDER BY s.id`:'SELECT id,name,deleted_at AS deletedAt FROM spaces ORDER BY id'),
  db.prepare(workspace?`SELECT ${projectJson} AS record FROM projects p ORDER BY p.id`:'SELECT id,space_id AS spaceId,name,deleted_at AS deletedAt FROM projects ORDER BY id'),
  db.prepare(workspace?`SELECT ${taskJson} AS record FROM tasks t ORDER BY t.id`:`SELECT id,space_id AS spaceId,project_id AS projectId,parent_id AS parentId,title,completion_state AS completionState,workflow_status AS workflowStatus,priority,planned_on AS plannedOn,planned_at AS plannedAt,notes,deadline_on AS deadlineOn,completed_at AS completedAt,created_at AS createdAt,entity_version AS entityVersion,deleted_at AS deletedAt FROM tasks ORDER BY id`),
  db.prepare('SELECT id,name,deleted_at AS deletedAt FROM labels ORDER BY id'),
  db.prepare('SELECT task_id AS taskId,label_id AS labelId FROM task_labels ORDER BY task_id,label_id'),
  db.prepare('SELECT entity_kind AS entityKind,entity_id AS entityId,entity_version AS entityVersion,deleted_at AS deletedAt,purge_after AS purgeAfter FROM tombstones ORDER BY entity_id'),
  db.prepare(`SELECT task_id AS taskId,integration_kind AS integrationKind,external_id_hash AS externalIdHash,source_url AS sourceUrl,source_title AS title,source_description AS description,source_project_name AS projectName,source_priority AS priority,source_planned_on AS plannedOn,source_planned_at AS plannedAt,source_deadline_on AS deadlineOn,source_deadline_at AS deadlineAt,recurrence_rule AS recurrenceRule,refreshed_at AS refreshedAt FROM source_descriptors ORDER BY task_id`),
  db.prepare('SELECT task_id AS taskId,command,state,requested_change_seq AS requestedChangeSeq,updated_at AS updatedAt,error_code AS errorCode FROM external_commands ORDER BY task_id'),
  db.prepare("SELECT 1 AS found FROM changes WHERE operation='workspace.changed' LIMIT 1")
 ];
 if(workspace)statements.push(db.prepare(`SELECT ${scopeJson} AS record FROM provider_scopes sc ORDER BY sc.id`),db.prepare(`SELECT ${catalogJson} AS record FROM provider_catalog c ORDER BY c.id`),db.prepare(`SELECT ${intentJson} AS record FROM provider_intents i WHERE NOT EXISTS(SELECT 1 FROM provider_intents n WHERE n.target_key=i.target_key AND (n.created_at>i.created_at OR (n.created_at=i.created_at AND n.rowid>i.rowid))) ORDER BY i.id`),db.prepare(`SELECT ${routeJson} AS record FROM provider_routes r ORDER BY r.id`));
 const r=await db.batch(statements);if(!workspace&&r[9].results.length)throw new ContractError('upgrade_required','This workspace requires a Desktop supporting workspace v1.');
 const records=(i:number)=>workspace?r[i].results.map((row:any)=>JSON.parse(row.record)):r[i].results;
 const snapshot:any={spaces:records(1),projects:records(2),tasks:records(3),labels:r[4].results,taskLabels:r[5].results,tombstones:r[6].results,sourceDescriptors:r[7].results,externalCommands:r[8].results};
 if(workspace)Object.assign(snapshot,{scopes:records(10),catalog:records(11),intents:records(12),routes:records(13)});
 const result={protocolVersion:1 as const,product:'tasks' as const,checkpoint:(r[0].results[0] as {next_change_seq:number}).next_change_seq,snapshot};
 if(utf8Bytes(result)>maximumSyncResponseBytes)throw new ContractError('upgrade_required','This workspace requires bounded sync paging.');return result;
}

export async function compact(db:D1Database, now:string) {
  const timestamp=new Date(now); if(Number.isNaN(timestamp.valueOf()) || timestamp.toISOString()!==now) throw new ContractError("invalid_request","now must be a canonical UTC timestamp.");
  const eligible=await db.prepare(`SELECT t.entity_id FROM tombstones t
    INNER JOIN changes c ON c.entity_id=t.entity_id AND c.operation='task.deleted'
    WHERE t.entity_kind='task' AND t.purge_after<=?1
      AND NOT EXISTS(SELECT 1 FROM device_sequences d WHERE NOT EXISTS(
        SELECT 1 FROM device_checkpoints cp WHERE cp.device_id=d.device_id AND cp.last_change_seq>=c.change_seq))
      AND NOT EXISTS(SELECT 1 FROM tasks child WHERE child.parent_id=t.entity_id AND child.deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM provider_delivery_claims p WHERE p.task_id=t.entity_id AND p.state IN ('reserved','started'))
    ORDER BY t.entity_id LIMIT 100`).bind(now).all<{entity_id:string}>();
  for(const row of eligible.results) {
    await db.batch([
      db.prepare("DELETE FROM task_labels WHERE task_id=?1").bind(row.entity_id),
      db.prepare("UPDATE tasks SET parent_id=NULL WHERE parent_id=?1").bind(row.entity_id),
      db.prepare("DELETE FROM tasks WHERE id=?1 AND deleted_at IS NOT NULL").bind(row.entity_id),
      db.prepare("DELETE FROM tombstones WHERE entity_id=?1").bind(row.entity_id),
    ]);
  }
  return {protocolVersion:1 as const,product:"tasks" as const,purgedEntityIds:eligible.results.map(row=>row.entity_id)};
}
