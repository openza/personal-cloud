ALTER TABLE spaces ADD COLUMN entity_version INTEGER NOT NULL DEFAULT 1 CHECK(entity_version>0);
ALTER TABLE spaces ADD COLUMN color TEXT;
ALTER TABLE spaces ADD COLUMN icon TEXT;
ALTER TABLE spaces ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spaces ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN(0,1));
ALTER TABLE spaces ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE spaces ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE projects ADD COLUMN entity_version INTEGER NOT NULL DEFAULT 1 CHECK(entity_version>0);
ALTER TABLE projects ADD COLUMN description TEXT;
ALTER TABLE projects ADD COLUMN color TEXT;
ALTER TABLE projects ADD COLUMN icon TEXT;
ALTER TABLE projects ADD COLUMN parent_id TEXT REFERENCES projects(id);
ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','completed','archived'));
ALTER TABLE projects ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN(0,1));
ALTER TABLE projects ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE projects ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE tasks ADD COLUMN deadline_at TEXT;
ALTER TABLE tasks ADD COLUMN scheduled_start TEXT;
ALTER TABLE tasks ADD COLUMN scheduled_end TEXT;
ALTER TABLE tasks ADD COLUMN duration_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN recurrence_rule TEXT;
ALTER TABLE tasks ADD COLUMN source_owner_device_id TEXT;
UPDATE tasks SET source_owner_device_id=(SELECT json_extract(canonical_request,'$.deviceId') FROM mutation_receipts WHERE mutation_id=tasks.created_by_mutation_id) WHERE EXISTS(SELECT 1 FROM source_descriptors WHERE task_id=tasks.id);

-- Retained guards turn all compare-and-set preconditions into transaction errors.
CREATE TABLE workspace_guards(id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
CREATE TABLE provider_scopes(
 id TEXT PRIMARY KEY, bridge_device_id TEXT NOT NULL REFERENCES devices(device_id),
 integration_kind TEXT NOT NULL, available INTEGER NOT NULL CHECK(available IN(0,1)),
 scope_json TEXT NOT NULL, entity_version INTEGER NOT NULL CHECK(entity_version>0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX provider_scopes_bridge ON provider_scopes(bridge_device_id,available);
CREATE TABLE provider_catalog(
 id TEXT PRIMARY KEY, bridge_device_id TEXT NOT NULL REFERENCES devices(device_id),
 scope_id TEXT REFERENCES provider_scopes(id),
 integration_kind TEXT NOT NULL, external_id_hash TEXT NOT NULL,
 item_json TEXT NOT NULL, entity_version INTEGER NOT NULL CHECK(entity_version>0),
 refreshed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(integration_kind,external_id_hash)
);
CREATE INDEX provider_catalog_scope ON provider_catalog(scope_id,bridge_device_id);
CREATE TABLE provider_intents(
 id TEXT PRIMARY KEY, bridge_device_id TEXT NOT NULL REFERENCES devices(device_id),
 target_key TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN('adopt','skip','restore','route.put','route.delete')),
 intent_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('pending_desktop','started','uncertain','confirmed','rejected')),
 adopted_task_id TEXT, error_code TEXT, entity_version INTEGER NOT NULL CHECK(entity_version>0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX provider_intent_one_unresolved ON provider_intents(target_key) WHERE state IN('pending_desktop','started','uncertain');
CREATE INDEX provider_intents_target_latest ON provider_intents(target_key,created_at DESC);
CREATE INDEX provider_intents_pending_bridge ON provider_intents(bridge_device_id,state,created_at,id);
CREATE TABLE provider_routes(
 id TEXT PRIMARY KEY, bridge_device_id TEXT NOT NULL REFERENCES devices(device_id),
 route_json TEXT NOT NULL, entity_version INTEGER NOT NULL CHECK(entity_version>0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);

-- D1 migrations run atomically; keep immutable receipts and historical indexes.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE changes_workspace_next(
 change_seq INTEGER PRIMARY KEY CHECK(change_seq>0),protocol_version INTEGER NOT NULL CHECK(protocol_version=1),
 product TEXT NOT NULL CHECK(product='tasks'),mutation_id TEXT NOT NULL UNIQUE,
 operation TEXT NOT NULL CHECK(operation IN('task.created','task.updatedOpenzaFields','task.completed','task.reopened','task.deleted','task.projectSet','task.moved','task.labelAdded','task.labelRemoved','task.parentSet','workspace.changed')),
 entity_kind TEXT NOT NULL CHECK(entity_kind IN('task','workspace')),entity_id TEXT NOT NULL,
 entity_version INTEGER NOT NULL CHECK(entity_version>0),payload_json TEXT NOT NULL,server_accepted_at TEXT NOT NULL
);
INSERT INTO changes_workspace_next SELECT * FROM changes;
DROP TABLE changes;
ALTER TABLE changes_workspace_next RENAME TO changes;
CREATE INDEX changes_by_entity_operation
  ON changes(entity_id, operation, change_seq DESC);

-- Source-less metadata/deletion changes must not make identity recovery scan
-- an entity's entire history. Match the recovery predicate exactly.
CREATE INDEX changes_source_history_by_entity
  ON changes(entity_id, change_seq DESC)
  WHERE coalesce(json_extract(payload_json,'$.task.source.integrationKind'),
                 json_extract(payload_json,'$.source.integrationKind'),
                 CASE WHEN operation='workspace.changed' AND json_extract(payload_json,'$.tasks[0].id')=entity_id
                 THEN json_extract(payload_json,'$.tasks[0].source.integrationKind') END) IS NOT NULL;

CREATE TRIGGER workspace_project_parent_cycle BEFORE UPDATE OF parent_id ON projects WHEN NEW.parent_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'project parent cycle') WHERE NEW.parent_id=NEW.id OR EXISTS(WITH RECURSIVE a(id,parent_id) AS(SELECT id,parent_id FROM projects WHERE id=NEW.parent_id UNION SELECT p.id,p.parent_id FROM projects p JOIN a ON p.id=a.parent_id)SELECT 1 FROM a WHERE id=NEW.id);
END;
CREATE TRIGGER workspace_project_parent_cycle_insert BEFORE INSERT ON projects WHEN NEW.parent_id IS NOT NULL BEGIN
 SELECT RAISE(ABORT,'project parent cycle') WHERE NEW.parent_id=NEW.id;
END;
PRAGMA defer_foreign_keys=OFF;

-- A compound mutation must claim every affected entity version, not only one.
ALTER TABLE entity_version_claims RENAME TO entity_version_claims_single;
CREATE TABLE entity_version_claims(entity_id TEXT NOT NULL,base_entity_version INTEGER NOT NULL CHECK(base_entity_version>0),mutation_id TEXT NOT NULL,PRIMARY KEY(entity_id,base_entity_version),UNIQUE(entity_id,mutation_id));
INSERT INTO entity_version_claims SELECT * FROM entity_version_claims_single;
DROP TABLE entity_version_claims_single;
CREATE INDEX entity_version_claims_mutation ON entity_version_claims(mutation_id,entity_id);
CREATE TRIGGER workspace_task_space_insert BEFORE INSERT ON tasks
WHEN NOT EXISTS(SELECT 1 FROM spaces WHERE id=NEW.space_id AND deleted_at IS NULL AND is_archived=0)
BEGIN SELECT RAISE(ABORT,'active target Space required'); END;
CREATE TRIGGER workspace_task_space_update BEFORE UPDATE OF space_id ON tasks
WHEN NEW.space_id<>OLD.space_id AND NOT EXISTS(SELECT 1 FROM spaces WHERE id=NEW.space_id AND deleted_at IS NULL AND is_archived=0)
BEGIN SELECT RAISE(ABORT,'active target Space required'); END;
CREATE TRIGGER workspace_task_project_insert BEFORE INSERT ON tasks
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND space_id=NEW.space_id AND deleted_at IS NULL AND status<>'archived')
BEGIN SELECT RAISE(ABORT,'active target project required'); END;
CREATE TRIGGER workspace_task_project_update BEFORE UPDATE OF project_id,space_id ON tasks
WHEN NEW.project_id IS NOT NULL AND (NEW.project_id IS NOT OLD.project_id OR NEW.space_id<>OLD.space_id) AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND space_id=NEW.space_id AND deleted_at IS NULL AND status<>'archived')
BEGIN SELECT RAISE(ABORT,'active target project required'); END;
CREATE TRIGGER workspace_label_link_active BEFORE INSERT ON task_labels
WHEN NOT EXISTS(SELECT 1 FROM labels WHERE id=NEW.label_id AND deleted_at IS NULL)
BEGIN SELECT RAISE(ABORT,'active target label required'); END;
