---
name: python-coding-style
description: >-
  python coding style conventions and rules. Use when writing or reviewing python code for coding
  style. - Follow **PEP 8** conventions
license: Apache-2.0
metadata:
  author: darhai
  version: 1.0.0
  tags: python coding-style standards best-practices
  category: software-engineering
  difficulty: intermediate
---

# python coding style

# Python Coding Style

> This file extends [common/coding-style.md](../common/coding-style.md) with Python specific content.

## Standards

- Follow **PEP 8** conventions
- Use **type annotations** on all function signatures

## Immutability

Prefer immutable data structures:

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class User:
    name: str
    email: str

from typing import NamedTuple

class Point(NamedTuple):
    x: float
    y: float
```

## Formatting

- **black** for code formatting
- **isort** for import sorting
- **ruff** for linting

## Reference

See skill: `python-patterns` for comprehensive Python idioms and patterns.
