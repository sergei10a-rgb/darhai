/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Source-text viewers.
 *
 * All three render textual content in-process through `react-syntax-highlighter`
 * and share the `SelectionToolbar` / `useTextSelection` reply affordance.
 */

export { default as CodeViewer } from './CodeViewer';
export { default as DiffViewer } from './DiffViewer';
export { default as MarkdownViewer } from './MarkdownViewer';
