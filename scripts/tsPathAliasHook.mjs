/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Node ESM resolve hook that teaches plain `node` the project's tsconfig path
 * aliases (`@/*`, `@process/*`, `@renderer/*`, `@worker/*`).
 *
 * Node 22.18+/24 strips TypeScript types natively, so a build script can import
 * the real runtime modules instead of duplicating their logic — but the type
 * stripper does NOT read `tsconfig.json`, so an aliased import inside those
 * modules fails with `ERR_MODULE_NOT_FOUND: Cannot find package '@/common'`.
 * This hook closes exactly that gap, and nothing else: it rewrites an aliased
 * specifier to a file URL and appends the `.ts` / `.tsx` / `index.ts` extension
 * the bundler would have resolved. Everything it cannot map is handed straight
 * back to Node's default resolver.
 *
 * Registered via `module.register()` — see `scripts/generateProviderCatalog.mjs`.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** tsconfig `compilerOptions.paths`, longest prefix first so `@process/` wins over `@/`. */
const ALIASES = [
  ['@process/', path.join(APP_ROOT, 'src', 'process')],
  ['@renderer/', path.join(APP_ROOT, 'src', 'renderer')],
  ['@worker/', path.join(APP_ROOT, 'src', 'process', 'worker')],
  ['@/', path.join(APP_ROOT, 'src')],
];

/** Extensions tried, in the order the bundler resolves them. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json'];

/** Resolve an extensionless path the way a bundler would: file, then directory index. */
function withExtension(filePath) {
  if (existsSync(filePath) && statSync(filePath).isFile()) return filePath;
  for (const ext of EXTENSIONS) {
    const candidate = `${filePath}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const ext of EXTENSIONS) {
    const candidate = path.join(filePath, `index${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Map an aliased specifier onto an absolute path, or `null` when it is not aliased. */
function resolveAlias(specifier) {
  for (const [prefix, target] of ALIASES) {
    if (!specifier.startsWith(prefix)) continue;
    return withExtension(path.join(target, specifier.slice(prefix.length)));
  }
  return null;
}

/** True for a TypeScript source URL Node should type-strip as an ES module. */
function isTypeScriptModule(url) {
  return /\.(?:ts|mts|tsx)$/.test(new URL(url).pathname);
}

/**
 * Node ESM `resolve` hook.
 *
 * Aliased specifiers are mapped to a file URL; everything else falls through to
 * the default resolver. Either way a TypeScript target is tagged
 * `module-typescript` so Node type-strips it as ESM directly, instead of
 * attempting a CommonJS parse first (the project's `package.json` has no
 * `"type": "module"`, which otherwise triggers a reparse warning per file).
 */
export async function resolve(specifier, context, nextResolve) {
  const aliased = resolveAlias(specifier);
  const result = aliased
    ? { url: pathToFileURL(aliased).href, shortCircuit: true }
    : await nextResolve(specifier, context);
  if (isTypeScriptModule(result.url)) {
    return { ...result, format: 'module-typescript' };
  }
  return result;
}
