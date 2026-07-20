---
name: plan-prd
description: >-
  Produces a lean, problem-first Product Requirements Document capturing who, what, why, evidence, hypothesis,
  scope, and success metrics, then hands off to an implementation-planning step. Use when the requirements for a
  product or feature are unclear and need to be framed before design. Do NOT use to produce an implementation
  plan or architecture — that belongs to the planning step.
license: Apache-2.0
type: workflow
skills: system-design-process
trigger_phrases: write a prd product requirements document requirements first frame the problem prd
metadata:
  author: darhai
  version: "1.0.0"
  tags: "prd requirements product planning sdlc"
  category: "software-development"
  depends: "system-design-process"
  disclaimer: "none"
  difficulty: "intermediate"
---

# PRD Workflow

Produce a **Product Requirements Document** — the requirements-phase artifact of the SDLC. Capture *what* must be true for success and *why*, and stop before *how*. Implementation decomposition is delegated to the planning workflow.

## Scope of this workflow

| This workflow does | This workflow does NOT do |
|---|---|
| Frame the problem and users | Design the architecture |
| Capture success criteria and scope | Pick files or write patterns |
| List open questions and risks | Enumerate implementation tasks |
| Write the PRD artifact | Produce an implementation plan |

If you find yourself writing implementation detail, stop and cut it. It belongs in the planning workflow.

**Anti-fluff rule**: When information is missing, write `TBD — needs validation via {method}`. Never invent plausible-sounding requirements.

## Workflow

Four phases. Each phase is a single gate — ask the questions, wait for the user, then move on. No nested loops, no parallel research ceremony.

### Phase 1 — FRAME

If the user gave no starting idea, ask:

> What do you want to build? One or two sentences.

If they did, restate it in one sentence and confirm before continuing. Then ask the framing questions in a single set:

> 1. **Who** has this problem? (specific role or segment)
> 2. **What** is the observable pain? (describe behavior, not assumed needs)
> 3. **Why** can't they solve it with what exists today?
> 4. **Why now?** — what changed that makes this worth doing?

Wait for the user. Do not proceed without answers (or an explicit "skip").

### Phase 2 — GROUND

Ask for evidence. This is the shortest phase and the most load-bearing:

> What evidence do you have that this problem is real and worth solving? (user quotes, support tickets, metrics, observed behavior, failed workarounds — anything concrete)

If the user has none, record the Evidence section as `Assumption — needs validation via {user research | analytics | prototype}`. This keeps the PRD honest.

### Phase 3 — DECIDE

Scope and hypothesis in a single set:

> 1. **Hypothesis** — Complete: *We believe **{capability}** will **{solve problem}** for **{users}**. We'll know we're right when **{measurable outcome}**.*
> 2. **MVP** — The minimum needed to test the hypothesis?
> 3. **Out of scope** — What are you explicitly **not** building (even if users ask)?
> 4. **Open questions** — Uncertainties that could change the approach?

Wait for responses.

### Phase 4 — GENERATE & HAND OFF

Write the PRD to a project docs directory (for example `docs/prds/{kebab-case-name}.prd.md`).

#### PRD Template

```markdown
# {Product / Feature Name}

## Problem
{2–3 sentences: who has what problem, and what's the cost of leaving it unsolved?}

## Evidence
- {User quote, data point, or observation}
- {OR: "Assumption — needs validation via {method}"}

## Users
- **Primary**: {role, context, what triggers the need}
- **Not for**: {who this explicitly excludes}

## Hypothesis
We believe **{capability}** will **{solve problem}** for **{users}**.
We'll know we're right when **{measurable outcome}**.

## Success Metrics
| Metric | Target | How measured |
|---|---|---|
| {primary} | {number} | {method} |

## Scope
**MVP** — {the minimum to test the hypothesis}

**Out of scope**
- {item} — {why deferred}

## Delivery Milestones
<!-- Business outcomes, not engineering tasks. The planning workflow turns each into a plan. -->
<!-- Status: pending | in-progress | complete -->

| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 1 | {name} | {user-visible change} | pending | — |
| 2 | {name} | {user-visible change} | pending | — |

## Open Questions
- [ ] {question that could change scope or approach}

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|

---
*Status: DRAFT — requirements only. Implementation planning pending.*
```

#### Report to the user

Report the PRD path, a one-line problem/hypothesis/MVP summary, the validation status of each section (validated vs assumption), the open-question count, and the next step: run the implementation-planning workflow against this PRD to turn the next pending milestone into a plan.

## Success criteria

- **PROBLEM_CLEAR**: the problem is specific and evidenced (or flagged as an assumption).
- **USER_CONCRETE**: the primary user is a specific role, not "users".
- **HYPOTHESIS_TESTABLE**: a measurable outcome is included.
- **SCOPE_BOUNDED**: explicit MVP and explicit out-of-scope.
- **NO_IMPLEMENTATION_DETAIL**: file paths, libraries, and task breakdowns are absent — if they appeared, move them to the planning step.
