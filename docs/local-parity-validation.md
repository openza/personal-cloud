# Local shared-workflow validation

Desktop owns third-party accounts, provider requests and routing. Web is a
Personal Cloud companion for the shared task workspace. Source-task facts and
completion feedback remain visible on Web; integration management does not.

Build a fresh validation artifact with `npm run build:artifact -- <version>`.
Start the disposable fixture from this repository:

```text
node scripts/shared-parity-fixture.mjs dist/openza-personal-cloud-<version>
```

The fixture uses the actual bundled Worker, all migrations and in-memory D1.
It serves current `public/` assets on `http://127.0.0.1:8788/`, with synthetic
tasks and a synthetic owner session. It binds loopback only and does not read
`.dev.vars`, a real passkey, credentials or the normal local cloud database.
Its auth facade is for this test fixture only; it must never be deployed.
Ctrl+C stops the fixture and discards its database. Restarting creates a new
instance identity, so durable browser mutation sequences cannot alias old data.

For the real .NET Core/SQLite sync acceptance, run in the Tasks repository:

```powershell
$env:OPENZA_SHARED_ACCEPTANCE_ORIGIN = 'http://127.0.0.1:8788/'
$env:OPENZA_TASKS_DEV_DATA_DIR = Join-Path $PWD 'artifacts/shared-acceptance-dev'
dotnet test src/Openza.Tasks.Tests/Openza.Tasks.Tests.csproj -c Release --filter FullyQualifiedName~PersonalCloudSharedWorkerAcceptanceTests
Remove-Item Env:OPENZA_SHARED_ACCEPTANCE_ORIGIN
```

The test first requires the fixture marker. It pairs a synthetic desktop using
the normal pairing API and keeps its credentials in memory. It exercises
Desktop create → Web patch → SQLite restart → Desktop patch → Web move →
complete/reopen → delete, preserving authoritative modification time.
It is skipped by default. Production/Preview apps and their stores are unused.

Chrome acceptance also checks row commands, project and Space editing,
save/discard/cancel, filters, themes, narrow layouts and two-window conflicts.
To simulate a service read outage without losing D1 state, create an empty file
at `artifacts/parity-service-unavailable`, then use Refresh tasks. Cached data
must become read only. Remove the file and refresh; editing must resume.
This simulates a service interruption, not OS-level network loss.

Run `npm run test:web`, `npm run typecheck`, `npx vitest run`, and
`npm run test:d1-limits` and `npm run test:migrations` for the corresponding automated checks.
The D1 limits probe uses `uv` to select Python 3.11 or newer. The migration check
upgrades a populated schema 22 database and verifies retained receipts and foreign keys.
Real external
accounts and native Linux accessibility/scaling need their own platform runs;
synthetic acceptance must not be described as those checks.
