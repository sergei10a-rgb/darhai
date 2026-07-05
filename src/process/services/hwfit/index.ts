/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hardware-fit model advisor service ("Загвар зөвлөмж" / Cookbook).
 *
 * Public entry point wiring the bundled catalog to the pure fit-scoring
 * pipeline and the hardware detector. The bridge layer (hwfitBridge.ts) calls
 * these; the pure algorithms live in fitScore.ts / speedModel.ts / quantTables.ts
 * and are importable directly by unit tests.
 */

import type { FitResult, HardwareProfile, RankOptions } from './types';
import { rankModels as rankModelsPure } from './fitScore';
import { getCatalog } from './modelCatalog';
import { scanHardware } from './hardwareDetect';

/** Rank the bundled catalog against a hardware profile. */
export function rankCatalog(system: HardwareProfile, options: RankOptions = {}): FitResult[] {
  return rankModelsPure(getCatalog(), system, options);
}

export { scanHardware, clearHardwareCache } from './hardwareDetect';
export { getCatalog, getCatalogSize } from './modelCatalog';
export type { CatalogModel, FitResult, HardwareProfile, RankOptions, SortKey, UseCase } from './types';
