/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGet, mockSet } = vi.hoisted(() => ({ mockGet: vi.fn(), mockSet: vi.fn() }));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: mockGet, set: mockSet },
}));

import { getHookGuardConfig, setHookGuardEnabled } from '@process/agent/guard/config';

describe('getHookGuardConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to enabled with an empty ruleset when unset', async () => {
    mockGet.mockResolvedValue(undefined);
    expect(await getHookGuardConfig()).toEqual({ enabled: true, rules: [] });
  });

  it('respects an explicit enabled:false', async () => {
    mockGet.mockResolvedValue({ enabled: false });
    expect((await getHookGuardConfig()).enabled).toBe(false);
  });

  it('passes through a stored additive ruleset', async () => {
    const rules = [{ id: 'x', event: 'pre', action: 'deny', commandPattern: 'y' }];
    mockGet.mockResolvedValue({ enabled: true, rules });
    expect((await getHookGuardConfig()).rules).toEqual(rules);
  });

  it('fails safe to the enabled default when the store throws', async () => {
    mockGet.mockRejectedValue(new Error('store not ready'));
    expect(await getHookGuardConfig()).toEqual({ enabled: true, rules: [] });
  });
});

describe('setHookGuardEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists the enabled flag while preserving existing rules', async () => {
    const rules = [{ id: 'x', event: 'pre', action: 'deny', commandPattern: 'y' }];
    mockGet.mockResolvedValue({ enabled: true, rules });
    await setHookGuardEnabled(false);
    expect(mockSet).toHaveBeenCalledWith('agent.hookGuard', { enabled: false, rules });
  });

  it('persists with an empty ruleset when no prior config is readable', async () => {
    mockGet.mockRejectedValue(new Error('nope'));
    await setHookGuardEnabled(true);
    expect(mockSet).toHaveBeenCalledWith('agent.hookGuard', { enabled: true, rules: [] });
  });
});
