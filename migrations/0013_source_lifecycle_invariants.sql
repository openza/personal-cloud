CREATE TRIGGER source_refresh_must_advance
BEFORE UPDATE OF refreshed_at ON source_descriptors
WHEN NEW.refreshed_at <= OLD.refreshed_at
BEGIN
  SELECT RAISE(ABORT, 'source refresh must advance');
END;

CREATE TABLE external_command_resolutions (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_change_seq INTEGER NOT NULL REFERENCES changes(change_seq),
  mutation_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('confirmed','rejected')),
  resolved_at TEXT NOT NULL,
  error_code TEXT,
  PRIMARY KEY (task_id, requested_change_seq)
);
