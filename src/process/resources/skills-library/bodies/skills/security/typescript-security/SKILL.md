---
name: typescript-security
description: >-
  typescript security conventions and rules. Use when writing or reviewing typescript code for
  security. // NEVER: Hardcoded secrets
license: Apache-2.0
metadata:
  author: darhai
  version: 1.0.0
  tags: typescript security standards best-practices
  category: security
  difficulty: intermediate
---

# typescript security

# TypeScript/JavaScript Security

> This file extends [common/security.md](../common/security.md) with TypeScript/JavaScript specific content.

## Secret Management

```typescript
// NEVER: Hardcoded secrets
const apiKey = "sk-proj-xxxxx"

// ALWAYS: Environment variables
const apiKey = process.env.API_KEY

if (!apiKey) {
  throw new Error('API_KEY not configured')
}
```

## Agent Support

- Use **security-reviewer** skill for comprehensive security audits
