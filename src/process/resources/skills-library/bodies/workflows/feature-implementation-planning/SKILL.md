---
name: feature-implementation-planning
description: >-
  Produces a detailed, self-contained implementation plan by parsing the feature request, mining the codebase for patterns and conventions, researching external dependencies, designing the approach, and generating a plan document that captures every pattern and gotcha needed for a single-pass implementation.
  Use when the user wants a thorough, codebase-aware plan before implementing a feature, or wants to turn a PRD phase into an actionable plan.
  Do NOT use for trivial one-line changes or for quick conversational planning that needs no artifact.
license: Apache-2.0
type: workflow
trigger_phrases: create an implementation plan plan this feature write a plan for
metadata:
  author: darhai
  version: "1.0.0"
  tags: planning architecture codebase-analysis research design
  category: software-project
  disclaimer: none
  difficulty: advanced
---

# Feature Implementation Planning

**Estimated time:** 1-4 hours, depending on feature scope and codebase size.

Create a self-contained implementation plan that captures all codebase patterns, conventions, and context needed to implement a feature in a single pass.

**Core philosophy:** a great plan contains everything needed to implement without asking further questions. Every pattern, convention, and gotcha is captured once and referenced throughout.

**Golden rule:** if you would need to search the codebase during implementation, capture that knowledge NOW in the plan.

## Phase 0 — Detect Input

| Input | Action |
|---|---|
| Path to a PRD-like file with "Implementation Phases" | Parse phases, find the next eligible pending phase |
| Path to any other file | Read it for context, treat as free-form |
| Free-form text | Proceed directly to Phase 1 |
| Empty | Ask the user what feature to plan |

When the input is a PRD, parse the Implementation Phases section, select the next eligible pending phase (respecting dependency chains), and use its description as the feature to plan. If no pending phases remain, report that all phases are complete.

## Phase 1 — Parse

Identify **what** is being built, **why** it matters, **who** uses it, and **where** it fits. Write a user story (`As a [user], I want [capability], so that [benefit]`) and assess complexity (Small / Medium / Large / XL).

**Ambiguity gate:** if the deliverable is vague, success criteria are undefined, there are multiple valid interpretations, or the technical approach has major unknowns — STOP and ask. Do not guess.

## Phase 2 — Explore

Search the codebase directly across eight categories:

1. **Similar implementations** — analogous features, endpoints, components
2. **Naming conventions** — how files, functions, variables, types, and exports are named
3. **Error handling** — how errors are caught, propagated, logged, returned
4. **Logging patterns** — what is logged, at what level, in what format
5. **Type definitions** — relevant types, interfaces, schemas and their organization
6. **Test patterns** — test locations, naming, setup/teardown, assertion styles
7. **Configuration** — config files, environment variables, feature flags
8. **Dependencies** — packages, imports, internal modules used by similar features

Then trace five things by reading relevant files: entry points, data flow, state changes, contracts, and architectural patterns. Compile everything into a single discovery table (`Category | File:Lines | Pattern | Key Snippet`).

## Phase 3 — Research

If the feature involves external libraries, APIs, or unfamiliar technology, find official documentation, usage examples, and version-specific gotchas. Format findings as `KEY_INSIGHT / APPLIES_TO / GOTCHA`. If the feature uses only well-understood internal patterns, note that no external research is needed.

## Phase 4 — Design

Document the before/after user experience and interaction changes (or mark N/A for purely internal changes).

## Phase 5 — Architect

Define the approach, alternatives considered and why they were rejected, the concrete scope, and an explicit **NOT Building** list to prevent scope creep.

## Phase 6 — Generate

Write the full plan to `docs/plans/{kebab-case-feature-name}.plan.md` using a template that includes: summary, user story, problem→solution, metadata, UX design, mandatory reading (prioritized file list with line ranges), external documentation, **Patterns to Mirror** (real codebase snippets with `// SOURCE:` references for naming, error handling, logging, data access, service layer, and test structure), files to change, NOT-building list, step-by-step tasks (each with ACTION, IMPLEMENT, MIRROR, IMPORTS, GOTCHA, VALIDATE), testing strategy, validation commands, acceptance criteria, completion checklist, and risks.

If the input was a PRD phase, update that phase's status from `pending` to `in-progress` and record the plan path.

## Verification

Before finalizing, check the plan against these gates:

- **Context completeness** — all relevant files discovered and documented; conventions captured with examples.
- **Implementation readiness** — every task has ACTION, IMPLEMENT, MIRROR, and VALIDATE; no task needs further codebase searching; import paths specified.
- **Pattern faithfulness** — code snippets are real codebase examples with accurate SOURCE references.
- **Validation coverage** — static analysis, test, and build commands specified.
- **No-prior-knowledge test** — a developer unfamiliar with the codebase could implement the feature using only this plan.

## Output

```
## Plan Created
- File: docs/plans/{name}.plan.md
- Source PRD: {path or "N/A"}
- Complexity: {level}
- Scope: {N files, M tasks}
- Key patterns: {top 3}
- Confidence: {1-10} likelihood of single-pass implementation
```

## Edge Cases

- **Ambiguous request**: stop at the ambiguity gate rather than planning on assumptions.
- **XL scope**: recommend splitting into smaller features each planned independently.
- **Pure internal change**: mark UX sections N/A instead of inventing a user flow.
