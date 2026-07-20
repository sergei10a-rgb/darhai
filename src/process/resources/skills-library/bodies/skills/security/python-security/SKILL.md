---
name: python-security
description: >-
  python security conventions and rules. Use when writing or reviewing python code for security.
  import os
license: Apache-2.0
metadata:
  author: darhai
  version: 1.0.0
  tags: python security standards best-practices
  category: security
  difficulty: intermediate
---

# python security

# Python Security

> This file extends [common/security.md](../common/security.md) with Python specific content.

## Secret Management

```python
import os
from dotenv import load_dotenv

load_dotenv()

api_key = os.environ["OPENAI_API_KEY"]  # Raises KeyError if missing
```

## Security Scanning

- Use **bandit** for static security analysis:
  ```bash
  bandit -r src/
  ```

## Reference

See skill: `django-security` for Django-specific security guidelines (if applicable).
