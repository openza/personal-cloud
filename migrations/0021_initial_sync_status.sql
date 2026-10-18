-- One latest initial-upload report per paired desktop; no task content or history.
CREATE TABLE initial_sync_status (
  device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
  report_sequence INTEGER NOT NULL CHECK (report_sequence > 0),
  state TEXT NOT NULL CHECK (state IN ('uploading','complete','blocked')),
  acknowledged INTEGER,
  total INTEGER,
  error_code TEXT CHECK (error_code IN ('offline','unauthorized','cloud_unavailable','conflict','interrupted','unknown')),
  updated_at TEXT NOT NULL,
  CHECK ((acknowledged IS NULL AND total IS NULL) OR
    (acknowledged IS NOT NULL AND total IS NOT NULL AND acknowledged >= 0 AND total >= acknowledged)),
  CHECK (state != 'complete' OR (acknowledged IS NOT NULL AND total IS NOT NULL AND acknowledged = total)),
  CHECK (error_code IS NULL OR state = 'blocked')
);
