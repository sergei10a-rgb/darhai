/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-scoped spill storage: persist an oversized tool result to a private,
 * traversal-safe, owner-only file and hand the model a bounded preview plus a
 * locator it can `read`/`grep`. See {@link spillText} for the policy and
 * {@link saveTextFile} for the file mechanics.
 */

export { spillText, SPILL_DEFAULT_MAX_INLINE_BYTES } from './spillText';
export type { SpillTextInput, SpillTextConfig, SpillTextResult } from './spillText';
export { saveTextFile, encodeSegment, sessionDir, privateRoot } from './store';
export type { SaveTextOptions, SavedText } from './store';
