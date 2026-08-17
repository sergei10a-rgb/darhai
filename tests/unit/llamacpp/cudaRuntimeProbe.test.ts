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
  it('looks in the CUDA Toolkit bin, then System32 - and nowhere else', () => {
    const dirs = cudaSearchDirs({
      cudaPath: TOOLKIT,
      systemRoot: 'C:\\Windows',
    });
    expect(dirs).toEqual([path.join(TOOLKIT, 'bin'), path.join('C:\\Windows', 'System32')]);
  });

  it('is empty when neither CUDA_PATH nor SystemRoot is set', () => {
    expect(cudaSearchDirs({})).toEqual([]);
  });
});

describe('hasCudaRuntime', () => {
  const env = { cudaPath: TOOLKIT, systemRoot: 'C:\\Windows' };
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
    expect(hasCudaRuntime('13.3', { systemRoot: 'C:\\Windows' }, { existsSync })).toBe(false);
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

  it('is not satisfied by a third-party llama.cpp directory on PATH', () => {
    // Measured on the reference machine: a hand-installed llama.cpp at
    // C:\claude\llamacpp was on PATH, its cudart DLLs satisfied the probe, the
    // 373 MB cudart archive was skipped - and deleting that directory later
    // silently lost the GPU ("Available devices: (none)", exit 0). PATH is
    // therefore not part of the probe at all: the DLLs exist, but the two
    // sanctioned locations do not carry them, so the answer must be false.
    const foreign = 'C:\\claude\\llamacpp';
    const existsSync = fsWith([
      dll(foreign, 'cudart64_13.dll'),
      dll(foreign, 'cublas64_13.dll'),
      dll(foreign, 'cublasLt64_13.dll'),
    ]);
    expect(hasCudaRuntime('13.3', { systemRoot: 'C:\\Windows' }, { existsSync })).toBe(false);
    // And no way to smuggle the directory in: the search list is closed.
    expect(cudaSearchDirs({ systemRoot: 'C:\\Windows' })).not.toContain(foreign);
  });

  it('ignores our own managed install directory even via CUDA_PATH', () => {
    // Those DLLs being there is a consequence of a previous download, not
    // evidence that the machine supplies them - counting them would be
    // circular. Guarded even for a CUDA_PATH pointed (or leaked) into our
    // own install root.
    const managedRoot = 'C:\\Users\\x\\AppData\\Roaming\\Darhai\\llamacpp';
    const managedBin = path.join(managedRoot, 'versions', 'b10437');
    const existsSync = fsWith([
      dll(path.join(managedBin, 'bin'), 'cudart64_13.dll'),
      dll(path.join(managedBin, 'bin'), 'cublas64_13.dll'),
      dll(path.join(managedBin, 'bin'), 'cublasLt64_13.dll'),
    ]);
    expect(hasCudaRuntime('13.3', { cudaPath: managedBin }, { existsSync, excludeDirs: [managedRoot] })).toBe(false);
    // Without the exclusion it would wrongly report the runtime as present.
    expect(hasCudaRuntime('13.3', { cudaPath: managedBin }, { existsSync })).toBe(true);
  });

  it('is false when nothing is installed at all', () => {
    expect(hasCudaRuntime('13.3', env, { existsSync: fsWith([]) })).toBe(false);
  });
});
