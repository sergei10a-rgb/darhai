/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Redirect main-process console output to electron-log so that all
 * console.log / console.warn / console.error calls are persisted to
 * daily log files on disk.
 *
 * Log file location (managed by electron-log, named after productName `Darhai`):
 *   - macOS:   ~/Library/Logs/Darhai/YYYY-MM-DD.log
 *   - Windows: %USERPROFILE%\AppData\Roaming\Darhai\logs\YYYY-MM-DD.log
 *   - Linux:   ~/.config/Darhai/logs/YYYY-MM-DD.log
 *
 * Users can share the relevant date's file for debugging (#1157) - which is
 * precisely why every line is filtered through {@link redactLogData} first.
 * Two call sites forward bytes this app never chose: the engine's whole stderr
 * stream, and the full text of any event line that failed to parse. Either can
 * carry an API key or the contents of a file a tool just read, and a shared log
 * makes that public.
 *
 * Must be imported as early as possible in the main process entry point,
 * BEFORE any other module emits console output.
 */

import log from 'electron-log/main';
import { redactLogData } from './logRedaction';

// Daily log file: e.g. 2026-03-12.log
const today = new Date().toISOString().slice(0, 10);
log.transports.file.fileName = `${today}.log`;

// Persist info-level and above to file; keep all levels in terminal stdout.
log.transports.file.level = 'info';
log.transports.console.level = 'silly';

// Cap each daily log file at 10 MB.
log.transports.file.maxSize = 10 * 1024 * 1024;

// Strip credentials before ANY transport sees the line.
//
// Registered on the hook chain rather than on the file transport alone: the
// terminal is copy-pasted into issues as readily as the file is attached to
// them, so redacting one and not the other would just move the leak. The hook
// runs once per transport; redaction is idempotent, so a second pass over an
// already-clean line is a no-op.
log.hooks.push((message) => {
  message.data = redactLogData(message.data);
  return message;
});

// Patch global console so every console.log/warn/error from any module
// goes through electron-log (and thus to the file transport).
log.initialize();

// log.initialize() only patches the renderer via preload.
// Explicitly redirect main-process console to electron-log.
Object.assign(console, log.functions);
