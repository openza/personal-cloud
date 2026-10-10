import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index.ts";
import { requireDeviceAccess } from "../src/device-auth.ts";

const origin = "https://personal-cloud.local";

describe.sequential("desktop pairing and revocation", () => {
  it("pairs once, issues scoped short access, and revokes refresh plus access immediately", async () => {
    const owner = await createOwnerSession();
    const grantResponse = await productionFetch("/auth/pairing-grants", {
      method: "POST", body: "{}", headers: ownerHeaders(owner),
    });
    expect(grantResponse.status).toBe(200);
    const grant = await grantResponse.json() as any;
    expect(grant.qrPayload).toContain(grant.grant);

    const pairResponse = await productionFetch("/auth/pair", { method: "POST", body: JSON.stringify({
      grant: grant.grant, deviceName: "Ubuntu desktop", capabilities: ["desktop_sync", "provider_bridge"],
    }) });
    expect(pairResponse.status).toBe(201);
    const paired = await pairResponse.json() as any;
    expect(paired.refreshCredential).toMatch(/^refresh-/);
    expect(JSON.stringify(await env.DB.prepare("SELECT * FROM device_refresh_credentials").first()))
      .not.toContain(paired.refreshCredential);

    const replay = await productionFetch("/auth/pair", { method: "POST", body: JSON.stringify({
      grant: grant.grant, deviceName: "Replay", capabilities: ["desktop_sync"],
    }) });
    expect(replay.status).toBe(401);

    const tokenResponse = await productionFetch("/auth/device/token", { method: "POST", body: JSON.stringify({
      deviceId: paired.deviceId, refreshCredential: paired.refreshCredential,
    }) });
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json() as any;
    expect(token.capabilities).toEqual(["desktop_sync", "provider_bridge"]);
    expect((await productionFetch("/sync/bootstrap", { headers: { authorization: `Bearer ${token.accessToken}` } })).status).toBe(200);
    expect((await productionFetch("/sync/bootstrap")).status).toBe(401);

    const listed = await productionFetch("/auth/devices", { headers: { cookie: owner.cookie } });
    expect((await listed.json() as any).devices[0]).toMatchObject({
      deviceId: paired.deviceId, displayName: "Ubuntu desktop", canSync: 1, canBridgeProvider: 1, revokedAt: null,
    });
    const revoked = await productionFetch(`/auth/devices/${paired.deviceId}/revoke`, {
      method: "POST", body: "{}", headers: ownerHeaders(owner),
    });
    expect(revoked.status).toBe(200);
    expect((await revoked.json() as any).outcome).toBe("revoked");
    expect((await productionFetch("/sync/bootstrap", { headers: { authorization: `Bearer ${token.accessToken}` } })).status).toBe(401);
    expect((await productionFetch("/auth/device/token", { method: "POST", body: JSON.stringify({
      deviceId: paired.deviceId, refreshCredential: paired.refreshCredential,
    }) })).status).toBe(401);

    const replacementGrant = await productionFetch("/auth/pairing-grants", {
      method: "POST", body: "{}", headers: ownerHeaders(owner),
    });
    const replacementCode = await replacementGrant.json() as any;
    const replacementResponse = await productionFetch("/auth/pair", { method: "POST", body: JSON.stringify({
      grant: replacementCode.grant, deviceName: "Ubuntu desktop re-paired", capabilities: ["desktop_sync"],
    }) });
    expect(replacementResponse.status).toBe(201);
    const replacement = await replacementResponse.json() as any;
    const replacementTokenResponse = await productionFetch("/auth/device/token", { method: "POST", body: JSON.stringify({
      deviceId: replacement.deviceId, refreshCredential: replacement.refreshCredential,
    }) });
    const replacementToken = await replacementTokenResponse.json() as any;
    const request = new Request(`${origin}/v1/tasks/mutations`, {
      headers: { authorization: `Bearer ${replacementToken.accessToken}` },
    });
    await expect(requireDeviceAccess(request, env.DB, "desktop_sync")).resolves.toBe(replacement.deviceId);
    await expect(requireDeviceAccess(request, env.DB, "provider_bridge")).rejects.toMatchObject({ code: "unauthorized" });

    const selfRevoked = await productionFetch("/auth/device/revoke", {
      method: "POST",
      body: "{}",
      headers: { authorization: `Bearer ${replacementToken.accessToken}` },
    });
    expect(selfRevoked.status).toBe(200);
    expect(await selfRevoked.json()).toMatchObject({ outcome: "revoked", deviceId: replacement.deviceId });
    expect((await productionFetch("/sync/bootstrap", {
      headers: { authorization: `Bearer ${replacementToken.accessToken}` },
    })).status).toBe(401);
  });
});

async function createOwnerSession() {
  const token = `session-${crypto.randomUUID()}`, csrf = `csrf-${crypto.randomUUID()}`;
  const now = new Date(), expires = new Date(now.valueOf() + 15 * 60_000), absolute = new Date(now.valueOf() + 60 * 60_000);
  const credentialId = `credential-${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO owner_credentials(credential_id,display_name,public_key_jwk,created_at)
      VALUES(?1,'Pairing test','{}',?2)`).bind(credentialId, now.toISOString()),
    env.DB.prepare(`INSERT INTO web_sessions(session_hash,credential_id,csrf_hash,created_at,rotated_at,expires_at,absolute_expires_at)
      VALUES(?1,?2,?3,?4,?4,?5,?6)`).bind(await digest(token), credentialId, await digest(csrf),
        now.toISOString(), expires.toISOString(), absolute.toISOString()),
  ]);
  return { cookie: `__Host-openza_session=${token}`, csrf };
}

function ownerHeaders(owner: { cookie: string; csrf: string }) {
  return { cookie: owner.cookie, origin, "x-openza-csrf": owner.csrf };
}
function productionFetch(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`${origin}${path}`, init), { ...env, TEST_MODE: undefined } as unknown as Env);
}
async function digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
