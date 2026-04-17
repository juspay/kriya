## Description

<!-- What does this PR change, and why? -->

## Type of Change

- [ ] feat — new feature (non-breaking)
- [ ] fix — bug fix (non-breaking)
- [ ] refactor — no behavior change
- [ ] perf — performance improvement
- [ ] docs — documentation only
- [ ] test — adding/updating tests
- [ ] chore — tooling/infra
- [ ] BREAKING CHANGE — backwards-incompatible

## How has this been tested?

<!-- Steps to verify. Attach repro output, screenshots, or linked CI run. -->

- [ ] Unit tests added/updated
- [ ] Manually verified in browser (DOM/form flows)
- [ ] Node CJS + ESM consumers tested

**Test environment**:

- Node version:
- Browser (if applicable):

## Checklist

- [ ] **Single commit** on this branch (required — squash before pushing)
- [ ] Commit message follows `type(scope): description` (Conventional Commits)
- [ ] Code is strictly typed — no `any`, no `@ts-ignore`, no non-null `!`
- [ ] No `console.log`/`debugger` left in `src/`
- [ ] All public library functions return a typed `Result` (no throws)
- [ ] `npm run lint`, `npm run type-check`, `npm test`, `npm run build` all pass locally
- [ ] No hardcoded secrets or credentials
- [ ] DOM writes avoid `innerHTML`/`eval`/`new Function`
- [ ] Documentation updated (README / docs/ / JSDoc on public API)
- [ ] CHANGELOG will be generated via semantic-release — no manual edit

## Linked Issues

<!-- Closes #123 -->

## Screenshots / Recordings (if UI-adjacent)

## Additional Context

<!-- Design decisions, tradeoffs, known follow-ups. -->

---

By submitting this PR you agree to the [single-commit-per-branch policy](./SINGLE_COMMIT_POLICY.md).
