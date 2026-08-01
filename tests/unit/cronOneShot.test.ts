import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/userData'),
    getAppPath: vi.fn(() => '/mock/appPath'),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  powerMonitor: { on: vi.fn() },
}));
vi.mock('@/common/platform', () => ({
  getPlatformServices: () => ({
    power: { preventSleep: vi.fn(() => 1), allowSleep: vi.fn() },
  }),
}));
vi.mock('croner', () => ({
  Cron: vi.fn(() => ({ stop: vi.fn(), nextRun: vi.fn(() => null) })),
}));
vi.mock('@process/services/i18n', () => ({
  default: { t: vi.fn((key: string) => key) },
  i18nReady: Promise.resolve(),
}));
vi.mock('@process/utils/message', () => ({ addMessage: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: { conversation: { responseStream: { emit: vi.fn() } } },
}));
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: vi.fn(async () => false) },
  getCronSkillsDir: vi.fn(() => '/mock/cronSkills'),
}));
vi.mock('@/process/services/cron/cronSkillFile', () => ({
  writeCronSkillFile: vi.fn(async () => '/mock/cronSkills/job-id/SKILL.md'),
  deleteCronSkillFile: vi.fn(async () => {}),
}));

import { CronService } from '../../src/process/services/cron/CronService';
import type { ICronRepository } from '../../src/process/services/cron/ICronRepository';
import type { ICronEventEmitter } from '../../src/process/services/cron/ICronEventEmitter';
import type { ICronJobExecutor } from '../../src/process/services/cron/ICronJobExecutor';
import type { IConversationRepository } from '../../src/process/services/database/IConversationRepository';
import type { CronJob } from '../../src/process/services/cron/CronStore';

/** Stateful repo that mirrors CronStore.update merge semantics. */
function makeStatefulRepo(): ICronRepository & { rows: Map<string, CronJob> } {
  const rows = new Map<string, CronJob>();
  return {
    rows,
    insert: vi.fn(async (job: CronJob) => {
      rows.set(job.id, structuredClone(job));
    }),
    update: vi.fn(async (jobId: string, updates: Partial<CronJob>) => {
      // The real repo awaits `getDatabase()` before touching a row, so a write
      // is never atomic with respect to a concurrently-running update.
      await Promise.resolve();
      const existing = rows.get(jobId);
      if (!existing) return;
      rows.set(jobId, {
        ...existing,
        ...updates,
        metadata: { ...existing.metadata, ...updates.metadata, updatedAt: Date.now() },
        state: { ...existing.state, ...updates.state },
      });
    }),
    delete: vi.fn(async (jobId: string) => {
      rows.delete(jobId);
    }),
    getById: vi.fn(async (jobId: string) => structuredClone(rows.get(jobId) ?? null)),
    listAll: vi.fn(async () => [...rows.values()]),
    listEnabled: vi.fn(async () => [...rows.values()].filter((j) => j.enabled)),
    listByConversation: vi.fn(async () => []),
    deleteByConversation: vi.fn(async () => 0),
  } as unknown as ICronRepository & { rows: Map<string, CronJob> };
}

function makeEmitter(): ICronEventEmitter {
  return {
    emitJobCreated: vi.fn(),
    emitJobUpdated: vi.fn(),
    emitJobRemoved: vi.fn(),
    emitJobExecuted: vi.fn(),
    showNotification: vi.fn(async () => {}),
  } as unknown as ICronEventEmitter;
}

function makeExecutor(): ICronJobExecutor {
  return {
    isConversationBusy: vi.fn(() => false),
    // A real executor awaits IPC/DB work; model that with a couple of ticks so
    // the state write interleaves with the disable-after-run update.
    executeJob: vi.fn(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      return undefined;
    }),
    onceIdle: vi.fn(),
    setProcessing: vi.fn(),
    prepareConversation: vi.fn(async () => 'conv-1'),
  } as unknown as ICronJobExecutor;
}

function makeConversationRepo(): IConversationRepository {
  return {
    getConversation: vi.fn(() => ({ id: 'conv-1', extra: {} })),
    createConversation: vi.fn(),
    updateConversation: vi.fn(),
    deleteConversation: vi.fn(),
    getMessages: vi.fn(() => ({ data: [], total: 0, hasMore: false })),
    insertMessage: vi.fn(),
    getUserConversations: vi.fn(() => ({ data: [], total: 0, hasMore: false })),
    listAllConversations: vi.fn(() => []),
    searchMessages: vi.fn(async () => ({ data: [], total: 0, hasMore: false })),
    getConversationsByCronJob: vi.fn(async () => []),
  } as unknown as IConversationRepository;
}

/**
 * One-shot ('at') cron jobs: the status a run leaves behind must survive both
 * the disable-after-run write and any later re-arm of the same job.
 */
describe('one-shot at job', () => {
  let repo: ReturnType<typeof makeStatefulRepo>;
  let service: CronService;

  beforeEach(() => {
    vi.useFakeTimers();
    repo = makeStatefulRepo();
    service = new CronService(repo, makeEmitter(), makeExecutor(), makeConversationRepo());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('reports ok - not skipped - after it actually runs', async () => {
    const job = await service.addJob({
      name: 'one-shot',
      schedule: { kind: 'at', atMs: Date.now() + 1000, description: 'in 1s' },
      prompt: 'hello',
      conversationId: 'conv-1',
      agentType: 'gemini',
      createdBy: 'user',
    });

    await vi.advanceTimersByTimeAsync(1500);
    // Let any trailing microtasks / chained updates settle.
    await vi.advanceTimersByTimeAsync(100);

    const final = repo.rows.get(job.id)!;
    expect(final.state.runCount).toBe(1);
    expect(final.state.lastStatus).toBe('ok');
    expect(final.state.lastError).toBeUndefined();
    // One-shot jobs disable themselves once the run has finished.
    expect(final.enabled).toBe(false);
  });

  it('re-arming an already-run one-shot job keeps its recorded result', async () => {
    const atMs = Date.now() - 60_000;
    const job: CronJob = {
      id: 'one-shot-ran',
      name: 'ran already',
      enabled: true,
      schedule: { kind: 'at', atMs, description: 'a minute ago' },
      target: { payload: { kind: 'message', text: 'hi' } },
      metadata: {
        conversationId: 'conv-1',
        agentType: 'gemini',
        createdBy: 'user',
        createdAt: atMs - 1000,
        updatedAt: atMs - 1000,
      },
      state: { runCount: 1, retryCount: 0, maxRetries: 3, lastRunAtMs: atMs + 5, lastStatus: 'ok' },
    };
    repo.rows.set(job.id, job);

    await service.init();

    const final = repo.rows.get(job.id)!;
    expect(final.state.lastStatus).toBe('ok');
    expect(final.state.lastError).toBeUndefined();
    expect(final.enabled).toBe(false);
  });

  it('marks a genuinely missed one-shot job as skipped', async () => {
    const atMs = Date.now() - 60_000;
    const job: CronJob = {
      id: 'one-shot-missed',
      name: 'never ran',
      enabled: true,
      schedule: { kind: 'at', atMs, description: 'a minute ago' },
      target: { payload: { kind: 'message', text: 'hi' } },
      metadata: {
        conversationId: 'conv-1',
        agentType: 'gemini',
        createdBy: 'user',
        createdAt: atMs - 1000,
        updatedAt: atMs - 1000,
      },
      state: { runCount: 0, retryCount: 0, maxRetries: 3 },
    };
    repo.rows.set(job.id, job);

    await service.init();

    const final = repo.rows.get(job.id)!;
    expect(final.state.lastStatus).toBe('skipped');
    expect(final.enabled).toBe(false);
  });
});
