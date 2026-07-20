---
name: rust-tdd
description: |
  Enforces test-driven development for Rust — scaffold signatures with todo!(), write the test module first, watch it fail, implement minimal code to pass, refactor, and verify 80%+ coverage with cargo-llvm-cov.
  Use when implementing new Rust functions, methods, or traits, adding coverage to existing Rust code, or reproducing a bug with a failing test first.
  Do NOT use for non-Rust code or when the build is already broken (fix the build first).
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "rust testing tdd coverage cargo"
  category: "software-engineering"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# Rust TDD

Test-driven development for Rust using `#[test]`, `rstest`, `proptest`, and `mockall`.

## The Cycle

```
RED      -> Write a failing test first
GREEN    -> Implement minimal code to pass
REFACTOR -> Improve code; tests stay green
REPEAT   -> Next test case
```

1. **Define types/traits** — scaffold function signatures with `todo!()`.
2. **Write tests** — create a comprehensive test module. RED.
3. **Run tests** — verify they fail for the right reason (a `todo!` panic).
4. **Implement code** — write minimal code to pass. GREEN.
5. **Refactor** — improve while keeping tests green.
6. **Check coverage** — ensure 80%+ with `cargo-llvm-cov`.

## Test Patterns

**Unit tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_two_numbers() {
        assert_eq!(add(2, 3), 5);
    }

    #[test]
    fn handles_error() -> Result<(), Box<dyn std::error::Error>> {
        let result = parse_config(r#"port = 8080"#)?;
        assert_eq!(result.port, 8080);
        Ok(())
    }
}
```

**Parameterized tests with rstest**

```rust
use rstest::rstest;

#[rstest]
#[case("hello", 5)]
#[case("", 0)]
#[case("rust", 4)]
fn test_string_length(#[case] input: &str, #[case] expected: usize) {
    assert_eq!(input.len(), expected);
}
```

**Async tests**

```rust
#[tokio::test]
async fn fetches_data_successfully() {
    let client = TestClient::new().await;
    let result = client.get("/data").await;
    assert!(result.is_ok());
}
```

**Property-based tests**

```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn encode_decode_roundtrip(input in ".*") {
        let encoded = encode(&input);
        let decoded = decode(&encoded).unwrap();
        assert_eq!(input, decoded);
    }
}
```

## Coverage Commands

```bash
cargo llvm-cov                        # Summary report
cargo llvm-cov --html                 # HTML report
cargo llvm-cov --fail-under-lines 80  # Fail below threshold
cargo test test_name                  # Run a specific test
cargo test -- --nocapture             # Run with output
cargo test --no-fail-fast             # Run without stopping on first failure
```

## Coverage Targets

| Code type | Target |
|-----------|--------|
| Critical business logic | 100% |
| Public API | 90%+ |
| General code | 80%+ |
| Generated / FFI bindings | Exclude |

## Best Practices

**Do:**

- Write the test FIRST, before any implementation
- Run tests after each change
- Prefer `assert_eq!` over `assert!` for better failure messages
- Use `?` in tests that return `Result` for cleaner output
- Test behavior, not implementation
- Include edge cases (empty, boundary, error paths)

**Don't:**

- Write implementation before tests
- Skip the RED phase
- Use `#[should_panic]` when `Result::is_err()` works
- Use `sleep()` in tests — use channels or `tokio::time::pause()`
- Mock everything — prefer integration tests when feasible

## When to Use

- Implementing new Rust functions, methods, or traits
- Adding test coverage to existing Rust code
- Fixing bugs (write a failing test first)
- Building critical business logic

## Edge Cases

- **FFI or generated bindings**: exclude from coverage targets rather than writing hollow tests.
- **Async timing**: use `tokio::time::pause()` instead of real sleeps to keep tests deterministic.
- **Panics vs errors**: prefer `Result`-returning tests over `#[should_panic]` when the API returns `Result`.
