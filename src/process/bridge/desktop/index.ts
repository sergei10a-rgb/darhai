/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridges over the desktop shell the app is wrapped in rather than over
 * anything the agent does: application lifecycle and start-on-boot, native
 * dialogs and notifications, system settings, the auto-updater, window frame
 * controls and the always-on ambient bubble. These are the surfaces that would
 * disappear entirely in a headless deployment - `applicationBridgeCore` is
 * split out precisely because it is the platform-agnostic remainder that
 * standalone server mode still needs.
 *
 * `feedbackBridge.ts` lives here but is deliberately NOT re-exported: it
 * registers `feedback:collect-logs` on `ipcMain` at module load and exports
 * nothing, so it is imported for its side effect exactly once from
 * `src/index.ts`. Re-exporting it would pull that registration into every
 * consumer of this barrel.
 *
 * Headroom: this directory is at the 10-child cap - eight re-exported bridges,
 * `feedbackBridge` and this barrel - so it has none. The next desktop-shell
 * bridge opens a subdirectory (window/chrome versus OS integration is the
 * obvious seam) rather than landing beside these.
 */

export * from './ambientBridge';
export * from './applicationBridge';
export * from './applicationBridgeCore';
export * from './dialogBridge';
export * from './notificationBridge';
export * from './systemSettingsBridge';
export * from './updateBridge';
export * from './windowControlsBridge';
