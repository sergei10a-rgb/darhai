/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for ResearchService - the deep-research loop - in pure isolation.
 * An in-memory repo + mock emitter + fully-mocked engine deps (search /
 * fetchAndRead / completeFast / completeBest / now) let the loop run
 * deterministically with no DB, network, or model dependency. We assert it
 * produces a cited report, persists it, emits progress per phase, and that
 * cancel stops it cooperatively.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResearchService, type ResearchEngineDeps } from '@process/services/research/ResearchService';
import type { IResearchRunRepository, ResearchRunPatch } from '@process/services/research/IResearchRunRepository';
import type { IResearchEventEmitter } from '@process/services/research/IResearchEventEmitter';
import type { WebSearchResult } from '@process/resources/builtinMcp/webSearchServer';
import type { ResearchRun, ResearchRunChangedEvent, ResearchStatus } from '@/common/types/research';

class InMemoryResearchRepo implements IResearchRunRepository {
  runs = new Map<string, ResearchRun>();

  async insert(run: ResearchRun): Promise<void> {
    this.runs.set(run.id, { ...run });
  }
  async update(runId: string, patch: ResearchRunPatch): Promise<ResearchRun> {
    const current = this.runs.get(runId);
    if (!current) throw new Error(`no run ${runId}`);
    const next: ResearchRun = { ...current, ...patch, updatedAtMs: current.updatedAtMs + 1 };
    this.runs.set(runId, next);
    return { ...next };
  }
  async getById(runId: string): Promise<ResearchRun | null> {
    const run = this.runs.get(runId);
    return run ? { ...run } : null;
  }
  async listByUser(userId: string, limit: number): Promise<ResearchRun[]> {
    return [...this.runs.values()]
      .filter((r) => r.userId === userId)
      .toSorted((a, b) => b.updatedAtMs - a.updatedAtMs)
      .slice(0, limit);
  }
  async delete(runId: string): Promise<void> {
    this.runs.delete(runId);
  }
}

function makeEmitter(): { emitter: IResearchEventEmitter; events: ResearchRunChangedEvent[] } {
  const events: ResearchRunChangedEvent[] = [];
  return { emitter: { emitRunChanged: (e) => events.push(e) }, events };
}

const SEARCH_HITS: WebSearchResult[] = [
  { title: 'Solar cost', url: 'https://a.example/solar', snippet: 's' },
  { title: 'Wind cost', url: 'https://b.example/wind', snippet: 'w' },
];

/** Route a completion by the identifying substring of each prompt builder. */
function routeCompleteFast(prompt: string): string {
  if (prompt.includes('Classify this research question')) return 'general';
  if (prompt.includes('planning web searches')) return '["solar cost 2026", "wind cost 2026"]';
  if (prompt.includes('Extract relevant information from a web page')) {
    return '{"summary": "Solar is now the cheapest source.", "evidence": "LCOE fell to $30/MWh."}';
  }
  if (prompt.includes('deciding whether a research report')) return 'NO - more evidence needed.';
  return '';
}

function routeCompleteBest(prompt: string): string {
  if (prompt.includes('research strategist')) {
    return '{"sub_questions": ["cost?", "trend?"], "key_topics": ["solar", "wind"], "success_criteria": "balanced"}';
  }
  if (prompt.includes('updating an evolving research report')) {
    return 'Solar is cheaper than wind in 2026 [Solar cost](https://a.example/solar).';
  }
  if (prompt.includes('Write a long, detailed, comprehensive research report')) {
    return '# Energy Report\n\n## Summary\n\nSolar leads on cost [Solar cost](https://a.example/solar).';
  }
  return '';
}

function makeDeps(overrides: Partial<ResearchEngineDeps> = {}): ResearchEngineDeps {
  return {
    search: vi.fn(async () => SEARCH_HITS),
    fetchAndRead: vi.fn(async (url: string) => ({ success: true, title: `Title ${url}`, content: 'page body' })),
    completeFast: vi.fn(async (prompt: string) => routeCompleteFast(prompt)),
    completeBest: vi.fn(async (prompt: string) => routeCompleteBest(prompt)),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

const USER = 'user-1';

describe('ResearchService loop', () => {
  let repo: InMemoryResearchRepo;

  beforeEach(() => {
    repo = new InMemoryResearchRepo();
  });

  it('runs the full loop, produces a cited report, persists it, and emits progress', async () => {
    const { emitter, events } = makeEmitter();
    const service = new ResearchService(repo, emitter, makeDeps());

    const { runId } = await service.start(USER, { query: 'Is solar cheaper than wind?', rounds: 1 });
    await service.waitForRun(runId);

    const run = await repo.getById(runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe('done');
    expect(run!.rounds).toBe(1);

    // Cited report + appended Sources section.
    expect(run!.report).toContain('# Energy Report');
    expect(run!.report).toContain('](https://a.example/solar)');
    expect(run!.report).toContain('## Sources');
    expect(run!.sources.map((s) => s.url)).toContain('https://a.example/solar');
    expect(run!.sources.map((s) => s.url)).toContain('https://b.example/wind');

    // Progress emitted per phase, ending at done.
    const statuses = events.map((e) => e.status);
    const expectedOrder: ResearchStatus[] = ['planning', 'searching', 'reading', 'synthesizing', 'writing', 'done'];
    for (const phase of expectedOrder) {
      expect(statuses).toContain(phase);
    }
    expect(statuses[statuses.length - 1]).toBe('done');
    expect(statuses.indexOf('searching')).toBeLessThan(statuses.indexOf('reading'));
    expect(statuses.indexOf('writing')).toBeLessThan(statuses.indexOf('done'));
  });

  it('wraps fetched page bodies as UNTRUSTED before the extractor sees them', async () => {
    const { emitter } = makeEmitter();
    const completeFast = vi.fn(async (prompt: string) => routeCompleteFast(prompt));
    const service = new ResearchService(repo, emitter, makeDeps({ completeFast }));

    const { runId } = await service.start(USER, { query: 'q', rounds: 1 });
    await service.waitForRun(runId);

    const extractCall = completeFast.mock.calls.find(([p]) => p.includes('Extract relevant information'));
    expect(extractCall).toBeDefined();
    expect(extractCall![0]).toContain('UNTRUSTED SOURCE DATA');
    expect(extractCall![0]).toContain('<<<UNTRUSTED_SOURCE_DATA>>>');
  });

  it('runs multiple rounds and stops early when the model says YES', async () => {
    const { emitter } = makeEmitter();
    const completeFast = vi.fn(async (prompt: string) => {
      if (prompt.includes('deciding whether a research report')) return 'YES - comprehensive enough.';
      return routeCompleteFast(prompt);
    });
    const service = new ResearchService(repo, emitter, makeDeps({ completeFast }));

    const { runId } = await service.start(USER, { query: 'q', rounds: 4 });
    await service.waitForRun(runId);

    const run = await repo.getById(runId);
    expect(run!.status).toBe('done');
    // Stopped after round 1 despite a target of 4.
    expect(run!.rounds).toBe(1);
  });

  it('cancel stops the loop cooperatively and never reaches done', async () => {
    const { emitter, events } = makeEmitter();

    // Make the plan step hang until we have cancelled, so the loop is mid-flight.
    let releasePlan: () => void = () => {};
    const planGate = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    const completeBest = vi.fn(async (prompt: string) => {
      if (prompt.includes('research strategist')) {
        await planGate;
      }
      return routeCompleteBest(prompt);
    });

    // category 'general' so no classify step muddies the cancel timing.
    const service = new ResearchService(repo, emitter, makeDeps({ completeBest }));
    const { runId } = await service.start(USER, { query: 'q', category: 'general', rounds: 3 });

    await service.cancel(runId);
    releasePlan();
    await service.waitForRun(runId);

    const run = await repo.getById(runId);
    expect(run!.status).toBe('cancelled');
    const statuses = events.map((e) => e.status);
    expect(statuses).toContain('cancelled');
    expect(statuses).not.toContain('done');
  });

  it('marks the run errored when a heavy step throws', async () => {
    const { emitter, events } = makeEmitter();
    const completeBest = vi.fn(async (prompt: string) => {
      if (prompt.includes('research strategist')) throw new Error('planner exploded');
      return routeCompleteBest(prompt);
    });
    const service = new ResearchService(repo, emitter, makeDeps({ completeBest }));

    const { runId } = await service.start(USER, { query: 'q', rounds: 1 });
    await service.waitForRun(runId);

    const run = await repo.getById(runId);
    expect(run!.status).toBe('error');
    expect(run!.error).toContain('planner exploded');
    expect(events.map((e) => e.status)).toContain('error');
  });

  it("lists a user's runs and cancel is a no-op on an unknown run", async () => {
    const { emitter } = makeEmitter();
    const service = new ResearchService(repo, emitter, makeDeps());
    const { runId } = await service.start(USER, { query: 'q', rounds: 1 });
    await service.waitForRun(runId);

    const runs = await service.listRuns(USER);
    expect(runs.map((r) => r.id)).toContain(runId);
    await expect(service.cancel('res_does_not_exist')).resolves.toBeUndefined();
  });
});
