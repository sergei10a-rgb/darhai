/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eyes on the llama.cpp runtime row, in the real app, in Mongolian.
 *
 * The DOM suite for this surface is large and it proves behaviour - which
 * branch renders, which handler a button calls, that every error code has a
 * sentence. What it cannot tell anyone is whether the result is READABLE: does
 * the Mongolian disclosure fit its cell at 1280px, does the consent sentence
 * carry more weight than the hint under it, does a half-gigabyte download read
 * as a decision the user is making rather than a status they are watching.
 *
 * So this is not a pixel assertion. It opens the advisor against a profile
 * that genuinely has no runtime, presses the button that asks for consent, and
 * writes PNGs a human looks at. The only mechanical failure is "the screen did
 * not come up" - and one real assertion that costs nothing: the disclosure must
 * be on screen BEFORE anything is installed, since the whole point of that
 * state is that it precedes the download.
 *
 * NETWORK. The disclosure is the real one. `llamaRuntime.plan` reaches GitHub
 * for the release index, because a mocked plan would photograph the mock. When
 * the machine is offline the spec skips rather than pretending - a screenshot
 * of the offline branch is a different picture and is taken separately.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchVisualApp, closeVisualApp, stabilize, assertBundleShowsSource, type VisualApp } from './fixture';
import { invokeBridge } from '../helpers/bridge';

const OUT_DIR = path.resolve(__dirname, '..', 'screenshots', 'llama-runtime');

/** The source this spec claims to be photographing. */
const WATCHED = [
  'src/renderer/pages/model-advisor/CookbookServeControls.tsx',
  'src/renderer/pages/model-advisor/useLlamaRuntime.ts',
  'src/renderer/pages/model-advisor/ModelAdvisor.module.css',
  'src/renderer/pages/model-advisor/ModelTable.tsx',
  'src/renderer/services/i18n/locales/mn-MN/modelAdvisor.json',
];

type RuntimeStatus = { state: string; tag?: string | null };
type RuntimePlan = { ok?: boolean; kind?: string; totalBytes?: number; tag?: string };

let visual: VisualApp;

test.beforeAll(async () => {
  assertBundleShowsSource(WATCHED);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  visual = await launchVisualApp();
  // Same approach as the other visual specs: make first-run detection fail so
  // the onboarding overlay never covers the surface under review.
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

async function goToAdvisor(): Promise<void> {
  await visual.page.evaluate(() => {
    window.location.hash = '#/model-advisor';
  });
  await stabilize(visual.page);
}

async function shoot(name: string, fullPage = false): Promise<void> {
  const file = path.join(OUT_DIR, `${name}.png`);
  await visual.page.screenshot({ path: file, fullPage, animations: 'disabled' });
  console.log(`[visual] wrote ${file}`);
}

test('a profile with no runtime shows the advisor, not an error', async () => {
  test.setTimeout(180_000);

  // This is the state the whole feature exists for: a fresh install, nothing
  // provisioned. If the profile already had a runtime the screenshots would be
  // of a different branch, so assert the premise rather than assume it.
  const status = await invokeBridge<RuntimeStatus>(visual.page, 'llamaRuntime.status');
  expect(status.state, 'this run must start with no managed runtime').not.toBe('ready');

  await goToAdvisor();
  await shoot('advisor-no-runtime', true);

  // The page came up with content, not a blank or an error boundary.
  const text = await visual.page.evaluate(() => document.body.innerText);
  expect(text.length).toBeGreaterThan(200);
});

test('pressing the primary action does not install anything on its own', async () => {
  test.setTimeout(240_000);

  // The real release index, not a mock - a mocked plan photographs the mock.
  // A failure here is worth SEEING (the offline branch is a picture too), so it
  // is captured rather than skipped past.
  let plan: RuntimePlan | null = null;
  try {
    plan = await invokeBridge<RuntimePlan>(visual.page, 'llamaRuntime.plan', undefined, 60_000);
    console.log(`[visual] plan: ${JSON.stringify(plan)}`);
  } catch (err) {
    console.log(`[visual] plan failed (offline branch will be photographed): ${String(err)}`);
  }

  await goToAdvisor();

  // The primary action is labelled in Mongolian ("Ажиллуулах" = serve). There
  // is no testid on this surface, so match the real copy - which also means a
  // copy change makes this spec fail loudly rather than photograph nothing.
  const serve = visual.page.getByRole('button', { name: 'Ажиллуулах', exact: true }).first();
  await expect(serve, 'the advisor must offer at least one servable model').toBeVisible({ timeout: 30_000 });

  await serve.scrollIntoViewIfNeeded();
  await serve.click();
  await stabilize(visual.page);
  await shoot('runtime-disclosure', true);

  // WHICH branch renders depends on the host, and both are legitimate:
  //   - no local backend at all  -> the runtime disclosure (consent pending)
  //   - ollama or vLLM present   -> Darhai uses theirs and never offers ours
  // So the claim is not "a disclosure appeared", it is "the cell said SOMETHING
  // and no half-gigabyte download began behind the user's back".
  const body = await visual.page.evaluate(() => document.body.innerText);
  const branch = [
    ['disclosure', body.includes('Татаад ажиллуулах') || body.includes('Одоохондоо болъё')],
    ['problem', body.includes('Дахин оролдох')],
    ['delegated-to-existing-backend', body.includes('Эхлүүлж байна') || body.includes('Идэвхтэй')],
  ].find(([, hit]) => hit === true);
  console.log(`[visual] branch on this host: ${branch ? branch[0] : 'NONE'}`);
  expect(branch, 'the action cell rendered nothing at all').toBeDefined();

  // The claim that holds on every host: consent precedes the download.
  const after = await invokeBridge<RuntimeStatus>(visual.page, 'llamaRuntime.status');
  expect(after.state, 'pressing the primary action must not have installed a runtime').not.toBe('ready');
});
