/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { FrequentlyUsedAggregator, FrequentlyUsedModel } from '@process/services/usage/FrequentlyUsedAggregator';
import type { UsageEventLogger } from '@process/services/usage/UsageEventLogger';
import type { UsageEventType } from '@process/services/usage/types';

type RecordInput = {
  eventType: string;
  anchorId?: string;
  assistantId?: string;
  cliBackend?: string;
  metadata?: Record<string, unknown>;
};

// Cross-audit Gemini-HIGH fix: the IPC channel is registered eagerly so the
// first renderer-side `guid.foreground` (fired in a `useEffect` on mount) is
// never dropped on cold start. The logger resolves asynchronously after
// `getDatabase()` settles — until then events are buffered and flushed in
// arrival order once `initUsageBridge` wires the live logger.
const PENDING_LIMIT = 256;
const pending: RecordInput[] = [];
let liveLogger: UsageEventLogger | null = null;
let liveAggregator: FrequentlyUsedAggregator | null = null;
let providerInstalled = false;

function forwardToLogger(input: RecordInput): Promise<void> {
  if (!liveLogger) return Promise.resolve();
  return liveLogger.record({
    eventType: input.eventType as UsageEventType,
    anchorId: input.anchorId,
    assistantId: input.assistantId,
    cliBackend: input.cliBackend,
    metadata: input.metadata,
  });
}

function recordOrBuffer(input: RecordInput): Promise<void> {
  if (liveLogger) {
    return forwardToLogger(input);
  }
  if (pending.length < PENDING_LIMIT) {
    pending.push(input);
  }
  // Renderer never blocks on the result and never sees errors — telemetry
  // must never break a flow.
  return Promise.resolve();
}

/**
 * Eagerly register the IPC provider for `usage.recordEvent`. Safe to call
 * before `initUsageBridge` resolves the SQLite-backed logger — events that
 * arrive during the cold-start window are buffered (FIFO, capped at
 * PENDING_LIMIT) and flushed in arrival order once the logger lands.
 */
export function ensureUsageProviderRegistered(): void {
  if (providerInstalled) return;
  providerInstalled = true;
  ipcBridge.usage.recordEvent.provider((input) => recordOrBuffer(input));
  // Query providers don't buffer — pre-aggregator callers just get an empty
  // list (the picker's "Nothing here yet" empty state). Once the SQLite
  // logger lands and a few events are recorded, subsequent calls succeed.
  ipcBridge.usage.queryFrequentlyUsedModels.provider(
    async (input: { windowMs?: number; limit?: number }): Promise<FrequentlyUsedModel[]> => {
      if (!liveAggregator) return [];
      return liveAggregator.queryFrequentlyUsedModels(input ?? {});
    }
  );
}

/**
 * Wire the renderer-facing IPC provider for `usage.recordEvent` to a
 * SQLite-backed event logger. Events buffered before this resolves are
 * flushed in arrival order. The provider itself is installed eagerly via
 * `ensureUsageProviderRegistered`; calling this function more than once
 * replaces the logger and re-drains the buffer.
 */
export function initUsageBridge(logger: UsageEventLogger, aggregator?: FrequentlyUsedAggregator): void {
  liveLogger = logger;
  if (aggregator) liveAggregator = aggregator;
  ensureUsageProviderRegistered();
  const drained = pending.splice(0);
  for (const input of drained) {
    void forwardToLogger(input);
  }
}

/**
 * Test-only reset hook so unit tests can exercise the buffer-then-flush
 * sequence deterministically. Not used in production paths.
 */
export function __resetUsageBridgeForTests(): void {
  pending.length = 0;
  liveLogger = null;
  liveAggregator = null;
  providerInstalled = false;
}
