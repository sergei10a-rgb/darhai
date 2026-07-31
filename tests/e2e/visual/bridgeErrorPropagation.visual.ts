/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A main-process provider that throws must answer the renderer.
 *
 * The @office-ai/platform provider wire protocol emits the reply callback only
 * from the handler's `.then` (`r(n.data).then(res => emit(callback, res))`),
 * with no `.catch`. A handler that rejects therefore sends nothing back: the
 * renderer's promise never settles, the main process logs an
 * `[unhandledRejection]`, and every failed write in the app renders as an
 * infinite spinner with no message.
 *
 * `withBridgeErrorPropagation` (src/common/adapter/bridgeError.ts) closes that
 * hole by converting a thrown handler into a structured envelope on the wire.
 * This spec is the live proof, and asserts all three properties that matter:
 *
 *   1. the call ANSWERS (fast) instead of hanging,
 *   2. the answer is a structured error carrying the real message, and
 *   3. the main process no longer emits `[unhandledRejection]` for it.
 *
 * These specific keys are the ones the functional audit reproduced hanging.
 * They are used as probes only - each fails validation inside its own service,
 * so nothing is written to the user profile.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchVisualApp, closeVisualApp, type VisualApp } from './fixture';
import { invokeBridge } from '../helpers/bridge';

/** Mirrors BRIDGE_ERROR_MARKER in src/common/adapter/bridgeError.ts. */
const BRIDGE_ERROR_MARKER = '__darhaiBridgeError';

type BridgeErrorEnvelope = {
  __darhaiBridgeError: { key: string; name: string; message: string; code?: string };
};

/**
 * Calls whose main-process handler throws for these params. Each was confirmed
 * to hang the renderer forever before the fix.
 */
const THROWING_CALLS: ReadonlyArray<{ key: string; data: unknown }> = [
  { key: 'calendar.create', data: {} },
  { key: 'note.create', data: {} },
  { key: 'note.update', data: { noteId: 'definitely-not-a-note', updates: { title: 'x' } } },
  { key: 'documents.create', data: {} },
];

/**
 * A short budget on purpose. The defect being guarded is an unbounded wait, so
 * the assertion has to be "answers promptly", not "answers eventually".
 */
const ANSWER_BUDGET_MS = 3_000;

let visual: VisualApp;

test.beforeAll(async () => {
  visual = await launchVisualApp();
});

/**
 * Read everything the main process logged, from the app's OWN log directory.
 *
 * `src/index.ts` sends every unhandled rejection to electron-log, and the
 * fixture gives each run an isolated profile, so this file is a per-run record
 * of main-process failures. Reading it beats piping the child's stdout: the
 * pipes are shared with Playwright's own driver channel and attaching to them
 * was observed killing the app mid-spec.
 */
async function readMainLog(): Promise<string> {
  const logsDir = await visual.app.evaluate(({ app }) => app.getPath('logs'));
  // electron-log's file transport is queued; give it a beat to land on disk.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  if (!fs.existsSync(logsDir)) return '';
  return fs
    .readdirSync(logsDir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => fs.readFileSync(path.join(logsDir, name), 'utf8'))
    .join('\n');
}

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
});

const isBridgeErrorEnvelope = (value: unknown): value is BridgeErrorEnvelope =>
  typeof value === 'object' && value !== null && BRIDGE_ERROR_MARKER in value;

for (const { key, data } of THROWING_CALLS) {
  test(`${key} answers the renderer with a structured error instead of hanging`, async () => {
    const startedAt = Date.now();
    const result = await invokeBridge<unknown>(visual.page, key, data, ANSWER_BUDGET_MS);
    const elapsed = Date.now() - startedAt;

    expect(
      isBridgeErrorEnvelope(result),
      `${key} resolved with ${JSON.stringify(result)}, expected a "${BRIDGE_ERROR_MARKER}" envelope`
    ).toBe(true);

    const payload = (result as BridgeErrorEnvelope)[BRIDGE_ERROR_MARKER];
    expect(payload.key).toBe(key);
    // A real diagnosis, not a placeholder: the renderer must be able to show it.
    expect(payload.message.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(ANSWER_BUDGET_MS);
  });
}

test('a healthy provider still resolves with its plain value', async () => {
  // Control: the envelope must not leak into the success path.
  const result = await invokeBridge<unknown>(visual.page, 'cron.list-jobs', undefined, ANSWER_BUDGET_MS);
  expect(isBridgeErrorEnvelope(result)).toBe(false);
  expect(Array.isArray(result)).toBe(true);
});

test('every provider failure is reported, and none of them is an unhandled rejection', async () => {
  // Runs last (Playwright preserves declaration order with workers: 1), so the
  // log covers every invocation above.
  const mainLog = await readMainLog();

  // An "absence" assertion is worthless unless we know the log we are reading
  // is real and current. Anchor on the failure lines the wrapper itself writes:
  // each one proves that this specific call reached main, threw, and was logged
  // through the very transport the check below inspects.
  for (const { key } of THROWING_CALLS) {
    expect(mainLog, `main log has no failure report for "${key}" - the check below would be vacuous`).toContain(
      `[bridge] provider "${key}" failed:`
    );
  }

  // With the reports present, the SAME failures must not also appear as
  // unhandled rejections: the wrapper answers the caller instead of leaking.
  const offenders = mainLog
    .split('\n')
    .filter((line) => line.includes('[unhandledRejection]'))
    .join('\n');
  expect(offenders, `main process logged unhandled rejections:\n${offenders}`).toBe('');
});
