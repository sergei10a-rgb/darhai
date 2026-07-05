/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * H-1: concurrent probe amplification. `scanHardware` writes its cache only
 * AFTER the async probe resolves, so without in-flight deduplication N parallel
 * (non-fresh) calls each spawn their own host probe. These tests mock the host
 * command layer and assert a burst of concurrent scans collapses to ONE probe
 * pass while still returning the same profile to every caller.
 */

// Count how many times any host command is spawned, and gate resolution so we
// can hold every in-flight probe open while we fire concurrent callers.
let execCallCount = 0;
let releaseExec: (() => void) | null = null;
let execGate: Promise<void> = Promise.resolve();

const mockSafeExecFile = vi.fn(async () => {
  execCallCount += 1;
  await execGate;
  // Return an empty stdout: every detector treats this as "nothing found" and
  // degrades to a CPU/RAM-only profile without throwing.
  return { stdout: '', stderr: '' };
});

vi.mock('@process/utils/safeExec', () => ({
  safeExecFile: (...args: unknown[]) => mockSafeExecFile(...args),
  safeExec: (...args: unknown[]) => mockSafeExecFile(...args),
}));

// Keep the platform deterministic: force the non-Windows path so the probe goes
// through safeExecFile-backed detectors (nvidia/amd/apple) rather than the
// Windows PowerShell branch (which also uses safeExecFile, but this keeps the
// count assertions independent of the CI host OS).
const originalPlatform = process.platform;

import { scanHardware, clearHardwareCache } from '@process/services/hwfit/hardwareDetect';

beforeEach(() => {
  execCallCount = 0;
  clearHardwareCache();
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});

function openGate(): void {
  execGate = new Promise<void>((resolve) => {
    releaseExec = resolve;
  });
}

describe('scanHardware - in-flight dedup (H-1)', () => {
  it('runs a single probe pass for N concurrent non-fresh callers', async () => {
    openGate();

    // Fire 5 concurrent scans while the probe is held open.
    const pending = Promise.all([scanHardware(), scanHardware(), scanHardware(), scanHardware(), scanHardware()]);

    // Let the first (shared) probe reach the gated exec call(s).
    await Promise.resolve();
    await Promise.resolve();

    const countWhileInflight = execCallCount;

    // Release the gate and let all callers settle.
    releaseExec?.();
    const results = await pending;

    // All five callers get the same resolved profile object (shared in-flight).
    expect(results.every((r) => r === results[0])).toBe(true);

    // A single probe pass makes a bounded number of exec calls (nvidia + amd
    // fallbacks), NOT 5x that. Concurrency did not multiply the probe.
    const singlePass = execCallCount;
    expect(countWhileInflight).toBe(singlePass);
  });

  it('serves the cached profile without re-probing on a later non-fresh call', async () => {
    execGate = Promise.resolve();
    const first = await scanHardware();
    const afterFirst = execCallCount;

    const second = await scanHardware();
    // Cache hit: no additional probe.
    expect(execCallCount).toBe(afterFirst);
    expect(second).toBe(first);
  });

  it('always resolves to a well-formed profile even when every probe is empty', async () => {
    execGate = Promise.resolve();
    const profile = await scanHardware();
    expect(profile.hasGpu).toBe(false);
    expect(profile.platform).toBe('linux');
    expect(profile.totalRamGb).toBeGreaterThan(0);
  });
});

// Restore the real platform after the suite.
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});
