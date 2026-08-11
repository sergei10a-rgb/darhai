/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Binary-asset viewers.
 *
 * Both take a `filePath`/`content` pair, pull the bytes over `ipcBridge`, and
 * render them with a native surface rather than parsing the content themselves.
 */

export { default as ImageViewer } from './ImageViewer';
export { default as PDFViewer } from './PDFViewer';
