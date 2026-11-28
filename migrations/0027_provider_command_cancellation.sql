PRAGMA defer_foreign_keys=ON;
DROP TRIGGER provider_delivery_reservation_current;
DROP TRIGGER provider_retry_current;
DROP TRIGGER provider_delivery_start_current;
ALTER TABLE external_commands RENAME TO external_commands_schema26;
CREATE TABLE external_commands (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  command TEXT NOT NULL CHECK (command IN ('complete','reopen')),
  state TEXT NOT NULL CHECK (state IN ('pending_desktop','confirmed','rejected','cancelled')),
  requested_change_seq INTEGER NOT NULL REFERENCES changes(change_seq),
  updated_at TEXT NOT NULL,
  error_code TEXT
);
INSERT INTO external_commands(task_id,command,state,requested_change_seq,updated_at,error_code)
SELECT task_id,command,state,requested_change_seq,updated_at,error_code FROM external_commands_schema26;
DROP TABLE external_commands_schema26;
CREATE INDEX external_commands_cancelled_by_sequence
  ON external_commands(state,requested_change_seq) WHERE state='cancelled';
CREATE TRIGGER provider_delivery_reservation_current
BEFORE INSERT ON provider_delivery_claims
WHEN NOT EXISTS (
  SELECT 1 FROM external_commands c JOIN tasks t ON t.id=c.task_id
  JOIN source_descriptors s ON s.task_id=t.id
  WHERE c.task_id=NEW.task_id AND c.requested_change_seq=NEW.requested_change_seq
    AND c.command=NEW.command AND c.state='pending_desktop' AND t.deleted_at IS NULL
    AND s.integration_kind=NEW.integration_kind AND s.external_id_hash=NEW.external_id_hash
    AND EXISTS(SELECT 1 FROM devices d WHERE d.device_id=NEW.device_id AND d.revoked_at IS NULL AND d.can_bridge_provider=1)
)
BEGIN SELECT RAISE(ABORT,'provider delivery superseded'); END;
CREATE TRIGGER provider_retry_current
BEFORE INSERT ON provider_command_retries
WHEN NOT EXISTS (
  SELECT 1 FROM external_commands c JOIN tasks t ON t.id=c.task_id JOIN source_descriptors s ON s.task_id=t.id
  WHERE c.task_id=NEW.task_id AND c.requested_change_seq=NEW.requested_change_seq AND c.state='rejected'
    AND t.deleted_at IS NULL AND s.integration_kind=NEW.integration_kind AND s.external_id_hash=NEW.external_id_hash
    AND EXISTS(SELECT 1 FROM devices d WHERE d.device_id=NEW.device_id AND d.revoked_at IS NULL AND d.can_bridge_provider=1)
) OR EXISTS(SELECT 1 FROM provider_delivery_claims p WHERE p.task_id=NEW.task_id AND p.state IN('reserved','started'))
BEGIN SELECT RAISE(ABORT,'provider retry superseded'); END;
CREATE TRIGGER provider_delivery_start_current
BEFORE UPDATE OF state ON provider_delivery_claims
WHEN NEW.state='started' AND OLD.state='reserved' AND NOT EXISTS (
  SELECT 1 FROM external_commands c JOIN tasks t ON t.id=c.task_id
  WHERE c.task_id=NEW.task_id AND c.requested_change_seq=NEW.requested_change_seq
    AND c.command=NEW.command AND c.state='pending_desktop' AND t.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM devices d WHERE d.device_id=NEW.device_id AND d.revoked_at IS NULL AND d.can_bridge_provider=1)
)
BEGIN SELECT RAISE(ABORT,'provider delivery superseded'); END;
PRAGMA defer_foreign_keys=OFF;
