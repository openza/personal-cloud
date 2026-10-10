CREATE TABLE source_descriptors (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  integration_kind TEXT NOT NULL CHECK (length(integration_kind) BETWEEN 1 AND 64),
  external_id_hash TEXT NOT NULL CHECK (length(external_id_hash) = 64),
  source_url TEXT,
  source_title TEXT NOT NULL,
  source_description TEXT,
  source_project_name TEXT,
  source_priority INTEGER,
  source_planned_on TEXT,
  source_planned_at TEXT,
  source_deadline_on TEXT,
  source_deadline_at TEXT,
  recurrence_rule TEXT,
  refreshed_at TEXT NOT NULL
);

CREATE TABLE external_commands (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  command TEXT NOT NULL CHECK (command IN ('complete','reopen')),
  state TEXT NOT NULL CHECK (state IN ('pending_desktop','confirmed','rejected')),
  requested_change_seq INTEGER NOT NULL REFERENCES changes(change_seq),
  updated_at TEXT NOT NULL,
  error_code TEXT
);
