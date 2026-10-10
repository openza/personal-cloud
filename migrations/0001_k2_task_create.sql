CREATE TABLE cloud_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  next_change_seq INTEGER NOT NULL CHECK (next_change_seq >= 0)
);

INSERT INTO cloud_state (singleton, next_change_seq) VALUES (1, 0);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  deleted_at TEXT
);

INSERT INTO spaces (id, deleted_at) VALUES ('space_default', NULL);

CREATE TABLE device_sequences (
  device_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL CHECK (last_sequence > 0)
);

CREATE TABLE device_sequence_claims (
  device_id TEXT NOT NULL,
  device_sequence INTEGER NOT NULL CHECK (device_sequence > 0),
  mutation_id TEXT NOT NULL,
  PRIMARY KEY (device_id, device_sequence),
  UNIQUE (device_id, mutation_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  product TEXT NOT NULL CHECK (product = 'tasks'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  title TEXT NOT NULL,
  completion_state TEXT NOT NULL CHECK (completion_state = 'open'),
  workflow_status TEXT NOT NULL CHECK (workflow_status = 'inbox'),
  created_at TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version = 1),
  created_by_mutation_id TEXT NOT NULL UNIQUE
);

CREATE TABLE changes (
  change_seq INTEGER PRIMARY KEY CHECK (change_seq > 0),
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
  product TEXT NOT NULL CHECK (product = 'tasks'),
  mutation_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation = 'task.created'),
  entity_kind TEXT NOT NULL CHECK (entity_kind = 'task'),
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version = 1),
  payload_json TEXT NOT NULL,
  server_accepted_at TEXT NOT NULL
);

CREATE TABLE mutation_receipts (
  mutation_id TEXT PRIMARY KEY,
  protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
  product TEXT NOT NULL CHECK (product = 'tasks'),
  canonical_request TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version = 1),
  change_seq INTEGER NOT NULL UNIQUE REFERENCES changes(change_seq),
  server_accepted_at TEXT NOT NULL
);

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
