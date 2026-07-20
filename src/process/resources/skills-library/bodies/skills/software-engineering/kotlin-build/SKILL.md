---
name: kotlin-build
description: >-
  Fixes Kotlin and Gradle build errors, compiler warnings, and dependency issues incrementally with minimal, surgical changes.
  Use when `./gradlew build`, the Kotlin compiler, or detekt/ktlint reports errors.
  Do NOT use for code-quality review or non-Kotlin code.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "kotlin gradle build compiler-errors debugging"
  category: "software-engineering"
  subcategory: "developer-tools"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Kotlin Build and Fix

Act as a Kotlin build-resolution specialist. Incrementally fix Kotlin build errors with minimal changes.

## What This Skill Does

1. **Run Diagnostics**: Execute `./gradlew build`, `detekt`, `ktlintCheck`.
2. **Parse Errors**: Group by file and sort by severity.
3. **Fix Incrementally**: One error at a time.
4. **Verify Each Fix**: Re-run the build after each change.
5. **Report Summary**: Show what was fixed and what remains.

## When to Use

- `./gradlew build` fails with errors
- The Kotlin compiler reports errors
- `./gradlew detekt` reports violations
- Gradle dependency resolution fails
- After pulling changes that break the build

## Diagnostic Commands

```bash
# Primary build check
./gradlew build 2>&1

# Static analysis
./gradlew detekt 2>&1 || echo "detekt not configured"
./gradlew ktlintCheck 2>&1 || echo "ktlint not configured"

# Dependency issues
./gradlew dependencies --configuration runtimeClasspath 2>&1 | head -100

# Optional deep refresh when caches or dependency metadata are suspect
./gradlew build --refresh-dependencies
```

## Common Errors Fixed

| Error | Typical Fix |
|-------|-------------|
| `Unresolved reference: X` | Add the import or dependency |
| `Type mismatch` | Fix the type conversion or assignment |
| `'when' must be exhaustive` | Add the missing sealed-class branches |
| `Suspend function can only be called from a coroutine` | Add the `suspend` modifier |
| `Smart cast impossible` | Use a local `val` or `let` |
| `None of the following candidates is applicable` | Fix argument types |
| `Could not resolve dependency` | Fix the version or add the repository |

## Example Fixes

**Type mismatch** — parse a nullable query parameter to the expected type:

```kotlin
val count = call.parameters["count"]?.toIntOrNull()
    ?: return@get call.respond(HttpStatusCode.BadRequest, "Invalid count")
```

**Non-exhaustive when** — add the missing branch:

```kotlin
when (user.role) {
    Role.ADMIN -> handleAdmin(user)
    Role.USER -> handleUser(user)
    Role.MODERATOR -> handleModerator(user) // added
}
```

## Fix Strategy

1. **Build errors first** — code must compile.
2. **Detekt violations second** — fix code-quality issues.
3. **ktlint warnings third** — fix formatting.
4. **One fix at a time** — verify each change.
5. **Minimal changes** — do not refactor, just fix.

## Stop Conditions

Stop and report if:

- The same error persists after 3 attempts.
- A fix introduces more errors.
- The fix requires architectural changes.
- External dependencies are missing.

After the build is clean, run the Kotlin test workflow, then Kotlin code review.
