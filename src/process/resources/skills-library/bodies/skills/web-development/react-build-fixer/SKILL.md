---
name: react-build-fixer
description: |
  Fixes React build failures across Vite, webpack, Next.js, CRA, Parcel, esbuild, and Bun — JSX/TSX compile errors, hydration mismatches, server/client component boundary failures, and missing types — with minimal, surgical, one-error-at-a-time changes.
  Use when a React project's build script fails, after upgrading React or a bundler, or when hydration and RSC boundary errors appear at runtime.
  Do NOT use for pure TypeScript type errors with no React involvement, or for architectural redesigns of the component boundary.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "react build vite nextjs bundler"
  category: "web-development"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# React Build Fixer

Incrementally fix React build errors with minimal changes, re-running the build after each fix.

## What This Does

1. **Detect the build system** — Vite, webpack, Next.js, CRA, Parcel, esbuild, or Bun.
2. **Run the build** — execute the project's build script.
3. **Parse errors** — group by layer (TypeScript / bundler config / runtime / hydration).
4. **Fix incrementally** — one error at a time, re-running the build after each change.
5. **Report** — show what was fixed and what remains.

## Scope

This owns React build, bundler, and runtime-hydration failures. For pure TypeScript type errors with no React involvement, use a generic build fixer instead.

## Diagnostic Commands

```bash
# Project build script (preferred)
npm run build --if-present
pnpm build 2>/dev/null
yarn build 2>/dev/null
bun run build 2>/dev/null

# Standalone typecheck
npm run typecheck --if-present
tsc --noEmit -p tsconfig.json

# Bundler-specific fallback
next build                          # Next.js
vite build                          # Vite
react-scripts build                 # CRA
webpack --mode=production           # webpack
parcel build src/index.html         # Parcel
bun build ./src/index.tsx --outdir=dist
```

## Common Errors Fixed

| Error | Typical fix |
|---|---|
| `'React' is not defined` | Set `"jsx": "react-jsx"` in tsconfig (React 17+) |
| Missing `@types/react` | `npm i -D @types/react @types/react-dom` |
| `Unexpected token '<'` | Add `@vitejs/plugin-react` or `babel-loader` |
| "You're importing a component that needs useState" (Next.js) | Add `"use client"` or move the hook into a Client Component child |
| `Module not found: Can't resolve 'fs'` (Next.js) | Remove the `fs` import or move logic into a Server Component / API route |
| "Hydration failed because the initial UI does not match" | Move `Date.now()`/`Math.random()`/`window.*` into `useEffect` |
| `Invalid hook call` | Multiple React copies — dedupe via `resolutions`/`overrides` |
| `Element type is invalid` | Default vs named import mismatch |

## Fix Strategy

1. **Compile errors first** — code must build.
2. **Hydration errors second** — they affect production correctness.
3. **Bundler config third** — restore plugin/loader correctness.
4. **One fix at a time** — verify each change by re-running the build.
5. **Minimal changes** — never suppress with `// @ts-ignore` without an explanation.

## Example Session (abridged)

```text
# React Build Resolution

## Build System Detected
Vite (vite.config.ts present, @vitejs/plugin-react in deps)

## Fix 1: Old JSX transform leftover
File: src/components/UserCard.tsx:1
Cause: tsconfig already uses "jsx": "react-jsx"; the explicit `import React` is unused.
- import React from 'react';

## Fix 2: Missing types
File: src/components/Modal.tsx
Cause: @types/react-portal not installed.
$ npm i -D @types/react-portal

## Fix 3: Missing hook import
File: src/pages/Home.tsx
- import { useEffect } from "react";
+ import { useEffect, useState } from "react";

## Result
Build successful, tests passing.
```

## Stop Conditions

Stop and report if:

- The same error persists after 3 attempts.
- A fix introduces more errors than it resolves.
- The fix requires an architectural change beyond build resolution (for example, redesigning the RSC boundary).
- The bundler version no longer supports the installed React major.

## When to Use

- `npm run build` (or the pnpm/yarn/bun equivalent) fails
- JSX/TSX compile errors after a TypeScript or React upgrade
- Next.js hydration mismatch or Server/Client boundary errors
- After installing or upgrading `react`, `react-dom`, `@types/react`, or a bundler

## Edge Cases

- **Multiple React copies**: dedupe with package-manager `resolutions`/`overrides` before touching component code.
- **Monorepo builds**: run the build from the correct workspace and check that shared packages built first.
- **CI-only failures**: compare Node and bundler versions between local and CI before editing source.
