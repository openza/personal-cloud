import { ContractError, parseStrictJson, type JsonValue } from "./protocol.ts";
import { authJson, hash, randomToken, requireOwnerSession, requireRateLimit } from "./auth.ts";

const pairingLifetimeMs = 10 * 60_000;
const refreshLifetimeMs = 90 * 24 * 60 * 60_000;
const accessLifetimeMs = 10 * 60_000;

export async function createPairingGrant(request: Request, db: D1Database, instanceId: string): Promise<Response> {
  await requireOwnerSession(request, db, true);
  const body = exactObject(await request.text(), []);
  void body;
  const grant = `pair-${randomToken(24)}`;
  const now = new Date();
  const expiresAt = new Date(now.valueOf() + pairingLifetimeMs).toISOString();
  await db.prepare(`INSERT INTO pairing_grants(grant_hash,expires_at,created_at) VALUES(?1,?2,?3)`)
    .bind(await hash(grant), expiresAt, now.toISOString()).run();
  return authJson({ protocolVersion: 1, grant, expiresAt,
    qrPayload: JSON.stringify({ protocolVersion: 1, instanceId, grant }) });
}

export async function pairDevice(request: Request, db: D1Database, instanceId: string): Promise<Response> {
  await requireRateLimit(db, `pair:${request.headers.get("cf-connecting-ip") ?? "local"}`);
  const body = exactObject(await request.text(), ["grant", "deviceName", "capabilities"]);
  const grant = requireText(body.grant, "grant", 20, 256);
  const deviceName = requireText(body.deviceName, "deviceName", 1, 80).trim();
  const capabilities = requireCapabilities(body.capabilities);
  const grantHash = await hash(grant);
  const stored = await db.prepare(`SELECT expires_at,consumed_at,attempt_count FROM pairing_grants WHERE grant_hash=?1`)
    .bind(grantHash).first<{ expires_at: string; consumed_at: string | null; attempt_count: number }>();
  if (!stored || stored.consumed_at || stored.expires_at <= new Date().toISOString()) throw unauthorized();
  const deviceId = `device_${crypto.randomUUID().replaceAll("-", "")}`;
  const refreshCredential = `refresh-${randomToken(32)}`;
  const now = new Date();
  try {
    await db.batch([
      db.prepare("UPDATE pairing_grants SET consumed_at=?1 WHERE grant_hash=?2").bind(now.toISOString(), grantHash),
      db.prepare(`INSERT INTO devices(device_id,display_name,kind,can_sync,can_bridge_provider,created_at)
        VALUES(?1,?2,'desktop',?3,?4,?5)`).bind(deviceId, deviceName,
          capabilities.includes("desktop_sync") ? 1 : 0,
          capabilities.includes("provider_bridge") ? 1 : 0, now.toISOString()),
      db.prepare(`INSERT INTO device_refresh_credentials(credential_hash,device_id,created_at,expires_at)
        VALUES(?1,?2,?3,?4)`).bind(await hash(refreshCredential), deviceId, now.toISOString(),
          new Date(now.valueOf() + refreshLifetimeMs).toISOString()),
    ]);
  } catch { throw unauthorized(); }
  return authJson({ protocolVersion: 1, instanceId, deviceId, refreshCredential,
    capabilities, refreshExpiresAt: new Date(now.valueOf() + refreshLifetimeMs).toISOString() }, { status: 201 });
}

export async function issueDeviceAccessToken(request: Request, db: D1Database): Promise<Response> {
  const body = exactObject(await request.text(), ["deviceId", "refreshCredential"]);
  const deviceId = requireText(body.deviceId, "deviceId", 10, 128);
  await requireRateLimit(db, `device-token:${deviceId}`);
  const refreshCredential = requireText(body.refreshCredential, "refreshCredential", 20, 256);
  const now = new Date();
  const device = await db.prepare(`SELECT can_sync,can_bridge_provider FROM devices
    WHERE device_id=?1 AND revoked_at IS NULL`).bind(deviceId).first<{ can_sync: number; can_bridge_provider: number }>();
  const refresh = await db.prepare(`SELECT credential_hash FROM device_refresh_credentials
    WHERE credential_hash=?1 AND device_id=?2 AND revoked_at IS NULL AND expires_at>?3`)
    .bind(await hash(refreshCredential), deviceId, now.toISOString()).first<{ credential_hash: string }>();
  if (!device || !refresh) throw unauthorized();
  const accessToken = `access-${randomToken(32)}`;
  const expiresAt = new Date(now.valueOf() + accessLifetimeMs).toISOString();
  await db.batch([
    db.prepare(`INSERT INTO device_access_tokens(token_hash,device_id,created_at,expires_at)
      VALUES(?1,?2,?3,?4)`).bind(await hash(accessToken), deviceId, now.toISOString(), expiresAt),
    db.prepare("UPDATE devices SET last_seen_at=?1 WHERE device_id=?2 AND revoked_at IS NULL")
      .bind(now.toISOString(), deviceId),
  ]);
  return authJson({ protocolVersion: 1, accessToken, expiresAt,
    capabilities: capabilitiesFrom(device) });
}

export async function listDevices(request: Request, db: D1Database): Promise<Response> {
  await requireOwnerSession(request, db);
  const devices = await db.prepare(`SELECT device_id AS deviceId,display_name AS displayName,kind,
    can_sync AS canSync,can_bridge_provider AS canBridgeProvider,created_at AS createdAt,
    last_seen_at AS lastSeenAt,revoked_at AS revokedAt FROM devices ORDER BY created_at,device_id`).all();
  return authJson({ protocolVersion: 1, devices: devices.results });
}

export async function revokeDevice(request: Request, db: D1Database, deviceId: string): Promise<Response> {
  await requireOwnerSession(request, db, true);
  exactObject(await request.text(), []);
  return revokeDeviceRecord(db, deviceId);
}

export async function revokeCurrentDevice(request: Request, db: D1Database): Promise<Response> {
  const deviceId = await requireDeviceAccess(request, db, "desktop_sync");
  exactObject(await request.text(), []);
  return revokeDeviceRecord(db, deviceId);
}

async function revokeDeviceRecord(db: D1Database, deviceId: string): Promise<Response> {
  const existing = await db.prepare("SELECT revoked_at FROM devices WHERE device_id=?1")
    .bind(deviceId).first<{ revoked_at: string | null }>();
  if (!existing) throw new ContractError("entity_not_found", "The device does not exist.");
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE devices SET revoked_at=COALESCE(revoked_at,?1) WHERE device_id=?2").bind(now, deviceId),
    db.prepare("UPDATE device_refresh_credentials SET revoked_at=COALESCE(revoked_at,?1) WHERE device_id=?2").bind(now, deviceId),
    db.prepare("UPDATE device_access_tokens SET revoked_at=COALESCE(revoked_at,?1) WHERE device_id=?2").bind(now, deviceId),
  ]);
  return authJson({ protocolVersion: 1, outcome: existing.revoked_at ? "already_revoked" : "revoked", deviceId });
}

export async function requireDeviceAccess(
  request: Request,
  db: D1Database,
  capability: "desktop_sync" | "provider_bridge",
): Promise<string> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ") || header.length > 512) throw unauthorized();
  const token = header.slice(7);
  const row = await db.prepare(`SELECT d.device_id,d.can_sync,d.can_bridge_provider FROM device_access_tokens a
    INNER JOIN devices d ON d.device_id=a.device_id
    WHERE a.token_hash=?1 AND a.revoked_at IS NULL AND a.expires_at>?2 AND d.revoked_at IS NULL`)
    .bind(await hash(token), new Date().toISOString())
    .first<{ device_id: string; can_sync: number; can_bridge_provider: number }>();
  if (!row || (capability === "desktop_sync" ? row.can_sync !== 1 : row.can_bridge_provider !== 1)) throw unauthorized();
  return row.device_id;
}

function capabilitiesFrom(device: { can_sync: number; can_bridge_provider: number }): string[] {
  const values: string[] = [];
  if (device.can_sync === 1) values.push("desktop_sync");
  if (device.can_bridge_provider === 1) values.push("provider_bridge");
  return values;
}

function requireCapabilities(value: JsonValue): ("desktop_sync" | "provider_bridge")[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 ||
      value.some(item => item !== "desktop_sync" && item !== "provider_bridge") ||
      new Set(value).size !== value.length || !value.includes("desktop_sync")) {
    throw new ContractError("invalid_request", "Desktop capabilities are invalid.");
  }
  return value as ("desktop_sync" | "provider_bridge")[];
}

function exactObject(raw: string, keys: string[]): Record<string, JsonValue> {
  const value = parseStrictJson(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ContractError("invalid_request", "The device request must be an object.");
  const object = value as Record<string, JsonValue>; const actual = Object.keys(object).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) throw new ContractError("invalid_request", "The device request contains missing or unknown fields.");
  return object;
}
function requireText(value: JsonValue, field: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new ContractError("invalid_request", `${field} is invalid.`);
  return value;
}
function unauthorized() { return new ContractError("unauthorized", "Authentication failed."); }
