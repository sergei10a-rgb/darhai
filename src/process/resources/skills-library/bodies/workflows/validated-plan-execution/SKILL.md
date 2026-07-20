---
name: validated-plan-execution
description: >-
  Executes a written implementation plan step by step with continuous validation, running static analysis, tests, build, and integration checks after every change so broken state is never accumulated, then producing an implementation report.
  Use when the user has an implementation plan file and wants it executed with rigorous per-change validation loops and a traceable report.
  Do NOT use for exploratory prototyping, one-line fixes, or when no plan file exists (create a plan first).
license: Apache-2.0
type: workflow
trigger_phrases: execute the implementation plan run the plan implement the plan with validation
metadata:
  author: darhai
  version: "1.0.0"
  tags: implementation validation testing build step-by-step
  category: software-project
  disclaimer: none
  difficulty: advanced
---

# Validated Plan Execution

**Estimated time:** hours to a few days, depending on plan scope.

Execute a plan file step by step with continuous validation. Every change is verified immediately.

**Core philosophy:** validation loops catch mistakes early. Run checks after every change; fix issues immediately.

**Golden rule:** if a validation fails, fix it before moving on. Never accumulate broken state.

## Phase 0 — Detect

### Package Manager Detection

| File exists | Package manager | Runner |
|---|---|---|
| `bun.lockb` | bun | `bun run` |
| `pnpm-lock.yaml` | pnpm | `pnpm run` |
| `yarn.lock` | yarn | `yarn` |
| `package-lock.json` | npm | `npm run` |
| `pyproject.toml` or `requirements.txt` | uv / pip | `uv run` or `python -m` |
| `Cargo.toml` | cargo | `cargo` |
| `go.mod` | go | `go` |

Check `package.json` (or equivalent) for available scripts and note the commands for type-check, lint, test, and build.

## Phase 1 — Load

Read the plan file and extract:

- **Summary** — what is being built
- **Patterns to Mirror** — code conventions to follow
- **Files to Change** — what to create or modify
- **Step-by-Step Tasks** — implementation sequence
- **Validation Commands** — how to verify correctness
- **Acceptance Criteria** — definition of done

If the file is missing or invalid, stop and ask for a valid plan (create one with a planning workflow first).

**Checkpoint:** plan loaded, all sections identified, tasks extracted.

## Phase 2 — Prepare

```bash
git branch --show-current
git status --porcelain
```

| Current state | Action |
|---|---|
| On a feature branch | Use the current branch |
| On main, clean tree | Create a feature branch: `git checkout -b feat/{plan-name}` |
| On main, dirty tree | **STOP** — ask the user to stash or commit first |
| In a worktree for this feature | Use the worktree |

Sync the remote:

```bash
git pull --rebase origin $(git branch --show-current) 2>/dev/null || true
```

**Checkpoint:** on the correct branch, working tree ready, remote synced.

## Phase 3 — Execute

For each task in **Step-by-Step Tasks**:

1. **Read the MIRROR reference** — open the pattern file the task points to and understand the convention before writing code.
2. **Implement** — write code following the pattern exactly; apply any GOTCHA warnings; use the specified imports.
3. **Validate immediately** — after every file change, run the type-check command. If it fails, fix the error before the next file.
4. **Track progress** — log `[done] Task N: {name}` as each completes.

If implementation must deviate from the plan, note WHAT changed and WHY, continue with the corrected approach, and capture the deviation in the report.

**Checkpoint:** all tasks executed, deviations logged.

## Phase 4 — Validate

Run all validation levels; fix issues at each level before proceeding.

- **Level 1 — Static analysis:** type-check (zero errors) and lint (auto-fix, then fix remaining manually).
- **Level 2 — Unit tests:** write a test for every new function; cover the edge cases the plan lists; fix the implementation (not the test) on failure.
- **Level 3 — Build:** the build must succeed with zero errors.
- **Level 4 — Integration (if applicable):** start the server, wait for readiness with a health-check poll, run integration tests, then stop the server and propagate the test exit code.
- **Level 5 — Edge cases:** walk the plan's edge-case checklist.

**Checkpoint:** all levels pass, zero errors.

## Phase 5 — Report

Write an implementation report to `docs/reports/{plan-name}-report.md` covering: summary, predicted-vs-actual metrics, tasks completed, validation results, files changed, deviations, issues encountered, and tests written.

If the plan was a phase of a PRD, update that phase's status from `in-progress` to `complete` and record the report path. Archive the executed plan to `docs/plans/completed/`.

**Checkpoint:** report created, PRD updated, plan archived.

## Phase 6 — Output

```
## Implementation Complete
- Plan: {path} -> archived to completed/
- Branch: {name}
- Status: all tasks complete

Validation: type-check / lint / tests (N written) / build / integration — all pass
Files changed: N created, M updated
Deviations: {summary or "none — implemented exactly as planned"}
Artifacts: docs/reports/{name}-report.md
```

## Failure Handling

- **Type-check fails:** read the error, fix the source, re-run, continue only when clean.
- **Tests fail:** find whether the bug is in the implementation or the test; fix the root cause (usually the implementation); re-run.
- **Lint fails:** auto-fix first, then fix remaining manually.
- **Build fails:** usually a type or import issue — fix the offending file and re-run.
- **Integration fails:** confirm the server started, the route exists, and the request format matches; fix and re-run.

## Success Criteria

- All tasks executed
- Zero type and lint errors
- All tests green, new tests written
- Build succeeds
- Implementation report saved
- Plan archived to `completed/`

## Edge Cases

- **Dirty main branch**: stop and require a clean tree before creating the feature branch.
- **No integration surface**: mark Level 4 N/A rather than fabricating a server check.
- **Plan proves wrong mid-execution**: log the deviation with rationale instead of silently diverging.
