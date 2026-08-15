/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Load-invariant waits for fire-and-forget async pipelines under test.
 *
 * The problem these replace
 * ------------------------
 * A test that starts a `void`-returning pipeline has no handle to await, so it
 * used to reach for `await new Promise((r) => setTimeout(r, 80))`. That is a
 * bet that the pipeline finishes inside 80 ms of WALL CLOCK - and wall clock is
 * exactly the thing a full `vitest run` takes away. With 24 forks on 24 cores,
 * a fork can sit unscheduled for hundreds of milliseconds; the sleep's timer
 * still expires on schedule, the pipeline behind it has not advanced, and the
 * test asserts against a half-finished state. Measured on this repo, that is
 * how `weixinLogin.test.ts` reported `expected "vi.fn()" to be called 1 times,
 * but got 0 times` in 3 of 6 loaded runs while passing 10 of 10 idle ones.
 *
 * Why counting turns fixes it
 * ---------------------------
 * These pipelines advance one step per event-loop turn, not per millisecond.
 * A zero-delay timer is already expired by the time a descheduled fork is
 * resumed, so it fires on the first timers phase after resumption: N awaited
 * turns buy N steps of real progress no matter how long the host took to get
 * around to them. The budget is denominated in the unit the work actually
 * consumes, so a busy machine makes the wait slower in wall clock without
 * making it less complete.
 *
 * This is not a retry and not a longer timeout: a pipeline that never reaches
 * its terminal state still fails, and it fails on the same assertion as before.
 */

/**
 * Default turn budget.
 *
 * Measured, not guessed. With `nextTurn` below, a chain of N zero-delay timers
 * needs exactly N turns (probed at depth 6 -> 6 turns, depth 40 -> 40 turns).
 * Instrumenting all 15 `settleUntil` call sites in the two WeChat suites gave:
 * 9 sites settle in 1 turn, 2 in 2, 3 in 3, and the deepest - `calls onError
 * after 3 expired responses`, 6 chained HTTPS round trips - in 6. So 500 is
 * ~83x the worst real pipeline: depth can grow freely before this needs
 * revisiting, while a genuinely stalled pipeline still gives up promptly and
 * fails on its own assertion.
 *
 * Cost: `settleUntil` returns on the turn its condition holds, so its 15 sites
 * across the two suites stay in the millisecond range. Only `settleTurns`
 * spends the budget in full, and it has 6 sites - 1 in `weixinLogin.test.ts`,
 * 5 in `weixinMonitor.test.ts` (`grep -rn "settleTurns()" tests/`).
 *
 * That full drain has NO wall-clock bound, and quoting one would defeat the
 * point of the helper: it buys turns, and a busy host makes each turn take
 * longer. Five consecutive drains measured on an otherwise idle machine cost
 * 4666, 2586, 1354, 1355 and 822 ms; under the 24-fork load of a full
 * `vitest run` a single one has been measured at 4360 ms. Running just these
 * two suites, the six `settleTurns` tests were the six slowest at 740-968 ms
 * each, against ~230 ms for the other 16 tests combined. Budget seconds per
 * call, not milliseconds, and re-measure before adding a seventh site.
 */
export const DEFAULT_TURN_BUDGET = 500;

/**
 * Yield control for exactly one event-loop turn.
 *
 * `setImmediate` alone is NOT enough and was measured to be actively wrong
 * here: spinning on it starves the timers phase, so a chain of 6 zero-delay
 * timers made zero progress across 500 immediate-only turns. Draining the
 * check phase first and then a zero-delay timer advances microtasks,
 * immediates and timers on every turn, which is what the mocked HTTP round
 * trips in these suites are built from.
 */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => setTimeout(resolve, 0));
  });
}

/**
 * Yield the event loop until `predicate` returns true, or until `turns` turns
 * have elapsed - whichever comes first.
 *
 * Returns as soon as the condition holds, so a passing test costs only the
 * turns the pipeline actually needed. Exhausting the budget is NOT reported as
 * an error here: the caller's own `expect` is what defines the failure, so the
 * assertion message stays the one that describes the missing behaviour rather
 * than a generic "wait timed out".
 */
export async function settleUntil(predicate: () => boolean, turns: number = DEFAULT_TURN_BUDGET): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (predicate()) return;
    // oxlint-disable-next-line eslint/no-await-in-loop
    await nextTurn();
  }
}

/**
 * Yield the event loop for a fixed number of turns.
 *
 * For assertions that something did NOT happen, where there is no positive
 * condition to wait for. The budget is spent in full by design - that is what
 * gives the pipeline every opportunity to do the forbidden thing before the
 * test concludes it did not.
 */
export async function settleTurns(turns: number = DEFAULT_TURN_BUDGET): Promise<void> {
  for (let i = 0; i < turns; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await nextTurn();
  }
}
