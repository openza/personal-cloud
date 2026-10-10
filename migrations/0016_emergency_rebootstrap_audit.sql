CREATE TABLE emergency_rebootstrap_audit (
  audit_id TEXT PRIMARY KEY,
  prepared_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'all_app_credentials_lost')
);
