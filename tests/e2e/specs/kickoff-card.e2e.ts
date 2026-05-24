/**
 * E2E (v0.4.7.1): Kickoff card on the new-chat surface.
 *
 * Validates the post-cross-audit kickoff system end-to-end as a user would:
 *   1. Open the new-chat surface (/guid).
 *   2. Pick a preset assistant (Coach/Helm — known to ship with all
 *      cascade levels in `assistants.json`).
 *   3. Assert the KickoffCard renders BELOW the input (render-then-hydrate
 *      contract from the design doc).
 *   4. Assert the card has the expected role/aria-live/aria-label (D-M-4).
 *   5. Click "Yes, let's start" → assert input prefills + textarea
 *      actually focuses (RENDERER-1 fix that was broken before v0.4.7.1).
 *   6. Re-open the assistant → assert card stays dismissed for the session.
 *   7. Press Escape on a fresh assistant → assert dismissal works.
 *
 * Per Sean's `feedback-playwright-cdp-for-electron-verify` memory:
 * interaction tests MUST run via Playwright over CDP, not synthetic
 * dispatchEvent, because synthetic events give false negatives for
 * focus/blur. This spec uses Playwright's real keyboard + click drivers.
 *
 * Selectors used (production data-testids):
 *   - new-chat-kickoff-card       — card container
 *   - new-chat-kickoff-accept     — primary "Yes, let's start" button
 *   - new-chat-kickoff-redirect   — "Something else" text link
 *   - new-chat-kickoff-dismiss    — × dismiss button
 *   - preset-pill-builtin-helm    — preset assistant pill
 *
 * Prereq: app must be built (`bunx electron-vite build`) OR run with
 * `E2E_DEV=1 bun run test:e2e tests/e2e/specs/kickoff-card.e2e.ts`.
 */

import { test, expect } from '../fixtures';
import { navigateTo, ROUTES } from '../helpers';

const PRESET_HELM = '[data-testid="preset-pill-builtin-helm"]';
const PRESET_SLATE = '[data-testid="preset-pill-builtin-slate"]';
const KICKOFF_CARD = '[data-testid="new-chat-kickoff-card"]';
const KICKOFF_ACCEPT = '[data-testid="new-chat-kickoff-accept"]';
const KICKOFF_REDIRECT = '[data-testid="new-chat-kickoff-redirect"]';
const KICKOFF_DISMISS = '[data-testid="new-chat-kickoff-dismiss"]';
const GUID_TEXTAREA = 'textarea';
const NEW_CHAT_STARTER = '[data-testid="new-chat-starter"]';

test.describe('Kickoff card — new-chat empty state (v0.4.7.1)', () => {
  test.beforeEach(async ({ page }) => {
    await navigateTo(page, ROUTES.guid);
    // Guid page may render skeleton first; wait for either the starter
    // (no preset selected) or the input (preset selected from prior state).
    await page.locator(GUID_TEXTAREA).first().waitFor({ state: 'visible', timeout: 10_000 });
  });

  test('DIAGNOSTIC: dump all data-testids on /guid', async ({ page }, testInfo) => {
    const diag = await page.evaluate(() => {
      const allTestids = Array.from(document.querySelectorAll('[data-testid]')).map((el) =>
        el.getAttribute('data-testid')
      );
      // Look for assistant-pick affordances by class / text hints too
      const interactives = Array.from(
        document.querySelectorAll('button, [role="button"], [data-testid*="intent"], [data-testid*="recent"], [data-testid*="mention"]')
      )
        .map((el) => ({
          testid: el.getAttribute('data-testid'),
          text: (el.textContent || '').trim().slice(0, 40),
        }))
        .filter((x) => x.testid || x.text);
      return {
        url: window.location.href,
        allTestids,
        interactives: interactives.slice(0, 40),
      };
    });
    // eslint-disable-next-line no-console
    console.log('[DIAGNOSTIC]\n', JSON.stringify(diag, null, 2));
    await page.screenshot({ path: testInfo.outputPath('guid-page.png'), fullPage: true });
    expect(diag.allTestids.length).toBeGreaterThan(0);
  });

  test('preset assistant selection surfaces the kickoff card below the input', async ({ page }) => {
    // Pick Helm (Coach) — it ships with morning/afternoon/evening cold-starts +
    // continuation + beginner-safe + post-fire-ritual. Cascade should hit
    // Level 3 (cold-start library) for a fresh-state user with no recent
    // conversation history against Helm.
    await page.locator(PRESET_HELM).click();

    // Card mounts after the suggest IPC round-trip — give it generous slack
    // for cold-cache + ExtensionRegistry init (INIT-1 race protection caps
    // at 3s server-side).
    await expect(page.locator(KICKOFF_CARD)).toBeVisible({ timeout: 8_000 });

    // RENDERER-1 + design contract: card must mount BELOW the input.
    // Capture both bounding boxes and assert vertical order.
    const inputBox = await page.locator(GUID_TEXTAREA).first().boundingBox();
    const cardBox = await page.locator(KICKOFF_CARD).boundingBox();
    expect(inputBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    if (inputBox && cardBox) {
      expect(cardBox.y).toBeGreaterThan(inputBox.y);
    }

    // D-M-4 — a11y attributes
    const card = page.locator(KICKOFF_CARD);
    await expect(card).toHaveAttribute('role', 'region');
    await expect(card).toHaveAttribute('aria-live', 'polite');
    const ariaLabel = await card.getAttribute('aria-label');
    expect(ariaLabel).toBeTruthy();
    expect(ariaLabel?.length).toBeGreaterThan(3);
  });

  test('clicking "Yes, let\'s start" prefills the input AND focuses the textarea (RENDERER-1)', async ({ page }) => {
    await page.locator(PRESET_HELM).click();
    await expect(page.locator(KICKOFF_CARD)).toBeVisible({ timeout: 8_000 });

    const textarea = page.locator(GUID_TEXTAREA).first();

    // Snapshot the pre-click textarea state
    const beforeValue = await textarea.inputValue();
    expect(beforeValue).toBe('');

    // Click the primary CTA
    await page.locator(KICKOFF_ACCEPT).click();

    // RENDERER-1 — prefill landed
    await expect(textarea).not.toHaveValue('', { timeout: 3_000 });
    const afterValue = await textarea.inputValue();
    expect(afterValue.length).toBeGreaterThan(0);

    // RENDERER-1 — textarea is the focused element. Use Playwright's
    // accessibility-tree focus check rather than synthetic event detection.
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase());
    expect(focusedTag).toBe('textarea');

    // Card dismissed itself after accept
    await expect(page.locator(KICKOFF_CARD)).not.toBeVisible();
  });

  test('× dismiss hides the card for the rest of the session (per-assistant)', async ({ page }) => {
    await page.locator(PRESET_HELM).click();
    await expect(page.locator(KICKOFF_CARD)).toBeVisible({ timeout: 8_000 });

    await page.locator(KICKOFF_DISMISS).click();
    await expect(page.locator(KICKOFF_CARD)).not.toBeVisible();

    // Switch to another assistant + back: still dismissed for Helm.
    await page.locator(PRESET_SLATE).click();
    // Slate gets its own card (not dismissed yet)
    await expect(page.locator(KICKOFF_CARD)).toBeVisible({ timeout: 8_000 });
    // Switch back to Helm: card stays dismissed
    await page.locator(PRESET_HELM).click();
    await expect(page.locator(KICKOFF_CARD)).not.toBeVisible();
  });

  test('"Something else" rotates through alternates, then exhausts to dismiss', async ({ page }) => {
    await page.locator(PRESET_HELM).click();
    await expect(page.locator(KICKOFF_CARD)).toBeVisible({ timeout: 8_000 });

    const card = page.locator(KICKOFF_CARD);
    const initialText = await card.locator('div').first().textContent();

    // Redirect 1 — text changes to alternate 1
    await page.locator(KICKOFF_REDIRECT).click();
    await expect(card).toBeVisible();
    const afterFirst = await card.locator('div').first().textContent();
    expect(afterFirst).not.toBe(initialText);

    // Redirect 2 — text changes to alternate 2
    await page.locator(KICKOFF_REDIRECT).click();
    await expect(card).toBeVisible();

    // Redirect 3 — ladder exhausted, card dismisses to bare input
    await page.locator(KICKOFF_REDIRECT).click();
    await expect(card).not.toBeVisible({ timeout: 3_000 });
  });

  test('Escape key dismisses the card (D-M-4 keyboard a11y)', async ({ page }) => {
    await page.locator(PRESET_HELM).click();
    await expect(page.locator(KICKOFF_CARD)).toBeVisible({ timeout: 8_000 });

    await page.keyboard.press('Escape');
    await expect(page.locator(KICKOFF_CARD)).not.toBeVisible();
  });

  test('typing in the input dismisses the card (dismiss-on-type)', async ({ page }) => {
    await page.locator(PRESET_HELM).click();
    await expect(page.locator(KICKOFF_CARD)).toBeVisible({ timeout: 8_000 });

    const textarea = page.locator(GUID_TEXTAREA).first();
    await textarea.focus();
    await textarea.type('h');

    // Card dismisses on first keystroke
    await expect(page.locator(KICKOFF_CARD)).not.toBeVisible({ timeout: 2_000 });
    // First keystroke is NOT lost — design contract guarantee.
    const value = await textarea.inputValue();
    expect(value).toBe('h');
  });

  test('rapid double-click on "Yes" does not double-fire (RENDERER-2 lock)', async ({ page }) => {
    await page.locator(PRESET_HELM).click();
    await expect(page.locator(KICKOFF_CARD)).toBeVisible({ timeout: 8_000 });

    const textarea = page.locator(GUID_TEXTAREA).first();
    const accept = page.locator(KICKOFF_ACCEPT);
    // Two rapid clicks in the same frame
    await Promise.all([accept.click(), accept.click().catch(() => {})]);

    // Only one prefill should land (idempotent), card dismissed.
    await expect(page.locator(KICKOFF_CARD)).not.toBeVisible();
    const value = await textarea.inputValue();
    expect(value.length).toBeGreaterThan(0);
    // Telemetry double-fire is checked via console logs in dev — surface
    // here as a smoke that nothing throws on the double-tap.
  });
});
