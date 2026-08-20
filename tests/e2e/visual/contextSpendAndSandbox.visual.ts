/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The two surfaces from the harness-assimilation waves that had only ever been
 * seen by jsdom: the context-usage popover (its ₮ spend row and used/free
 * breakdown) and the host-sandbox card on General settings.
 *
 * WHY A SEPARATE SPEC. Both are unreachable by a bare hash navigation. The
 * popover needs three things to exist at once - a conversation row, a token
 * count on the renderer stream, and a priced row in `cost_events` - and the
 * sandbox card's mode picker and enforcement notice are gated behind a switch
 * that defaults to off. A spec that only navigated would photograph an empty
 * composer and a collapsed card, and would have proved nothing about either.
 *
 * WHAT EACH STEP IS FOR
 * ---------------------
 * - `cost.setMntRateSettings` pins the ₮ rate, so the tögrög figure is a fixed
 *   number rather than whatever the live rate happens to be that morning.
 * - The `cost_events` insert is a direct SQLite write ON PURPOSE. `ipcBridge`
 *   exposes the cost namespace read-only ("writes go through CostRecorder"), and
 *   `costMntSurface.visual.ts` already documents that stubbing `ipcMain.handle`
 *   for cost channels silently does nothing. A real recorded row is the only
 *   honest way to make `useContextSpend` return a spend, so the insert is
 *   asserted rather than best-effort: if it fails, this spec fails.
 * - The `finish` frame goes down the same `office-ai-bridge-adapter` wire the
 *   engine uses, so `tokenUsage` becomes non-null the way it does in production
 *   rather than by poking React state.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertBundleShowsSource,
  closeVisualApp,
  launchVisualApp,
  pinNondeterminism,
  stabilize,
  stableScreenshot,
  type VisualApp,
} from './fixture';
import { gotoHash, hideFirstRunOverlay, pushResponseFrame, settleFrozen } from './surfaces';
import { invokeBridge } from '../helpers/bridge';
import { resetOnboardingCache } from '../helpers/navigation';

const OUT_DIR = path.resolve(__dirname, '..', 'screenshots', 'contextSpendAndSandbox');

/** Pinned so the ₮ figure in the screenshot is reproducible, not market data. */
const MNT_PER_USD = 3580;
/** A spend a human can check by hand: 0.5 USD * 3580 = 1,790₮. */
const SEEDED_COST_USD = 0.5;
/** Comfortably inside the default window, so the ring is partial, not full. */
const SEEDED_INPUT_TOKENS = 140_000;
const SEEDED_OUTPUT_TOKENS = 12_000;

/**
 * The sandbox card's Mongolian labels, copied from
 * `locales/mn-MN/settings.json` (`settings.sandbox.*`). The visual fixture
 * launches with `LANG=mn_MN.UTF-8`, so this is what the screen actually says -
 * and pinning the literal here means a translation change that silently drops
 * these controls fails this spec instead of passing it.
 */
const BACKUP_EXPORT_LABEL = 'Бүгдийг экспортлох';
const BACKUP_RESTORE_LABEL = 'Нөөцлөлтөөс сэргээх';
const RESTORE_CONFIRM_TITLE = 'Нөөцлөлтөөс сэргээх үү?';

const MODE_READ_ONLY = 'Зөвхөн унших';
const MODE_WORKSPACE_WRITE = 'Ажлын талбарт бичих';
const PARTIAL_WARNING_PREFIX = 'Хамгаалалт хэсэгчилсэн';

let visual: VisualApp;

test.beforeAll(async () => {
  // These are the files this spec claims to be photographing; a bundle older
  // than any of them would make every assertion below describe stale code.
  assertBundleShowsSource([
    'src/renderer/components/agent/ContextUsageIndicator.tsx',
    'src/renderer/hooks/cost/useContextSpend.ts',
    'src/renderer/components/settings/SettingsModal/contents/SystemModalContent',
  ]);
  visual = await launchVisualApp();
  await pinNondeterminism(visual.page);
  await hideFirstRunOverlay(visual.page);
  // The overlay can mount after the first check; walk it away for real.
  await visual.page.waitForTimeout(2_000);
  resetOnboardingCache();
  await hideFirstRunOverlay(visual.page);
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

test.afterAll(async () => {
  await closeVisualApp(visual);
});

async function snap(name: string): Promise<void> {
  await settleFrozen(visual.page);
  await stabilize(visual.page);
  const shot = await stableScreenshot(visual.page);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), shot);
}

/**
 * Write one priced row straight into the app's own database.
 *
 * Runs inside the MAIN process rather than the Playwright node process: the
 * `better-sqlite3` binary is built for Electron's ABI, so requiring it from
 * plain node would throw NODE_MODULE_VERSION. The database is in WAL mode while
 * the app holds it, which is what makes a second writer safe here.
 *
 * Returns the row id so the caller can assert the write actually landed instead
 * of trusting that a silent resolve meant success.
 */
async function seedCostRow(conversationId: string): Promise<number> {
  return visual.app.evaluate(
    async ({ app }, seed: { conversationId: string; costUsd: number; mntPerUsd: number; tokens: number }) => {
      // Playwright evaluates this function in the main process's GLOBAL scope.
      // `require` is a MODULE-scope binding, so it is not in reach here, and
      // `await import(...)` is refused outright ("a dynamic import callback was
      // not specified") because the eval context has no import hook. The main
      // module's own `require` is the one loader that survives both: it is a
      // property of a live object, and it resolves from `out/main/`, which walks
      // up to the app's node_modules.
      const mainModule = (
        process as unknown as { mainModule?: { require: (id: string) => unknown; filename?: string } }
      ).mainModule;
      const mainRequire = mainModule?.require;
      if (typeof mainRequire !== 'function') {
        throw new Error('main module require is unavailable; cannot reach better-sqlite3 to seed cost');
      }
      const nodePath = mainRequire('node:path') as typeof import('node:path');
      const appPath = app.getAppPath();

      // `better-sqlite3` is a native addon the bundler leaves external, so the
      // resolution ANCHOR decides whether it is found - and which anchor works
      // is not something to guess. Try each, in order of how directly it points
      // at the app's own node_modules, and report every failure if none works.
      type DatabaseCtor = new (file: string) => {
        prepare: (sql: string) => { run: (...args: unknown[]) => { lastInsertRowid: number | bigint } };
        close: () => void;
      };
      const { createRequire } = mainRequire('node:module') as typeof import('node:module');
      const candidates: Array<{ label: string; load: () => unknown }> = [
        { label: 'mainModule.require', load: () => mainRequire('better-sqlite3') },
        {
          label: 'createRequire(appPath/package.json)',
          load: () => createRequire(nodePath.join(appPath, 'package.json'))('better-sqlite3'),
        },
        {
          label: 'absolute node_modules path',
          load: () => mainRequire(nodePath.join(appPath, 'node_modules', 'better-sqlite3')),
        },
      ];
      let Database: DatabaseCtor | undefined;
      const failures: string[] = [];
      for (const candidate of candidates) {
        try {
          Database = candidate.load() as DatabaseCtor;
          break;
        } catch (err) {
          failures.push(`${candidate.label}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!Database) {
        throw new Error(
          `could not load better-sqlite3 in the main process. appPath=${appPath} ` +
            `mainModule=${mainModule?.filename ?? '(unknown)'}\n  ${failures.join('\n  ')}`
        );
      }
      // Mirrors getDataPath() in src/process/utils/utils.ts.
      const file = nodePath.join(app.getPath('userData'), 'wayland', 'wayland.db');
      const db = new Database(file);
      try {
        const result = db
          .prepare(
            `INSERT INTO cost_events (
               conversation_id, backend, model_id, cost_usd, tokens_total,
               input_tokens, output_tokens, cache_read_tokens, cost_source,
               cron_id, team_id, created_at, mnt_per_usd
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            seed.conversationId,
            'wcore',
            'visual-placeholder',
            seed.costUsd,
            seed.tokens,
            seed.tokens,
            0,
            0,
            'measured',
            null,
            null,
            1_700_000_000_000,
            seed.mntPerUsd
          );
        return Number(result.lastInsertRowid);
      } finally {
        db.close();
      }
    },
    {
      conversationId,
      costUsd: SEEDED_COST_USD,
      mntPerUsd: MNT_PER_USD,
      tokens: SEEDED_INPUT_TOKENS + SEEDED_OUTPUT_TOKENS,
    }
  );
}

test('context-usage popover shows the used/free breakdown and the ₮ spend', async () => {
  // 1. Pin the rate BEFORE the conversation mounts: useContextSpend fetches once
  //    on mount and does not revalidate on focus.
  await invokeBridge(visual.page, 'cost.setMntRateSettings', { auto: false, manualMntPerUsd: MNT_PER_USD });

  // 2. Create the conversation ourselves (rather than via openWCoreConversation)
  //    so the cost row can be seeded against its id before the surface mounts.
  const created = await invokeBridge<{ id?: string } | null>(visual.page, 'create-conversation', {
    type: 'wcore',
    name: 'Visual: context spend',
    model: { id: 'visual-placeholder', name: 'visual-placeholder', platform: 'wcore', useModel: 'visual-placeholder' },
    extra: { backend: 'wcore' },
  });
  const id = created?.id;
  expect(id, 'create-conversation returned no id').toBeTruthy();

  // 3. Seed the priced row, and prove the write landed.
  const rowId = await seedCostRow(id as string);
  expect(rowId, 'cost_events insert did not return a row id').toBeGreaterThan(0);

  // 4. Read it back through the REAL bridge the hook uses. If this is empty the
  //    popover could never show a spend, and we want that reported here - at the
  //    cause - rather than as a confusing missing-element failure later.
  const rows = await invokeBridge<Array<{ key: string; costUsd: number }>>(visual.page, 'cost.byConversation', {
    fromMs: 0,
    toMs: 8_640_000_000_000_000,
  });
  const seeded = rows?.find((r) => r.key === id);
  expect(seeded?.costUsd, 'cost.byConversation does not see the seeded row').toBeCloseTo(SEEDED_COST_USD, 6);

  // 5. Open the surface and put a real token count on the stream.
  await gotoHash(visual.page, `#/conversation/${id}`);
  await visual.page.waitForFunction((target: string) => window.location.hash.includes(target), id, { timeout: 15_000 });
  await settleFrozen(visual.page);

  await pushResponseFrame(visual.app, {
    type: 'finish',
    msg_id: 'context-spend-visual-1',
    conversation_id: id as string,
    data: { input_tokens: SEEDED_INPUT_TOKENS, output_tokens: SEEDED_OUTPUT_TOKENS },
  });

  // The indicator returns null without token usage, so its mere presence is the
  // proof that the frame arrived.
  const indicator = visual.page.locator('.context-usage-indicator');
  await expect(indicator).toBeVisible({ timeout: 15_000 });
  await snap('context-usage-ring');

  // 6. Hover BEFORE stabilize: freezeMotion kills the popover's fade-in, so the
  //    panel has to already be mounted when motion stops.
  await indicator.hover();
  const figure = visual.page.getByTestId('context-usage-figure');
  await expect(figure).toBeVisible({ timeout: 10_000 });
  await expect(visual.page.getByTestId('context-usage-breakdown')).toBeVisible();
  const spend = visual.page.getByTestId('context-usage-spend');
  await expect(spend).toBeVisible();
  // 0.5 USD at the pinned rate: the ₮ figure is arithmetic, not a live quote.
  await expect(spend).toContainText('1,790₮');

  // WHAT SITS IN THE WINDOW IS INPUT. The frame above reports 140K in and 12K
  // out; the old code added them and drew 152K, overstating the fill by 8.6%.
  // With no `active_window_percent` on this frame the fill falls to the input
  // count: 140_000 of 1_048_576 is 13.4%, leaving 908.6K free.
  await expect(figure).toContainText('13.4%');
  await expect(figure).toContainText('140.0K');
  await expect(figure).toContainText('1.0M');
  // The output tokens must NOT appear as used - that was the whole bug.
  await expect(figure).not.toContainText('152.0K');
  const breakdownText = (await visual.page.getByTestId('context-usage-breakdown').textContent()) ?? '';
  expect(breakdownText).toContain('140.0K');
  // 140.0K + 908.6K = 1048.6K, which rounds to the 1.0M shown as the limit.
  expect(breakdownText).toContain('908.6K');

  // `snap()` is deliberately not used: its `stableScreenshot` needs two
  // byte-identical frames, and the hover has to survive between them. It does -
  // the popover stays mounted - but the plain capture keeps the failure mode
  // ("popover missing") separate from the stability check.
  const shot = await visual.page.screenshot({ animations: 'disabled' });
  fs.writeFileSync(path.join(OUT_DIR, 'context-usage-popover.png'), shot);
  // Still open after the capture: proves the screenshot above photographed the
  // popover rather than an empty composer.
  await expect(figure).toBeVisible();

  // 7. The engine's OWN fill measure outranks our division. A second frame
  //    carrying `active_window_percent` must move the reading to it - proving
  //    the precedence in the BUILT app, not just in jsdom.
  await pushResponseFrame(visual.app, {
    type: 'finish',
    msg_id: 'context-spend-visual-2',
    conversation_id: id as string,
    data: {
      input_tokens: SEEDED_INPUT_TOKENS,
      output_tokens: SEEDED_OUTPUT_TOKENS,
      active_window_percent: 42,
    },
  });
  await expect(figure).toContainText('42.0%', { timeout: 10_000 });
  // 42% of the 1_048_576 window is 440.4K - a figure that can only come from
  // the engine's percentage, never from the 140K input count.
  await expect(figure).toContainText('440.4K');

  fs.writeFileSync(
    path.join(OUT_DIR, 'context-usage-engine-percent.png'),
    await visual.page.screenshot({ animations: 'disabled' })
  );
});

test('constitution page counts tokens with a real tokenizer, not chars/4', async () => {
  await gotoHash(visual.page, '#/settings/constitution');

  const readout = visual.page.getByTestId('constitution-token-count');
  await readout.scrollIntoViewIfNeeded();
  await expect(readout).toBeVisible({ timeout: 15_000 });

  const text = (await readout.textContent()) ?? '';
  // The number must be qualified: an approximation sign, and the name of the
  // tokenizer that produced it. A bare exact-looking figure would be a lie -
  // this is not the provider's own tokenizer.
  expect(text).toContain('≈');
  expect(text.toLowerCase()).toContain('o200k');

  // The measured trap: chars/4 undercounts this Cyrillic document by ~1.6x and
  // reported 1,791 tokens. Anything near that figure means the old estimate is
  // still live somewhere in the renderer.
  expect(text).not.toContain('1,791');
  const digits = text.replace(/[^\d]/g, '');
  expect(Number(digits), `token readout was "${text}"`).toBeGreaterThan(2_000);

  await snap('constitution-token-count');
});

test('backup card renders both actions', async () => {
  await gotoHash(visual.page, '#/settings/storage');

  // Located by the Mongolian labels the running app actually shows. The card's
  // handlers open OS dialogs, which a test cannot drive, so this proves the
  // surface renders - the outcome reporting is covered by the DOM test.
  const exportButton = visual.page.getByRole('button', { name: BACKUP_EXPORT_LABEL });
  await exportButton.scrollIntoViewIfNeeded();
  await expect(exportButton).toBeVisible({ timeout: 15_000 });
  await expect(visual.page.getByRole('button', { name: BACKUP_RESTORE_LABEL })).toBeVisible();

  await snap('backup-card');
});

test('restore asks before it starts, because it relaunches the app', async () => {
  await gotoHash(visual.page, '#/settings/storage');

  const restore = visual.page.getByRole('button', { name: BACKUP_RESTORE_LABEL });
  await restore.scrollIntoViewIfNeeded();
  await restore.click();

  // The confirmation must appear BEFORE the OS file dialog - which is why this
  // click is safe to make in a test at all. If the gate were missing, this step
  // would open a native dialog and hang the run.
  const dialogText = visual.page.getByText(RESTORE_CONFIRM_TITLE);
  await expect(dialogText).toBeVisible({ timeout: 10_000 });

  // THE DIALOG'S OWN BUTTONS MUST BE MONGOLIAN TOO.
  //
  // Arco's static dialogs mount outside the React tree, so they read their
  // locale from a module-level slot that ANY <ConfigProvider> overwrites while
  // `effectGlobalModal` is on - and it defaults to on. GuidPage mounts a
  // provider purely to scope popups and passes no locale, so Arco filled it
  // from its own defaults (zh-CN) and every confirmation in the app rendered
  // 取消 / 确定 beneath Mongolian text. This assertion is the only place that
  // catches it: the static dialogs use the pre-React-18 `ReactDOM.render`, so
  // they cannot be rendered in jsdom at all.
  const modal = visual.page.locator('.arco-modal').first();
  const modalText = (await modal.textContent()) ?? '';
  expect(modalText, 'the confirm dialog rendered Chinese buttons').not.toContain('确定');
  expect(modalText).not.toContain('取消');
  expect(modalText).toContain('Болсон');
  expect(modalText).toContain('Цуцлах');

  await snap('backup-restore-confirm');

  // Leave the app as we found it: decline, and prove the card is usable again.
  await visual.page.getByRole('button', { name: 'Цуцлах' }).click();
  await expect(dialogText).toHaveCount(0, { timeout: 10_000 });
  await expect(restore).toBeVisible();
});

test('sandbox card: collapsed by default, mode picker and enforcement notice after enabling', async () => {
  await gotoHash(visual.page, '#/settings/general');

  const toggle = visual.page.getByTestId('sandbox-enable-switch');
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).toBeVisible();

  // Located by their rendered Mongolian labels, not by role: Arco's Radio.Group
  // in `type='button'` mode keeps the real <input type=radio> permanently
  // hidden behind CSS, so `getByRole('radio')` resolves to an element that can
  // never be visible and the assertion would be unfalsifiable.
  const readOnlyMode = visual.page.getByText(MODE_READ_ONLY, { exact: true });
  const workspaceMode = visual.page.getByText(MODE_WORKSPACE_WRITE, { exact: true });
  const enforcementNotice = visual.page.getByText(PARTIAL_WARNING_PREFIX, { exact: false });

  // Off by default: the mode picker must NOT be on screen yet. Asserting the
  // absence is what makes the "after enabling" shot below mean something.
  await expect(readOnlyMode).toHaveCount(0);
  await expect(enforcementNotice).toHaveCount(0);
  await snap('sandbox-collapsed');

  await toggle.click();
  // Enabling reveals both modes and the honest partial-enforcement notice.
  await expect(readOnlyMode).toBeVisible({ timeout: 10_000 });
  await expect(workspaceMode).toBeVisible();
  await expect(enforcementNotice).toBeVisible();
  await toggle.scrollIntoViewIfNeeded();
  await snap('sandbox-enabled');
});
