/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Visual baselines for the onboarding screens AFTER the quickstart step
 * (`onboarding.visual.ts` owns quickstart itself).
 *
 * Every screen here is a branch the developer almost never sees: the clean-slate
 * scan result, and the three mutually exclusive `outcome` bodies. Which branch
 * renders is decided entirely by `DetectionResult`, which on a real run is a
 * function of *this machine* (installed CLIs, exported provider keys, a running
 * Ollama). A baseline captured from live detection would therefore be
 * unreproducible anywhere else, so detection is pinned to a fixed payload.
 *
 * How it is pinned: `useOnboardingDetection` calls
 * `window.electronAPI.onboardingDetect()`, which the preload forwards to the
 * main-process `onboarding:detect` IPC handler. We re-register that handler with
 * a constant payload and reload, so React's first render sees the fixed result
 * through the app's real code path. Patching the renderer object is not an
 * option: `contextBridge.exposeInMainWorld` publishes a frozen proxy, so
 * `window.electronAPI.onboardingDetect = ...` does not stick.
 *
 * NOT captured: the in-progress scan screen. Its narration line advances on a
 * 430ms interval (`OnboardingFlow.tsx:161`) and the radar is a live animation,
 * so the screen is a function of elapsed time, not of state - it can never be a
 * stable baseline. Only its settled result (`scanDone`) is captured.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DetectionResult } from '../../../src/common/types/onboarding';
import {
  launchVisualApp,
  closeVisualApp,
  stabilize,
  stableScreenshot,
  pinNondeterminism,
  type VisualApp,
} from './fixture';

let visual: VisualApp;

/** A machine with nothing at all: no CLIs, no keys, no Ollama, no agents. */
const COLD_DETECTION: DetectionResult = {
  name: 'Дархай',
  clis: [],
  agents: [],
  envKeys: [],
  claudePro: false,
  ollama: { running: false, models: [] },
};

/** A machine with a CLI agent installed but no provider key and no Ollama. */
const CLI_DETECTION: DetectionResult = {
  name: 'Дархай',
  clis: ['claude'],
  agents: [{ id: 'claude-code', kind: 'acp', name: 'Claude Code' }],
  envKeys: [],
  claudePro: false,
  ollama: { running: false, models: [] },
};

/** Button labels (mn-MN) used to walk the flow. */
const CONTINUE = 'Үргэлжлүүлэх';
const DO_LATER = 'Үүнийг дараа хийнэ';
const SKIP = 'Алгас';

/**
 * Replace the main-process `onboarding:detect` handler with a constant, then
 * reload so the overlay mounts against it from the very first render.
 */
async function useDetection(detection: DetectionResult): Promise<void> {
  await visual.app.evaluate(({ ipcMain }, fixed) => {
    ipcMain.removeHandler('onboarding:detect');
    ipcMain.handle('onboarding:detect', () => fixed);
  }, detection);
  await visual.page.reload({ waitUntil: 'domcontentloaded' });
  await expect(visual.page.getByRole('button', { name: CONTINUE })).toBeVisible({ timeout: 60_000 });
}

/** Wait until some exact copy is on screen, failing loudly with what we got. */
async function expectCopy(page: Page, needle: string): Promise<void> {
  await expect
    .poll(async () => (await page.evaluate(() => document.body.innerText)).includes(needle), { timeout: 30_000 })
    .toBe(true);
}

/** quickstart -> scan, and wait for the scan to settle (its result is stable). */
async function walkToScanResult(page: Page, settledHeadline: string): Promise<void> {
  await page.getByRole('button', { name: CONTINUE }).click();
  await expectCopy(page, settledHeadline);
}

/** quickstart -> scan -> outcome. */
async function walkToOutcome(page: Page, settledHeadline: string, outcomeCopy: string): Promise<void> {
  await walkToScanResult(page, settledHeadline);
  await page.getByRole('button', { name: CONTINUE }).click();
  await expectCopy(page, outcomeCopy);
}

test.beforeAll(async () => {
  visual = await launchVisualApp();
  await pinNondeterminism(visual.page);
  await visual.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
});

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
});

test.describe('Visual: onboarding screens', () => {
  test('scan result - clean slate', async () => {
    const { page } = visual;
    await useDetection(COLD_DETECTION);
    await walkToScanResult(page, 'Цэвэр хуудас');
    await stabilize(page);

    // Guard the premise: the clean-slate copy AND the absence of any finding
    // chip. If detection ever leaked through, we'd be baselining this machine.
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'clean-slate scan headline missing').toContain('Цэвэр хуудас');
    expect(text, 'a finding group rendered on a clean-slate scan').not.toContain('Агентууд\nClaude Code');

    expect(await stableScreenshot(page)).toMatchSnapshot('onboarding-scan-clean-slate.png');
  });

  test('outcome - Continue with Google hero (cold machine)', async () => {
    const { page } = visual;
    await useDetection(COLD_DETECTION);
    await walkToOutcome(page, 'Цэвэр хуудас', 'Google-аар үргэлжлүүлэх');
    await stabilize(page);

    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'cold outcome headline missing').toContain('Танд загвар олж өгье');
    expect(text, 'Google hero missing on the cold outcome').toContain('Google-аар үргэлжлүүлэх');

    expect(await stableScreenshot(page)).toMatchSnapshot('onboarding-outcome-cold.png');
  });

  test('outcome - detected CLI, no keys', async () => {
    const { page } = visual;
    await useDetection(CLI_DETECTION);
    await walkToOutcome(page, 'Бид юу олж танд холбосноо энд харуулъя', 'Таны хэрэгслүүд илрэгдлээ');
    await stabilize(page);

    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'cli outcome headline missing').toContain('Таны хэрэгслүүд илрэгдлээ');
    expect(text, 'the Google hero must not render on the cli outcome').not.toContain('Google-аар үргэлжлүүлэх');

    expect(await stableScreenshot(page)).toMatchSnapshot('onboarding-outcome-cli.png');
  });

  test('interests picker', async () => {
    const { page } = visual;
    await useDetection(COLD_DETECTION);
    await walkToOutcome(page, 'Цэвэр хуудас', 'Google-аар үргэлжлүүлэх');
    // The cold outcome is the only branch with a "do it later" escape hatch.
    await page.getByRole('button', { name: DO_LATER }).click();
    await expectCopy(page, 'Та юун дээр ажиллаж байна');
    await stabilize(page);

    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'interests headline missing').toContain('Та юун дээр ажиллаж байна');

    expect(await stableScreenshot(page)).toMatchSnapshot('onboarding-interests.png');
  });

  test('all set', async () => {
    const { page } = visual;
    await useDetection(COLD_DETECTION);
    await walkToOutcome(page, 'Цэвэр хуудас', 'Google-аар үргэлжлүүлэх');
    await page.getByRole('button', { name: DO_LATER }).click();
    await expectCopy(page, 'Та юун дээр ажиллаж байна');
    // Skip goes straight to `allset` without the focus-inference IPC round trip.
    await page.getByRole('button', { name: SKIP }).click();
    await expectCopy(page, 'Эхэлцгээе');
    await stabilize(page);

    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'all-set headline missing').toContain('Та бүрэн бэлэн боллоо');

    expect(await stableScreenshot(page)).toMatchSnapshot('onboarding-allset.png');
  });
});
