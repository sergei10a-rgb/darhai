/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capture spec for the Doctor settings panel, the cost circuit-breaker
 * panel, and the memory entry editor modal. Beyond the screenshots it
 * writes for human review, it proves three real flows end to end: the
 * Doctor battery runs and renders results, the breaker panel mounts on
 * the cost tab, and editing a memory entry surfaces the `---` separator
 * warning before a save could corrupt the store.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  closeVisualApp,
  launchVisualApp,
  pinNondeterminism,
  stabilize,
  stableScreenshot,
  type VisualApp,
} from './fixture';
import { gotoHash, hideFirstRunOverlay, settleFrozen } from './surfaces';
import { resetOnboardingCache } from '../helpers/navigation';
import { invokeBridge } from '../helpers/bridge';

const OUT_DIR = path.resolve(__dirname, '..', 'screenshots', 'wave5');

let visual: VisualApp;

test.beforeAll(async () => {
  visual = await launchVisualApp();
  await pinNondeterminism(visual.page);
  await hideFirstRunOverlay(visual.page);
  // The overlay can mount AFTER the first check (it consults the config on
  // mount, which may predate the completed-flag write) - give it time to
  // appear, then walk it away for real.
  await visual.page.waitForTimeout(2_000);
  resetOnboardingCache();
  await hideFirstRunOverlay(visual.page);
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

test.afterAll(async () => {
  await closeVisualApp(visual);
});

async function snap(name: string): Promise<void> {
  await settleFrozen(visual.page);
  await stabilize(visual.page);
  const shot = await stableScreenshot(visual.page);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), shot);
}

test('doctor settings panel - initial and after a run', async () => {
  await gotoHash(visual.page, '#/settings/doctor');
  await expect(visual.page.getByTestId('doctor-settings-panel')).toBeVisible();
  await snap('doctor-settings-initial');

  await visual.page.getByTestId('doctor-run-button').click();
  await visual.page.locator('[data-testid^="doctor-result-"]').first().waitFor({ timeout: 60_000 });
  await snap('doctor-settings-results');
});

test('cost circuit-breaker panel on the mission-control cost tab', async () => {
  await invokeBridge(visual.page, 'cost.setMntRateSettings', { auto: false, manualMntPerUsd: 3580 });
  await gotoHash(visual.page, '#/mission-control');
  await visual.page.getByRole('tab', { name: /Зардал/ }).click();
  const panel = visual.page.getByTestId('circuit-breaker-panel');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  await snap('circuit-breaker-panel');
});

test('memory entry editor modal, including the --- separator warning', async () => {
  const saved = await invokeBridge<{ ok: boolean }>(
    visual.page,
    'memory.set-quick-add',
    { content: 'WAVE5-VISUAL Дархайн санах ойн засварын цонхыг нүдээр шалгах бичлэг.', scope: 'global' },
    30_000
  );
  expect(saved.ok).toBe(true);

  await gotoHash(visual.page, '#/memory');
  const row = visual.page.locator('[data-testid^="memory-row-"]').first();
  await row.waitFor({ timeout: 30_000 });
  await row.click();
  await expect(visual.page.getByTestId('right-drawer')).toBeVisible();
  await snap('memory-right-drawer');

  await visual.page.getByTestId('drawer-edit-btn').click();
  await expect(visual.page.getByTestId('entry-editor-modal')).toBeVisible();
  await snap('memory-entry-editor');

  const body = visual.page.getByTestId('entry-editor-body').locator('textarea');
  const target = (await body.count()) > 0 ? body : visual.page.getByTestId('entry-editor-body');
  await target.fill('Дээд мөр\n---\nДоод мөр');
  await expect(visual.page.getByTestId('entry-editor-body-separator-warn')).toBeVisible();
  await snap('memory-entry-editor-warn');
});
