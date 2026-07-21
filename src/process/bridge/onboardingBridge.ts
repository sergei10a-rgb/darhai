/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcMain } from 'electron';
import { ipcBridge } from '@/common';
import { connectPastedKey } from '@process/onboarding/connectPastedKey';
import { runOnboardingDetection } from '@process/onboarding/detect';

/**
 * Register the onboarding IPC handlers. Called once from initAllBridges.
 *
 * The detection handler uses raw `ipcMain.handle` (same as `constitutionBridge`
 * / `webui-direct-*`): it is zero-argument, read-only, and returns no sensitive
 * data, so the typed allowlist buys nothing there.
 */
export function initOnboardingBridge(): void {
  ipcMain.handle('onboarding:detect', () => runOnboardingDetection());
  ipcBridge.onboarding.connectPastedKey.provider((p) => connectPastedKey(p.key));
  // Lazy: the focus inferer (and its model-bridge dependency) must stay out of
  // the boot module graph - it only runs when the user finishes onboarding.
  ipcBridge.onboarding.inferFocus.provider(async (p) => {
    const { inferFocusFromText } = await import('@process/onboarding/inferFocus');
    return inferFocusFromText(p.work);
  });
}
