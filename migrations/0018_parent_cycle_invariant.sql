-- Enforce the full parent chain inside the serialized write, not only before it.
-- UNION deduplicates ancestors and terminates even with historical cyclic data.
CREATE TRIGGER tasks_parent_cycle_before_update
BEFORE UPDATE OF parent_id ON tasks
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'task parent cycle') WHERE EXISTS (
    WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM tasks WHERE id=NEW.parent_id
      UNION SELECT t.id,t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  );
END;

CREATE TRIGGER tasks_parent_cycle_before_insert
BEFORE INSERT ON tasks
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'task parent cycle') WHERE NEW.parent_id=NEW.id OR EXISTS (
    WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM tasks WHERE id=NEW.parent_id
      UNION SELECT t.id,t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.parent_id
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  );
END;
