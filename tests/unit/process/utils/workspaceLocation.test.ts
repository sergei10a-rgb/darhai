/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A project without a chosen folder sent each of its chats to a fresh
 * `wcore-temp-<timestamp>` directory inside the app's own data folder.
 *
 * Two things followed, both invisible. Anything an agent wrote landed somewhere
 * the user would never find - not in their documents, machine-named, and no
 * path shown anywhere in the app. And because the name carried a timestamp,
 * every new chat in the same project got a DIFFERENT folder, so the second chat
 * could not see what the first one built. A project is exactly where that
 * continuity is the point.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveProjectWorkspacePath, sanitizeProjectFolderName } from '@process/utils/workspaceLocation';

describe('sanitizeProjectFolderName', () => {
  it('keeps a name the user would recognise', () => {
    expect(sanitizeProjectFolderName('Quarterly Report')).toBe('Quarterly Report');
    expect(sanitizeProjectFolderName('Тайлан 2026')).toBe('Тайлан 2026');
  });

  it('removes what a filesystem will not take', () => {
    expect(sanitizeProjectFolderName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('cannot escape into another directory', () => {
    // The name comes from the user, and the result is joined onto a root.
    const out = sanitizeProjectFolderName('../../etc/passwd');
    expect(out).not.toContain('..');
    expect(out).not.toContain('/');
    expect(out).not.toContain('\\');
  });

  it('never returns nothing, however unusable the name', () => {
    // A project still needs somewhere to live.
    expect(sanitizeProjectFolderName('///')).toBe('Project');
    expect(sanitizeProjectFolderName('   ')).toBe('Project');
    expect(sanitizeProjectFolderName('')).toBe('Project');
  });

  it('avoids the names Windows reserves', () => {
    // `CON` and friends cannot be created as folders at all.
    expect(sanitizeProjectFolderName('CON')).toBe('CON project');
    expect(sanitizeProjectFolderName('lpt1')).toBe('lpt1 project');
  });

  it('drops a trailing dot or space, which Windows creates but cannot open', () => {
    expect(sanitizeProjectFolderName('Report.')).toBe('Report');
    expect(sanitizeProjectFolderName('Report ')).toBe('Report');
  });

  it('caps a very long name so the whole path stays usable', () => {
    expect(sanitizeProjectFolderName('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('resolveProjectWorkspacePath', () => {
  const root = join('/home', 'me', 'Documents', 'Darhai');
  const takenBy = (paths: string[]) => async (path: string) => paths.includes(path);

  it('uses the project name when the folder is free', async () => {
    expect(await resolveProjectWorkspacePath(root, 'Website', takenBy([]))).toBe(join(root, 'Website'));
  });

  it('never hands two projects the same folder', async () => {
    // Sharing one would merge two projects' files with no warning at all.
    const first = join(root, 'Website');
    expect(await resolveProjectWorkspacePath(root, 'Website', takenBy([first]))).toBe(join(root, 'Website 2'));
  });

  it('keeps counting past the first collision', async () => {
    const taken = [join(root, 'Website'), join(root, 'Website 2'), join(root, 'Website 3')];
    expect(await resolveProjectWorkspacePath(root, 'Website', takenBy(taken))).toBe(join(root, 'Website 4'));
  });

  it('stays inside the root for a name that tries to climb out', async () => {
    const resolved = await resolveProjectWorkspacePath(root, '../../etc', takenBy([]));
    expect(resolved.startsWith(root)).toBe(true);
  });
});
