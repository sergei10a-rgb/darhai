/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC arg validation for memory.update-entry / memory.delete-entry (#414
 * port). The bridge handlers safeParse against these schemas before touching
 * the archive service; anything a renderer bug or a hostile peer could send
 * that violates the index clamps (MAX_SUMMARY_CHARS / MAX_TAGS /
 * MAX_TAG_CHARS) must be rejected at the wire, not truncated later.
 */

import { describe, expect, it } from 'vitest';
import { deleteEntrySchema, updateEntrySchema } from '@process/bridge/knowledge/memoryArchiveBridge';

describe('updateEntrySchema (memory.update-entry)', () => {
  it('accepts a minimal valid patch', () => {
    expect(updateEntrySchema.safeParse({ id: 'abc123', summary: 'Шинэ товч утга' }).success).toBe(true);
    expect(updateEntrySchema.safeParse({ id: 'abc123', body: 'Шинэ агуулга' }).success).toBe(true);
    expect(updateEntrySchema.safeParse({ id: 'abc123', type: 'decision', tags: ['кэш'] }).success).toBe(true);
  });

  it('rejects a missing or empty id', () => {
    expect(updateEntrySchema.safeParse({ summary: 'x' }).success).toBe(false);
    expect(updateEntrySchema.safeParse({ id: '', summary: 'x' }).success).toBe(false);
  });

  it('rejects an empty summary (would erase the block locator)', () => {
    expect(updateEntrySchema.safeParse({ id: 'abc', summary: '' }).success).toBe(false);
  });

  it('rejects a summary over the 500-char index clamp', () => {
    expect(updateEntrySchema.safeParse({ id: 'abc', summary: 'x'.repeat(501) }).success).toBe(false);
    expect(updateEntrySchema.safeParse({ id: 'abc', summary: 'x'.repeat(500) }).success).toBe(true);
  });

  it('rejects a tags flood beyond the 64-tag / 128-char clamps', () => {
    expect(updateEntrySchema.safeParse({ id: 'abc', tags: Array.from({ length: 65 }, () => 't') }).success).toBe(false);
    expect(updateEntrySchema.safeParse({ id: 'abc', tags: ['x'.repeat(129)] }).success).toBe(false);
    expect(updateEntrySchema.safeParse({ id: 'abc', tags: Array.from({ length: 64 }, () => 't') }).success).toBe(true);
  });

  it('rejects an oversized body', () => {
    expect(updateEntrySchema.safeParse({ id: 'abc', body: 'x'.repeat(100_001) }).success).toBe(false);
  });

  it('rejects wrong field types', () => {
    expect(updateEntrySchema.safeParse({ id: 'abc', tags: 'not-an-array' }).success).toBe(false);
    expect(updateEntrySchema.safeParse({ id: 'abc', body: 42 }).success).toBe(false);
    expect(updateEntrySchema.safeParse('not-an-object').success).toBe(false);
  });
});

describe('deleteEntrySchema (memory.delete-entry)', () => {
  it('accepts a plain id', () => {
    expect(deleteEntrySchema.safeParse({ id: 'abc123' }).success).toBe(true);
  });

  it('rejects missing/empty/oversized ids and non-objects', () => {
    expect(deleteEntrySchema.safeParse({}).success).toBe(false);
    expect(deleteEntrySchema.safeParse({ id: '' }).success).toBe(false);
    expect(deleteEntrySchema.safeParse({ id: 'x'.repeat(65) }).success).toBe(false);
    expect(deleteEntrySchema.safeParse(null).success).toBe(false);
  });
});
