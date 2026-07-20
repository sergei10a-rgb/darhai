---
name: go-build
description: >-
  Fixes Go build errors, `go vet` warnings, and linter issues incrementally with minimal, surgical changes.
  Use when `go build`, `go vet`, or a Go linter reports problems.
  Do NOT use for code-quality review or non-Go code.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "go build compiler-errors debugging static-analysis"
  category: "software-engineering"
  subcategory: "developer-tools"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# Go Build and Fix

Act as a Go build-resolution specialist. Incrementally fix Go build errors with minimal changes.

## What This Skill Does

1. **Run Diagnostics**: Execute `go build`, `go vet`, `staticcheck`.
2. **Parse Errors**: Group by file and sort by severity.
3. **Fix Incrementally**: One error at a time.
4. **Verify Each Fix**: Re-run the build after each change.
5. **Report Summary**: Show what was fixed and what remains.

## When to Use

- `go build ./...` fails with errors
- `go vet ./...` reports issues
- `golangci-lint run` shows warnings
- Module dependencies are broken
- After pulling changes that break the build

## Diagnostic Commands

```bash
# Primary build check
go build ./...

# Static analysis
go vet ./...

# Extended linting (if available)
staticcheck ./...
golangci-lint run

# Module issues
go mod verify
go mod tidy -v
```

## Common Errors Fixed

| Error | Typical Fix |
|-------|-------------|
| `undefined: X` | Add the import or fix the typo |
| `cannot use X as Y` | Type conversion or fix the assignment |
| `missing return` | Add the return statement |
| `X does not implement Y` | Add the missing method |
| `import cycle` | Restructure packages |
| `declared but not used` | Remove or use the variable |
| `cannot find package` | `go get` or `go mod tidy` |

## Example Fixes

**Type mismatch** — a string used where an int is required:

```go
countStr := params.Get("count")
count, _ := strconv.Atoi(countStr)
```

**Missing return** — add the missing return at the end of a function:

```go
func GetUser(id string) (*User, error) {
    if id == "" {
        return nil, ErrInvalidID
    }
    return findUser(id), nil // added
}
```

## Fix Strategy

1. **Build errors first** — code must compile.
2. **Vet warnings second** — fix suspicious constructs.
3. **Lint warnings third** — style and best practices.
4. **One fix at a time** — verify each change.
5. **Minimal changes** — do not refactor, just fix.

## Stop Conditions

Stop and report if:

- The same error persists after 3 attempts.
- A fix introduces more errors.
- The fix requires architectural changes.
- External dependencies are missing.

After the build is clean, run the Go test workflow, then Go code review. Finish with `go vet ./...` and `go test ./...`.
