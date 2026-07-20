---
name: dead-code-removal
description: |
  Safely identifies and removes dead code — unused exports, files, and dependencies — with full test verification after every single deletion and immediate rollback on any failure.
  Use when the user wants to clean up dead code, remove unused dependencies, or reduce codebase size safely with a test-guarded deletion loop.
  Do NOT use for behavior-changing refactors, performance rewrites, or when the project has no test suite to guard deletions.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "refactoring dead-code cleanup maintenance testing"
  category: "software-engineering"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Dead Code Removal

Identify and remove dead code with test verification at every step. Clean first; refactor later — never mix the two.

## Step 1: Detect Dead Code

Run analysis tools based on project type:

| Tool | What it finds | Command |
|------|--------------|---------|
| knip | Unused exports, files, dependencies | `npx knip` |
| depcheck | Unused npm dependencies | `npx depcheck` |
| ts-prune | Unused TypeScript exports | `npx ts-prune` |
| vulture | Unused Python code | `vulture src/` |
| deadcode | Unused Go code | `deadcode ./...` |
| cargo-udeps | Unused Rust dependencies | `cargo +nightly udeps` |

If no tool is available, use a content search to find exports with zero imports.

## Step 2: Categorize Findings

Sort findings into safety tiers:

| Tier | Examples | Action |
|------|----------|--------|
| **SAFE** | Unused utilities, test helpers, internal functions | Delete with confidence |
| **CAUTION** | Components, API routes, middleware | Verify no dynamic imports or external consumers |
| **DANGER** | Config files, entry points, type definitions | Investigate before touching |

## Step 3: Safe Deletion Loop

For each SAFE item:

1. **Run the full test suite** — establish a green baseline.
2. **Delete the dead code** — surgical removal only.
3. **Re-run the test suite** — verify nothing broke.
4. **If tests fail** — immediately revert with `git checkout -- <file>` and skip this item.
5. **If tests pass** — move to the next item.

## Step 4: Handle CAUTION Items

Before deleting a CAUTION item:

- Search for dynamic imports: `import()`, `require()`, `__import__`
- Search for string references: route names, component names in configs
- Check whether it is exported from a public package API
- Verify there are no external consumers (check dependents if published)

## Step 5: Consolidate Duplicates

After removing dead code, look for:

- Near-duplicate functions (>80% similar) — merge into one
- Redundant type definitions — consolidate
- Wrapper functions that add no value — inline them
- Re-exports that serve no purpose — remove the indirection

## Step 6: Report

```
Dead Code Cleanup
------------------------------
Deleted:   12 unused functions
           3 unused files
           5 unused dependencies
Skipped:   2 items (tests failed)
Saved:     ~450 lines removed
------------------------------
All tests passing.
```

## Rules

- **Never delete without running tests first.**
- **One deletion at a time** — atomic changes make rollback easy.
- **Skip if uncertain** — better to keep dead code than break production.
- **Don't refactor while cleaning** — separate the concerns.

## When to Use

- Periodic maintenance to shrink an accreted codebase
- After a large feature removal that left orphaned code
- Trimming unused dependencies flagged by an audit

## Edge Cases

- **Dynamically referenced code**: string-keyed routes/components can look unused; verify before deleting.
- **Public library surface**: exports consumed by downstream packages are not dead even with zero local imports.
- **No test suite**: stop and recommend adding at least smoke tests before any deletion, since the safety loop depends on them.
