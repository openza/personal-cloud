import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

test("emergency rebootstrap emits review-only credential reset SQL without exposing the grant", () => {
  const grant = "replacement-owner-bootstrap-grant-123456789";
  const result = spawnSync(process.execPath, ["scripts/prepare-owner-rebootstrap.mjs"], {
    input: `${grant}\n`, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, new RegExp(grant));
  assert.match(result.stdout, /BEGIN IMMEDIATE;/);
  assert.match(result.stdout, /UPDATE web_sessions SET revoked_at=/);
  assert.match(result.stdout, /UPDATE device_refresh_credentials SET revoked_at=/);
  assert.match(result.stdout, /UPDATE device_access_tokens SET revoked_at=/);
  assert.match(result.stdout, /UPDATE owner_credentials SET revoked_at=/);
  assert.match(result.stdout, /UPDATE recovery_codes SET consumed_at=/);
  assert.match(result.stdout, /emergency_rebootstrap_audit/);
  assert.match(result.stdout, /COMMIT;/);
  assert.doesNotMatch(result.stdout, /DELETE FROM (?:tasks|changes|sync_checkpoints)/i);
});

test("emergency rebootstrap rejects a weak replacement grant", () => {
  const result = spawnSync(process.execPath, ["scripts/prepare-owner-rebootstrap.mjs"], {
    input: "too-short\n", encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /32-256 characters/);
});

test("generated SQL revokes every app credential and preserves task data", () => {
  const grant = "replacement-owner-bootstrap-grant-987654321";
  const prepared = spawnSync(process.execPath, ["scripts/prepare-owner-rebootstrap.mjs"], {
    input: `${grant}\n`, encoding: "utf8",
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE web_sessions(id TEXT PRIMARY KEY, revoked_at TEXT);
    CREATE TABLE device_refresh_credentials(id TEXT PRIMARY KEY, revoked_at TEXT);
    CREATE TABLE device_access_tokens(id TEXT PRIMARY KEY, revoked_at TEXT);
    CREATE TABLE devices(id TEXT PRIMARY KEY, revoked_at TEXT);
    CREATE TABLE owner_credentials(id TEXT PRIMARY KEY, revoked_at TEXT);
    CREATE TABLE recovery_codes(id TEXT PRIMARY KEY, consumed_at TEXT);
    CREATE TABLE owner_bootstrap(singleton INTEGER PRIMARY KEY, grant_hash TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT);
    CREATE TABLE emergency_rebootstrap_audit(audit_id TEXT PRIMARY KEY, prepared_at TEXT NOT NULL, reason TEXT NOT NULL);
    INSERT INTO tasks VALUES('task_1','Preserve me');
    INSERT INTO web_sessions VALUES('web_1',NULL);
    INSERT INTO device_refresh_credentials VALUES('refresh_1',NULL);
    INSERT INTO device_access_tokens VALUES('access_1',NULL);
    INSERT INTO devices VALUES('device_1',NULL);
    INSERT INTO owner_credentials VALUES('owner_1',NULL);
    INSERT INTO recovery_codes VALUES('recovery_1',NULL);
    INSERT INTO owner_bootstrap VALUES(1,'old','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z');
  `);
  db.exec(prepared.stdout);
  const task = db.prepare("SELECT id,title FROM tasks").get();
  assert.equal(task.id, "task_1");
  assert.equal(task.title, "Preserve me");
  for (const table of ["web_sessions", "device_refresh_credentials", "device_access_tokens", "devices", "owner_credentials"]) {
    assert.notEqual(db.prepare(`SELECT revoked_at FROM ${table}`).get().revoked_at, null);
  }
  assert.notEqual(db.prepare("SELECT consumed_at FROM recovery_codes").get().consumed_at, null);
  const bootstrap = db.prepare("SELECT grant_hash,consumed_at FROM owner_bootstrap").get();
  assert.equal(bootstrap.consumed_at, null);
  assert.notEqual(bootstrap.grant_hash, "old");
  assert.equal(db.prepare("SELECT reason FROM emergency_rebootstrap_audit").get().reason, "all_app_credentials_lost");
  db.close();
});
