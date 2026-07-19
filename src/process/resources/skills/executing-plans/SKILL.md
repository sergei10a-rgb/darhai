---
name: executing-plans
description: Use when you have a written implementation plan to execute, working through its tasks with per-task verification and review checkpoints
---

# Executing Plans

## Overview

Load the plan, review it critically, execute all tasks under completion contracts, report when done.

If the plan's tasks are independent and subagent dispatch is available in this environment, prefer the subagent-driven-development skill. Use this skill for sequential, single-session execution.

## Before Starting: Ledger Gate

Check for a project-local execution issues ledger before touching any task (e.g. `docs/plans/execute-issues.json` or an `Issues` section in the plan file — whatever the project already uses; treat a missing file as zero issues).

- If any entry from a prior run is still `unresolved`: **halt**. List the unresolved issues to the user and get each one resolved (fixed, accepted, or deferred with a note) before starting.
- A later successful execution of the same task auto-resolves that task's open entries — record the resolution when it happens.

Minimal entry shape: task id, failing criteria, last failure output, status (`unresolved` | `resolved`), resolution note.

## The Process

### Step 1: Load and Review Plan

1. Read the plan file
2. Review critically — identify any questions or concerns about the plan
3. If concerns: raise them with the user before starting
4. If no concerns: create todos for the plan items and proceed

### Step 2: Execute Tasks

Every task runs under a **completion contract**: the task's acceptance criteria (its verification steps from the plan) must all pass before the task counts as complete.

For each task:

1. Mark as in_progress
2. Follow each step exactly (the plan has bite-sized steps)
3. Run the verifications specified in the plan
4. All criteria pass → mark completed, move on

**Retry loop (max 3 iterations).** When any criterion fails:

1. Capture the exact failure output
2. Re-attempt, feeding the failure output into the fix — never repeat the same approach blindly
3. Re-run all criteria

Stop the loop early when either:

- **Max iterations reached** — 3 attempts exhausted, or
- **Stagnation detected** — two consecutive iterations produce identical failure sets (same criteria failing the same way)

On stop: write the task, its failing criteria, and the last failure output as an `unresolved` entry in the issues ledger, then stop and ask the user. Never silently continue into dependent tasks.

### Step 3: Complete Development

After all tasks complete and verified, wrap up the branch: run the full test suite, then present integration options (merge, PR, keep the branch, or discard). If the finishing-a-development-branch skill is available, follow it.

## When to Stop and Ask for Help

**STOP executing immediately when:**

- You hit a blocker (missing dependency, test fails, instruction unclear)
- The plan has critical gaps preventing starting
- You don't understand an instruction
- A task exhausted its completion contract (max iterations or stagnation)

**Ask for clarification rather than guessing.**

## When to Revisit Earlier Steps

**Return to Review (Step 1) when:**

- The user updates the plan based on your feedback
- The fundamental approach needs rethinking

**Don't force through blockers** — stop and ask.

## Remember

- Check the issues ledger before starting; unresolved entries block execution
- Review the plan critically first
- Follow plan steps exactly
- Don't skip verifications — every task has a completion contract
- Reference skills when the plan says to
- Cap retries at 3; two identical failure sets in a row means stop, not "try harder"
- Stop when blocked, don't guess
- Never start implementation on main/master without explicit user consent

## Related Skills

Optional companions when available in this workspace:

- **writing-plans** — creates the plan this skill executes
- **using-git-worktrees** — isolated workspace for the implementation branch
- **subagent-driven-development** — alternative execution mode when tasks are independent and subagent dispatch is available
- **finishing-a-development-branch** — verify tests and integrate after all tasks complete
