/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Asleep-engine pending-send store (SEC-8).
 *
 * When the engine is asleep (e.g. mid OAuth / activation round trip), the
 * renderer parks the user's in-flight message HERE so the send box can clear,
 * then reclaims it exactly once when the engine wakes.
 *
 * SECURITY (SEC-8) - HUMAN/RENDERER ONLY, MAIN-MEMORY ONLY. Message bodies are
 * PII/secrets and live ONLY in this process's `store` Map - never disk, never
 * sessionStorage. `take` is exactly-once (atomic read+delete) so a body can be
 * reclaimed precisely one time. All four methods are remote-denied in
 * `bridgeAllowlist.ts`: a remote/agent caller must never read a held body or
 * inject one into a conversation.
 *
 * `Date.now()` is used for `createdAt` - that is fine in the main process (no
 * renderer clock concerns; this is never serialised to disk).
 */

import { ipcBridge } from '@/common';
import type { IPendingSend } from '@/common/adapter/ipcBridge';
import { uuid } from '@/common/utils';

/** Main-process-only hold store, keyed by conversationId. One hold per conversation. */
const store = new Map<string, IPendingSend>();

/**
 * Hold a message for a conversation, REPLACING any prior hold for that
 * conversation. Mints and returns an opaque id the renderer can use to confirm
 * its own held message.
 */
export function holdPendingSend({
  conversationId,
  message,
  files,
}: {
  conversationId: string;
  message: string;
  files?: string[];
}): { id: string } {
  const id = uuid();
  store.set(conversationId, {
    id,
    conversationId,
    message,
    files: files ?? [],
    createdAt: Date.now(),
  });
  return { id };
}

/**
 * Atomically read AND delete the held message for a conversation (exactly-once).
 * Returns the record, or null when nothing is held.
 */
export function takePendingSend({ conversationId }: { conversationId: string }): IPendingSend | null {
  const record = store.get(conversationId) ?? null;
  store.delete(conversationId);
  return record;
}

/** Non-destructive check: whether a hold exists for a conversation, and its id. */
export function peekPendingSend({ conversationId }: { conversationId: string }): {
  hasPending: boolean;
  id?: string;
} {
  const record = store.get(conversationId);
  return record ? { hasPending: true, id: record.id } : { hasPending: false };
}

/** Drop a held message without sending it (user cancelled / left the thread). */
export function clearPendingSend({ conversationId }: { conversationId: string }): { ok: true } {
  store.delete(conversationId);
  return { ok: true };
}

/**
 * Register the pending-send IPC handlers. All four are HUMAN/RENDERER ONLY and
 * remote-denied (see `bridgeAllowlist.ts`).
 */
export function initPendingSendBridge(): void {
  ipcBridge.pendingSend.hold.provider(async ({ conversationId, message, files }) => {
    return holdPendingSend({ conversationId, message, files });
  });

  ipcBridge.pendingSend.take.provider(async ({ conversationId }) => {
    return takePendingSend({ conversationId });
  });

  ipcBridge.pendingSend.peek.provider(async ({ conversationId }) => {
    return peekPendingSend({ conversationId });
  });

  ipcBridge.pendingSend.clear.provider(async ({ conversationId }) => {
    return clearPendingSend({ conversationId });
  });
}
