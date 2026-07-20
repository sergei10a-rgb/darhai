---
name: fastapi-review
description: >-
  Reviews a FastAPI application for architecture, async correctness, dependency injection, Pydantic schema design, security, performance, and testability.
  Use when reviewing FastAPI routers, dependencies, endpoints, or app structure.
  Do NOT use for non-FastAPI Python code or general framework-agnostic review.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "fastapi python code-review api async"
  category: "backend-systems"
  subcategory: "api-development"
  depends: ""
  disclaimer: "none"
  difficulty: "intermediate"
---

# FastAPI Review

Act as a FastAPI review specialist and perform a focused, FastAPI-specific review of the target file or directory.

## Review Areas

- App factory, router boundaries, middleware, and exception handlers.
- Pydantic request and response schema separation.
- Dependency injection for database sessions, auth, pagination, and settings.
- Async database and external HTTP patterns (no blocking calls in async paths).
- CORS, auth, rate limits, logging, and secret handling.
- OpenAPI metadata and documented response models.
- Test client setup and dependency overrides.

## What to Check in Detail

| Area | What to look for |
|------|------------------|
| Architecture | App created via a factory; routers grouped by resource; no business logic in route handlers |
| Schemas | Separate request vs response models; no ORM models leaking into responses; validation at the boundary |
| Dependency injection | Shared concerns (DB session, current user, pagination, settings) provided via `Depends`, not constructed inline |
| Async correctness | `async def` endpoints do not call blocking I/O; sync work offloaded appropriately |
| Security | Secrets from config not literals; auth enforced on protected routes; CORS not wildcard in production |
| Performance | No N+1 queries; pagination on list endpoints; connection pooling |
| Testability | Test client configured; dependencies overridable for tests |

## Expected Output

Report each finding in this shape:

```
[SEVERITY] Short issue title
File: path/to/file.py:42
Issue: What is wrong and why it matters.
Fix: Concrete change to make.
```

Use CRITICAL / HIGH / MEDIUM / LOW severities. Block a merge on any CRITICAL issue (for example, exposed secrets, missing auth on a protected route, or a blocking call inside an async handler that will stall the event loop).
