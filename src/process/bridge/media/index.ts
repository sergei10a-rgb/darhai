/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges that turn a file into something the renderer can show. Document
 * conversion produces the target format; the PPT and Word/Excel watchers each
 * spawn an `officecli` child on its own port for the renderer to load in a
 * webview, which is why the shared installer for that binary sits beside them;
 * preview history is the record of what was previewed. The unifying job is
 * rendering, not file access - reading or writing the file itself is
 * `workspace/`. Spoken media has its own lifecycle (models, assets, streaming)
 * and lives in `voice/`.
 */

export * from './documentBridge';
export * from './officecliInstaller';
export * from './officeWatchBridge';
export * from './pptPreviewBridge';
export * from './previewHistoryBridge';
export * from './voice';
