---
name: react-code-review
description: |
  Reviews React/JSX code for hook correctness, render performance, server/client component boundaries, accessibility, and React-specific security, categorizing findings by severity with concrete fixes.
  Use when a change touches .tsx/.jsx files, after writing components or custom hooks, before merging React code, or when auditing a Next.js App Router server/client boundary.
  Do NOT use for pure TypeScript/JavaScript changes with no React imports, or for generic project-wide security audits.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "react code-review hooks accessibility security"
  category: "web-development"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# React Code Review

React-specific code review covering hook rules, RSC boundaries, accessibility, render performance, and React-specific security. On a TSX/JSX change, pair this with a generic TypeScript review — each owns a distinct, non-overlapping lane.

## What This Does

1. **Identify React changes** — find modified `.tsx`/`.jsx` files (and React-containing `.ts`/`.js` files) via `git diff`.
2. **Run lint** — `eslint` with `eslint-plugin-react-hooks` and `eslint-plugin-jsx-a11y`.
3. **Typecheck** — `tsc --noEmit` or the project's canonical typecheck command.
4. **Review React lanes only** — hook rules, RSC boundaries, accessibility, render performance, React-specific security.
5. **Report** — categorize issues by severity (CRITICAL / HIGH / MEDIUM).

## Scope

| Lane | Scope |
|---|---|
| React review (this skill) | Hook rules, JSX, RSC, a11y, React-specific security, render perf |
| Generic TS/JS review | `any` abuse, async correctness, Node security |
| Security audit | Project-wide security |

For pure `.ts`/`.js` changes with no React imports, use a generic code review instead.

## Review Categories

### CRITICAL (must fix)

- `dangerouslySetInnerHTML` with unsanitized input
- `href`/`src` with unvalidated user URLs (`javascript:`, `data:`)
- Server Action without input validation
- Secret in client bundle (`NEXT_PUBLIC_*`, `VITE_*`, `REACT_APP_*`)
- `localStorage`/`sessionStorage` for session tokens
- Conditional hook calls (violates Rules of Hooks)
- Direct state mutation
- Hook called outside a component or custom hook

### HIGH (should fix)

- Missing `useEffect`/`useMemo`/`useCallback` deps (disabled `exhaustive-deps` without justification)
- Effect used for derived state
- Effect missing cleanup
- Stale closures in handlers/intervals
- Server-only imports in Client Components
- Sensitive data leaked via props to Client Components
- Server Actions without auth checks
- Accessibility violations (missing labels, non-semantic interactive elements, ARIA misuse)
- `key={index}` in dynamic lists
- Duplicated state, `useEffect` chains

### MEDIUM (consider)

- Over-memoization without a measured win
- Inline new object/function as a prop to a memoized child
- Suspense at route root only (no progressive reveal)
- Long lists without virtualization
- High-frequency value via `useContext`
- Roll-your-own validation in non-trivial forms
- Prop drilling beyond 3 levels
- Component over 200 lines
- Class components in new code

## Automated Checks

```bash
# Lint (required for a meaningful review)
npx eslint . --ext .tsx,.jsx,.ts,.js

# Typecheck (skip cleanly for JS-only projects)
npm run typecheck --if-present
[ -f tsconfig.json ] && tsc --noEmit -p tsconfig.json

# Targeted a11y rules
npx eslint . --rule 'jsx-a11y/alt-text: error' \
              --rule 'jsx-a11y/anchor-is-valid: error' \
              --rule 'jsx-a11y/click-events-have-key-events: error'

# Supply-chain
npm audit
```

If `eslint-plugin-react-hooks` or `eslint-plugin-jsx-a11y` is not configured, flag the gap as a HIGH config issue and continue.

## Example Findings

**CRITICAL — unsanitized dangerouslySetInnerHTML**

```tsx
import DOMPurify from "isomorphic-dompurify";
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(user.bio) }} />
```

**HIGH — effect cleanup missing**

```ts
useEffect(() => {
  const ac = new AbortController();
  fetch(`/api/users/${id}`, { signal: ac.signal })
    .then(r => r.json())
    .then(setUser);
  return () => ac.abort();
}, [id]);
```

## Approval Criteria

| Status | Condition |
|---|---|
| Approve | No CRITICAL or HIGH issues |
| Warning | Only MEDIUM issues (merge with caution) |
| Block | CRITICAL or HIGH issues found |

## When to Use

- A PR or commit touches `.tsx`/`.jsx` files
- After writing or modifying React components, custom hooks, or pages
- Auditing accessibility on UI components
- Reviewing a new hook for rules-of-hooks and dependency correctness
- Auditing a Next.js App Router server/client component boundary

## Edge Cases

- **JS-only project**: skip the typecheck lane cleanly and lean on lint plus manual review.
- **Missing a11y/hooks lint plugins**: treat the absence as a HIGH config finding, then review manually.
- **TSX PR**: run this alongside a generic TypeScript review so findings stay non-overlapping.
