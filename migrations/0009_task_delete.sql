PRAGMA defer_foreign_keys = ON;

ALTER TABLE tasks ADD COLUMN deleted_at TEXT;

CREATE TABLE tombstones (
  entity_kind TEXT NOT NULL CHECK (entity_kind = 'task'),
  entity_id TEXT PRIMARY KEY,
  entity_version INTEGER NOT NULL CHECK (entity_version > 0),
  deleted_at TEXT NOT NULL,
  purge_after TEXT
);

DROP TRIGGER mutation_receipts_are_immutable_before_update;
DROP TRIGGER mutation_receipts_are_immutable_before_delete;
ALTER TABLE mutation_receipts RENAME TO mutation_receipts_reopen_checkpoint;
ALTER TABLE changes RENAME TO changes_reopen_checkpoint;

CREATE TABLE changes (
  change_seq INTEGER PRIMARY KEY CHECK (change_seq > 0),
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
  product TEXT NOT NULL CHECK (product = 'tasks'),
  mutation_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN (
    'task.created', 'task.updatedOpenzaFields', 'task.completed', 'task.reopened', 'task.deleted'
  )),
  entity_kind TEXT NOT NULL CHECK (entity_kind = 'task'),
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version > 0),
  payload_json TEXT NOT NULL,
  server_accepted_at TEXT NOT NULL
);
INSERT INTO changes SELECT * FROM changes_reopen_checkpoint;

CREATE TABLE mutation_receipts (
  mutation_id TEXT PRIMARY KEY,
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
  product TEXT NOT NULL CHECK (product = 'tasks'),
  canonical_request TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version > 0),
  change_seq INTEGER NOT NULL UNIQUE REFERENCES changes(change_seq),
  server_accepted_at TEXT NOT NULL
);
INSERT INTO mutation_receipts SELECT * FROM mutation_receipts_reopen_checkpoint;
DROP TABLE mutation_receipts_reopen_checkpoint;
DROP TABLE changes_reopen_checkpoint;

CREATE TRIGGER mutation_receipts_are_immutable_before_update BEFORE UPDATE ON mutation_receipts
BEGIN SELECT RAISE(ABORT, 'mutation receipts are immutable'); END;
CREATE TRIGGER mutation_receipts_are_immutable_before_delete BEFORE DELETE ON mutation_receipts
BEGIN SELECT RAISE(ABORT, 'mutation receipts are immutable'); END;

PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys = OFF;
