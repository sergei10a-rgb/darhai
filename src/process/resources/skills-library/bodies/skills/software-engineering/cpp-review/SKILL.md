---
name: cpp-review
description: >-
  Reviews C++ changes for memory safety, modern C++ idioms, concurrency correctness, and security, categorizing findings by severity.
  Use when C++ code has been written or modified and needs review before commit or merge.
  Do NOT use for build-error fixing or non-C++ code.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "cpp code-review memory-safety concurrency security"
  category: "software-engineering"
  subcategory: "developer-tools"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# C++ Code Review

Act as a C++ review specialist and perform a comprehensive, C++-specific code review.

## What This Skill Does

1. **Identify C++ Changes**: Find modified `.cpp`, `.hpp`, `.cc`, `.h` files via `git diff`.
2. **Run Static Analysis**: Execute `clang-tidy` and `cppcheck`.
3. **Memory Safety Scan**: Check for raw `new`/`delete`, buffer overflows, use-after-free.
4. **Concurrency Review**: Analyze thread safety, mutex usage, data races.
5. **Modern C++ Check**: Verify code follows C++17/20 conventions and best practices.
6. **Generate Report**: Categorize issues by severity.

## When to Use

- After writing or modifying C++ code
- Before committing C++ changes
- Reviewing pull requests with C++ code
- Onboarding to a new C++ codebase
- Checking for memory safety issues

## Review Categories

### CRITICAL (Must Fix)
- Raw `new`/`delete` without RAII
- Buffer overflows and use-after-free
- Data races without synchronization
- Command injection via `system()`
- Uninitialized variable reads
- Null pointer dereferences

### HIGH (Should Fix)
- Rule of Five violations
- Missing `std::lock_guard` / `std::scoped_lock`
- Detached threads without proper lifetime management
- C-style casts instead of `static_cast` / `dynamic_cast`
- Missing `const` correctness

### MEDIUM (Consider)
- Unnecessary copies (pass by value instead of `const&`)
- Missing `reserve()` on known-size containers
- `using namespace std;` in headers
- Missing `[[nodiscard]]` on important return values
- Overly complex template metaprogramming

## Automated Checks

```bash
# Static analysis
clang-tidy --checks='*,-llvmlibc-*' src/*.cpp -- -std=c++17

# Additional analysis
cppcheck --enable=all --suppress=missingIncludeSystem src/

# Build with warnings
cmake --build build -- -Wall -Wextra -Wpedantic
```

## Example Findings

**[CRITICAL] Memory leak** — raw `new` without a matching `delete`:

```cpp
auto* session = new Session(userId);  // leak
cache[userId] = session;
```
Fix with `std::unique_ptr`:
```cpp
auto session = std::make_unique<Session>(userId);
cache[userId] = std::move(session);
```

**[HIGH] Missing const reference** — a large object passed by value:

```cpp
void processUser(User user) {          // unnecessary copy
void processUser(const User& user) {   // fix
```

## Approval Criteria

| Status | Condition |
|--------|-----------|
| Approve | No CRITICAL or HIGH issues |
| Warning | Only MEDIUM issues (merge with caution) |
| Block | CRITICAL or HIGH issues found |

Report each finding with severity, file and line, the problem, and a concrete fix. Block the merge until CRITICAL issues are resolved.
