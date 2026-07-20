---
name: code-review
description: >-
  Runs a comprehensive code review of either local uncommitted changes or a GitHub pull request, covering
  correctness, security, performance, and maintainability, then reports findings by severity and (for PRs)
  publishes the review. Use when reviewing changes before commit or a pull request before merge.
  Do NOT use for automated-only linting or for reviewing an architecture proposal that has no code yet.
license: Apache-2.0
type: workflow
skills: code-review-patterns security-review performance-profiling technical-documentation
trigger_phrases: code review review changes review pull request pr review security review before merge
metadata:
  author: darhai
  version: "1.0.0"
  tags: "code-review security quality pull-request github step-by-step"
  category: "software-project"
  depends: "code-review-patterns security-review performance-profiling technical-documentation"
  disclaimer: "none"
  difficulty: "intermediate"
---

# Code Review

Review either local uncommitted changes or a GitHub pull request. If the user supplies a PR number, PR URL, or branch name, use **PR Review Mode**; otherwise use **Local Review Mode**.

## Local Review Mode

Comprehensive security and quality review of uncommitted changes.

### Phase 1 — GATHER

```bash
git diff --name-only HEAD
```

If there are no changed files, stop: "Nothing to review."

### Phase 2 — REVIEW

Read each changed file in full. Check for:

**Security Issues (CRITICAL):**
- Hardcoded credentials, API keys, tokens
- SQL injection vulnerabilities
- XSS vulnerabilities
- Missing input validation
- Insecure dependencies
- Path traversal risks

**Code Quality (HIGH):**
- Functions > 50 lines
- Files > 800 lines
- Nesting depth > 4 levels
- Missing error handling
- Debug/log statements left in
- TODO/FIXME comments
- Missing docs for public APIs

**Best Practices (MEDIUM):**
- Mutation where an immutable pattern is preferable
- Missing tests for new code
- Accessibility issues (a11y)

### Phase 3 — REPORT

Generate a report with severity (CRITICAL, HIGH, MEDIUM, LOW), file and line, issue description, and a suggested fix. Block the commit if CRITICAL or HIGH issues are found. Never approve code with security vulnerabilities.

## PR Review Mode

Comprehensive GitHub PR review — fetches the diff, reads full files, runs validation, posts the review. This mode uses the GitHub CLI (`gh`) or any equivalent GitHub integration.

### Phase 1 — FETCH

Determine the PR from the input:

| Input | Action |
|---|---|
| Number (e.g. `42`) | Use as the PR number |
| URL (`github.com/.../pull/42`) | Extract the PR number |
| Branch name | Find the PR via `gh pr list --head <branch>` |

```bash
gh pr view <NUMBER> --json number,title,body,author,baseRefName,headRefName,changedFiles,additions,deletions
gh pr diff <NUMBER>
```

If the PR is not found, stop with an error. Store PR metadata for later phases.

### Phase 2 — CONTEXT

Build review context:

1. **Project rules** — Read project convention files (for example `AGENTS.md`, `CONTRIBUTING.md`, and any `docs/` guidelines).
2. **Planning artifacts** — Check any PRD, plan, or prior-review documents related to this PR.
3. **PR intent** — Parse the PR description for goals, linked issues, and test plans.
4. **Changed files** — List all modified files and categorize by type (source, test, config, docs).

### Phase 3 — REVIEW

Read each changed file **in full** (not just the diff hunks — you need surrounding context). For PRs, fetch the full file contents at the PR head revision:

```bash
gh pr diff <NUMBER> --name-only | while IFS= read -r file; do
  gh api "repos/{owner}/{repo}/contents/$file?ref=<head-branch>" --jq '.content' | base64 -d
done
```

Apply the checklist across 7 categories:

| Category | What to Check |
|---|---|
| **Correctness** | Logic errors, off-by-ones, null handling, edge cases, race conditions |
| **Type Safety** | Type mismatches, unsafe casts, dynamic-any usage, missing generics |
| **Pattern Compliance** | Matches project conventions (naming, file structure, error handling, imports) |
| **Security** | Injection, auth gaps, secret exposure, SSRF, path traversal, XSS |
| **Performance** | N+1 queries, missing indexes, unbounded loops, memory leaks, large payloads |
| **Completeness** | Missing tests, missing error handling, incomplete migrations, missing docs |
| **Maintainability** | Dead code, magic numbers, deep nesting, unclear naming, missing types |

Assign a severity to each finding:

| Severity | Meaning | Action |
|---|---|---|
| **CRITICAL** | Security vulnerability or data-loss risk | Must fix before merge |
| **HIGH** | Bug or logic error likely to cause issues | Should fix before merge |
| **MEDIUM** | Code-quality issue or missing best practice | Fix recommended |
| **LOW** | Style nit or minor suggestion | Optional |

### Phase 4 — VALIDATE

Detect the project type from config files (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, etc.), then run only the applicable commands:

**Node.js / TypeScript:**
```bash
npm run typecheck 2>/dev/null || npx tsc --noEmit 2>/dev/null
npm run lint
npm test
npm run build
```

**Rust:**
```bash
cargo clippy -- -D warnings
cargo test
cargo build
```

**Go:**
```bash
go vet ./...
go test ./...
go build ./...
```

**Python:**
```bash
pytest
```

Record pass/fail for each.

### Phase 5 — DECIDE

| Condition | Decision |
|---|---|
| Zero CRITICAL/HIGH issues, validation passes | **APPROVE** |
| Only MEDIUM/LOW issues, validation passes | **APPROVE** with comments |
| Any HIGH issues or validation failures | **REQUEST CHANGES** |
| Any CRITICAL issues | **BLOCK** — must fix before merge |

Special cases: a draft PR always uses **COMMENT**; docs/config-only changes get a lighter review focused on correctness.

### Phase 6 — REPORT

Write a review artifact to a project reviews directory (for example `docs/reviews/pr-<NUMBER>-review.md`):

```markdown
# PR Review: #<NUMBER> — <TITLE>

**Reviewed**: <date>
**Author**: <author>
**Branch**: <head> → <base>
**Decision**: APPROVE | REQUEST CHANGES | BLOCK

## Summary
<1-2 sentence overall assessment>

## Findings
### CRITICAL
<findings or "None">
### HIGH
<findings or "None">
### MEDIUM
<findings or "None">
### LOW
<findings or "None">

## Validation Results
| Check | Result |
|---|---|
| Type check | Pass / Fail / Skipped |
| Lint | Pass / Fail / Skipped |
| Tests | Pass / Fail / Skipped |
| Build | Pass / Fail / Skipped |

## Files Reviewed
<list of files with change type: Added/Modified/Deleted>
```

### Phase 7 — PUBLISH

Post the review to GitHub:

```bash
# If APPROVE
gh pr review <NUMBER> --approve --body "<summary of review>"

# If REQUEST CHANGES
gh pr review <NUMBER> --request-changes --body "<summary with required fixes>"

# If COMMENT only (draft PR or informational)
gh pr review <NUMBER> --comment --body "<summary>"
```

For inline comments on specific lines, use the GitHub review-comments API (post a single review with multiple inline comments at once):

```bash
gh api "repos/{owner}/{repo}/pulls/<NUMBER>/reviews" \
  -f event="COMMENT" \
  -f body="<overall summary>" \
  --input comments.json  # [{"path": "file", "line": N, "body": "comment"}, ...]
```

### Phase 8 — OUTPUT

Report to the user: PR number and title, decision, issue counts by severity, validation pass count, artifact path, PR URL, and contextual next steps.

## Edge Cases

- **No `gh` CLI**: Fall back to a local-only review (read the diff, skip GitHub publish). Warn the user.
- **Diverged branches**: Suggest `git fetch origin && git rebase origin/<base>` before review.
- **Large PRs (>50 files)**: Warn about review scope. Focus on source changes first, then tests, then config/docs.
