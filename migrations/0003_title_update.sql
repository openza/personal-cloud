DROP TRIGGER mutation_receipts_are_immutable_before_update;
DROP TRIGGER mutation_receipts_are_immutable_before_delete;

ALTER TABLE mutation_receipts RENAME TO mutation_receipts_k2;
ALTER TABLE changes RENAME TO changes_k2;
ALTER TABLE tasks RENAME TO tasks_k2;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL CHECK (product = 'tasks'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  title TEXT NOT NULL,
  completion_state TEXT NOT NULL CHECK (completion_state = 'open'),
  workflow_status TEXT NOT NULL CHECK (workflow_status = 'inbox'),
  created_at TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version > 0),
  created_by_mutation_id TEXT NOT NULL UNIQUE
);

INSERT INTO tasks
  (id, product, space_id, title, completion_state, workflow_status, created_at,
   entity_version, created_by_mutation_id)
SELECT id, product, space_id, title, completion_state, workflow_status, created_at,
       entity_version, created_by_mutation_id
FROM tasks_k2;

CREATE TABLE changes (
  change_seq INTEGER PRIMARY KEY CHECK (change_seq > 0),
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
  product TEXT NOT NULL CHECK (product = 'tasks'),
  mutation_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('task.created', 'task.updatedOpenzaFields')),
  entity_kind TEXT NOT NULL CHECK (entity_kind = 'task'),
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version > 0),
  payload_json TEXT NOT NULL,
  server_accepted_at TEXT NOT NULL
);

INSERT INTO changes
  (change_seq, protocol_version, product, mutation_id, operation, entity_kind,
   entity_id, entity_version, payload_json, server_accepted_at)
SELECT change_seq, protocol_version, product, mutation_id, operation, entity_kind,
       entity_id, entity_version, payload_json, server_accepted_at
FROM changes_k2;

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

INSERT INTO mutation_receipts
  (mutation_id, protocol_version, product, canonical_request, canonical_hash,
   entity_id, entity_version, change_seq, server_accepted_at)
SELECT mutation_id, protocol_version, product, canonical_request, canonical_hash,
       entity_id, entity_version, change_seq, server_accepted_at
FROM mutation_receipts_k2;

CREATE TABLE entity_version_claims (
  entity_id TEXT NOT NULL,
  base_entity_version INTEGER NOT NULL CHECK (base_entity_version > 0),
  mutation_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (entity_id, base_entity_version)
);

DROP TABLE mutation_receipts_k2;
DROP TABLE changes_k2;
DROP TABLE tasks_k2;

CREATE TRIGGER mutation_receipts_are_immutable_before_update
BEFORE UPDATE ON mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'mutation receipts are immutable');
END;

CREATE TRIGGER mutation_receipts_are_immutable_before_delete
BEFORE DELETE ON mutation_receipts
BEGIN
  SELECT RAISE(ABORT, 'mutation receipts are immutable');
END;
