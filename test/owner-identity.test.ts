import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const origin = "https://personal-cloud.local";
const grant = "local-bootstrap-grant-do-not-deploy";

describe.sequential("single-owner passkey identity", () => {
  it("bootstraps once, stores only verifiers, signs in, enforces CSRF, and revokes the session", async () => {
    expect(await json(await exports.default.fetch(`${origin}/auth/status`))).toEqual({ protocolVersion: 1, initialized: false });
    const duplicateKey = await exports.default.fetch(`${origin}/auth/bootstrap/begin`, {
      method: "POST", body: `{"grant":"${grant}","grant":"${grant}","displayName":"Owner passkey"}`,
    });
    expect(duplicateKey.status).toBe(400);
    const begin = await post("/auth/bootstrap/begin", { grant, displayName: "Owner passkey" });
    expect(begin.status).toBe(200);
    const creation = await json(begin) as any;
    const credential = await createRegistrationCredential(creation.challenge, creation.rp.id);
    const finish = await post("/auth/bootstrap/finish", {
      grant, displayName: "Owner passkey", challenge: creation.challenge, credential: credential.response,
    });
    expect(finish.status).toBe(200);
    const initialized = await json(finish) as any;
    expect(initialized.outcome).toBe("initialized");
    expect(initialized.recoveryCode).toMatch(/^openza-/);
    expect(initialized.csrfToken).toBeTruthy();
    const firstCookie = cookie(finish);
    expect(firstCookie).toContain("Secure"); expect(firstCookie).toContain("HttpOnly"); expect(firstCookie).toContain("SameSite=Strict");
    expect(await env.DB.prepare("SELECT public_key_jwk FROM owner_credentials").first()).not.toBeNull();
    await expect(env.DB.prepare(`INSERT INTO owner_credentials(credential_id,display_name,public_key_jwk,created_at)
      VALUES('concurrent_owner','Concurrent setup','{}','2026-09-13T00:00:00.000Z')`).run()).rejects.toThrow();
    expect(JSON.stringify(await env.DB.prepare("SELECT * FROM recovery_codes").first())).not.toContain(initialized.recoveryCode);
    expect(JSON.stringify(await env.DB.prepare("SELECT * FROM web_sessions").first())).not.toContain(sessionToken(firstCookie));
    await env.DB.prepare("UPDATE web_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE session_hash=?1")
      .bind(await digest(sessionToken(firstCookie))).run();
    expect((await exports.default.fetch(`${origin}/auth/session`, { headers: { cookie: firstCookie } })).status).toBe(401);

    const replay = await post("/auth/bootstrap/finish", {
      grant, displayName: "Owner passkey", challenge: creation.challenge, credential: credential.response,
    });
    expect(replay.status).toBe(401);

    const signinBegin = await post("/auth/signin/begin", {});
    const assertionOptions = await json(signinBegin) as any;
    const assertion = await createAssertionCredential(
      assertionOptions.challenge, assertionOptions.rpId, credential.id, credential.privateKey, 1);
    const signin = await post("/auth/signin/finish", {
      challenge: assertionOptions.challenge, credential: assertion,
    });
    expect(signin.status).toBe(200);
    const signinBody = await json(signin) as any;
    const signedInCookie = cookie(signin);
    const resumedSession = await exports.default.fetch(`${origin}/auth/session`, { headers: { cookie: signedInCookie } });
    expect(resumedSession.status).toBe(200);
    const resumedBody = await json(resumedSession) as any;
    expect(resumedBody.csrfToken).toBeTruthy();
    expect(resumedBody.csrfToken).not.toBe(signinBody.csrfToken);

    const missingCsrf = await exports.default.fetch(`${origin}/auth/signout`, { method: "POST", headers: { cookie: signedInCookie } });
    expect(missingCsrf.status).toBe(403);
    const wrongOrigin = await exports.default.fetch(`${origin}/auth/signout`, { method: "POST", headers: {
      cookie: signedInCookie, origin: "https://evil.invalid", "x-openza-csrf": signinBody.csrfToken,
    } });
    expect(wrongOrigin.status).toBe(403);
    const rotated = await exports.default.fetch(`${origin}/auth/session/rotate`, { method: "POST", headers: {
      cookie: signedInCookie, origin, "x-openza-csrf": signinBody.csrfToken,
    } });
    expect(rotated.status).toBe(403);
    const rotatedWithResumedCsrf = await exports.default.fetch(`${origin}/auth/session/rotate`, { method: "POST", headers: {
      cookie: signedInCookie, origin, "x-openza-csrf": resumedBody.csrfToken,
    } });
    expect(rotatedWithResumedCsrf.status).toBe(200);
    const rotatedBody = await json(rotatedWithResumedCsrf) as any;
    const rotatedCookie = cookie(rotatedWithResumedCsrf);
    expect(rotatedCookie).not.toBe(signedInCookie);
    expect((await exports.default.fetch(`${origin}/auth/session`, { headers: { cookie: signedInCookie } })).status).toBe(401);
    const signout = await exports.default.fetch(`${origin}/auth/signout`, { method: "POST", headers: {
      cookie: rotatedCookie, origin, "x-openza-csrf": rotatedBody.csrfToken,
    } });
    expect(signout.status).toBe(200);
    expect((await exports.default.fetch(`${origin}/auth/session`, { headers: { cookie: rotatedCookie } })).status).toBe(401);

    const badRecovery = await post("/auth/recovery/begin", {
      recoveryCode: "openza-invalid-recovery-code-value", displayName: "Recovered passkey",
    });
    expect(badRecovery.status).toBe(401);
    const recoveryBegin = await post("/auth/recovery/begin", {
      recoveryCode: initialized.recoveryCode, displayName: "Recovered passkey",
    });
    expect(recoveryBegin.status).toBe(200);
    const recoveryOptions = await json(recoveryBegin) as any;
    const recoveredCredential = await createRegistrationCredential(recoveryOptions.challenge, recoveryOptions.rp.id);
    const recovered = await post("/auth/recovery/finish", {
      recoveryCode: initialized.recoveryCode, displayName: "Recovered passkey",
      challenge: recoveryOptions.challenge, credential: recoveredCredential.response,
    });
    expect(recovered.status).toBe(200);
    const recoveredBody = await json(recovered) as any;
    expect(recoveredBody.outcome).toBe("recovered");
    expect(recoveredBody.recoveryCode).toMatch(/^openza-/);
    expect(recoveredBody.recoveryCode).not.toBe(initialized.recoveryCode);
    expect(recoveredBody.credentialsRevoked).toBe(true);
    expect((await exports.default.fetch(`${origin}/auth/session`, { headers: { cookie: firstCookie } })).status).toBe(401);
    const afterRecovery = await json(await post("/auth/signin/begin", {})) as any;
    expect(afterRecovery.allowCredentials.map((item: any) => item.id)).toEqual([recoveredCredential.id]);
    expect(afterRecovery.allowCredentials.map((item: any) => item.id)).not.toContain(credential.id);
    expect((await post("/auth/recovery/begin", {
      recoveryCode: initialized.recoveryCode, displayName: "Replay",
    })).status).toBe(401);
  });
});

async function createRegistrationCredential(challenge: string, rpId: string) {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey;
  const idBytes = crypto.getRandomValues(new Uint8Array(32));
  const id = base64url(idBytes);
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
  const cose = cborMap([[1, 2], [3, -7], [-1, 1], [-2, fromBase64url(jwk.x!)], [-3, fromBase64url(jwk.y!)]]);
  const authData = concat(rpHash, Uint8Array.of(0x45), uint32(0), new Uint8Array(16),
    Uint8Array.of(idBytes.length >> 8, idBytes.length & 255), idBytes, cose);
  const attestation = cborMap([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]);
  const clientDataJSON = base64url(new TextEncoder().encode(JSON.stringify({
    type: "webauthn.create", challenge, origin,
  })));
  return { id, privateKey: keys.privateKey, response: { id, clientDataJSON, attestationObject: base64url(attestation) } };
}

async function createAssertionCredential(
  challenge: string, rpId: string, id: string, privateKey: CryptoKey, count: number,
) {
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
  const authenticatorData = concat(rpHash, Uint8Array.of(0x05), uint32(count));
  const clientBytes = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge, origin }));
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientBytes));
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey, concat(authenticatorData, clientHash)));
  return { id, clientDataJSON: base64url(clientBytes), authenticatorData: base64url(authenticatorData), signature: base64url(signature) };
}

async function post(path: string, value: unknown) {
  return exports.default.fetch(`${origin}${path}`, { method: "POST", body: JSON.stringify(value) });
}
async function json(response: Response) { return response.json(); }
function cookie(response: Response) { return response.headers.get("set-cookie")!; }
function sessionToken(header: string) { return header.match(/__Host-openza_session=([^;]+)/)![1]; }
function uint32(value: number) { const result = new Uint8Array(4); new DataView(result.buffer).setUint32(0, value); return result; }
function concat(...values: Uint8Array[]) { const result = new Uint8Array(values.reduce((sum, item) => sum + item.length, 0)); let offset = 0; for (const value of values) { result.set(value, offset); offset += value.length; } return result; }
function base64url(value: Uint8Array) { return btoa(String.fromCharCode(...value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
function fromBase64url(value: string) { const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4); return Uint8Array.from(atob(padded), item => item.charCodeAt(0)); }
async function digest(value: string) { const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); }

function cborMap(entries: [unknown, unknown][] | Map<unknown, unknown>): Uint8Array {
  const values = entries instanceof Map ? [...entries.entries()] : entries;
  return concat(cborHead(5, values.length), ...values.flatMap(([key, value]) => [cbor(key), cbor(value)]));
}
function cbor(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  if (value instanceof Map) return cborMap(value);
  if (typeof value === "string") { const bytes = new TextEncoder().encode(value); return concat(cborHead(3, bytes.length), bytes); }
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  throw new Error("Unsupported test CBOR value");
}
function cborHead(major: number, value: number): Uint8Array {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value < 256) return Uint8Array.of((major << 5) | 24, value);
  return Uint8Array.of((major << 5) | 25, value >> 8, value & 255);
}
