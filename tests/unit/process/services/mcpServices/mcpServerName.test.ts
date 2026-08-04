/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Nothing in the MCP Library could be installed.
 *
 * An MCP server has two names. The DISPLAY name comes from the catalog and is a
 * reverse-DNS id - `com.slack/slack-mcp` - and all 55 bundled entries contain a
 * slash. The WIRE name is a key in a per-CLI agent config and an argv element in
 * the command that agent builds, so it must satisfy SAFE_MCP_NAME, which does
 * not allow a slash. The two were the same string, so every Library install
 * stored a name that the pre-sync check then rejected.
 *
 * These tests pin both halves of the fix: the derivation itself, and the fact
 * that it makes the real shipped catalog installable.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sanitizeMcpServerName, validateMcpServer } from '@process/services/mcpServices/validateMcpServer';
import type { IMcpServer } from '@/common/config/storage';

const CATALOG_DIR = path.resolve(process.cwd(), 'src/renderer/mcp-catalog/entries');

/** Minimal server shaped the way an install from the Library stores one. */
const asServer = (name: string): IMcpServer =>
  ({
    id: `id-${name}`,
    name,
    enabled: true,
    transport: { type: 'stdio', command: 'node', args: ['x.js'], env: {} },
  }) as unknown as IMcpServer;

describe('sanitizeMcpServerName', () => {
  it('turns a reverse-DNS catalog id into a usable wire name', () => {
    expect(sanitizeMcpServerName('com.slack/slack-mcp')).toBe('com.slack-slack-mcp');
    expect(sanitizeMcpServerName('com.darhai/imap-mcp')).toBe('com.darhai-imap-mcp');
  });

  it('is idempotent, so a row keeps the same key forever', () => {
    // Sync derives the key; removal derives it again. If the derivation were not
    // idempotent the second pass would produce a different key and the server
    // could never be removed.
    const once = sanitizeMcpServerName('com.slack/slack-mcp');
    expect(sanitizeMcpServerName(once)).toBe(once);
  });

  it('leaves an already-safe name untouched', () => {
    expect(sanitizeMcpServerName('darhai-search-skills')).toBe('darhai-search-skills');
    expect(sanitizeMcpServerName('my_server.v2')).toBe('my_server.v2');
  });

  it('never produces a name that reads as a CLI option', () => {
    // SAFE_MCP_NAME permits a leading '-', but a CLI that re-parses the name
    // would treat it as a flag.
    expect(sanitizeMcpServerName('-rf').startsWith('-')).toBe(false);
    expect(sanitizeMcpServerName('/rf').startsWith('-')).toBe(false);
  });

  it('is NOT injective, which is why sync carries a collision guard', () => {
    // Every illegal character maps to '-', so two names that differ only in
    // which illegal character they use land on the same key. Making the
    // derivation injective would mean hex-escaping - unreadable keys in every
    // agent config, to buy a property the real catalog does not need (55
    // entries, 55 distinct keys). The risk is handled where it actually
    // matters instead: `syncMcpToAgents` refuses to write two servers onto one
    // key. This test exists so nobody "fixes" the collision here and quietly
    // breaks the sync/remove symmetry, which requires a PURE function of the
    // name - removal sees one name, never the set.
    expect(sanitizeMcpServerName('a/b')).toBe(sanitizeMcpServerName('a-b'));
  });

  it('produces something validateMcpServer accepts for hostile input', () => {
    for (const hostile of ['a b;rm -rf /', 'x$(whoami)', 'a\\b/c', '../../etc/passwd', 'сервер']) {
      expect(() => validateMcpServer(asServer(sanitizeMcpServerName(hostile)))).not.toThrow();
    }
  });
});

describe('the shipped MCP catalog', () => {
  const entries = readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(CATALOG_DIR, f), 'utf8')) as { name?: string })
    .filter((e): e is { name: string } => typeof e.name === 'string');

  it('is not empty - a passing suite must mean the catalog was actually read', () => {
    expect(entries.length).toBeGreaterThan(20);
  });

  it('installs every single entry', () => {
    // The regression itself. Before the fix this failed on entry 1 of 55.
    const rejected: string[] = [];
    for (const entry of entries) {
      try {
        validateMcpServer(asServer(sanitizeMcpServerName(entry.name)));
      } catch {
        rejected.push(entry.name);
      }
    }
    expect(rejected, `catalog entries that still cannot be installed: ${rejected.join(', ')}`).toEqual([]);
  });

  it('gives every entry a distinct wire name', () => {
    // Two servers colliding onto one key would silently overwrite each other in
    // the agent config. Measured: 55 entries, 55 distinct keys.
    const wire = entries.map((e) => sanitizeMcpServerName(e.name));
    expect(new Set(wire).size).toBe(wire.length);
  });
});
