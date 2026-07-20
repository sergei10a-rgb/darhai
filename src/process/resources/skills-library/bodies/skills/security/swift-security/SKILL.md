---
name: swift-security
description: >-
  swift security conventions and rules. Use when writing or reviewing swift code for security. - Use
  **Keychain Services** for sensitive data (tokens, passwords, keys) — never `UserDefaults`
license: Apache-2.0
metadata:
  author: darhai
  version: 1.0.0
  tags: swift security standards best-practices
  category: security
  difficulty: intermediate
---

# swift security

# Swift Security

> This file extends [common/security.md](../common/security.md) with Swift specific content.

## Secret Management

- Use **Keychain Services** for sensitive data (tokens, passwords, keys) — never `UserDefaults`
- Use environment variables or `.xcconfig` files for build-time secrets
- Never hardcode secrets in source — decompilation tools extract them trivially

```swift
let apiKey = ProcessInfo.processInfo.environment["API_KEY"]
guard let apiKey, !apiKey.isEmpty else {
    fatalError("API_KEY not configured")
}
```

## Transport Security

- App Transport Security (ATS) is enforced by default — do not disable it
- Use certificate pinning for critical endpoints
- Validate all server certificates

## Input Validation

- Sanitize all user input before display to prevent injection
- Use `URL(string:)` with validation rather than force-unwrapping
- Validate data from external sources (APIs, deep links, pasteboard) before processing
