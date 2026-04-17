# Branch Protection Configuration

Required GitHub settings to enforce Kriya's quality pipeline. Apply via **Settings → Branches → Add rule** on the `main` branch, or via `gh api` (see below).

## Protected branch: `main`

### Pull Request Requirements

- ✅ **Require a pull request before merging**
- ✅ **Require approvals**: 1
- ✅ **Dismiss stale pull request approvals when new commits are pushed**
- ✅ **Require review from code owners** (CODEOWNERS active)

### Required Status Checks

Add these contexts (names must match exactly):

- `🧪 Test (Node 20)`
- `🧪 Test (Node 22)`
- `📦 Build & Package Check`
- `🛡️ Code Quality & Security Gate`
- `🔒 Single Commit Policy Validation`

AI review is handled by the **CodeRabbit GitHub App** (install via
[github.com/apps/coderabbitai](https://github.com/apps/coderabbitai)) which
reads `.coderabbit.yaml`. CodeRabbit posts its own review status — do **not**
add it as a required status check unless you want merges blocked on AI review.

Also:

- ✅ **Require branches to be up to date before merging**

### Commit Requirements

- ✅ **Require linear history**
- ✅ **Require signed commits** _(optional, recommended)_

### Merge Settings (Repository → Settings → General)

- ✅ **Allow squash merging** — default to PR title + commit message
- ❌ **Allow merge commits**
- ❌ **Allow rebase merging**
- ✅ **Always suggest updating PR branches**
- ✅ **Automatically delete head branches**

### Push Restrictions

- ❌ Force pushes
- ❌ Deletions
- ✅ Restrict pushes that create merge commits

## One-shot CLI configuration

```bash
OWNER=juspay
REPO=kriya

# Branch protection
gh api "repos/$OWNER/$REPO/branches/main/protection" \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["🧪 Test (Node 20)","🧪 Test (Node 22)","📦 Build & Package Check","🛡️ Code Quality & Security Gate","🔒 Single Commit Policy Validation"]}' \
  --field enforce_admins=false \
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true,"require_code_owner_reviews":true}' \
  --field restrictions=null \
  --field required_linear_history=true \
  --field allow_force_pushes=false \
  --field allow_deletions=false

# Repository merge settings
gh api "repos/$OWNER/$REPO" \
  --method PATCH \
  --field allow_squash_merge=true \
  --field allow_merge_commit=false \
  --field allow_rebase_merge=false \
  --field delete_branch_on_merge=true \
  --field allow_auto_merge=true
```

## Required repository secrets

| Secret           | Purpose                 | Required           |
| ---------------- | ----------------------- | ------------------ |
| `NPM_TOKEN`      | Publish to npm registry | Yes (for releases) |
| `OPENAI_API_KEY` | AI PR review workflow   | Optional           |
| `GITHUB_TOKEN`   | Auto-provided           | N/A                |

Add via **Settings → Secrets and variables → Actions**.

## GitHub Apps to install

- **Settings** (github.com/apps/settings) — applies `.github/settings.yml`
- **CodeRabbit** (github.com/apps/coderabbitai) — native AI PR review; reads `.coderabbit.yaml`

## Verification

1. Create a branch with 2+ commits
2. Open a PR to `main` — Single Commit check fails
3. Squash commits — all checks pass
4. Merge dropdown offers only "Squash and merge"
5. On merge, branch auto-deletes; `main` stays linear
