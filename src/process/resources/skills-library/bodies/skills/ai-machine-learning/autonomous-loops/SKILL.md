---
name: autonomous-loops
description: |
  Patterns and architectures for running an AI coding agent autonomously in loops — from simple sequential headless pipelines to RFC-driven multi-agent DAG orchestration with a merge queue.
  Use when setting up autonomous development workflows, choosing a loop architecture, running parallel agents with merge coordination, or adding quality gates and context persistence across iterations.
  Do NOT use for single interactive edits, or when a human-in-the-loop review is required on every step.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "ai-agents automation orchestration loops parallel-agents"
  category: "ai-machine-learning"
  subcategory: "applied-ai"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# Autonomous Loops

Patterns, architectures, and reference implementations for running an AI coding agent autonomously in loops. Covers everything from simple headless pipelines to full RFC-driven multi-agent DAG orchestration.

Throughout this skill, `agent-run` stands for your harness's non-interactive (headless) invocation — a single-shot run that takes a prompt, does the work, and exits. Replace it with your runtime's equivalent command.

## When to Use

- Setting up autonomous development workflows that run without human intervention
- Choosing the right loop architecture for your problem (simple vs complex)
- Building CI/CD-style continuous development pipelines
- Running parallel agents with merge coordination
- Implementing context persistence across loop iterations
- Adding quality gates and cleanup passes to autonomous workflows

## Loop Pattern Spectrum

From simplest to most sophisticated:

| Pattern | Complexity | Best For |
|---------|-----------|----------|
| Sequential Pipeline | Low | Daily dev steps, scripted workflows |
| Persistent REPL Loop | Low | Interactive persistent sessions |
| Infinite Agentic Loop | Medium | Parallel content generation, spec-driven work |
| Continuous PR Loop | Medium | Multi-day iterative projects with CI gates |
| De-Sloppify Pattern | Add-on | Quality cleanup after any Implementer step |
| RFC-Driven DAG Orchestration | High | Large features, multi-unit parallel work with merge queue |

---

## 1. Sequential Pipeline

**The simplest loop.** Break daily development into a sequence of non-interactive headless calls. Each call is a focused step with a clear prompt.

### Core Insight

> If you can't figure out a loop like this, it means you can't even drive the agent to fix your code in interactive mode.

A headless run executes the agent non-interactively with a prompt, then exits when done. Chain calls to build a pipeline:

```bash
#!/bin/bash
# daily-dev.sh — Sequential pipeline for a feature branch

set -e

# Step 1: Implement the feature
agent-run -p "Read the spec in docs/auth-spec.md. Implement OAuth2 login in src/auth/. Write tests first (TDD). Do NOT create any new documentation files."

# Step 2: De-sloppify (cleanup pass)
agent-run -p "Review all files changed by the previous commit. Remove any unnecessary type tests, overly defensive checks, or testing of language features. Keep real business logic tests. Run the test suite after cleanup."

# Step 3: Verify
agent-run -p "Run the full build, lint, type check, and test suite. Fix any failures. Do not add new features."

# Step 4: Commit
agent-run -p "Create a conventional commit for all staged changes. Use 'feat: add OAuth2 login flow' as the message."
```

### Key Design Principles

1. **Each step is isolated** — A fresh context window per headless call means no context bleed between steps.
2. **Order matters** — Steps execute sequentially. Each builds on the filesystem state left by the previous.
3. **Negative instructions are dangerous** — Don't say "don't test type systems." Instead, add a separate cleanup step (see De-Sloppify Pattern).
4. **Exit codes propagate** — `set -e` stops the pipeline on failure.

### Variations

**With model routing** (use whichever model tiers your harness exposes):
```bash
# Research with a deep-reasoning model
agent-run -p --model deep "Analyze the codebase architecture and write a plan for adding caching..."

# Implement with a fast, capable model
agent-run -p "Implement the caching layer according to the plan in docs/caching-plan.md..."

# Review with a deep-reasoning model
agent-run -p --model deep "Review all changes for security issues, race conditions, and edge cases..."
```

**With environment context:**
```bash
# Pass context via files, not prompt length
echo "Focus areas: auth module, API rate limiting" > .agent-context.md
agent-run -p "Read .agent-context.md for priorities. Work through them in order."
rm .agent-context.md
```

**With tool restrictions:**
```bash
# Read-only analysis pass
agent-run -p --allowedTools "Read,Grep,Glob" "Audit this codebase for security vulnerabilities..."

# Write-only implementation pass
agent-run -p --allowedTools "Read,Write,Edit,Bash" "Implement the fixes from security-audit.md..."
```

---

## 2. Persistent REPL Loop

**A session-aware wrapper** that calls the headless agent synchronously while carrying full conversation history in a session file (Markdown-as-database).

### How It Works

1. Loads conversation history from a per-session file (e.g. `sessions/{session}.md`)
2. Each user message is sent to a headless run with the full history as context
3. Responses are appended to the session file
4. Sessions persist across restarts

### When Persistent REPL vs Sequential Pipeline

| Use Case | Persistent REPL | Sequential Pipeline |
|----------|-----------------|---------------------|
| Interactive exploration | Yes | No |
| Scripted automation | No | Yes |
| Session persistence | Built-in | Manual |
| Context accumulation | Grows per turn | Fresh each step |
| CI/CD integration | Poor | Excellent |

---

## 3. Infinite Agentic Loop

**A two-prompt system** that orchestrates parallel sub-agents for specification-driven generation. (Pattern popularized by disler.)

### Architecture: Two-Prompt System

```
PROMPT 1 (Orchestrator)              PROMPT 2 (Sub-Agents)
┌─────────────────────┐             ┌──────────────────────┐
│ Parse spec file      │             │ Receive full context  │
│ Scan output dir      │  deploys   │ Read assigned number  │
│ Plan iteration       │────────────│ Follow spec exactly   │
│ Assign creative dirs │  N agents  │ Generate unique output │
│ Manage waves         │             │ Save to output dir    │
└─────────────────────┘             └──────────────────────┘
```

### The Pattern

1. **Spec Analysis** — Orchestrator reads a specification file (Markdown) defining what to generate
2. **Directory Recon** — Scans existing output to find the highest iteration number
3. **Parallel Deployment** — Launches N sub-agents, each with:
   - The full spec
   - A unique creative direction
   - A specific iteration number (no conflicts)
   - A snapshot of existing iterations (for uniqueness)
4. **Wave Management** — For infinite mode, deploys waves of 3-5 agents until context is exhausted

### Implementation via a Workflow Definition

Create a workflow file (`workflows/infinite.md` or your host's equivalent):

```markdown
Parse the following arguments:
1. spec_file — path to the specification markdown
2. output_dir — where iterations are saved
3. count — integer 1-N or "infinite"

PHASE 1: Read and deeply understand the specification.
PHASE 2: List output_dir, find highest iteration number. Start at N+1.
PHASE 3: Plan creative directions — each agent gets a DIFFERENT theme/approach.
PHASE 4: Deploy sub-agents in parallel. Each receives:
  - Full spec text
  - Current directory snapshot
  - Their assigned iteration number
  - Their unique creative direction
PHASE 5 (infinite mode): Loop in waves of 3-5 until context is low.
```

### Batching Strategy

| Count | Strategy |
|-------|----------|
| 1-5 | All agents simultaneously |
| 6-20 | Batches of 5 |
| infinite | Waves of 3-5, progressive sophistication |

### Key Insight: Uniqueness via Assignment

Don't rely on agents to self-differentiate. The orchestrator **assigns** each agent a specific creative direction and iteration number. This prevents duplicate concepts across parallel agents.

---

## 4. Continuous PR Loop

**A production-grade shell script** that runs the agent in a continuous loop, creating PRs, waiting for CI, and merging automatically. (Pattern popularized by AnandChowdhary's "Continuous Claude".)

### Core Loop

```
┌─────────────────────────────────────────────────────┐
│  CONTINUOUS ITERATION                               │
│                                                     │
│  1. Create branch (auto-loop/iteration-N)           │
│  2. Run a headless agent with the enhanced prompt   │
│  3. (Optional) Reviewer pass — separate headless run│
│  4. Commit changes (agent generates message)        │
│  5. Push + create PR                                │
│  6. Wait for CI checks (poll)                       │
│  7. CI failure? → Auto-fix pass (headless run)      │
│  8. Merge PR (squash/merge/rebase)                  │
│  9. Return to main → repeat                         │
│                                                     │
│  Limit by: --max-runs N | --max-cost $X             │
│            --max-duration 2h | completion signal     │
└─────────────────────────────────────────────────────┘
```

### Installation

> **Warning:** Install any third-party continuous-loop runner from its repository after reviewing the code. Do not pipe external scripts directly to bash.

### Usage

```bash
# Basic: 10 iterations
continuous-loop --prompt "Add unit tests for all untested functions" --max-runs 10

# Cost-limited
continuous-loop --prompt "Fix all linter errors" --max-cost 5.00

# Time-boxed
continuous-loop --prompt "Improve test coverage" --max-duration 8h

# With code review pass
continuous-loop \
  --prompt "Add authentication feature" \
  --max-runs 10 \
  --review-prompt "Run the test and lint suites, fix any failures"

# Parallel via worktrees
continuous-loop --prompt "Add tests" --max-runs 5 --worktree tests-worker &
continuous-loop --prompt "Refactor code" --max-runs 5 --worktree refactor-worker &
wait
```

### Cross-Iteration Context: SHARED_TASK_NOTES.md

The critical innovation: a `SHARED_TASK_NOTES.md` file persists across iterations:

```markdown
## Progress
- [x] Added tests for auth module (iteration 1)
- [x] Fixed edge case in token refresh (iteration 2)
- [ ] Still need: rate limiting tests, error boundary tests

## Next Steps
- Focus on rate limiting module next
- The mock setup in tests/helpers.ts can be reused
```

The agent reads this file at iteration start and updates it at iteration end. This bridges the context gap between independent headless invocations.

### CI Failure Recovery

When PR checks fail, the loop automatically:
1. Fetches the failed run ID from the VCS
2. Spawns a new headless run with CI fix context
3. The agent inspects logs, fixes code, commits, pushes
4. Re-waits for checks (up to a retry cap)

### Completion Signal

The agent can signal "I'm done" by outputting a magic phrase:

```bash
continuous-loop \
  --prompt "Fix all bugs in the issue tracker" \
  --completion-signal "PROJECT_COMPLETE" \
  --completion-threshold 3  # Stops after 3 consecutive signals
```

Three consecutive iterations signaling completion stops the loop, preventing wasted runs on finished work.

### Key Configuration

| Flag | Purpose |
|------|---------|
| `--max-runs N` | Stop after N successful iterations |
| `--max-cost $X` | Stop after spending $X |
| `--max-duration 2h` | Stop after time elapsed |
| `--merge-strategy squash` | squash, merge, or rebase |
| `--worktree <name>` | Parallel execution via git worktrees |
| `--disable-commits` | Dry-run mode (no git operations) |
| `--review-prompt "..."` | Add reviewer pass per iteration |
| `--ci-retry-max N` | Auto-fix CI failures |

---

## 5. The De-Sloppify Pattern

**An add-on pattern for any loop.** Add a dedicated cleanup/refactor step after each Implementer step.

### The Problem

When you ask an agent to implement with TDD, it takes "write tests" too literally:
- Tests that verify the type system works (testing `typeof x === 'string'`)
- Overly defensive runtime checks for things the type system already guarantees
- Tests for framework behavior rather than business logic
- Excessive error handling that obscures the actual code

### Why Not Negative Instructions?

Adding "don't test type systems" or "don't add unnecessary checks" to the Implementer prompt has downstream effects:
- The model becomes hesitant about ALL testing
- It skips legitimate edge case tests
- Quality degrades unpredictably

### The Solution: Separate Pass

Instead of constraining the Implementer, let it be thorough. Then add a focused cleanup agent:

```bash
# Step 1: Implement (let it be thorough)
agent-run -p "Implement the feature with full TDD. Be thorough with tests."

# Step 2: De-sloppify (separate context, focused cleanup)
agent-run -p "Review all changes in the working tree. Remove:
- Tests that verify language/framework behavior rather than business logic
- Redundant type checks that the type system already enforces
- Over-defensive error handling for impossible states
- Debug print/log statements
- Commented-out code

Keep all business logic tests. Run the test suite after cleanup to ensure nothing breaks."
```

### In a Loop Context

```bash
for feature in "${features[@]}"; do
  agent-run -p "Implement $feature with TDD."
  agent-run -p "Cleanup pass: review changes, remove test/code slop, run tests."
  agent-run -p "Run build + lint + tests. Fix any failures."
  agent-run -p "Commit with message: feat: add $feature"
done
```

### Key Insight

> Rather than adding negative instructions which have downstream quality effects, add a separate de-sloppify pass. Two focused agents outperform one constrained agent.

---

## 6. RFC-Driven DAG Orchestration

**The most sophisticated pattern.** An RFC-driven, multi-agent pipeline that decomposes a spec into a dependency DAG, runs each unit through a tiered quality pipeline, and lands them via an agent-driven merge queue. (Pattern popularized by enitrat's "Ralphinho".)

### Architecture Overview

```
RFC/PRD Document
       │
       ▼
  DECOMPOSITION (AI)
  Break RFC into work units with dependency DAG
       │
       ▼
┌──────────────────────────────────────────────────────┐
│  DRIVER LOOP (up to 3 passes)                        │
│                                                      │
│  For each DAG layer (sequential, by dependency):     │
│                                                      │
│  ┌── Quality Pipelines (parallel per unit) ───────┐  │
│  │  Each unit in its own worktree:                │  │
│  │  Research → Plan → Implement → Test → Review   │  │
│  │  (depth varies by complexity tier)             │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌── Merge Queue ─────────────────────────────────┐  │
│  │  Rebase onto main → Run tests → Land or evict │  │
│  │  Evicted units re-enter with conflict context  │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

### RFC Decomposition

AI reads the RFC and produces work units:

```typescript
interface WorkUnit {
  id: string;              // kebab-case identifier
  name: string;            // Human-readable name
  rfcSections: string[];   // Which RFC sections this addresses
  description: string;     // Detailed description
  deps: string[];          // Dependencies (other unit IDs)
  acceptance: string[];    // Concrete acceptance criteria
  tier: "trivial" | "small" | "medium" | "large";
}
```

**Decomposition Rules:**
- Prefer fewer, cohesive units (minimize merge risk)
- Minimize cross-unit file overlap (avoid conflicts)
- Keep tests WITH implementation (never separate "implement X" + "test X")
- Dependencies only where real code dependency exists

The dependency DAG determines execution order:
```
Layer 0: [unit-a, unit-b]     ← no deps, run in parallel
Layer 1: [unit-c]             ← depends on unit-a
Layer 2: [unit-d, unit-e]     ← depend on unit-c
```

### Complexity Tiers

Different tiers get different pipeline depths:

| Tier | Pipeline Stages |
|------|----------------|
| **trivial** | implement → test |
| **small** | implement → test → code-review |
| **medium** | research → plan → implement → test → PRD-review + code-review → review-fix |
| **large** | research → plan → implement → test → PRD-review + code-review → review-fix → final-review |

This prevents expensive operations on simple changes while ensuring architectural changes get thorough scrutiny.

### Separate Context Windows (Author-Bias Elimination)

Each stage runs in its own agent process with its own context window. Assign model tiers by stage cost/criticality:

| Stage | Model tier | Purpose |
|-------|------------|---------|
| Research | fast | Read codebase + RFC, produce context doc |
| Plan | deep | Design implementation steps |
| Implement | capable | Write code following the plan |
| Test | fast | Run build + test suite |
| PRD Review | fast | Spec compliance check |
| Code Review | deep | Quality + security check |
| Review Fix | capable | Address review issues |
| Final Review | deep | Quality gate (large tier only) |

**Critical design:** The reviewer never wrote the code it reviews. This eliminates author bias — the most common source of missed issues in self-review.

### Merge Queue with Eviction

After quality pipelines complete, units enter the merge queue:

```
Unit branch
    │
    ├─ Rebase onto main
    │   └─ Conflict? → EVICT (capture conflict context)
    │
    ├─ Run build + tests
    │   └─ Fail? → EVICT (capture test output)
    │
    └─ Pass → Fast-forward main, push, delete branch
```

**File Overlap Intelligence:**
- Non-overlapping units land speculatively in parallel
- Overlapping units land one-by-one, rebasing each time

**Eviction Recovery:**
When evicted, full context is captured (conflicting files, diffs, test output) and fed back to the implementer on the next driver pass:

```markdown
## MERGE CONFLICT — RESOLVE BEFORE NEXT LANDING

Your previous implementation conflicted with another unit that landed first.
Restructure your changes to avoid the conflicting files/lines below.

{full eviction context with diffs}
```

### Data Flow Between Stages

```
research.contextFilePath ──────────────────→ plan
plan.implementationSteps ──────────────────→ implement
implement.{filesCreated, whatWasDone} ─────→ test, reviews
test.failingSummary ───────────────────────→ reviews, implement (next pass)
reviews.{feedback, issues} ────────────────→ review-fix → implement (next pass)
final-review.reasoning ────────────────────→ implement (next pass)
evictionContext ───────────────────────────→ implement (after merge conflict)
```

### Worktree Isolation

Every unit runs in an isolated worktree:
```
/tmp/workflow-wt-{unit-id}/
```

Pipeline stages for the same unit **share** a worktree, preserving state (context files, plan files, code changes) across research → plan → implement → test → review.

### Key Design Principles

1. **Deterministic execution** — Upfront decomposition locks in parallelism and ordering
2. **Human review at leverage points** — The work plan is the single highest-leverage intervention point
3. **Separate concerns** — Each stage in a separate context window with a separate agent
4. **Conflict recovery with context** — Full eviction context enables intelligent re-runs, not blind retries
5. **Tier-driven depth** — Trivial changes skip research/review; large changes get maximum scrutiny
6. **Resumable workflows** — Full state persisted to a store (e.g. SQLite); resume from any point

### When to Use DAG Orchestration vs Simpler Patterns

| Signal | Use DAG Orchestration | Use Simpler Pattern |
|--------|-----------------------|---------------------|
| Multiple interdependent work units | Yes | No |
| Need parallel implementation | Yes | No |
| Merge conflicts likely | Yes | No (sequential is fine) |
| Single-file change | No | Yes (sequential pipeline) |
| Multi-day project | Yes | Maybe (continuous PR loop) |
| Spec/RFC already written | Yes | Maybe |
| Quick iteration on one thing | No | Yes (REPL or pipeline) |

---

## Choosing the Right Pattern

### Decision Matrix

```
Is the task a single focused change?
├─ Yes → Sequential Pipeline or Persistent REPL
└─ No → Is there a written spec/RFC?
         ├─ Yes → Do you need parallel implementation?
         │        ├─ Yes → DAG orchestration (merge queue)
         │        └─ No → Continuous PR loop (iterative)
         └─ No → Do you need many variations of the same thing?
                  ├─ Yes → Infinite Agentic Loop (spec-driven generation)
                  └─ No → Sequential Pipeline with de-sloppify
```

### Combining Patterns

These patterns compose well:

1. **Sequential Pipeline + De-Sloppify** — The most common combination. Every implement step gets a cleanup pass.
2. **Continuous PR loop + De-Sloppify** — Add `--review-prompt` with a de-sloppify directive to each iteration.
3. **Any loop + Verification** — Use a verification/quality gate as a check before commits.
4. **Tiered model routing in simpler loops** — Even in a sequential pipeline, route simple tasks to a cheap model and complex tasks to a deep-reasoning model:
   ```bash
   agent-run -p --model cheap "Fix the import ordering in src/utils.ts"
   agent-run -p --model deep "Refactor the auth module to use the strategy pattern"
   ```

---

## Anti-Patterns

1. **Infinite loops without exit conditions** — Always have a max-runs, max-cost, max-duration, or completion signal.
2. **No context bridge between iterations** — Each headless call starts fresh. Use `SHARED_TASK_NOTES.md` or filesystem state to bridge context.
3. **Retrying the same failure** — If an iteration fails, don't just retry. Capture the error context and feed it to the next attempt.
4. **Negative instructions instead of cleanup passes** — Don't say "don't do X." Add a separate pass that removes X.
5. **All agents in one context window** — For complex workflows, separate concerns into different agent processes. The reviewer should never be the author.
6. **Ignoring file overlap in parallel work** — If two parallel agents might edit the same file, you need a merge strategy (sequential landing, rebase, or conflict resolution).

## References

These patterns build on public work by the community:

| Pattern | Credit |
|---------|--------|
| RFC-driven DAG orchestration ("Ralphinho") | enitrat |
| Infinite Agentic Loop | disler |
| Continuous PR loop ("Continuous Claude") | AnandChowdhary |
