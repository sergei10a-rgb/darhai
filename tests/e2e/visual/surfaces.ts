/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared navigation and window helpers for the Mongolian layout/contrast specs.
 *
 * These specs measure the DOM rather than compare pixels, and some of them
 * deliberately run at non-baseline window sizes, so they cannot use
 * `fixture.stabilize()` (it asserts a 1280px viewport). The pieces that still
 * apply - settle, then freeze motion - are composed here instead.
 */
import type { ElectronApplication, Page } from 'playwright';
import { freezeMotion, waitForSettle } from './fixture';

/** Narrow sizes Mongolian button pairs must still survive. */
export const NARROW_VIEWPORTS = [
  { width: 900, height: 700 },
  { width: 760, height: 700 },
] as const;

/**
 * Settle the DOM and kill motion, without asserting the baseline viewport.
 * The trailing pause mirrors `stabilize()`: freezing motion snaps in-flight
 * transitions to their end state, which is itself a layout change.
 */
export async function settleFrozen(page: Page): Promise<void> {
  await waitForSettle(page);
  await freezeMotion(page);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/** Resize the real Electron window; the fixture pins it non-resizable. */
export async function setContentSize(app: ElectronApplication, size: { width: number; height: number }): Promise<void> {
  await app.evaluate(({ BrowserWindow }, target: { width: number; height: number }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (!win) return;
    win.setResizable(true);
    win.setContentSize(target.width, target.height);
  }, size);
}

/**
 * Take the first-run overlay out of the way.
 *
 * The overlay is an Arco `Modal` with `closable`, `maskClosable` and
 * `escToExit` all false (`OnboardingOverlay.tsx:70`), and its dismissal is
 * React state behind a multi-step flow, so there is no stable "close" affordance
 * to click. Its `visible` flag also lives in a component we must not modify.
 * Hiding the modal layer leaves the real application mounted and laid out
 * underneath - which is what these specs need to measure - without pretending
 * onboarding was completed.
 */
export async function hideFirstRunOverlay(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '.arco-modal-wrapper, .arco-modal-mask { display: none !important; }',
  });
}

/**
 * The sider collapse toggle. Scoped by class on purpose: the window controls
 * carry the same Mongolian `aria-label` ("Хураах" = minimise), and clicking
 * those would minimise the whole app mid-suite.
 */
export const SIDER_TOGGLE = 'button.app-titlebar__button:not(.app-titlebar__button--nav)';

/**
 * Put the settings rail back in its expanded state.
 *
 * Collapse is sticky across navigation, so a spec that collapses the rail would
 * otherwise leave every later test measuring an empty rail - which looks like a
 * clean pass but proves nothing.
 */
export async function ensureSiderExpanded(page: Page): Promise<void> {
  const isCollapsed = (): Promise<boolean> =>
    page.evaluate(() => document.querySelector('.settings-sider--collapsed') !== null);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await isCollapsed())) return;
    // The first-run overlay swallows pointer events across the whole window,
    // so re-hide it before reaching for the toggle. Idempotent by design: the
    // page is never reloaded, but a re-mounted overlay must not be able to
    // block this and turn a real assertion into a click timeout.
    await hideFirstRunOverlay(page);
    await page.locator(SIDER_TOGGLE).first().click({ timeout: 10_000 });
    await settleFrozen(page);
  }
  throw new Error('settings sider stayed collapsed after 3 toggle attempts');
}

/** Navigate the hash router without needing a clickable target. */
export async function gotoHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((target: string) => {
    window.location.hash = target;
  }, hash);
  await settleFrozen(page);
}

/**
 * Inject CSS, run an assertion against the mutated page, then remove it.
 * Used by the mutation self-tests that prove these detectors can still fail.
 */
export async function withInjectedCss<T>(page: Page, css: string, run: () => Promise<T>): Promise<T> {
  const style = await page.addStyleTag({ content: css });
  try {
    await settleFrozen(page);
    return await run();
  } finally {
    await style.evaluate((el) => (el as Element).remove());
    await settleFrozen(page);
  }
}
