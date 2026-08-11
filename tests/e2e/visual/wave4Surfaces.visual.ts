/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Eyes on the wave-4 surfaces, in the real app.
 *
 * The whole wave failed review for one reason: green tests over screens that
 * could not receive data. A DOM test pushes a frame into a mounted component;
 * it cannot tell you whether the pane renders at all in the shipped build,
 * whether the Mongolian copy fits its box, or whether a new empty state reads
 * as "nothing yet" or as "broken".
 *
 * So these are not assertions about pixels. They open each surface this wave
 * touched and write a PNG that a human looks at. The only failure condition is
 * "the screen did not come up" - anything subtler is for the reviewer's eyes,
 * which is the point.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchVisualApp, closeVisualApp, stabilize, type VisualApp } from './fixture';
import { openWCoreConversation, pushResponseFrame } from './surfaces';

const OUT_DIR = path.resolve(__dirname, '..', 'screenshots', 'wave4');

let visual: VisualApp;

test.beforeAll(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  visual = await launchVisualApp();
  // Make first-run detection fail so the onboarding overlay never covers the
  // surface under review: `useOnboardingDetection` treats a rejection as "no
  // detection" and `OnboardingOverlay` renders nothing without one. Same
  // approach as modelsSettings.visual.ts.
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

/** Drive the renderer's own router rather than clicking through the shell. */
async function goTo(hash: string): Promise<void> {
  await visual.page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await stabilize(visual.page);
}

async function shoot(name: string, fullPage = false): Promise<void> {
  const buffer = await visual.page.screenshot({ fullPage });
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), buffer);
  // A blank or near-blank capture means the route did not render. 20 KB is far
  // below any real screen at 1280x800 and far above an all-one-colour PNG.
  expect(buffer.byteLength, `${name} looks blank`).toBeGreaterThan(20_000);
}

test('mission control - goals tab', async () => {
  await goTo('#/mission-control');
  // The tab strip is the surface this wave added; open it rather than
  // photographing the activity tab it defaults to.
  const goals = visual.page.getByText('Зорилтууд', { exact: false }).first();
  await goals.dispatchEvent('click').catch((): undefined => undefined);
  await stabilize(visual.page);
  await shoot('mission-control-goals', true);
});

test('settings - engine overview (capability readiness)', async () => {
  await goTo('#/settings/wcore-config');
  await shoot('settings-engine-overview', true);
});

test('settings - engine runtime (diagnostics control)', async () => {
  await goTo('#/settings/wcore-config');
  // The rail item is overlapped by a decorative grow layer, so a real click is
  // intercepted; dispatching the event the handler listens for exercises the
  // same code path without fighting the z-order.
  await visual.page
    .locator('[data-wcore-rail-id="runtime"]')
    .first()
    .dispatchEvent('click')
    .catch((): undefined => undefined);
  await stabilize(visual.page);
  await shoot('settings-engine-runtime', true);
});

test('mcp library - installed', async () => {
  await goTo('#/settings/mcp-library/installed');
  await shoot('mcp-library-installed');
});

/**
 * The conversation surface, which this file used to skip.
 *
 * Three of the four wave-4 surfaces were photographed here and the fourth - the
 * one that grew a new transcript card AND a new badge beside the composer - was
 * not, so `WorkflowRunCard` and `EffectivePolicyBadge` had never rendered
 * outside jsdom. A DOM test cannot tell you whether the card shows up at all in
 * the shipped build or whether the Mongolian copy fits its box; that is the
 * whole reason this file exists.
 *
 * The frames below are the real projections (a `workflow_lifecycle_v1` run with
 * a failed node and a lost-lines gap, and the `execution_policy` receipt in its
 * loudest state) pushed down the real response stream. No engine is started:
 * the point is the RENDER, and an engine would make the shot non-deterministic.
 */
test('conversation - workflow run card and effective policy badge', async () => {
  const conversationId = await openWCoreConversation(visual.page);

  await pushResponseFrame(visual.app, {
    type: 'workflow_run',
    msg_id: 'run-visual-1',
    conversation_id: conversationId,
    data: {
      runId: 'run-visual-1',
      workflowId: 'desktop-audit',
      name: 'Ажлын талбарын шалгалт',
      nodeCount: 4,
      status: 'failed',
      missingTotal: 2,
      nodes: [
        { nodeId: 'scan', state: 'succeeded' },
        { nodeId: 'collect', state: 'blocked' },
        {
          nodeId: 'report',
          state: 'failed',
          failure: { code: 'io.write_denied', message: 'workspace is read-only', retryable: false },
        },
      ],
      failure: { code: 'run.aborted', message: 'a node failed and the run cannot continue', retryable: true },
    },
  });

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

  await stabilize(visual.page);

  // Guard the premise. A screenshot of a conversation where the frames never
  // landed is exactly the "green over a screen that could not receive data"
  // failure this file was added to end.
  await expect(visual.page.getByTestId('workflow-run-card')).toBeVisible({ timeout: 15_000 });
  await expect(visual.page.getByTestId('execution-policy-badge')).toBeVisible({ timeout: 15_000 });

  await shoot('conversation-workflow-run', true);
});
