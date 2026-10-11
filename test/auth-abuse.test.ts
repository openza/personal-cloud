import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { requireRateLimit } from "../src/auth.ts";

describe("authentication abuse limits", () => {
  it("allows eight attempts in a window and rejects the ninth", async () => {
    const bucket = `test-abuse-${crypto.randomUUID()}`;
    for (let attempt = 0; attempt < 8; attempt += 1) await requireRateLimit(env.DB, bucket);
    await expect(requireRateLimit(env.DB, bucket)).rejects.toMatchObject({ code: "rate_limited" });
  });
});
