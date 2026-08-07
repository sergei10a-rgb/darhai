/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, truncateSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Append-only JSONL audit log for webhook deliveries.
 *
 * Design constraints:
 *   - Lines are flushed synchronously so a crash mid-pipeline still leaves the
 *     reject/accept record on disk for forensics.
 *   - No PII or payload bytes: only metadata (platform, last-4 of token,
 *     verdict, reason, status).
 *   - Self-rotating at 10 MB; one prior file is kept (.1 suffix) and overwritten
 *     on the next rotation. The volume is bounded so users running on small
 *     disks don't get squeezed by webhook traffic.
 */
const MAX_BYTES = 10 * 1024 * 1024;

export type AuditEntry = {
  platform: string;
  token: string;
  verdict: 'accept' | 'reject';
  reason?: string;
  status: number;
};

let cachedPath: string | null = null;

function resolveLogPath(): string {
  if (cachedPath !== null) return cachedPath;
  // Lazy-load electron's app - falls back to tmpdir when running in vitest /
  // CLI / pre-app contexts.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { app?: { getPath?: (n: string) => string } };
    const userData = electron.app?.getPath?.('userData');
    if (userData) {
      cachedPath = path.join(userData, 'webhook-audit.log');
      return cachedPath;
    }
  } catch {
    // electron unavailable - fall through.
  }
  cachedPath = path.join(os.tmpdir(), 'wayland-webhook-audit.log');
  return cachedPath;
}

/**
 * Test seam: override the log file location and reset internal state. Used
 * exclusively by the unit tests to point at a fixture directory.
 */
export function __setLogPathForTests(p: string | null): void {
  cachedPath = p;
}

/**
 * Mask all but the last 4 characters of the connection token so the audit
 * trail can correlate to a token without revealing the secret.
 */
function maskToken(token: string): string {
  if (token.length <= 4) return token;
  return token.slice(-4);
}

/**
 * Rotate the log when it exceeds `maxBytes`. Exported (with an injectable
 * threshold) so a test can exercise the Windows rename-failure fallback with a
 * tiny file instead of writing the real 10 MB cap.
 */
export function rotateIfNeeded(logPath: string, maxBytes: number = MAX_BYTES): void {
  try {
    const stats = statSync(logPath);
    if (stats.size < maxBytes) return;
    const rotated = `${logPath}.1`;
    try {
      renameSync(logPath, rotated);
    } catch (err) {
      // The old blanket catch treated EVERY failure as "file missing". On
      // Windows a rename fails EPERM whenever any process holds the log open -
      // even just for reading - so rotation never happened and the size cap
      // silently stopped existing: the log grew without bound. Fall back to
      // copy+truncate, the standard rotation for a file that cannot be moved
      // (what logrotate's copytruncate does). Lines appended between the copy
      // and the truncate are lost; that narrow window is the accepted price of
      // keeping the cap real.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      copyFileSync(logPath, rotated);
      truncateSync(logPath, 0);
    }
  } catch {
    // File missing, or the fallback itself failed (rotated target locked too).
    // Never let rotation break the append - the audit record matters more.
  }
}

export function logWebhookEvent(entry: AuditEntry): void {
  const logPath = resolveLogPath();

  try {
    const dir = path.dirname(logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    rotateIfNeeded(logPath);

    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        platform: entry.platform,
        token4: maskToken(entry.token),
        verdict: entry.verdict,
        reason: entry.reason,
        status: entry.status,
      }) + '\n';

    appendFileSync(logPath, line, 'utf8');
  } catch (err) {
    // Audit logging must never throw into the request pipeline. Surface to
    // stderr so operators can spot disk issues without crashing the receiver.
    console.error('[webhook-audit] failed to write entry', err);
  }
}
