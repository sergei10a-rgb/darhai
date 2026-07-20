---
name: adversarial-dual-review
description: >-
  Runs an adversarial dual-review convergence loop in which two independent reviewers — ideally different model families with no shared context — must both approve against an objective rubric before code ships, fixing and re-reviewing with fresh reviewers for up to three rounds.
  Use when the user wants a high-assurance gate before pushing, catching blind spots that a single reviewer misses through model diversity and context isolation.
  Do NOT use for trivial changes, exploratory work, or when only a quick single-pass review is warranted.
license: Apache-2.0
type: workflow
trigger_phrases: dual review adversarial review two-reviewer gate must both approve before shipping
metadata:
  author: darhai
  version: "1.0.0"
  tags: code-review quality convergence verification security
  category: software-project
  disclaimer: none
  difficulty: advanced
---

# Adversarial Dual Review

**Estimated time:** 20-90 minutes, depending on scope and rounds.

An adversarial dual-review convergence loop. Two independent reviewers — different models where possible, with no shared context — must both return a passing verdict before code ships. If either fails, fix every flagged issue, commit, and re-run with fresh reviewers, up to three rounds.

## Purpose

Run two independent reviewers against the current change. Both must pass before the code is pushed. Model diversity (different training data, different biases, different blind spots) plus context isolation is what makes the gate strong.

## Step 1 — Identify What to Review

Determine the scope from the input, or fall back to uncommitted changes:

```bash
git diff --name-only HEAD
```

Read all changed files to build full review context. If the input specifies a path, file, or description, use that as the scope instead.

## Step 2 — Build the Rubric

Construct a rubric appropriate to the file types under review. Every criterion must have an objective PASS/FAIL condition. Include at minimum:

| Criterion | Pass condition |
|-----------|---------------|
| Correctness | Logic is sound, no bugs, handles edge cases |
| Security | No secrets, injection, XSS, or OWASP Top 10 issues |
| Error handling | Errors handled explicitly, no silent swallowing |
| Completeness | All requirements addressed, no missing cases |
| Internal consistency | No contradictions between files or sections |
| No regressions | Changes don't break existing behavior |

Add domain-specific criteria based on file types (type safety for TypeScript, memory safety for Rust, migration safety for SQL, and so on).

## Step 3 — Dual Independent Review

Launch two reviewers **in parallel**, each with the full rubric and all files under review, and each instructed: "You are an independent quality reviewer. You have NOT seen any other review. Your job is to find problems, not to approve." Each reviewer evaluates every rubric criterion and returns structured JSON:

```json
{
  "verdict": "PASS" | "FAIL",
  "checks": [
    {"criterion": "...", "result": "PASS|FAIL", "detail": "..."}
  ],
  "critical_issues": ["..."],
  "suggestions": ["..."]
}
```

- **Reviewer A** — a strong reviewer model; always runs, guaranteeing at least one capable reviewer.
- **Reviewer B** — a second, ideally different model family for true independence. If an external model CLI is available, prefer it (run it read-only so the review cannot mutate the repo); write the reviewer prompt to a unique temp file and feed it in. If no external model is available, fall back to a second isolated instance of the same model family and log that context isolation is preserved but model diversity was not achieved.

## Step 4 — Verdict Gate

- **Both PASS** -> proceed to Step 6 (push).
- **Either FAIL** -> merge and deduplicate all critical issues from both reviewers, proceed to Step 5.

## Step 5 — Fix Cycle

1. Display all critical issues from both reviewers.
2. Fix every flagged issue — change only what was flagged, no drive-by refactors.
3. Commit all fixes in a single commit: `fix: address dual-review findings (round N)`.
4. Re-run Step 3 with **fresh reviewers** (no memory of previous rounds).
5. Repeat until both pass.

**Maximum 3 rounds.** If still failing after 3 rounds, stop, present the remaining critical issues, require manual review, and do NOT push.

## Step 6 — Push

When both reviewers pass:

```bash
git push -u origin HEAD
```

## Step 7 — Final Report

```
VERDICT: [SHIP / ESCALATED]

Reviewer A: [PASS/FAIL]
Reviewer B ([model used]): [PASS/FAIL]

Agreement:
  Both flagged:    [issues caught by both]
  Reviewer A only: [issues only A caught]
  Reviewer B only: [issues only B caught]

Rounds: [N]/3
Result: [PUSHED / ESCALATED TO USER]
```

## Notes

- Reviewer A always runs, guaranteeing at least one strong reviewer regardless of tooling.
- Model diversity is the goal for Reviewer B; a different model family gives real independence. The same-family fallback still adds value through context isolation but loses diversity.
- Fresh reviewers each round prevent anchoring bias from prior findings.
- The rubric is the most important input — tighten it if reviewers rubber-stamp or flag subjective style issues.
- Commits happen on failing rounds so fixes are preserved even if the loop is interrupted.
- Push only happens after both pass — never mid-loop.

## Edge Cases

- **No external model available**: use the isolated same-family fallback and disclose the reduced diversity.
- **Reviewers disagree every round**: after 3 rounds, escalate to a human rather than forcing convergence.
- **Rubber-stamping**: if both pass instantly on a risky change, tighten the rubric and re-run.
