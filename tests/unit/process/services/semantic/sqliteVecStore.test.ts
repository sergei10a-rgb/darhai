/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { SqliteVecStore } from '@process/services/semantic/SqliteVecStore';
import type { ISqliteDriver } from '@process/services/database/drivers/ISqliteDriver';

/** A driver whose loadExtension throws - simulates a missing sqlite-vec binary. */
function failingDriver(): ISqliteDriver {
  return {
    prepare: vi.fn(),
    exec: vi.fn(),
    pragma: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
    loadExtension: vi.fn(() => {
      throw new Error('extension not found');
    }),
  } as unknown as ISqliteDriver;
}

/** A driver with no loadExtension method at all (e.g. a non-native backend). */
function driverWithoutLoadExtension(): ISqliteDriver {
  return {
    prepare: vi.fn(),
    exec: vi.fn(),
    pragma: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  } as unknown as ISqliteDriver;
}

describe('SqliteVecStore (unavailable path)', () => {
  it('is unavailable when loadExtension throws (missing binary)', () => {
    const store = SqliteVecStore.create(failingDriver(), 384, '/nonexistent/vec0');
    expect(store.isAvailable()).toBe(false);
  });

  it('is unavailable when the driver has no loadExtension support', () => {
    const store = SqliteVecStore.create(driverWithoutLoadExtension(), 384, '/x');
    expect(store.isAvailable()).toBe(false);
  });

  it('search returns empty and mutations are no-ops when unavailable', () => {
    const store = SqliteVecStore.create(failingDriver(), 384, '/x');
    expect(store.search('skills', Float32Array.from([1, 0, 0]), 5)).toEqual([]);
    expect(store.fingerprints('skills').size).toBe(0);
    expect(store.count('memory')).toBe(0);
    // Mutations must not throw even though the store is unavailable.
    expect(() =>
      store.upsert('skills', [{ id: 'a', fingerprint: 'fp', vector: Float32Array.from([1, 0, 0]) }])
    ).not.toThrow();
    expect(() => store.remove('skills', ['a'])).not.toThrow();
  });

  it('does not call exec (schema creation) when the extension fails to load', () => {
    const driver = failingDriver();
    SqliteVecStore.create(driver, 384, '/x');
    // exec would only run inside ensureSchema, which is guarded by a successful
    // loadExtension - so a failed load must never touch the schema.
    expect(driver.exec).not.toHaveBeenCalled();
  });
});
