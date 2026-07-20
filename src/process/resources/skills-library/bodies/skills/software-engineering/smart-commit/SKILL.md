---
name: smart-commit
description: |
  Stages and commits changes using natural-language file targeting — describe what to commit in plain English and the skill interprets it against git status and diff, then writes a conventional-commit message.
  Use when the user wants to commit a subset of changes described informally ("the auth changes", "everything except tests"), or wants an auto-generated conventional-commit message.
  Do NOT use for pushing, opening pull requests, rewriting history, or resolving merge conflicts.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "git commit conventional-commits version-control workflow"
  category: "software-engineering"
  depends: ""
  disclaimer: "none"
  difficulty: "beginner"
---

# Smart Commit

Commit changes with natural-language file targeting. The input describes what to stage in plain English (blank means all changes).

## Phase 1 — Assess

```bash
git status --short
```

If the output is empty, stop: "Nothing to commit." Otherwise show the user a summary of what changed (added, modified, deleted, untracked).

## Phase 2 — Interpret & Stage

Interpret the target description to decide what to stage:

| Input | Interpretation | Git command |
|---|---|---|
| *(blank)* | Stage everything | `git add -A` |
| `staged` | Use whatever is already staged | *(no git add)* |
| `*.ts` / `*.py` etc. | Stage matching glob | `git add '*.ts'` |
| `except tests` | Stage all, then unstage tests | `git add -A && git reset -- '**/*.test.*' '**/*.spec.*' '**/test_*' 2>/dev/null \|\| true` |
| `only new files` | Stage untracked files only | `git ls-files --others --exclude-standard \| xargs git add` |
| `the auth changes` | Interpret from status/diff — find related files | `git add <matched files>` |
| Specific filenames | Stage those files | `git add <files>` |

For natural-language inputs, cross-reference `git status` and `git diff` to identify the relevant files. Show the user which files are being staged and why.

After staging, verify:

```bash
git diff --cached --stat
```

If nothing is staged, stop: "No files matched your description."

## Phase 3 — Commit

Craft a single-line message in imperative mood:

```
{type}: {description}
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

Rules:

- Imperative mood ("add feature", not "added feature")
- Lowercase after the type prefix
- No trailing period
- Under 72 characters
- Describe WHAT changed, not HOW

```bash
git commit -m "{type}: {description}"
```

## Phase 4 — Output

```
Committed: {hash_short}
Message:   {type}: {description}
Files:     {count} file(s) changed
```

## Examples

| Description | What happens |
|---|---|
| *(blank)* | Stages all, auto-generates message |
| `staged` | Commits only what is already staged |
| `*.ts` | Stages all TypeScript files, commits |
| `except tests` | Stages everything except test files |
| `the database migration` | Finds migration files from status, stages them |
| `only new files` | Stages untracked files only |

## When to Use

- Committing a described subset of a dirty working tree
- Generating a conventional-commit message from the actual diff
- Quick, disciplined commits without hand-picking files

## Edge Cases

- **Ambiguous description**: show the matched files and confirm before committing rather than guessing.
- **Nothing matches**: stop cleanly instead of committing an empty change.
- **Mixed change types**: pick the dominant type for the prefix and mention the secondary area in the description.
