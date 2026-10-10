UPDATE tombstones
SET purge_after = strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at, '+30 days')
WHERE purge_after IS NULL;

CREATE TRIGGER tombstones_default_retention
AFTER INSERT ON tombstones
WHEN NEW.purge_after IS NULL
BEGIN
  UPDATE tombstones
  SET purge_after = strftime('%Y-%m-%dT%H:%M:%fZ', NEW.deleted_at, '+30 days')
  WHERE entity_kind = NEW.entity_kind AND entity_id = NEW.entity_id;
END;
