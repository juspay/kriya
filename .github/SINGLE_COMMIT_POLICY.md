# Single Commit Per Branch Policy

Kriya enforces a **single commit per branch policy** to keep `main` linear and make reviews, bisects, and rollbacks trivial.

## Policy

- ✅ Each feature branch must contain **exactly 1 commit** ahead of `main`
- ✅ Commit messages must follow **`type(scope): description`** (Conventional Commits)
- ✅ **No merge commits** in feature branches — rebase, don't merge
- ✅ `main` merges are **squash-only**

## Enforcement

- Automated via `.github/workflows/single-commit-enforcement.yml`
- Enforced at branch protection on `main` as a required status check

## Compliant workflow

```bash
git checkout -b feat/my-change
# make changes
git add .
git commit -m "feat(core): add new executor"
git push origin feat/my-change
# open PR to main → check passes ✅
```

## If you have multiple commits

### Option 1 — Interactive rebase

```bash
git rebase -i HEAD~N          # N = number of commits to squash
# change 'pick' → 'squash' for all but the first, save
git push --force-with-lease
```

### Option 2 — Soft reset

```bash
git reset --soft origin/main
git commit -m "feat(core): combined change description"
git push --force-with-lease
```

## Valid commit types

`feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`, `ci`, `build`, `revert`, `hotfix`

## Amending in-place

If your PR review asks for changes, amend rather than add a new commit:

```bash
git add .
git commit --amend --no-edit
git push --force-with-lease
```

## FAQ

**Q: What about emergency hotfixes?**  
Same policy. One commit, one PR, squash-merge to `main`.

**Q: What about collaborative branches?**  
Designate one owner to squash before raising the PR, or split into multiple single-commit PRs.

**Q: What if I merged `main` into my feature branch?**  
Rebase instead: `git rebase origin/main && git push --force-with-lease`.
