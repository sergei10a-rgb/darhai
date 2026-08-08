/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Red-team regression for SEC-IPC-04 (HIGH): arbitrary file read -> model exfil
 * via addProjectReference. Renderer/remote-supplied `sourcePaths` must pass a
 * confinement gate BEFORE any fs.lstat / fs.copyFile, so a plain absolute path
 * to a sensitive regular file (`/etc/passwd`, ~/.aws/credentials, ~/.ssh/id_rsa
 * when not a symlink) can never be copied into the reference dir and later read
 * back into chat prompts.
 *
 * The gate accepts a source when EITHER confinePath() resolves it (in an
 * authorized app root) OR resolveWithinApprovedDirectory() resolves it (the
 * user picked it through the native open dialog, whose parent dir dialogBridge
 * approves in MAIN). Both return the resolved path used for the copy. The
 * pre-existing symlink-skip, non-regular-file skip and size cap remain as
 * defense in depth.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The three security gates. Mock them so we control accept/reject
// deterministically. resolveExternalReferencePath is the owner-approved
// relaxation (arbitrary folders, sensitive/unsafe still rejected).
vi.mock('@process/bridge/pathConfinement', () => ({
  confinePath: vi.fn(),
  resolveExternalReferencePath: vi.fn(),
}));
vi.mock('@process/bridge/userApprovedPaths', () => ({
  resolveWithinApprovedDirectory: vi.fn(),
}));

// fs/promises is the dangerous sink. Mock the file ops so we detect any raw
// lstat/copyFile against an un-gated path and avoid touching the real disk.
vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    lstat: vi.fn(),
    copyFile: vi.fn(),
    access: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
  },
}));

// bootstrap only contributes the dir-name constant; stub it so the module loads
// without its transitive imports.
vi.mock('@process/services/projectKnowledge/bootstrap', () => ({
  DARHAI_KNOWLEDGE_DIR: '.darhai',
}));

import fs from 'fs/promises';
import { confinePath, resolveExternalReferencePath } from '@process/bridge/pathConfinement';
import { resolveWithinApprovedDirectory } from '@process/bridge/userApprovedPaths';
import { addProjectReference } from '@process/services/projectKnowledge/knowledge';

const mockConfinePath = vi.mocked(confinePath);
const mockResolveExternal = vi.mocked(resolveExternalReferencePath);
const mockResolveApproved = vi.mocked(resolveWithinApprovedDirectory);
const mockMkdir = vi.mocked(fs.mkdir);
const mockLstat = vi.mocked(fs.lstat);
const mockCopyFile = vi.mocked(fs.copyFile);
const mockAccess = vi.mocked(fs.access);
const mockReaddir = vi.mocked(fs.readdir);

const WORKSPACE = '/Users/seandonahoe/Documents/project';
const IN_ROOT = '/Users/seandonahoe/Documents/project/spec.md';
const OUT_OF_ROOT = '/etc/passwd';

/** Minimal fs.Stats-like double for a plain regular file of `size` bytes. */
const regularFile = (size: number) =>
  ({
    isSymbolicLink: () => false,
    isFile: () => true,
    size,
  }) as unknown as Awaited<ReturnType<typeof fs.lstat>>;

beforeEach(() => {
  vi.clearAllMocks();
  // Default the relaxation gate to REJECT, so the existing rejection tests
  // model a source all three gates refuse (a sensitive/unsafe path). Tests
  // exercising the acceptance path override it per-case.
  mockResolveExternal.mockReturnValue(null);
  mockMkdir.mockResolvedValue(undefined as never);
  // uniqueDest: fs.access throws => destination is free on first try.
  mockAccess.mockRejectedValue(new Error('ENOENT') as never);
  mockCopyFile.mockResolvedValue(undefined as never);
  // listProjectReference at the end reads the dir; keep it empty (not asserted).
  mockReaddir.mockResolvedValue([] as never);
});

describe('addProjectReference confinement (SEC-IPC-04)', () => {
  it('rejects a plain out-of-root path and never lstats or copies it', async () => {
    // Neither gate accepts /etc/passwd.
    mockConfinePath.mockResolvedValue(null);
    mockResolveApproved.mockReturnValue(null);

    await addProjectReference(WORKSPACE, [OUT_OF_ROOT]);

    expect(mockConfinePath).toHaveBeenCalledWith(OUT_OF_ROOT);
    // The dangerous sinks were never reached for the rejected source.
    expect(mockLstat).not.toHaveBeenCalled();
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('copies a legitimate in-root source via its confined path', async () => {
    // confinePath accepts and returns the confined (realpath) form.
    mockConfinePath.mockResolvedValue(IN_ROOT);
    mockResolveApproved.mockReturnValue(null);
    mockLstat.mockResolvedValue(regularFile(1234));

    await addProjectReference(WORKSPACE, [IN_ROOT]);

    // lstat/copy operate on the confined path, not the raw input.
    expect(mockLstat).toHaveBeenCalledWith(IN_ROOT);
    expect(mockCopyFile).toHaveBeenCalledTimes(1);
    const [copiedSrc, copiedDest] = mockCopyFile.mock.calls[0];
    expect(copiedSrc).toBe(IN_ROOT);
    expect(String(copiedDest)).toContain('spec.md');
  });

  it('accepts a dialog-approved source outside app roots', async () => {
    const APPROVED = '/Volumes/USB/brief.pdf';
    // Outside every app root, but the user picked it via the native dialog, so
    // the approved-directory gate resolves it (returns the resolved path).
    mockConfinePath.mockResolvedValue(null);
    mockResolveApproved.mockReturnValue(APPROVED);
    mockLstat.mockResolvedValue(regularFile(42));

    await addProjectReference(WORKSPACE, [APPROVED]);

    expect(mockResolveApproved).toHaveBeenCalledWith(APPROVED);
    // lstat/copy operate on the resolved approved path.
    expect(mockLstat).toHaveBeenCalledWith(APPROVED);
    expect(mockCopyFile).toHaveBeenCalledTimes(1);
    expect(mockCopyFile.mock.calls[0][0]).toBe(APPROVED);
    expect(String(mockCopyFile.mock.calls[0][1])).toContain('brief.pdf');
  });

  it('skips the out-of-root path but still copies a sibling in-root path', async () => {
    mockConfinePath.mockImplementation(async (p: unknown) => (p === IN_ROOT ? IN_ROOT : null));
    mockResolveApproved.mockReturnValue(null);
    mockLstat.mockResolvedValue(regularFile(10));

    await addProjectReference(WORKSPACE, [OUT_OF_ROOT, IN_ROOT]);

    // Only the in-root path reached the sink.
    expect(mockLstat).toHaveBeenCalledTimes(1);
    expect(mockLstat).toHaveBeenCalledWith(IN_ROOT);
    expect(mockCopyFile).toHaveBeenCalledTimes(1);
    expect(mockCopyFile).toHaveBeenCalledWith(IN_ROOT, expect.stringContaining('spec.md'));
  });

  // Owner-approved relaxation (2026-08-08): a file dragged from an arbitrary
  // content folder is now accepted through the external-reference gate, even
  // though neither the app-root nor the dialog-approved gate matches it.
  it('accepts an arbitrary-folder source via the external-reference gate', async () => {
    const EXTERNAL = '/home/user/Downloads/dataset.csv';
    mockConfinePath.mockResolvedValue(null);
    mockResolveApproved.mockReturnValue(null);
    mockResolveExternal.mockReturnValue(EXTERNAL);
    mockLstat.mockResolvedValue(regularFile(2048));

    const result = await addProjectReference(WORKSPACE, [EXTERNAL]);

    expect(mockResolveExternal).toHaveBeenCalledWith(EXTERNAL);
    // The copy operates on the resolved external path.
    expect(mockLstat).toHaveBeenCalledWith(EXTERNAL);
    expect(mockCopyFile).toHaveBeenCalledTimes(1);
    expect(mockCopyFile.mock.calls[0][0]).toBe(EXTERNAL);
    expect(String(mockCopyFile.mock.calls[0][1])).toContain('dataset.csv');
    expect(result.rejected).toEqual([]);
  });

  // The relaxation is bounded: a source the external gate refuses (sensitive
  // credential dir / unsafe form) is still rejected and never copied.
  it('still refuses a source the external-reference gate rejects', async () => {
    const SENSITIVE = '/home/user/.ssh/id_rsa';
    mockConfinePath.mockResolvedValue(null);
    mockResolveApproved.mockReturnValue(null);
    mockResolveExternal.mockReturnValue(null); // sensitive → refused

    const result = await addProjectReference(WORKSPACE, [SENSITIVE]);

    expect(mockLstat).not.toHaveBeenCalled();
    expect(mockCopyFile).not.toHaveBeenCalled();
    expect(result.rejected).toEqual([{ name: 'id_rsa', reason: 'not-permitted' }]);
  });
});

/**
 * Refusals are normal here - the reference dir is read straight into prompts,
 * so a source outside every authorized root is rejected on purpose. What was
 * NOT acceptable is that the caller could not tell. `addProjectReference`
 * returned only the resulting list, and the panel reported success using the
 * number of files the user DRAGGED: drop three documents that were all refused
 * and it said "3 files added", while the project quietly lacked the very
 * context it had just been given.
 */
describe('addProjectReference reports what it refused', () => {
  it('names a source it would not accept', async () => {
    mockConfinePath.mockResolvedValue(null);
    mockResolveApproved.mockReturnValue(null);

    const result = await addProjectReference(WORKSPACE, [OUT_OF_ROOT]);

    expect(result.rejected).toEqual([{ name: 'passwd', reason: 'not-permitted' }]);
  });

  it('reports nothing rejected when every source was copied', async () => {
    mockConfinePath.mockResolvedValue(IN_ROOT);
    mockResolveApproved.mockReturnValue(null);
    mockLstat.mockResolvedValue(regularFile(10));

    const result = await addProjectReference(WORKSPACE, [IN_ROOT]);

    expect(result.rejected).toEqual([]);
  });

  it('separates the copied from the refused in a mixed drop', async () => {
    // This is the case the old return type could not express at all.
    mockConfinePath.mockImplementation(async (p: unknown) => (p === IN_ROOT ? IN_ROOT : null));
    mockResolveApproved.mockReturnValue(null);
    mockLstat.mockResolvedValue(regularFile(10));

    const result = await addProjectReference(WORKSPACE, [OUT_OF_ROOT, IN_ROOT]);

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].name).toBe('passwd');
  });

  it('reports a symlinked source as refused, not as added', async () => {
    mockConfinePath.mockResolvedValue(IN_ROOT);
    mockResolveApproved.mockReturnValue(null);
    mockLstat.mockResolvedValue({
      isSymbolicLink: () => true,
      isFile: () => false,
      size: 10,
    } as unknown as Awaited<ReturnType<typeof fs.lstat>>);

    const result = await addProjectReference(WORKSPACE, [IN_ROOT]);

    expect(result.rejected).toEqual([{ name: 'spec.md', reason: 'not-permitted' }]);
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('reports an oversized source with its own reason', async () => {
    mockConfinePath.mockResolvedValue(IN_ROOT);
    mockResolveApproved.mockReturnValue(null);
    mockLstat.mockResolvedValue(regularFile(500 * 1024 * 1024));

    const result = await addProjectReference(WORKSPACE, [IN_ROOT]);

    expect(result.rejected).toEqual([{ name: 'spec.md', reason: 'too-large' }]);
  });

  it('reports a copy that threw, rather than swallowing it', async () => {
    mockConfinePath.mockResolvedValue(IN_ROOT);
    mockResolveApproved.mockReturnValue(null);
    mockLstat.mockResolvedValue(regularFile(10));
    mockCopyFile.mockRejectedValue(new Error('EACCES') as never);

    const result = await addProjectReference(WORKSPACE, [IN_ROOT]);

    expect(result.rejected).toEqual([{ name: 'spec.md', reason: 'failed' }]);
  });

  it('still returns the resulting file list alongside the refusals', async () => {
    mockConfinePath.mockResolvedValue(null);
    mockResolveApproved.mockReturnValue(null);

    const result = await addProjectReference(WORKSPACE, [OUT_OF_ROOT]);

    expect(Array.isArray(result.files)).toBe(true);
  });
});
