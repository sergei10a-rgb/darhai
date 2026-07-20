---
name: golang-security
description: >-
  golang security conventions and rules. Use when writing or reviewing golang code for security.
  apiKey := os.Getenv("OPENAI_API_KEY")
license: Apache-2.0
metadata:
  author: darhai
  version: 1.0.0
  tags: golang security standards best-practices
  category: security
  difficulty: intermediate
---

# golang security

# Go Security

> This file extends [common/security.md](../common/security.md) with Go specific content.

## Secret Management

```go
apiKey := os.Getenv("OPENAI_API_KEY")
if apiKey == "" {
    log.Fatal("OPENAI_API_KEY not configured")
}
```

## Security Scanning

- Use **gosec** for static security analysis:
  ```bash
  gosec ./...
  ```

## Context & Timeouts

Always use `context.Context` for timeout control:

```go
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
```
