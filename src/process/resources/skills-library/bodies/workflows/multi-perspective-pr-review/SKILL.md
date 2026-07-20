---
name: multi-perspective-pr-review
description: >-
  Runs a comprehensive multi-perspective review of a pull request by evaluating it through several independent lenses — general code quality, comment accuracy, test coverage, silent-failure detection, type design, and simplification — then deduplicates and ranks findings by severity.
  Use when the user wants a thorough, multi-angle review of a PR or the current branch's changes before merging.
  Do NOT use for single-lane linting, trivial diffs, or when only one narrow concern needs checking.
license: Apache-2.0
type: workflow
trigger_phrases: review this PR comprehensive pr review multi-perspective review review the pull request
metadata:
  author: darhai
  version: "1.0.0"
  tags: code-review pull-request quality testing security
  category: software-project
  disclaimer: none
  difficulty: intermediate
---

# Multi-Perspective PR Review

**Estimated time:** 15-60 minutes, depending on PR size.

Run a comprehensive multi-perspective review of a pull request. Input may name a PR (number or URL) and an optional focus (`comments`, `tests`, `errors`, `types`, `code`, or `simplify`). If no PR is specified, review the current branch's PR; if no focus is specified, run the full review stack.

## Steps

1. **Identify the PR**
   - Use `gh pr view` to get PR details, the changed files, and the diff.

2. **Find project guidance**
   - Look for the project's agent guide and conventions, lint config, and TypeScript config so the review respects repo standards.

3. **Run the review lenses** — evaluate the diff through each independent perspective:

   | Lens | Focus |
   |---|---|
   | General code review | Correctness, structure, naming, readability, security |
   | Comment accuracy | Comments and docstrings that mislead or contradict the code |
   | Test coverage | Missing tests for new/changed behavior and edge cases |
   | Silent-failure detection | Swallowed errors, ignored return values, empty catch blocks |
   | Type design | Weak or unsafe types, `any` abuse, missing invariants |
   | Simplification | Redundant logic, dead branches, over-engineering |

   When a focus is specified, run only that lens; otherwise run all of them.

4. **Aggregate results**
   - Deduplicate overlapping findings across lenses.
   - Rank by severity.

5. **Report** findings grouped by severity.

## Confidence Rule

Only report issues with confidence >= 80.

- **Critical** — bugs, security, data loss
- **Important** — missing tests, quality problems, style violations
- **Advisory** — suggestions, only when explicitly requested

## Output

```
PR Review: #{number} — {title}

CRITICAL
- {finding} ({file}:{line}) — {why}

IMPORTANT
- {finding} ({file}:{line}) — {why}

ADVISORY (on request)
- {suggestion}

Summary: {N critical} / {M important} / {K advisory}
Verdict: {Approve / Request changes / Block}
```

## When to Use

- A thorough pre-merge review of a non-trivial PR
- Auditing a branch's changes through multiple independent lenses at once
- Focusing on a single concern (tests, types, silent failures) on demand

## Edge Cases

- **No PR for the branch**: fall back to reviewing uncommitted or unpushed changes.
- **Huge diff**: chunk the review by file group and note where size limited depth.
- **Low-confidence hunches**: drop anything below the confidence threshold rather than reporting noise.
