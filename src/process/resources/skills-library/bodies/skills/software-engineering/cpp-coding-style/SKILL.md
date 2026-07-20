---
name: cpp-coding-style
description: >-
  cpp coding style conventions and rules. Use when writing or reviewing cpp code for coding style. -
  Prefer **modern C++ features** over C-style constructs
license: Apache-2.0
metadata:
  author: darhai
  version: 1.0.0
  tags: cpp coding-style standards best-practices
  category: software-engineering
  difficulty: intermediate
---

# cpp coding style

# C++ Coding Style

> This file extends [common/coding-style.md](../common/coding-style.md) with C++ specific content.

## Modern C++ (C++17/20/23)

- Prefer **modern C++ features** over C-style constructs
- Use `auto` when the type is obvious from context
- Use `constexpr` for compile-time constants
- Use structured bindings: `auto [key, value] = map_entry;`

## Resource Management

- **RAII everywhere** — no manual `new`/`delete`
- Use `std::unique_ptr` for exclusive ownership
- Use `std::shared_ptr` only when shared ownership is truly needed
- Use `std::make_unique` / `std::make_shared` over raw `new`

## Naming Conventions

- Types/Classes: `PascalCase`
- Functions/Methods: `snake_case` or `camelCase` (follow project convention)
- Constants: `kPascalCase` or `UPPER_SNAKE_CASE`
- Namespaces: `lowercase`
- Member variables: `snake_case_` (trailing underscore) or `m_` prefix

## Formatting

- Use **clang-format** — no style debates
- Run `clang-format -i <file>` before committing

## Reference

See skill: `cpp-coding-standards` for comprehensive C++ coding standards and guidelines.
