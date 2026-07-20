/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the Deep Research feature (Odysseus assimilation "deep research").
 *
 * Darhai already owns every ingredient this feature needs - a workflow runtime
 * (persistence / cancel / progress), a `web_search` builtin, `oneShotComplete`
 * for background LLM calls, and a markdown renderer. The genuine gap is an
 * LLM-planned iterative research LOOP (plan -> search -> fetch -> read ->
 * synthesize -> decide -> report) plus one new primitive: a URL fetch-and-read
 * (the `web_search` builtin returns snippets only, never full page bodies).
 *
 * These shapes cross the IPC boundary. All timestamps follow Darhai's UTC
 * epoch-ms `*Ms` naming convention.
 */

/**
 * Where a research run currently sits in the loop. The first six are transient
 * phases the progress rail paints; the last three are terminal.
 *
 *  - `planning`      the model is drafting a research strategy
 *  - `searching`     web queries are being generated + run
 *  - `reading`       source pages are being fetched + extracted
 *  - `synthesizing`  findings are being folded into the evolving report
 *  - `writing`       the final long-form report is being composed
 *  - `done`          finished successfully (report + sources populated)
 *  - `error`         a fatal failure (see `error`)
 *  - `cancelled`     the user stopped the run cooperatively
 */
export type ResearchStatus =
  | 'planning'
  | 'searching'
  | 'reading'
  | 'synthesizing'
  | 'writing'
  | 'done'
  | 'error'
  | 'cancelled';

/**
 * Report shape override. `auto` lets the model classify; the rest force a
 * format (ranked product list, comparison table, how-to guide, fact-check,
 * or the default general article). Mirrors Odysseus's category prompts.
 */
export type ResearchCategory = 'auto' | 'general' | 'product' | 'comparison' | 'howto' | 'factcheck';

/** A single cited source surfaced during a run (title + URL only). */
export type ResearchSource = {
  title: string;
  url: string;
};

/** A persisted research run - the query, its live status, and (when done) the report. */
export type ResearchRun = {
  id: string;
  userId: string;
  query: string;
  category: ResearchCategory;
  status: ResearchStatus;
  /** How many search->read->synthesize rounds the loop actually completed. */
  rounds: number;
  /** The final markdown report (empty until `status === 'done'`). */
  report: string;
  /** Every source cited in the report. */
  sources: ResearchSource[];
  /** Populated only when `status === 'error'`. */
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

/**
 * Fields accepted when starting a run. The server fills id / status / timestamps
 * and clamps `rounds` to a safe range. `category` defaults to `auto`.
 */
export type StartResearchParams = {
  query: string;
  category?: ResearchCategory;
  /** Target number of deepening rounds (clamped 1..MAX). Omit for the default. */
  rounds?: number;
};

/** Payload emitted on any run status change so open surfaces refresh. */
export type ResearchRunChangedEvent = {
  runId: string;
  status: ResearchStatus;
};
