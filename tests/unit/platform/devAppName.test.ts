/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The dev userData folder name.
 *
 * Renaming it is not a free cosmetic change: a developer's dev profile (chat
 * history, settings, connected providers) lives in that folder, and a new name
 * means the app opens an empty one while the old data sits on disk unreachable.
 * So the resolver prefers the fork's own name but keeps using a pre-fork
 * `Wayland-Dev` folder when one is already there. These tests pin both halves -
 * the new default AND the case that protects existing data.
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDevAppName } from '@/common/platform';

let parent: string;
const ORIGINAL_MULTI = process.env.DARHAI_MULTI_INSTANCE;

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'darhai-devname-'));
  delete process.env.DARHAI_MULTI_INSTANCE;
});

afterEach(async () => {
  if (ORIGINAL_MULTI === undefined) delete process.env.DARHAI_MULTI_INSTANCE;
  else process.env.DARHAI_MULTI_INSTANCE = ORIGINAL_MULTI;
  await rm(parent, { recursive: true, force: true }).catch(() => {});
});

describe('getDevAppName', () => {
  it('returns the fork name for a fresh checkout (neither folder exists)', () => {
    expect(getDevAppName(parent)).toBe('Darhai-Dev');
  });

  it('returns the fork name when called with no parent dir (pure form)', () => {
    expect(getDevAppName()).toBe('Darhai-Dev');
  });

  it('keeps using an existing pre-fork Wayland-Dev profile', async () => {
    await mkdir(join(parent, 'Wayland-Dev'));
    expect(getDevAppName(parent)).toBe('Wayland-Dev');
  });

  it('prefers Darhai-Dev once it exists, even alongside the legacy folder', async () => {
    await mkdir(join(parent, 'Wayland-Dev'));
    await mkdir(join(parent, 'Darhai-Dev'));
    expect(getDevAppName(parent)).toBe('Darhai-Dev');
  });

  describe('multi-instance mode keeps the two instances apart', () => {
    beforeEach(() => {
      process.env.DARHAI_MULTI_INSTANCE = '1';
    });

    it('suffixes the fork name', () => {
      expect(getDevAppName(parent)).toBe('Darhai-Dev-2');
    });

    it('honours the suffixed legacy folder', async () => {
      await mkdir(join(parent, 'Wayland-Dev-2'));
      expect(getDevAppName(parent)).toBe('Wayland-Dev-2');
    });

    it('is NOT satisfied by the unsuffixed legacy folder - that is instance 1', async () => {
      await mkdir(join(parent, 'Wayland-Dev'));
      expect(getDevAppName(parent)).toBe('Darhai-Dev-2');
    });
  });
});
