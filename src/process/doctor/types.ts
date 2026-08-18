/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Doctor — Darhai's diagnostic surface, ported from the upstream check
 * registry + runner (upstream commit e4324b592, "feat(doctor): diagnostic
 * check registry and runner").
 *
 * A Doctor run executes a battery of independent checks across Darhai's own
 * subsystems (the bundled bun runtime, builtin MCP servers, the llama.cpp
 * runtime receipt, the Mongolian voice components, ffmpeg, the OmniRoute
 * gateway, the memory index, disk space) and reports a per-check verdict with
 * a human-readable detail and, on a non-pass, an actionable remediation.
 *
 * Each check is a self-contained `{ id, titleKey, category, run() }` record
 * whose `run()` resolves a typed result and never throws — the runner
 * additionally guards every check so one thrown error cannot abort the
 * battery. Adding a check is a single registry entry (see `registry.ts`).
 */

/** The verdict of a single diagnostic check. */
export type DoctorStatus = 'pass' | 'warn' | 'fail';

/**
 * Subsystem group a check belongs to. Used purely to group checks in the UI;
 * adding a category is a string-union edit plus an i18n label.
 */
export type DoctorCategory = 'runtime' | 'services' | 'models' | 'system';

/** The outcome a check's `run()` resolves. */
export type DoctorCheckOutcome = {
  status: DoctorStatus;
  /** One-line human-readable summary of what was found (user's language). */
  detail: string;
  /** Actionable next step when `status` is `warn`/`fail`. Omitted on `pass`. */
  remediation?: string;
};

/**
 * A single registered diagnostic check. Pure-ish and individually testable: it
 * captures its own dependencies and exposes one async `run()`.
 */
export type DoctorCheck = {
  /** Stable machine-readable id, e.g. `runtime.bun`. */
  id: string;
  /** i18n key for the check's display title (translated in the renderer). */
  titleKey: string;
  category: DoctorCategory;
  /**
   * Run the check. Should resolve a verdict for every reachable outcome and
   * avoid throwing; the runner still wraps it so a throw becomes a `fail`.
   */
  run: () => Promise<DoctorCheckOutcome>;
};

/** A check's outcome plus its identity — what the runner returns per check. */
export type DoctorCheckResult = DoctorCheckOutcome & {
  id: string;
  titleKey: string;
  category: DoctorCategory;
  /** Wall-clock duration of `run()` in milliseconds. */
  durationMs: number;
};

/** The aggregated result of a full Doctor run. */
export type DoctorReport = {
  /** ISO-8601 timestamp the run completed. */
  ranAt: string;
  /** Worst status across all checks (`fail` > `warn` > `pass`). */
  overall: DoctorStatus;
  counts: { pass: number; warn: number; fail: number };
  results: DoctorCheckResult[];
};
