# Git hooks

Husky is installed by npm prepare for repository contributors.

- pre-commit runs lint-staged without a stash, full source lint/format/type checks, quick security/staged-file checks and optional redacted gitleaks.
- commit-msg enforces conventional commit subjects.
- pre-push runs types, lint, tests, security/build validation, package build and consumer/integration checks.

Install the contributor Node version and Chromium before using the full gate. See CONTRIBUTING.md.
Hooks run checks; they do not authorize a push, paid provider run or merge. ReScript is no longer
part of the build. Unique local evidence and other worktrees must not be deleted by cleanup scripts.
