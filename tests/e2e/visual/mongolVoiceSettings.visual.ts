/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eyes on the Voice settings page after the Mongolian voice core landed.
 *
 * The DOM suite proves behaviour: which providers the two Selects offer, that
 * the retired ones are gone, that the install card renders per component
 * state. What it cannot say is whether the page READS well in Mongolian: does
 * the install card's size disclosure carry the weight of a decision, do the
 * three component rows scan as one purchase, does the kitten-mn voice hint
 * fit its line at 1280px. So this writes PNGs a human looks at.
 *
 * Mechanical assertions are the free ones only: the page came up, the install
 * card discloses the download BEFORE anything is installed (that ordering is
 * the card's whole point), and the retired providers are not on screen.
 *
 * No network: on a fresh profile status() reads local receipts (none exist),
 * so every state photographed here is the honest "nothing installed" one.
 */

import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { assertBundleShowsSource, closeVisualApp, launchVisualApp, stabilize, type VisualApp } from './fixture';

const OUT_DIR = path.resolve(__dirname, '..', 'screenshots', 'mongol-voice');

/** The sources this spec claims to be photographing. */
const WATCHED = [
  'src/renderer/pages/settings/VoiceSettings/index.tsx',
  'src/renderer/pages/settings/VoiceSettings/MongolVoiceInstallCard.tsx',
  'src/renderer/pages/settings/VoiceSettings/useMongolVoice.ts',
  'src/renderer/components/settings/SettingsModal/contents/ToolsModalContent.tsx',
  'src/renderer/services/i18n/locales/mn-MN/settings.json',
];

test.describe('Mongolian voice settings: photographs', () => {
  let visual: VisualApp | null = null;

  test.beforeAll(async () => {
    assertBundleShowsSource(WATCHED);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    visual = await launchVisualApp();
    // Make first-run detection fail so the onboarding overlay never covers the
    // surface under review - same approach as wave4Surfaces.visual.ts. Eyes on
    // the first run of this spec caught exactly that: the overlay photographed
    // instead of the page.
    await visual.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('onboarding:detect');
      ipcMain.handle('onboarding:detect', () => {
        throw new Error('visual: onboarding detection disabled for this run');
      });
    });
    await visual.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await visual.page.evaluate(() => {
      window.location.hash = '#/settings/voice';
    });
    await stabilize(visual.page);
  });

  test.afterAll(async () => {
    if (visual) await closeVisualApp(visual);
    visual = null;
  });

  test('page up, install card discloses before anything is installed', async () => {
    const page = visual!.page;
    // The page rendered at all - the only hard failure this spec owns.
    await page.waitForSelector('text=Монгол дуу хоолой', { timeout: 30_000 });

    // The disclosure precedes installation: a fresh profile has no receipts,
    // so the card must show an install action with a size, not a ✓.
    const body = await page.locator('body').innerText();
    expect(body).toContain('МБ');

    // Retired providers must not be reachable anywhere on this page.
    expect(body).not.toContain('Kokoro');
    expect(body).not.toContain('kokoro');

    await page.screenshot({ path: path.join(OUT_DIR, '01-voice-settings-fresh.png'), fullPage: true });
  });

  test('text-to-speech section photographs with the kitten-mn provider', async () => {
    const page = visual!.page;
    // The page body never scrolls (the settings pane owns the scroll), so a
    // fullPage screenshot equals the viewport - eyes on the first run caught
    // that shot 02 was a duplicate of shot 01. Target the TTS section TITLE:
    // a `text=kitten-mn` locator matched the install-card row at the top of
    // the page (already in view, so nothing scrolled) - eyes caught that too.
    const ttsSection = page.locator('text=Текстийг яриа руу').first();
    await ttsSection.scrollIntoViewIfNeeded();
    await stabilize(page);
    await page.screenshot({ path: path.join(OUT_DIR, '02-voice-settings-tts.png') });
  });
});
