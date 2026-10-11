CREATE TABLE provider_delivery_claims (
  claim_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_change_seq INTEGER NOT NULL REFERENCES changes(change_seq),
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  command TEXT NOT NULL CHECK(command IN ('complete','reopen')),
  integration_kind TEXT NOT NULL,
  external_id_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','started','resolved','cancelled')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  resolved_at TEXT,
  resolution TEXT CHECK(resolution IN ('confirmed','rejected','owner_reconciled'))
);
CREATE UNIQUE INDEX provider_delivery_one_active_task ON provider_delivery_claims(task_id)
  WHERE state IN ('reserved','started');

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

ALTER TABLE external_command_resolutions ADD COLUMN claim_id TEXT REFERENCES provider_delivery_claims(claim_id);
ALTER TABLE external_command_resolutions ADD COLUMN resolving_device_id TEXT;
CREATE TRIGGER provider_delivery_result_owned
BEFORE INSERT ON external_command_resolutions
WHEN NOT EXISTS (
  SELECT 1 FROM provider_delivery_claims p WHERE p.claim_id=NEW.claim_id
    AND p.task_id=NEW.task_id AND p.requested_change_seq=NEW.requested_change_seq
    AND p.device_id=NEW.resolving_device_id AND p.state='started'
    AND EXISTS(SELECT 1 FROM devices d WHERE d.device_id=p.device_id AND d.revoked_at IS NULL AND d.can_bridge_provider=1)
)
BEGIN SELECT RAISE(ABORT,'provider delivery not owned'); END;

CREATE TABLE provider_command_retries (
  retry_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_change_seq INTEGER NOT NULL REFERENCES changes(change_seq),
  new_change_seq INTEGER REFERENCES changes(change_seq),
  device_id TEXT NOT NULL REFERENCES devices(device_id),
  integration_kind TEXT NOT NULL,
  external_id_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER provider_retry_current
BEFORE INSERT ON provider_command_retries
WHEN NOT EXISTS (
  SELECT 1 FROM external_commands c JOIN tasks t ON t.id=c.task_id JOIN source_descriptors s ON s.task_id=t.id
  WHERE c.task_id=NEW.task_id AND c.requested_change_seq=NEW.requested_change_seq AND c.state='rejected'
    AND t.deleted_at IS NULL AND s.integration_kind=NEW.integration_kind AND s.external_id_hash=NEW.external_id_hash
    AND EXISTS(SELECT 1 FROM devices d WHERE d.device_id=NEW.device_id AND d.revoked_at IS NULL AND d.can_bridge_provider=1)
) OR EXISTS(SELECT 1 FROM provider_delivery_claims p WHERE p.task_id=NEW.task_id AND p.state IN ('reserved','started'))
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
