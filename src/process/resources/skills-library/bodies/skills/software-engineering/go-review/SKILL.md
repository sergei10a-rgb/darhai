---
name: go-review
description: >-
  Reviews Go changes for idiomatic patterns, concurrency safety, error handling, and security, categorizing findings by severity.
  Use when Go code has been written or modified and needs review before commit.
  Do NOT use for build-error fixing or non-Go code.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "go code-review concurrency error-handling security"
  category: "software-engineering"
  subcategory: "developer-tools"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# Go Code Review

Act as a Go review specialist and perform a comprehensive, Go-specific code review.

## What This Skill Does

1. **Identify Go Changes**: Find modified `.go` files via `git diff`.
2. **Run Static Analysis**: Execute `go vet`, `staticcheck`, and `golangci-lint`.
3. **Security Scan**: Check for SQL injection, command injection, race conditions.
4. **Concurrency Review**: Analyze goroutine safety, channel usage, mutex patterns.
5. **Idiomatic Go Check**: Verify code follows Go conventions and best practices.
6. **Generate Report**: Categorize issues by severity.

## When to Use

- After writing or modifying Go code
- Before committing Go changes
- Reviewing pull requests with Go code
- Onboarding to a new Go codebase
- Learning idiomatic Go patterns

## Review Categories

### CRITICAL (Must Fix)
- SQL/command injection vulnerabilities
- Race conditions without synchronization
- Goroutine leaks
- Hardcoded credentials
- Unsafe pointer usage
- Ignored errors in critical paths

### HIGH (Should Fix)
- Missing error wrapping with context
- Panic instead of error returns
- Context not propagated
- Unbuffered channels causing deadlocks
- Interface-not-satisfied errors
- Missing mutex protection

### MEDIUM (Consider)
- Non-idiomatic code patterns
- Missing godoc comments on exports
- Inefficient string concatenation
- Slice not preallocated
- Table-driven tests not used

## Automated Checks

```bash
# Static analysis
go vet ./...

# Advanced checks (if installed)
staticcheck ./...
golangci-lint run

# Race detection
go build -race ./...

# Security vulnerabilities
govulncheck ./...
```

## Example Findings

**[CRITICAL] Race condition** — a shared map accessed without synchronization:

```go
var cache = map[string]*Session{}
func GetSession(id string) *Session { return cache[id] } // race
```
Fix with `sync.RWMutex` (or `sync.Map`):
```go
var (
    cache   = map[string]*Session{}
    cacheMu sync.RWMutex
)
func GetSession(id string) *Session {
    cacheMu.RLock()
    defer cacheMu.RUnlock()
    return cache[id]
}
```

**[HIGH] Missing error context** — wrap errors instead of returning them bare:

```go
return fmt.Errorf("get user %s: %w", userID, err)
```

## Approval Criteria

| Status | Condition |
|--------|-----------|
| Approve | No CRITICAL or HIGH issues |
| Warning | Only MEDIUM issues (merge with caution) |
| Block | CRITICAL or HIGH issues found |

Report each finding with severity, file and line, the problem, and a concrete fix. Block the merge until CRITICAL issues are resolved.
