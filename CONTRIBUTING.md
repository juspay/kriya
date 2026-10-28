# Contributing to Kriya

Use an isolated branch/worktree, install the locked dependencies and validate the actual package
consumer. Keep runtime changes, live-provider acceptance and release/deployment claims distinct.

## Setup

```sh
nvm use
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

`.nvmrc` selects Node 24.22.1. Development/release tooling needs a compatible modern Node release;
consumer runtime support starts at Node 22 (Node 20 reached end of life in April 2026) and CI exercises
Node 22, 24 and 26 after installation under Node 24. Raise the consumer engine floor only when a Node
line reaches end of life, never just to match contributor tooling.
No API key or environment file is needed for unit/package/documentation integration checks.

## Required checks

```sh
pnpm run validate
pnpm test --runInBand
pnpm run test:tooling
pnpm run build
pnpm run verify:package
pnpm run docs:verify
pnpm audit --prod
pnpm audit
```

The last command currently reports known development-only advisories; inspect the actual output
and SECURITY.md. It is not a zero-findings gate. Do not force unsafe downgrades to hide it.
Use tsc --noEmit --incremental false to avoid shared build-info races. Lint has a zero-warning bar.
New public type definitions belong in src/types and must be re-exported; use type, named exports
and structured error results. Keep secrets out of goals, observations, events and recorded payloads.

Each PR contains one conventional commit with subject type(scope): description. A breaking package
surface removal must include a BREAKING CHANGE footer. Never include recordings, credentials,
local acceptance evidence or generated API/site output in a commit. Preserve failed evidence locally.

## Documentation website

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r docs-requirements.txt
pnpm run docs:api
.venv/bin/mkdocs build --strict --clean
```

The workflow generates API docs under docs/api-generated; authored guides remain under docs/.
Keep the four documentation PR gates blocking: markdownlint, TypeDoc, MkDocs and link validation.
When changing an example, update its executable verification rather than claiming prose review
alone establishes that an integration works.

The public documentation deployment uses GitHub Actions and the github-pages environment.
A repository administrator must configure Pages with build_type workflow once. The configure-pages
action cannot enable it with the normal GITHUB_TOKEN. For an authorized maintainer using gh:

```sh
gh api --method POST repos/juspay/kriya/pages -f build_type=workflow
gh workflow run docs-deploy.yml --repo juspay/kriya --ref main
```

Read the current Pages configuration before changing it. Do not create a second configuration
when one already exists. Docs deployment is separate from npm publication and from PR merge.

## Release and maintenance

Semantic-release on main determines the version, generates/formats CHANGELOG and publishes via
the repository's configured npm authentication/provenance workflow. Do not hand-bump a version to
pretend a local change shipped. The ReScript package-surface removal requires the next major release.
Keep npm/GitHub Actions Dependabot maintenance; there is no Docker image in this repository.

See docs/integration for supported consumer paths and e2e/README.md for the paid live harness.
Live provider runs need explicit cost/credential authorization; offline checks are not provider acceptance.
