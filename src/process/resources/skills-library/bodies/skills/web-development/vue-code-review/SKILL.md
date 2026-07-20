---
name: vue-code-review
description: |
  Reviews Vue.js code for Composition API and reactivity correctness, composable patterns, template security, accessibility, and Vue-specific performance, categorizing findings by severity with concrete fixes.
  Use when a change touches .vue files or Vue-related .ts/.js, after writing components/composables/Pinia stores, or when auditing template security, router guards, or Nuxt SSR code.
  Do NOT use for pure TypeScript/JavaScript changes with no Vue imports, or for generic project-wide security audits.
license: Apache-2.0
metadata:
  author: darhai
  version: "1.0.0"
  tags: "vue code-review composition-api reactivity security"
  category: "web-development"
  depends: ""
  disclaimer: "none"
  difficulty: "advanced"
---

# Vue Code Review

Vue-specific code review covering reactivity, composables, template security, accessibility, and Vue-specific performance. On a `.vue` change, pair this with a generic TypeScript review — each owns a distinct, non-overlapping lane.

## What This Does

1. **Identify Vue changes** — find modified `.vue` files and Vue-related `.ts`/`.js` files via `git diff`.
2. **Run lint** — `eslint` with `eslint-plugin-vue`.
3. **Typecheck** — `vue-tsc --noEmit` or the project's canonical typecheck command.
4. **Review Vue lanes only** — reactivity, composables, template security, accessibility, Vue-specific performance.
5. **Report** — categorize issues by severity (CRITICAL / HIGH / MEDIUM).

## Scope

| Lane | Scope |
|---|---|
| Vue review (this skill) | Reactivity, composables, template security, a11y, Vue perf, Pinia/Router |
| Generic TS/JS review | `any` abuse, async correctness, Node security |
| Security audit | Project-wide security |

For pure `.ts`/`.js` changes with no Vue imports, use a generic code review instead.

## Review Categories

### CRITICAL (must fix)

- `v-html` with unsanitized input
- `:href`/`:src` with unvalidated user URLs (`javascript:`, `data:`)
- Secret in client bundle (`VITE_*`, Nuxt `public` runtimeConfig)
- Server endpoint without input validation (Nuxt Nitro)
- `localStorage`/`sessionStorage` for session tokens
- Destructuring reactive props in Vue < 3.5 (breaks reactivity)
- `reactive()` object replacement (breaks watchers)
- Watcher source tracking a ref object instead of `.value`

### HIGH (should fix)

- Composable with module-scope side effects
- Missing cleanup in a composable (watcher, interval, listener)
- `v-for` without `:key` or with `key={index}`
- `v-if` + `v-for` on the same element
- Props mutation
- Missing prop validation
- Route guard returning false without a redirect
- `useRoute().params` destructured at top level (snapshot)
- `v-model` bound to a computed without a setter
- Accessibility violations (missing labels, non-semantic interactive elements)
- Direct store-property mutation outside actions

### MEDIUM (consider)

- Options API in new Vue 3 code
- Component over 300 lines
- `v-show` where `v-if` is more appropriate (or vice versa)
- Missing `:max` on `<KeepAlive>`
- Missing `shallowRef` for large replaced data
- Custom validation instead of a vetted form library
- `defineExpose` exposing more than necessary
- `inheritAttrs` not disabled when using `v-bind="$attrs"`

## Automated Checks

```bash
# Lint (required)
npx eslint . --ext .vue,.ts,.js

# Vue-specific typecheck
vue-tsc --noEmit

# Targeted security rules
npx eslint . --rule 'vue/no-v-html: warn' \
              --rule 'vue/no-template-target-blank: error'

# Supply-chain
npm audit
```

If `eslint-plugin-vue` or `vue-tsc` is not configured, flag the gap as a HIGH config issue and continue.

## Example Findings

**CRITICAL — unsanitized v-html**

```vue
<script setup>
import DOMPurify from "dompurify";
const safeBio = computed(() => DOMPurify.sanitize(user.bio));
</script>
<template>
  <div v-html="safeBio" />
</template>
```

**HIGH — watcher in composable missing cleanup**

```ts
watch(userId, async (newId, _old, onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const data = await fetch(`/api/users/${newId}`, { signal: controller.signal });
  user.value = await data.json();
});
```

## Approval Criteria

| Status | Condition |
|---|---|
| Approve | No CRITICAL or HIGH issues |
| Warning | Only MEDIUM issues (merge with caution) |
| Block | CRITICAL or HIGH issues found |

## When to Use

- A PR or commit touches `.vue` files
- After writing or modifying Vue components, composables, or Pinia stores
- Auditing template security (`v-html`, URL bindings)
- Reviewing a new composable for correctness
- Auditing Vue Router guards or Nuxt server/SSR code

## Edge Cases

- **Vue version reactivity rules**: prop-destructuring safety differs before and after Vue 3.5 — check the target version.
- **Missing lint/typecheck plugins**: treat the absence as a HIGH config finding, then review manually.
- **Vue-related TS PR**: run this alongside a generic TypeScript review so findings stay non-overlapping.
