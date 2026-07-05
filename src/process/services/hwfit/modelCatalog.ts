/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local-model catalog loader.
 *
 * The catalog (data/modelCatalog.json) is a reference-only port of Odysseus'
 * hf_models.json, converted to the camelCase Darhai shape (see types.ts). It is
 * imported statically so the bundler (esbuild/vite via resolveJsonModule) packs
 * it into the app bundle — no runtime fs read, no external file dependency.
 *
 * A future "add Mongolian / discovered model" flow can merge user-supplied
 * entries (tagged `source: 'custom' | 'discovered'`) on top of this bundled set.
 */

import type { CatalogModel } from './types';
import rawCatalog from './data/modelCatalog.json';

// The JSON is validated at build time by its type; assert the imported shape.
const BUNDLED_CATALOG = rawCatalog as CatalogModel[];

/** Return the bundled local-model catalog (frozen; do not mutate). */
export function getCatalog(): readonly CatalogModel[] {
  return BUNDLED_CATALOG;
}

/** Number of models in the bundled catalog (diagnostics / tests). */
export function getCatalogSize(): number {
  return BUNDLED_CATALOG.length;
}
