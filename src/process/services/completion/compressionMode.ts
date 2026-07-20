/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read/write the persisted prompt-compression mode. Single source of truth for
 * both the completion hook (`oneShotComplete`) and the Settings bridge, mirroring
 * the ECC GateGuard accessor pair (`isGateGuardEnabled` / `setGateGuardEnabled`).
 *
 * Default (absent config) is `lite` - a LOSSLESS formatting normalization that is
 * a safe immediate cost win. Reads are tolerant of a not-yet-ready store: any
 * failure or unrecognized value degrades to `lite`.
 */

import type { CompressionMode } from '@/common/types/compression';
import { isCompressionMode } from '@/common/types/compression';
import { ProcessConfig } from '@process/utils/initStorage';

/** The safe default applied when no mode is configured. */
export const DEFAULT_COMPRESSION_MODE: CompressionMode = 'lite';

/** Current compression mode from config, defaulting to `lite` on any failure. */
export async function getCompressionMode(): Promise<CompressionMode> {
  try {
    const value = (await ProcessConfig.get('compression.mode')) as unknown;
    return isCompressionMode(value) ? value : DEFAULT_COMPRESSION_MODE;
  } catch {
    return DEFAULT_COMPRESSION_MODE;
  }
}

/** Persist the compression mode. Unrecognized input is coerced to the default. */
export async function setCompressionMode(mode: CompressionMode): Promise<void> {
  const safe = isCompressionMode(mode) ? mode : DEFAULT_COMPRESSION_MODE;
  await ProcessConfig.set('compression.mode', safe);
}
