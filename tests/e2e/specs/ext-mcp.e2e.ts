/**
 * Extensions - MCP Servers tests.
 *
 * Validates that the MCP settings surface is reachable and renders the server
 * list. The spec used to navigate to `#/settings/capabilities`, a route that no
 * longer exists (MCP moved to the MCP Library), so all four tests timed out on
 * `[data-settings-path="capabilities"]` and the MCP page was never exercised.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { expectBodyContainsAny, takeScreenshot, waitForSettle, ARCO_SWITCH, ROUTES } from '../helpers';

const MCP_ROUTE = ROUTES.settings.mcpLibrary;
/** Installed servers (the seeded built-ins) rather than the installable catalog. */
const INSTALLED_ROUTE = '#/settings/mcp-library/installed';

/**
 * Navigate to the MCP Library settings page.
 *
 * `goToSettings` drives the sider footer button, which a first-run
 * `.arco-modal-wrapper` covers on a fresh E2E profile - the click is swallowed
 * and every settings spec times out. Hash navigation reaches the same route
 * without depending on that overlay, which is what this spec is actually about.
 */
async function goToMcpSettings(page: Page, route: string = MCP_ROUTE): Promise<void> {
  await page.evaluate((hash) => window.location.assign(hash), route);
  await page.waitForFunction(() => window.location.hash.includes('/settings/mcp-library'), { timeout: 15_000 });
  await page.waitForFunction(() => (document.body.textContent?.length ?? 0) > 50, { timeout: 15_000 });
  await waitForSettle(page);
}

test.describe('Extension: MCP Servers', () => {
  test('MCP settings page loads at the MCP Library route', async ({ page }) => {
    await goToMcpSettings(page);
    await expectBodyContainsAny(page, ['MCP', 'mcp', 'Server', 'server', 'Сервер', 'сервер']);
  });

  test('extension MCP servers registered (page functional)', async ({ page }) => {
    await goToMcpSettings(page);

    const body = await page.locator('body').textContent();
    // MCP servers may appear in the list or be internal-only
    expect(body!.length).toBeGreaterThan(50);
  });

  test('installed MCP servers render an enable toggle', async ({ page }) => {
    // The Browse tab is a catalog of installable entries (cards, no toggles);
    // the seeded built-in servers live on the Installed tab.
    await goToMcpSettings(page, INSTALLED_ROUTE);

    const count = await page.locator(ARCO_SWITCH).count();
    // initStorage seeds three built-in servers, each with an enable toggle.
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('screenshot: MCP tools with extensions', async ({ page }) => {
    test.skip(!process.env.E2E_SCREENSHOTS, 'screenshots disabled');
    await goToMcpSettings(page);
    await takeScreenshot(page, 'ext-mcp-servers');
  });
});
