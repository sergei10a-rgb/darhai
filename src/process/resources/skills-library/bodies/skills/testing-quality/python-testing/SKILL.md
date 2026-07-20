---
name: python-testing
description: >-
  python testing conventions and rules. Use when writing or reviewing python code for testing. Use
  **pytest** as the testing framework.
license: Apache-2.0
metadata:
  author: darhai
  version: 1.0.0
  tags: python testing standards best-practices
  category: testing-quality
  difficulty: intermediate
---

# python testing

# Python Testing

> This file extends [common/testing.md](../common/testing.md) with Python specific content.

## Framework

Use **pytest** as the testing framework.

## Coverage

```bash
pytest --cov=src --cov-report=term-missing
```

## Test Organization

Use `pytest.mark` for test categorization:

```python
import pytest

@pytest.mark.unit
def test_calculate_total():
    ...

@pytest.mark.integration
def test_database_connection():
    ...
```

## Reference

See skill: `python-testing` for detailed pytest patterns and fixtures.
