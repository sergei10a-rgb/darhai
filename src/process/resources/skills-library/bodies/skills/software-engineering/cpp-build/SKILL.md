---
name: cpp-build
description: >-
  Fixes C++ build errors, CMake configuration issues, and linker problems incrementally with minimal, surgical changes.
  Use when a C++ build fails with compiler, template, include, or linker errors.
  Do NOT use for code-quality review or for languages other than C++.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "cpp build cmake compiler-errors debugging"
  category: "software-engineering"
  subcategory: "developer-tools"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# C++ Build and Fix

Act as a C++ build-resolution specialist. Incrementally fix C++ build errors with minimal, surgical changes.

## What This Skill Does

1. **Run Diagnostics**: Execute `cmake --build`, `clang-tidy`, `cppcheck`.
2. **Parse Errors**: Group by file and sort by severity.
3. **Fix Incrementally**: One error at a time.
4. **Verify Each Fix**: Re-run the build after each change.
5. **Report Summary**: Show what was fixed and what remains.

## When to Use

- `cmake --build build` fails with errors
- Linker errors (undefined references, multiple definitions)
- Template instantiation failures
- Include/dependency issues
- After pulling changes that break the build

## Diagnostic Commands

```bash
# CMake configure
cmake -B build -S .

# Build
cmake --build build 2>&1 | head -100

# Static analysis (if available)
clang-tidy src/*.cpp -- -std=c++17
cppcheck --enable=all src/
```

## Common Errors Fixed

| Error | Typical Fix |
|-------|-------------|
| `undeclared identifier` | Add `#include` or fix typo |
| `no matching function` | Fix argument types or add overload |
| `undefined reference` | Link the library or add the implementation |
| `multiple definition` | Use `inline` or move to a `.cpp` file |
| `incomplete type` | Replace a forward declaration with `#include` |
| `no member named X` | Fix the member name or include the header |
| `cannot convert X to Y` | Add an appropriate cast |
| `CMake Error` | Fix the `CMakeLists.txt` configuration |

## Fix Strategy

1. **Compilation errors first** — Code must compile.
2. **Linker errors second** — Resolve undefined references.
3. **Warnings third** — Fix with `-Wall -Wextra`.
4. **One fix at a time** — Verify each change.
5. **Minimal changes** — Do not refactor, just fix.

## Example Fixes

**Undeclared identifier** — `src/service/user.cpp:25: use of undeclared identifier 'UserRepository'` is usually a missing include:

```cpp
#include "repository/user_repository.hpp"
```

**Missing return** — a non-void function that does not return a value:

```cpp
std::optional<User> getUser(const std::string& id) {
    if (id.empty()) {
        return std::nullopt;
    }
    return findUser(id); // added missing return
}
```

After each fix, re-run `cmake --build build` and confirm the error count dropped without introducing new errors. Finish with `ctest --test-dir build --output-on-failure`.

## Stop Conditions

Stop and report if:

- The same error persists after 3 attempts.
- A fix introduces more errors than it resolves.
- The fix requires architectural changes.
- External dependencies are missing.

## Related Guidance

- Run the C++ test workflow after the build succeeds.
- Run C++ code review before committing.
