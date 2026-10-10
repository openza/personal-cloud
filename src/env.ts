interface Env {
  DB: D1Database;
  INSTANCE_ID: string;
  ARTIFACT_VERSION: string;
  K5_TEST_SESSION?: string;
  OWNER_BOOTSTRAP_GRANT?: string;
  TEST_MODE?: string;
  ASSETS: Fetcher;
}
