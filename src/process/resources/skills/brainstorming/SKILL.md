---
name: brainstorming
description: 'Use before any creative work - creating features, building components, adding functionality, or modifying behavior - and whenever a request is ambiguous enough that the expected outcome is not yet observable or testable. Explores user intent, requirements and design before implementation.'
---

# Brainstorming Ideas Into Designs

Help turn ideas into fully formed designs and specs through natural collaborative dialogue.

Start by understanding the current project context, then ask questions one at a time to refine the idea. Once you understand what you're building, present the design and get user approval.

<HARD-GATE>
Do NOT start any implementation workflow, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Checklist

You MUST create a task for each of these items and complete them in order:

1. **Explore project context** — check files, docs, recent commits
2. **Offer the visual companion just-in-time** — NOT upfront. The first time a question would genuinely be clearer shown than described, offer it then (its own message); on approval its browser tab opens for you. If no visual question ever arises, never offer it. See the Visual Companion section below.
3. **Ask clarifying questions** — one at a time, understand purpose/constraints/success criteria
4. **Propose 2-3 approaches** — with trade-offs and your recommendation
5. **Present design** — in sections scaled to their complexity, get user approval after each section
6. **Write design doc** — save to `docs/specs/YYYY-MM-DD-<topic>-design.md`, with falsifiable acceptance criteria, and commit
7. **Spec self-review** — quick inline check for placeholders, contradictions, ambiguity, scope, falsifiability (see below)
8. **User reviews written spec** — ask user to review the spec file before proceeding
9. **Transition to implementation** — hand off to the writing-plans skill to create an implementation plan

## Process Flow

```
Explore project context
  → Ask clarifying questions (one at a time)
  → Propose 2-3 approaches
  → Present design sections
      → user approves?  no → revise and re-present
                        yes ↓
  → Write design doc (spec with acceptance criteria)
  → Spec self-review (fix inline)
  → User reviews spec?  changes requested → update doc, re-review
                        approved ↓
  → Hand off to the writing-plans skill   ← terminal state
```

**The terminal state is the writing-plans skill.** Do NOT jump to a design, scaffolding, or any other implementation skill. The ONLY skill that follows brainstorming is writing-plans.

## The Process

**Understanding the idea:**

- Check out the current project state first (files, docs, recent commits)
- Before asking detailed questions, assess scope: if the request describes multiple independent subsystems (e.g., "build a platform with chat, file storage, billing, and analytics"), flag this immediately. Don't spend questions refining details of a project that needs to be decomposed first.
- If the project is too large for a single spec, help the user decompose into sub-projects: what are the independent pieces, how do they relate, what order should they be built? Then brainstorm the first sub-project through the normal design flow. Each sub-project gets its own spec → plan → implementation cycle.
- For appropriately-scoped projects, ask questions one at a time to refine the idea
- Rewrite vague asks into verifiable goals before echoing them back. Examples: "Add validation" → "Tests for invalid inputs, then make them pass"; "Fix the bug" → "Failing repro test, then make it pass"; "Refactor X" → "Suite passes before and after, no public API changes"; "Make it faster" → "Profile the hot path, change it, show the benchmark improved"; "Clean up the code" → "Pick one smell, fix only that, one-commit diff". If the ask cannot be reduced to a checkable outcome, surface that gap before proceeding.
- Prefer multiple choice questions when possible, but open-ended is fine too
- Only one question per message - if a topic needs more exploration, break it into multiple questions
- Focus on understanding: purpose, constraints, success criteria

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
- Lead with your recommended option and explain why

**Presenting the design:**

- Once you believe you understand what you're building, present the design
- Scale each section to its complexity: a few sentences if straightforward, up to 200-300 words if nuanced
- Ask after each section whether it looks right so far
- Cover: architecture, components, data flow, error handling, testing
- Be ready to go back and clarify if something doesn't make sense

**Design for isolation and clarity:**

- Break the system into smaller units that each have one clear purpose, communicate through well-defined interfaces, and can be understood and tested independently
- For each unit, you should be able to answer: what does it do, how do you use it, and what does it depend on?
- Can someone understand what a unit does without reading its internals? Can you change the internals without breaking consumers? If not, the boundaries need work.
- Smaller, well-bounded units are also easier for you to work with - you reason better about code you can hold in context at once, and your edits are more reliable when files are focused. When a file grows large, that's often a signal that it's doing too much.

**Working in existing codebases:**

- Explore the current structure before proposing changes. Follow existing patterns.
- Where existing code has problems that affect the work (e.g., a file that's grown too large, unclear boundaries, tangled responsibilities), include targeted improvements as part of the design - the way a good developer improves code they're working in.
- Don't propose unrelated refactoring. Stay focused on what serves the current goal.

## After the Design

**Documentation:**

- Write the validated design (spec) to `docs/specs/YYYY-MM-DD-<topic>-design.md`
  - (User preferences for spec location override this default)
- Commit the design document to git

**Acceptance criteria — make the spec falsifiable:**

Every requirement in the spec must be checkable: binary pass/fail, observable by two people who would agree on the outcome. Number the criteria `AC-001`, `AC-002`, … and give each applicable criterion:

- **Scenario:** starting condition
- **Action:** single trigger
- **Expected:** observable result
- **Must not:** prohibited side effect, when meaningful
- **Verification:** automated test, integration check, manual UX review, accessibility check, security review, or stakeholder acceptance
- **Priority:** Required | Important | Optional

Example of a passing criterion:

```
AC-001: Export generates file with correct headers
- Scenario: authenticated user, at least one data row visible
- Action: click "Export CSV"
- Expected: browser downloads file with columns [id, name, created_at]
- Must not: expose internal fields or rows belonging to other users
- Verification: automated integration test + manual schema spot-check
- Priority: Required
```

`AC-001: The export works correctly and is secure` FAILS — "correctly" and "secure" are not observable, and there is no scenario, trigger, or verification method. Never use words such as "correctly", "securely", "fast", "intuitive", or "robust" without defining observable evidence or explicitly marking them as a human-review judgment.

**Discovered facts vs product/business constraints:** the repository tells you how the system behaves today, not what the business requires it to do. Business rules, compliance and regulatory obligations, contractual SLAs, pricing, data-retention policy, prioritization, and target users cannot be read from code — never reconstruct them from code or naming. Treat them as unknown until the user or an authoritative product artifact (PRD, contract, policy document) supplies them, and record them in the spec as assumptions flagged for confirmation, never as discovered facts.

**Pass/fail rubric** — the spec passes only if every answer is "yes"; any "no" means revise before presenting it:

- [ ] Does every required criterion have a scenario, an observable expected result, and a named verification method?
- [ ] Are all vague terms ("correctly", "secure", "fast", "robust") either replaced with observable evidence or marked as human judgment?
- [ ] Are product/business constraints listed as supplied or assumed, with none silently inferred from code?
- [ ] Is scope explicit, with out-of-scope items named?

**Spec Self-Review:**
After writing the spec document, look at it with fresh eyes:

1. **Placeholder scan:** Any "TBD", "TODO", incomplete sections, or vague requirements? Fix them.
2. **Internal consistency:** Do any sections contradict each other? Does the architecture match the feature descriptions?
3. **Scope check:** Is this focused enough for a single implementation plan, or does it need decomposition?
4. **Ambiguity check:** Could any requirement be interpreted two different ways? If so, pick one and make it explicit.
5. **Falsifiability check:** Run the pass/fail rubric above against the acceptance criteria.

Fix any issues inline. No need to re-review — just fix and move on.

**User Review Gate:**
After the spec review loop passes, ask the user to review the written spec before proceeding:

> "Spec written and committed to `<path>`. Please review it and let me know if you want to make any changes before we start writing out the implementation plan."

Wait for the user's response. If they request changes, make them and re-run the spec review loop. Only proceed once the user approves.

**Implementation:**

- Hand off to the writing-plans skill to create a detailed implementation plan
- Do NOT use any other skill. writing-plans is the next step.

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions
- **Multiple choice preferred** - Easier to answer than open-ended when possible
- **YAGNI ruthlessly** - Remove unnecessary features from all designs
- **Explore alternatives** - Always propose 2-3 approaches before settling
- **Incremental validation** - Present design, get approval before moving on
- **Be flexible** - Go back and clarify when something doesn't make sense

## Visual Companion

A browser-based companion for showing mockups, diagrams, and visual options during brainstorming. Available as a tool — not a mode. Accepting the companion means it's available for questions that benefit from visual treatment; it does NOT mean every question goes through the browser.

**Optional and token-intensive.** Skip it entirely when running on a small local model or in a constrained context — the text-only flow above is fully sufficient. Only load the detailed guide when the user has accepted the offer.

**Offering the companion (just-in-time):** Do NOT offer it upfront. Wait until a question would genuinely be clearer shown than told — a real mockup / layout / diagram question, not merely a UI _topic_. The first time that happens, offer it then, as its own message:

> "This next part might be easier if I show you — I can put together mockups, diagrams, and comparisons in a browser tab as we go. It's still new and can be token-intensive. Want me to? I'll open it for you."

**This offer MUST be its own message.** Only the offer — no clarifying question, summary, or other content. Wait for the user's response. If they accept, start the server with `--open` so their browser opens to the first screen automatically. If they decline, continue text-only and don't offer again unless they raise it.

**Per-question decision:** Even after the user accepts, decide FOR EACH QUESTION whether to use the browser or the terminal. The test: **would the user understand this better by seeing it than reading it?**

- **Use the browser** for content that IS visual — mockups, wireframes, layout comparisons, architecture diagrams, side-by-side visual designs
- **Use the terminal** for content that is text — requirements questions, conceptual choices, tradeoff lists, A/B/C/D text options, scope decisions

A question about a UI topic is not automatically a visual question. "What does personality mean in this context?" is a conceptual question — use the terminal. "Which wizard layout works better?" is a visual question — use the browser.

If they agree to the companion, read the detailed guide before proceeding:
`references/visual-companion.md` (relative to this skill's directory)
