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
import { ensureOnboardingComplete, resetOnboardingCache } from '../helpers/navigation';
import { invokeBridge } from '../helpers/bridge';

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

/** Pages whose Electron app has already had the onboarding cache reset. */
const onboardedPages = new WeakSet<Page>();

/**
 * Take the first-run overlay out of the way, for real.
 *
 * This used to inject `.arco-modal-wrapper, .arco-modal-mask { display: none }`.
 * That hid the overlay but left onboarding un-completed, and - because the rule
 * is global and permanent for the page - it also hid every OTHER Arco modal and
 * every composer rendered inside one, so specs that need to click those saw an
 * element that was present in the DOM and invisible on screen.
 *
 * `ensureOnboardingComplete` persists `onboardingCompleted`, walks the
 * quickstart flow, and reloads if the overlay is still mounted, so the app ends
 * up in the state a returning user actually sees. It is idempotent and cached,
 * so the repeat calls in `ensureSiderExpanded` cost nothing.
 */
export async function hideFirstRunOverlay(page: Page): Promise<void> {
  // `ensureOnboardingComplete` caches "already done" in a module-level flag,
  // which is scoped to the Playwright worker process - but every visual spec
  // launches its OWN Electron app against a fresh profile, so that flag would
  // make the second app skip onboarding and keep its overlay up. Reset it once
  // per app (tracked per page), then let the cache work normally for the
  // repeat calls inside `ensureSiderExpanded`.
  if (!onboardedPages.has(page)) {
    onboardedPages.add(page);
    resetOnboardingCache();
  }
  await ensureOnboardingComplete(page);
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
    // so make sure it is gone before reaching for the toggle. Idempotent by
    // design, and cheap after the first call: a re-mounted overlay must not be
    // able to block this and turn a real assertion into a click timeout.
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
 * The engine-backed conversation surface, open and ready to receive frames.
 *
 * WHY THIS EXISTS. Every other visual spec drives Settings or Mission Control,
 * which are reachable by a hash alone. The conversation surface is not: it
 * needs a conversation row in the database, and the wave-4 components that live
 * there (`WorkflowRunCard`, `EffectivePolicyBadge`) had therefore never been
 * rendered outside jsdom.
 *
 * No engine is started and none is needed - the components read the RENDERER
 * stream, and {@link pushResponseFrame} puts real frames on it. The model
 * reference is a placeholder because nothing here sends a turn.
 *
 * Returns the conversation id so callers can address their frames at it;
 * `useWCoreMessage` drops any frame whose `conversation_id` does not match.
 */
export async function openWCoreConversation(page: Page): Promise<string> {
  await hideFirstRunOverlay(page);
  const created = await invokeBridge<{ id?: string } | null>(page, 'create-conversation', {
    type: 'wcore',
    name: 'Visual: engine capability surface',
    model: { id: 'visual-placeholder', name: 'visual-placeholder', platform: 'wcore', useModel: 'visual-placeholder' },
    extra: { backend: 'wcore' },
  });
  const id = created?.id;
  if (!id) throw new Error('create-conversation returned no id; the conversation surface was never opened');
  await gotoHash(page, `#/conversation/${id}`);
  await page.waitForFunction((target: string) => window.location.hash.includes(target), id, { timeout: 15_000 });
  await settleFrozen(page);
  return id;
}

/**
 * Put one frame on the renderer's response stream, through the real wire.
 *
 * The main process delivers `chat.response.stream` by sending the adapter's
 * single IPC channel a `{name, data}` envelope (`common/adapter/main.ts`), and
 * the preload hands that straight to the bridge - so this is the same path
 * `WCoreManager` uses, not a stub of it. That matters: a helper that reached
 * into React state would prove the component renders, not that the frame
 * reaches it.
 */
export async function pushResponseFrame(
  app: ElectronApplication,
  frame: { type: string; data: unknown; msg_id: string; conversation_id: string }
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload: string) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send('office-ai-bridge-adapter', payload);
        }
      }
    },
    JSON.stringify({ name: 'chat.response.stream', data: frame })
  );
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
