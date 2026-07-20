---
name: flutter-test
description: >-
  Runs Flutter and Dart tests (unit, widget, golden, integration), reports failures, and fixes them incrementally with a coverage summary.
  Use when verifying a Flutter change or diagnosing failing Flutter tests.
  Do NOT use for fixing compile/build errors that stop tests from running at all.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "flutter dart testing widget-tests coverage"
  category: "testing-quality"
  subcategory: "mobile-testing"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Flutter Test

Run the Flutter test suite and report results. When failures occur, diagnose and fix them incrementally.

## What This Skill Does

1. **Run Tests**: Execute `flutter test` (or scope to changed files).
2. **Parse Failures**: Identify failing tests by type and cause.
3. **Fix Incrementally**: One failure at a time where possible.
4. **Verify**: Re-run after each fix.
5. **Report**: Show the coverage summary and remaining failures.

## When to Use

- After implementing a feature to verify nothing broke
- After fixing build errors, to ensure tests pass
- To check test coverage on new code
- When a specific test file is failing
- Before submitting a PR

## Commands

```bash
# Run all tests
flutter test 2>&1

# Run with coverage
flutter test --coverage 2>&1

# Run a specific test file
flutter test test/unit/domain/usecases/get_user_test.dart 2>&1

# Run tests matching a name pattern
flutter test --name "CartBloc" 2>&1

# Run integration tests (requires device/emulator)
flutter test integration_test/ 2>&1

# Update golden files when intentional visual changes are made
flutter test --update-goldens 2>&1
```

## Common Test Failures

| Failure | Typical Fix |
|---------|-------------|
| `Expected: <X> Actual: <Y>` | Update the assertion or fix the implementation |
| `Widget not found` | Fix the finder selector or update the test after a widget rename |
| `Golden file not found` | Run `flutter test --update-goldens` to generate |
| `Golden mismatch` | Inspect the diff; run `--update-goldens` only if the change was intentional |
| `MissingPluginException` | Mock the platform channel in test setup |
| `LateInitializationError` | Initialize `late` fields in `setUp()` |
| `pumpAndSettle timed out` | Replace with explicit `pump(Duration)` calls |

## Fix Approach

When a test fails, determine whether the test or the implementation is wrong before changing anything:

- If the implementation regressed, fix the implementation.
- If the test assertion is stale (for example, copy was renamed from "Your cart is empty" to "Cart is empty"), update the test to match current behavior.
- Re-run just the affected file after each fix, then run the full suite with coverage at the end.

Target coverage is typically 80% or higher. Report total tests, passed, failed, and coverage. Before running tests, ensure the build is clean; fix build errors first.
