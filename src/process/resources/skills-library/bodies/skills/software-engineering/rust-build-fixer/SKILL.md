---
name: rust-build-fixer
description: |
  Fixes Rust build errors, borrow-checker and lifetime issues, and Cargo dependency problems incrementally, verifying each change with cargo check before moving on and making minimal, surgical edits.
  Use when cargo build or cargo check fails, clippy reports warnings, borrow-checker errors block compilation, or dependency resolution fails.
  Do NOT use for architectural redesigns of data ownership or for non-Rust build systems.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "rust cargo build borrow-checker clippy"
  category: "software-engineering"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# Rust Build Fixer

Incrementally fix Rust build errors with minimal changes, re-running `cargo check` after each fix.

## What This Does

1. **Run diagnostics** — `cargo check`, `cargo clippy`, `cargo fmt --check`.
2. **Parse errors** — identify error codes and affected files.
3. **Fix incrementally** — one error at a time.
4. **Verify each fix** — re-run `cargo check` after each change.
5. **Report** — show what was fixed and what remains.

## Diagnostic Commands

```bash
# Primary build check
cargo check 2>&1

# Lints and suggestions
cargo clippy -- -D warnings 2>&1

# Formatting check
cargo fmt --check 2>&1

# Dependency issues
cargo tree --duplicates

# Security audit (if available)
if command -v cargo-audit >/dev/null; then cargo audit; else echo "cargo-audit not installed"; fi
```

## Common Errors Fixed

| Error | Typical fix |
|-------|-------------|
| `cannot borrow as mutable` | Restructure to end the immutable borrow first; clone only if justified |
| `does not live long enough` | Use an owned type or add a lifetime annotation |
| `cannot move out of` | Restructure to take ownership; clone only as a last resort |
| `mismatched types` | Add `.into()`, `as`, or an explicit conversion |
| `trait X not implemented` | Add `#[derive(Trait)]` or implement manually |
| `unresolved import` | Add the crate to `Cargo.toml` or fix the `use` path |
| `cannot find value` | Add the import or fix the path |

## Fix Strategy

1. **Build errors first** — code must compile.
2. **Clippy warnings second** — fix suspicious constructs.
3. **Formatting third** — `cargo fmt` compliance.
4. **One fix at a time** — verify each change.
5. **Minimal changes** — don't refactor, just fix.

## Example Session (abridged)

```text
# Rust Build Resolution

$ cargo check
error[E0502]: cannot borrow `map` as mutable because it is also borrowed as immutable
error[E0308]: mismatched types
error[E0425]: cannot find value `db` in this scope

## Fix 1: E0502 — restructure to end the immutable borrow before the mutable insert
if !map.contains_key("key") {
    map.insert("key".into(), default);
}

## Fix 2: E0308 — parse the string into the expected numeric type
let count: usize = params.get("count").and_then(|s| s.parse().ok()).unwrap_or(0);

## Fix 3: E0425 — add the missing import
use crate::db;

## Result
Build successful; clippy clean; tests passing.
```

## Stop Conditions

Stop and report if:

- The same error persists after 3 attempts.
- A fix introduces more errors.
- The fix requires architectural changes.
- A borrow-checker error requires redesigning data ownership.

## When to Use

- `cargo build` or `cargo check` fails with errors
- `cargo clippy` reports warnings
- Borrow-checker or lifetime errors block compilation
- Cargo dependency resolution fails
- After pulling changes that break the build

## Edge Cases

- **Clone-to-silence-the-borrow-checker**: prefer restructuring the borrow over an unjustified `.clone()`.
- **Duplicate transitive dependencies**: use `cargo tree --duplicates` before pinning versions.
- **Ownership redesign needed**: escalate rather than patching around a fundamental data-flow problem.
