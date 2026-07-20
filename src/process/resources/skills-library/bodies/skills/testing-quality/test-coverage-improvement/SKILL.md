---
name: test-coverage-improvement
description: |
  Analyzes test coverage, identifies the least-covered files and untested branches, and generates the missing tests needed to reach an 80%+ coverage target, verifying the suite stays green after each addition.
  Use when the user wants to raise test coverage, close coverage gaps, or add tests for under-covered files across JS/TS, Python, Rust, Java, or Go projects.
  Do NOT use for designing a test strategy from scratch, end-to-end flow authoring, or when the goal is fixing failing tests rather than adding coverage.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "testing coverage quality unit-tests gaps"
  category: "testing-quality"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Test Coverage Improvement

Analyze test coverage, identify gaps, and generate missing tests to reach 80%+ coverage.

## Step 1: Detect the Test Framework

| Indicator | Coverage command |
|-----------|-----------------|
| `jest.config.*` or `package.json` jest | `npx jest --coverage --coverageReporters=json-summary` |
| `vitest.config.*` | `npx vitest run --coverage` |
| `pytest.ini` / `pyproject.toml` pytest | `pytest --cov=src --cov-report=json` |
| `Cargo.toml` | `cargo llvm-cov --json` |
| `pom.xml` with JaCoCo | `mvn test jacoco:report` |
| `go.mod` | `go test -coverprofile=coverage.out ./...` |

## Step 2: Analyze the Coverage Report

1. Run the coverage command.
2. Parse the output (JSON summary or terminal output).
3. List files **below 80% coverage**, sorted worst-first.
4. For each under-covered file, identify:
   - Untested functions or methods
   - Missing branch coverage (if/else, switch, error paths)
   - Dead code that inflates the denominator

## Step 3: Generate Missing Tests

For each under-covered file, generate tests in priority order:

1. **Happy path** — core functionality with valid inputs
2. **Error handling** — invalid inputs, missing data, network failures
3. **Edge cases** — empty arrays, null/undefined, boundary values (0, -1, MAX_INT)
4. **Branch coverage** — each if/else, switch case, ternary

### Test Generation Rules

- Place tests adjacent to source: `foo.ts` -> `foo.test.ts` (or the project convention)
- Use the project's existing test patterns (import style, assertion library, mocking approach)
- Mock external dependencies (database, APIs, file system)
- Keep each test independent — no shared mutable state
- Name tests descriptively: `test_create_user_with_duplicate_email_returns_409`

## Step 4: Verify

1. Run the full test suite — all tests must pass.
2. Re-run coverage — verify improvement.
3. If still below 80%, repeat Step 3 for the remaining gaps.

## Step 5: Report

```
Coverage Report
------------------------------
File                     Before  After
src/services/auth.ts     45%     88%
src/utils/validation.ts  32%     82%
------------------------------
Overall:                 67%     84%
```

## Focus Areas

- Functions with complex branching (high cyclomatic complexity)
- Error handlers and catch blocks
- Utility functions used across the codebase
- API endpoint handlers (request -> response flow)
- Edge cases: null, undefined, empty string, empty array, zero, negative numbers

## When to Use

- Raising a project below its coverage threshold
- Closing gaps flagged by CI coverage gates
- Adding tests to legacy modules before refactoring them

## Edge Cases

- **Inflated denominator**: dead code lowers the ratio; remove it rather than writing tests for unreachable branches.
- **Hard-to-reach branches**: some paths need dependency injection or mocking to exercise — refactor for testability if needed.
- **Pages / UI shells**: defer to end-to-end coverage instead of forcing brittle unit tests.
