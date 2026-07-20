---
name: gan-design
description: >-
  Runs a two-role generator-evaluator loop focused on frontend and visual design quality, weighting originality
  and craft above functionality to push for creative breakthroughs. Use when iterating on the visual excellence
  of a frontend or design surface. Do NOT use for backend logic or feature-completeness work.
license: Apache-2.0
type: workflow
skills: css-architecture responsive-design-patterns web-animation-master
trigger_phrases: gan design design loop visual design iteration frontend design harness creative design loop
metadata:
  author: darhai
  version: "1.0.0"
  tags: "design frontend generator-evaluator iteration visual-quality step-by-step"
  category: "design-creative"
  depends: "css-architecture responsive-design-patterns web-animation-master"
  disclaimer: "none"
  difficulty: "advanced"
---

# Generator-Evaluator Design Harness

A two-role loop (generator plus evaluator) focused on frontend design quality. There is no planner — the brief IS the spec. Run each role as a delegated subagent if the runtime provides one, or inline otherwise.

## Inputs

- **brief** — the description of the design to create (required).
- **max iterations** — maximum design-evaluate cycles (default 10).
- **pass threshold** — the weighted score needed to pass (default 7.5 out of 10; higher than a functional build because the bar for design is higher).

## Setup

1. Create a `gan-harness/` directory.
2. Write the brief directly as `gan-harness/spec.md`.
3. Write a design-focused `gan-harness/eval-rubric.md` that puts extra weight on Design Quality and Originality.

## Design-Specific Eval Rubric

```markdown
### Design Quality (weight: 0.35)
### Originality (weight: 0.30)
### Craft (weight: 0.25)
### Functionality (weight: 0.10)
```

Originality weight is higher (0.30 vs a typical 0.20) to push for creative breakthroughs. Functionality weight is lower because design mode focuses on visual quality.

## Loop

Same generator-evaluator loop as the generator-evaluator build harness, but:

- Skip the planner.
- Use the design-focused rubric.
- The generator prompt emphasizes visual quality over feature completeness.
- The evaluator prompt asks "would this win a design award?" rather than "do all features work?"

## Key Difference

The generator is told: "Your PRIMARY goal is visual excellence. A stunning half-finished surface beats a functional ugly one. Push for creative leaps — unusual layouts, custom animations, distinctive color work." This deliberately rewards bold, memorable design over safe completeness.
