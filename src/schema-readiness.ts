import {throwDailyQuota} from "./daily-quota.ts";
// Schema 25 readiness checks metadata and resolves required columns without reading rows.
// This is a readiness contract, not a replacement for checksum migration preflight.
const requiredColumns: Record<string, readonly string[]> = {
  auth_challenges: ["challenge_hash", "purpose", "credential_id", "expires_at", "consumed_at", "attempt_count", "created_at"],
  auth_rate_limits: ["bucket", "window_started_at", "attempt_count"],
  changes: ["change_seq", "protocol_version", "product", "mutation_id", "operation", "entity_kind", "entity_id", "entity_version", "payload_json", "server_accepted_at"],
  cloud_state: ["singleton", "next_change_seq"],
  device_access_tokens: ["token_hash", "device_id", "created_at", "expires_at", "revoked_at"],
  device_checkpoints: ["instance_id", "product", "device_id", "last_change_seq", "updated_at"],
  device_refresh_credentials: ["credential_hash", "device_id", "created_at", "expires_at", "revoked_at"],
  device_sequence_claims: ["device_id", "device_sequence", "mutation_id"],
  device_sequences: ["device_id", "last_sequence"],
  devices: ["device_id", "display_name", "kind", "can_sync", "can_bridge_provider", "created_at", "last_seen_at", "revoked_at"],
  emergency_rebootstrap_audit: ["audit_id", "prepared_at", "reason"],
  entity_version_claims: ["entity_id", "base_entity_version", "mutation_id"],
  external_command_resolutions: ["task_id", "requested_change_seq", "mutation_id", "state", "resolved_at", "error_code", "claim_id", "resolving_device_id"],
  external_commands: ["task_id", "command", "state", "requested_change_seq", "updated_at", "error_code"],
  initial_sync_status: ["device_id", "report_sequence", "state", "acknowledged", "total", "error_code", "updated_at"],
  labels: ["id", "name", "deleted_at"],
  mutation_receipts: ["mutation_id", "protocol_version", "product", "canonical_request", "canonical_hash", "entity_id", "entity_version", "change_seq", "server_accepted_at"],
  owner_bootstrap: ["singleton", "grant_hash", "expires_at", "consumed_at"],
  owner_credentials: ["credential_id", "display_name", "public_key_jwk", "sign_count", "created_at", "last_used_at", "revoked_at"],
  pairing_grants: ["grant_hash", "expires_at", "created_at", "consumed_at", "attempt_count"],
  projects: ["id", "space_id", "name", "deleted_at", "entity_version", "description", "color", "icon", "parent_id", "sort_order", "status", "is_favorite", "created_at", "updated_at"],
  provider_catalog: ["id", "bridge_device_id", "scope_id", "integration_kind", "external_id_hash", "item_json", "entity_version", "refreshed_at", "created_at", "updated_at"],
  provider_command_retries: ["retry_id", "task_id", "requested_change_seq", "new_change_seq", "device_id", "integration_kind", "external_id_hash", "created_at"],
  provider_delivery_claims: ["claim_id", "task_id", "requested_change_seq", "device_id", "command", "integration_kind", "external_id_hash", "state", "created_at", "started_at", "resolved_at", "resolution"],
  provider_intents: ["id", "bridge_device_id", "target_key", "action", "intent_json", "state", "adopted_task_id", "error_code", "entity_version", "created_at", "updated_at"],
  provider_routes: ["id", "bridge_device_id", "route_json", "entity_version", "created_at", "updated_at", "deleted_at"],
  provider_scopes: ["id", "bridge_device_id", "integration_kind", "available", "scope_json", "entity_version", "created_at", "updated_at"],
  recovery_codes: ["version", "verifier_hash", "created_at", "consumed_at", "attempt_count"],
  source_descriptors: ["task_id", "integration_kind", "external_id_hash", "source_url", "source_title", "source_description", "source_project_name", "source_priority", "source_planned_on", "source_planned_at", "source_deadline_on", "source_deadline_at", "recurrence_rule", "refreshed_at"],
  spaces: ["id", "deleted_at", "name", "entity_version", "color", "icon", "sort_order", "is_archived", "created_at", "updated_at"],
  task_labels: ["task_id", "label_id"],
  tasks: ["id", "product", "space_id", "title", "completion_state", "workflow_status", "created_at", "entity_version", "created_by_mutation_id", "priority", "completed_at", "planned_on", "planned_at", "deleted_at", "project_id", "parent_id", "notes", "deadline_on", "deadline_at", "scheduled_start", "scheduled_end", "duration_minutes", "recurrence_rule", "source_owner_device_id", "updated_at"],
  tombstones: ["entity_kind", "entity_id", "entity_version", "deleted_at", "purge_after"],
  web_sessions: ["session_hash", "credential_id", "csrf_hash", "created_at", "rotated_at", "expires_at", "absolute_expires_at", "revoked_at"],
  workspace_cursor_key: ["singleton", "key_hex"],
  workspace_guards: ["id", "valid"],
};

const requiredObjects = [
  ["table", "auth_challenges", "auth_challenges"],
  ["table", "auth_rate_limits", "auth_rate_limits"],
  ["table", "changes", "changes"],
  ["table", "cloud_state", "cloud_state"],
  ["table", "device_access_tokens", "device_access_tokens"],
  ["table", "device_checkpoints", "device_checkpoints"],
  ["table", "device_refresh_credentials", "device_refresh_credentials"],
  ["table", "device_sequence_claims", "device_sequence_claims"],
  ["table", "device_sequences", "device_sequences"],
  ["table", "devices", "devices"],
  ["table", "emergency_rebootstrap_audit", "emergency_rebootstrap_audit"],
  ["table", "entity_version_claims", "entity_version_claims"],
  ["table", "external_command_resolutions", "external_command_resolutions"],
  ["table", "external_commands", "external_commands"],
  ["table", "initial_sync_status", "initial_sync_status"],
  ["table", "labels", "labels"],
  ["table", "mutation_receipts", "mutation_receipts"],
  ["table", "owner_bootstrap", "owner_bootstrap"],
  ["table", "owner_credentials", "owner_credentials"],
  ["table", "pairing_grants", "pairing_grants"],
  ["table", "projects", "projects"],
  ["table", "provider_catalog", "provider_catalog"],
  ["table", "provider_command_retries", "provider_command_retries"],
  ["table", "provider_delivery_claims", "provider_delivery_claims"],
  ["table", "provider_intents", "provider_intents"],
  ["table", "provider_routes", "provider_routes"],
  ["table", "provider_scopes", "provider_scopes"],
  ["table", "recovery_codes", "recovery_codes"],
  ["table", "source_descriptors", "source_descriptors"],
  ["table", "spaces", "spaces"],
  ["table", "task_labels", "task_labels"],
  ["table", "tasks", "tasks"],
  ["table", "tombstones", "tombstones"],
  ["table", "web_sessions", "web_sessions"],
  ["table", "workspace_cursor_key", "workspace_cursor_key"],
  ["table", "workspace_guards", "workspace_guards"],
  ["index", "changes_by_entity_operation", "changes"],
  ["index", "changes_source_history_by_entity", "changes"],
  ["index", "device_access_tokens_active_by_device", "device_access_tokens"],
  ["index", "entity_version_claims_mutation", "entity_version_claims"],
  ["index", "owner_credentials_single_active", "owner_credentials"],
  ["index", "provider_catalog_scope", "provider_catalog"],
  ["index", "provider_delivery_one_active_source", "provider_delivery_claims"],
  ["index", "provider_delivery_one_active_task", "provider_delivery_claims"],
  ["index", "provider_intent_one_unresolved", "provider_intents"],
  ["index", "provider_intents_pending_bridge", "provider_intents"],
  ["index", "provider_intents_target_latest", "provider_intents"],
  ["index", "provider_scopes_bridge", "provider_scopes"],
  ["index", "source_descriptors_identity", "source_descriptors"],
  ["index", "web_sessions_active_by_credential", "web_sessions"],
  ["trigger", "auth_challenge_is_one_use", "auth_challenges"],
  ["trigger", "changes_workspace_response_limit", "changes"],
  ["trigger", "mutation_receipts_are_immutable_before_delete", "mutation_receipts"],
  ["trigger", "mutation_receipts_are_immutable_before_update", "mutation_receipts"],
  ["trigger", "pairing_grant_is_one_use", "pairing_grants"],
  ["trigger", "provider_delivery_reservation_current", "provider_delivery_claims"],
  ["trigger", "provider_delivery_reservation_unambiguous", "provider_delivery_claims"],
  ["trigger", "provider_delivery_result_owned", "external_command_resolutions"],
  ["trigger", "provider_delivery_start_current", "provider_delivery_claims"],
  ["trigger", "provider_delivery_start_unambiguous", "provider_delivery_claims"],
  ["trigger", "provider_retry_current", "provider_command_retries"],
  ["trigger", "recovery_code_is_one_use", "recovery_codes"],
  ["trigger", "source_refresh_must_advance", "source_descriptors"],
  ["trigger", "tasks_accepted_updated_at", "changes"],
  ["trigger", "tasks_initial_updated_at", "tasks"],
  ["trigger", "tasks_parent_cycle_before_insert", "tasks"],
  ["trigger", "tasks_parent_cycle_before_update", "tasks"],
  ["trigger", "tombstones_default_retention", "tombstones"],
  ["trigger", "workspace_label_link_active", "task_labels"],
  ["trigger", "workspace_project_parent_cycle", "projects"],
  ["trigger", "workspace_project_parent_cycle_insert", "projects"],
  ["trigger", "workspace_task_project_insert", "tasks"],
  ["trigger", "workspace_task_project_update", "tasks"],
  ["trigger", "workspace_task_space_insert", "tasks"],
  ["trigger", "workspace_task_space_update", "tasks"],
 ] as const;

// Read metadata once rather than rescanning sqlite_master for each required object.
// Both the returned rows and the column probe are bounded by this fixed contract.
// All names are source-controlled identifiers, never request input.
const objectSql = `SELECT type,name,tbl_name FROM sqlite_master
WHERE name IN (${requiredObjects.map(item => `'${item[1]}'`).join(",")})
LIMIT ${requiredObjects.length + 1}`;
// WHERE 0 resolves columns at compilation without scanning application rows.
const columnSql = `SELECT
${Object.entries(requiredColumns).map(([table, columns], index) =>
  `(SELECT ${columns.map(column => `${table}."${column}" IS NULL`).join(" AND ")} FROM ${table} WHERE 0) AS probe_${index}`
).join(",\n")}`;

export async function schemaReady(db: D1Database): Promise<boolean> {
  try {
    const results = await db.batch<{type:string;name:string;tbl_name:string}>([
      db.prepare(objectSql), db.prepare(columnSql),
    ]);
    if (results.length !== 2 || results.some(result => !result.success)) return false;
    const found = new Set(results[0].results.map(item => JSON.stringify([item.type,item.name,item.tbl_name])));
    return requiredObjects.every(item => found.has(JSON.stringify(item)));
  } catch (error) {
    throwDailyQuota(error);
    // Empty, incomplete and unavailable bindings share one public health failure.
    return false;
  }
}
