/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WCAG AA contrast, measured from live computed styles (category C).
 *
 * Nothing here reads a token file: the probe resolves each text node's actual
 * painted colour and the nearest opaque background behind it, composites any
 * `rgba()` alpha, and compares relative luminance. See `probes/contrast.ts` for
 * the method and its documented approximations.
 *
 * Two rules keep this honest:
 *  - Nodes whose background genuinely cannot be resolved (over a gradient or an
 *    image) are **skipped and counted**, never quietly passed. The skip total is
 *    asserted against total coverage so a run that resolved almost nothing
 *    cannot masquerade as a clean result.
 *  - The 4.5:1 / 3:1 thresholds are fixed. Violations found here are real
 *    findings about the product, not a reason to move the bar.
 */
import { test, expect } from '@playwright/test';
import { launchVisualApp, closeVisualApp, pinNondeterminism, type VisualApp } from './fixture';
import { gotoHash, hideFirstRunOverlay, settleFrozen, withInjectedCss } from './surfaces';
import { CONTRAST_DEFAULTS, formatContrastReport, probeContrast, type ContrastReport } from './probes/contrast';

let visual: VisualApp;

const scan = (root: string): Promise<ContrastReport> =>
  visual.page.evaluate(probeContrast, { root, ...CONTRAST_DEFAULTS });

/**
 * Coverage guard: if most candidates were skipped, a violation count of zero
 * says nothing. Fails loudly instead of reporting a hollow pass.
 */
const expectMeaningfulCoverage = (report: ContrastReport, surface: string): void => {
  expect(report.rootFound, `${surface}: root selector "${report.root}" matched nothing`).toBe(true);
  const total = report.scanned + report.skippedTotal;
  expect(total, `${surface}: no text found at all`).toBeGreaterThan(0);
  expect(
    report.scanned,
    `${surface}: only ${report.scanned} of ${total} text nodes had a resolvable background, ` +
      `so a clean result would be meaningless:\n${formatContrastReport(report)}`
  ).toBeGreaterThan(total / 2);
};

test.beforeAll(async () => {
  visual = await launchVisualApp();
  await pinNondeterminism(visual.page);
  await visual.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await settleFrozen(visual.page);
});

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
});

test.describe('WCAG AA contrast (default theme)', () => {
  test('onboarding overlay text meets AA', async () => {
    const report = await scan('.arco-modal');
    expectMeaningfulCoverage(report, 'onboarding overlay');
    expect(report.violations, `onboarding overlay has text below WCAG AA:\n${formatContrastReport(report)}`).toEqual(
      []
    );
  });

  test('settings screen text meets AA', async () => {
    await hideFirstRunOverlay(visual.page);
    await gotoHash(visual.page, '#/settings/models');
    const report = await scan('body');
    expectMeaningfulCoverage(report, 'settings screen');
    expect(report.violations, `settings screen has text below WCAG AA:\n${formatContrastReport(report)}`).toEqual([]);
  });
});

/**
 * Mutation self-test: proves the contrast probe still fails on genuinely
 * unreadable text, so a future refactor cannot silently turn it into a no-op.
 */
test.describe('WCAG AA contrast: detector is still alive', () => {
  test.beforeEach(async () => {
    await hideFirstRunOverlay(visual.page);
    await gotoHash(visual.page, '#/settings/models');
  });

  test('washed-out sider labels are detected and the finding clears on restore', async () => {
    const target = '.settings-sider__item-label';
    const countFor = (report: ContrastReport): number =>
      report.violations.filter((v) => v.selector.includes('settings-sider__item-label')).length;

    const before = await scan('.settings-sider');
    expect(
      countFor(before),
      `sider labels were already failing AA before the mutation, so this proves nothing:\n` +
        formatContrastReport(before)
    ).toBe(0);

    // #9b9b9b on the #f0f0f0 rail is ~2.4:1 - comfortably unreadable.
    const mutated = await withInjectedCss(visual.page, `${target} { color: #9b9b9b !important; }`, () =>
      scan('.settings-sider')
    );
    expect(
      countFor(mutated),
      `contrast probe did not notice washed-out sider labels:\n${formatContrastReport(mutated)}`
    ).toBeGreaterThan(0);
    for (const violation of mutated.violations.filter((v) => v.selector.includes('settings-sider__item-label'))) {
      expect(violation.ratio, 'mutated label should be far below AA').toBeLessThan(3);
    }

    const restored = await scan('.settings-sider');
    expect(
      countFor(restored),
      `contrast finding survived removal of the mutation:\n${formatContrastReport(restored)}`
    ).toBe(0);
  });
});
