// tests/unit/process/acp/session/ApprovalPersistence.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store } = vi.hoisted(() => ({ store: { value: {} as Record<string, unknown> } }));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: {
    get: vi.fn(async (key: string) => store.value[key]),
    set: vi.fn(async (key: string, value: unknown) => {
      store.value[key] = value;
    }),
  },
}));
vi.mock('@process/utils/mainLogger', () => ({
  mainLog: vi.fn(),
  mainError: vi.fn(),
}));

// eslint-disable-next-line import/first
import {
  loadWorkspaceApprovals,
  saveWorkspaceApproval,
  clearWorkspaceApprovals,
} from '@process/acp/session/ApprovalPersistence';
// eslint-disable-next-line import/first
import { ProcessConfig } from '@process/utils/initStorage';

const CWD = '/home/user/project';

describe('ApprovalPersistence', () => {
  beforeEach(() => {
    store.value = {};
    vi.clearAllMocks();
  });

  it('round-trips a saved approval scoped to its workspace', async () => {
    await saveWorkspaceApproval(CWD, 'key-1', 'allow_always');
    expect(await loadWorkspaceApprovals(CWD)).toEqual([['key-1', 'allow_always']]);
    // A different workspace sees nothing.
    expect(await loadWorkspaceApprovals('/other/ws')).toEqual([]);
  });

  it('skips the config write when the same decision is already stored', async () => {
    await saveWorkspaceApproval(CWD, 'key-1', 'allow_always');
    const setCalls = (ProcessConfig.set as ReturnType<typeof vi.fn>).mock.calls.length;
    await saveWorkspaceApproval(CWD, 'key-1', 'allow_always'); // redundant
    expect((ProcessConfig.set as ReturnType<typeof vi.fn>).mock.calls.length).toBe(setCalls);
  });

  it('overwrites the optionId for an existing key without duplicating it', async () => {
    await saveWorkspaceApproval(CWD, 'key-1', 'allow_once');
    await saveWorkspaceApproval(CWD, 'key-1', 'allow_always');
    expect(await loadWorkspaceApprovals(CWD)).toEqual([['key-1', 'allow_always']]);
  });

  it('clears only the target workspace', async () => {
    await saveWorkspaceApproval(CWD, 'key-1', 'allow_always');
    await saveWorkspaceApproval('/ws2', 'key-2', 'allow_always');
    await clearWorkspaceApprovals(CWD);
    expect(await loadWorkspaceApprovals(CWD)).toEqual([]);
    expect(await loadWorkspaceApprovals('/ws2')).toEqual([['key-2', 'allow_always']]);
  });

  it('is fail-soft: a read error yields [] rather than throwing', async () => {
    (ProcessConfig.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk gone'));
    await expect(loadWorkspaceApprovals(CWD)).resolves.toEqual([]);
  });

  it('ignores an empty cwd on save and load', async () => {
    await saveWorkspaceApproval('', 'key', 'allow_always');
    expect(ProcessConfig.set).not.toHaveBeenCalled();
    expect(await loadWorkspaceApprovals('')).toEqual([]);
  });
});
