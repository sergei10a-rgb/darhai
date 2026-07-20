/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { IMcpServer } from '@/common/config/storage';
import {
  BUILTIN_IMAGE_GEN_ID,
  BUILTIN_IMAGE_GEN_LEGACY_NAMES,
  BUILTIN_IMAGE_GEN_NAME,
  BUILTIN_SEARCH_SKILLS_ID,
  BUILTIN_SEARCH_SKILLS_LEGACY_NAMES,
  BUILTIN_SEARCH_SKILLS_NAME,
  isBuiltinImageGenName,
  isBuiltinSearchSkillsName,
  isBuiltinSearchSkillsTransport,
} from '@process/resources/builtinMcp/constants';

/**
 * Catalog migration test for the built-in MCP display-name rename (task #28).
 *
 * v0.9.7-mn.1 shipped the two stdio built-ins under Wayland-branded display
 * names ('wayland-search-skills', 'wayland-image-generation'). The rename to
 * 'darhai-*' must migrate those SHIPPED entries in place - never duplicate a
 * row - because the entries are keyed on a stable id and can already be found
 * by that id (and by their stable transport filename) regardless of the stored
 * display name.
 *
 * Because `ensureBuiltinMcpServers` in initStorage.ts is wrapped in filesystem,
 * database and MCP side-effects, we test the migration contract directly
 * against an in-memory `mcp.config` array - the same inline-reproduction
 * pattern used by initStorageMigration.test.ts. The decision logic below is
 * keyed on the REAL exported constants, legacy-name arrays and predicates, so a
 * drift in the canonical/legacy names is caught here.
 */

const MIGRATION_NOW = 999;

/**
 * Reproduce the name-migration portion of the two find-or-create blocks in
 * initStorage.ts `ensureBuiltinMcpServers`. Both blocks locate the existing
 * entry by its stable id; a legacy display name is rewritten to the canonical
 * one in place. Nothing is ever pushed for an already-present id, so a
 * legacy-named row is renamed, not duplicated.
 */
function ensureBuiltinMcpServerNames(input: IMcpServer[]): IMcpServer[] {
  const mcpServers = [...input];

  const imageGenIdx = mcpServers.findIndex((s) => s.builtin === true && s.id === BUILTIN_IMAGE_GEN_ID);
  if (imageGenIdx >= 0) {
    const existing = mcpServers[imageGenIdx];
    const needsNameMigration =
      existing.name !== BUILTIN_IMAGE_GEN_NAME &&
      BUILTIN_IMAGE_GEN_LEGACY_NAMES.includes(existing.name as (typeof BUILTIN_IMAGE_GEN_LEGACY_NAMES)[number]);
    if (needsNameMigration) {
      mcpServers[imageGenIdx] = { ...existing, name: BUILTIN_IMAGE_GEN_NAME, updatedAt: MIGRATION_NOW };
    }
  }

  const searchSkillsIdx = mcpServers.findIndex((s) => s.builtin === true && s.id === BUILTIN_SEARCH_SKILLS_ID);
  if (searchSkillsIdx >= 0) {
    const existing = mcpServers[searchSkillsIdx];
    const needsNameMigration =
      existing.name !== BUILTIN_SEARCH_SKILLS_NAME &&
      BUILTIN_SEARCH_SKILLS_LEGACY_NAMES.includes(existing.name as (typeof BUILTIN_SEARCH_SKILLS_LEGACY_NAMES)[number]);
    if (needsNameMigration) {
      mcpServers[searchSkillsIdx] = { ...existing, name: BUILTIN_SEARCH_SKILLS_NAME, updatedAt: MIGRATION_NOW };
    }
  }

  return mcpServers;
}

const makeSearchSkillsEntry = (name: string): IMcpServer => ({
  id: BUILTIN_SEARCH_SKILLS_ID,
  name,
  enabled: true,
  builtin: true,
  transport: {
    type: 'stdio',
    command: 'node',
    args: ['/abs/out/main/builtin-mcp-search-skills.js'],
    env: {},
  },
  createdAt: 1,
  updatedAt: 1,
  originalJson: '{}',
});

const makeImageGenEntry = (name: string): IMcpServer => ({
  id: BUILTIN_IMAGE_GEN_ID,
  name,
  enabled: true,
  builtin: true,
  transport: {
    type: 'stdio',
    command: 'node',
    args: ['/abs/out/main/builtin-mcp-image-gen.js'],
    env: {},
  },
  createdAt: 1,
  updatedAt: 1,
  originalJson: '{}',
});

describe('ensureBuiltinMcpServers - display-name migration (task #28)', () => {
  it('renames a shipped wayland-search-skills entry to darhai-search-skills in place, without duplicating', () => {
    const before = [makeSearchSkillsEntry('wayland-search-skills')];

    // Pre-condition: the shipped entry is still resolvable by the legacy-aware
    // predicate and by its stable transport filename.
    expect(isBuiltinSearchSkillsName(before[0].name)).toBe(true);
    expect(isBuiltinSearchSkillsTransport(before[0].transport)).toBe(true);

    const after = ensureBuiltinMcpServerNames(before);

    const rows = after.filter((s) => s.id === BUILTIN_SEARCH_SKILLS_ID);
    expect(rows).toHaveLength(1); // renamed, NOT duplicated
    expect(after).toHaveLength(1);
    expect(rows[0].name).toBe('darhai-search-skills');
    expect(rows[0].updatedAt).toBe(MIGRATION_NOW);
  });

  it('renames a shipped wayland-image-generation entry to darhai-image-generation in place, without duplicating', () => {
    const before = [makeImageGenEntry('wayland-image-generation')];

    expect(isBuiltinImageGenName(before[0].name)).toBe(true);

    const after = ensureBuiltinMcpServerNames(before);

    const rows = after.filter((s) => s.id === BUILTIN_IMAGE_GEN_ID);
    expect(rows).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(rows[0].name).toBe('darhai-image-generation');
  });

  it('migrates both built-ins together, preserving row count (no duplicates)', () => {
    const before = [makeImageGenEntry('wayland-image-generation'), makeSearchSkillsEntry('wayland-search-skills')];

    const after = ensureBuiltinMcpServerNames(before);

    expect(after).toHaveLength(2);
    expect(after.find((s) => s.id === BUILTIN_IMAGE_GEN_ID)?.name).toBe('darhai-image-generation');
    expect(after.find((s) => s.id === BUILTIN_SEARCH_SKILLS_ID)?.name).toBe('darhai-search-skills');
  });

  it('is idempotent: a second pass over already-canonical names changes nothing', () => {
    const first = ensureBuiltinMcpServerNames([makeSearchSkillsEntry('wayland-search-skills')]);
    const second = ensureBuiltinMcpServerNames(first);

    expect(second).toHaveLength(1);
    expect(second[0].name).toBe('darhai-search-skills');
    // Already canonical → no re-migration bump beyond the first pass.
    expect(second[0].updatedAt).toBe(MIGRATION_NOW);
  });

  it('leaves a user-renamed builtin entry untouched (only legacy names migrate)', () => {
    const before = [makeSearchSkillsEntry('My Custom Skill Search')];

    const after = ensureBuiltinMcpServerNames(before);

    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('My Custom Skill Search');
    expect(after[0].updatedAt).toBe(1); // untouched
  });
});
