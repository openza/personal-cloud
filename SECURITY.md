# Security and privacy

Personal Cloud is an optional private copy of your Openza tasks hosted in **your Cloudflare account**. The Web shell is public; task APIs require an owner session or an explicitly paired Desktop. This is access control, not end-to-end encryption: Cloudflare processes and stores task content, and account administrators can access resources.

## Data boundaries

- Task titles, notes, Spaces, projects, labels, planning, completion and safe provider-source descriptors synchronize. Source descriptors may contain provider URLs and descriptions; treat them as private task data.
- Provider credentials remain on Desktop. Cloud does not call Todoist, Microsoft or other task providers. A paired, provider-capable Desktop performs those operations.
- Desktop keeps its refresh credential in its OS credential store. Web uses an HttpOnly owner-session cookie. The server stores hashed credential verifiers, not the original pairing grants or refresh credentials.
- The browser stores its last confirmed task copy in local storage for stale, read-only viewing. Signing out revokes the session but does **not** erase that cached copy. Do not use a shared browser profile for private tasks; clear site data when leaving it.
- Passkeys are managed by the user's browser/OS credential provider. Keep recovery codes private; they can replace owner access. Lost Desktop access can be revoked in Web Settings.
- There is no Openza-operated task hosting service or analytics endpoint in this repository. Cloudflare may retain platform/account logs under its own policies. Avoid logging credentials or task bodies.

## Report a vulnerability

Use the repository's **Security → Report a vulnerability** option when available. If private reporting is unavailable, contact a maintainer through a verified private channel first. Do not post tokens, recovery codes, private task data or exploit credentials in a public issue. Public issues are suitable for non-sensitive defects only. This preview has no guaranteed response time or security SLA.

## Supported state

Only the current preview source is maintained. A passing local test suite does not prove that an older deployed Worker has the fixes. Inspect `/health` and the deployment's artifact version before reporting a result. Updates, schema changes and destructive removal require the account owner's explicit action.

See [the lifecycle runbook](docs/lifecycle.md) for backup and rollback precautions.
