CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'desktop'),
  can_sync INTEGER NOT NULL CHECK (can_sync IN (0,1)),
  can_bridge_provider INTEGER NOT NULL CHECK (can_bridge_provider IN (0,1)),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);

CREATE TABLE pairing_grants (
  grant_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8)
);

CREATE TRIGGER pairing_grant_is_one_use
BEFORE UPDATE OF consumed_at ON pairing_grants
WHEN OLD.consumed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'pairing grant already consumed');
END;

CREATE TABLE device_refresh_credentials (
  credential_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE device_access_tokens (
  token_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX device_access_tokens_active_by_device
  ON device_access_tokens(device_id, expires_at) WHERE revoked_at IS NULL;
