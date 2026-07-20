/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vitest (Node ABI) test for migration_v54 - the `research_runs` table backing the
 * Deep Research surface (Odysseus assimilation "deep research"). Verifies the table
 * + indexes are created, up() is idempotent, the FK from users cascades, and a row
 * round-trips. Runs under the shared native-better-sqlite3 gate.
 */

import { afterEach, beforeEach, expect, it } from 'vitest';
import { CURRENT_DB_VERSION, initSchema } from '@process/services/database/schema';
import { runMigrations, ALL_MIGRATIONS, type IMigration } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import { describeNativeSqlite } from '../../../helpers/nativeSqlite';

const migration_v54 = ALL_MIGRATIONS.find((m) => m.version === 54) as IMigration | undefined;

describeNativeSqlite('Migration v54 - research_runs table', () => {
  let driver: BetterSqlite3Driver;
  beforeEach(() => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, CURRENT_DB_VERSION);
  });
  afterEach(() => driver.close());

  it('bumps CURRENT_DB_VERSION to 54 or higher and registers migration v54', () => {
    expect(CURRENT_DB_VERSION).toBeGreaterThanOrEqual(54);
    expect(migration_v54).toBeDefined();
    expect(migration_v54!.name).toMatch(/research/i);
  });

  it('creates the research_runs table with all required columns', () => {
    const cols = driver.pragma('table_info(research_runs)') as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).toSorted();
    expect(colNames).toEqual(
      [
        'category',
        'created_at_ms',
        'error',
        'id',
        'query',
        'report',
        'rounds',
        'sources',
        'status',
        'updated_at_ms',
        'user_id',
      ].toSorted()
    );
  });

  it('creates the user_id / (user_id, updated_at_ms) indexes', () => {
    const indexes = driver.pragma('index_list(research_runs)') as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names.some((n) => n.includes('user_id'))).toBe(true);
    expect(names.some((n) => n.includes('user_updated'))).toBe(true);
  });

  it('cascades a FK from users(id) ON DELETE CASCADE', () => {
    const fks = driver.pragma('foreign_key_list(research_runs)') as Array<{ table: string; on_delete: string }>;
    expect(fks.some((fk) => fk.table === 'users' && fk.on_delete === 'CASCADE')).toBe(true);
  });

  it('round-trips a research run row', () => {
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u1', 'alice', 'hash', Date.now(), Date.now());
    driver
      .prepare(
        `INSERT INTO research_runs (id, user_id, query, category, status, rounds, report, sources, error, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('res_1', 'u1', 'why is the sky blue', 'auto', 'planning', 0, '', '[]', null, 1, 1);
    const row = driver.prepare('SELECT * FROM research_runs WHERE id = ?').get('res_1') as Record<string, unknown>;
    expect(row.query).toBe('why is the sky blue');
    expect(row.status).toBe('planning');
    expect(row.sources).toBe('[]');
  });

  it('deletes runs when the owning user is deleted (ON DELETE CASCADE)', () => {
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u2', 'bob', 'hash', Date.now(), Date.now());
    driver
      .prepare(
        `INSERT INTO research_runs (id, user_id, query, category, status, rounds, report, sources, error, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('res_2', 'u2', 'gone', 'general', 'done', 2, '# Report', '[]', null, 1, 1);
    driver.prepare('DELETE FROM users WHERE id = ?').run('u2');
    const remaining = driver.prepare('SELECT COUNT(*) AS n FROM research_runs WHERE user_id = ?').get('u2') as {
      n: number;
    };
    expect(remaining.n).toBe(0);
  });

  it('up() is idempotent - re-running does not throw and keeps existing rows', () => {
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u3', 'carol', 'hash', Date.now(), Date.now());
    driver
      .prepare(
        `INSERT INTO research_runs (id, user_id, query, category, status, rounds, report, sources, error, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('keep', 'u3', 'keep me', 'auto', 'done', 1, 'x', '[]', null, 1, 1);
    expect(() => migration_v54!.up(driver)).not.toThrow();
    expect(driver.prepare('SELECT 1 FROM research_runs WHERE id = ?').get('keep')).toBeDefined();
  });
});
