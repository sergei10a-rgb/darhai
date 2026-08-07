/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Synchronous last-resort release of OS resources at process death.
 *
 * The ordinary quit path is the async cleanup bundle in `src/index.ts`, now
 * held open by a bounded `will-quit` barrier so it actually finishes. This
 * module covers the paths that barrier can never see, because they skip the
 * quit sequence entirely:
 *
 *   - `app.exit(1)` from the `uncaughtException` handler,
 *   - `app.exit(1)` when `initializeProcess()` or app init rejects,
 *   - `app.exit(0)` driven from outside (the E2E fixture does exactly this),
 *   - anything else that terminates the process without emitting `will-quit`.
 *
 * On every one of those, an OPEN SQLite handle is left behind. In WAL mode
 * (`schema.ts` sets `journal_mode = WAL`) that means the `-wal` and `-shm`
 * sidecars survive with un-checkpointed pages in them: recoverable on the next
 * clean open, but the exact state in which a power loss or a disk-full moment
 * costs the user data. `closeDatabase()` is synchronous by design - its own
 * comment says it is safe to call from `process.on('exit')` - so the guarantee
 * costs one blocking checkpoint at the very end of the process's life.
 *
 * Only work that is genuinely synchronous belongs here. Anything that needs to
 * await stays in the quit bundle behind the barrier; a promise created in an
 * `exit` handler never runs.
 */

import { app } from 'electron';
import { closeDatabase } from '@process/services/database/export';
import { reapAgentChildrenSync } from '@process/agent/childRegistry';

/** Set once so a repeated init cannot stack handlers. */
let registered = false;

/**
 * Release every synchronously-releasable OS resource. Idempotent:
 * `closeDatabase()` nulls its own reference, so repeated calls are no-ops.
 */
function reapSync(): void {
  try {
    closeDatabase();
  } catch (err) {
    // Never throw from an exit handler - a throw here would replace the real
    // exit reason with this one.
    console.error('[Wayland] sync quit reaper: closeDatabase failed:', err);
  }
  try {
    // Engine children (wcore, ACP backends, the OpenClaw gateway) outlive an
    // `app.exit()` for the same reason the database handle did: nothing on
    // these paths gets a chance to tear them down. On Windows a survivor holds
    // files in the install directory, which is what makes the next update or
    // uninstall fail. Normally a no-op - the async sweep already ran.
    const killed = reapAgentChildrenSync();
    if (killed > 0) {
      console.warn(`[Wayland] sync quit reaper: hard-killed ${killed} engine child(ren)`);
    }
  } catch (err) {
    console.error('[Wayland] sync quit reaper: engine child reap failed:', err);
  }
}

/**
 * Register the synchronous reapers. Call once, as early in main as possible -
 * an init failure that hard-exits must already be covered.
 */
export function registerSyncQuitReapers(): void {
  if (registered) return;
  registered = true;
  // Node's own last word before the process is gone. Fires for app.exit(...)
  // and for a plain process.exit(), neither of which emits will-quit.
  process.on('exit', reapSync);
  // Electron's last word on the ordinary quit path. Redundant with the barrier
  // in the common case, and the safety net if a future change removes it.
  app.on('quit', reapSync);
}
