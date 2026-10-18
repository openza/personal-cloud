# Continue the local candidate on Windows

## Source branches and scope

Use this repository's `feat/web-desktop-functional-parity` branch together with
[`openza/tasks`](https://github.com/openza/tasks), branch
`feat/personal-cloud-initial-sync-progress`. Fetch both branches and use isolated
development worktrees following their applicable `AGENTS.md` instructions. Leave
the primary checkout on its default branch. Do not merge either branch as part
of this handoff.

This Cloud branch combines initial-upload feedback, bounded sequential mutation
batches, indexed source-history recovery, source ownership safeguards, workspace
records and paging, and the Web task workbench. The workbench includes responsive
panes, Spaces/projects/labels, sorting/grouping/filtering, create and open, draft
copy and keyboard commands, archived-project navigation, and Desktop-owned
delivery status. Provider account setup, intake and routing remain Desktop-only. Draft version checks survive polling and label changes;
accepted creation and deferred navigation are protected across refresh failures
and sign-out. Pending provider work does not imply provider confirmation.

The Tasks branch contains shared/Core and Avalonia changes, plus some WinUI
changes. Avalonia acceptance does **not** establish Windows-native WinUI feature
parity. Read the Tasks branch's own continuation note and validate the intended
Windows host directly with equivalent disposable Dev data.

## Restore dependencies and check source

The last Linux verification used Node.js `22.23.2` and npm `10.9.8`. The lockfile's
Wrangler dependency requires Node.js 22 or newer; Node.js 22 is the verified lane.
Use Git, Node/npm and Gitleaks installed through the normal Windows tooling
workflow. From the Cloud feature worktree, in PowerShell:

```powershell
git status --short --branch
git log -1 --oneline
node --version
npm --version
npm ci
npm run typecheck
npm run test:web
```

`npm test` still contains a POSIX inline environment assignment. The recovery
test script now invokes Node directly. Use these commands in PowerShell:

```powershell
$env:WRANGLER_LOG_PATH = Join-Path $env:TEMP "openza-personal-cloud-tests.log"
npx --no-install vitest run
npm run test:rebootstrap
npm run test:d1-limits
gitleaks detect --source . --verbose
```

Scan the current/staged files as well before another commit; the history scan
alone does not cover new or modified files. These commands are continuation
instructions, not a claim that the Windows checks have already passed.

## Run a fresh, local-only Worker

The current source advertises schema 25. Keep all ordered migrations through
`0025_task_updated_at.sql`; migrations 21-22 add initial-upload status and
history indexes, 23-24 add the combined workspace and source-identity support,
and 25 retains authoritative task modification times.
Use the checked-in local configuration and a new disposable persistence directory:

```powershell
npx --no-install wrangler d1 migrations apply DB --local --persist-to .wrangler/windows-dev-state
npx --no-install wrangler dev --local --ip 127.0.0.1 --port 8787 --persist-to .wrangler/windows-dev-state
```

Open `http://localhost:8787/`, using the hostname consistently for WebAuthn. See
[the README](../README.md#local-verification) for the separate local owner setup
and ignored `.dev.vars` configuration. Any fresh passkey, recovery or pairing
setup needs the human's participation; no existing authentication material is
included in this branch. Do not connect the Dev app to daily-use data or a live
Personal Cloud for this validation.

Git does not carry the Linux browser sessions, local D1/SQLite state, device
credentials, synthetic seed databases, ignored audit harnesses, screenshots or
operational logs. Recreate disposable Windows fixtures instead of copying a live
profile or credentials. The previous audit's synthetic session facades shared a
numbered fixture pool, so that audit does not prove independent-session isolation.

## Historical Ubuntu acceptance and remaining checks at handoff

Before the original Ubuntu handoff, the then-current reviewed source passed 109 Web tests,
17 focused Worker delivery/auth tests, five Worker shell tests, TypeScript
checking and diff checks. The unchanged backend retained its earlier full
153-test / 28-file result. The final independent correction review passed
22 targeted regressions with no remaining confirmed P1/P2 findings. These are
recorded Linux/local results; they are not a new Windows run.

Local browser checks covered 320/390/768/1024/1280 viewports, task/reference
lifecycle, source metadata preservation, stale-draft conflicts, ordinary
label-and-notes saves, offline recovery, catalog and delivery controls, and
unavailable-route cleanup using synthetic data and fake provider bridges.

Remaining validation includes actual passkey/owner/recovery/pairing ceremonies,
full native Windows interaction, literal 200% zoom, comprehensive accessibility,
and real-provider/business acceptance. Automatic approval blocked an owner-setup
submission during the local audit; no credential ceremony or bypass followed.
Initial-upload progress is distinct from ongoing sync and provider delivery.

## Subsequent Windows evidence and this correction

[PR #2](https://github.com/openza/personal-cloud/pull/2) records the later
Windows/Node 26 recovery checks, schema-25 migration and isolated restore
validation, and shared Worker/SQLite round-trip acceptance. Those are prior PR
records, separate from the historical Ubuntu counts above. They do not establish
WinUI parity, native Linux accessibility, real-provider or production acceptance.

The follow-up Web correction restores owner-only Settings delivery-lock recovery.
A desktop must be revoked, and the owner must explicitly confirm that its host
is stopped and provider state has been checked. It does not restore Web provider
intake or routing. Accepted autosaves retain their draft while a confirming read
is unavailable; they cannot be resent or reopened by a stale session continuation.

## Artifact and production boundary

Pushing these branches does not package, install, migrate or deploy anything.
Ignored `dist/` bundles are not transferred by Git, and an older Desktop artifact
pin must not be assumed to contain this source. A future package must build and
stage a matching checksum-manifested Cloud artifact using the Tasks repository's
documented process and then verify its schema/capabilities.

The current `scripts/build-artifact.mjs` invokes Wrangler's JavaScript entry point
with `process.execPath`, uses the operating system temporary directory, recursively
packages nested assets, and emits POSIX manifest paths. It normalizes migration
SQL to LF before hashing; `.gitattributes` also retains LF migration checkouts.
The extensionless-executable/POSIX-log limitation described at the original
Ubuntu handoff was fixed by the subsequent Windows commits. This correction
does not rerun Windows packaging or update any Desktop artifact pin. Build and
verify a matching artifact from the intended source before staging it.

Do not run remote migrations, Cloudflare login/provisioning, deployment, account
cleanup, real-provider writes, package installation or release as part of this
continuation. Live lifecycle and destructive drills remain separate approval and
acceptance gates. Keep the installed daily apps and their data untouched.
