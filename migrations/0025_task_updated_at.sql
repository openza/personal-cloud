-- Preserve the accepted modification time independently of compacted history.
-- A historical task without surviving history has an unknown modification time.
ALTER TABLE tasks ADD COLUMN updated_at TEXT;
WITH task_times AS MATERIALIZED (
  SELECT entity_id AS id, entity_version AS version, server_accepted_at AS accepted_at
  FROM changes WHERE entity_kind='task'
  UNION ALL
  SELECT json_extract(t.value,'$.id'), json_extract(t.value,'$.entityVersion'), c.server_accepted_at
  FROM changes c, json_each(c.payload_json,'$.tasks') t WHERE c.operation='workspace.changed'
)
UPDATE tasks SET updated_at = COALESCE(
  (SELECT MAX(accepted_at) FROM task_times WHERE id=tasks.id AND version=tasks.entity_version),
  CASE WHEN entity_version=1 THEN created_at ELSE NULL END
);

CREATE TRIGGER tasks_initial_updated_at AFTER INSERT ON tasks
BEGIN
  UPDATE tasks SET updated_at=NEW.created_at WHERE id=NEW.id;
END;

CREATE TRIGGER tasks_accepted_updated_at AFTER INSERT ON changes
WHEN NEW.entity_kind='task' OR NEW.operation='workspace.changed'
BEGIN
  UPDATE tasks SET updated_at=NEW.server_accepted_at
  WHERE (NEW.entity_kind='task' AND id=NEW.entity_id)
     OR (NEW.operation='workspace.changed' AND id IN
         (SELECT json_extract(value,'$.id') FROM json_each(NEW.payload_json,'$.tasks')));
END;
