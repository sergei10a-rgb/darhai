/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Does the Mongolian UI physically fit? (categories A and B)
 *
 * Mongolian Cyrillic runs ~30-50% longer than the English these layouts were
 * built for, so a translated label can outgrow a box that was never resized.
 * A screenshot baseline cannot separate "this text changed" from "this text is
 * now unreadable", so every assertion here measures the live DOM instead - see
 * `probes/overflow.ts` for the full policy on what counts as a defect and which
 * intentional truncations are deliberately ignored.
 *
 * The narrow-window block re-runs the same measurement after really resizing
 * the Electron window, because a button pair that fits at 1280px is not
 * evidence that it fits at 760px.
 */
import { test, expect } from '@playwright/test';
import { launchVisualApp, closeVisualApp, pinNondeterminism, type VisualApp } from './fixture';
import {
  NARROW_VIEWPORTS,
  SIDER_TOGGLE,
  ensureSiderExpanded,
  gotoHash,
  hideFirstRunOverlay,
  setContentSize,
  settleFrozen,
  withInjectedCss,
} from './surfaces';
import {
  OVERFLOW_DEFAULTS,
  formatOverflowReport,
  probeOverflow,
  type OverflowFinding,
  type OverflowReport,
} from './probes/overflow';
import { VIEWPORT } from './fixture';

let visual: VisualApp;

const scan = (root: string): Promise<OverflowReport> =>
  visual.page.evaluate(probeOverflow, { root, ...OVERFLOW_DEFAULTS });

/** Assert a surface is clean, printing the full measurement when it is not. */
const expectNoOverflow = (report: OverflowReport, surface: string): void => {
  expect(report.rootFound, `${surface}: root selector "${report.root}" matched nothing`).toBe(true);
  expect(report.findings, `${surface} has clipped/overflowing text:\n${formatOverflowReport(report)}`).toEqual([]);
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

test.describe('Mongolian text fit: first run', () => {
  test('onboarding overlay headlines and sub-lines are not clipped', async () => {
    // Runs first, while the overlay is still up: it opens by itself on a fresh
    // profile and is the only screen a brand-new user is guaranteed to see.
    const report = await scan('.arco-modal');
    // Guard the premise - a silently-absent overlay would "pass" trivially.
    expect(
      report.scanned,
      `onboarding overlay rendered no measurable text:\n${formatOverflowReport(report)}`
    ).toBeGreaterThan(0);
    expectNoOverflow(report, 'onboarding overlay');
  });
});

test.describe('Mongolian text fit: main surfaces at 1280x800', () => {
  // Per-test rather than once: the collapse toggle and the mobile breakpoint
  // can both move the app off this route, and measuring the wrong screen would
  // pass for the wrong reason.
  test.beforeEach(async () => {
    await hideFirstRunOverlay(visual.page);
    await gotoHash(visual.page, '#/settings/models');
    await ensureSiderExpanded(visual.page);
  });

  test('titlebar brand tagline fits beside the lockup', async () => {
    const report = await scan('.app-titlebar');
    // The tagline is `display:none` below 900px (titlebar.css:159), so at the
    // baseline width it must be present - otherwise this test proves nothing.
    const taglineVisible = await visual.page.evaluate(() => {
      const el = document.querySelector('.app-titlebar__brand-tagline');
      return el !== null && el.getBoundingClientRect().width > 1;
    });
    expect(taglineVisible, 'brand tagline is not rendered at 1280px, so its fit was never measured').toBe(true);
    expectNoOverflow(report, 'titlebar');
  });

  test('settings sider fits all 19 localized tab labels', async () => {
    const report = await scan('.settings-sider');
    const labelCount = await visual.page.evaluate(() => document.querySelectorAll('[data-settings-id]').length);
    expect(labelCount, 'settings sider rendered no tabs').toBeGreaterThanOrEqual(19);
    expectNoOverflow(report, 'settings sider');
  });

  test('settings sider collapsed rail hides labels instead of clipping them', async () => {
    const toggle = visual.page.locator(SIDER_TOGGLE).first();
    await toggle.click();
    await settleFrozen(visual.page);
    try {
      const collapsed = await visual.page.evaluate(() => document.querySelector('.settings-sider--collapsed') !== null);
      expect(collapsed, 'clicking the titlebar toggle did not collapse the sider').toBe(true);
      const report = await scan('.settings-sider');
      // The collapsed rail is only safe because it stops rendering labels
      // entirely; assert that rather than just "no findings", which a rail that
      // rendered nothing at all would also satisfy.
      const renderedLabels = await visual.page.evaluate(
        () =>
          Array.from(document.querySelectorAll('.settings-sider__item-label')).filter(
            (el) => el.getBoundingClientRect().width > 1
          ).length
      );
      expect(renderedLabels, 'collapsed rail still paints labels; they would be clipped').toBe(0);
      expectNoOverflow(report, 'settings sider (collapsed)');
    } finally {
      await ensureSiderExpanded(visual.page);
    }
  });

  test('OmniRoute gateway card keeps its tag pill and progress line intact', async () => {
    const report = await scan('[data-testid="omniroute-gateway-card"]');
    expect(report.scanned, 'OmniRoute card rendered no measurable text').toBeGreaterThan(0);
    expectNoOverflow(report, 'OmniRoute gateway card');
  });

  test('whole settings screen has no clipped text or colliding button rows', async () => {
    expectNoOverflow(await scan('body'), 'settings screen (full sweep)');
  });
});

test.describe('Mongolian text fit: narrow windows', () => {
  for (const size of NARROW_VIEWPORTS) {
    test(`settings screen survives ${size.width}x${size.height}`, async () => {
      await setContentSize(visual.app, size);
      // Re-assert the route rather than inheriting it: resizing into the mobile
      // breakpoint can move the app off the settings screen, and a sweep of the
      // wrong screen would be a silently meaningless pass.
      await gotoHash(visual.page, '#/settings/models');
      const report = await scan('body');
      expect(report.viewport.width, 'window did not actually resize').toBe(size.width);
      expectNoOverflow(report, `settings screen @ ${size.width}x${size.height}`);
    });
  }

  test.afterAll(async () => {
    await setContentSize(visual.app, VIEWPORT);
    await settleFrozen(visual.page);
  });
});

/**
 * Mutation self-tests.
 *
 * A detector that has quietly rotted into a no-op looks exactly like a healthy
 * one on a clean app. These break the layout on purpose, confirm the probe
 * notices, then restore it and confirm it goes quiet again - so the suite keeps
 * proving it can still fail, on every run, without touching app source.
 */
test.describe('Mongolian text fit: detector is still alive', () => {
  test.beforeEach(async () => {
    await setContentSize(visual.app, VIEWPORT);
    await hideFirstRunOverlay(visual.page);
    await gotoHash(visual.page, '#/settings/models');
    await ensureSiderExpanded(visual.page);
  });

  test('lengthening sider labels is detected as hard clipping', async () => {
    // Simulates the real failure mode - text grew, the rail did not - rather
    // than shrinking a container, which would be a less honest stand-in.
    // 16px is chosen so that even the shortest label ("Тухай") outgrows the
    // rail: at 8px the probe correctly found only the 9 labels that genuinely
    // no longer fit, which is right but makes a fixed threshold brittle.
    const mutated = await withInjectedCss(
      visual.page,
      '.settings-sider__item-label { letter-spacing: 16px !important; }',
      () => scan('.settings-sider')
    );
    const clipped = mutated.findings.filter((f) => f.kind === 'hard-clip');
    expect(
      clipped.length,
      `overflow probe did not notice 19 blown-out sider labels:\n${formatOverflowReport(mutated)}`
    ).toBeGreaterThanOrEqual(15);

    const restored = await scan('.settings-sider');
    expect(
      restored.findings.length,
      `probe stayed noisy after the mutation was removed:\n${formatOverflowReport(restored)}`
    ).toBeLessThan(clipped.length);
  });

  test('over-wide OmniRoute card is detected as sideways pane scroll', async () => {
    const before = await scan('[data-testid="omniroute-gateway-card"]');
    expectNoOverflow(before, 'OmniRoute card (pre-mutation control)');

    const mutated = await withInjectedCss(
      visual.page,
      '[data-testid="omniroute-gateway-card"] { min-width: 1600px !important; }',
      () => scan('body')
    );
    expect(
      mutated.findings.filter((f) => f.kind === 'pane-scroll').length,
      `overflow probe did not notice the settings pane scrolling sideways:\n${formatOverflowReport(mutated)}`
    ).toBeGreaterThan(0);

    const after = await scan('body');
    expect(
      after.findings.filter((f) => f.kind === 'pane-scroll'),
      `pane-scroll finding survived removal of the mutation:\n${formatOverflowReport(after)}`
    ).toEqual([]);
  });

  test('breakage that only appears when narrow is caught only when narrow', async () => {
    // The media query makes this mutation exist *only* below 800px, so passing
    // at 1280 and failing at 760 is proof the narrow pass genuinely re-measures
    // rather than reusing the baseline-width result.
    const css = '@media (max-width: 800px) { [data-testid="omniroute-gateway-card"] { min-width: 900px !important; } }';
    // Compared by kind, not by total: the settings screen currently carries
    // real `hard-clip` defects (see the sider test), and this self-test is
    // about whether the narrow pass *re-measures*, not about those.
    const paneScrolls = (report: OverflowReport): OverflowFinding[] =>
      report.findings.filter((f) => f.kind === 'pane-scroll');

    const wide = await withInjectedCss(visual.page, css, () => scan('body'));
    expect(paneScrolls(wide), `narrow-only mutation should be inert at 1280px:\n${formatOverflowReport(wide)}`).toEqual(
      []
    );

    await setContentSize(visual.app, NARROW_VIEWPORTS[1]);
    await settleFrozen(visual.page);
    try {
      const narrow = await withInjectedCss(visual.page, css, () => scan('body'));
      expect(
        paneScrolls(narrow).length,
        `narrow pass missed breakage that only exists below 800px:\n${formatOverflowReport(narrow)}`
      ).toBeGreaterThan(0);

      const restored = await scan('body');
      expect(
        paneScrolls(restored),
        `narrow pass stayed noisy after the mutation was removed:\n${formatOverflowReport(restored)}`
      ).toEqual([]);
    } finally {
      await setContentSize(visual.app, VIEWPORT);
      await settleFrozen(visual.page);
    }
  });
});
