/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A bounded barrier that lets an async quit cleanup actually finish.
 *
 * The problem it solves
 * ---------------------
 * Electron does not await async `before-quit` handlers. Measured on this build,
 * `[Wayland] before-quit` and `[Wayland] will-quit` are ~23ms apart with the
 * process already going away, so every awaited step in the app's cleanup bundle
 * - SQLite close, cron shutdown, cookbook llama-server teardown, fork workers -
 * was best-effort. The one subsystem that survived (OmniRoute) did so by
 * registering its own SYNCHRONOUS reaper: a fix per subsystem, not a fix of the
 * pattern.
 *
 * `will-quit` IS cancellable, so this cancels it once, waits for the cleanup
 * that `before-quit` started, and then exits explicitly.
 *
 * The three properties that make that safe
 * ----------------------------------------
 *  1. **It always exits.** `exit()` runs from the success path, the failure
 *     path AND an unconditional ceiling timer. A quit can be DELAYED here; it
 *     can never be prevented. That is the difference between this and a plain
 *     `event.preventDefault()`, which is how a quit turns into a hang.
 *  2. **It is bounded.** {@link QuitBarrierDeps.ceilingMs} is an absolute upper
 *     bound that does not depend on the cleanup behaving.
 *  3. **It runs once.** Repeated `will-quit` events re-cancel without scheduling
 *     a second exit, and `begin` never starts a second cleanup run.
 *
 * Kept out of `src/index.ts` so the ordering rules above are unit-testable;
 * an Electron entry point is not.
 */

export type QuitBarrierDeps = {
  /**
   * Terminate the process. Invoked exactly once, and guaranteed to be invoked
   * once {@link QuitBarrier.hold} has returned true.
   */
  exit: () => void;
  /**
   * Absolute upper bound on how long the barrier may hold the quit, in ms.
   * Should exceed the cleanup's own internal ceiling: it only matters when that
   * ceiling itself wedges.
   */
  ceilingMs: number;
  /** Diagnostic sink. Defaults to `console.log`. */
  log?: (message: string) => void;
  /** Warning sink (the ceiling path). Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /** Clock, injectable so tests need not sleep. Defaults to `Date.now`. */
  now?: () => number;
  /** Timer seam, injectable for the same reason. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type QuitBarrier = {
  /**
   * Start the cleanup. Safe to call repeatedly - only the first call runs
   * `run`, so a re-entrant quit cannot tear the same subsystems down twice.
   */
  begin: (run: () => Promise<void>) => void;
  /**
   * Call from `will-quit`.
   *
   * @returns `true` when the caller MUST `event.preventDefault()`: the barrier
   *   has taken responsibility for exiting and will do so. `false` means there
   *   is nothing to wait for (no cleanup was started, or it already finished)
   *   and the quit should proceed normally.
   */
  hold: () => boolean;
  /** True once the cleanup promise has settled. Diagnostics/tests. */
  isSettled: () => boolean;
};

export function createQuitBarrier(deps: QuitBarrierDeps): QuitBarrier {
  const log = deps.log ?? ((message: string) => console.log(message));
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let cleanup: Promise<void> | undefined;
  let settled = false;
  let armed = false;
  let exited = false;

  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    log('[Wayland] quit barrier released; exiting');
    deps.exit();
  };

  return {
    begin(run: () => Promise<void>): void {
      if (cleanup) return;
      const startedAt = now();
      cleanup = run().then(
        () => {
          settled = true;
          log(`[Wayland] quit cleanup finished in ${now() - startedAt}ms`);
        },
        (err: unknown) => {
          settled = true;
          warn(`[Wayland] quit cleanup failed after ${now() - startedAt}ms: ${String(err)}`);
        }
      );
    },

    hold(): boolean {
      // Nothing started, or already done: let Electron quit on its own terms.
      if (!cleanup || settled) return false;
      if (armed) return true;
      armed = true;
      log('[Wayland] will-quit - holding the quit until cleanup finishes');

      const ceiling = setTimer(() => {
        warn(`[Wayland] quit barrier ceiling (${deps.ceilingMs}ms) reached; exiting anyway`);
        exitOnce();
      }, deps.ceilingMs);

      const release = (): void => {
        clearTimer(ceiling);
        exitOnce();
      };
      // `cleanup` already absorbed its own rejection above, so `then` alone
      // cannot leave an unhandled rejection - but both arms are wired anyway,
      // because "exits on failure too" is the property that must not regress.
      cleanup.then(release, release);
      return true;
    },

    isSettled(): boolean {
      return settled;
    },
  };
}
