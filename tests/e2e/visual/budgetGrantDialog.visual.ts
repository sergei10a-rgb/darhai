/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eyes on the budget-grant dialog, in the real app.
 *
 * This is the one surface of the engine-capability work that had never been
 * seen. `wcoreBudgetGate.ts` is unit-tested, `ToolConfirmationDialog.tsx` is
 * unit-tested, and neither test can tell you whether the Mongolian copy fits
 * its box, whether the two amount rows read as different units, or whether the
 * footer still says "Requested by budget" - the sentence the whole kind exists
 * to remove.
 *
 * WHY THE BUILD GATE IS THE FIRST LINE OF `beforeAll`
 * --------------------------------------------------
 * This suite launches the BUILT app (`electron .` -> `out/renderer/index.html`),
 * while everything imported below runs from current `src/` inside the test
 * process. Left unchecked those are two different snapshots of the repo, and
 * this spec was measured failing exactly that way: deleting the one line that
 * gives this dialog its own footer (`ToolConfirmationDialog.tsx`'s
 * `footer: 'mcp.confirm.budgetGrant.footer'`) left both footer assertions green,
 * because the running renderer had never seen the deletion. `assertBundleShowsSource`
 * names the source this spec claims to be photographing and refuses to run when
 * the bundle predates any of it - so a change to the component under test can
 * once again change the result.
 *
 * WHY THE PAYLOAD IS NOT WRITTEN HERE
 * -----------------------------------
 * The proposal is DERIVED from the engine's own numbers, and deriving it is the
 * part that can be wrong, so this spec must not hand-write it. `resolveBudgetGrant`
 * itself runs - in this process, from `src/` - against the exact `budget_exceeded`
 * the engine reported in the field ("max_tokens_out, observed 8192, limit 4096",
 * quoted in `wcoreBudgetGate.ts`'s own header). Whatever it decides to ask for
 * is what the dialog shows. `t` is deliberately NOT passed, because
 * `WCoreManager` does not pass one either: the main process has no translator,
 * so the payload carries English fallbacks plus `labelKey`s and the RENDERER
 * does the translating. That is precisely the mapping this spec photographs.
 *
 * WHERE THE REQUEST ENTERS THE APP, AND WHAT IS AND IS NOT REAL
 * -------------------------------------------------------------
 * In production `ToolConfirmationService.emitRequest` is
 * `ipcBridge.toolConfirmation.request.emit(request)`, and the adapter turns
 * that into exactly one thing: `webContents.send(ADAPTER_BRIDGE_EVENT_KEY,
 * JSON.stringify({ name, data }))` (`common/adapter/main.ts`). This spec sends
 * that same envelope on that same channel - the same seam `pushResponseFrame`
 * uses for response frames - so the preload, the bridge, the dialog's
 * `request.on` subscription, the kind->chrome mapping and every `labelKey`
 * lookup are the shipped ones.
 *
 * What is NOT real is the main process's pending-request map. It cannot be:
 * the only way into the running service from outside is the loopback gate
 * (`ToolConfirmationTcpServer`), and its `confirm()` copies `label` and `value`
 * ONLY - `labelKey` is dropped on that path by design, because its callers are
 * MCP subprocesses that send English protocol words. A request delivered that
 * way would render "Cap reached (read as a token cap from this name)" instead
 * of the Mongolian this spec exists to look at, i.e. it would photograph
 * something the user never sees. So the request is injected, and the human's
 * press is observed FROM THE APP rather than assumed:
 *
 *   - the press still travels renderer -> main and back. The dialog only shows
 *     its `answerExpired` alert when `respond.invoke` RESOLVED and came back
 *     `{settled: false}`, and only for an approval (`approved && settled ===
 *     false`). Seeing that alert is proof the press crossed the process
 *     boundary with `approved: true`; the main service answered "I do not hold
 *     that id", which is the truth here and nowhere else.
 *   - a Cancel press takes the row down with no alert, because a refusal that
 *     did not arrive is still a refusal.
 *
 * Downstream of the press everything is real again: the outcome goes back into
 * `resolveBudgetGrant`, which calls the real `sendContinueWithBudget`, which
 * builds the real `continue_with_budget` command through the only sanctioned
 * constructor. The spec asserts the command that came out - so a press here
 * produces the same bytes a press in the field would.
 *
 * WHAT "VISUAL" MEANS HERE, EXACTLY
 * ---------------------------------
 * Two different things, and it is worth not confusing them:
 *   - The two settled states are pixel-compared against committed baselines
 *     under `__baselines__/{platform}/` (`toMatchSnapshot`), the same mechanism
 *     `modelsSettings` and `onboardingScreens` already use. A later run diffs
 *     them; nobody has to remember to look.
 *   - The transient states are captured to `tests/e2e/screenshots/wave4/`, which
 *     is gitignored, and exist for a human to open once. They are evidence, not
 *     a gate, and nothing here pretends otherwise.
 * Everything a machine must keep true is a DOM or geometry assertion below.
 */

import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import {
  assertBundleShowsSource,
  launchVisualApp,
  closeVisualApp,
  stabilize,
  stableScreenshot,
  type VisualApp,
} from './fixture';
import { openWCoreConversation } from './surfaces';
import { resolveBudgetGrant } from '@process/task/wcoreBudgetGate';
import type { BudgetGrantDecision, EngineBudgetRequest } from '@process/task/wcoreBudgetGate';
import { sendContinueWithBudget } from '@process/agent/wcore/capabilities/handlers/budgetGrants';
import type { CapabilityContext } from '@process/agent/wcore/capabilities/types';
import type { ToolConfirmationRequestInput } from '@process/services/toolConfirmation/types';
import { ADAPTER_BRIDGE_EVENT_KEY } from '@/common/adapter/constant';
import mcpMn from '@renderer/services/i18n/locales/mn-MN/mcp.json';

const OUT_DIR = path.resolve(__dirname, '..', 'screenshots', 'wave4');

/**
 * The source this spec asserts about, and therefore the source the running
 * bundle has to contain. Every entry earns its place:
 *  - the dialog itself paints the copy, the rows and the footer;
 *  - `DarhaiModal` owns the scrolling body box and the width this spec measures
 *    the Mongolian against;
 *  - the mn-MN `mcp` bundle is where the expected strings are READ from, so a
 *    locale edit that the bundle has not picked up would compare new copy
 *    against an old screen.
 */
const SOURCE_UNDER_TEST = [
  'src/renderer/components/agent/ToolConfirmationDialog.tsx',
  'src/renderer/components/base/DarhaiModal.tsx',
  'src/renderer/services/i18n/locales/mn-MN/mcp.json',
] as const;

/**
 * Expected copy is READ from the locale file, never retyped.
 *
 * A retyped Mongolian sentence in a test is a second source of truth that drifts
 * silently; reading the shipped key means the assertion says what it means -
 * "the app rendered the mn-MN string for THIS key in THIS slot".
 */
const MN = mcpMn.confirm;
const MN_BUDGET = MN.budgetGrant;

/**
 * The tightest box the app's own scale range can produce, in CSS pixels.
 *
 * `DarhaiModal` divides its preset width by the user's font scale
 * (`scaleDimension`: `value / safeScale`) while the copy keeps its CSS size, so
 * the text-to-box ratio TIGHTENS as the user scales up. `MODAL_SIZES.large` is
 * 800px and `useFontScale` caps the scale at 1.3, so the narrowest this dialog
 * is ever laid out at is 800/1.3 CSS px - roughly 23% less room for the same
 * Mongolian strings. `scrollWidth`/`clientWidth` are CSS-pixel measurements and
 * the zoom factor scales both equally, so narrowing the box to this width at
 * scale 1 reproduces the scale-1.3 geometry exactly rather than approximating it.
 */
const MODAL_WIDTH_AT_SCALE_1 = '800px';
const UI_SCALE_MAX = 1.3;
const TIGHTEST_MODAL_WIDTH_PX = 800 / UI_SCALE_MAX;

let visual: VisualApp;

test.beforeAll(async () => {
  // Before anything else: a stale bundle would make every assertion below
  // describe code that is no longer in the repo. See the module header.
  assertBundleShowsSource(SOURCE_UNDER_TEST);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  visual = await launchVisualApp();
  // Same trick as wave4Surfaces/modelsSettings: a rejected detection makes
  // `useOnboardingDetection` render no overlay, so nothing covers the modal.
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

/**
 * Capture the screen, having first proved there is a dialog on it.
 *
 * The presence check is structural on purpose. A byte floor cannot do this job:
 * MEASURED over this suite's own output (`tests/e2e/screenshots/wave4/`), the
 * smallest full-window capture on disk is 81 KB and none of them depends on a
 * modal being up, so any threshold a real screen clears is a threshold a run
 * with no dialog clears too. The remaining byte assertion is only what its name
 * says - the screenshot call came back with an image rather than nothing.
 *
 * `stableScreenshot` rather than `page.screenshot`: it captures twice 700ms
 * apart and requires the two to be byte-identical, so a screen that cannot
 * reproduce itself is reported as unstable instead of being frozen into a
 * baseline.
 */
async function shoot(name: string): Promise<Buffer> {
  const dialogs = await visual.page.locator('.arco-modal .darhai-modal-wrapper').count();
  expect(dialogs, `${name}: there was no dialog on screen to photograph`).toBeGreaterThan(0);

  const buffer = await stableScreenshot(visual.page);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), buffer);
  expect(buffer.byteLength, `${name}: the screenshot call returned no image`).toBeGreaterThan(1_000);
  return buffer;
}

/** Put one `toolConfirmation.request` on the renderer's bridge, through the real wire. */
async function pushConfirmationRequest(input: ToolConfirmationRequestInput, requestId: string): Promise<void> {
  await visual.app.evaluate(
    ({ BrowserWindow }, wire: { channel: string; payload: string }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(wire.channel, wire.payload);
        }
      }
    },
    {
      channel: ADAPTER_BRIDGE_EVENT_KEY,
      payload: JSON.stringify({
        name: 'toolConfirmation.request',
        // The service adds exactly one field to what the gate asked for.
        data: { ...input, details: [...input.details], requestId },
      }),
    }
  );
}

/**
 * Wait for a human-equivalent press, read off the app rather than assumed.
 *
 * See the module header for why each branch means what it says.
 */
async function waitForPress(page: Page, timeoutMs = 60_000): Promise<'approved' | 'declined'> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Sequential by nature: this polls one page for a state change. Same shape
    // (and same exemption) as `waitForSettle` in the fixture.
    // eslint-disable-next-line no-await-in-loop
    const state = await page
      .evaluate(
        (copy: { title: string; expired: string }) => {
          const text = document.body?.innerText ?? '';
          if (text.includes(copy.expired)) return 'approved';
          return text.includes(copy.title) ? 'open' : 'gone';
        },
        { title: MN_BUDGET.title, expired: MN.answerExpired }
      )
      .catch(() => 'open');
    if (state === 'approved') return 'approved';
    if (state === 'gone') return 'declined';
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('visual: no press was observed on the budget dialog within 60s');
}

/** A capability context that records what would go on the wire. */
function recordingContext(commands: Array<Record<string, unknown>>, warnings: string[]): CapabilityContext {
  return {
    sendCommand: (command) => {
      commands.push(command as Record<string, unknown>);
    },
    emit: () => undefined,
    activeMsgId: () => 'visual-budget-turn',
    log: () => undefined,
    warn: (message) => {
      warnings.push(message);
    },
  };
}

type RaisedDialog = {
  /** What the gate asked the dialog for - the derived payload, not a written one. */
  input: ToolConfirmationRequestInput;
  /** Resolves when the press this spec makes has been answered end to end. */
  decision: Promise<BudgetGrantDecision>;
  /** Commands `sendContinueWithBudget` actually wrote. */
  commands: Array<Record<string, unknown>>;
  /** Anything the send path warned about. Empty is the healthy answer. */
  warnings: string[];
};

/**
 * Run the REAL gate for one `budget_exceeded` and get its dialog on screen.
 *
 * Returns before the press: the caller photographs the dialog, presses, and
 * then awaits `decision`.
 */
async function raiseBudgetDialog(request: EngineBudgetRequest): Promise<RaisedDialog> {
  // Requests QUEUE, and a queued one is invisible: if a previous test left its
  // dialog up, everything below would measure that dialog while believing it
  // measured this one. Say so instead.
  await expect(
    visual.page.getByText(MN_BUDGET.title, { exact: false }),
    'a budget dialog was already on screen before this test raised one'
  ).toHaveCount(0);

  const commands: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const ctx = recordingContext(commands, warnings);
  const inputs: ToolConfirmationRequestInput[] = [];

  const decision = resolveBudgetGrant(request, {
    confirm: async (input) => {
      inputs.push(input);
      const requestId = `visual-${randomUUID()}`;
      await pushConfirmationRequest(input, requestId);
      const press = await waitForPress(visual.page);
      return press === 'approved'
        ? { approved: true, requestId, fingerprint: input.fingerprint }
        : { approved: false, requestId, reason: 'declined', message: 'The user pressed Cancel, so nothing was done.' };
    },
    grant: (input) => sendContinueWithBudget(ctx, input, () => true),
  });

  // The dialog has to actually come up. Without this the spec would photograph
  // whatever was on screen and call it a budget dialog.
  await expect(visual.page.getByText(MN_BUDGET.title, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  if (inputs.length !== 1) {
    throw new Error(`visual: the gate raised ${inputs.length} dialogs for one budget_exceeded`);
  }
  return { input: inputs[0], decision, commands, warnings };
}

/** Every labelled row of the dialog, as the user reads it. */
async function readDetailRows(page: Page): Promise<Array<{ label: string; value: string }>> {
  return page.evaluate(() => {
    const modal = document.querySelector('.arco-modal');
    if (!modal) return [];
    return Array.from(modal.querySelectorAll('dl > div')).map((row) => ({
      label: (row.querySelector('dt') as HTMLElement)?.innerText?.trim() ?? '',
      value: (row.querySelector('dd') as HTMLElement)?.innerText?.trim() ?? '',
    }));
  });
}

/**
 * The footer line that answers "what asked for this?".
 *
 * `DarhaiModal` passes `footer={null}` to Arco and renders its own, so there is
 * no `.arco-modal-footer` to read - the note is the first span of the last child
 * of `.darhai-modal-wrapper`. Measured: reading the Arco class returned an empty
 * string, which would have passed a `not.toContain` check while proving nothing.
 */
async function readFooterNote(page: Page): Promise<string> {
  return page.evaluate(() => {
    const wrapper = document.querySelector('.arco-modal .darhai-modal-wrapper');
    const footer = wrapper?.lastElementChild;
    return ((footer?.querySelector('span') as HTMLElement)?.innerText ?? '').trim();
  });
}

/**
 * Anything inside the dialog whose text is wider than the box holding it.
 *
 * This is the Mongolian-fit check, and it is measured rather than eyeballed:
 * Mongolian runs roughly 20-40% longer than the English these boxes were sized
 * for, so a row that fits in en-US can still spill here.
 *
 * `widthPx` is passed so the same scan can run at the narrowest width the app's
 * font-scale range produces; see {@link TIGHTEST_MODAL_WIDTH_PX}. The width is
 * restored before returning, so a caller measuring the tight case does not
 * leave the next assertion (or the next screenshot) looking at a squeezed modal.
 */
async function findHorizontalOverflow(page: Page, widthPx?: number): Promise<{ width: string; offenders: string[] }> {
  return page.evaluate((narrowTo: number | undefined) => {
    const modal = document.querySelector('.arco-modal') as HTMLElement;
    if (!modal) return { width: '', offenders: ['no modal on screen'] };

    const originalWidth = modal.style.width;
    if (narrowTo !== undefined) modal.style.width = `${narrowTo}px`;

    const offenders: string[] = [];
    const nodes = [modal, ...Array.from(modal.querySelectorAll('dt, dd, p, span, button'))];
    nodes.forEach((el, index) => {
      const element = el as HTMLElement;
      if (element.clientWidth === 0) return;
      if (element.scrollWidth > element.clientWidth + 1) {
        offenders.push(`${element.tagName}#${index} ${element.scrollWidth}>${element.clientWidth}`);
      }
    });

    if (narrowTo !== undefined) modal.style.width = originalWidth;
    return { width: originalWidth, offenders };
  }, widthPx);
}

/**
 * How the scrolling content box is sitting.
 *
 * Three different questions, all about a dialog that spends money:
 *  - `found`: is there a body box at all? Without this the "no box" path would
 *    return a shape that reads as "nothing is wrong" on a screen with no dialog.
 *  - `grantAmountFullyVisible`: is the LAST row - the amount about to be
 *    granted - inside the box without scrolling? A spend dialog whose figure
 *    starts below the fold invites a press on an unread number.
 *  - `overflowing` / `scrollable`: when the content IS taller than its box, can
 *    the user actually reach the rest? Content that overflows a box with
 *    `overflow: hidden` is not scrolled, it is gone.
 */
async function measureContentFit(page: Page): Promise<{
  found: boolean;
  grantAmountFullyVisible: boolean;
  hiddenPx: number;
  overflowing: boolean;
  scrollable: boolean;
}> {
  return page.evaluate(() => {
    const box = document.querySelector('.arco-modal .darhai-modal-body-content') as HTMLElement;
    if (!box) {
      return { found: false, grantAmountFullyVisible: false, hiddenPx: -1, overflowing: false, scrollable: false };
    }
    const rows = Array.from(box.querySelectorAll('dl > div'));
    const last = rows[rows.length - 1] as HTMLElement;
    const boxRect = box.getBoundingClientRect();
    const rowRect = last?.getBoundingClientRect();
    const overflowY = getComputedStyle(box).overflowY;
    return {
      found: true,
      grantAmountFullyVisible: rowRect ? rowRect.bottom <= boxRect.bottom + 1 : false,
      hiddenPx: rowRect ? Math.max(0, Math.round(rowRect.bottom - boxRect.bottom)) : -1,
      overflowing: box.scrollHeight > box.clientHeight + 1,
      scrollable: overflowY === 'auto' || overflowY === 'scroll',
    };
  });
}

/**
 * Reach the bottom of the dialog the way a person does: with the wheel.
 *
 * Deliberately NOT `box.scrollTop = box.scrollHeight`. Programmatic scrolling
 * works on an `overflow: hidden` box too, so a scrollTop assignment would
 * "prove" reachability on a box no human can move - the exact failure this is
 * here to catch. A wheel event over the box is refused by `overflow: hidden`
 * and honoured by `overflow: auto`, so what it measures is what the user gets.
 */
async function wheelContentToBottom(page: Page): Promise<{ scrolledPx: number; lastRowFullyVisible: boolean }> {
  const box = await page.evaluate(() => {
    const el = document.querySelector('.arco-modal .darhai-modal-body-content') as HTMLElement;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  });
  if (!box) return { scrolledPx: -1, lastRowFullyVisible: false };

  await page.mouse.move(box.x, box.y);
  // Three notches of a generous wheel: more than the ~37px measured overrun and
  // more than any plausible growth of it, and a box that is already at its end
  // simply stays there.
  for (let i = 0; i < 3; i++) {
    // eslint-disable-next-line no-await-in-loop
    await page.mouse.wheel(0, 400);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  return page.evaluate(() => {
    const el = document.querySelector('.arco-modal .darhai-modal-body-content') as HTMLElement;
    if (!el) return { scrolledPx: -1, lastRowFullyVisible: false };
    const rows = Array.from(el.querySelectorAll('dl > div'));
    const last = rows[rows.length - 1] as HTMLElement;
    const boxRect = el.getBoundingClientRect();
    const rowRect = last?.getBoundingClientRect();
    return {
      scrolledPx: Math.round(el.scrollTop),
      lastRowFullyVisible: rowRect ? rowRect.bottom <= boxRect.bottom + 1 : false,
    };
  });
}

/**
 * Assert the whole content is reachable, whatever shape the dialog is in.
 *
 * Both branches assert something, on purpose. The check this replaces was
 * `expect(overflowing === true && scrollable === false).toBe(false)`, which no
 * state of the app could fail - `scrollable` is pinned true by the component,
 * and the no-box path set both operands so the conjunction was false there too.
 * MEASURED with an adversarial probe: the alert state returns
 * `{overflowing: true, scrollable: true}`, i.e. `true && false` -> `false`,
 * which is exactly what that assertion demanded.
 */
async function assertEverythingIsReachable(page: Page, where: string): Promise<void> {
  const fit = await measureContentFit(page);
  expect(fit.found, `${where}: there was no dialog body box on screen to measure`).toBe(true);
  // The one property that decides whether anything past the box edge exists for
  // the user at all. Flip `ToolConfirmationDialog`'s `contentStyle.overflow` to
  // 'hidden' and this goes red.
  expect(fit.scrollable, `${where}: the dialog body is not a scrolling box, so anything past its edge is gone`).toBe(
    true
  );

  if (fit.overflowing === true) {
    const reached = await wheelContentToBottom(page);
    expect(
      reached.scrolledPx,
      `${where}: the wheel did not move the dialog body, so the rest is out of reach`
    ).toBeGreaterThan(0);
    expect(
      reached.lastRowFullyVisible,
      `${where}: scrolling to the end still did not bring the granted amount fully on screen`
    ).toBe(true);
  } else {
    expect(
      fit.grantAmountFullyVisible,
      `${where}: nothing overflows yet the granted amount is ${fit.hiddenPx}px below the fold`
    ).toBe(true);
  }
}

/**
 * The token cap: the engine's own reported overrun, all the way to the wire.
 *
 * 8192 / 4096 is not a number this spec chose - it is what `WCoreAgent` printed
 * before any of this existed, quoted in both `wcoreBudgetGate.ts` and
 * `budgetGrants.ts`.
 */
test('budget grant dialog - token cap, granted', async () => {
  await openWCoreConversation(visual.page);

  const raised = await raiseBudgetDialog({ reason: 'max_tokens_out', observed: '8192', limit: '4096' });

  // The payload really is the derived one, and it is the budget KIND - which is
  // what makes the renderer use budget chrome instead of a tool's own strings.
  expect(raised.input.kind).toBe('agent.budgetGrant');
  expect(raised.input.toolName).toBe('max_tokens_out');
  expect(raised.input.details.map((detail) => detail.labelKey)).toEqual([
    'mcp.confirm.budgetGrant.reasonTokens',
    'mcp.confirm.budgetGrant.observedTokens',
    'mcp.confirm.budgetGrant.limitTokens',
    'mcp.confirm.budgetGrant.grantTokens',
  ]);

  await stabilize(visual.page);

  // Every row is the Mongolian for its key, and every amount names its unit.
  // Reading them back as a whole table is deliberate: the failure this catches
  // is a row whose LABEL says one unit while its neighbour says another.
  expect(await readDetailRows(visual.page)).toEqual([
    { label: MN_BUDGET.reasonTokens, value: 'max_tokens_out' },
    { label: MN_BUDGET.observedTokens, value: '8192' },
    { label: MN_BUDGET.limitTokens, value: '4096' },
    { label: MN_BUDGET.grantTokens, value: '4096' },
  ]);

  // No tool asked for this, so the footer must not name one. `toolLabel` would
  // render "max_tokens_out хүсэлт гаргав" - the "Requested by budget" line.
  const footer = await readFooterNote(visual.page);
  expect(footer).toBe(MN_BUDGET.footer);
  expect(footer).not.toContain('max_tokens_out');

  // Fit, at the width the app actually lays this out at...
  const asShipped = await findHorizontalOverflow(visual.page);
  expect(
    asShipped.width,
    'the large modal is no longer 800px, so the tight-scale width below is derived from a stale number'
  ).toBe(MODAL_WIDTH_AT_SCALE_1);
  expect(asShipped.offenders).toEqual([]);

  // ...and at the narrowest width its font-scale range can produce, which is
  // where Mongolian runs out of room first. See TIGHTEST_MODAL_WIDTH_PX.
  const atTightestScale = await findHorizontalOverflow(visual.page, TIGHTEST_MODAL_WIDTH_PX);
  expect(
    atTightestScale.offenders,
    `Mongolian copy spills its box at UI scale ${UI_SCALE_MAX} (${Math.round(TIGHTEST_MODAL_WIDTH_PX)}px)`
  ).toEqual([]);

  // The figure being granted must be on screen when the dialog opens, not one
  // scroll below the Grant button.
  const fit = await measureContentFit(visual.page);
  expect(fit.found, 'the dialog body box was not on screen when the dialog opened').toBe(true);
  expect(fit.grantAmountFullyVisible, `the granted amount sits ${fit.hiddenPx}px below the fold`).toBe(true);

  expect(await shoot('budget-grant-tokens')).toMatchSnapshot('budget-grant-tokens.png');

  // Press Grant. Everything from here is the shipped path again.
  await visual.page.getByRole('button', { name: MN_BUDGET.confirm, exact: true }).click();

  const decision = await raised.decision;
  expect(decision.approved).toBe(true);
  expect(decision.granted).toBe(true);
  // The bytes a press produces. `additional_cost_usd` must be absent, not 0:
  // the command is `additionalProperties: false` with an `anyOf`, and a token
  // grant that also carried a zero cost is a different message.
  expect(raised.commands).toEqual([
    { type: 'continue_with_budget', request_id: decision.requestId, additional_tokens: 4096 },
  ]);
  expect(raised.warnings).toEqual([]);

  // The press crossed to main and came back unheld, so the dialog says so
  // rather than closing on a grant it cannot vouch for. Photograph that too -
  // it is the state a user meets when the engine died before they answered.
  await expect(visual.page.getByText(MN.answerExpired, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await stabilize(visual.page);

  // The alert is ~100px of new copy above rows that already filled the box, so
  // the last row goes below the fold here - MEASURED at 37px on this run. That
  // is the design ("long values scroll; they are never elided"). What must NOT
  // happen is content going below the fold of a box nobody can scroll, and the
  // wheel inside this call is what proves nobody is stuck.
  //
  // The capture below shows the state as it opens: clipped, and - because the
  // fixture launches with `--hide-scrollbars` so captures are host-independent -
  // with no scrollbar drawn. The real app draws one; the reachability assertion
  // is what stands behind that claim, not the PNG.
  await shoot('budget-grant-answer-not-held');
  await assertEverythingIsReachable(visual.page, 'answer-not-held');
  await shoot('budget-grant-answer-not-held-scrolled');

  // Leave the screen clean for the next test.
  await visual.page.getByRole('button', { name: MN.cancel, exact: true }).click();
  await expect(visual.page.getByText(MN_BUDGET.title, { exact: false })).toHaveCount(0, { timeout: 20_000 });
});

/**
 * The money cap, refused.
 *
 * US$2.50 is the contract's own example grant (`commands/continue_with_budget.json`),
 * reached here the only way the gate allows - as the overrun the engine reported.
 */
test('budget grant dialog - US$ cap, cancelled', async () => {
  const raised = await raiseBudgetDialog({ reason: 'max_cost_usd', observed: '2.75', limit: '0.25' });

  expect(raised.input.details.map((detail) => detail.labelKey)).toEqual([
    'mcp.confirm.budgetGrant.reasonCost',
    'mcp.confirm.budgetGrant.observedCost',
    'mcp.confirm.budgetGrant.limitCost',
    'mcp.confirm.budgetGrant.grantCost',
  ]);

  await stabilize(visual.page);

  // The same four rows, in money. Side by side with the token test this is the
  // whole point: a reader must never have to guess which unit is on screen.
  expect(await readDetailRows(visual.page)).toEqual([
    { label: MN_BUDGET.reasonCost, value: 'max_cost_usd' },
    { label: MN_BUDGET.observedCost, value: '2.75' },
    { label: MN_BUDGET.limitCost, value: '0.25' },
    { label: MN_BUDGET.grantCost, value: '2.5' },
  ]);
  expect(await readFooterNote(visual.page)).toBe(MN_BUDGET.footer);

  expect((await findHorizontalOverflow(visual.page)).offenders).toEqual([]);
  const atTightestScale = await findHorizontalOverflow(visual.page, TIGHTEST_MODAL_WIDTH_PX);
  expect(
    atTightestScale.offenders,
    `Mongolian money copy spills its box at UI scale ${UI_SCALE_MAX} (${Math.round(TIGHTEST_MODAL_WIDTH_PX)}px)`
  ).toEqual([]);

  const fit = await measureContentFit(visual.page);
  expect(fit.found, 'the dialog body box was not on screen when the money dialog opened').toBe(true);
  expect(fit.grantAmountFullyVisible, `the granted amount sits ${fit.hiddenPx}px below the fold`).toBe(true);

  expect(await shoot('budget-grant-cost')).toMatchSnapshot('budget-grant-cost.png');

  // Closing is refusing, and refusing must spend nothing.
  await visual.page.getByRole('button', { name: MN.cancel, exact: true }).click();

  const decision = await raised.decision;
  expect(decision.granted).toBe(false);
  expect(decision.approved).toBeFalsy();
  expect(raised.commands).toEqual([]);
  expect(raised.warnings).toEqual([]);
});
