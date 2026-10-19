import {throwDailyQuota} from "./daily-quota.ts";
import { ContractError, parseStrictJson, type JsonValue } from "./protocol.ts";

const challengeLifetimeMs = 5 * 60_000;
const sessionLifetimeMs = 15 * 60_000;
const sessionAbsoluteLifetimeMs = 12 * 60 * 60_000;
const bootstrapLifetimeMs = 30 * 60_000;

type AuthEnv = { DB: D1Database; INSTANCE_ID: string; OWNER_BOOTSTRAP_GRANT?: string };
type CredentialRow = { credential_id: string; public_key_jwk: string; sign_count: number };
type ChallengeRow = { challenge_hash: string; expires_at: string; consumed_at: string | null };

export async function authStatus(db: D1Database) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM owner_credentials WHERE revoked_at IS NULL")
    .first<{ count: number }>();
  return { protocolVersion: 1 as const, initialized: (row?.count ?? 0) > 0 };
}

export async function beginOwnerBootstrap(request: Request, env: AuthEnv, raw: string): Promise<Response> {
  const body = exactObject(raw, ["grant", "displayName"]);
  const grant = requireSecret(body.grant, "grant");
  const displayName = requireDisplayName(body.displayName);
  await requireRateLimit(env.DB, `bootstrap:${request.headers.get("cf-connecting-ip") ?? "local"}`);
  await ensureBootstrapGrant(env, request);
  await verifyBootstrapGrant(env.DB, grant);
  if ((await authStatus(env.DB)).initialized) throw new ContractError("already_initialized", "Owner setup is already complete.");
  const challenge = randomToken(32);
  const now = new Date();
  await storeChallenge(env.DB, challenge, "bootstrap_register", null, now);
  return json({
    protocolVersion: 1,
    challenge,
    rp: { id: new URL(request.url).hostname, name: "Openza Personal Cloud" },
    user: { id: randomToken(24), name: "owner", displayName },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    timeout: challengeLifetimeMs,
    attestation: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
}

export async function finishOwnerBootstrap(request: Request, env: AuthEnv, raw: string): Promise<Response> {
  const body = exactObject(raw, ["grant", "displayName", "challenge", "credential"]);
  const grant = requireSecret(body.grant, "grant");
  const displayName = requireDisplayName(body.displayName);
  const challenge = requireSecret(body.challenge, "challenge");
  await verifyBootstrapGrant(env.DB, grant);
  if ((await authStatus(env.DB)).initialized) throw new ContractError("already_initialized", "Owner setup is already complete.");
  const liveChallenge = await requireLiveChallenge(env.DB, challenge, "bootstrap_register");
  const credential = await verifyRegistrationCredential(body.credential, challenge, request);
  const recoveryCode = `openza-${randomToken(24)}`;
  const session = await createSessionValues();
  const now = new Date();
  const expiresAt = new Date(now.valueOf() + sessionLifetimeMs);
  const absoluteExpiresAt = new Date(now.valueOf() + sessionAbsoluteLifetimeMs);
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO owner_credentials
        (credential_id,display_name,public_key_jwk,sign_count,created_at)
        VALUES(?1,?2,?3,?4,?5)`)
        .bind(credential.id, displayName, JSON.stringify(credential.publicKeyJwk), credential.signCount, now.toISOString()),
      consumeChallenge(env.DB, liveChallenge.challenge_hash, now),
      env.DB.prepare("UPDATE owner_bootstrap SET consumed_at=?1 WHERE singleton=1 AND consumed_at IS NULL")
        .bind(now.toISOString()),
      env.DB.prepare(`INSERT INTO recovery_codes(version,verifier_hash,created_at)
        SELECT COALESCE(MAX(version),0)+1,?1,?2 FROM recovery_codes`)
        .bind(await hash(recoveryCode), now.toISOString()),
      insertSession(env.DB, session, credential.id, now, expiresAt, absoluteExpiresAt),
    ]);
  } catch (error) {
    throwDailyQuota(error);
    if ((await authStatus(env.DB)).initialized) throw new ContractError("already_initialized", "Owner setup is already complete.");
    throw error;
  }
  return sessionResponse({ protocolVersion: 1, outcome: "initialized", csrfToken: session.csrfToken, recoveryCode }, session.token, expiresAt);
}

export async function beginSignIn(request: Request, env: AuthEnv, raw: string): Promise<Response> {
  exactObject(raw, []);
  await requireRateLimit(env.DB, `signin:${request.headers.get("cf-connecting-ip") ?? "local"}`);
  const credentials = await env.DB.prepare("SELECT credential_id FROM owner_credentials WHERE revoked_at IS NULL ORDER BY created_at")
    .all<{ credential_id: string }>();
  if (credentials.results.length === 0) throw new ContractError("not_initialized", "Owner setup is not complete.");
  const challenge = randomToken(32);
  await storeChallenge(env.DB, challenge, "signin", null, new Date());
  return json({ protocolVersion: 1, challenge, rpId: new URL(request.url).hostname,
    allowCredentials: credentials.results.map(row => ({ type: "public-key", id: row.credential_id })),
    userVerification: "required", timeout: challengeLifetimeMs });
}

export async function finishSignIn(request: Request, env: AuthEnv, raw: string): Promise<Response> {
  const body = exactObject(raw, ["challenge", "credential"]);
  const challenge = requireSecret(body.challenge, "challenge");
  const liveChallenge = await requireLiveChallenge(env.DB, challenge, "signin");
  const assertion = parseAssertion(body.credential);
  const stored = await env.DB.prepare(`SELECT credential_id,public_key_jwk,sign_count FROM owner_credentials
    WHERE credential_id=?1 AND revoked_at IS NULL`).bind(assertion.id).first<CredentialRow>();
  if (!stored) throw unauthorized();
  const nextCount = await verifyAssertion(assertion, challenge, request, stored);
  const session = await createSessionValues();
  const now = new Date();
  const expiresAt = new Date(now.valueOf() + sessionLifetimeMs);
  const absoluteExpiresAt = new Date(now.valueOf() + sessionAbsoluteLifetimeMs);
  try {
    await env.DB.batch([
      consumeChallenge(env.DB, liveChallenge.challenge_hash, now),
      env.DB.prepare(`UPDATE owner_credentials SET sign_count=?1,last_used_at=?2
        WHERE credential_id=?3 AND sign_count=?4 AND revoked_at IS NULL`)
        .bind(nextCount, now.toISOString(), stored.credential_id, stored.sign_count),
      insertSession(env.DB, session, stored.credential_id, now, expiresAt, absoluteExpiresAt),
    ]);
  } catch (error) {
    throwDailyQuota(error);
    throw unauthorized();
  }
  return sessionResponse({ protocolVersion: 1, outcome: "authenticated", csrfToken: session.csrfToken }, session.token, expiresAt);
}

export async function requireOwnerSession(request: Request, db: D1Database, requireCsrf = false): Promise<void> {
  const token = cookieValue(request.headers.get("cookie"), "__Host-openza_session");
  if (!token) throw unauthorized();
  const sessionHash = await hash(token);
  const now = new Date().toISOString();
  const session = await db.prepare(`SELECT csrf_hash FROM web_sessions
    WHERE session_hash=?1 AND revoked_at IS NULL AND expires_at>?2 AND absolute_expires_at>?2`)
    .bind(sessionHash, now).first<{ csrf_hash: string }>();
  if (!session) throw unauthorized();
  if (requireCsrf) {
    const origin = request.headers.get("origin");
    if (origin !== new URL(request.url).origin) throw new ContractError("invalid_origin", "The request origin is invalid.");
    const csrf = request.headers.get("x-openza-csrf");
    if (!csrf || await hash(csrf) !== session.csrf_hash) throw new ContractError("csrf_failed", "The CSRF token is invalid.");
  }
}

export async function refreshOwnerCsrf(request: Request, db: D1Database): Promise<Response> {
  await requireOwnerSession(request, db);
  const token = cookieValue(request.headers.get("cookie"), "__Host-openza_session")!;
  const csrfToken = randomToken(32);
  const result = await db.prepare(`UPDATE web_sessions SET csrf_hash=?1
    WHERE session_hash=?2 AND revoked_at IS NULL AND expires_at>?3 AND absolute_expires_at>?3`)
    .bind(await hash(csrfToken), await hash(token), new Date().toISOString()).run();
  if (result.meta.changes !== 1) throw unauthorized();
  return json({ protocolVersion: 1, authenticated: true, csrfToken });
}

export async function signOut(request: Request, db: D1Database): Promise<Response> {
  await requireOwnerSession(request, db, true);
  const token = cookieValue(request.headers.get("cookie"), "__Host-openza_session")!;
  await db.prepare("UPDATE web_sessions SET revoked_at=?1 WHERE session_hash=?2 AND revoked_at IS NULL")
    .bind(new Date().toISOString(), await hash(token)).run();
  return json({ protocolVersion: 1, outcome: "signed_out" }, { headers: {
    "set-cookie": "__Host-openza_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0",
  } });
}

export async function rotateOwnerSession(request: Request, db: D1Database): Promise<Response> {
  await requireOwnerSession(request, db, true);
  const oldToken = cookieValue(request.headers.get("cookie"), "__Host-openza_session")!;
  const oldHash = await hash(oldToken);
  const old = await db.prepare(`SELECT credential_id,absolute_expires_at FROM web_sessions
    WHERE session_hash=?1 AND revoked_at IS NULL`).bind(oldHash)
    .first<{ credential_id: string; absolute_expires_at: string }>();
  if (!old) throw unauthorized();
  const now = new Date();
  const absolute = new Date(old.absolute_expires_at);
  const expiresAt = new Date(Math.min(now.valueOf() + sessionLifetimeMs, absolute.valueOf()));
  if (expiresAt <= now) throw unauthorized();
  const session = await createSessionValues();
  await db.batch([
    db.prepare("UPDATE web_sessions SET revoked_at=?1 WHERE session_hash=?2 AND revoked_at IS NULL")
      .bind(now.toISOString(), oldHash),
    insertSession(db, session, old.credential_id, now, expiresAt, absolute),
  ]);
  return sessionResponse({ protocolVersion: 1, outcome: "rotated", csrfToken: session.csrfToken }, session.token, expiresAt);
}

async function ensureBootstrapGrant(env: AuthEnv, request: Request): Promise<void> {
  const existing = await env.DB.prepare("SELECT 1 AS present FROM owner_bootstrap WHERE singleton=1")
    .first<{ present: number }>();
  if (existing) return;
  if (!env.OWNER_BOOTSTRAP_GRANT || env.OWNER_BOOTSTRAP_GRANT.length < 20) {
    throw new ContractError("bootstrap_unavailable", "Owner bootstrap is not configured.");
  }
  const now = new Date();
  await env.DB.prepare(`INSERT OR IGNORE INTO owner_bootstrap(singleton,grant_hash,expires_at)
    VALUES(1,?1,?2)`).bind(await hash(env.OWNER_BOOTSTRAP_GRANT),
      new Date(now.valueOf() + bootstrapLifetimeMs).toISOString()).run();
  void request;
}

async function verifyBootstrapGrant(db: D1Database, grant: string): Promise<void> {
  const row = await db.prepare(`SELECT grant_hash,expires_at,consumed_at FROM owner_bootstrap WHERE singleton=1`)
    .first<{ grant_hash: string; expires_at: string; consumed_at: string | null }>();
  if (!row || row.consumed_at || row.expires_at <= new Date().toISOString() || await hash(grant) !== row.grant_hash) {
    throw unauthorized();
  }
}

async function storeChallenge(db: D1Database, challenge: string, purpose: string, credentialId: string | null, now: Date) {
  await db.prepare(`INSERT INTO auth_challenges
    (challenge_hash,purpose,credential_id,expires_at,created_at) VALUES(?1,?2,?3,?4,?5)`)
    .bind(await hash(challenge), purpose, credentialId,
      new Date(now.valueOf() + challengeLifetimeMs).toISOString(), now.toISOString()).run();
}

async function requireLiveChallenge(db: D1Database, challenge: string, purpose: string): Promise<ChallengeRow> {
  const row = await db.prepare(`SELECT challenge_hash,expires_at,consumed_at FROM auth_challenges
    WHERE challenge_hash=?1 AND purpose=?2`).bind(await hash(challenge), purpose).first<ChallengeRow>();
  if (!row || row.consumed_at || row.expires_at <= new Date().toISOString()) throw unauthorized();
  return row;
}

function consumeChallenge(db: D1Database, challengeHash: string, now: Date): D1PreparedStatement {
  return db.prepare("UPDATE auth_challenges SET consumed_at=?1 WHERE challenge_hash=?2")
    .bind(now.toISOString(), challengeHash);
}

function insertSession(
  db: D1Database, session: { token: string; tokenHash: string; csrfToken: string; csrfHash: string },
  credentialId: string, now: Date, expiresAt: Date, absoluteExpiresAt: Date,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO web_sessions
    (session_hash,credential_id,csrf_hash,created_at,rotated_at,expires_at,absolute_expires_at)
    VALUES(?1,?2,?3,?4,?4,?5,?6)`)
    .bind(session.tokenHash, credentialId, session.csrfHash, now.toISOString(), expiresAt.toISOString(), absoluteExpiresAt.toISOString());
}

async function createSessionValues() {
  const token = randomToken(32);
  const csrfToken = randomToken(32);
  return { token, tokenHash: await hash(token), csrfToken, csrfHash: await hash(csrfToken) };
}

function sessionResponse(body: object, token: string, expiresAt: Date): Response {
  const maxAge = Math.max(0, Math.floor((expiresAt.valueOf() - Date.now()) / 1000));
  return json(body, { headers: { "set-cookie": `__Host-openza_session=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` } });
}

export async function verifyRegistrationCredential(value: JsonValue, challenge: string, request: Request) {
  const credential = requireObject(value, "credential");
  requireKeys(credential, ["id", "clientDataJSON", "attestationObject"]);
  const id = requireSecret(credential.id, "credential.id");
  const clientData = decodeClientData(requireSecret(credential.clientDataJSON, "clientDataJSON"), "webauthn.create", challenge, request);
  void clientData;
  const attestation = decodeBase64Url(requireSecret(credential.attestationObject, "attestationObject"));
  const decoded = decodeCbor(attestation, 0).value;
  if (!(decoded instanceof Map) || !(decoded.get("authData") instanceof Uint8Array)) throw unauthorized();
  const authData = decoded.get("authData") as Uint8Array;
  await verifyRpAndFlags(authData, request, true);
  let offset = 37 + 16;
  if (authData.length < offset + 2) throw unauthorized();
  const credentialLength = (authData[offset] << 8) | authData[offset + 1];
  offset += 2;
  const credentialBytes = authData.slice(offset, offset + credentialLength);
  offset += credentialLength;
  if (encodeBase64Url(credentialBytes) !== id) throw unauthorized();
  const cose = decodeCbor(authData, offset).value;
  if (!(cose instanceof Map) || cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1 ||
      !(cose.get(-2) instanceof Uint8Array) || !(cose.get(-3) instanceof Uint8Array)) throw unauthorized();
  return { id, signCount: readUint32(authData, 33), publicKeyJwk: {
    kty: "EC", crv: "P-256", x: encodeBase64Url(cose.get(-2)), y: encodeBase64Url(cose.get(-3)), ext: true,
  } };
}

function parseAssertion(value: JsonValue) {
  const credential = requireObject(value, "credential");
  requireKeys(credential, ["id", "clientDataJSON", "authenticatorData", "signature"]);
  return { id: requireSecret(credential.id, "credential.id"),
    clientDataJSON: requireSecret(credential.clientDataJSON, "clientDataJSON"),
    authenticatorData: requireSecret(credential.authenticatorData, "authenticatorData"),
    signature: requireSecret(credential.signature, "signature") };
}

async function verifyAssertion(
  assertion: ReturnType<typeof parseAssertion>, challenge: string, request: Request, stored: CredentialRow,
): Promise<number> {
  const clientBytes = decodeBase64Url(assertion.clientDataJSON);
  decodeClientData(assertion.clientDataJSON, "webauthn.get", challenge, request);
  const authData = decodeBase64Url(assertion.authenticatorData);
  await verifyRpAndFlags(authData, request, false);
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientBytes));
  const signed = concat(authData, clientHash);
  const key = await crypto.subtle.importKey("jwk", JSON.parse(stored.public_key_jwk),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const signature = derToRaw(decodeBase64Url(assertion.signature));
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signed)) throw unauthorized();
  const count = readUint32(authData, 33);
  if (count !== 0 && count <= stored.sign_count) throw unauthorized();
  return count;
}

function decodeClientData(encoded: string, type: string, challenge: string, request: Request) {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decodeBase64Url(encoded))); }
  catch { throw unauthorized(); }
  if (!isRecord(value) || value.type !== type || value.challenge !== challenge || value.origin !== new URL(request.url).origin) throw unauthorized();
  return value;
}

async function verifyRpAndFlags(authData: Uint8Array, request: Request, requireAttested: boolean): Promise<void> {
  if (authData.length < 37 || (authData[32] & 0x01) === 0 || (authData[32] & 0x04) === 0 ||
      (requireAttested && (authData[32] & 0x40) === 0)) throw unauthorized();
  const expected = await hashBytes(new TextEncoder().encode(new URL(request.url).hostname));
  if (!expected.every((byte, index) => byte === authData[index])) throw unauthorized();
}

export async function requireRateLimit(db: D1Database, bucket: string): Promise<void> {
  const now = new Date();
  const windowStart = new Date(now.valueOf() - 60_000).toISOString();
  await db.prepare(`INSERT INTO auth_rate_limits(bucket,window_started_at,attempt_count) VALUES(?1,?2,1)
    ON CONFLICT(bucket) DO UPDATE SET window_started_at=CASE WHEN window_started_at<?3 THEN excluded.window_started_at ELSE window_started_at END,
      attempt_count=CASE WHEN window_started_at<?3 THEN 1 ELSE attempt_count+1 END`)
    .bind(bucket, now.toISOString(), windowStart).run();
  const row = await db.prepare("SELECT attempt_count FROM auth_rate_limits WHERE bucket=?1").bind(bucket).first<{ attempt_count: number }>();
  if ((row?.attempt_count ?? 9) > 8) throw new ContractError("rate_limited", "Too many authentication attempts.");
}

function exactObject(raw: string, keys: string[]): Record<string, JsonValue> {
  const object = requireObject(parseStrictJson(raw), "request");
  requireKeys(object, keys);
  return object;
}

function requireObject(value: JsonValue, field: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ContractError("invalid_request", `${field} must be an object.`);
  return value as Record<string, JsonValue>;
}

function requireKeys(value: Record<string, JsonValue>, keys: string[]) {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) throw new ContractError("invalid_request", "The authentication request contains missing or unknown fields.");
}

function requireSecret(value: JsonValue, field: string): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 2048) throw new ContractError("invalid_request", `${field} is invalid.`);
  return value;
}

function requireDisplayName(value: JsonValue): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 80) throw new ContractError("invalid_request", "The credential name is invalid.");
  return value.trim();
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function randomToken(bytes: number): string { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return encodeBase64Url(value); }
export async function hash(value: string): Promise<string> { return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))); }
async function hashBytes(value: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest("SHA-256", value)); }
function encodeHex(value: Uint8Array): string { return [...value].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
function encodeBase64Url(value: Uint8Array): string { return btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw unauthorized();
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  try { return Uint8Array.from(atob(padded), character => character.charCodeAt(0)); } catch { throw unauthorized(); }
}
function concat(...values: Uint8Array[]): Uint8Array { const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0)); let offset = 0; for (const value of values) { result.set(value, offset); offset += value.length; } return result; }
function readUint32(value: Uint8Array, offset: number): number { return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(offset); }
function unauthorized(): ContractError { return new ContractError("unauthorized", "Authentication failed."); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function derToRaw(signature: Uint8Array): Uint8Array {
  if (signature.length === 64) return signature;
  if (signature[0] !== 0x30) throw unauthorized();
  let offset = signature[1] < 0x80 ? 2 : 2 + (signature[1] & 0x7f);
  if (signature[offset++] !== 0x02) throw unauthorized();
  const rLength = signature[offset++]; const r = signature.slice(offset, offset + rLength); offset += rLength;
  if (signature[offset++] !== 0x02) throw unauthorized();
  const sLength = signature[offset++]; const s = signature.slice(offset, offset + sLength);
  const result = new Uint8Array(64); result.set(r.slice(Math.max(0, r.length - 32)), 32 - Math.min(32, r.length)); result.set(s.slice(Math.max(0, s.length - 32)), 64 - Math.min(32, s.length)); return result;
}

function decodeCbor(bytes: Uint8Array, start: number): { value: unknown; offset: number } {
  let offset = start; const initial = bytes[offset++]; const major = initial >> 5; const additional = initial & 31;
  const length = (): number => { if (additional < 24) return additional; if (additional === 24) return bytes[offset++]; if (additional === 25) { const n = (bytes[offset] << 8) | bytes[offset + 1]; offset += 2; return n; } throw unauthorized(); };
  if (major === 0) return { value: length(), offset };
  if (major === 1) return { value: -1 - length(), offset };
  if (major === 2 || major === 3) { const size = length(); const value = bytes.slice(offset, offset + size); offset += size; return { value: major === 2 ? value : new TextDecoder().decode(value), offset }; }
  if (major === 5) { const count = length(); const map = new Map<unknown, unknown>(); for (let index = 0; index < count; index++) { const key = decodeCbor(bytes, offset); offset = key.offset; const value = decodeCbor(bytes, offset); offset = value.offset; map.set(key.value, value.value); } return { value: map, offset }; }
  throw unauthorized();
}

export function authJson(value: unknown, init: ResponseInit = {}): Response { const headers = new Headers(init.headers); headers.set("cache-control", "no-store"); return Response.json(value, { ...init, headers }); }
const json = authJson;
