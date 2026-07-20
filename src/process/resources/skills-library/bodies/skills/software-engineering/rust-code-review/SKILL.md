---
name: rust-code-review
description: |
  Reviews Rust code for ownership and lifetime correctness, error handling, unsafe usage, and idiomatic patterns, gating on cargo check/clippy/fmt/test and categorizing findings by severity with concrete fixes.
  Use after writing or modifying Rust code, before committing Rust changes, or when reviewing a pull request that contains Rust.
  Do NOT use for non-Rust languages or for generic project-wide concerns unrelated to Rust.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "rust code-review ownership clippy security"
  category: "software-engineering"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# Rust Code Review

Comprehensive Rust-specific code review covering ownership, lifetimes, error handling, unsafe usage, and idiomatic patterns.

## What This Does

1. **Verify automated checks** — run `cargo check`, `cargo clippy -- -D warnings`, `cargo fmt --check`, and `cargo test`; stop if any fail.
2. **Identify Rust changes** — find modified `.rs` files via `git diff HEAD~1` (or `git diff main...HEAD` for PRs).
3. **Run a security audit** — `cargo audit` if available.
4. **Security scan** — unsafe usage, command injection, hardcoded secrets.
5. **Ownership review** — unnecessary clones, lifetime issues, borrowing patterns.
6. **Report** — categorize issues by severity.

## Review Categories

### CRITICAL (must fix)

- Unchecked `unwrap()`/`expect()` in production code paths
- `unsafe` without a `// SAFETY:` comment documenting invariants
- SQL injection via string interpolation in queries
- Command injection via unvalidated input in `std::process::Command`
- Hardcoded credentials
- Use-after-free via raw pointers

### HIGH (should fix)

- Unnecessary `.clone()` to satisfy the borrow checker
- `String` parameter where `&str` or `impl AsRef<str>` suffices
- Blocking in async context (`std::thread::sleep`, `std::fs`)
- Missing `Send`/`Sync` bounds on shared types
- Wildcard `_ =>` match on business-critical enums
- Large functions (>50 lines)

### MEDIUM (consider)

- Unnecessary allocation in hot paths
- Missing `with_capacity` when the size is known
- Suppressed clippy warnings without justification
- Public API without `///` documentation
- Missing `#[must_use]` where ignoring the return value is likely a bug

## Automated Checks

```bash
# Build gate (must pass before review)
cargo check

# Lints and suggestions
cargo clippy -- -D warnings

# Formatting
cargo fmt --check

# Tests
cargo test

# Security audit (if available)
if command -v cargo-audit >/dev/null; then cargo audit; else echo "cargo-audit not installed"; fi
```

## Example Findings

**CRITICAL — unchecked unwrap in a production path**

```rust
// Bad: panics on missing user
let user = db.find_by_id(id).unwrap();

// Good: propagate with context
let user = db.find_by_id(id).context("failed to fetch user")?;
```

**HIGH — unnecessary clone**

```rust
// Bad
let name = user.name.clone();
process(&user, &name);

// Good: restructure to avoid the clone
let result = process_name(&user.name);
use_user(&user, result);
```

## Approval Criteria

| Status | Condition |
|--------|-----------|
| Approve | No CRITICAL or HIGH issues |
| Warning | Only MEDIUM issues (merge with caution) |
| Block | CRITICAL or HIGH issues found |

## When to Use

- After writing or modifying Rust code
- Before committing Rust changes
- Reviewing pull requests with Rust code
- Onboarding to a new Rust codebase

## Edge Cases

- **`cargo-audit` not installed**: note the gap and continue with the manual security scan.
- **Justified `unwrap()`**: acceptable in tests, build scripts, or after a proven invariant with a comment — flag only unprotected production paths.
- **Documented `unsafe`**: a correct `// SAFETY:` block downgrades the finding; missing documentation keeps it CRITICAL.
