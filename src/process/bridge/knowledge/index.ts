/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges over everything the app remembers between sessions. The memory
 * archive and its promotion sweep, the wiki, deep research output and the
 * conversation store (plus the lazy file-to-SQLite migration it still needs)
 * are all persistence surfaces, and the import bridge is how foreign histories
 * enter them. They belong together because each one answers "what do we
 * already know", not "what is happening right now". The per-user record
 * features that key off the local `users` row are one level down in
 * `records/`.
 */

export * from './databaseBridge';
export * from './importBridge';
export * from './memoryArchiveBridge';
export * from './migrationUtils';
export * from './refineBridge';
export * from './researchBridge';
export * from './wikiBridge';
export * from './records';
