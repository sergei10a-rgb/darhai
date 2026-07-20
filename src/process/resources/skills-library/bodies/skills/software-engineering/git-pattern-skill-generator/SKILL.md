---
name: git-pattern-skill-generator
description: |
  Analyzes a repository's git history to extract recurring coding patterns — commit conventions, file co-changes, architecture, and testing conventions — and generates a reusable SKILL.md that teaches those team practices.
  Use when the user wants to capture a codebase's conventions into a shareable skill file, or bootstrap a patterns document from real commit history.
  Do NOT use for repositories with little or no git history, or for generating application code rather than documentation.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "git skill-authoring conventions analysis documentation"
  category: "software-engineering"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Git Pattern Skill Generator

Analyze a repository's git history to extract coding patterns and generate a `SKILL.md` file that captures the team's conventions.

## What It Does

1. **Parse git history** — analyze commits, file changes, and patterns.
2. **Detect patterns** — identify recurring workflows and conventions.
3. **Generate SKILL.md** — produce a valid skill file describing the patterns.

Optional flags: analyze the last N commits, or write to a custom output directory.

## Step 1: Gather Git Data

```bash
# Recent commits with file changes
git log --oneline -n ${COMMITS:-200} --name-only --pretty=format:"%H|%s|%ad" --date=short

# Commit frequency by file
git log --oneline -n 200 --name-only | grep -v "^$" | grep -v "^[a-f0-9]" | sort | uniq -c | sort -rn | head -20

# Commit message patterns
git log --oneline -n 200 | cut -d' ' -f2- | head -50
```

## Step 2: Detect Patterns

| Pattern | Detection method |
|---------|-----------------|
| **Commit conventions** | Regex on commit messages (`feat:`, `fix:`, `chore:`) |
| **File co-changes** | Files that always change together |
| **Workflow sequences** | Repeated file-change patterns |
| **Architecture** | Folder structure and naming conventions |
| **Testing patterns** | Test file locations, naming, coverage |

## Step 3: Generate SKILL.md

Output format:

```markdown
---
name: {repo-name}-patterns
description: Coding patterns extracted from {repo-name}. Use when writing code in this repository to match its established conventions.
metadata:
  author: darhai
  version: "1.0.0"
  tags: "conventions patterns {repo-name}"
  category: "software-engineering"
---

# {Repo Name} Patterns

## Commit Conventions
{detected commit message patterns}

## Code Architecture
{detected folder structure and organization}

## Workflows
{detected repeating file-change patterns}

## Testing Patterns
{detected test conventions}
```

## Example Output (abridged)

Running against a TypeScript project might produce:

```markdown
# My App Patterns

## Commit Conventions
Conventional commits: feat:, fix:, chore:, docs:, test:, refactor:

## Code Architecture
src/
  components/   # React components (PascalCase.tsx)
  hooks/        # Custom hooks (use*.ts)
  utils/        # Utility functions
  types/        # TypeScript type definitions
  services/     # API and external services

## Workflows
### Adding a New Component
1. Create src/components/ComponentName.tsx
2. Add tests in src/components/__tests__/ComponentName.test.tsx
3. Export from src/components/index.ts

## Testing Patterns
- Test files: __tests__/ directories or .test.ts suffix
- Coverage target: 80%+
- Framework: Vitest
```

## When to Use

- Capturing an existing codebase's conventions into a shareable skill
- Bootstrapping a patterns document from real commit history
- Onboarding new contributors with evidence-based conventions

## Edge Cases

- **Shallow or new repo**: with too few commits the signal is weak — report low confidence rather than inventing patterns.
- **Squash-merge history**: file co-change signals degrade; lean more on message conventions and directory structure.
- **Monorepo**: scope the analysis to one package at a time so patterns don't blur across projects.
