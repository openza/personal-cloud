PRAGMA defer_foreign_keys = ON;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES spaces(id),
  name TEXT NOT NULL,
  deleted_at TEXT
);

ALTER TABLE spaces ADD COLUMN name TEXT NOT NULL DEFAULT 'Inbox';
ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id);
ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id);

CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE task_labels (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  label_id TEXT NOT NULL REFERENCES labels(id),
  PRIMARY KEY (task_id, label_id)
);

DROP TRIGGER mutation_receipts_are_immutable_before_update;
DROP TRIGGER mutation_receipts_are_immutable_before_delete;
ALTER TABLE mutation_receipts RENAME TO mutation_receipts_relationship_checkpoint;
ALTER TABLE changes RENAME TO changes_relationship_checkpoint;

CREATE TABLE changes (
  change_seq INTEGER PRIMARY KEY CHECK (change_seq > 0),
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
  product TEXT NOT NULL CHECK (product = 'tasks'),
  mutation_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN (
    'task.created', 'task.updatedOpenzaFields', 'task.completed', 'task.reopened', 'task.deleted',
    'task.projectSet', 'task.moved', 'task.labelAdded', 'task.labelRemoved', 'task.parentSet'
  )),
  entity_kind TEXT NOT NULL CHECK (entity_kind = 'task'),
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version > 0),
  payload_json TEXT NOT NULL,
  server_accepted_at TEXT NOT NULL
);
INSERT INTO changes SELECT * FROM changes_relationship_checkpoint;

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
INSERT INTO mutation_receipts SELECT * FROM mutation_receipts_relationship_checkpoint;
DROP TABLE mutation_receipts_relationship_checkpoint;
DROP TABLE changes_relationship_checkpoint;

CREATE TRIGGER mutation_receipts_are_immutable_before_update BEFORE UPDATE ON mutation_receipts
BEGIN SELECT RAISE(ABORT, 'mutation receipts are immutable'); END;
CREATE TRIGGER mutation_receipts_are_immutable_before_delete BEFORE DELETE ON mutation_receipts
BEGIN SELECT RAISE(ABORT, 'mutation receipts are immutable'); END;

PRAGMA foreign_key_check;
PRAGMA defer_foreign_keys = OFF;
