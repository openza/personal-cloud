-- Current Desktop catch-up is separate from terminal initial-upload progress.
CREATE TABLE sync_catchup_status (
 device_id TEXT PRIMARY KEY REFERENCES devices(device_id),
 report_sequence INTEGER NOT NULL CHECK(report_sequence>0),
 state TEXT NOT NULL CHECK(state IN ('catching_up','idle')),
 pending INTEGER NOT NULL CHECK(pending>=0),
 finished_at TEXT,
 updated_at TEXT NOT NULL
);

-- One shared Web fan-out allowance per owner cloud and UTC day. A named CHECK
-- also gives an atomic eligibility/allowance failure a safe distinct identity.
CREATE TABLE web_fanout_budget (
 day TEXT PRIMARY KEY,
 credits INTEGER NOT NULL CONSTRAINT web_fanout_cap CHECK(credits>=0 AND credits<=12000)
);

-- Explicit owner recovery of one unapplied Web fan-out mutation. Its original
-- sequence claim is consumed atomically, preventing late original application.
CREATE TABLE web_pending_resolutions (
 mutation_id TEXT PRIMARY KEY,
 device_id TEXT NOT NULL,
 device_sequence INTEGER NOT NULL CHECK(device_sequence>0),
 canonical_hash TEXT NOT NULL,
 canonical_request TEXT NOT NULL,
 cancelled_at TEXT NOT NULL,
 UNIQUE(device_id,device_sequence)
);
CREATE TRIGGER web_pending_resolutions_immutable_update BEFORE UPDATE ON web_pending_resolutions
BEGIN SELECT RAISE(ABORT,'Web pending resolutions are immutable'); END;
CREATE TRIGGER web_pending_resolutions_immutable_delete BEFORE DELETE ON web_pending_resolutions
BEGIN SELECT RAISE(ABORT,'Web pending resolutions are immutable'); END;
-- Mutation IDs are global, while sequence claims are per replica. These mutual
-- guards also protect against a different replica/operation already in flight.
CREATE TRIGGER mutation_receipt_not_cancelled BEFORE INSERT ON mutation_receipts
WHEN EXISTS(SELECT 1 FROM web_pending_resolutions WHERE mutation_id=NEW.mutation_id)
BEGIN SELECT RAISE(ABORT,'Mutation ID was explicitly cancelled'); END;
CREATE TRIGGER web_pending_not_applied BEFORE INSERT ON web_pending_resolutions
WHEN EXISTS(SELECT 1 FROM mutation_receipts WHERE mutation_id=NEW.mutation_id)
BEGIN SELECT RAISE(ABORT,'Mutation ID already has a receipt'); END;
