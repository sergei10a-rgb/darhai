---
name: gan-build
description: >-
  Runs a bounded generator-evaluator build loop that plans, implements, and scores an application against a
  rubric until it passes a threshold or plateaus, using three cooperating roles (planner, generator, evaluator).
  Use when you want iterative, self-scoring implementation of a build task with objective quality gates.
  Do NOT use for quick single-shot edits or when no measurable rubric applies.
license: Apache-2.0
type: workflow
skills: system-design-process test-strategy-design code-review-patterns
trigger_phrases: gan build generator evaluator loop iterative build self-scoring build harness build with scoring
metadata:
  author: darhai
  version: "1.0.0"
  tags: "generator-evaluator iteration build-loop scoring automation step-by-step"
  category: "software-development"
  depends: "system-design-process test-strategy-design code-review-patterns"
  disclaimer: "none"
  difficulty: "advanced"
---

# Generator-Evaluator Build Harness

Orchestrate a three-role build loop (planner, generator, evaluator) that iterates on an implementation until it passes a quality threshold or stops improving. Run each role as a delegated subagent if the runtime provides one, or inline otherwise.

## Inputs

Gather from the user's request:

1. **brief** — a one-line description of what to build (required).
2. **max iterations** — maximum generator-evaluator cycles (default 15).
3. **pass threshold** — the weighted score needed to pass (default 7.0 out of 10).
4. **skip planner** — if a spec already exists, skip the planning phase.
5. **eval mode** — one of `playwright`, `screenshot`, or `code-only` (default `playwright`).

## Phase 0: Setup

1. Create a `gan-harness/` directory in the project root.
2. Create subdirectories: `gan-harness/feedback/` and `gan-harness/screenshots/`.
3. Initialize git if it is not already initialized.
4. Log the start time and configuration.

## Phase 1: Planning (Planner Role)

Unless planning is skipped:

1. Run the planner role with the user's brief.
2. Have it produce `gan-harness/spec.md` and `gan-harness/eval-rubric.md`.
3. Display the spec summary to the user.
4. Proceed to Phase 2.

## Phase 2: Generator-Evaluator Loop

```
iteration = 1
while iteration <= max_iterations:

    # GENERATE
    Run the generator role:
    - Read spec.md
    - If iteration > 1: read feedback/feedback-{iteration-1}.md
    - Build/improve the application
    - Ensure the dev server is running
    - Commit changes

    # EVALUATE
    Run the evaluator role:
    - Read eval-rubric.md and spec.md
    - Test the live application (mode: playwright / screenshot / code-only)
    - Score against the rubric
    - Write feedback to feedback/feedback-{iteration}.md

    # CHECK SCORE
    Read feedback/feedback-{iteration}.md and extract the weighted total score.

    if score >= pass_threshold:
        Log "PASSED at iteration {iteration} with score {score}"; break

    if iteration >= 3 and score has not improved in the last 2 iterations:
        Log "PLATEAU detected — stopping early"; break

    iteration += 1
```

Browser-based evaluation (`playwright` mode) drives the running application and inspects real behavior; `screenshot` mode compares rendered output; `code-only` mode scores from static inspection when no runtime is available.

## Phase 3: Summary

1. Read all feedback files.
2. Display final scores and iteration history.
3. Show the score progression, e.g. `iteration 1: 4.2 → iteration 2: 5.8 → ... → iteration N: 7.5`.
4. List any remaining issues from the final evaluation.
5. Report total time and estimated cost.

## Output

Write the full report to `gan-harness/build-report.md`:

```markdown
## GAN Harness Build Report

**Brief:** [original prompt]
**Result:** PASS/FAIL
**Iterations:** N / max
**Final Score:** X.X / 10

### Score Progression
| Iter | Design | Originality | Craft | Functionality | Total |
|------|--------|-------------|-------|---------------|-------|
| 1 | ... | ... | ... | ... | X.X |
| N | ... | ... | ... | ... | X.X |

### Remaining Issues
- [Any issues from the final evaluation]

### Files Created
- gan-harness/spec.md
- gan-harness/eval-rubric.md
- gan-harness/feedback/feedback-001.md ... feedback-NNN.md
- gan-harness/build-report.md
```
