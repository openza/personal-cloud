import { createHash, randomUUID } from "node:crypto";
import { stdin, stdout, stderr } from "node:process";

if (stdin.isTTY) {
  stderr.write("Pipe one newly generated bootstrap grant on standard input. The grant is not echoed.\n");
  process.exitCode = 2;
} else {
  let grant = "";
  stdin.setEncoding("utf8");
  for await (const chunk of stdin) grant += chunk;
  grant = grant.trim();
  if (grant.length < 32 || grant.length > 256) {
    stderr.write("The replacement grant must contain 32-256 characters.\n");
    process.exitCode = 2;
  } else {
    const preparedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const hash = createHash("sha256").update(grant, "utf8").digest("hex");
    const auditId = `rebootstrap_${randomUUID().replaceAll("-", "")}`;
    stdout.write(`-- Review and execute only through an authenticated, direct D1 administration session.\n`);
    stdout.write(`-- This revokes every app credential and does not delete tasks or sync history.\n`);
    stdout.write(`BEGIN IMMEDIATE;\n`);
    stdout.write(`UPDATE web_sessions SET revoked_at='${preparedAt}' WHERE revoked_at IS NULL;\n`);
    stdout.write(`UPDATE device_refresh_credentials SET revoked_at='${preparedAt}' WHERE revoked_at IS NULL;\n`);
    stdout.write(`UPDATE device_access_tokens SET revoked_at='${preparedAt}' WHERE revoked_at IS NULL;\n`);
    stdout.write(`UPDATE devices SET revoked_at='${preparedAt}' WHERE revoked_at IS NULL;\n`);
    stdout.write(`UPDATE owner_credentials SET revoked_at='${preparedAt}' WHERE revoked_at IS NULL;\n`);
    stdout.write(`UPDATE recovery_codes SET consumed_at='${preparedAt}' WHERE consumed_at IS NULL;\n`);
    stdout.write(`INSERT INTO owner_bootstrap(singleton,grant_hash,expires_at,consumed_at) VALUES(1,'${hash}','${expiresAt}',NULL)\n`);
    stdout.write(`ON CONFLICT(singleton) DO UPDATE SET grant_hash=excluded.grant_hash,expires_at=excluded.expires_at,consumed_at=NULL;\n`);
    stdout.write(`INSERT INTO emergency_rebootstrap_audit(audit_id,prepared_at,reason) VALUES('${auditId}','${preparedAt}','all_app_credentials_lost');\n`);
    stdout.write(`COMMIT;\n`);
  }
}
