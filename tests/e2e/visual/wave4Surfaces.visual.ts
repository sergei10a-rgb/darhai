/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eyes on the wave-4 surfaces, in the real app.
 *
 * The whole wave failed review for one reason: green tests over screens that
 * could not receive data. A DOM test pushes a frame into a mounted component;
 * it cannot tell you whether the pane renders at all in the shipped build,
 * whether the Mongolian copy fits its box, or whether a new empty state reads
 * as "nothing yet" or as "broken".
 *
 * So these are not assertions about pixels. They open each surface this wave
 * touched and write a PNG that a human looks at. The only failure condition is
 * "the screen did not come up" - anything subtler is for the reviewer's eyes,
 * which is the point.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchVisualApp, closeVisualApp, stabilize, type VisualApp } from './fixture';

const OUT_DIR = path.resolve(__dirname, '..', 'screenshots', 'wave4');

let visual: VisualApp;

test.beforeAll(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  visual = await launchVisualApp();
  // Make first-run detection fail so the onboarding overlay never covers the
  // surface under review: `useOnboardingDetection` treats a rejection as "no
  // detection" and `OnboardingOverlay` renders nothing without one. Same
  // approach as modelsSettings.visual.ts.
  await visual.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('onboarding:detect');
    ipcMain.handle('onboarding:detect', () => {
      throw new Error('visual: onboarding detection disabled for this run');
    });
  });
  await visual.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
});

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
});

/** Drive the renderer's own router rather than clicking through the shell. */
async function goTo(hash: string): Promise<void> {
  await visual.page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await stabilize(visual.page);
}

async function shoot(name: string, fullPage = false): Promise<void> {
  const buffer = await visual.page.screenshot({ fullPage });
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), buffer);
  // A blank or near-blank capture means the route did not render. 20 KB is far
  // below any real screen at 1280x800 and far above an all-one-colour PNG.
  expect(buffer.byteLength, `${name} looks blank`).toBeGreaterThan(20_000);
}

test('mission control - goals tab', async () => {
  await goTo('#/mission-control');
  // The tab strip is the surface this wave added; open it rather than
  // photographing the activity tab it defaults to.
  const goals = visual.page.getByText('Зорилтууд', { exact: false }).first();
  await goals.dispatchEvent('click').catch(() => undefined);
  await stabilize(visual.page);
  await shoot('mission-control-goals', true);
});

test('settings - engine overview (capability readiness)', async () => {
  await goTo('#/settings/wcore-config');
  await shoot('settings-engine-overview', true);
});

test('settings - engine runtime (diagnostics control)', async () => {
  await goTo('#/settings/wcore-config');
  // The rail item is overlapped by a decorative grow layer, so a real click is
  // intercepted; dispatching the event the handler listens for exercises the
  // same code path without fighting the z-order.
  await visual.page
    .locator('[data-wcore-rail-id="runtime"]')
    .first()
    .dispatchEvent('click')
    .catch(() => undefined);
  await stabilize(visual.page);
  await shoot('settings-engine-runtime', true);
});

test('mcp library - installed', async () => {
  await goTo('#/settings/mcp-library/installed');
  await shoot('mcp-library-installed');
});
