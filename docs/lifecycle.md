# Personal Cloud setup, updates and recovery

## Two test environments

| | localhost | Your Cloudflare account |
|---|---|---|
| Server and database | Wrangler local Worker and disposable D1 state | Worker + D1 owned by your account |
| Setup | Local migrations, ignored bootstrap grant, browser passkey | Desktop guided OAuth authorization and provisioning |
| Desktop connection | Pair existing cloud using `http://localhost:8787/` | Guided setup or pair an existing HTTPS cloud |
| Pairing code | Web Settings → Pair a desktop | Same Web Settings control |
| Provider credentials | Remain on Desktop | Remain on Desktop |
| Changes deployed automatically? | Source hot reload in the running dev server | No: build/package/update explicitly |

Each pairing code is one-use and belongs to the exact cloud that created it. A code generated on a remote cloud cannot pair localhost. Remote HTTP is rejected; HTTP is accepted only for loopback development. Localhost tests do not create or modify Cloudflare account resources.

## Before an update

1. Identify the exact cloud URL, Worker, D1 database and account. Record `/health` and the current artifact version/schema version; never infer deployment from Git state. Successful health now requires the expected schema footprint; incomplete or unavailable D1 returns `schema_not_ready` 503. Health is separate from checksum-history validation and backup recovery proof; see [cloud upgrade compatibility v1](cloud-upgrade-v1.md).
2. Download a database backup through Desktop's Personal Cloud management flow. Store the SQL export privately, outside Git. Confirm the file exists and is nonempty. A downloaded file is not yet a tested restore.
3. Record the deployed Git revision or release and Cloudflare deployment version so the previous code can be recovered. Keep an existing build and checksum manifest when available; downloading another code copy is not a prerequisite when the source is already preserved in Git. If deployed code cannot be traced to a saved revision, record that limitation before updating. Build a new version with `npm run build:artifact -- <new-version>` and verify its recorded file sizes and SHA-256 hashes. Package that artifact with Desktop; building alone does not update Desktop's bundle or the live cloud.
4. Require successful typecheck, Worker tests, browser paging tests, recovery-generator tests and secret scanning. Confirm browser behavior before the approved deployment.

Desktop temporarily authorizes the Cloudflare operation, targets the existing instance's resources, applies ordered migrations and verifies health. Completed provisioning work is journaled for retry; do not delete resources blindly after an interrupted update. Authorization is revoked when the operation finishes or fails.

## Rollback limitations

### Rehearse a cloud SQL restore

The Personal Cloud download is a D1 SQL export, not a Desktop `.db` backup. Desktop's **Restore from file** accepts only Desktop database backups. Keep SQL exports private: they include task data and authentication verifiers.

A Cloudflare export can insert rows before creating a table referenced by their foreign keys. Even with deferred foreign keys, importing that order can fail with `no such table`. Prepare a separate copy with all table definitions before data, followed by indexes and triggers:

```sh
npm ci
npm run prepare:restore -- /private/original-export.sql /private/prepared-restore.sql
```

The command preserves every parsed SQL statement, refuses to overwrite a file, and never contacts a database. Keep the original export. It supports full D1 exports, not arbitrary SQL or partial table dumps.

First import into a **new, empty disposable local database**, using its own Wrangler configuration and persistence directory:

```sh
npx wrangler d1 execute RESTORE --local --config /private/restore-wrangler.json --persist-to /private/restore-state --file /private/prepared-restore.sql
```

Verify recovered tasks, Spaces, projects, labels, receipts and relationships before planning a remote recovery. A successful local import is not proof of a deployed restore. Do not import over an active database; code rollback does not revert its schema. A production restore must be executed by a human operator under an approved recovery procedure.

A Worker-code rollback does **not** roll back D1 migrations. Do not deploy an old artifact unless its expected schema is compatible with the current database. Prefer a forward fix. For an incompatible migration, stop writes, preserve a fresh backup, and rehearse recovery into a separate disposable database before selecting a recovery procedure. No automatic downgrade or generic SQL-restore guarantee is provided by this preview.

The emergency owner-rebootstrap generator is review-only: it reads a new bootstrap grant from standard input and prints SQL. It neither connects to Cloudflare nor executes the SQL. A human must review and execute an approved recovery procedure. Never put the grant on a command line, in Git, or in screenshots.

## Disconnect versus remove

- **Disconnect this Desktop** revokes that Desktop's cloud access, clears its connection/credential locally, and preserves local tasks and the remote cloud. Other paired devices remain separate.
- **Remove Personal Cloud** deletes the identified Worker/D1 resources. Export first. Local tasks are preserved, but cloud data is not recoverable through a normal product undo. Confirm exact targets and have the user perform the destructive confirmation. This is not a routine test against their active cloud.

## Release boundaries

Linux is the current scope; Snap validation is deferred by user direction and Windows is not an acceptance requirement for this batch. Live lifecycle rehearsals and public OAuth-client availability are separate from fake-backed/local tests. No production database writes should be executed by the development agent. Source completion, commit/push, approved deployment and live acceptance must be reported separately.
