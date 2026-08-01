/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Visual baselines for `#/settings/models` - the page's own loading / empty /
 * error states, and every runtime state of the OmniRoute gateway card that
 * lives on it.
 *
 * Both surfaces are here because they share one hard requirement: the page must
 * be a pure function of stubbed data. On a real machine this page renders live
 * registry results (this dev box shows a connected Ollama with three models and
 * a discovered Gemini key), so an unstubbed baseline would encode *this laptop*.
 * The OmniRoute card is affected too even though it is captured as an element:
 * its own height is fractional (746.55px), so a one-pixel shift in the content
 * above it flips the screenshot clip between 747px and 748px tall - observed as
 * a real cross-run failure before the page above it was pinned.
 *
 * Two stub seams are used, both outside the renderer, because
 * `contextBridge.exposeInMainWorld` publishes `electronAPI` as a frozen proxy -
 * neither the preload methods nor the bridge emitter can be patched from page
 * context:
 *
 *  1. **Providers** (`modelRegistry.*`): the renderer invokes them as
 *     `subscribe-<key>` over the single `office-ai-bridge-adapter` IPC channel
 *     and waits for `subscribe.callback-<key><id>` to come back
 *     (@office-ai/platform). We wrap that one main-process handler and answer
 *     the stubbed keys ourselves, passing everything else through untouched.
 *  2. **Emitter events** (`omniroute-gateway.on-runtime-status`): main publishes
 *     these by sending `<key>` on the same channel (`adapter/main.ts:74`), so we
 *     send the identical frame and the card is driven through its real
 *     subscription path.
 */
import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { OmnirouteInstallProgress, OmnirouteRuntimeStatus } from '../../../src/common/types/omnirouteGateway';
import {
  launchVisualApp,
  closeVisualApp,
  stabilize,
  stableScreenshot,
  pinNondeterminism,
  type VisualApp,
} from './fixture';

let visual: VisualApp;

const CARD = '[data-testid="omniroute-gateway-card"]';
/** The one-click install/run block inside the card - the runtime-driven region. */
const AUTOINSTALL = '[data-testid="omniroute-gateway-autoinstall"]';
const MODELS_ROUTE = '#/settings/models';

/** Sentinel stub value meaning "accept the call and never answer it". */
const NEVER_RESOLVES = '__visual_never_resolves__';

/** Provider stubs that make the page render its empty state, deterministically. */
const EMPTY_PAGE_STUBS: Record<string, unknown> = {
  'modelRegistry.list': [],
  'modelRegistry.detectKeys': [],
  'modelRegistry.getRefreshState': { lastRefreshedAt: null, refreshing: false },
  'modelRegistry.getAutoRefresh': true,
};

/** Shared fields of the pushed runtime-status frames. */
const BASE_RUNTIME: OmnirouteRuntimeStatus = {
  state: 'idle',
  port: null,
  dashboardUrl: null,
  runtime: 'node',
  needsRuntime: false,
  owned: true,
};

/**
 * Install (once) a pass-through wrapper around the main-process bridge handler,
 * then set the active stub table to exactly `stubs`.
 *
 * Keys are bridge provider keys (`modelRegistry.list`, ...). A key mapped to
 * {@link NEVER_RESOLVES} is accepted and never answered, which is the only
 * honest way to hold the renderer in its in-flight state.
 */
async function setProviderStubs(stubs: Record<string, unknown>): Promise<void> {
  await visual.app.evaluate(
    ({ ipcMain }, payload) => {
      const CHANNEL = 'office-ai-bridge-adapter';
      const scope = globalThis as typeof globalThis & { __visualStubs?: Map<string, unknown> };

      if (!scope.__visualStubs) {
        const store = new Map<string, unknown>();
        scope.__visualStubs = store;
        const registry = (ipcMain as unknown as { _invokeHandlers: Map<string, Function> })._invokeHandlers;
        const original = registry?.get(CHANNEL);
        if (typeof original !== 'function') {
          throw new Error('visual: the bridge IPC handler is not registered - cannot install provider stubs');
        }
        ipcMain.removeHandler(CHANNEL);
        ipcMain.handle(CHANNEL, (event, info) => {
          let frame: { name?: string; data?: { id?: string } } | null = null;
          try {
            frame = JSON.parse(String(info));
          } catch {
            frame = null;
          }
          const name = frame?.name;
          if (typeof name === 'string' && name.startsWith('subscribe-')) {
            const key = name.slice('subscribe-'.length);
            if (store.has(key)) {
              const value = store.get(key);
              // Hold the request open: the renderer stays in its loading state.
              if (value === payload.neverResolves) return Promise.resolve();
              event.sender.send(
                CHANNEL,
                JSON.stringify({ name: `subscribe.callback-${key}${frame?.data?.id ?? ''}`, data: value })
              );
              return Promise.resolve();
            }
          }
          return original(event, info);
        });
      }

      scope.__visualStubs.clear();
      for (const [key, value] of Object.entries(payload.stubs)) scope.__visualStubs.set(key, value);
    },
    { stubs, neverResolves: NEVER_RESOLVES }
  );
}

/** Push one frame on the bridge event channel, exactly as main publishes it. */
async function pushEvent(name: string, data: unknown): Promise<void> {
  await visual.app.evaluate(({ BrowserWindow }, frame) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.isDestroyed());
    if (!win) throw new Error('visual: no live BrowserWindow to push a bridge event to');
    win.webContents.send('office-ai-bridge-adapter', frame);
  }, JSON.stringify({ name, data }));
}

const pushRuntime = (status: OmnirouteRuntimeStatus): Promise<void> =>
  pushEvent('omniroute-gateway.on-runtime-status', status);
const pushProgress = (progress: OmnirouteInstallProgress): Promise<void> =>
  pushEvent('omniroute-gateway.on-install-progress', progress);

/**
 * Wait until no Arco toast floats over the page.
 *
 * It matters twice over. The startup "multi-agent mode" toast
 * (`useMultiAgentDetection.tsx:34`) only fires when the machine has more than
 * one ACP agent installed, so a baseline containing it is machine-specific. And
 * it outlives the fixture's paint-settle window and then auto-dismisses, so it
 * was observed sitting over this page in the first verification screenshot and
 * gone from the second.
 */
async function waitForToastsGone(page: Page): Promise<void> {
  await expect.poll(() => page.locator('.arco-message').count(), { timeout: 30_000 }).toBe(0);
}

/** Everything that must hold before a baseline may be captured on this page. */
async function settlePage(page: Page): Promise<void> {
  await waitForToastsGone(page);
  await stabilize(page);
}

/**
 * Reload onto the Models page under the currently-installed stubs.
 *
 * Deliberately a bare reload, never a hash assignment: the route is pinned once
 * in `beforeAll` with `location.replace`, so no test adds a history entry. An
 * earlier version navigated per test and the titlebar's back chevron changed
 * enabled state between runs - a one-glyph diff caused purely by the test walk.
 */
async function openModelsPage(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  // The gateway card renders in every page state, so it doubles as proof that
  // the reload actually landed on the Models route.
  await expect(page.locator(CARD)).toBeVisible({ timeout: 60_000 });
}

/** Reload onto a pristine empty Models page and return the gateway card. */
async function freshCard(page: Page): Promise<Locator> {
  await setProviderStubs(EMPTY_PAGE_STUBS);
  await openModelsPage(page);
  const card = page.locator(CARD);
  await card.scrollIntoViewIfNeeded();
  return card;
}

/**
 * Element twin of the fixture's `stableScreenshot`: capture twice and require
 * byte-equality, so "this element cannot reproduce itself" is reported as
 * instability rather than surfacing later as a mystery pixel diff.
 */
async function stableElementShot(locator: Locator): Promise<Buffer> {
  const first = await locator.screenshot({ animations: 'disabled' });
  await new Promise((r) => setTimeout(r, 700));
  const second = await locator.screenshot({ animations: 'disabled' });
  if (Buffer.compare(first, second) !== 0) {
    throw new Error(
      `visual: element is not self-reproducible - two screenshots 700ms apart differed ` +
        `(${first.length} vs ${second.length} bytes). Something inside it is still animating, ` +
        `polling, or clock-dependent; pin it before capturing a baseline.`
    );
  }
  return first;
}

test.beforeAll(async () => {
  visual = await launchVisualApp();
  // Make first-run detection fail so the onboarding overlay never opens over the
  // settings page: `useOnboardingDetection` treats a rejection as "no detection"
  // and `OnboardingOverlay` renders nothing without one.
  await visual.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('onboarding:detect');
    ipcMain.handle('onboarding:detect', () => {
      throw new Error('visual: onboarding detection disabled for this run');
    });
  });
  await pinNondeterminism(visual.page);
  // Pin the route by REPLACING the current history entry, so every later reload
  // lands on the Models page without ever growing the back/forward stack.
  await visual.page.evaluate((route) => {
    window.location.replace(route);
  }, MODELS_ROUTE);
  await visual.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
});

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
});

test.describe('Visual: Models settings page states', () => {
  test('loading - provider list still in flight', async () => {
    const { page } = visual;
    await setProviderStubs({ ...EMPTY_PAGE_STUBS, 'modelRegistry.list': NEVER_RESOLVES });
    await openModelsPage(page);
    await settlePage(page);

    // Guard the premise: the spinner is up and the empty state is NOT, which is
    // the whole point of the loading branch (`index.tsx:374`).
    await expect(page.locator('.arco-spin')).toBeVisible();
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'the empty state must not render while the list is loading').not.toContain(
      'Одоогоор нийлүүлэгч холбогдоогүй байна'
    );

    expect(await stableScreenshot(page)).toMatchSnapshot('models-settings-loading.png');
  });

  test('empty - no providers and no detected keys', async () => {
    const { page } = visual;
    await setProviderStubs(EMPTY_PAGE_STUBS);
    await openModelsPage(page);
    await settlePage(page);

    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'empty-state nudge missing').toContain('Одоогоор нийлүүлэгч холбогдоогүй байна');

    expect(await stableScreenshot(page)).toMatchSnapshot('models-settings-empty.png');
  });

  test('error - the provider list came back unusable', async () => {
    const { page } = visual;
    // The only reachable failure: `bridge.invoke` never rejects, so a bad list
    // response is what `useModelRegistry` turns into `error` (`:127`).
    await setProviderStubs({ ...EMPTY_PAGE_STUBS, 'modelRegistry.list': null });
    await openModelsPage(page);
    await settlePage(page);

    await expect(page.locator('[role="alert"]').first()).toBeVisible();
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, 'load-error banner missing').toContain('Холбогдсон нийлүүлэгчдийг ачаалж чадсангүй');

    expect(await stableScreenshot(page)).toMatchSnapshot('models-settings-error.png');
  });
});

test.describe('Visual: OmniRoute gateway card', () => {
  test('idle - never installed this session', async () => {
    const card = await freshCard(visual.page);
    await settlePage(visual.page);

    // `idle` is the only state that shows no status pill at all.
    await expect(visual.page.locator('[data-testid="omniroute-gateway-runtime-status"]')).toHaveCount(0);
    await expect(visual.page.locator('[data-testid="omniroute-gateway-install-run"]')).toBeVisible();

    expect(await stableElementShot(card)).toMatchSnapshot('omniroute-card-idle.png');
  });

  test('installing - global install in flight', async () => {
    const card = await freshCard(visual.page);
    await pushRuntime({ ...BASE_RUNTIME, state: 'installing' });
    await pushProgress({ phase: 'install', message: 'added 1 package in 3s' });
    await expect(visual.page.locator('[data-testid="omniroute-gateway-progress"]')).toBeVisible();
    await settlePage(visual.page);

    expect(await stableElementShot(card)).toMatchSnapshot('omniroute-card-installing.png');
  });

  test('starting - spawned, waiting for health', async () => {
    const card = await freshCard(visual.page);
    await pushRuntime({ ...BASE_RUNTIME, state: 'starting' });
    await pushProgress({ phase: 'health', message: 'waiting for http://localhost:20128/v1/models' });
    await expect(visual.page.locator('[data-testid="omniroute-gateway-progress"]')).toBeVisible();
    await settlePage(visual.page);

    expect(await stableElementShot(card)).toMatchSnapshot('omniroute-card-starting.png');
  });

  test('running - dashboard + stop offered', async () => {
    const card = await freshCard(visual.page);
    await pushRuntime({ ...BASE_RUNTIME, state: 'running', port: 20128, dashboardUrl: 'http://localhost:20128' });
    await expect(visual.page.locator('[data-testid="omniroute-gateway-open-dashboard"]')).toBeVisible();
    await expect(visual.page.locator('[data-testid="omniroute-gateway-stop"]')).toBeVisible();
    await settlePage(visual.page);

    expect(await stableElementShot(card)).toMatchSnapshot('omniroute-card-running.png');
  });

  test('stopped - was running, now stopped', async () => {
    const card = await freshCard(visual.page);
    await pushRuntime({ ...BASE_RUNTIME, state: 'stopped' });
    await expect(visual.page.locator('[data-testid="omniroute-gateway-runtime-status"]')).toBeVisible();
    // Stopping must hand the install/run button back, not leave a dead card.
    await expect(visual.page.locator('[data-testid="omniroute-gateway-install-run"]')).toBeVisible();
    await settlePage(visual.page);

    expect(await stableElementShot(card)).toMatchSnapshot('omniroute-card-stopped.png');
  });

  test('error - install or start failed', async () => {
    const card = await freshCard(visual.page);
    await pushRuntime({ ...BASE_RUNTIME, state: 'error', runtime: null, error: 'install-failed' });
    await expect(visual.page.locator('[data-testid="omniroute-gateway-runtime-status"]')).toBeVisible();
    // An error without `needsRuntime` must NOT offer the Node.js download.
    await expect(visual.page.locator('[data-testid="omniroute-gateway-install-node"]')).toHaveCount(0);
    await settlePage(visual.page);

    expect(await stableElementShot(card)).toMatchSnapshot('omniroute-card-error.png');
  });

  /**
   * Captured at SECTION scope, unlike its six siblings, and deliberately so.
   *
   * The Node.js warning plus its download button push the card to 803px, past
   * the fixture's 800px content height. An element that overflows the viewport
   * cannot be fully rendered into one capture: the recorded PNG was the right
   * 803px tall but its bottom ~50px - the Test/Save button row - came back
   * blank. The fixture owns the viewport and must not be edited here, so this
   * state is captured on the auto-install section instead, which holds the
   * entire delta of `needsRuntime` and always fits.
   */
  test('needsRuntime - no bun/node on the machine', async () => {
    await freshCard(visual.page);
    await pushRuntime({ ...BASE_RUNTIME, state: 'error', runtime: null, needsRuntime: true, error: 'no-runtime' });
    const section = visual.page.locator(AUTOINSTALL);
    await expect(visual.page.locator('[data-testid="omniroute-gateway-install-node"]')).toBeVisible();
    await settlePage(visual.page);

    expect(await stableElementShot(section)).toMatchSnapshot('omniroute-runtime-needs-runtime.png');
  });
});
