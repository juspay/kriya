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

The 9 October 2026 audit baseline reports zero production findings and 14 development findings
(12 high, 2 moderate). The development chain includes an unpatched braces advisory through
micromatch/release tooling and vulnerable packages bundled inside npm used by @semantic-release/npm.
Safe dependency removals/upgrades and npm audit fix do not eliminate that upstream limitation.
These are build/release dependencies, not consumer runtime dependencies. Keep release inputs
trusted and use isolated CI; this bounds exposure but is not a vulnerability fix.

- [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
- [Bundled undici advisory](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5)
- [Bundled PostCSS selector parser advisory](https://github.com/advisories/GHSA-rj75-hqrm-r3gf)

Run npm audit --omit=dev and npm audit separately when reviewing a release. Do not disable audit,
force unrelated release-stack downgrades or call these findings resolved before a patched upstream
chain is installed and verified. Repository CI retains the production audit gate; development
findings remain an explicit maintenance item.
