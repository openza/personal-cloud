# Signed cloud releases

Personal Cloud (Worker, Web assets and D1 migrations) is released on its own,
independent of Openza Desktop releases. Desktop remains the only component that
installs or upgrades an owner's cloud: it downloads a signed release, verifies
it and deploys it with the existing short-lived Cloudflare authorization. The
cloud never holds a Cloudflare credential and never updates itself.

## Release format

Each release is a GitHub Release of `openza/personal-cloud` tagged
`cloud-v<artifactVersion>`, with exactly these assets:

| Asset | Content |
| --- | --- |
| `openza-personal-cloud-<artifactVersion>.zip` | The artifact directory produced by `npm run build:artifact -- <artifactVersion>` (`artifact-manifest.json`, `worker.js`, `assets/`, `migrations/`) |
| `cloud-release.json` | Release metadata (below) |
| `cloud-release.json.sig` | ECDSA P-256 / SHA-256 signature of the exact `cloud-release.json` bytes, DER-encoded, then base64 |

`cloud-release.json`:

```json
{
  "formatVersion": 1,
  "product": "openza-personal-cloud",
  "artifactVersion": "0.1.0-preview.11",
  "releaseNumber": 11,
  "minDesktopVersion": "1.3.0",
  "sourceRevision": "<40-character git commit>",
  "manifestSha256": "<sha256 of artifact-manifest.json>",
  "archive": {"file": "openza-personal-cloud-0.1.0-preview.11.zip", "size": 123, "sha256": "<sha256>"}
}
```

- `releaseNumber` is a strictly increasing integer. It orders releases;
  `artifactVersion` labels stay opaque.
- `minDesktopVersion` is the oldest Desktop that can sync with and manage this
  cloud. It is raised only when a release needs something older Desktops lack.
- The repository's `cloud-release.config.json` holds `releaseNumber` and
  `minDesktopVersion` for the next release; the release workflow checks that
  the tag matches and copies them into the signed metadata.

The signing key's private half exists only as the `CLOUD_RELEASE_SIGNING_KEY`
secret of the tag-restricted `cloud-release` GitHub environment. Desktop
embeds the public key. A compromised GitHub release page alone cannot change
what Desktop installs: Desktop rejects any metadata without a valid signature,
any archive whose size or hash differs, and any artifact whose manifest hash or
file hashes differ.

## How Desktop selects and installs a release

1. List the repository's published (non-draft) releases from the GitHub API.
2. For each release, download `cloud-release.json` and its signature, and
   verify the signature before reading anything else.
3. Choose the highest `releaseNumber` whose `minDesktopVersion` is not newer
   than the running Desktop. If a newer release needs a newer Desktop, show
   "Update Openza Desktop to get Personal Cloud <version>".
4. Download the archive, check its size and SHA-256, extract it into
   Desktop's data folder (rejecting paths outside the folder), and verify
   `manifestSha256` and every manifest entry as before.
5. Deploy with the existing checks: target identity, migration provenance,
   origin, migrations, then `/health` reporting exactly the installed
   `artifactVersion`.

An interrupted first setup resumes with the exact `artifactVersion` it started
with. Verified downloads are cached by version and re-verified before reuse.
Dev builds may still point `PersonalCloudArtifactDirectory` at a locally built
artifact for unreleased testing.

## Compatibility rules (cloud may be newer than Desktop)

1. **Add only.** A cloud release keeps every endpoint, field, capability shape
   and behaviour that a supported Desktop uses. New behaviour arrives as new
   fields, new optional capabilities or new endpoints.
2. **Migrations only add.** New tables, columns with defaults, and indexes.
   Removing or renaming happens only after `minDesktopVersion` has moved past
   every Desktop that used the old shape.
3. **Desktop ignores what it does not know.** Unknown `/health` fields,
   unknown capabilities, extra keys inside a known capability and higher
   `schemaVersion` values are accepted; known capabilities are still checked
   exactly for the values Desktop relies on.
4. **Breaking changes raise `minDesktopVersion`.** Older Desktops then refuse
   to install that release and say why; they keep syncing with the cloud they
   already have.
5. **Mixed-version tests** cover the previous Desktop release against the new
   cloud and the new Desktop against the previous cloud release before a cloud
   release is published.

## One-time repository setup (maintainer)

1. Create the `cloud-release` environment in the repository settings, allow
   deployments only from tags matching `cloud-v*`, and require the
   maintainer's review.
2. Store the PKCS#8 PEM private key as the environment secret
   `CLOUD_RELEASE_SIGNING_KEY` (never as a repository-wide secret). Keep an
   offline backup; Desktop's embedded public key (`PersonalCloudReleaseKeys`)
   must change in a Desktop release before a new key can sign.

## Publishing a cloud release (maintainer)

1. Merge the cloud change with `cloud-release.config.json` updated (next
   `releaseNumber`, and `minDesktopVersion` only if rule 4 applies). The
   workflow refuses a number that is not greater than every earlier
   `cloud-v*` tag's number.
2. Push the tag `cloud-v<artifactVersion>` on that commit. The `Release`
   workflow tests, builds, signs and creates a **draft** GitHub Release.
3. Review the draft (version, release number, minimum Desktop, assets), then
   publish it. Only published releases are visible to Desktop.
4. Owners install it from Openza Desktop: Personal Cloud → Manage → Update.

Web assets, Worker and migrations always ship together in one release, so the
Web app and its API are never out of step with each other.
