---
name: github-pr-creator
description: |
  Creates a GitHub pull request from the current branch by validating preconditions, discovering PR templates, analyzing commits and changed files, pushing the branch, and opening the PR with the GitHub CLI.
  Use when the user wants to open a PR for unpushed commits, generate a PR title and body from commit history, or turn a feature branch into a reviewable pull request.
  Do NOT use for merging PRs, reviewing PR contents, or repositories hosted outside GitHub.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "git github pull-request gh-cli workflow"
  category: "software-engineering"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# GitHub PR Creator

Create a GitHub pull request from the current branch's unpushed commits. Input may include a base branch name and/or flags such as `--draft`; the base branch defaults to `main`.

## Phase 1 — Validate

Check preconditions before doing anything irreversible:

```bash
git branch --show-current
git status --short
git log origin/<base>..HEAD --oneline
```

| Check | Condition | Action if failed |
|---|---|---|
| Not on base branch | Current branch != base | Stop: "Switch to a feature branch first." |
| Clean working directory | No uncommitted changes | Warn: "You have uncommitted changes. Commit or stash first." |
| Has commits ahead | `git log origin/<base>..HEAD` not empty | Stop: "No commits ahead of `<base>`. Nothing to PR." |
| No existing PR | `gh pr list --head <branch> --json number` is empty | Stop: "PR already exists: #<number>." |

If all checks pass, proceed.

## Phase 2 — Discover

### PR Template

Search for a PR template in order:

1. `.github/PULL_REQUEST_TEMPLATE/` directory — if it exists, list files and let the user choose (or use `default.md`)
2. `.github/PULL_REQUEST_TEMPLATE.md`
3. `.github/pull_request_template.md`
4. `docs/pull_request_template.md`

If found, read it and use its structure for the PR body.

### Commit Analysis

```bash
git log origin/<base>..HEAD --format="%h %s" --reverse
```

Determine:

- **PR title** — conventional-commit format with a type prefix (`feat: ...`, `fix: ...`). If multiple types, use the dominant one; if a single commit, use its message as-is.
- **Change summary** — group commits by type/area.

### File Analysis

```bash
git diff origin/<base>..HEAD --stat
git diff origin/<base>..HEAD --name-only
```

Categorize changed files: source, tests, docs, config, migrations.

### Planning Artifacts

If the project keeps planning artifacts (PRDs, implementation plans, implementation reports) under a docs directory such as `docs/prds/`, `docs/plans/`, or `docs/reports/`, reference the relevant ones in the PR body so reviewers can trace intent.

## Phase 3 — Push

```bash
git push -u origin HEAD
```

If the push fails due to divergence:

```bash
git fetch origin
git rebase origin/<base>
git push -u origin HEAD
```

If rebase conflicts occur, stop and inform the user.

## Phase 4 — Create

### With Template

Fill each template section from the commit and file analysis. Preserve all sections — mark inapplicable ones "N/A" rather than deleting them.

### Without Template

```markdown
## Summary
<1-2 sentence description of what this PR does and why>

## Changes
<bulleted list of changes grouped by area>

## Files Changed
<list of changed files with change type: Added/Modified/Deleted>

## Testing
<how the changes were tested, or "Needs testing">

## Related Issues
<Closes/Fixes/Relates to #N, or "None">
```

### Open the PR

```bash
gh pr create \
  --title "<PR title>" \
  --base <base-branch> \
  --body "<PR body>"
  # Add --draft if the --draft flag was requested
```

## Phase 5 — Verify

```bash
gh pr view --json number,url,title,state,baseRefName,headRefName,additions,deletions,changedFiles
gh pr checks --json name,status,conclusion 2>/dev/null || true
```

## Phase 6 — Output

```
PR #<number>: <title>
URL: <url>
Branch: <head> -> <base>
Changes: +<additions> -<deletions> across <changedFiles> files
CI Checks: <status summary or "pending" or "none configured">
Artifacts referenced: <any planning docs linked in the PR body>
```

## When to Use

- Turning a finished feature branch into a reviewable pull request
- Auto-generating a PR title and body from commit history
- Wiring a PR template's sections from real diff analysis

## Edge Cases

- **No `gh` CLI**: stop with an install pointer to the GitHub CLI.
- **Not authenticated**: stop with "Run `gh auth login` first."
- **Force push needed**: after a rebase, use `git push --force-with-lease` — never `--force`.
- **Multiple PR templates**: list them and let the user choose.
- **Large PR (>20 files)**: warn about size and suggest splitting if the changes are logically separable.
