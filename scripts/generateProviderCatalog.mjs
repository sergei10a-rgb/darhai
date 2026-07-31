/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * generateProviderCatalog.mjs
 *
 * Build-time generator for `src/process/providers/catalog/data/providerCatalog.generated.json`
 * — the bundled, curated provider catalog the desktop ships.
 *
 * Behaviour:
 *  - Reads the engine catalog (`providers.toml`) from the sibling waylandcore
 *    repo IF present, else falls back to the vendored snapshot committed next to
 *    the output so the build never hard-depends on `../waylandcore`.
 *  - Parses with `smol-toml`, runs every row through the SAME T0.2 curation
 *    (`isCatalogEligible`) the runtime uses, keeps only eligible rows, and
 *    normalizes each via `normalizeCatalogEntry` (snake_case -> camelCase).
 *  - Writes a DETERMINISTIC JSON (entries sorted by id, stable key order) so a
 *    re-run produces a byte-identical file — the snapshot test depends on this.
 *  - Prints a breakdown of how many rows were excluded and why.
 *
 * Reuses the real runtime modules (Node 22.18+/24 strips the TypeScript types
 * natively) so the generator can never drift from the curation the app ships.
 * The type stripper does not read `tsconfig.json`, so the project's path
 * aliases are supplied by `scripts/tsPathAliasHook.mjs` — registered BEFORE the
 * runtime modules are pulled in, which is why they are imported dynamically.
 *
 * Usage:
 *   node scripts/generateProviderCatalog.mjs
 *   bun run providers:catalog
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';

register('./tsPathAliasHook.mjs', import.meta.url);

const { normalizeCatalogEntry } = await import('../src/process/providers/catalog/catalogProvider.ts');
const { isCatalogEligible } = await import('../src/process/providers/catalog/catalogCuration.ts');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_ROOT = path.resolve(__dirname, '..');
const CATALOG_REL = path.join('crates', 'wcore-config', 'src', 'data', 'providers.toml');

/**
 * Candidate live-engine catalog locations (preferred source of truth), tried in
 * order. The sibling waylandcore repo sits next to either the app repo or its
 * parent container directory, so both are probed before the vendored fallback.
 */
const ENGINE_CANDIDATES = [
  path.resolve(APP_ROOT, '..', 'waylandcore', CATALOG_REL),
  path.resolve(APP_ROOT, '..', '..', 'waylandcore', CATALOG_REL),
];

const DATA_DIR = path.join(APP_ROOT, 'src', 'process', 'providers', 'catalog', 'data');
/** Committed fallback used when the sibling waylandcore repo is absent. */
const VENDORED_TOML = path.join(DATA_DIR, 'providers.vendored.toml');
const OUTPUT_JSON = path.join(DATA_DIR, 'providerCatalog.generated.json');

/** Pick the live engine file if present, otherwise the vendored snapshot. */
function resolveSource() {
  for (const tomlPath of ENGINE_CANDIDATES) {
    if (existsSync(tomlPath)) return { tomlPath, source: 'engine' };
  }
  if (existsSync(VENDORED_TOML)) return { tomlPath: VENDORED_TOML, source: 'vendored' };
  const looked = [...ENGINE_CANDIDATES, VENDORED_TOML].join(', ');
  throw new Error(`No provider catalog found. Looked for: ${looked}.`);
}

/** Re-serialize one normalized entry with a fixed key order (determinism). */
function stableEntry(entry) {
  /** @type {Record<string, string>} */
  const out = {
    id: entry.id,
    displayName: entry.displayName,
    baseUrl: entry.baseUrl,
    envVar: entry.envVar,
  };
  // Preserve the absent-vs-empty distinction: only emit apiPath when present.
  if (entry.apiPath !== undefined) out.apiPath = entry.apiPath;
  return out;
}

function main() {
  const { tomlPath, source } = resolveSource();
  const raw = parse(readFileSync(tomlPath, 'utf8'));
  const providers = Array.isArray(raw.provider) ? raw.provider : [];

  if (providers.length === 0) {
    throw new Error(`Parsed 0 [[provider]] entries from ${tomlPath} — refusing to write an empty catalog.`);
  }

  /** @type {Record<string, number>} */
  const excluded = {};
  const eligible = [];

  for (const entry of providers) {
    const verdict = isCatalogEligible(entry);
    if (verdict.eligible) {
      eligible.push(normalizeCatalogEntry(entry));
    } else {
      excluded[verdict.reason] = (excluded[verdict.reason] ?? 0) + 1;
    }
  }

  // Deterministic ordering: sort by id, then stabilize each entry's key order.
  eligible.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const output = eligible.map(stableEntry);

  // Trailing newline keeps the file POSIX-clean and matches other generated JSON.
  const json = `${JSON.stringify(output, null, 2)}\n`;
  writeIfChanged(OUTPUT_JSON, json);

  const excludedTotal = Object.values(excluded).reduce((sum, n) => sum + n, 0);
  console.log(`[generateProviderCatalog] source: ${source} (${tomlPath})`);
  console.log(`[generateProviderCatalog] parsed ${providers.length} entries`);
  console.log(`[generateProviderCatalog] eligible ${eligible.length}, excluded ${excludedTotal}`);
  for (const reason of Object.keys(excluded).sort()) {
    console.log(`[generateProviderCatalog]   - ${reason}: ${excluded[reason]}`);
  }
  console.log(`[generateProviderCatalog] wrote ${OUTPUT_JSON}`);
}

/** Write only when content differs so re-runs are byte-stable and idempotent. */
function writeIfChanged(filePath, content) {
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === content) return;
  writeFileSync(filePath, content);
}

main();
