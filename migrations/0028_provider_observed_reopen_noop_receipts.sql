CREATE TABLE provider_observed_reopen_noop_receipts (
  mutation_id TEXT PRIMARY KEY,
  canonical_hash TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK(entity_version>0),
  change_seq INTEGER NOT NULL REFERENCES changes(change_seq),
  server_accepted_at TEXT NOT NULL
);

CREATE TRIGGER provider_observed_reopen_noop_receipts_immutable_update BEFORE UPDATE ON provider_observed_reopen_noop_receipts
BEGIN SELECT RAISE(ABORT,'provider-observed reopen receipts are immutable'); END;
CREATE TRIGGER provider_observed_reopen_noop_receipts_immutable_delete BEFORE DELETE ON provider_observed_reopen_noop_receipts
BEGIN SELECT RAISE(ABORT,'provider-observed reopen receipts are immutable'); END;
CREATE TRIGGER provider_observed_reopen_noop_not_applied BEFORE INSERT ON provider_observed_reopen_noop_receipts
WHEN EXISTS(SELECT 1 FROM mutation_receipts WHERE mutation_id=NEW.mutation_id)
BEGIN SELECT RAISE(ABORT,'Mutation ID was already applied'); END;
CREATE TRIGGER mutation_receipt_not_provider_observed_reopen_noop BEFORE INSERT ON mutation_receipts
WHEN EXISTS(SELECT 1 FROM provider_observed_reopen_noop_receipts WHERE mutation_id=NEW.mutation_id)
BEGIN SELECT RAISE(ABORT,'Mutation ID was already recorded as a no-op'); END;
