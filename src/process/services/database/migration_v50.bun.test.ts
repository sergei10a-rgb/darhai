// src/process/services/database/migration_v50.bun.test.ts
// Run with: bun test src/process/services/database/migration_v50.bun.test.ts
//
// Bun-runtime test for migration_v50 (semantic retrieval fingerprint shadow
// tables). Verifies both meta tables are created with NO foreign keys (so
// PRAGMA foreign_key_check stays clean), up() is idempotent, down() drops them,
// and a fingerprint row inserts/reads back. Uses BunSqliteDriver so it runs
// where better-sqlite3 ABI-mismatches under Bun.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BunSqliteDriver } from './drivers/BunSqliteDriver';
import { ALL_MIGRATIONS, type IMigration } from './migrations';

const migration_v50 = ALL_MIGRATIONS.find((m) => m.version === 50) as IMigration | undefined;

function tableExists(driver: BunSqliteDriver, name: string): boolean {
  try {
    driver.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

describe('Migration v50 - semantic fingerprint shadow tables (bun:sqlite)', () => {
  let driver: BunSqliteDriver;

  beforeEach(() => {
    driver = new BunSqliteDriver(':memory:');
    expect(migration_v50).toBeDefined();
  });

  afterEach(() => driver.close());

  it('is registered in ALL_MIGRATIONS at version 50', () => {
    expect(migration_v50!.version).toBe(50);
    expect(migration_v50!.name).toMatch(/semantic|fingerprint/i);
  });

  it('creates both shadow tables', () => {
    migration_v50!.up(driver);
    expect(tableExists(driver, 'vec_skills_meta')).toBe(true);
    expect(tableExists(driver, 'vec_memory_meta')).toBe(true);
  });

  it('declares NO foreign keys (foreign_key_check stays clean)', () => {
    migration_v50!.up(driver);
    expect((driver.pragma('foreign_key_list(vec_skills_meta)') as unknown[]).length).toBe(0);
    expect((driver.pragma('foreign_key_list(vec_memory_meta)') as unknown[]).length).toBe(0);
    expect((driver.pragma('foreign_key_check') as unknown[]).length).toBe(0);
  });

  it('stores and reads back a fingerprint row', () => {
    migration_v50!.up(driver);
    driver.prepare('INSERT INTO vec_skills_meta (id, fingerprint) VALUES (?, ?)').run('python-setup', 'abc123');
    const row = driver.prepare('SELECT id, fingerprint FROM vec_skills_meta WHERE id = ?').get('python-setup') as {
      id: string;
      fingerprint: string;
    };
    expect(row.id).toBe('python-setup');
    expect(row.fingerprint).toBe('abc123');
  });

  it('enforces the primary key (id is unique)', () => {
    migration_v50!.up(driver);
    driver.prepare('INSERT INTO vec_memory_meta (id, fingerprint) VALUES (?, ?)').run('m1', 'fp1');
    expect(() => {
      driver.prepare('INSERT INTO vec_memory_meta (id, fingerprint) VALUES (?, ?)').run('m1', 'fp2');
    }).toThrow();
  });

  it('up() is idempotent (re-run does not throw or drop existing rows)', () => {
    migration_v50!.up(driver);
    driver.prepare('INSERT INTO vec_skills_meta (id, fingerprint) VALUES (?, ?)').run('keep', 'fp');
    expect(() => migration_v50!.up(driver)).not.toThrow();
    expect(driver.prepare('SELECT 1 FROM vec_skills_meta WHERE id = ?').get('keep')).toBeDefined();
  });

  it('down() drops both tables', () => {
    migration_v50!.up(driver);
    migration_v50!.down(driver);
    expect(tableExists(driver, 'vec_skills_meta')).toBe(false);
    expect(tableExists(driver, 'vec_memory_meta')).toBe(false);
  });
});
