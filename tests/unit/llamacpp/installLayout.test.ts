/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  RECEIPT_NAME,
  RECEIPT_SCHEMA,
  downloadsDir,
  installDir,
  installedServerPath,
  isInstalled,
  listInstalledTags,
  llamaRoot,
  llamaServerCandidates,
  readReceipt,
  receiptPath,
  stagingDir,
  versionsDir,
  type LlamaFsProbe,
  type LlamaInstallReceipt,
} from '@process/services/llamacpp/installLayout';

const USER_DATA = path.join('/userData');

const receipt = (over: Partial<LlamaInstallReceipt> = {}): LlamaInstallReceipt => ({
  schema: RECEIPT_SCHEMA,
  tag: 'b10437',
  platform: 'win32',
  arch: 'x64',
  requestedBackend: 'cuda',
  acceleration: 'cuda',
  fallback: null,
  serverRelPath: 'llama-server.exe',
  assets: [{ name: 'llama-b10437-bin-win-cuda-13.3-x64.zip', sha256: 'a'.repeat(64), bytes: 146777069 }],
  files: ['ggml-base.dll', 'ggml-cuda.dll', 'llama-server.exe'],
  requires: [],
  installedAt: '2026-08-15T00:00:00.000Z',
  ...over,
});

/**
 * An in-memory filesystem. `files` maps absolute paths to contents; directories
 * are inferred, so a "partially extracted" install is expressed by simply
 * leaving files out.
 */
function fakeFs(files: Record<string, string>): LlamaFsProbe {
  const norm = (p: string) => path.resolve(p);
  const all = Object.keys(files).map(norm);
  // Real `fs.existsSync` is true for directories too, so the double has to
  // treat any ancestor of a known file as existing - otherwise it reports
  // "no versions directory" and every lookup trivially returns null.
  const dirs = new Set<string>();
  for (const f of all) {
    let dir = path.dirname(f);
    while (dir && !dirs.has(dir)) {
      dirs.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return {
    existsSync: (p) => all.includes(norm(p)) || dirs.has(norm(p)),
    readFileSync: (p) => {
      const key = Object.keys(files).find((k) => norm(k) === norm(p));
      if (key === undefined) throw new Error(`ENOENT: ${p}`);
      return files[key];
    },
    readdirSync: (p) => {
      const dir = norm(p) + path.sep;
      const names = new Set<string>();
      for (const f of all) {
        if (!f.startsWith(dir)) continue;
        names.add(f.slice(dir.length).split(path.sep)[0]);
      }
      if (names.size === 0) throw new Error(`ENOENT: ${p}`);
      return [...names];
    },
  };
}

/** A complete, valid install of one tag. */
function completeInstall(tag: string, over: Partial<LlamaInstallReceipt> = {}): Record<string, string> {
  const dir = installDir(USER_DATA, tag);
  return {
    [path.join(dir, RECEIPT_NAME)]: JSON.stringify(receipt({ tag, ...over })),
    [path.join(dir, 'llama-server.exe')]: 'SERVER',
    [path.join(dir, 'ggml-cuda.dll')]: 'CUDA',
    [path.join(dir, 'ggml-base.dll')]: 'BASE',
  };
}

describe('install layout paths', () => {
  it('keeps every managed artefact under userData/llamacpp', () => {
    expect(llamaRoot(USER_DATA)).toBe(path.join(USER_DATA, 'llamacpp'));
    expect(versionsDir(USER_DATA)).toBe(path.join(USER_DATA, 'llamacpp', 'versions'));
    expect(downloadsDir(USER_DATA)).toBe(path.join(USER_DATA, 'llamacpp', 'downloads'));
    expect(stagingDir(USER_DATA)).toBe(path.join(USER_DATA, 'llamacpp', 'staging'));
  });

  it('versions each install by release tag so an upgrade cannot overwrite one in place', () => {
    expect(installDir(USER_DATA, 'b10437')).toBe(path.join(versionsDir(USER_DATA), 'b10437'));
    expect(installDir(USER_DATA, 'b10500')).toBe(path.join(versionsDir(USER_DATA), 'b10500'));
    expect(installDir(USER_DATA, 'b10437')).not.toBe(installDir(USER_DATA, 'b10500'));
  });

  it('keeps downloads and staging outside the versions tree', () => {
    // A half-extracted staging directory must not be reachable from the search
    // path at all, not merely be incomplete.
    expect(downloadsDir(USER_DATA).startsWith(versionsDir(USER_DATA))).toBe(false);
    expect(stagingDir(USER_DATA).startsWith(versionsDir(USER_DATA))).toBe(false);
  });

  it('puts the receipt inside the install directory', () => {
    expect(receiptPath(USER_DATA, 'b10437')).toBe(path.join(installDir(USER_DATA, 'b10437'), RECEIPT_NAME));
  });
});

describe('isInstalled - readiness is a filesystem fact', () => {
  it('reports a complete install as ready', () => {
    expect(isInstalled(USER_DATA, 'b10437', fakeFs(completeInstall('b10437')))).toBe(true);
  });

  it('reports a directory with no receipt as NOT ready', () => {
    // This is the killed-extraction shape: files landed, the receipt never did.
    const files = completeInstall('b10437');
    delete files[path.join(installDir(USER_DATA, 'b10437'), RECEIPT_NAME)];
    expect(isInstalled(USER_DATA, 'b10437', fakeFs(files))).toBe(false);
  });

  it('reports a partially extracted directory as NOT ready', () => {
    // Receipt lists 3 files; only 1 is on disk.
    const dir = installDir(USER_DATA, 'b10437');
    const files = completeInstall('b10437');
    delete files[path.join(dir, 'ggml-base.dll')];
    delete files[path.join(dir, 'ggml-cuda.dll')];
    expect(isInstalled(USER_DATA, 'b10437', fakeFs(files))).toBe(false);
  });

  it('names the missing file rather than counting, so a swap cannot pass', () => {
    // Same number of files as the receipt records, but not the same files.
    // A `count >= fileCount` test calls this ready; naming them does not.
    const dir = installDir(USER_DATA, 'b10437');
    const files = completeInstall('b10437');
    delete files[path.join(dir, 'ggml-cuda.dll')];
    files[path.join(dir, 'something-else.dll')] = 'x';
    expect(isInstalled(USER_DATA, 'b10437', fakeFs(files))).toBe(false);
  });

  it('reports an install whose server binary vanished as NOT ready', () => {
    const dir = installDir(USER_DATA, 'b10437');
    const files = completeInstall('b10437');
    delete files[path.join(dir, 'llama-server.exe')];
    expect(isInstalled(USER_DATA, 'b10437', fakeFs(files))).toBe(false);
  });

  it('reports an install missing a library its own binaries load as NOT ready', () => {
    // This is the macOS/Linux defect in miniature. Every file the extractor
    // wrote is present and the receipt agrees with itself - but `requires` came
    // out of the binaries' own load commands, and `libllama.0.dylib` (a symlink
    // in the real tarball) never landed.
    const dir = installDir(USER_DATA, 'b10441');
    const files = {
      [path.join(dir, RECEIPT_NAME)]: JSON.stringify(
        receipt({
          tag: 'b10441',
          platform: 'darwin',
          serverRelPath: 'llama-server',
          files: ['libllama.0.1.0.dylib', 'llama-server'],
          requires: ['libllama.0.dylib'],
        })
      ),
      [path.join(dir, 'llama-server')]: 'SERVER',
      [path.join(dir, 'libllama.0.1.0.dylib')]: 'LIB',
    };
    expect(isInstalled(USER_DATA, 'b10441', fakeFs(files))).toBe(false);

    // Materialising that name - a symlink on macOS, a copy on Windows - is what
    // makes the same tree ready.
    files[path.join(dir, 'libllama.0.dylib')] = 'LIB';
    expect(isInstalled(USER_DATA, 'b10441', fakeFs(files))).toBe(true);
  });

  it('reports an install whose files live in subdirectories as ready', () => {
    // A non-recursive count of the top level reads 2 where the receipt says 3.
    const dir = installDir(USER_DATA, 'b10437');
    const files = {
      [path.join(dir, RECEIPT_NAME)]: JSON.stringify(
        receipt({ files: ['llama-server.exe', 'sub/a.dll', 'sub/b.dll'] })
      ),
      [path.join(dir, 'llama-server.exe')]: 'SERVER',
      [path.join(dir, 'sub', 'a.dll')]: 'A',
      [path.join(dir, 'sub', 'b.dll')]: 'B',
    };
    expect(isInstalled(USER_DATA, 'b10437', fakeFs(files))).toBe(true);
  });

  it('reports an unparseable receipt as NOT ready', () => {
    const files = completeInstall('b10437');
    files[path.join(installDir(USER_DATA, 'b10437'), RECEIPT_NAME)] = '{ this is not json';
    expect(isInstalled(USER_DATA, 'b10437', fakeFs(files))).toBe(false);
  });

  it('reports a schema-1 receipt as NOT ready even though it looks complete', () => {
    // Schema 1 was written by the extractor that dropped every symlink, and its
    // `fileCount` came from that same extractor. Reading it would re-certify a
    // tree that cannot run; refusing it makes the next serve reinstall.
    const dir = installDir(USER_DATA, 'b10437');
    const legacy: Record<string, unknown> = {
      schema: 1,
      tag: 'b10437',
      platform: 'win32',
      arch: 'x64',
      requestedBackend: 'cuda',
      acceleration: 'cuda',
      fallback: null,
      serverRelPath: 'llama-server.exe',
      assets: [],
      fileCount: 3,
      installedAt: '2026-08-15T00:00:00.000Z',
    };
    const files = completeInstall('b10437');
    files[path.join(dir, RECEIPT_NAME)] = JSON.stringify(legacy);
    expect(isInstalled(USER_DATA, 'b10437', fakeFs(files))).toBe(false);
  });

  it('reports a receipt from an unknown schema as NOT ready', () => {
    const files = completeInstall('b10437');
    files[path.join(installDir(USER_DATA, 'b10437'), RECEIPT_NAME)] = JSON.stringify(
      receipt({ tag: 'b10437', schema: 999 })
    );
    expect(isInstalled(USER_DATA, 'b10437', fakeFs(files))).toBe(false);
  });

  it('reports a receipt naming a different tag than its directory as NOT ready', () => {
    const files = completeInstall('b10437');
    files[path.join(installDir(USER_DATA, 'b10437'), RECEIPT_NAME)] = JSON.stringify(receipt({ tag: 'b10500' }));
    expect(isInstalled(USER_DATA, 'b10437', fakeFs(files))).toBe(false);
  });

  it('reports a missing install directory as NOT ready', () => {
    expect(isInstalled(USER_DATA, 'b10437', fakeFs({}))).toBe(false);
  });
});

describe('readReceipt', () => {
  it('returns the parsed receipt for a valid install', () => {
    const parsed = readReceipt(USER_DATA, 'b10437', fakeFs(completeInstall('b10437')));
    expect(parsed.tag).toBe('b10437');
    expect(parsed.acceleration).toBe('cuda');
    expect(parsed.serverRelPath).toBe('llama-server.exe');
  });

  it('carries a stated CPU fallback through to disk so the UI can keep showing it', () => {
    const files = completeInstall('b10437', {
      acceleration: 'cpu',
      requestedBackend: 'rocm',
      fallback: {
        from: 'rocm',
        to: 'cpu',
        code: 'NO_GPU_BUILD_FOR_TARGET',
        reason: 'no ROCm build for linux/x64',
      },
    });
    const parsed = readReceipt(USER_DATA, 'b10437', fakeFs(files));
    expect(parsed.fallback.from).toBe('rocm');
    // The code survives to disk, so the UI can still localize the explanation
    // long after the install happened.
    expect(parsed.fallback.code).toBe('NO_GPU_BUILD_FOR_TARGET');
    expect(parsed.fallback.reason).toContain('ROCm');
  });

  it('returns null rather than throwing on a missing file', () => {
    expect(readReceipt(USER_DATA, 'b10437', fakeFs({}))).toBeNull();
  });
});

describe('installedServerPath / llamaServerCandidates', () => {
  it('returns the absolute server path of a ready install', () => {
    const fs = fakeFs(completeInstall('b10437'));
    expect(installedServerPath(USER_DATA, undefined, fs)).toBe(
      path.join(installDir(USER_DATA, 'b10437'), 'llama-server.exe')
    );
  });

  it('returns null when nothing is installed - the state before this work existed', () => {
    expect(installedServerPath(USER_DATA, undefined, fakeFs({}))).toBeNull();
    expect(llamaServerCandidates(USER_DATA, fakeFs({}))).toEqual([]);
  });

  it('returns null when the only install is incomplete', () => {
    const files = completeInstall('b10437');
    delete files[path.join(installDir(USER_DATA, 'b10437'), RECEIPT_NAME)];
    expect(installedServerPath(USER_DATA, undefined, fakeFs(files))).toBeNull();
  });

  it('prefers the newest release tag when several are installed', () => {
    const fs = fakeFs({ ...completeInstall('b10437'), ...completeInstall('b10500') });
    expect(listInstalledTags(USER_DATA, fs)).toEqual(['b10500', 'b10437']);
    expect(installedServerPath(USER_DATA, undefined, fs)).toContain(path.join('versions', 'b10500'));
  });

  it('sorts tags numerically, not lexically', () => {
    // b9000 is lexically greater than b10500 but numerically much older.
    const fs = fakeFs({ ...completeInstall('b9000'), ...completeInstall('b10500') });
    expect(listInstalledTags(USER_DATA, fs)).toEqual(['b10500', 'b9000']);
  });

  it('can pin a specific tag', () => {
    const fs = fakeFs({ ...completeInstall('b10437'), ...completeInstall('b10500') });
    expect(installedServerPath(USER_DATA, 'b10437', fs)).toContain(path.join('versions', 'b10437'));
  });

  it('skips a broken install and returns the working older one', () => {
    // An interrupted upgrade must not take the running install down with it.
    const files = { ...completeInstall('b10437'), ...completeInstall('b10500') };
    delete files[path.join(installDir(USER_DATA, 'b10500'), RECEIPT_NAME)];
    const fs = fakeFs(files);
    expect(listInstalledTags(USER_DATA, fs)).toEqual(['b10437']);
    expect(installedServerPath(USER_DATA, undefined, fs)).toContain(path.join('versions', 'b10437'));
  });

  it('lists every ready install newest-first for LocalServeManager to probe', () => {
    const fs = fakeFs({ ...completeInstall('b10437'), ...completeInstall('b10500') });
    expect(llamaServerCandidates(USER_DATA, fs)).toEqual([
      path.join(installDir(USER_DATA, 'b10500'), 'llama-server.exe'),
      path.join(installDir(USER_DATA, 'b10437'), 'llama-server.exe'),
    ]);
  });

  it('uses the platform server name recorded in the receipt', () => {
    const dir = installDir(USER_DATA, 'b10437');
    const fs = fakeFs({
      [path.join(dir, RECEIPT_NAME)]: JSON.stringify(
        receipt({ platform: 'linux', serverRelPath: 'llama-server', files: ['libllama.so', 'llama-server'] })
      ),
      [path.join(dir, 'llama-server')]: 'SERVER',
      [path.join(dir, 'libllama.so')]: 'LIB',
    });
    expect(installedServerPath(USER_DATA, undefined, fs)).toBe(path.join(dir, 'llama-server'));
  });
});
