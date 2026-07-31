/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Visual baselines for the first-run onboarding overlay.
 *
 * This is the screen a brand-new user meets, so it is the one most worth
 * guarding and the one least likely to be looked at during development. On a
 * fresh profile the overlay opens by itself once environment detection
 * resolves (`OnboardingOverlay.tsx:62`).
 *
 * Also serves as the determinism gate for the whole visual suite: the app is
 * launched cold against an isolated profile, so a pass on a second run means
 * screenshots reproduce across processes and profiles, not merely within one
 * session.
 */
import { test, expect } from '@playwright/test';
import {
  launchVisualApp,
  closeVisualApp,
  stabilize,
  stableScreenshot,
  pinNondeterminism,
  type VisualApp,
} from './fixture';

let visual: VisualApp;

test.beforeAll(async () => {
  visual = await launchVisualApp();
  // Pin clock + PRNG, then reload so React's first render already sees them.
  await pinNondeterminism(visual.page);
  await visual.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
});

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
});

test.describe('Visual: onboarding (fresh profile)', () => {
  test('quickstart step matches baseline', async () => {
    const { page } = visual;
    await stabilize(page);

    // Guard the premise: if the overlay silently stopped opening on a fresh
    // profile, a screenshot would still pass against a re-recorded baseline.
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'onboarding overlay did not open on a fresh profile').toContain('Дархай');

    const shot = await stableScreenshot(page);
    expect(shot).toMatchSnapshot('onboarding-quickstart.png');
  });

  test('shows Mongolian copy, not raw i18n keys', async () => {
    const text = await visual.page.evaluate(() => document.body.innerText);

    // A missing translation surfaces as the dotted key path itself; asserting
    // on it gives a readable failure instead of an opaque pixel diff.
    const rawKeys = text.match(/\b[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*){2,}\b/g) ?? [];
    const suspicious = rawKeys.filter((k) => !k.includes('/') && !k.includes(':'));
    expect(suspicious, `untranslated i18n keys visible on screen: ${suspicious.join(', ')}`).toHaveLength(0);

    // Mongolian-specific letters must render as text, proving the locale loaded
    // and that Ө/Ү survive the whole pipeline.
    expect(/[ӨөҮү]/.test(text), 'no Ө/Ү found - locale may not have loaded').toBe(true);
  });
});
