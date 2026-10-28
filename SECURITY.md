# Security policy

Report vulnerabilities privately through [GitHub security reporting](https://github.com/juspay/kriya/security/advisories/new)
or <opensource@juspay.in>. Include the affected version, impact and reproduction details. Do not
include real credentials or private user data. Maintainers determine affected releases and fixes;
this project does not promise a response SLA or blanket support for every historical version.

## Integration responsibilities

Keep provider keys outside the page and out of goals. Bind private inputs to authorized origins
and targets. Treat page text as untrusted. Protect checkpoints as personal data and consume
approvals atomically when continuing across processes. Cancellation and timeouts do not roll back
writes. Screenshots/video need a separate privacy review. See
[privacy and verification](docs/integration/security.md) for the execution boundaries.

## Dependency audit limitation

The 28 October 2026 audit baseline reports zero production findings. The only production
dependency is html2canvas. Three development findings remain and cannot be fixed from this
repository:

- `semantic-release` depends on `@semantic-release/npm`, which depends on the npm CLI package. npm
  ships its dependency tree as bundled files, and every published npm 11.x and 12.x release bundles
  undici 6.29.0 and ip-address 10.7.2. Bundled files are extracted verbatim, so overrides cannot
  replace them, and removing the plugin from the release configuration does not remove it from the
  dependency tree. `pnpm-lock.yaml` does not list bundled files, so lockfile-based scanners and
  `pnpm audit` do not report them; the files are still installed under `node_modules/.pnpm` and run
  only while the release job publishes from isolated CI.
- Jest's configuration loader depends on deepmerge 4.3.1, which has no fixed release.

Advisories: [undici content-encoding](https://github.com/advisories/GHSA-xjj6-f33q-929c),
[undici EventSource](https://github.com/advisories/GHSA-4qv8-2p9j-2685),
[undici TLS options](https://github.com/advisories/GHSA-2m5v-pch6-74hx),
[undici renegotiation](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm),
[undici WebSocket PONG](https://github.com/advisories/GHSA-9fm3-97px-rjf6),
[ip-address](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5),
[deepmerge](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).

Supply-chain controls in this repository: every GitHub Action is pinned to a commit SHA, Dependabot
waits seven days before proposing a newly published version, `.npmrc` sets
`minimum-release-age=10080` (seven days) so fresh versions are not resolved into the lockfile, and
`pnpm install --frozen-lockfile` installs only what the lockfile pins. Run `pnpm audit --prod` and
`pnpm audit` separately when reviewing a release. Do not disable audit or downgrade unrelated
packages to silence these findings; the bundled copies clear when npm ships patched bundles, and
deepmerge clears when Jest drops it.
