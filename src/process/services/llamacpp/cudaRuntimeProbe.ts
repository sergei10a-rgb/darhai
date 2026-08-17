/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Decides whether a Windows NVIDIA machine downloads ~140 MB or ~510 MB.
 *
 * Measured (HTTP Range read of each archive's central directory, b10437):
 *
 *   llama-b10437-bin-win-cuda-13.3-x64.zip   140 MB, 52 entries, has ggml-cuda.dll
 *   cudart-llama-bin-win-cuda-13.3-x64.zip   373 MB, EXACTLY 3 entries:
 *       cudart64_13.dll, cublas64_13.dll, cublasLt64_13.dll
 *
 * The server archive contains none of those three, so `ggml-cuda.dll` cannot
 * load without them. They ship with the CUDA *Toolkit*; the NVIDIA *driver*
 * installs `nvcuda.dll` into System32 and nothing else. Verified on the dev
 * machine (RTX 4070, driver present, `CUDA_PATH` empty): `nvcuda.dll` was found
 * in System32, and the three cudart DLLs existed only inside a hand-installed
 * llama.cpp directory - i.e. a clean NVIDIA box does NOT have them.
 *
 * Hence the default is to fetch the cudart archive, and this probe is the only
 * thing that may downgrade that to "skip". It deliberately does NOT count our
 * own managed install directory: those DLLs being there is a consequence of a
 * previous download, not evidence that the machine supplies them.
 *
 * WHY PATH IS NOT SEARCHED. It used to be, and on the reference machine the
 * probe answered `true` because a THIRD-PARTY hand-installed llama.cpp
 * (C:\claude\llamacpp) happened to sit on PATH with its own cudart copies. The
 * 373 MB archive was skipped, and deleting that unrelated directory later
 * silently lost the GPU - "Available devices: (none)", exit 0, nothing logged
 * (measured, see docs/architecture/local-models.md §3). A directory Darhai
 * does not own says nothing durable about the machine, so the probe is
 * restricted to the two locations the runtime is INSTALLED to by its owners:
 * the CUDA Toolkit's own `CUDA_PATH\bin` and the system's System32. Erring
 * this way costs at most a re-download of an archive the machine already had;
 * erring the old way cost the GPU.
 */

import fs from 'node:fs';
import path from 'node:path';
import { cudaRuntimeDllNames } from './assetMap';

export type CudaProbeEnv = {
  /** `process.env.CUDA_PATH`, when a CUDA Toolkit is installed. */
  cudaPath?: string;
  /** `process.env.SystemRoot`, for the driver's System32 copies. */
  systemRoot?: string;
};

export type CudaProbeDeps = {
  existsSync: (p: string) => boolean;
  /** Directories to ignore even here (our own managed installs). */
  excludeDirs: readonly string[];
};

/**
 * Directories worth searching for the CUDA runtime, in priority order.
 * Deliberately NOT PATH - see the module comment.
 */
export function cudaSearchDirs(env: CudaProbeEnv): string[] {
  const dirs: string[] = [];
  if (env.cudaPath) dirs.push(path.join(env.cudaPath, 'bin'));
  if (env.systemRoot) dirs.push(path.join(env.systemRoot, 'System32'));
  return dirs;
}

/**
 * True when every DLL of the given CUDA line already resolves on this machine.
 *
 * All three must be present: two out of three still fails to load, and a
 * partial answer here would trade a 373 MB download for a broken install.
 */
export function hasCudaRuntime(cudaVersion: string, env: CudaProbeEnv, deps?: Partial<CudaProbeDeps>): boolean {
  const existsSync = deps?.existsSync || ((p: string) => fs.existsSync(p));
  const excluded = (deps?.excludeDirs || []).map((d) => path.resolve(d).toLowerCase());
  const dirs = cudaSearchDirs(env).filter((d) => {
    const resolved = path.resolve(d).toLowerCase();
    return !excluded.some((ex) => resolved === ex || resolved.startsWith(ex + path.sep));
  });

  for (const dll of cudaRuntimeDllNames(cudaVersion)) {
    const found = dirs.some((dir) => existsSync(path.join(dir, dll)));
    if (!found) return false;
  }
  return true;
}
