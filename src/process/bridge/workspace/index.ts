/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges that touch the user's disk, plus the two modules that decide whether
 * a given path may be touched at all. Filesystem reads, file watching, shell
 * execution (Electron and standalone variants), project files and workspace
 * snapshots are all renderer-driven paths into the host; `pathConfinement` and
 * `userApprovedPaths` are the confinement and allowlist those paths are
 * validated against. The guards live beside their callers deliberately - a
 * reviewer looking at any write here can see the check it is supposed to pass
 * without leaving the directory.
 *
 * `shellBridgeStandalone.ts` lives here but is deliberately NOT re-exported.
 * It is the no-Electron implementation of the same shell contract and its only
 * caller is `@process/utils/initBridgeStandalone`, which the desktop path never
 * runs. Re-exporting it made the Electron main bundle load it eagerly (measured
 * with an esbuild metafile of `src/index.ts`: eager with the `export *`, absent
 * without it) for no desktop benefit. Import it by path, as that caller does.
 */

export * from './fileWatchBridge';
export * from './fsBridge';
export * from './pathConfinement';
export * from './projectBridge';
export * from './shellBridge';
export * from './userApprovedPaths';
export * from './workspaceSnapshotBridge';
