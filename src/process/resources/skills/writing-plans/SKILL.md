---
name: writing-plans
description: Use when you have a spec or requirements for a multi-step task — code or otherwise — before touching files or starting execution
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the implementer has zero context for the codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about the toolset or problem domain. Assume they don't know good test design very well.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** If working in an isolated worktree, it should have been created via the using-git-worktrees skill at execution time.

**Save plans to:** `docs/plans/YYYY-MM-DD-<feature-name>.md`

- (User preferences for plan location override this default)

## Scope Check

If the spec covers multiple independent subsystems, it should have been broken into sub-project specs during brainstorming. If it wasn't, suggest breaking this into separate plans — one per subsystem. Each plan should produce working, testable output on its own.

## File Structure

Before defining tasks, map out which files will be created or modified and what each one is responsible for. This is where decomposition decisions get locked in.

- Design units with clear boundaries and well-defined interfaces. Each file should have one clear responsibility.
- You reason best about code you can hold in context at once, and your edits are more reliable when files are focused. Prefer smaller, focused files over large ones that do too much.
- Files that change together should live together. Split by responsibility, not by technical layer.
- In existing codebases, follow established patterns. If the codebase uses large files, don't unilaterally restructure - but if a file you're modifying has grown unwieldy, including a split in the plan is reasonable.

This structure informs the task decomposition. Each task should produce self-contained changes that make sense independently.

## Task Right-Sizing

A task is the smallest unit that carries its own test cycle and is worth a
fresh reviewer's gate. When drawing task boundaries: fold setup,
configuration, scaffolding, and documentation steps into the task whose
deliverable needs them; split only where a reviewer could meaningfully
reject one task while approving its neighbor. Each task ends with an
independently testable deliverable.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**

- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** Execute this plan task-by-task using the
> subagent-driven-development skill (recommended) or the executing-plans
> skill. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

## Success Criteria

[Falsifiable, binary pass/fail statements. "Works well" is not a
criterion; "`npm test -- login` exits 0" and "chapter covers beats 1-7
from the outline" are. Every criterion must be checkable by someone who
did not write the plan.]

1. [Criterion — pass/fail]
2. [Criterion — pass/fail]

## Global Constraints

[The spec's project-wide requirements — version floors, dependency limits,
naming and copy rules, platform requirements — one line each, with exact
values copied verbatim from the spec. Every task's requirements implicitly
include this section.]

## Out of Scope (Deferred)

[Anything mentioned in the spec or brief but deliberately cut from this
plan — one line each, with the reason. This is what stops scope creep
during execution.]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**

- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Depends:** Task M | none

**Risk:** low | medium | high — [one-line reason]

**Interfaces:**

- Consumes: [what this task uses from earlier tasks — exact signatures]
- Produces: [what later tasks rely on — exact function names, parameter
  and return types. A task's implementer sees only their own task; this
  block is how they learn the names and types neighboring tasks use.]

- [ ] **Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

- [ ] **Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## Dependency Wave Table

After the tasks, add a wave table so execution order and parallelism are
explicit. Tasks within a wave are independent and can run in parallel
(including as parallel subagents); waves run in order, gated on the
acceptance of the tasks they depend on.

```markdown
## Dependency Wave Table

| Wave | Tasks (parallel within wave)       | Gates between waves   |
| ---- | ---------------------------------- | --------------------- |
| W1   | Task 1, Task 2                     | none                  |
| W2   | Task 3 (depends Task 1)            | Task 1 acceptance met |
| W3   | Task 4, Task 5 (depends Tasks 2,3) | Task 3 acceptance met |
```

The wave table must agree with each task's **Depends** field. A `Depends`
that points at a task declared in a later wave is a plan bug.

## Plans for Non-Code Work

The plan shape is domain-agnostic: goal, falsifiable success criteria,
bite-sized tasks with deliverables and acceptance checks, dependency
waves. Only the deliverables change. Examples:

- **Software task:** Deliverable = `src/auth/login.ts` + test file.
  Acceptance = `npm test -- login` exit 0. Files = `src/auth/`,
  `tests/auth/`.
- **Book task:** Deliverable = `chapters/04-draft.md`. Acceptance =
  beats 1-7 from outline covered, POV consistent, word count ±10% of
  target. Files = `chapters/04-*`, `outline.md`.
- **Campaign task:** Deliverable = `campaign/launch-week/email-1.html`.
  Acceptance = subject line + preview text + body locked, links tracked.
  Files = `campaign/launch-week/`, `analytics/utm-plan.md`.
- **Design system task:** Deliverable = `tokens/color.v2.json`.
  Acceptance = contrast ratios meet WCAG AA, dark-mode pair validated.
  Files = `tokens/`, `docs/migration.md`.

For non-code tasks, replace the test/implement/commit step cycle with the
domain's equivalent check cycle (draft → check against acceptance →
revise → commit), but keep the same step granularity.

## No Placeholders

Every step must contain the actual content an implementer needs. These are **plan failures** — never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases"
- "Write tests for the above" (without actual test code)
- "Similar to Task N" (repeat the code — the implementer may be reading tasks out of order)
- Steps that describe what to do without showing how (code blocks required for code steps)
- References to types, functions, or methods not defined in any task

## Remember

- Exact file paths always
- Complete code in every step — if a step changes code, show the code
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## Self-Review

After writing the complete plan, look at the spec with fresh eyes and check the plan against it. This is a checklist you run yourself — not a subagent dispatch.

**1. Spec coverage:** Skim each section/requirement in the spec. Can you point to a task that implements it? List any gaps.

**2. Placeholder scan:** Search your plan for red flags — any of the patterns from the "No Placeholders" section above. Fix them.

**3. Type consistency:** Do the types, method signatures, and property names you used in later tasks match what you defined in earlier tasks? A function called `clearLayers()` in Task 3 but `clearFullLayers()` in Task 7 is a bug.

**4. Dependency sanity:** Every **Depends** field points at a declared task, the wave table matches the Depends fields, and no task depends on a task in a later wave. Each success criterion is binary pass/fail.

If you find issues, fix them inline. No need to re-review — just fix and move on. If you find a spec requirement with no task, add the task.

**Optional fresh-eyes pass:** For large or high-stakes plans, dispatch a reviewer subagent using the template in `references/plan-reviewer-prompt.md` to verify the plan against the spec with zero authoring bias.

## Execution Handoff

After saving the plan, offer execution choice:

**"Plan complete and saved to `docs/plans/<filename>.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session, batch execution with checkpoints

**Which approach?"**

**If Subagent-Driven chosen:** follow the subagent-driven-development skill — fresh subagent per task + two-stage review.

**If Inline Execution chosen:** follow the executing-plans skill — batch execution with checkpoints for review.
