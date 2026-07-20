---
name: golang-testing
description: >-
  golang testing conventions and rules. Use when writing or reviewing golang code for testing. Use
  the standard `go test` with **table-driven tests**.
license: Apache-2.0
metadata:
  author: darhai
  version: 1.0.0
  tags: golang testing standards best-practices
  category: testing-quality
  difficulty: intermediate
---

# golang testing

# Go Testing

> This file extends [common/testing.md](../common/testing.md) with Go specific content.

## Framework

Use the standard `go test` with **table-driven tests**.

## Race Detection

Always run with the `-race` flag:

```bash
go test -race ./...
```

## Coverage

```bash
go test -cover ./...
```

## Reference

See skill: `golang-testing` for detailed Go testing patterns and helpers.
