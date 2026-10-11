-- One physical provider source must not have concurrent delivery owners, even
-- when an old started task is deleted and another task adopts that source.
CREATE UNIQUE INDEX provider_delivery_one_active_source
  ON provider_delivery_claims(integration_kind,external_id_hash)
  WHERE state IN ('reserved','started');

CREATE TRIGGER provider_delivery_reservation_unambiguous
BEFORE INSERT ON provider_delivery_claims
WHEN (SELECT count(*) FROM source_descriptors s JOIN tasks t ON t.id=s.task_id
  WHERE s.integration_kind=NEW.integration_kind AND s.external_id_hash=NEW.external_id_hash
    AND t.deleted_at IS NULL)<>1
BEGIN SELECT RAISE(ABORT,'provider source ambiguous'); END;

CREATE TRIGGER provider_delivery_start_unambiguous
BEFORE UPDATE OF state ON provider_delivery_claims
WHEN NEW.state='started' AND OLD.state='reserved' AND
  (SELECT count(*) FROM source_descriptors s JOIN tasks t ON t.id=s.task_id
    WHERE s.integration_kind=NEW.integration_kind AND s.external_id_hash=NEW.external_id_hash
      AND t.deleted_at IS NULL)<>1
BEGIN SELECT RAISE(ABORT,'provider source ambiguous'); END;
