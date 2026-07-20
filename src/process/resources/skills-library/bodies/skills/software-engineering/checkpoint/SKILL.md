---
name: checkpoint
description: >-
  Creates, verifies, and lists workflow checkpoints backed by git so progress can be compared against a known-good point.
  Use when you want to snapshot a clean state, compare current state against an earlier checkpoint, or list saved checkpoints.
  Do NOT use as a substitute for real version-control history or release tagging.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "git checkpoints verification workflow version-control"
  category: "software-engineering"
  subcategory: "developer-tools"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Checkpoint

Create or verify a checkpoint in your workflow. A checkpoint is a named, timestamped snapshot of a known-good state that later work can be compared against.

The four actions are: **create** a named checkpoint, **verify** current state against a named checkpoint, **list** all checkpoints, and **clear** old checkpoints.

## Create Checkpoint

When creating a checkpoint:

1. Run a quick verification (build plus fast tests) to ensure the current state is clean.
2. Create a git stash or commit with the checkpoint name.
3. Log the checkpoint to a repo-local log file (`.checkpoints.log`):

```bash
echo "$(date +%Y-%m-%d-%H:%M) | $CHECKPOINT_NAME | $(git rev-parse --short HEAD)" >> .checkpoints.log
```

4. Report that the checkpoint was created.

## Verify Checkpoint

When verifying against a checkpoint:

1. Read the checkpoint entry from the log.
2. Compare current state to the checkpoint:
   - Files added since the checkpoint
   - Files modified since the checkpoint
   - Test pass rate now vs then
   - Coverage now vs then

3. Report:

```
CHECKPOINT COMPARISON: $NAME
============================
Files changed: X
Tests: +Y passed / -Z failed
Coverage: +X% / -Y%
Build: [PASS/FAIL]
```

## List Checkpoints

Show all checkpoints with:

- Name
- Timestamp
- Git SHA
- Status (current, behind, ahead)

## Clear Checkpoints

Remove old checkpoints, keeping the most recent five.

## Workflow

A typical checkpoint flow:

```
[Start]     --> create "feature-start"
[Implement] --> create "core-done"
[Test]      --> verify "core-done"
[Refactor]  --> create "refactor-done"
[PR]        --> verify "feature-start"
```

Use checkpoints to make it cheap to answer "did this change make things better or worse?" at any point during a longer task.
