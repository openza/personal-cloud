CREATE TABLE owner_credentials (
  credential_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  public_key_jwk TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE UNIQUE INDEX owner_credentials_single_active
  ON owner_credentials((1)) WHERE revoked_at IS NULL;

CREATE TABLE auth_challenges (
  challenge_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('bootstrap_register','signin','recovery_register')),
  credential_id TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  created_at TEXT NOT NULL
);

CREATE TRIGGER auth_challenge_is_one_use
BEFORE UPDATE OF consumed_at ON auth_challenges
WHEN OLD.consumed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'auth challenge already consumed');
END;

CREATE TABLE web_sessions (
  session_hash TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES owner_credentials(credential_id),
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX web_sessions_active_by_credential
  ON web_sessions(credential_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE owner_bootstrap (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  grant_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE recovery_codes (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  verifier_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8)
);

CREATE TRIGGER recovery_code_is_one_use
BEFORE UPDATE OF consumed_at ON recovery_codes
WHEN OLD.consumed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'recovery code already consumed');
END;

CREATE TABLE auth_rate_limits (
  bucket TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0)
);
