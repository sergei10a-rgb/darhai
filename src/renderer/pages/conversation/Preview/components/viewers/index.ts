/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Viewer components exports
 *
 * Read-only preview components for displaying various file types, grouped by
 * how they actually render:
 *
 * - `text/`   - source text through SyntaxHighlighter + SelectionToolbar
 * - `office/` - the `officecli watch` bridge family (Word/Excel/PowerPoint)
 * - `web/`    - live web content inside an embedded frame
 * - `media/`  - binary assets read off disk and shown natively
 */

export * from './text';
export * from './office';
export * from './web';
export * from './media';
