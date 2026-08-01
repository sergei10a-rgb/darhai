/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `<namespace>.storage.*` must answer the renderer when its handler throws.
 *
 * `bridgeAllowlist.buildProvider` wraps every provider we declare in
 * `withBridgeErrorPropagation`, which repairs the vendored platform's missing
 * error path. Storage was the hole: the platform's own `storage.buildStorage`
 * calls `bridge.buildProvider` INTERNALLY, so the four wire keys per namespace
 * (`get` / `set` / `clear` / `remove`) were registered through the unrepaired
 * protocol - a throwing storage handler emitted nothing back and the renderer's
 * promise stayed pending forever. `ConfigStorage.get` is on the boot path of
 * most screens, so that failure mode is an app that never finishes loading,
 * with no error anywhere in the UI.
 *
 * The probe is a REAL storage handler failing for a real reason, not an
 * injected fault: `agent.chat.message` resolves each conversation to
 * `<cacheDir>/wayland-chat-history/<id>.txt`, so an id carrying a NUL byte is
 * a path the OS will not accept and the handler throws on the way to disk.
 * Nothing is written - the failure happens before any file is created.
 *
 * `bridgeErrorPropagation.visual.ts` covers the same guarantee for ordinary
 * `buildProvider` keys; this spec exists because storage reaches the wire by a
 * different route and regressed independently.
 */
import { test, expect } from '@playwright/test';
import { launchVisualApp, closeVisualApp, waitForSettle, type VisualApp } from './fixture';
import { invokeBridge } from '../helpers/bridge';

/** Mirrors BRIDGE_ERROR_MARKER in src/common/adapter/bridgeError.ts. */
const BRIDGE_ERROR_MARKER = '__darhaiBridgeError';

type BridgeErrorEnvelope = {
  __darhaiBridgeError: { key: string; name: string; message: string; code?: string };
};

/**
 * A conversation id the filesystem cannot represent. Chosen over a
 * platform-specific illegal character (`*`, `<`) so the probe fails the same
 * way on Windows, macOS and Linux.
 */
const UNWRITABLE_ID = 'darhai-storage-probe\u0000';

/**
 * Short on purpose: the defect is an UNBOUNDED wait, so the assertion has to be
 * "answers promptly", not "answers eventually".
 */
const ANSWER_BUDGET_MS = 3_000;

let visual: VisualApp;

test.beforeAll(async () => {
  visual = await launchVisualApp();
  await waitForSettle(visual.page);
});

test.afterAll(async () => {
  if (visual) await closeVisualApp(visual);
});

const isBridgeErrorEnvelope = (value: unknown): value is BridgeErrorEnvelope =>
  typeof value === 'object' && value !== null && BRIDGE_ERROR_MARKER in value;

test('agent.chat.message.storage.set rejects instead of hanging when the handler throws', async () => {
  const startedAt = Date.now();
  const result = await invokeBridge<unknown>(
    visual.page,
    'agent.chat.message.storage.set',
    { key: UNWRITABLE_ID, data: [] },
    ANSWER_BUDGET_MS
  );
  const elapsed = Date.now() - startedAt;

  expect(
    isBridgeErrorEnvelope(result),
    `storage.set resolved with ${JSON.stringify(result)}, expected a "${BRIDGE_ERROR_MARKER}" envelope`
  ).toBe(true);
  const payload = (result as BridgeErrorEnvelope)[BRIDGE_ERROR_MARKER];
  expect(payload.key).toBe('agent.chat.message.storage.set');
  expect(payload.message.length).toBeGreaterThan(0);
  expect(elapsed).toBeLessThan(ANSWER_BUDGET_MS);
});

// The read verbs are covered by `tests/unit/bridgeStorage.test.ts`, which drives
// get / set / clear / remove through the REAL @office-ai/platform emitter. They
// are not repeated here because no live `storage.get` handler in the app throws
// for a caller-supplied key - `JsonFileBuilder.loadSync` swallows read failures
// and answers with an empty document, which is its own (separate) decision.

test('a healthy storage read still resolves with its plain value', async () => {
  // Control: the envelope must not leak into the success path, and the
  // rebuilt buildStorage must still speak the platform's wire shape.
  const result = await invokeBridge<unknown>(visual.page, 'agent.config.storage.get', 'language', ANSWER_BUDGET_MS);
  expect(isBridgeErrorEnvelope(result)).toBe(false);
});

test('storage.set still writes, and storage.get reads the value back', async () => {
  // The rebuilt namespace must be functionally identical to the platform's,
  // not merely non-hanging: `set` takes `{key, data}` and `get` takes the key.
  const probeKey = 'agent.chat.message.storage.set';
  const conversationId = `darhai-storage-roundtrip-${Date.now()}`;
  const messages = [{ id: 'm1', role: 'user', content: 'roundtrip' }];

  await invokeBridge<unknown>(visual.page, probeKey, { key: conversationId, data: messages }, ANSWER_BUDGET_MS);
  const readBack = await invokeBridge<unknown>(
    visual.page,
    'agent.chat.message.storage.get',
    conversationId,
    ANSWER_BUDGET_MS
  );

  expect(isBridgeErrorEnvelope(readBack)).toBe(false);
  expect(readBack).toEqual(messages);
});
