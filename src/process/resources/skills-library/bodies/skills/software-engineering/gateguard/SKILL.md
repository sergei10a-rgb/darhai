---
name: gateguard
description: |
  A fact-forcing pre-action gate that blocks the first Edit/Write/destructive-Bash attempt and demands concrete investigation (importers, data schemas, verbatim user instruction) before allowing the action. Investigation-forcing measurably outperforms self-evaluation.
  Use on any codebase where edits affect multiple modules, where data files have specific schemas, or where an agent tends to guess instead of investigating.
  Do NOT use as a substitute for post-edit code review, and do not gate routine read-only commands.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "guardrails code-quality pre-action-gate agent-safety developer-tools"
  category: "software-engineering"
  subcategory: "developer-tools"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# GateGuard — Fact-Forcing Pre-Action Gate

A pre-action gate that forces the agent to investigate before editing. Instead of self-evaluation ("are you sure?"), it demands concrete facts. The act of investigation creates awareness that self-evaluation never did.

## When to Activate

- Working on any codebase where file edits affect multiple modules
- Projects with data files that have specific schemas or date formats
- Teams where AI-generated code must match existing patterns
- Any workflow where the agent tends to guess instead of investigating

## Core Concept

LLM self-evaluation doesn't work. Ask "did you violate any policies?" and the answer is always "no." This is verified experimentally.

But asking "list every file that imports this module" forces the agent to run Grep and Read. The investigation itself creates context that changes the output.

**Three-stage gate:**

```
1. DENY  — block the first Edit/Write/destructive-Bash attempt
2. FORCE — tell the agent exactly which facts to gather
3. ALLOW — permit retry after the facts are presented
```

Most guardrails stop at deny. The value is in doing all three.

## Evidence

Two independent A/B tests, identical agents, same task:

| Task | Gated | Ungated | Gap |
| --- | --- | --- | --- |
| Analytics module | 8.0/10 | 6.5/10 | +1.5 |
| Webhook validator | 10.0/10 | 7.0/10 | +3.0 |
| **Average** | **9.0** | **6.75** | **+2.25** |

Both agents produce code that runs and passes tests. The difference is design depth.

## Gate Types

### Edit Gate (first edit per file)

Batch/multi-edit operations are handled identically — each file in the batch is gated individually.

```
Before editing {file_path}, present these facts:

1. List ALL files that import/require this file (use Grep)
2. List the public functions/classes affected by this change
3. If this file reads/writes data files, show field names, structure,
   and date format (use redacted or synthetic values, not raw production data)
4. Quote the user's current instruction verbatim
```

### Write Gate (first new file creation)

```
Before creating {file_path}, present these facts:

1. Name the file(s) and line(s) that will call this new file
2. Confirm no existing file serves the same purpose (use Glob)
3. If this file reads/writes data files, show field names, structure,
   and date format (use redacted or synthetic values, not raw production data)
4. Quote the user's current instruction verbatim
```

### Destructive Bash Gate (every destructive command)

Triggers on: `rm -rf`, `git reset --hard`, `git push --force`, `drop table`, etc.

```
1. List all files/data this command will modify or delete
2. Write a one-line rollback procedure
3. Quote the user's current instruction verbatim
```

### Routine Bash Gate (once per session)

```
1. The current user request in one sentence
2. What this specific command verifies or produces
```

## Implementation

Implement GateGuard as a pre-action hook in your agent harness — the harness intercepts the tool call, returns a DENY with the required facts, and the agent must present them before the retry is allowed.

To keep long sessions healthy, cap how many full four-fact denial blocks are emitted (a default of 3 works well); condense later denials to a single line carrying the denial ordinal, so near-identical blocks cannot accumulate in the context window and amplify model repetition loops. Retrying the same file or command after presenting the facts must never re-trigger the gate.

Provide an env toggle (e.g. `GATEGUARD=off`) and a per-hook disable path so setup or repair work is never blocked. A per-project config file can hold custom gate messages, ignore paths (`.venv/`, `node_modules/`, `.git/`), and gate toggles.

## Anti-Patterns

- **Don't use self-evaluation instead.** "Are you sure?" always gets "yes." This is experimentally verified.
- **Don't skip the data schema check.** Both A/B test agents assumed ISO-8601 dates when real data used `%Y/%m/%d %H:%M`. Checking data structure (with redacted values) prevents this entire class of bugs.
- **Don't gate every single Bash command.** Routine bash gates once per session. Destructive bash gates every time. This balance avoids slowdown while catching real risks.

## Best Practices

- Let the gate fire naturally. Don't try to pre-answer the gate questions — the investigation itself is what improves quality.
- Customize gate messages for your domain. If your project has specific conventions, add them to the gate prompts.
- Use the ignore-paths config to skip vendored and generated directories.

## Related Skills

- A runtime safety-check skill — complementary, not overlapping.
- A post-edit code-review skill — GateGuard is pre-edit investigation; review is post-edit verification.
