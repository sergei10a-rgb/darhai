---
name: using-skills
description: Use when starting any conversation or task - establishes how to find and use skills, requiring a skill check before ANY response or action, including clarifying questions
---

<SUBAGENT-NOTE>
If you were dispatched as a subagent to execute one specific, fully-specified task, follow your task instructions; this dispatcher applies to the agent that dispatched you.
</SUBAGENT-NOTE>

<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST use the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>

## The Rule

**Read and follow relevant or requested skills BEFORE any response or action** — including clarifying questions, exploring the codebase, or checking files. If a skill turns out wrong for the situation, you don't have to use it.

**Before writing an implementation plan:** if you haven't already brainstormed, use the brainstorming skill first.

Then announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, create a todo per item.

## Where Skills Live

Two channels:

1. **Workspace skills** — the process skills below plus any skills enabled for this assistant are available as markdown in your workspace skill directories. Read the skill's `SKILL.md` directly; no special invocation mechanism is needed.
2. **Full skill library** — thousands of additional skills are reachable only through the `wayland_search_skills` MCP tool. Search it with a short task-shaped query (Cyrillic queries work too); matching skill bodies are returned inline. If your workspace has no skill for the task, search the library before improvising.

## Process Skill Routing

Process skills set the approach; implementation and domain skills carry it out. When multiple skills apply, process skills come first. Brainstorming and systematic-debugging are the most common, but the rule holds for any of them.

| Situation                                                         | Skill                          |
| ----------------------------------------------------------------- | ------------------------------ |
| "Let's build X" — any creative work, new feature, behavior change | brainstorming                  |
| Have a spec or requirements, before touching code                 | writing-plans                  |
| Have a written plan to execute                                    | executing-plans                |
| Executing a plan with independent tasks via subagents             | subagent-driven-development    |
| 2+ independent tasks with no shared state                         | dispatching-parallel-agents    |
| Parallel work needing isolated workspaces                         | using-git-worktrees            |
| "Fix this bug" — any bug, test failure, unexpected behavior       | systematic-debugging           |
| Writing or changing code                                          | test-driven-development        |
| About to claim something works or is done                         | verification-before-completion |
| Work ready for review                                             | requesting-code-review         |
| Review feedback received                                          | receiving-code-review          |
| Implementation complete, deciding how to integrate                | finishing-a-development-branch |
| Creating or updating a skill                                      | skill-creator                  |

- "Let's build X" → brainstorming first, then implementation skills.
- "Fix this bug" → systematic-debugging first, then domain skills.

## Red Flags

These thoughts mean STOP—you're rationalizing:

| Thought                             | Reality                                                |
| ----------------------------------- | ------------------------------------------------------ |
| "This is just a simple question"    | Questions are tasks. Check for skills.                 |
| "I need more context first"         | Skill check comes BEFORE clarifying questions.         |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first.           |
| "I can check git/files quickly"     | Files lack conversation context. Check for skills.     |
| "Let me gather information first"   | Skills tell you HOW to gather information.             |
| "This doesn't need a formal skill"  | If a skill exists, use it.                             |
| "I remember this skill"             | Skills evolve. Read current version.                   |
| "This doesn't count as a task"      | Action = task. Check for skills.                       |
| "The skill is overkill"             | Simple things become complex. Use it.                  |
| "I'll just do this one thing first" | Check BEFORE doing anything.                           |
| "This feels productive"             | Undisciplined action wastes time. Skills prevent this. |
| "I know what that means"            | Knowing the concept ≠ using the skill. Invoke it.      |

## Engines

Darhai runs agents on multiple engines: the built-in wcore engine, local models, and external CLI engines. Skills are plain markdown and the rules above apply identically on every engine. If a skill references a tool your current engine lacks, adapt with the closest available equivalent rather than skipping the skill.

## User Instructions

User instructions (project guides, direct requests) take precedence over skills, which in turn override default behavior. Only skip skill workflows or instructions when the user has explicitly told you to.
