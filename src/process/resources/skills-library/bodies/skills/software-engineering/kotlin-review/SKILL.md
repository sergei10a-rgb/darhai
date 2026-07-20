---
name: kotlin-review
description: >-
  Reviews Kotlin changes for idiomatic patterns, null safety, coroutine and structured-concurrency correctness, and security, categorizing findings by severity.
  Use when Kotlin code has been written or modified and needs review before commit.
  Do NOT use for build-error fixing or non-Kotlin code.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "kotlin code-review null-safety coroutines security"
  category: "software-engineering"
  subcategory: "developer-tools"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# Kotlin Code Review

Act as a Kotlin review specialist and perform a comprehensive, Kotlin-specific code review.

## What This Skill Does

1. **Identify Kotlin Changes**: Find modified `.kt` and `.kts` files via `git diff`.
2. **Run Build & Static Analysis**: Execute `./gradlew build`, `detekt`, `ktlintCheck`.
3. **Security Scan**: Check for SQL injection, command injection, hardcoded secrets.
4. **Null Safety Review**: Analyze `!!` usage, platform-type handling, unsafe casts.
5. **Coroutine Review**: Check structured concurrency, dispatcher usage, cancellation.
6. **Generate Report**: Categorize issues by severity.

## When to Use

- After writing or modifying Kotlin code
- Before committing Kotlin changes
- Reviewing pull requests with Kotlin code
- Onboarding to a new Kotlin codebase
- Learning idiomatic Kotlin patterns

## Review Categories

### CRITICAL (Must Fix)
- SQL/command injection vulnerabilities
- Force-unwrap `!!` without justification
- Platform-type null-safety violations
- `GlobalScope` usage (structured-concurrency violation)
- Hardcoded credentials
- Unsafe deserialization

### HIGH (Should Fix)
- Mutable state where immutable suffices
- Blocking calls inside a coroutine context
- Missing cancellation checks in long loops
- Non-exhaustive `when` on sealed types
- Large functions (>50 lines)
- Deep nesting (>4 levels)

### MEDIUM (Consider)
- Non-idiomatic Kotlin (Java-style patterns)
- Missing trailing commas
- Scope-function misuse or nesting
- Missing `sequence` for large collection chains
- Redundant explicit types

## Automated Checks

```bash
./gradlew build       # Build check
./gradlew detekt      # Static analysis
./gradlew ktlintCheck # Formatting check
./gradlew test        # Tests
```

## Example Findings

**[CRITICAL] Force-unwrap null safety** — replace `!!` with safe handling:

```kotlin
val user = repository.findById(id)   // instead of findById(id)!!
    ?: throw UserNotFoundException("User $id not found")
```

**[HIGH] GlobalScope usage** — use the call's own coroutine scope instead of `GlobalScope`:

```kotlin
launch {
    notificationService.sendWelcome(user)
}
```

## Approval Criteria

| Status | Condition |
|--------|-----------|
| Approve | No CRITICAL or HIGH issues |
| Warning | Only MEDIUM issues (merge with caution) |
| Block | CRITICAL or HIGH issues found |

Report each finding with severity, file and line, the problem, and a concrete fix. Block the merge until CRITICAL issues are resolved.
