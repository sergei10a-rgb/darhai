---
name: plan
description: >-
  Restates requirements, grounds the approach in existing code patterns, breaks work into phases, assesses risks,
  and waits for explicit confirmation before any code is written. Accepts free-form requirements or a PRD file.
  Use when starting a feature or significant change that needs an agreed plan first.
  Do NOT use for trivial changes or when a plan is already approved.
license: Apache-2.0
type: workflow
skills: system-design-process
trigger_phrases: make a plan implementation plan plan this feature plan before coding requirements to plan
metadata:
  author: darhai
  version: "1.0.0"
  tags: "planning implementation-plan architecture requirements sdlc"
  category: "software-development"
  depends: "system-design-process"
  disclaimer: "none"
  difficulty: "intermediate"
---

# Plan

Create a comprehensive implementation plan before writing any code. Accepts either free-form requirements or a PRD markdown file. Run inline — do not require any specific subagent.

## What This Workflow Does

1. **Restate Requirements** — Clarify what needs to be built.
2. **Identify Risks** — Surface potential issues and blockers.
3. **Create a Step Plan** — Break implementation into phases.
4. **Wait for Confirmation** — MUST receive user approval before proceeding.

## When to Use

- Starting a new feature
- Making significant architectural changes
- Working on complex refactoring
- Multiple files/components will be affected
- Requirements are unclear or ambiguous

## How It Works

1. **Analyze the request** and restate requirements in clear terms.
2. **Ground the plan** in relevant codebase patterns when the repo is available.
3. **Break down into phases** with specific, actionable steps.
4. **Identify dependencies** between components.
5. **Assess risks** and potential blockers.
6. **Estimate complexity** (High/Medium/Low).
7. **Present the plan** and WAIT for explicit confirmation.

## Input Modes

| Input | Mode | Behavior |
|---|---|---|
| `path/to/name.prd.md` | PRD artifact mode | Read the PRD, pick the next pending delivery milestone or phase, and write a plan artifact |
| Any other markdown path | Reference mode | Read the file as context and produce an inline plan |
| Free-form text | Conversational mode | Produce an inline plan |
| Empty input | Clarification mode | Ask what should be planned |

In PRD artifact mode, write the plan to a project docs directory (for example `docs/plans/{name}.plan.md`). If the PRD contains a `Delivery Milestones` table, update only the selected row from `pending` to `in-progress` and set its `Plan` cell to the generated plan path.

## Pattern Grounding

Before writing the plan, search the codebase for conventions the implementation should mirror. Capture the top example for each relevant category with file references:

| Category | What to capture |
|---|---|
| Naming | File, function, type, command, or script naming in the affected area |
| Error handling | How failures are raised, returned, logged, or handled gracefully |
| Logging | Levels, format, and what gets logged |
| Data access | Repository, service, query, or filesystem patterns |
| Tests | Test file location, framework, fixtures, and assertion style |

If no similar code exists, state that explicitly. Do not invent a pattern.

## PRD Artifact Output

When called with a `.prd.md` file, write the plan using this structure:

````markdown
# Plan: {Feature Name}

**Source PRD**: {path}
**Selected Milestone**: {milestone or phase name}
**Complexity**: {Small | Medium | Large}

## Summary
{2-3 sentences}

## Patterns to Mirror
| Category | Source | Pattern |
|---|---|---|
| Naming | `path:line` | {short description} |
| Errors | `path:line` | {short description} |
| Tests | `path:line` | {short description} |

## Files to Change
| File | Action | Why |
|---|---|---|
| `path` | CREATE / UPDATE / DELETE | {reason} |

## Tasks
### Task 1: {name}
- **Action**: {what to do}
- **Mirror**: {pattern to follow}
- **Validate**: {command that proves correctness}

## Validation
```bash
{project-specific validation commands}
```

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|

## Acceptance
- [ ] All tasks complete
- [ ] Validation passes
- [ ] Patterns mirrored, not reinvented
````

After writing the artifact, report its path and WAIT for confirmation before writing code.

## Example

For a request like "add real-time notifications when markets resolve", the plan restates the requirements, breaks the work into phases (database schema, notification service, integration points, frontend components), lists dependencies (queue, email service, real-time subscriptions), enumerates risks with likelihood (e.g. email deliverability HIGH, per-market performance MEDIUM), estimates complexity, and ends with:

```
**WAITING FOR CONFIRMATION**: Proceed with this plan? (yes/no/modify)
```

## Important Notes

**CRITICAL**: This workflow will **NOT** write any code until the user explicitly confirms the plan with "yes", "proceed", or a similar affirmative response.

If the user wants changes, they respond with "modify: [changes]", "different approach: [alternative]", or "skip phase 2 and do phase 3 first".

## After Planning

- Implement with test-driven development.
- Fix build errors if they occur.
- Run a code review of the completed implementation.
- Open a pull request that references the plan.

If requirements are not yet clear, produce a lean PRD first with the PRD workflow, then return here.
