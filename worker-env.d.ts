declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    INSTANCE_ID: string;
    K5_TEST_SESSION: string;
    OWNER_BOOTSTRAP_GRANT: string;
    TEST_MODE: string;
    ASSETS: Fetcher;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }

  interface GlobalProps {
    mainModule: typeof import("./src/index.ts");
  }
}
