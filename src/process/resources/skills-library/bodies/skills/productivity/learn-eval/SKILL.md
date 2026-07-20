---
name: learn-eval
description: >-
  Extracts a reusable pattern from the current session, self-evaluates its quality against a checklist, and decides whether to save it globally or per-project.
  Use when a non-obvious fix, debugging technique, or convention worth reusing emerged during work.
  Do NOT use for trivial fixes, typos, or one-off issues.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "knowledge-capture patterns self-evaluation learning skills"
  category: "productivity"
  subcategory: "knowledge-management"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Extract, Evaluate, then Save

Extract a reusable pattern from the session, apply a quality gate, decide the right save location, and stay aware of knowledge placement before writing any skill file.

## What to Extract

Look for:

1. **Error Resolution Patterns** — root cause plus fix plus reusability
2. **Debugging Techniques** — non-obvious steps, tool combinations
3. **Workarounds** — library quirks, API limitations, version-specific fixes
4. **Project-Specific Patterns** — conventions, architecture decisions, integration patterns

## Process

1. Review the session for extractable patterns.
2. Identify the most valuable and reusable insight.

3. **Determine the save location:**
   - Ask: "Would this pattern be useful in a different project?"
   - **Global** (a shared, cross-project skills library): generic patterns usable across two or more projects (shell compatibility, LLM API behavior, debugging techniques, etc.).
   - **Project** (the current project's local skills directory): project-specific knowledge (quirks of a particular config file, project-specific architecture decisions, etc.).
   - When in doubt, choose Global (moving Global → Project is easier than the reverse).

4. Draft the skill file using this format:

```markdown
---
name: pattern-name
description: "Under 130 characters"
user-invocable: false
origin: auto-extracted
---

# [Descriptive Pattern Name]

**Extracted:** [Date]
**Context:** [Brief description of when this applies]

## Problem
[What problem this solves — be specific]

## Solution
[The pattern/technique/workaround — with code examples]

## When to Use
[Trigger conditions]
```

5. **Quality gate — checklist plus holistic verdict**

   ### 5a. Required checklist (verify by actually reading files)

   Execute **all** of the following before evaluating the draft:

   - [ ] Search the global skills library and the project's local skills by keyword to check for content overlap.
   - [ ] Check any existing memory or notes files (project and global) for overlap.
   - [ ] Consider whether appending to an existing skill would suffice.
   - [ ] Confirm this is a reusable pattern, not a one-off fix.

   ### 5b. Holistic verdict

   Synthesize the checklist results and the draft quality, then choose **one**:

   | Verdict | Meaning | Next Action |
   |---------|---------|-------------|
   | **Save** | Unique, specific, well-scoped | Proceed to Step 6 |
   | **Improve then Save** | Valuable but needs refinement | List improvements → revise → re-evaluate (once) |
   | **Absorb into [X]** | Should be appended to an existing skill | Show the target skill and additions → Step 6 |
   | **Drop** | Trivial, redundant, or too abstract | Explain the reasoning and stop |

   **Guideline dimensions** (informing the verdict, not scored):

   - **Specificity & Actionability**: contains code examples or commands that are immediately usable.
   - **Scope Fit**: name, trigger conditions, and content are aligned and focused on a single pattern.
   - **Uniqueness**: provides value not covered by existing skills (informed by the checklist).
   - **Reusability**: realistic trigger scenarios exist in future sessions.

6. **Verdict-specific confirmation flow**

   - **Improve then Save**: present the required improvements, the revised draft, and the updated checklist/verdict after one re-evaluation; if the revised verdict is **Save**, save after user confirmation, otherwise follow the new verdict.
   - **Save**: present the save path, checklist results, a one-line verdict rationale, and the full draft → save after user confirmation.
   - **Absorb into [X]**: present the target path, the additions (diff format), checklist results, and the verdict rationale → append after user confirmation.
   - **Drop**: show checklist results and reasoning only (no confirmation needed).

7. Save or absorb to the determined location.

## Output Format for Step 5

```
### Checklist
- [x] skills library grep: no overlap (or: overlap found → details)
- [x] memory/notes: no overlap (or: overlap found → details)
- [x] existing skill append: new file appropriate (or: should append to [X])
- [x] reusability: confirmed (or: one-off → Drop)

### Verdict: Save / Improve then Save / Absorb into [X] / Drop

**Rationale:** (1-2 sentences explaining the verdict)
```

## Design Rationale

This approach replaces a numeric 5-dimension scoring rubric with a checklist-based holistic verdict. Modern frontier models have strong contextual judgment — forcing rich qualitative signals into numeric scores loses nuance and can produce misleading totals. The holistic approach lets the model weigh all factors naturally while the explicit checklist ensures no critical check is skipped.

## Notes

- Don't extract trivial fixes (typos, simple syntax errors).
- Don't extract one-time issues (specific API outages, etc.).
- Focus on patterns that will save time in future sessions.
- Keep skills focused — one pattern per skill.
- When the verdict is Absorb, append to the existing skill rather than creating a new file.
