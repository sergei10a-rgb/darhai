/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Darhai used to write into the user's own `~/.codex/config.toml`.
 *
 * Only the `sandbox_mode` line changed, but that file is not ours: it is what
 * their `codex` command reads in their terminal. Launching an agent here
 * silently changed how their CLI behaves everywhere else - and with
 * `danger-full-access` it meant their own codex stopped sandboxing, with no
 * prompt and nothing to say it had happened.
 *
 * What is pinned here: the user's file is never written, the managed copy keeps
 * everything they had written except that one line, and `auth.json` is shared
 * so one sign-in still serves both.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userHome: string;
let appData: string;

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => userHome };
});
vi.mock('os', async (orig) => {
  const actual = await orig<typeof import('os')>();
  return { ...actual, homedir: () => userHome };
});
vi.mock('@process/utils/utils', () => ({ getDataPath: () => appData }));

import { applyCodexSandboxMode, materializeCodexHome } from '@process/task/codexConfig';

const userCodexDir = () => join(userHome, '.codex');
const managedDir = () => join(appData, 'codex-home');

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-'));
  userHome = join(root, 'home');
  appData = join(root, 'appdata');
  await mkdir(userCodexDir(), { recursive: true });
  await mkdir(appData, { recursive: true });
  delete process.env.CODEX_HOME;
});

afterEach(async () => {
  await rm(userHome, { recursive: true, force: true }).catch(() => {});
  await rm(appData, { recursive: true, force: true }).catch(() => {});
});

describe('materializeCodexHome', () => {
  it('never touches the config the user owns', async () => {
    // The whole point. Their terminal `codex` must behave exactly as before.
    const original = 'model = "o3"\nsandbox_mode = "read-only"\n';
    await writeFile(join(userCodexDir(), 'config.toml'), original, 'utf8');

    await materializeCodexHome('danger-full-access');

    expect(await readFile(join(userCodexDir(), 'config.toml'), 'utf8')).toBe(original);
  });

  it('writes the chosen sandbox mode into a home of our own', async () => {
    await writeFile(join(userCodexDir(), 'config.toml'), 'model = "o3"\n', 'utf8');

    const home = await materializeCodexHome('workspace-write');

    expect(home).toBe(managedDir());
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('sandbox_mode = "workspace-write"');
  });

  it('carries over everything else the user configured', async () => {
    // A copy that dropped their model or their MCP servers would be its own
    // silent breakage.
    await writeFile(
      join(userCodexDir(), 'config.toml'),
      'model = "o3"\nsandbox_mode = "read-only"\n\n[mcp_servers.mine]\ncommand = "x"\n',
      'utf8'
    );

    const home = await materializeCodexHome('workspace-write');
    const managed = await readFile(join(home, 'config.toml'), 'utf8');

    expect(managed).toContain('model = "o3"');
    expect(managed).toContain('[mcp_servers.mine]');
    expect(managed).toContain('sandbox_mode = "workspace-write"');
    expect(managed).not.toContain('read-only');
  });

  it('works for a user who has no codex config at all', async () => {
    const home = await materializeCodexHome('workspace-write');

    expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe('sandbox_mode = "workspace-write"\n');
  });

  it('shares auth.json so one sign-in serves the terminal and the app', async () => {
    await writeFile(join(userCodexDir(), 'auth.json'), '{"token":"t"}', 'utf8');

    const home = await materializeCodexHome('workspace-write');

    // Symlink where the platform allows one, copy where it does not - either
    // way the spawned CLI is signed in.
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('{"token":"t"}');
  });

  it('prefers a link, so a refreshed token reaches the user again', async () => {
    await writeFile(join(userCodexDir(), 'auth.json'), '{"token":"t"}', 'utf8');

    const home = await materializeCodexHome('workspace-write');

    const link = await readlink(join(home, 'auth.json')).catch(() => null);
    if (link === null) {
      // Windows without developer mode. The copy fallback is expected, and the
      // previous test already covered that it authenticates.
      return;
    }
    expect(link).toBe(join(userCodexDir(), 'auth.json'));
  });

  it('leaves no auth.json when the user is not signed in', async () => {
    // A dangling link would be worse than nothing: the CLI would trip on it.
    const home = await materializeCodexHome('workspace-write');

    await expect(stat(join(home, 'auth.json'))).rejects.toThrow();
  });

  it('replaces a stale auth link rather than trusting it', async () => {
    await writeFile(join(userCodexDir(), 'auth.json'), '{"token":"old"}', 'utf8');
    await materializeCodexHome('workspace-write');

    await writeFile(join(userCodexDir(), 'auth.json'), '{"token":"new"}', 'utf8');
    const home = await materializeCodexHome('workspace-write');

    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('{"token":"new"}');
  });
});

describe('applyCodexSandboxMode', () => {
  it('replaces an existing setting in place', () => {
    expect(applyCodexSandboxMode('a = 1\nsandbox_mode = "read-only"\nb = 2\n', 'workspace-write')).toBe(
      'a = 1\nsandbox_mode = "workspace-write"\nb = 2\n'
    );
  });

  it('adds the setting above the first table, where TOML requires it', () => {
    // A bare key after a `[table]` header belongs to that table, not the root -
    // appending would silently move the setting somewhere it does nothing.
    const out = applyCodexSandboxMode('[mcp_servers.mine]\ncommand = "x"\n', 'workspace-write');

    expect(out.indexOf('sandbox_mode')).toBeLessThan(out.indexOf('[mcp_servers.mine]'));
  });

  it('keeps the line endings the file already used', () => {
    expect(applyCodexSandboxMode('a = 1\r\n', 'workspace-write')).toContain('\r\n');
  });
});
