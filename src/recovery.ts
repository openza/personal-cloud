import { authJson, hash, randomToken, requireRateLimit, verifyRegistrationCredential } from "./auth.ts";
import { ContractError, parseStrictJson, type JsonValue } from "./protocol.ts";

const challengeLifetimeMs = 5 * 60_000;

type RecoveryRow = { version: number; verifier_hash: string; consumed_at: string | null; attempt_count: number };

export async function beginRecovery(request: Request, db: D1Database): Promise<Response> {
  await requireRateLimit(db, `recovery:${request.headers.get("cf-connecting-ip") ?? "local"}`);
  const body = exactObject(await request.text(), ["recoveryCode", "displayName"]);
  const recoveryCode = requireText(body.recoveryCode, "recoveryCode", 20, 256);
  const displayName = requireText(body.displayName, "displayName", 1, 80).trim();
  const active = await activeRecovery(db);
  if (!active || active.attempt_count >= 8 || await hash(recoveryCode) !== active.verifier_hash) {
    if (active && active.attempt_count < 8) {
      await db.prepare("UPDATE recovery_codes SET attempt_count=attempt_count+1 WHERE version=?1 AND consumed_at IS NULL")
        .bind(active.version).run();
    }
    throw unauthorized();
  }
  const challenge = randomToken(32);
  const now = new Date();
  await db.prepare(`INSERT INTO auth_challenges(challenge_hash,purpose,expires_at,created_at)
    VALUES(?1,'recovery_register',?2,?3)`).bind(await hash(challenge),
      new Date(now.valueOf() + challengeLifetimeMs).toISOString(), now.toISOString()).run();
  return authJson({ protocolVersion: 1, challenge,
    rp: { id: new URL(request.url).hostname, name: "Openza Personal Cloud" },
    user: { id: randomToken(24), name: "owner", displayName },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: challengeLifetimeMs,
    attestation: "none", authenticatorSelection: { residentKey: "preferred", userVerification: "required" } });
}

export async function finishRecovery(request: Request, db: D1Database): Promise<Response> {
  const body = exactObject(await request.text(), ["recoveryCode", "displayName", "challenge", "credential"]);
  const recoveryCode = requireText(body.recoveryCode, "recoveryCode", 20, 256);
  const displayName = requireText(body.displayName, "displayName", 1, 80).trim();
  const challenge = requireText(body.challenge, "challenge", 16, 256);
  const active = await activeRecovery(db);
  if (!active || active.attempt_count >= 8 || await hash(recoveryCode) !== active.verifier_hash) throw unauthorized();
  const challengeHash = await hash(challenge);
  const storedChallenge = await db.prepare(`SELECT expires_at,consumed_at FROM auth_challenges
    WHERE challenge_hash=?1 AND purpose='recovery_register'`).bind(challengeHash)
    .first<{ expires_at: string; consumed_at: string | null }>();
  if (!storedChallenge || storedChallenge.consumed_at || storedChallenge.expires_at <= new Date().toISOString()) throw unauthorized();
  const credential = await verifyRegistrationCredential(body.credential, challenge, request);
  const replacementCode = `openza-${randomToken(24)}`;
  const now = new Date();
  try {
    await db.batch([
      db.prepare("UPDATE owner_credentials SET revoked_at=COALESCE(revoked_at,?1) WHERE revoked_at IS NULL")
        .bind(now.toISOString()),
      db.prepare(`INSERT INTO owner_credentials(credential_id,display_name,public_key_jwk,sign_count,created_at)
        VALUES(?1,?2,?3,?4,?5)`).bind(credential.id, displayName,
          JSON.stringify(credential.publicKeyJwk), credential.signCount, now.toISOString()),
      db.prepare("UPDATE auth_challenges SET consumed_at=?1 WHERE challenge_hash=?2")
        .bind(now.toISOString(), challengeHash),
      db.prepare("UPDATE recovery_codes SET consumed_at=?1 WHERE version=?2")
        .bind(now.toISOString(), active.version),
      db.prepare(`INSERT INTO recovery_codes(version,verifier_hash,created_at)
        VALUES(?1,?2,?3)`).bind(active.version + 1, await hash(replacementCode), now.toISOString()),
      db.prepare("UPDATE web_sessions SET revoked_at=COALESCE(revoked_at,?1) WHERE revoked_at IS NULL")
        .bind(now.toISOString()),
    ]);
  } catch { throw unauthorized(); }
  return authJson({ protocolVersion: 1, outcome: "recovered", recoveryCode: replacementCode,
    credentialsRevoked: true, sessionsRevoked: true });
}

async function activeRecovery(db: D1Database): Promise<RecoveryRow | null> {
  return db.prepare(`SELECT version,verifier_hash,consumed_at,attempt_count FROM recovery_codes
    WHERE consumed_at IS NULL ORDER BY version DESC LIMIT 1`).first<RecoveryRow>();
}

function exactObject(raw: string, keys: string[]): Record<string, JsonValue> {
  const value = parseStrictJson(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ContractError("invalid_request", "The recovery request must be an object.");
  const object = value as Record<string, JsonValue>, actual = Object.keys(object).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) throw new ContractError("invalid_request", "The recovery request contains missing or unknown fields.");
  return object;
}
function requireText(value: JsonValue, field: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new ContractError("invalid_request", `${field} is invalid.`);
  return value;
}
function unauthorized() { return new ContractError("unauthorized", "Authentication failed."); }
