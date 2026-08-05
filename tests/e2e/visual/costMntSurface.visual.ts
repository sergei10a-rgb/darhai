/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The cost page, seen.
 *
 * Unit tests prove the formatter and the rate resolver; the dom test proves the
 * hook and formatter agree. None of them proves the page a person opens actually
 * renders two currencies, that the rate panel fits, or that Cyrillic labels and
 * a tögrög figure sit on one line without colliding. Those are questions only a
 * rendered screen answers.
 *
 * Cost data and the rate are both pinned. A real run would show whatever this
 * machine happened to spend at whatever today's rate is - which is not a
 * baseline, it is a snapshot of one afternoon.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
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
import { invokeBridge } from '../helpers/bridge';

let visual: VisualApp;

/** A fixed rate, so the rendered tögrög figures do not move between runs. */
const PINNED_MNT_PER_USD = 3580;

/**
 * Pin the rate and create a budget through the REAL providers.
 *
 * Stubbing `ipcMain.handle` was tried first and silently did nothing - the app's
 * bridge does not dispatch on those channel names - which left the page showing
 * zeroes while the test still passed. Driving the providers is both what the
 * other visual specs do and what makes this a test of the app rather than of a
 * stub: the rate goes in through `cost.setMntRateSettings`, the same call the
 * settings control makes, and the budget through `cost.upsertBudget`.
 *
 * A budget is what puts a non-zero tögrög figure on screen without inventing
 * spend: its limit is a real dollar amount the page must convert.
 */
async function pinRateAndBudget(page: Page): Promise<void> {
  // A manual rate, so the rendered tögrög figures do not depend on today's
  // exchange rate or on the machine having a network.
  await invokeBridge(page, 'cost.setMntRateSettings', { auto: false, manualMntPerUsd: PINNED_MNT_PER_USD });
  await invokeBridge(page, 'cost.upsertBudget', {
    scope: 'global',
    period: 'month',
    limitUsd: 50,
    action: 'warn',
  });
}

test.beforeAll(async () => {
  visual = await launchVisualApp();
  await pinNondeterminism(visual.page);
  await hideFirstRunOverlay(visual.page);
});

test.afterAll(async () => {
  await closeVisualApp(visual);
});

test('cost page shows spend in dollars and tögrög', async () => {
  await pinRateAndBudget(visual.page);
  await gotoHash(visual.page, '#/mission-control');
  await visual.page.getByRole('tab', { name: /Зардал/ }).click();
  await settleFrozen(visual.page);
  await stabilize(visual.page);

  // The claim under test, asserted in text before the pixels are captured: the
  // total is rendered in both currencies.
  const body = await visual.page.locator('body').innerText();
  expect(body, 'cost page should show a dollar figure').toContain('$');
  // The real claim: a NON-ZERO conversion is rendered. `0₮` would pass a bare
  // "contains ₮" check while proving nothing, which is exactly what the first
  // version of this test did.
  expect(body, 'the $50 budget limit should be converted to tögrög').toContain('179,000₮');
  // And the rate itself is stated, with its source, so the number is accountable.
  expect(body, 'the rate in use should be shown').toContain('3,580₮');

  const shot = await stableScreenshot(visual.page);
  expect(shot.length).toBeGreaterThan(0);
  await test.info().attach('cost-mnt', { body: shot, contentType: 'image/png' });
  // Also written to a stable path so a human (or a reviewer) can open the render
  // without digging through the reporter's output directory.
  const outPath = path.join(__dirname, '..', 'screenshots', 'cost-mnt.png');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, shot);
});
