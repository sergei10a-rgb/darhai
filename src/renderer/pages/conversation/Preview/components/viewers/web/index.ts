/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Web-surface viewers.
 *
 * Both hand their content to an embedded browser frame: `HTMLViewer` serializes
 * markup into a Blob-URL iframe, `URLViewer` points a `WebviewHost` at a URL.
 */

export { default as HTMLViewer } from './HTMLViewer';
export { default as URLViewer } from './URLViewer';
