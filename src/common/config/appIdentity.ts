/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Windows Application User Model ID.
 *
 * Windows groups taskbar buttons, jump lists and toast notifications by this
 * ID - NOT by executable path. Without `app.setAppUserModelId`, Windows falls
 * back to the host process identity: in development the taskbar shows
 * electron.exe's own icon instead of Darhai's anvil, and toast notifications
 * are attributed to "Electron" (or suppressed entirely) even in a packaged
 * install, because the installer registers a shortcut under this ID and the
 * running process never claims it.
 *
 * MUST stay byte-identical to `appId` in `electron-builder.yml` - the
 * installer writes the shortcut under that exact string, and a mismatch
 * silently breaks notifications in packaged builds. `appIdentity.test.ts`
 * reads the YAML and fails on any drift.
 */
export const DARHAI_APP_USER_MODEL_ID = 'mn.darhai.app';
