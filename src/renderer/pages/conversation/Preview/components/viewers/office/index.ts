/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Office document viewers.
 *
 * `OfficeWatchViewer` owns the whole `officecli watch` child-process bridge;
 * the three exported viewers are thin `docType` wrappers over it.
 */

export { default as ExcelViewer } from './ExcelViewer';
export { default as OfficeDocViewer } from './OfficeDocViewer';
export { default as PptViewer } from './PptViewer';
