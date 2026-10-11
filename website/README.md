# Openza public website

Static public product site for `https://openza.org/`, separate from Personal Cloud runtime code and user task deployments. No D1 bindings, credentials, task data, scripts, analytics, or account registration.

The owner approved using this existing worktree for the website while the separate managed fork remains unresolved. Do not edit or remove that pending checkout as part of this change.

## Build and check

Requires Node.js 22.18+ for the Cloudflare CLI configuration.

```sh
cd website
npm ci
npm run build
npm test
npm run preview
```

Preview binds only to `127.0.0.1:8799`. `dist/` and Cloudflare build/cache output are ignored. Source is `build.mjs` and `public/`; generated output must not be committed.

Deployment uses a separate assets-only Worker named `openza-website` through the official Cloudflare CLI. Review the configuration and authenticated account before deploying. Do not run the website deployment command from the parent Personal Cloud runtime directory.

```sh
npm run build
npm test
npx cf deploy --dry-run
npm run deploy -- --profile YOUR_AUTH_PROFILE
```

The deploy script regenerates and checks the assets before deployment. Configure your own CLI authentication profile; no account credentials are included in source. The custom domain is `openza.org`. Cloudflare manages the domain's DNS and certificate when deploying its trigger. Preserve its existing OAuth publisher-verification TXT record. No user cloud resources are targeted.

The public site must label Personal Cloud as preview and public OAuth onboarding as unavailable until explicitly approved and verified. Website publication does not promote OAuth or publish a production app release.

## Branding

Reuses the owner's existing circle badge from `solanky.dev/openza`, with the lightning mark reserved for Tasks. The square Openza logo is at `/openza.svg`, Tasks logo at `/tasks.svg`, and wordmark at `/wordmark.svg`.

Source code follows the repository license. Openza names and logos are copyright Deependra Solanky; they are not granted under the source-code license. Reuse here is authorized by the brand owner.
