/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Selecting an agent's answer, with a real mouse.
 *
 * Agent prose renders inside a shadow root, and Chromium reports selections
 * that touch that boundary differently from ordinary ones: a selection lying
 * wholly inside one shadow root comes back `isCollapsed === true` while the
 * text is plainly highlighted. The reply handler trusted that flag, so the
 * affordance never appeared on any agent answer.
 *
 * The dom test drives the handler with a selection shaped the way Chromium
 * shapes it - but that shape is itself an assumption written down by hand.
 * jsdom cannot produce a selection that crosses a shadow boundary, so only a
 * real drag in a real window proves the premise. That is what this spec does:
 * press, move, release across rendered prose, then look for the affordance.
 *
 * Chromium's own copy is shadow-aware, so Ctrl+C was never broken - measured,
 * see the header of `shadowSelection.ts`. Only JavaScript read paths were.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeVisualApp, launchVisualApp, pinNondeterminism, stabilize, type VisualApp } from './fixture';
import { gotoHash, hideFirstRunOverlay, openWCoreConversation, pushResponseFrame, settleFrozen } from './surfaces';

let visual: VisualApp;

const OUT_DIR = path.join(process.cwd(), 'tests', 'e2e', 'screenshots', 'selectionReply');

/** Long enough that a drag across it lands squarely inside one paragraph. */
// Deliberately free of the affordance's own label: a substring match against
// the prose is what made the first version of this spec pass without the
// affordance ever appearing.
const ANSWER = 'Энэ бол агентын урт мэдээлэл бөгөөд хэрэглэгч үүнээс хэсэг тэмдэглэн иш татах ёстой.';

test.beforeAll(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  visual = await launchVisualApp();
  await pinNondeterminism(visual.page);
  await hideFirstRunOverlay(visual.page);
});

test.afterAll(async () => {
  await closeVisualApp(visual);
});

test('dragging across an agent answer offers to quote it', async () => {
  const id = await openWCoreConversation(visual.page);
  await gotoHash(visual.page, `#/conversation/${id}`);
  await visual.page.waitForFunction((target: string) => window.location.hash.includes(target), id, { timeout: 15_000 });
  await settleFrozen(visual.page);

  // Seed one assistant message. It renders through MarkdownView, which is what
  // puts the prose inside a shadow root in the first place.
  await pushResponseFrame(visual.app, {
    type: 'content',
    msg_id: 'selection-reply-visual-1',
    conversation_id: id as string,
    data: { content: ANSWER },
  });

  const message = visual.page.locator('[id^="message-"]').last();
  await expect(message).toBeVisible({ timeout: 15_000 });
  await stabilize(visual.page);

  // Drag across the PARAGRAPH, not the message block. The block includes
  // padding and action rows, so its vertical centre can land between lines -
  // the first attempt selected only a newline. Playwright
  // pierces the open shadow root, so the paragraph is directly addressable.
  const prose = message.locator('p').first();
  await expect(prose, 'the seeded answer did not render as a paragraph').toBeVisible({ timeout: 10_000 });
  const box = await prose.boundingBox();
  expect(box, 'the paragraph has no box to drag across').not.toBeNull();
  if (!box) return;

  // A real press-move-release, not a synthetic selection: the whole point is to
  // let Chromium build the selection itself, shadow boundary included.
  const y = box.y + box.height / 2;
  await visual.page.mouse.move(box.x + 8, y);
  await visual.page.mouse.down();
  await visual.page.mouse.move(box.x + box.width - 8, y, { steps: 16 });
  await visual.page.mouse.up();

  // What Chromium reports for that gesture - recorded either way, because a
  // collapsed reading here is the bug's own signature.
  const reported = await visual.page.evaluate(() => {
    const sel = document.getSelection();
    return { collapsed: sel?.isCollapsed ?? null, text: sel?.toString() ?? '' };
  });

  const reply = visual.page.getByTestId('selection-reply');
  await expect(
    reply,
    `no reply affordance after a real drag (engine reported collapsed=${reported.collapsed}, text=${JSON.stringify(reported.text)})`
  ).toBeVisible({ timeout: 10_000 });

  fs.writeFileSync(path.join(OUT_DIR, 'selection-reply.png'), await visual.page.screenshot({ animations: 'disabled' }));

  // A full-window shot renders the affordance ~20px tall, too small to read.
  // Crop around it: a label that is present in the DOM but clipped, empty or
  // overlapped is a defect the wide shot cannot show.
  const affordance = await reply.boundingBox();
  expect(affordance, 'the reply affordance has no box').not.toBeNull();
  if (affordance) {
    fs.writeFileSync(
      path.join(OUT_DIR, 'selection-reply-closeup.png'),
      await visual.page.screenshot({
        animations: 'disabled',
        clip: {
          x: Math.max(0, affordance.x - 60),
          y: Math.max(0, affordance.y - 40),
          width: Math.min(520, affordance.width + 240),
          height: affordance.height + 90,
        },
      })
    );
    // The label must occupy real width. A collapsed box means the text rendered
    // as nothing - exactly what a mis-shaped `t()` produced in the dom test.
    expect(affordance.width, 'the reply label collapsed to nothing').toBeGreaterThan(40);

    // `toBeVisible()` only checks the element is in the DOM with a non-zero box.
    // It says nothing about whether something is painted ON TOP of it. The
    // handler places the affordance above the selection whenever `top - 40 >= 0`,
    // which is true even when that lands under the title bar - so measure what
    // is actually at its centre.
    const occlusion = await visual.page.evaluate(
      ({ x, y, w, h }) => {
        const cx = x + w / 2;
        const cy = y + h / 2;
        const top = document.elementFromPoint(cx, cy);
        const label = document.querySelector('[data-reply-affordance], .app-titlebar');
        return {
          topTag: top?.tagName ?? null,
          topText: (top?.textContent ?? '').slice(0, 40),
          inTitlebar: !!top?.closest('.app-titlebar'),
          hasLabel: !!label,
        };
      },
      { x: affordance.x, y: affordance.y, w: affordance.width, h: affordance.height }
    );
    expect(
      occlusion.inTitlebar,
      `the reply affordance is painted under the title bar (top element: ${occlusion.topTag} ${JSON.stringify(occlusion.topText)})`
    ).toBe(false);

    // Record where it actually sits, so the closeup can be judged against it
    // rather than guessed at.
    fs.writeFileSync(
      path.join(OUT_DIR, 'affordance-geometry.json'),
      JSON.stringify({ box: affordance, occlusion, viewport: visual.page.viewportSize() }, null, 2)
    );
  }
});
