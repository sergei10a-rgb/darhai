/**
 * Navigation helpers for E2E tests.
 *
 * Centralises route constants and provides typed navigation utilities
 * so individual test files stay DRY.
 */
import type { Page } from '@playwright/test';
import { channelItemById, webuiTabByKey } from './selectors';
import { invokeBridge } from './bridge';

// ── First-run onboarding ─────────────────────────────────────────────────────

/** Arco renders every modal, including the first-run overlay, in this wrapper. */
const MODAL_WRAPPER = '.arco-modal-wrapper';

/** One settled decision per app instance; the app is a per-worker singleton. */
let onboardingSettled = false;

/**
 * Put the app into the state of a user who has already been through onboarding.
 *
 * On a profile that has never completed onboarding, `OnboardingOverlay` mounts
 * an Arco `Modal` with `closable`, `maskClosable` and `escToExit` all false. Its
 * mask covers the whole window, so the sider-footer button `navigateTo` clicks
 * is never reached and every settings navigation times out - that alone
 * accounted for 12 of the 13 failures in `specs/ext-settings-tabs.e2e.ts`.
 *
 * The fix is to finish onboarding, not to hide it. Hiding the modal layer with
 * CSS (`display: none` on `.arco-modal-wrapper`) also hides every *other* Arco
 * modal - composers, confirm dialogs, pickers - that later specs need to click,
 * so it trades one silent failure for a subtler one.
 *
 * Three steps, in increasing order of intrusiveness:
 *   1. Persist `onboardingCompleted` through the app's own config bridge. This
 *      is byte-for-byte the write `OnboardingOverlay.dismiss()` performs, so the
 *      profile ends up in a genuine post-onboarding state rather than a faked
 *      one.
 *   2. If the overlay is already mounted, walk it to its finish button. Its
 *      `visible` flag is component state that only consults the config on
 *      mount, so the write in step 1 cannot close a modal that is already open.
 *   3. If it is still there, reload the renderer. Step 1 has persisted the flag,
 *      so the overlay does not re-open on the fresh mount.
 *
 * Throws if the overlay outlives all three - a loud failure is far better than
 * a suite that silently clicks through an invisible mask.
 */
export async function ensureOnboardingComplete(page: Page): Promise<void> {
  if (onboardingSettled || page.isClosed()) return;
  onboardingSettled = true;

  // `ConfigStorage.set('onboardingCompleted', true)` over the platform's storage
  // provider protocol: `<namespace>.storage.set` with `{ key, data }`.
  await invokeBridge(page, 'agent.config.storage.set', { key: 'onboardingCompleted', data: true }).catch(() => {
    // Best-effort: the walk + reload below still clear a mounted overlay.
  });

  const overlay = page.locator(MODAL_WRAPPER).first();
  if (!(await overlay.isVisible().catch(() => false))) return;

  // Step 2: click the step's primary action until the flow finishes. Each screen
  // (quickstart -> scan -> outcome) ends in a single forward button, and the
  // last one calls `onFinish`, which is the overlay's own dismiss path.
  for (let step = 0; step < 6; step++) {
    if (!(await overlay.isVisible().catch(() => false))) return;
    const forward = page.locator(`${MODAL_WRAPPER} button:visible`).last();
    // eslint-disable-next-line no-await-in-loop
    if (!(await forward.isEnabled().catch(() => false))) break;
    // eslint-disable-next-line no-await-in-loop
    await forward.click({ timeout: 5_000 }).catch((): void => undefined);
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(600);
  }

  if (!(await overlay.isVisible().catch(() => false))) return;

  // Step 3: the flag is persisted, so a fresh mount reads "already onboarded".
  await page.reload();
  await page
    .waitForFunction(() => (document.body.textContent?.length ?? 0) > 50, { timeout: 60_000 })
    .catch((): void => undefined);
  await page
    .locator(MODAL_WRAPPER)
    .first()
    .waitFor({ state: 'hidden', timeout: 20_000 })
    .catch((): void => undefined);

  if (
    await page
      .locator(MODAL_WRAPPER)
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    throw new Error(
      'first-run onboarding overlay is still covering the window after completing it and reloading. ' +
        'Every click-driven navigation will be swallowed by its mask; fix the overlay rather than hiding it.'
    );
  }
}

/** Reset the onboarding cache (call when a fresh app instance is launched). */
export function resetOnboardingCache(): void {
  onboardingSettled = false;
}

// ── Route constants ──────────────────────────────────────────────────────────

export const ROUTES = {
  guid: '#/guid',
  settings: {
    gemini: '#/settings/gemini',
    model: '#/settings/model',
    agent: '#/settings/agent',
    assistants: '#/settings/assistants',
    capabilities: '#/settings/capabilities',
    // MCP moved out of the old "capabilities" tab into the MCP Library.
    // `data-settings-path` on the sider item is the full segment, so the
    // route must carry `mcp-library/browse` verbatim.
    mcpLibrary: '#/settings/mcp-library/browse',
    display: '#/settings/display',
    webui: '#/settings/webui',
    system: '#/settings/system',
    about: '#/settings/about',
  },
  /** Dynamic extension settings tab route */
  extensionSettings: (tabId: string) => `#/settings/ext/${tabId}`,
} as const;

export type SettingsTab = keyof typeof ROUTES.settings;

// ── Navigation helpers ───────────────────────────────────────────────────────

/**
 * Check if the page is already at the target hash route.
 * Avoids redundant navigation + re-render when consecutive tests
 * in the same describe block navigate to the same page.
 */
function isAlreadyAt(page: Page, hash: string): boolean {
  try {
    const url = page.url();
    // Compare the hash portion (e.g. "#/guid" or "#/settings/agent")
    const currentHash = url.includes('#') ? '#' + url.split('#')[1] : '';
    return currentHash === hash;
  } catch {
    return false;
  }
}

/**
 * Navigate to a hash route via UI clicks.
 *
 * This app uses HashRouter with ProtectedLayout, so programmatic
 * `window.location.assign` is unreliable when React Router hasn't
 * initialised yet. Instead we click the Sider footer button and
 * settings sider nav items - exactly like a user would.
 */
export async function navigateTo(page: Page, hash: string): Promise<void> {
  if (page.isClosed()) {
    throw new Error('Cannot navigate: page is already closed.');
  }

  // Nothing below can click anything while the first-run mask is up.
  await ensureOnboardingComplete(page);

  if (isAlreadyAt(page, hash)) {
    return;
  }

  const currentHash = await page.evaluate(() => window.location.hash);
  const isOnSettings = currentHash.includes('/settings/');
  const targetIsSettings = hash.includes('/settings/');

  if (!targetIsSettings) {
    // Target is non-settings (guid, conversation, etc.)
    if (isOnSettings) {
      // Click the sider back button to leave settings
      const siderBtn = page.locator('.sider-footer div').first();
      await siderBtn.waitFor({ state: 'visible', timeout: 10_000 });
      await siderBtn.click();
      // Wait for hash to change away from settings
      await page
        .waitForFunction(() => !window.location.hash.includes('/settings/'), { timeout: 10_000 })
        .catch(() => {});
    }
    // Programmatic navigation for non-settings targets.
    // Always navigate when not already at the target (e.g. conversation → guid).
    if (!isAlreadyAt(page, hash)) {
      await page.evaluate((h) => window.location.assign(h), hash);
      try {
        await page.waitForFunction((h) => window.location.hash === h, hash, { timeout: 10_000 });
      } catch {
        /* best-effort */
      }
    }
  } else {
    // Target is a settings sub-page
    if (!isOnSettings) {
      // Click sider settings button to enter settings
      const siderBtn = page.locator('.sider-footer div').first();
      await siderBtn.waitFor({ state: 'visible', timeout: 10_000 });
      await siderBtn.click();
      await page
        .waitForFunction(() => window.location.hash.includes('/settings/'), { timeout: 10_000 })
        .catch(() => {});
    }

    // Extract the settings path segment (e.g. "assistants" from "#/settings/assistants")
    const settingsPath = hash.replace(/^#\/settings\//, '');
    if (!isAlreadyAt(page, hash)) {
      const navItem = page.locator(`[data-settings-path="${settingsPath}"]`);
      await navItem.waitFor({ state: 'visible', timeout: 10_000 });
      await navItem.click();
      await page
        .waitForFunction((h) => window.location.hash.includes(h), `/settings/${settingsPath}`, { timeout: 10_000 })
        .catch(() => {});
    }
  }

  // Wait for body to have meaningful content
  try {
    await page.waitForFunction(() => (document.body.textContent?.length ?? 0) > 50, { timeout: 10_000 });
  } catch {
    /* best-effort */
  }
}

async function navigateWithRetry(page: Page, hash: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await navigateTo(page, hash);
    if (isAlreadyAt(page, hash)) {
      return;
    }
  }
}

/**
 * Wait for the page to settle using event-driven detection.
 * If the condition is not met within timeout, simply continues (best-effort).
 */
export async function waitForSettle(page: Page, timeoutMs = 3000): Promise<void> {
  try {
    await page.waitForFunction(() => (document.body.textContent?.length ?? 0) > 50, { timeout: timeoutMs });
  } catch {
    // Best-effort: page may not have enough content yet, continue without fixed sleep
  }
}

/** Navigate to the guid / chat page. */
export async function goToGuid(page: Page): Promise<void> {
  await navigateWithRetry(page, ROUTES.guid);
}

/** Navigate to a settings tab. */
export async function goToSettings(page: Page, tab: SettingsTab): Promise<void> {
  await navigateWithRetry(page, ROUTES.settings[tab]);
}

/** Navigate to the assistant settings page. */
export async function goToAssistantSettings(page: Page): Promise<void> {
  await navigateWithRetry(page, ROUTES.settings.assistants);
}

/** Navigate to an extension-contributed settings tab by its ID. */
export async function goToExtensionSettings(page: Page, tabId: string): Promise<void> {
  await navigateWithRetry(page, ROUTES.extensionSettings(tabId));
}

/** Track whether we have already navigated to the channels tab in this session. */
let _onChannelsTab = false;

/**
 * Navigate to the channels tab inside the webui settings page.
 * Extracted from individual test files to eliminate duplication.
 * Uses a session-level flag to skip re-navigation when already on the tab.
 */
export async function goToChannelsTab(page: Page): Promise<void> {
  const channelItem = page
    .locator(`${channelItemById('telegram')}, ${channelItemById('lark')}, ${channelItemById('dingtalk')}`)
    .first();

  // Quick check: if we're already on the channels tab, verify a channel item is still visible
  if (_onChannelsTab && isAlreadyAt(page, ROUTES.settings.webui)) {
    const stillVisible = await channelItem.isVisible().catch(() => false);
    if (stillVisible) return;
  }

  await goToSettings(page, 'webui');

  // Ensure route transition is actually complete before locating inner tabs
  await page
    .waitForFunction(() => window.location.hash.startsWith('#/settings/webui'), { timeout: 12_000 })
    .catch((): void => undefined);

  const stableTab = page.locator(webuiTabByKey('channels')).first();
  const fallbackTab = page
    .locator('.arco-tabs-header-title, .arco-tabs-nav-tab-title')
    .filter({ hasText: /channel|频道|渠道/i })
    .first();

  let switched = false;
  for (let attempt = 0; attempt < 2 && !switched; attempt++) {
    if (await channelItem.isVisible().catch(() => false)) {
      switched = true;
      break;
    }

    if (await stableTab.isVisible().catch(() => false)) {
      await stableTab.click();
      switched = true;
      break;
    }

    if (await fallbackTab.isVisible().catch(() => false)) {
      await fallbackTab.click();
      switched = true;
      break;
    }

    // Retry once in case of slow Settings lazy-load in packaged CI runs
    await goToSettings(page, 'webui');
    await waitForSettle(page, 2_000);
  }

  if (!switched) {
    // Final strict wait to surface a clear failure when Channels tab truly does not exist
    await stableTab.waitFor({ state: 'visible', timeout: 12_000 });
    await stableTab.click();
  }

  try {
    await channelItem.waitFor({ state: 'visible', timeout: 12_000 });
    _onChannelsTab = true;
  } catch {
    // Best-effort fallback for transitional states
    await page.waitForFunction(() => (document.body.textContent?.length ?? 0) > 50, { timeout: 5_000 });
    _onChannelsTab = true;
  }
}

/** Reset the channels-tab navigation cache (call when navigating away). */
export function resetChannelsTabCache(): void {
  _onChannelsTab = false;
}

/**
 * Wait for a MutationObserver-based class change on an element.
 * Extracted from repeated inline usage across test files.
 */
export async function waitForClassChange(element: import('@playwright/test').Locator, timeoutMs = 1500): Promise<void> {
  await element.evaluate(
    (el, ms) =>
      new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
        setTimeout(() => {
          observer.disconnect();
          resolve();
        }, ms);
      }),
    timeoutMs
  );
}
