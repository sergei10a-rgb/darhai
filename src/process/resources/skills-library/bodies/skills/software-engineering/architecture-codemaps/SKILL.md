---
name: architecture-codemaps
description: |
  Scans a project's structure and generates token-lean architecture codemaps — high-level system, backend, frontend, data, and dependency maps optimized for AI context consumption rather than exhaustive detail.
  Use when the user wants a compact architecture overview, up-to-date codemaps for AI context, or a refreshed structural summary after major changes.
  Do NOT use for detailed API documentation, per-function docstrings, or user-facing product documentation.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "architecture documentation codemap onboarding analysis"
  category: "software-engineering"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Architecture Codemaps

Analyze the codebase structure and generate token-lean architecture documentation optimized for AI context loading.

## Step 1: Scan Project Structure

1. Identify the project type (monorepo, single app, library, microservice).
2. Find all source directories (`src/`, `lib/`, `app/`, `packages/`).
3. Map entry points (`main.ts`, `index.ts`, `app.py`, `main.go`, etc.).

## Step 2: Generate Codemaps

Create or update codemaps under `docs/CODEMAPS/` (or `.reports/codemaps/`):

| File | Contents |
|------|----------|
| `architecture.md` | High-level system diagram, service boundaries, data flow |
| `backend.md` | API routes, middleware chain, service -> repository mapping |
| `frontend.md` | Page tree, component hierarchy, state management flow |
| `data.md` | Database tables, relationships, migration history |
| `dependencies.md` | External services, third-party integrations, shared libraries |

### Codemap Format

Each codemap should be token-lean — optimized for AI context consumption:

```markdown
# Backend Architecture

## Routes
POST /api/users -> UserController.create -> UserService.create -> UserRepo.insert
GET  /api/users/:id -> UserController.get -> UserService.findById -> UserRepo.findById

## Key Files
src/services/user.ts (business logic, 120 lines)
src/repos/user.ts (database access, 80 lines)

## Dependencies
- PostgreSQL (primary data store)
- Redis (session cache, rate limiting)
- Stripe (payment processing)
```

## Step 3: Diff Detection

1. If previous codemaps exist, calculate the diff percentage.
2. If changes are > 30%, show the diff and request approval before overwriting.
3. If changes are <= 30%, update in place.

## Step 4: Add Metadata

Add a freshness header to each codemap:

```markdown
<!-- Generated: 2026-02-11 | Files scanned: 142 | Token estimate: ~800 -->
```

## Step 5: Save an Analysis Report

Write a summary to `.reports/codemap-diff.txt`:

- Files added / removed / modified since the last scan
- New dependencies detected
- Architecture changes (new routes, new services, etc.)
- Staleness warnings for docs not updated in 90+ days

## Tips

- Focus on **high-level structure**, not implementation details.
- Prefer **file paths and function signatures** over full code blocks.
- Keep each codemap under **1000 tokens** for efficient context loading.
- Use ASCII diagrams for data flow instead of verbose descriptions.
- Run after major feature additions or refactoring sessions.

## When to Use

- Producing a compact architecture overview for AI context
- Refreshing structural docs after a large feature or refactor
- Onboarding by mapping routes, services, and data flow quickly

## Edge Cases

- **Large diff**: when structure changed > 30%, confirm before overwriting so intentional context isn't lost.
- **Generated directories**: skip build output and vendored code so maps reflect authored structure.
- **Token budget**: if a map exceeds ~1000 tokens, split by domain rather than bloating a single file.
