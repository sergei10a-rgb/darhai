/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Vitest (Node ABI) test for migration_v53 - the `documents` + `document_versions`
 * tables backing the Documents surface (Odysseus assimilation "documents"). Verifies
 * the tables + indexes are created, up() is idempotent, the FKs cascade (from users
 * and from documents), and a row round-trips. Runs under the shared
 * native-better-sqlite3 gate.
 */

import { afterEach, beforeEach, expect, it } from 'vitest';
import { CURRENT_DB_VERSION, initSchema } from '@process/services/database/schema';
import { runMigrations, ALL_MIGRATIONS, type IMigration } from '@process/services/database/migrations';
import { BetterSqlite3Driver } from '@process/services/database/drivers/BetterSqlite3Driver';
import { describeNativeSqlite } from '../../../helpers/nativeSqlite';

const migration_v53 = ALL_MIGRATIONS.find((m) => m.version === 53) as IMigration | undefined;

describeNativeSqlite('Migration v53 - documents + document_versions tables', () => {
  let driver: BetterSqlite3Driver;
  beforeEach(() => {
    driver = new BetterSqlite3Driver(':memory:');
    initSchema(driver);
    runMigrations(driver, 0, CURRENT_DB_VERSION);
  });
  afterEach(() => driver.close());

  it('bumps CURRENT_DB_VERSION to 53 or higher and registers migration v53', () => {
    expect(CURRENT_DB_VERSION).toBeGreaterThanOrEqual(53);
    expect(migration_v53).toBeDefined();
    expect(migration_v53!.name).toMatch(/document/i);
  });

  it('creates the documents table with all required columns', () => {
    const cols = driver.pragma('table_info(documents)') as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).toSorted();
    expect(colNames).toEqual(
      [
        'archived',
        'content',
        'created_at_ms',
        'id',
        'language',
        'title',
        'updated_at_ms',
        'user_id',
        'version_count',
      ].toSorted()
    );
  });

  it('creates the document_versions table with all required columns', () => {
    const cols = driver.pragma('table_info(document_versions)') as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name).toSorted();
    expect(colNames).toEqual(
      ['content', 'created_at_ms', 'document_id', 'id', 'source', 'summary', 'version_number'].toSorted()
    );
  });

  it('creates the documents user_id / (user_id, updated_at_ms) indexes', () => {
    const indexes = driver.pragma('index_list(documents)') as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names.some((n) => n.includes('user_id'))).toBe(true);
    expect(names.some((n) => n.includes('user_updated'))).toBe(true);
  });

  it('creates the document_versions (document_id, version_number) index', () => {
    const indexes = driver.pragma('index_list(document_versions)') as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names.some((n) => n.includes('doc_number'))).toBe(true);
  });

  it('cascades a FK from users(id) ON DELETE CASCADE on documents', () => {
    const fks = driver.pragma('foreign_key_list(documents)') as Array<{ table: string; on_delete: string }>;
    expect(fks.some((fk) => fk.table === 'users' && fk.on_delete === 'CASCADE')).toBe(true);
  });

  it('cascades a FK from documents(id) ON DELETE CASCADE on document_versions', () => {
    const fks = driver.pragma('foreign_key_list(document_versions)') as Array<{ table: string; on_delete: string }>;
    expect(fks.some((fk) => fk.table === 'documents' && fk.on_delete === 'CASCADE')).toBe(true);
  });

  it('round-trips a document + version and cascades version deletes when the document is deleted', () => {
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u1', 'alice', 'hash', Date.now(), Date.now());
    driver
      .prepare(
        `INSERT INTO documents (id, user_id, title, language, content, version_count, archived, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('doc_1', 'u1', 'Spec', 'markdown', '# Hi', 1, 0, 1, 1);
    driver
      .prepare(
        `INSERT INTO document_versions (id, document_id, version_number, content, summary, source, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('docv_1', 'doc_1', 1, '# Hi', 'Initial version', 'user', 1);

    const doc = driver.prepare('SELECT * FROM documents WHERE id = ?').get('doc_1') as Record<string, unknown>;
    expect(doc.title).toBe('Spec');
    expect(doc.language).toBe('markdown');

    driver.prepare('DELETE FROM documents WHERE id = ?').run('doc_1');
    const remaining = driver
      .prepare('SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?')
      .get('doc_1') as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('deletes documents when the owning user is deleted (ON DELETE CASCADE)', () => {
    driver
      .prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('u2', 'bob', 'hash', Date.now(), Date.now());
    driver
      .prepare(
        `INSERT INTO documents (id, user_id, title, language, content, version_count, archived, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('doc_2', 'u2', 'Gone', 'code', '', 1, 0, 1, 1);
    driver.prepare('DELETE FROM users WHERE id = ?').run('u2');
    const remaining = driver.prepare('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?').get('u2') as {
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
        `INSERT INTO documents (id, user_id, title, language, content, version_count, archived, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('keep', 'u3', 'Keep me', 'markdown', 'x', 1, 0, 1, 1);

    expect(() => migration_v53!.up(driver)).not.toThrow();
    expect(driver.prepare('SELECT 1 FROM documents WHERE id = ?').get('keep')).toBeDefined();
  });
});
