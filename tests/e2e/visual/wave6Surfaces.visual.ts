/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Capture spec for the two harness-assimilation surfaces wired this wave: the
 * subscription-OAuth card on the Models settings page (its disclosure gate, and
 * the Login buttons enabling once the gate is acknowledged) and the /refine
 * rules card on the IJFW settings page. Writes screenshots for a human to review
 * and proves the gate toggle actually enables the provider Login controls.
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

const OUT_DIR = path.resolve(__dirname, '..', 'screenshots', 'wave6');

let visual: VisualApp;

test.beforeAll(async () => {
  visual = await launchVisualApp();
  await pinNondeterminism(visual.page);
  await hideFirstRunOverlay(visual.page);
  // The overlay can mount after the first check; walk it away for real.
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

test('subscription-OAuth card: gated by default, Login enables after acknowledge', async () => {
  await gotoHash(visual.page, '#/settings/models');
  const card = visual.page.getByTestId('subscription-oauth-card');
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await snap('subscription-oauth-gated');

  // A provider Login button is disabled while the gate is closed.
  const login = visual.page.locator('[data-testid^="subscription-login-"]').first();
  await expect(login).toBeDisabled();

  // Acknowledging the disclosure opens the gate; Login becomes enabled.
  await visual.page.getByTestId('subscription-ack').click();
  await expect(login).toBeEnabled();
  await snap('subscription-oauth-acknowledged');
});

test('refine rules card renders on the IJFW settings page', async () => {
  await gotoHash(visual.page, '#/settings/ijfw');
  const card = visual.page.getByTestId('refine-rules-card');
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible();
  await snap('refine-rules-card');
});
