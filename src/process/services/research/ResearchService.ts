/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deep Research service (Odysseus assimilation "deep research").
 *
 * Owns the iterative research LOOP - the genuine gap in Darhai. Every decision
 * is model-driven (what to search, what's relevant, what's missing, when to
 * stop), mirroring Odysseus's IterResearch approach:
 *
 *   plan -> [ round: search -> read -> synthesize -> decide ] -> write report
 *
 * The loop REUSES Darhai primitives rather than inventing a new agent loop or
 * LLM client:
 *   - `search`        wraps the `web_search` builtin's in-process `.call`
 *   - `fetchAndRead`  the one new primitive (full page body, not a snippet)
 *   - `completeFast`  / `completeBest` are `oneShotComplete` with the cheap /
 *                     best model the user already has a key for
 * All four are dependency-injected so the loop unit-tests in pure isolation.
 *
 * Persistence + progress + cancel reuse the same shape the workflow runtime uses:
 * a run row is updated at every phase and a `runChanged` event is emitted, and
 * `cancel` is cooperative (the loop checks a flag between phases).
 */

import { uuid } from '@/common/utils';
import { wrapUntrusted } from './researchPrompts';
import {
  classifyPrompt,
  extractPrompt,
  finalReportPrompt,
  planPrompt,
  queryGenPrompt,
  stopPrompt,
  synthesizePrompt,
} from './researchPrompts';
import type { FetchAndReadResult } from './fetchAndRead';
import type { IResearchRunRepository } from './IResearchRunRepository';
import type { IResearchEventEmitter } from './IResearchEventEmitter';
import type { WebSearchResult } from '@process/resources/builtinMcp/webSearchServer';
import type {
  ResearchCategory,
  ResearchRun,
  ResearchSource,
  ResearchStatus,
  StartResearchParams,
} from '@/common/types/research';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const MAX_ROUNDS = 5;
const DEFAULT_ROUNDS = 3;
const QUERIES_ROUND_ONE = 4;
const QUERIES_LATER = 3;
/** Web-search results requested per query. */
const RESULTS_PER_QUERY = 6;
/** Cap on pages fetched + read per round (protects context + host pressure). */
const MAX_URLS_PER_ROUND = 6;
/** Newest-N runs surfaced in the recent-runs list. */
const RECENT_RUNS_LIMIT = 30;

/** Search-key tool ids the research loop depends on (drift-guarded against TOOL_KEY_ENV_MAP). */
export const RESEARCH_SEARCH_KEY_IDS = ['tavily', 'brave', 'exa'] as const;
/** The optional clean-scrape tool id fetchAndRead prefers when present. */
export const RESEARCH_SCRAPE_KEY_ID = 'firecrawl' as const;

/** A single extracted finding from one source. */
type Finding = {
  title: string;
  url: string;
  summary: string;
  evidence: string;
};

/**
 * The four Darhai primitives the loop drives, injected so the service stays
 * pure. Production wiring lives in `researchServiceSingleton`.
 */
export type ResearchEngineDeps = {
  /** Reuse of the `web_search` builtin's in-process `.call`. */
  search: (query: string, count: number) => Promise<WebSearchResult[]>;
  /** The new fetch-and-read primitive. */
  fetchAndRead: (url: string) => Promise<FetchAndReadResult>;
  /** `oneShotComplete` with the cheap/fast model (plan/query/extract/stop). */
  completeFast: (prompt: string) => Promise<string>;
  /** `oneShotComplete` with the best model (synthesize/final report). */
  completeBest: (prompt: string) => Promise<string>;
  /** Injected clock so the loop's date grounding + timestamps stay deterministic. */
  now: () => number;
};

const clampRounds = (rounds: number | undefined): number => {
  if (typeof rounds !== 'number' || !Number.isFinite(rounds)) return DEFAULT_ROUNDS;
  return Math.max(1, Math.min(MAX_ROUNDS, Math.floor(rounds)));
};

const VALID_CATEGORIES: ReadonlySet<ResearchCategory> = new Set([
  'auto',
  'general',
  'product',
  'comparison',
  'howto',
  'factcheck',
]);

/** Extract the first JSON array of strings from a possibly-noisy model reply. */
function parseJsonArray(reply: string): string[] {
  const cleaned = stripCodeFence(reply);
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
  } catch {
    return [];
  }
}

/** Extract the first JSON object from a possibly-noisy model reply. */
function parseJsonObject(reply: string): Record<string, unknown> | null {
  const cleaned = stripCodeFence(reply);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stripCodeFence(reply: string): string {
  return reply.replace(/```(?:json)?/gi, '').trim();
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export class ResearchService {
  /** In-flight loop promises, exposed to tests via {@link waitForRun}. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Run ids the user asked to cancel; checked cooperatively between phases. */
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly repo: IResearchRunRepository,
    private readonly emitter: IResearchEventEmitter,
    private readonly deps: ResearchEngineDeps
  ) {}

  /**
   * Create a run row and launch the loop in the background. Returns immediately
   * with the run id; the renderer follows progress via `onRunChanged` + polls
   * `getRun`. The loop promise is retained so tests can await completion.
   */
  async start(userId: string, params: StartResearchParams): Promise<{ runId: string }> {
    const query = params.query.trim();
    if (!query) throw new Error('research.start: query is required');
    const category: ResearchCategory =
      params.category && VALID_CATEGORIES.has(params.category) ? params.category : 'auto';
    const targetRounds = clampRounds(params.rounds);

    const now = this.deps.now();
    const run: ResearchRun = {
      id: `res_${uuid()}`,
      userId,
      query,
      category,
      status: 'planning',
      rounds: 0,
      report: '',
      sources: [],
      error: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.repo.insert(run);
    this.emit(run.id, 'planning');

    const promise = this.runLoop(run.id, query, category, targetRounds)
      .catch((error: unknown) => this.failRun(run.id, error))
      .finally(() => {
        this.inflight.delete(run.id);
        this.cancelled.delete(run.id);
      });
    this.inflight.set(run.id, promise);

    return { runId: run.id };
  }

  async getRun(runId: string): Promise<ResearchRun | null> {
    return this.repo.getById(runId);
  }

  async listRuns(userId: string): Promise<ResearchRun[]> {
    return this.repo.listByUser(userId, RECENT_RUNS_LIMIT);
  }

  /**
   * Cooperatively cancel a run. Flags it (so the loop stops between phases) and,
   * when the run is still non-terminal, flips its status to `cancelled`.
   */
  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
    const run = await this.repo.getById(runId);
    if (!run || run.status === 'done' || run.status === 'error' || run.status === 'cancelled') return;
    await this.repo.update(runId, { status: 'cancelled' });
    this.emit(runId, 'cancelled');
  }

  /** Await the background loop for a run (tests / graceful shutdown). No-op if unknown. */
  async waitForRun(runId: string): Promise<void> {
    const promise = this.inflight.get(runId);
    if (promise) await promise;
  }

  // --- The loop ------------------------------------------------------------

  private async runLoop(runId: string, query: string, category: ResearchCategory, targetRounds: number): Promise<void> {
    if (this.isCancelled(runId)) return;

    // PLAN
    if (!(await this.setStatus(runId, 'planning'))) return;
    const plan = asText(await this.deps.completeBest(planPrompt(query, this.deps.now())));
    const resolvedCategory = category === 'auto' ? await this.classify(query) : category;

    let report = '';
    const sources: ResearchSource[] = [];
    const seenUrls = new Set<string>();
    let completedRounds = 0;
    let sawAnyFinding = false;

    // The round loop is intentionally sequential: this is iterative deepening -
    // round N's queries are generated from round N-1's evolving report, and the
    // per-source reads are bounded to cap model/host pressure (Odysseus uses a
    // semaphore; we serialize). Parallelizing would defeat the deepening design.
    /* eslint-disable no-await-in-loop */
    for (let round = 1; round <= targetRounds; round++) {
      if (this.isCancelled(runId)) return;

      // SEARCH: generate queries, run them, collect fresh URLs.
      if (!(await this.setStatus(runId, 'searching'))) return;
      const numQueries = round === 1 ? QUERIES_ROUND_ONE : QUERIES_LATER;
      let queries = parseJsonArray(
        await this.deps.completeFast(
          queryGenPrompt({ question: query, plan, report, round, numQueries, now: this.deps.now() })
        )
      );
      if (queries.length === 0 && round === 1) queries = [query];
      queries = dedupe(queries).slice(0, numQueries);

      const urls = await this.collectUrls(queries, seenUrls);
      if (this.isCancelled(runId)) return;

      // READ: fetch + extract each source.
      if (!(await this.setStatus(runId, 'reading'))) return;
      const roundFindings: Finding[] = [];
      for (const hit of urls) {
        if (this.isCancelled(runId)) return;
        const finding = await this.readOne(hit, query);
        if (!finding) continue;
        roundFindings.push(finding);
        sawAnyFinding = true;
        if (!sources.some((s) => s.url === finding.url)) {
          sources.push({ title: finding.title || finding.url, url: finding.url });
        }
      }
      if (this.isCancelled(runId)) return;

      // SYNTHESIZE: fold this round's findings into the evolving report.
      if (!(await this.setStatus(runId, 'synthesizing'))) return;
      if (roundFindings.length > 0) {
        const updated = asText(
          await this.deps.completeBest(synthesizePrompt(query, report, formatFindings(roundFindings)))
        );
        if (updated) report = updated;
      }
      completedRounds = round;
      await this.repo.update(runId, { rounds: completedRounds, report, sources });

      // DECIDE: stop early when the model judges the report comprehensive.
      if (round < targetRounds && report.trim()) {
        const decision = await this.deps.completeFast(stopPrompt(query, report, round, targetRounds));
        if (/^\s*yes\b/i.test(decision)) break;
      }
    }
    /* eslint-enable no-await-in-loop */

    if (this.isCancelled(runId)) return;

    // WRITE: compose the final long-form report + append the Sources section.
    if (!(await this.setStatus(runId, 'writing'))) return;
    let finalReport = report;
    if (report.trim() || sawAnyFinding) {
      const written = asText(await this.deps.completeBest(finalReportPrompt(query, report, resolvedCategory)));
      if (written) finalReport = written;
    }
    finalReport = appendSourcesSection(finalReport, sources);

    if (this.isCancelled(runId)) return;
    await this.repo.update(runId, { status: 'done', report: finalReport, sources, rounds: completedRounds });
    this.emit(runId, 'done');
  }

  /** Classify an `auto` run into a report category (falls back to `general`). */
  private async classify(query: string): Promise<ResearchCategory> {
    try {
      const raw = (await this.deps.completeFast(classifyPrompt(query))).toLowerCase();
      for (const cat of VALID_CATEGORIES) {
        if (cat !== 'auto' && cat !== 'general' && raw.includes(cat)) return cat;
      }
    } catch {
      // fall through to general
    }
    return 'general';
  }

  /** Run each query and collect up to MAX_URLS_PER_ROUND fresh, unseen URLs. */
  private async collectUrls(queries: string[], seenUrls: Set<string>): Promise<WebSearchResult[]> {
    const results = await Promise.all(queries.map((q) => this.safeSearch(q)));
    const out: WebSearchResult[] = [];
    for (const list of results) {
      for (const hit of list) {
        if (out.length >= MAX_URLS_PER_ROUND) break;
        const url = hit.url?.trim();
        if (!url || seenUrls.has(url)) continue;
        seenUrls.add(url);
        out.push(hit);
      }
    }
    return out;
  }

  /** Search one query; a provider error yields [] so the round survives. */
  private async safeSearch(query: string): Promise<WebSearchResult[]> {
    try {
      return await this.deps.search(query, RESULTS_PER_QUERY);
    } catch {
      return [];
    }
  }

  /**
   * Fetch + extract one source. The page body is wrapped as UNTRUSTED before it
   * reaches the extractor model (prompt-injection safety). Returns null when the
   * fetch fails or the model reports nothing relevant.
   */
  private async readOne(hit: WebSearchResult, query: string): Promise<Finding | null> {
    let page: FetchAndReadResult;
    try {
      page = await this.deps.fetchAndRead(hit.url);
    } catch {
      return null;
    }
    if (!page.success || !page.content.trim()) return null;

    const wrapped = wrapUntrusted(hit.title || hit.url, page.content);
    let raw: string;
    try {
      raw = await this.deps.completeFast(extractPrompt(query, wrapped));
    } catch {
      return null;
    }

    const title = hit.title || page.title || hit.url;
    const parsed = parseJsonObject(raw);
    if (parsed) {
      const summary = asText(parsed.summary);
      if (isLowQuality(summary)) return null;
      return { title, url: hit.url, summary, evidence: asText(parsed.evidence) };
    }
    // Non-JSON reply: treat the whole thing as evidence unless it's clearly empty.
    const evidence = asText(raw);
    if (isLowQuality(evidence)) return null;
    return { title, url: hit.url, summary: evidence.slice(0, 500), evidence: evidence.slice(0, 3000) };
  }

  // --- Status + events -----------------------------------------------------

  /**
   * Persist a phase transition + emit. Returns false when the run was cancelled
   * (so the loop stops without clobbering the `cancelled` status the cancel path
   * already wrote).
   */
  private async setStatus(runId: string, status: ResearchStatus): Promise<boolean> {
    if (this.isCancelled(runId)) return false;
    await this.repo.update(runId, { status });
    this.emit(runId, status);
    return true;
  }

  private async failRun(runId: string, error: unknown): Promise<void> {
    if (this.isCancelled(runId)) return;
    const message = error instanceof Error ? error.message : 'research failed';
    try {
      await this.repo.update(runId, { status: 'error', error: message });
      this.emit(runId, 'error');
    } catch {
      // The run row may already be gone (deleted mid-flight); nothing to do.
    }
  }

  private isCancelled(runId: string): boolean {
    return this.cancelled.has(runId);
  }

  private emit(runId: string, status: ResearchStatus): void {
    this.emitter.emitRunChanged({ runId, status });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** True when the model signalled the page had nothing useful. */
function isLowQuality(summary: string): boolean {
  const s = summary.trim();
  if (s.length === 0) return true;
  return /no[_\s-]*relevant[_\s-]*info/i.test(s);
}

/** Render this round's findings for the synthesis prompt, with source attribution. */
function formatFindings(findings: Finding[]): string {
  return findings
    .map((f, i) => {
      const parts = [`[${i + 1}] ${f.title} (${f.url})`];
      if (f.summary) parts.push(`Summary: ${f.summary}`);
      if (f.evidence) parts.push(`Evidence: ${f.evidence}`);
      return parts.join('\n');
    })
    .join('\n\n');
}

/**
 * Append a `## Sources` section listing each cited source, unless the report
 * already contains one (the final-report prompt may have written its own).
 */
function appendSourcesSection(report: string, sources: ResearchSource[]): string {
  if (sources.length === 0) return report;
  if (/(^|\n)#{1,3}\s*sources\b/i.test(report)) return report;
  const list = sources.map((s) => `- [${s.title || s.url}](${s.url})`).join('\n');
  const base = report.trimEnd();
  return `${base}\n\n## Sources\n\n${list}\n`;
}
