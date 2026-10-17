import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          TEST_MODE: "true",
          K5_TEST_SESSION: "k5-local-read-only",
          ARTIFACT_VERSION: "0.0.0-test",
          OWNER_BOOTSTRAP_GRANT: "local-bootstrap-grant-do-not-deploy",
        },
      },
    })),
  ],
  test: {
    exclude: [".wrangler/**", "dist/**", "artifacts/**", "test-node/**", "**/node_modules/**", "**/.git/**"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
