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
  openWCoreConversation,
  pushResponseFrame,
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

/**
 * The composer's tool row, at the widths where a 33-character badge bites.
 *
 * This row was the one surface on the conversation screen that nothing
 * measured. It carries three localized controls side by side - attach, the
 * permission-mode selector, and the engine's effective-policy badge - and the
 * badge is the longest string of the thirteen locales: mn-MN renders
 * "Хөдөлгүүр: Ухаалаг / Бүрд нь асуух" (33 chars) where en-US renders
 * "Engine: smart / prompt" (22). An Arco `Tag` is `white-space: nowrap`, so it
 * cannot shrink; the only question is whether the row gives.
 *
 * The badge only exists once the engine has published a receipt, so the frame
 * is pushed down the real response stream (`pushResponseFrame`) rather than
 * faked into the DOM - the component, its copy and its layout are all the real
 * ones, and only the engine that would have produced the frame is absent.
 */
test.describe('Mongolian text fit: conversation composer', () => {
  const TOOLS_ROW = '[data-testid="wcore-sendbox-tools"]';

  /** Open a conversation and give it the badge's frame. Returns nothing useful. */
  async function openComposerWithBadge(): Promise<void> {
    const conversationId = await openWCoreConversation(visual.page);
    await pushResponseFrame(visual.app, {
      type: 'execution_policy',
      msg_id: '',
      conversation_id: conversationId,
      data: {
        verdict: 'gap',
        stale: true,
        detail: 'revision 7 skips 2 revision(s) after 4',
        announcedRevision: 7,
        announcedReason: 'mode_change',
        announcedEffectiveAtUnixMs: 1721000000000,
        appliedRevision: 4,
        policy: {
          posture: 'smart',
          approvals: 'prompt',
          sandbox: 'bypass',
          source: 'desktop_local_launch',
          managed_floor_active: true,
        },
      },
    });
    await visual.page.locator('[data-testid="execution-policy-badge"]').first().waitFor({ timeout: 15_000 });
    await settleFrozen(visual.page);
  }

  /**
   * How far any control in the row sticks out past the row's own box.
   *
   * The overflow probe answers "is text CLIPPED", and this row does not clip -
   * nothing in its ancestor chain sets `overflow: hidden`, so a control that
   * does not fit simply paints outside the composer and the probe stays
   * (correctly) quiet. Containment is therefore measured directly: it is the
   * property that actually holds the row together, and it is the one a
   * nowrap Arco `Tag` breaks.
   */
  function overhangPx(): Promise<number> {
    return visual.page.evaluate((selector: string) => {
      const row = document.querySelector(selector);
      if (!row) return -1;
      const box = row.getBoundingClientRect();
      let worst = 0;
      for (const child of Array.from(row.children)) {
        const rect = child.getBoundingClientRect();
        if (rect.width < 1 && rect.height < 1) continue;
        worst = Math.max(worst, rect.right - box.right, box.left - rect.left);
      }
      return worst;
    }, TOOLS_ROW);
  }

  /** The badge has to actually be on screen, or the scan measures the wrong row. */
  async function expectBadgeMounted(where: string): Promise<void> {
    const width = await visual.page.evaluate(() => {
      const el = document.querySelector('[data-testid="execution-policy-badge"]');
      return el === null ? 0 : el.getBoundingClientRect().width;
    });
    expect(width, `${where}: the policy badge is not rendered, so its fit was never measured`).toBeGreaterThan(1);
  }

  test.beforeAll(async () => {
    await setContentSize(visual.app, VIEWPORT);
    await openComposerWithBadge();
  });

  test.afterAll(async () => {
    await setContentSize(visual.app, VIEWPORT);
    await settleFrozen(visual.page);
  });

  test('the tool row fits at the baseline width', async () => {
    await expectBadgeMounted('1280px');
    const report = await scan(TOOLS_ROW);
    expect(report.scanned, 'the composer tool row rendered no measurable text').toBeGreaterThan(0);
    expectNoOverflow(report, 'composer tool row @ 1280px');
  });

  for (const size of NARROW_VIEWPORTS) {
    test(`the tool row survives ${size.width}x${size.height}`, async () => {
      await setContentSize(visual.app, size);
      await settleFrozen(visual.page);
      const report = await scan(TOOLS_ROW);
      expect(report.viewport.width, 'window did not actually resize').toBe(size.width);
      expect(report.rootFound, `the composer tool row is gone at ${size.width}px`).toBe(true);
      await expectBadgeMounted(`${size.width}px`);
      expectNoOverflow(report, `composer tool row @ ${size.width}x${size.height}`);
      // ...and no control may sit outside the row it belongs to. This is the
      // half the clipping probe cannot see, and the half a nowrap `Tag`
      // actually breaks.
      expect(
        await overhangPx(),
        `a control hangs outside the composer tool row at ${size.width}px`
      ).toBeLessThanOrEqual(1);
    });
  }

  /**
   * The detector must be able to fail here too.
   *
   * The mutation reproduces the PRE-FIX layout rather than inventing a new
   * one: `flex-wrap: nowrap` puts the row back on a single line, and the letter
   * spacing stands in for a translation longer than mn-MN's. If the probe stays
   * quiet through that, a clean report on this row proves nothing.
   */
  test('a badge too long for one line is detected on this row', async () => {
    await setContentSize(visual.app, NARROW_VIEWPORTS[1]);
    await settleFrozen(visual.page);
    const before = await scan(TOOLS_ROW);
    expectNoOverflow(before, 'composer tool row (pre-mutation control)');

    expect(await overhangPx(), 'the row already overhangs before the mutation').toBeLessThanOrEqual(1);

    const mutatedOverhang = await withInjectedCss(
      visual.page,
      '[data-testid="wcore-sendbox-tools"] { flex-wrap: nowrap !important; }' +
        '[data-testid="execution-policy-badge"] { letter-spacing: 12px !important; }',
      () => overhangPx()
    );
    expect(mutatedOverhang, 'the containment check did not notice a badge that cannot fit one line').toBeGreaterThan(1);

    expect(await overhangPx(), 'the row stayed broken after the mutation was removed').toBeLessThanOrEqual(1);
    expectNoOverflow(await scan(TOOLS_ROW), 'composer tool row (post-mutation)');
  });
});
