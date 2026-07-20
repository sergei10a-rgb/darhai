---
name: docs-sync-from-source
description: |
  Syncs documentation with the codebase by generating reference sections from source-of-truth files — package scripts, env templates, route/OpenAPI definitions, and exports — while preserving hand-written prose and flagging stale docs.
  Use when the user wants documentation regenerated from code, a scripts or environment-variable reference kept in sync, or contributing/runbook docs updated from current sources.
  Do NOT use for authoring net-new narrative content or creating docs the command did not explicitly request.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "documentation automation reference maintenance devx"
  category: "software-engineering"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Docs Sync from Source

Sync documentation with the codebase, generating from source-of-truth files rather than hand-editing generated sections.

## Step 1: Identify Sources of Truth

| Source | Generates |
|--------|-----------|
| `package.json` scripts | Available commands reference |
| `.env.example` | Environment variable documentation |
| `openapi.yaml` / route files | API endpoint reference |
| Source code exports | Public API documentation |
| `Dockerfile` / `docker-compose.yml` | Infrastructure setup docs |

## Step 2: Generate the Script Reference

1. Read `package.json` (or `Makefile`, `Cargo.toml`, `pyproject.toml`).
2. Extract all scripts/commands with their descriptions.
3. Generate a reference table:

```markdown
| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Production build with type checking |
| `npm test` | Run test suite with coverage |
```

## Step 3: Generate Environment Documentation

1. Read `.env.example` (or `.env.template`, `.env.sample`).
2. Extract all variables with their purposes.
3. Categorize as required vs optional.
4. Document expected format and valid values.

```markdown
| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `DATABASE_URL` | Yes | PostgreSQL connection string | `postgres://user:pass@host:5432/db` |
| `LOG_LEVEL` | No | Logging verbosity (default: info) | `debug`, `info`, `warn`, `error` |
```

## Step 4: Update the Contributing Guide

Generate or update `docs/CONTRIBUTING.md` with:

- Development environment setup (prerequisites, install steps)
- Available scripts and their purposes
- Testing procedures (how to run, how to write new tests)
- Code-style enforcement (linter, formatter, pre-commit hooks)
- PR submission checklist

## Step 5: Update the Runbook

Generate or update `docs/RUNBOOK.md` with:

- Deployment procedures (step-by-step)
- Health-check endpoints and monitoring
- Common issues and their fixes
- Rollback procedures
- Alerting and escalation paths

## Step 6: Staleness Check

1. Find documentation files not modified in 90+ days.
2. Cross-reference with recent source-code changes.
3. Flag potentially outdated docs for manual review.

## Step 7: Summary

```
Documentation Update
------------------------------
Updated:  docs/CONTRIBUTING.md (scripts table)
Updated:  docs/ENV.md (3 new variables)
Flagged:  docs/DEPLOY.md (142 days stale)
Skipped:  docs/API.md (no changes detected)
------------------------------
```

## Rules

- **Single source of truth**: always generate from code; never hand-edit generated sections.
- **Preserve manual sections**: update only generated sections; leave hand-written prose intact.
- **Mark generated content**: wrap generated sections in `<!-- AUTO-GENERATED -->` markers.
- **Don't create docs unprompted**: only create new doc files when explicitly requested.

## When to Use

- Keeping a scripts or environment-variable reference in sync with code
- Regenerating contributing and runbook docs after tooling changes
- Auditing which docs have gone stale relative to source

## Edge Cases

- **Mixed manual/generated files**: only touch the marked generated regions so prose survives.
- **No `.env.example`**: skip the env section rather than documenting undeclared variables.
- **Stale but still-correct docs**: flag for review instead of auto-rewriting content you cannot verify from source.
