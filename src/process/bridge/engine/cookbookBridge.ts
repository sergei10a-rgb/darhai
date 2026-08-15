/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the cookbook-serve surface (download + auto-serve local
 * models). This is the write/exec extension of the read-only hwfit advisor.
 *
 * The whole `cookbook.*` namespace is remote-denied (see bridgeAllowlist
 * REMOTE_DENIED_PREFIXES): a multi-GB download + subprocess spawn is a host-side
 * DoS/exec class a paired-device WebSocket caller must never reach. The local
 * renderer contract is still untrusted input crossing a process boundary, so
 * every field is validated / clamped here (mirroring hwfitBridge) before it
 * reaches the service.
 */

import { ipcBridge } from '@/common';
import { cookbookServe } from '@process/services/cookbook/cookbookServeSingleton';
import { COOKBOOK_BACKENDS } from '@/common/types/cookbook';
import type { CookbookBackend, CookbookDownloadInfo, CookbookServeStatus } from '@/common/types/cookbook';

/** Cap on any single id / path string handed across the boundary (chars). */
const MAX_ID_LEN = 512;

/**
 * The set of accepted backend-override values (untrusted renderer input).
 *
 * BUILT FROM the union's own runtime array rather than re-listing it. A `Set`
 * literal is not exhaustive-checked by tsc, so a hand-written copy is a
 * duplicate that can silently fall behind: `lm-studio` would have type-checked,
 * linted and passed every existing test while the validator quietly rewrote the
 * user's choice to `undefined` and served through the hardware default instead.
 */
const VALID_BACKENDS: ReadonlySet<CookbookBackend> = new Set<CookbookBackend>(COOKBOOK_BACKENDS);

/** A trimmed string capped at {@link MAX_ID_LEN}, or empty when not a string. */
function safeId(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_ID_LEN) : '';
}

/** Narrow an untrusted backend override to a known value, else undefined. */
function safeBackend(value: unknown): CookbookBackend | undefined {
  return typeof value === 'string' && VALID_BACKENDS.has(value as CookbookBackend)
    ? (value as CookbookBackend)
    : undefined;
}

/** Look up the current download state for a model (idle fallback). */
function downloadInfoFor(modelId: string): CookbookDownloadInfo {
  return (
    cookbookServe.listDownloads().find((d) => d.modelId === modelId) ?? {
      modelId,
      status: 'idle',
      bytesDownloaded: 0,
      totalBytes: null,
      filePath: null,
    }
  );
}

/** Initialize the cookbook-serve IPC bridge handlers. */
export function initCookbookBridge(): void {
  ipcBridge.cookbook.listDownloads.provider(async (): Promise<CookbookDownloadInfo[]> => {
    return cookbookServe.listDownloads();
  });

  ipcBridge.cookbook.download.provider(async ({ modelId }): Promise<CookbookDownloadInfo> => {
    const id = safeId(modelId);
    if (!id) return downloadInfoFor('');
    try {
      await cookbookServe.download(id);
    } catch {
      // The error is captured into the per-model download state; surface it via
      // the info below rather than rejecting the IPC call.
    }
    return downloadInfoFor(id);
  });

  ipcBridge.cookbook.cancelDownload.provider(async ({ modelId }): Promise<{ cancelled: boolean }> => {
    const id = safeId(modelId);
    if (!id) return { cancelled: false };
    return { cancelled: cookbookServe.cancelDownload(id) };
  });

  ipcBridge.cookbook.serve.provider(async ({ modelId, backend }): Promise<CookbookServeStatus> => {
    const id = safeId(modelId);
    if (!id) return cookbookServe.serveStatus();
    return cookbookServe.serve(id, safeBackend(backend));
  });

  ipcBridge.cookbook.stopServe.provider(async (): Promise<CookbookServeStatus> => {
    return cookbookServe.stopServe();
  });

  ipcBridge.cookbook.serveStatus.provider(async (): Promise<CookbookServeStatus> => {
    return cookbookServe.serveStatus();
  });

  ipcBridge.cookbook.detectBackend.provider(async () => {
    return cookbookServe.detectBackend();
  });

  ipcBridge.cookbook.backendOptions.provider(async () => {
    return cookbookServe.backendSelection();
  });

  ipcBridge.cookbook.locateBackend.provider(async ({ path }) => {
    const binaryPath = safeId(path);
    if (!binaryPath) return { ok: false, backend: 'none' as const, error: 'empty path' };
    const result = await cookbookServe.locateBackend(binaryPath);
    return { ok: result.ok, backend: result.backend };
  });
}
