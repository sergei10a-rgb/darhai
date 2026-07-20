---
name: flutter-build
description: >-
  Fixes Dart analyzer errors and Flutter build failures incrementally with minimal, surgical changes across null-safety, dependencies, and code generation.
  Use when `flutter analyze` reports errors or a platform build fails.
  Do NOT use for test failures or code-quality review.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "flutter dart build null-safety debugging"
  category: "software-engineering"
  subcategory: "mobile-development"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Flutter Build and Fix

Act as a Dart/Flutter build-resolution specialist. Incrementally fix Dart/Flutter build errors with minimal changes.

## What This Skill Does

1. **Run Diagnostics**: Execute `flutter analyze`, `flutter pub get`.
2. **Parse Errors**: Group by file and sort by severity.
3. **Fix Incrementally**: One error at a time.
4. **Verify Each Fix**: Re-run analysis after each change.
5. **Report Summary**: Show what was fixed and what remains.

## When to Use

- `flutter analyze` reports errors
- `flutter build` fails for any platform
- `dart pub get` / `flutter pub get` fails with version conflicts
- `build_runner` fails to generate code
- After pulling changes that break the build

## Diagnostic Commands

```bash
# Analysis
flutter analyze 2>&1

# Dependencies
flutter pub get 2>&1

# Code generation (if the project uses build_runner)
dart run build_runner build --delete-conflicting-outputs 2>&1

# Platform builds
flutter build apk 2>&1
flutter build web 2>&1
```

## Common Errors Fixed

| Error | Typical Fix |
|-------|-------------|
| `A value of type 'X?' can't be assigned to 'X'` | Add `?? default` or a null guard |
| `The name 'X' isn't defined` | Add the import or fix the typo |
| `Non-nullable instance field must be initialized` | Add an initializer or `late` |
| `Version solving failed` | Adjust version constraints in `pubspec.yaml` |
| `Missing concrete implementation of 'X'` | Implement the missing interface method |
| `build_runner: Part of X expected` | Delete the stale `.g.dart` and rebuild |

## Example Fixes

**Null safety** — `A value of type 'String?' can't be assigned to type 'String'`:

```dart
final id = response.id ?? '';
```

**Immutable list mutation** — state holds an unmodifiable list, so mutate through the state manager instead of the list:

```dart
// Instead of: state.items.add(item);
context.read<CartCubit>().addItem(item);
// Note: a Cubit exposes named methods (addItem, removeItem); .add(event) is the
// BLoC event API — don't mix them.
```

## Fix Strategy

1. **Analysis errors first** — code must be error-free.
2. **Warning triage second** — fix warnings that could cause runtime bugs.
3. **pub conflicts third** — fix dependency resolution.
4. **One fix at a time** — verify each change.
5. **Minimal changes** — do not refactor, just fix.

## Stop Conditions

Stop and report if:

- The same error persists after 3 attempts.
- A fix introduces more errors.
- The fix requires architectural changes.
- Package upgrade conflicts need a user decision.

After the build is clean, run the Flutter test workflow, then Flutter code review.
