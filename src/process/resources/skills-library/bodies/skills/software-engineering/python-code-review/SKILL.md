---
name: python-code-review
description: |
  Reviews Python code for PEP 8 compliance, type-hint coverage, security vulnerabilities, and Pythonic idioms, running static analysis and categorizing findings by severity with concrete before/after fixes.
  Use when reviewing modified or new Python files, before committing Python changes, or auditing a Python codebase for correctness, security, and idiom quality.
  Do NOT use for non-Python languages or for generic project-wide concerns unrelated to Python.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "python code-review pep8 type-hints security"
  category: "software-engineering"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# Python Code Review

Comprehensive Python-specific code review covering static analysis, security, type safety, and Pythonic idioms.

## What This Does

1. **Identify Python changes** — find modified `.py` files via `git diff`.
2. **Run static analysis** — `ruff`, `mypy`, `pylint`, `black --check`.
3. **Security scan** — SQL injection, command injection, unsafe deserialization.
4. **Type-safety review** — analyze type hints and `mypy` errors.
5. **Pythonic check** — verify PEP 8 and Python best practices.
6. **Report** — categorize issues by severity.

## Review Categories

### CRITICAL (must fix)

- SQL / command injection vulnerabilities
- Unsafe `eval`/`exec` usage
- `pickle` unsafe deserialization
- Hardcoded credentials
- YAML unsafe load
- Bare `except:` clauses hiding errors

### HIGH (should fix)

- Missing type hints on public functions
- Mutable default arguments
- Silently swallowing exceptions
- Not using context managers for resources
- C-style loops instead of comprehensions
- `type()` instead of `isinstance()`
- Race conditions without locks

### MEDIUM (consider)

- PEP 8 formatting violations
- Missing docstrings on public functions
- `print` statements instead of logging
- Inefficient string operations
- Magic numbers without named constants
- Not using f-strings for formatting
- Unnecessary list creation

## Automated Checks

```bash
# Type checking
mypy .

# Linting and formatting
ruff check .
black --check .
isort --check-only .

# Security scanning
bandit -r .

# Dependency audit
pip-audit
safety check

# Testing
pytest --cov=app --cov-report=term-missing
```

## Common Fixes

**SQL injection**

```python
# Bad
query = f"SELECT * FROM users WHERE id = {user_id}"

# Good
query = "SELECT * FROM users WHERE id = %s"
cursor.execute(query, (user_id,))
```

**Mutable default argument**

```python
# Bad
def process_items(items=[]):
    items.append("new")
    return items

# Good
def process_items(items=None):
    if items is None:
        items = []
    items.append("new")
    return items
```

**Missing type hints**

```python
# Bad
def get_user(user_id):
    return db.find(user_id)

# Good
def get_user(user_id: str) -> Optional[User]:
    return db.find(user_id)
```

**Context manager for resources**

```python
# Bad
f = open("config.json")
data = f.read()
f.close()

# Good
with open("config.json") as f:
    data = f.read()
```

**List comprehension**

```python
# Bad
result = []
for item in items:
    if item.active:
        result.append(item.name)

# Good
result = [item.name for item in items if item.active]
```

**String concatenation in loops**

```python
# Bad
result = ""
for item in items:
    result += str(item)

# Good
result = "".join(str(item) for item in items)
```

## Approval Criteria

| Status | Condition |
|--------|-----------|
| Approve | No CRITICAL or HIGH issues |
| Warning | Only MEDIUM issues (merge with caution) |
| Block | CRITICAL or HIGH issues found |

## Framework-Specific Reviews

### Django

- N+1 queries (use `select_related` / `prefetch_related`)
- Missing migrations for model changes
- Raw SQL when the ORM would work
- Missing `transaction.atomic()` for multi-step operations

### FastAPI

- CORS misconfiguration
- Pydantic models for request validation
- Correct response models
- Proper `async`/`await` usage
- Dependency-injection patterns

### Flask

- Context management (app context, request context)
- Proper error handling
- Blueprint organization
- Configuration management

## Python Version Compatibility

Flag code that requires a newer Python than the project targets:

| Feature | Minimum Python |
|---------|----------------|
| Type hints | 3.5+ |
| f-strings | 3.6+ |
| Walrus operator (`:=`) | 3.8+ |
| Position-only parameters | 3.8+ |
| Match statements | 3.10+ |
| Type unions (`x | None`) | 3.10+ |

Verify the project's `pyproject.toml` or `setup.py` declares the correct minimum version.

## When to Use

- After writing or modifying Python code
- Before committing Python changes
- Reviewing pull requests containing Python
- Onboarding to a new Python codebase

## Edge Cases

- **No static-analysis tools installed**: flag the gap as a HIGH config issue and review manually.
- **Generated or vendored code**: exclude from strict idiom checks but still scan for injected secrets.
- **Mixed-language repo**: scope the review to Python files and defer other languages to their own reviews.
