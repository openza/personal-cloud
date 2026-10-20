# Cloud upgrade compatibility v1

This contract coordinates Personal Cloud and Tasks Desktop. It preserves protocol
1, schema 25, manifest format 1 and existing successful health fields/capabilities.
It adds no migration and does not change a release artifact pin.

## Health and deployment

`GET /health` returns the existing success response only after a bounded read-only
probe resolves every required table/column and finds the required named indexes
and triggers, including schema 24 paging and schema 25 modification-time objects.
The probe reads schema metadata and compiles zero-row column queries; it does not
scan tasks, receipts or history. An incomplete, empty or unavailable D1 binding
returns HTTP 503, `Cache-Control: no-store` and a generic `schema_not_ready` error.
SQL, task data and resource identifiers are not returned.

This proves the expected schema footprint is available. It does not validate
historical migration checksums, trigger/index definitions, all stored data, a
backup's recoverability, or compatibility with a future schema. Desktop must
separately validate the checksum migration journal before deployment. A journal
must be an explicitly ordered exact prefix of the validated artifact migrations;
unknown/newer entries, gaps, duplicate names and changed checksums stop the update
before deployment or migration. Wrangler's names-only `d1_migrations` ledger is
distinct from Desktop's `openza_schema_migrations` checksum journal. Do not invent
checksums or treat names as checksum proof.

Desktop retains negotiated capabilities, checkpoints and pending intents when
health fails. HTTP 503, malformed/incompatible HTTP 200, network failures and
other health errors cannot downgrade a previously negotiated cloud to legacy
behavior. Only an explicitly unsupported endpoint (404/405/501) can permit a
legacy path when that path is safe for the prior negotiation.

The artifact keeps exactly the manifest format 1 fields consumed by existing
Desktop. Its Worker, nested assets, `_headers` metadata and ordered migrations
remain size/hash verified. Migrations retain LF normalization. Readiness does not
authorize downgrade, SQL restore, remote deployment or resource replacement.

## Browser session and mutation boundaries

`owner-api.js` owns HTTP serialization, owner locking and the single explicit
CSRF retry. Every invocation captures its session generation before waiting for
the owner lock and checks it after awaited network/body work, before installing
a refreshed CSRF token and before retrying. A stale success or failure cannot
authenticate, render or sign out a later owner session.

`mutation-queue.js` captures that generation before waiting for the replica lock.
A cancellation before dispatch cannot allocate an old action or retain a newly
unsubmitted envelope. Once dispatched, an uncertain outcome keeps its exact
durable envelope for reconciliation. Cancelling an attempted replay preserves a
previously uncertain envelope. No automatic new mutation is substituted.

`owner-settings.js` guards pairing-grant and device-list callbacks; the app owns
their rendering. Session rotation and mutation/detail/workspace callbacks also
check their originating generation before installing tokens or changing UI.
Read-only cached data and accepted-save/read-failure recovery remain unchanged.

## Verification boundary

Use synthetic local data to check current health, incomplete schemas, missing
invariant objects, unavailable D1, exact artifact hashes, populated upgrades and
session races. Local browser behavior, Desktop artifact loading and deployed-cloud
validation cover different integration boundaries.

For a local artifact rehearsal, build a synthetic version and run:

```sh
npm run build:artifact -- 0.0.0-local-upgrade-v1
OPENZA_TEST_ARTIFACT=dist/openza-personal-cloud-0.0.0-local-upgrade-v1 npm run test:artifact
```

The artifact test checks format 1 fields, file hashes, LF-normalized migrations,
schema 17/20/22/24 health rejection and a populated upgrade to schema 25 with
receipt, version-claim, modification-time and foreign-key preservation. Worker
tests also bound the health read cost with populated tasks/history (114 metadata
row reads and zero application-row reads in the local D1 fixture).

For synthetic browser acceptance, run the existing shared-parity fixture with
that artifact. Opening `http://127.0.0.1:8788/__synthetic-fixture/health/unready`
removes a required trigger only in its disposable database. The built Worker's
health then returns a real 503; Refresh tasks must retain the cached workspace
read-only without signing out. Open `/__synthetic-fixture/health/ready` to restore
the trigger, then refresh to regain current/editable state. These routes exist
only in the local synthetic fixture server; they are not shipped Web/Worker APIs.
