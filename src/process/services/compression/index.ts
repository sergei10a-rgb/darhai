/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Prompt token-compression module. Pure, dependency-free string transforms hooked
 * at the single stateless completion primitive so every background caller shrinks
 * its token cost before the provider call.
 */

export { compress } from './compress';
export type { CompressionResult } from './compress';
export { rtk, rtkLossless, stripAnsi } from './rtk';
export { caveman, cavemanModerate, applyCavemanRules } from './caveman';
export { protect, restore } from './guard';
export type { GuardedText } from './guard';
export type { CompressionMode } from '@/common/types/compression';
export { COMPRESSION_MODES, isCompressionMode } from '@/common/types/compression';
