---
name: repo-scan
description: |
  Cross-stack source-code asset audit — classifies every file (project code, embedded third-party, or build artifact), detects embedded third-party libraries with version extraction, and delivers a four-level verdict per module with an interactive report.
  Use when taking over a large legacy codebase, auditing embedded dependencies not declared in package managers, or preparing an architecture decision record for a monorepo reorganization.
  Do NOT use for single-language dependency management already covered by a package manager, or for small projects where a manual read is faster.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "code-audit legacy-code dependency-analysis monorepo developer-tools"
  category: "software-engineering"
  subcategory: "developer-tools"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# repo-scan

> Every ecosystem has its own dependency manager, but no tool looks across C++, Android, iOS, and Web to tell you: how much code is actually yours, what's third-party, and what's dead weight.

## When to Use

- Taking over a large legacy codebase and need a structural overview
- Before major refactoring — identify what's core, what's duplicate, what's dead
- Auditing third-party dependencies embedded directly in source (not declared in package managers)
- Preparing architecture decision records for monorepo reorganization

## Core Capabilities

| Capability | Description |
|---|---|
| **Cross-stack scanning** | C/C++, Java/Android, iOS (OC/Swift), Web (TS/JS/Vue) in one pass |
| **File classification** | Every file tagged as project code, third-party, or build artifact |
| **Library detection** | 50+ known libraries (FFmpeg, Boost, OpenSSL…) with version extraction |
| **Four-level verdicts** | Core Asset / Extract & Merge / Rebuild / Deprecate |
| **Interactive reports** | Drill-down pages with per-module navigation |
| **Monorepo support** | Hierarchical scanning with summary + sub-project reports |

## Analysis Depth Levels

| Level | Files Read | Use Case |
|---|---|---|
| `fast` | 1-2 per module | Quick inventory of huge directories |
| `standard` | 2-5 per module | Default audit with full dependency + architecture checks |
| `deep` | 5-10 per module | Adds thread safety, memory management, API consistency |
| `full` | All files | Pre-merge comprehensive review |

## How It Works

1. **Classify the repo surface**: enumerate files, then tag each as project code, embedded third-party code, or build artifact.
2. **Detect embedded libraries**: inspect directory names, headers, license files, and version markers to identify bundled dependencies and likely versions.
3. **Score each module**: group files by module or subsystem, then assign one of the four verdicts based on ownership, duplication, and maintenance cost.
4. **Highlight structural risks**: call out dead-weight artifacts, duplicated wrappers, outdated vendored code, and modules that should be extracted, rebuilt, or deprecated.
5. **Produce the report**: return a concise summary plus an interactive output with per-module drill-down so the audit can be reviewed asynchronously.

## Four-Level Verdicts

| Verdict | Meaning |
|---|---|
| **Core Asset** | Owned, actively maintained code central to the product — keep and invest |
| **Extract & Merge** | Duplicated or scattered logic that should be consolidated into one module |
| **Rebuild** | Outdated or fragile code whose cheapest path forward is a rewrite |
| **Deprecate** | Dead weight — unused code, committed build artifacts, abandoned vendored libs |

## Examples

On a 50,000-file C++ monorepo:
- Found FFmpeg 2.x (2015 vintage) still in production
- Discovered the same SDK wrapper duplicated 3 times
- Identified 636 MB of committed Debug/ipch/obj build artifacts
- Classified: 3 MB project code vs 596 MB third-party

## Best Practices

- Start with `standard` depth for first-time audits
- Use `fast` for monorepos with 100+ modules to get a quick inventory
- Run `deep` incrementally on modules flagged for refactoring
- Review the cross-module analysis for duplicate detection across sub-projects
