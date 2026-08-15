/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { cudaSearchDirs, hasCudaRuntime } from '@process/services/llamacpp/cudaRuntimeProbe';

/** An existsSync that only knows the paths it was handed. */
const fsWith = (present: string[]) => {
  const set = new Set(present.map((p) => path.resolve(p).toLowerCase()));
  return (p: string) => set.has(path.resolve(p).toLowerCase());
};

const TOOLKIT = 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.3';
const dll = (dir: string, name: string) => path.join(dir, name);

describe('cudaSearchDirs', () => {
  it('looks in the CUDA Toolkit bin, then PATH, then System32', () => {
    const dirs = cudaSearchDirs({
      pathVar: 'C:\\bin;C:\\other',
      cudaPath: TOOLKIT,
      systemRoot: 'C:\\Windows',
    });
    expect(dirs[0]).toBe(path.join(TOOLKIT, 'bin'));
    expect(dirs).toContain('C:\\bin');
    expect(dirs).toContain(path.join('C:\\Windows', 'System32'));
  });

  it('tolerates an empty PATH and an absent CUDA_PATH', () => {
    expect(cudaSearchDirs({ pathVar: '' })).toEqual([]);
  });
});

describe('hasCudaRuntime', () => {
  const env = { pathVar: 'C:\\bin', cudaPath: TOOLKIT, systemRoot: 'C:\\Windows' };
  const bin = path.join(TOOLKIT, 'bin');

  it('is true when all three DLLs resolve', () => {
    const existsSync = fsWith([
      dll(bin, 'cudart64_13.dll'),
      dll(bin, 'cublas64_13.dll'),
      dll(bin, 'cublasLt64_13.dll'),
    ]);
    expect(hasCudaRuntime('13.3', env, { existsSync })).toBe(true);
  });

  it('is false when even one DLL is missing', () => {
    // Two of three still fails to load, so a partial answer would trade a
    // 373 MB download for a broken install.
    const existsSync = fsWith([dll(bin, 'cudart64_13.dll'), dll(bin, 'cublas64_13.dll')]);
    expect(hasCudaRuntime('13.3', env, { existsSync })).toBe(false);
  });

  it('is false on a driver-only machine that has nvcuda.dll and nothing else', () => {
    // Measured on the dev box: an NVIDIA driver puts nvcuda.dll in System32 and
    // installs none of the cudart/cuBLAS DLLs. CUDA_PATH was empty.
    const existsSync = fsWith([path.join('C:\\Windows', 'System32', 'nvcuda.dll')]);
    expect(hasCudaRuntime('13.3', { pathVar: '', systemRoot: 'C:\\Windows' }, { existsSync })).toBe(false);
  });

  it('matches the DLL names of the requested CUDA line', () => {
    const existsSync = fsWith([
      dll(bin, 'cudart64_12.dll'),
      dll(bin, 'cublas64_12.dll'),
      dll(bin, 'cublasLt64_12.dll'),
    ]);
    expect(hasCudaRuntime('12.4', env, { existsSync })).toBe(true);
    // The 12.x DLLs do not satisfy a 13.x build.
    expect(hasCudaRuntime('13.3', env, { existsSync })).toBe(false);
  });

  it('ignores our own managed install directory', () => {
    // Those DLLs being there is a consequence of a previous download, not
    // evidence that the machine supplies them - counting them would be circular.
    const managed = 'C:\\Users\\x\\AppData\\Roaming\\Darhai\\llamacpp\\versions\\b10437';
    const existsSync = fsWith([
      dll(managed, 'cudart64_13.dll'),
      dll(managed, 'cublas64_13.dll'),
      dll(managed, 'cublasLt64_13.dll'),
    ]);
    expect(hasCudaRuntime('13.3', { pathVar: managed }, { existsSync, excludeDirs: [path.dirname(managed)] })).toBe(
      false
    );
    // Without the exclusion it would wrongly report the runtime as present.
    expect(hasCudaRuntime('13.3', { pathVar: managed }, { existsSync })).toBe(true);
  });

  it('is false when nothing is installed at all', () => {
    expect(hasCudaRuntime('13.3', env, { existsSync: fsWith([]) })).toBe(false);
  });
});
