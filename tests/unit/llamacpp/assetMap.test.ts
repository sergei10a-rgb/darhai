/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  cudaRuntimeDllNames,
  planLlamaAssets,
  serverBinaryName,
  type LlamaAcceleration,
  type LlamaAssetPlanResult,
} from '@process/services/llamacpp/assetMap';
import type { HwfitBackend } from '@/common/types/hwfit';

const TAG = 'b10437';

/**
 * The asset names ggml-org/llama.cpp release b10437 actually ships, measured on
 * 2026-08-15 with `gh api repos/ggml-org/llama.cpp/releases/latest`. Keeping the
 * real list here is the point: the mapper only ever names assets from this set,
 * so a plan that passes these tests cannot 404.
 */
const B10437_ASSETS = [
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.3-x64.zip',
  'cudart-llama-bin-win-cuda-13.4-arm64.zip',
  'llama-b10437-bin-android-arm64.tar.gz',
  'llama-b10437-bin-macos-arm64.tar.gz',
  'llama-b10437-bin-macos-x64.tar.gz',
  'llama-b10437-bin-ubuntu-arm64.tar.gz',
  'llama-b10437-bin-ubuntu-openvino-2026.2.1-x64.tar.gz',
  'llama-b10437-bin-ubuntu-s390x.tar.gz',
  'llama-b10437-bin-ubuntu-sycl-fp16-x64.tar.gz',
  'llama-b10437-bin-ubuntu-sycl-fp32-x64.tar.gz',
  'llama-b10437-bin-ubuntu-vulkan-arm64.tar.gz',
  'llama-b10437-bin-ubuntu-vulkan-x64.tar.gz',
  'llama-b10437-bin-ubuntu-x64.tar.gz',
  'llama-b10437-bin-win-cpu-arm64.zip',
  'llama-b10437-bin-win-cpu-x64.zip',
  'llama-b10437-bin-win-cuda-12.4-x64.zip',
  'llama-b10437-bin-win-cuda-13.3-x64.zip',
  'llama-b10437-bin-win-cuda-13.4-arm64.zip',
  'llama-b10437-bin-win-opencl-adreno-arm64.zip',
  'llama-b10437-bin-win-openvino-2026.2.1-x64.zip',
  'llama-b10437-bin-win-rocm-7.14-x64.zip',
  'llama-b10437-bin-win-sycl-x64.zip',
  'llama-b10437-bin-win-vulkan-x64.zip',
  'llama-b10437-ui.tar.gz',
  'llama-b10437-xcframework.zip',
];

const plan = (
  platform: string,
  arch: string,
  backend: HwfitBackend,
  extra: {
    cudaRuntimePresent?: boolean;
    cudaVariant?: string;
    availableAssets?: string[];
    driverVersion?: string | null;
  } = {}
): LlamaAssetPlanResult =>
  planLlamaAssets({
    platform,
    arch,
    backend,
    tag: TAG,
    availableAssets: extra.availableAssets || B10437_ASSETS,
    cudaRuntimePresent: extra.cudaRuntimePresent,
    cudaVariant: extra.cudaVariant,
    driverVersion: extra.driverVersion,
  });

/** Assert an `ok` plan and hand it back narrowed. */
const ok = (result: LlamaAssetPlanResult) => {
  if (result.kind !== 'ok') throw new Error(`expected ok plan, got unsupported: ${result.reason}`);
  return result;
};

type Row = {
  platform: string;
  arch: string;
  backend: HwfitBackend;
  acceleration: LlamaAcceleration;
  assets: string[];
  /** true when the plan must carry a stated fallback. */
  fallback: boolean;
};

/**
 * Every (platform, arch, backend) combination with a llama.cpp build, and what
 * it must resolve to. Rows with `fallback: true` are the cases with no good
 * answer - the requirement is that they resolve to CPU *and say so*, never that
 * they silently substitute.
 */
const TABLE: Row[] = [
  // Windows x64 - the only target with a real accelerated build for both vendors.
  {
    platform: 'win32',
    arch: 'x64',
    backend: 'cuda',
    acceleration: 'cuda',
    assets: ['llama-b10437-bin-win-cuda-13.3-x64.zip', 'cudart-llama-bin-win-cuda-13.3-x64.zip'],
    fallback: false,
  },
  {
    platform: 'win32',
    arch: 'x64',
    backend: 'rocm',
    acceleration: 'rocm',
    assets: ['llama-b10437-bin-win-rocm-7.14-x64.zip'],
    fallback: false,
  },
  {
    platform: 'win32',
    arch: 'x64',
    backend: 'metal',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-win-cpu-x64.zip'],
    fallback: true,
  },
  {
    platform: 'win32',
    arch: 'x64',
    backend: 'cpu_x86',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-win-cpu-x64.zip'],
    fallback: false,
  },
  {
    platform: 'win32',
    arch: 'x64',
    backend: 'cpu_arm',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-win-cpu-x64.zip'],
    fallback: false,
  },

  // Windows arm64 - CUDA exists (13.4), ROCm does not.
  {
    platform: 'win32',
    arch: 'arm64',
    backend: 'cuda',
    acceleration: 'cuda',
    assets: ['llama-b10437-bin-win-cuda-13.4-arm64.zip', 'cudart-llama-bin-win-cuda-13.4-arm64.zip'],
    fallback: false,
  },
  {
    platform: 'win32',
    arch: 'arm64',
    backend: 'rocm',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-win-cpu-arm64.zip'],
    fallback: true,
  },
  {
    platform: 'win32',
    arch: 'arm64',
    backend: 'metal',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-win-cpu-arm64.zip'],
    fallback: true,
  },
  {
    platform: 'win32',
    arch: 'arm64',
    backend: 'cpu_x86',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-win-cpu-arm64.zip'],
    fallback: false,
  },
  {
    platform: 'win32',
    arch: 'arm64',
    backend: 'cpu_arm',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-win-cpu-arm64.zip'],
    fallback: false,
  },

  // macOS arm64 - Metal is real here and nowhere else.
  {
    platform: 'darwin',
    arch: 'arm64',
    backend: 'metal',
    acceleration: 'metal',
    assets: ['llama-b10437-bin-macos-arm64.tar.gz'],
    fallback: false,
  },
  {
    platform: 'darwin',
    arch: 'arm64',
    backend: 'cuda',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-macos-arm64.tar.gz'],
    fallback: true,
  },
  {
    platform: 'darwin',
    arch: 'arm64',
    backend: 'rocm',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-macos-arm64.tar.gz'],
    fallback: true,
  },
  {
    platform: 'darwin',
    arch: 'arm64',
    backend: 'cpu_x86',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-macos-arm64.tar.gz'],
    fallback: false,
  },
  {
    platform: 'darwin',
    arch: 'arm64',
    backend: 'cpu_arm',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-macos-arm64.tar.gz'],
    fallback: false,
  },

  // macOS x64 (Intel Mac) - the x64 tarball ships libggml-blas and NO Metal.
  {
    platform: 'darwin',
    arch: 'x64',
    backend: 'metal',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-macos-x64.tar.gz'],
    fallback: true,
  },
  {
    platform: 'darwin',
    arch: 'x64',
    backend: 'cuda',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-macos-x64.tar.gz'],
    fallback: true,
  },
  {
    platform: 'darwin',
    arch: 'x64',
    backend: 'rocm',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-macos-x64.tar.gz'],
    fallback: true,
  },
  {
    platform: 'darwin',
    arch: 'x64',
    backend: 'cpu_x86',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-macos-x64.tar.gz'],
    fallback: false,
  },
  {
    platform: 'darwin',
    arch: 'x64',
    backend: 'cpu_arm',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-macos-x64.tar.gz'],
    fallback: false,
  },

  // Linux - the release ships NO cuda and NO rocm build for either arch.
  {
    platform: 'linux',
    arch: 'x64',
    backend: 'cuda',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-ubuntu-x64.tar.gz'],
    fallback: true,
  },
  {
    platform: 'linux',
    arch: 'x64',
    backend: 'rocm',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-ubuntu-x64.tar.gz'],
    fallback: true,
  },
  {
    platform: 'linux',
    arch: 'x64',
    backend: 'metal',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-ubuntu-x64.tar.gz'],
    fallback: true,
  },
  {
    platform: 'linux',
    arch: 'x64',
    backend: 'cpu_x86',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-ubuntu-x64.tar.gz'],
    fallback: false,
  },
  {
    platform: 'linux',
    arch: 'x64',
    backend: 'cpu_arm',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-ubuntu-x64.tar.gz'],
    fallback: false,
  },
  {
    platform: 'linux',
    arch: 'arm64',
    backend: 'cuda',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-ubuntu-arm64.tar.gz'],
    fallback: true,
  },
  {
    platform: 'linux',
    arch: 'arm64',
    backend: 'rocm',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-ubuntu-arm64.tar.gz'],
    fallback: true,
  },
  {
    platform: 'linux',
    arch: 'arm64',
    backend: 'metal',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-ubuntu-arm64.tar.gz'],
    fallback: true,
  },
  {
    platform: 'linux',
    arch: 'arm64',
    backend: 'cpu_x86',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-ubuntu-arm64.tar.gz'],
    fallback: false,
  },
  {
    platform: 'linux',
    arch: 'arm64',
    backend: 'cpu_arm',
    acceleration: 'cpu',
    assets: ['llama-b10437-bin-ubuntu-arm64.tar.gz'],
    fallback: false,
  },
];

describe('planLlamaAssets - every platform x arch x backend', () => {
  it('covers all 30 combinations of the 3 platforms, 2 arches and 5 backends', () => {
    expect(TABLE).toHaveLength(30);
    const seen = new Set(TABLE.map((r) => `${r.platform}/${r.arch}/${r.backend}`));
    expect(seen.size).toBe(30);
  });

  for (const row of TABLE) {
    const label = `${row.platform}/${row.arch} + ${row.backend}`;
    it(`${label} -> ${row.acceleration}${row.fallback ? ' (stated fallback)' : ''}`, () => {
      const result = ok(plan(row.platform, row.arch, row.backend));
      expect(result.acceleration).toBe(row.acceleration);
      expect(result.assets.map((a) => a.name)).toEqual(row.assets);
      expect(result.requestedBackend).toBe(row.backend);
      expect(result.tag).toBe(TAG);
    });

    it(`${label} ${row.fallback ? 'states why it fell back to CPU' : 'reports no fallback'}`, () => {
      const result = ok(plan(row.platform, row.arch, row.backend));
      if (row.fallback) {
        // A silent substitution is the failure mode being guarded against.
        expect(result.fallback).not.toBeNull();
        expect(result.fallback.from).toBe(row.backend);
        expect(result.fallback.to).toBe('cpu');
        // The code is what the 13 locales key off; the prose is a diagnostic.
        expect(result.fallback.code.length).toBeGreaterThan(0);
        expect(result.fallback.reason.length).toBeGreaterThan(20);
      } else {
        expect(result.fallback).toBeNull();
      }
    });
  }
});

/**
 * The three cases with no good answer, as standalone tests.
 *
 * They are already covered by the table above, but the table generates its
 * names from the row (`linux/x64 + cuda ...`) and those characters are regex
 * metacharacters, so `vitest -t` cannot select a single one of them - which
 * makes them impossible to use as a mutation target. These names are plain
 * prose on purpose.
 */
describe('planLlamaAssets - the cases with no good answer', () => {
  it('gives an Intel Mac asking for Metal a stated CPU fallback', () => {
    // Measured: llama-b10437-bin-macos-x64.tar.gz contains libggml-blas.dylib
    // and no libggml-metal.dylib, while the arm64 tarball has Metal.
    const result = ok(plan('darwin', 'x64', 'metal'));
    expect(result.acceleration).toBe('cpu');
    expect(result.fallback).not.toBeNull();
    expect(result.fallback.from).toBe('metal');
    expect(result.fallback.code).toBe('METAL_REQUIRES_APPLE_SILICON');
    expect(result.fallback.reason).toContain('Metal');
    expect(result.assets[0].name).toBe('llama-b10437-bin-macos-x64.tar.gz');
  });

  it('gives a Linux NVIDIA machine a stated CPU fallback', () => {
    // Measured: release b10437 has no ubuntu-cuda asset of any version.
    const result = ok(plan('linux', 'x64', 'cuda'));
    expect(result.acceleration).toBe('cpu');
    expect(result.fallback).not.toBeNull();
    expect(result.fallback.code).toBe('NO_GPU_BUILD_FOR_TARGET');
    expect(result.fallback.reason).toContain('CUDA');
    expect(result.assets[0].name).toBe('llama-b10437-bin-ubuntu-x64.tar.gz');
  });

  it('gives a Linux AMD machine a stated CPU fallback', () => {
    // Measured: release b10437 has no ubuntu-rocm asset of any version.
    const result = ok(plan('linux', 'x64', 'rocm'));
    expect(result.acceleration).toBe('cpu');
    expect(result.fallback).not.toBeNull();
    expect(result.fallback.reason).toContain('ROCm');
  });

  it('gives a Windows ARM machine asking for ROCm a stated CPU fallback', () => {
    // Measured: win-rocm exists for x64 only.
    const result = ok(plan('win32', 'arm64', 'rocm'));
    expect(result.acceleration).toBe('cpu');
    expect(result.fallback.reason).toContain('ROCm');
  });
});

describe('planLlamaAssets - machines with no build at all', () => {
  it('rejects an unknown platform instead of guessing an asset name', () => {
    const result = plan('freebsd', 'x64', 'cpu_x86');
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') expect(result.reason).toContain('freebsd');
  });

  it('rejects 32-bit x86, which llama.cpp does not publish', () => {
    const result = plan('win32', 'ia32', 'cpu_x86');
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') expect(result.reason).toContain('ia32');
  });

  it('rejects an unknown architecture on a supported platform', () => {
    const result = plan('linux', 'ppc64', 'cpu_x86');
    expect(result.kind).toBe('unsupported');
  });

  it('reports unsupported when the release is missing the CPU build for this target', () => {
    const result = plan('linux', 'x64', 'cpu_x86', { availableAssets: ['llama-b10437-bin-macos-arm64.tar.gz'] });
    expect(result.kind).toBe('unsupported');
    if (result.kind === 'unsupported') expect(result.reason).toContain('llama-b10437-bin-ubuntu-x64.tar.gz');
  });

  it('accepts common arch aliases', () => {
    expect(ok(plan('linux', 'x86_64', 'cpu_x86')).arch).toBe('x64');
    expect(ok(plan('linux', 'aarch64', 'cpu_arm')).arch).toBe('arm64');
  });
});

describe('planLlamaAssets - the CUDA runtime decision', () => {
  it('adds the 373 MB cudart archive when the machine has no CUDA runtime', () => {
    const result = ok(plan('win32', 'x64', 'cuda', { cudaRuntimePresent: false }));
    expect(result.assets).toHaveLength(2);
    expect(result.assets[1]).toEqual({
      role: 'cuda-runtime',
      name: 'cudart-llama-bin-win-cuda-13.3-x64.zip',
      format: 'zip',
    });
    expect(result.notes.join(' ')).toContain('cudart64_13.dll');
  });

  it('omits the cudart archive when the runtime already resolves, saving ~373 MB', () => {
    const result = ok(plan('win32', 'x64', 'cuda', { cudaRuntimePresent: true }));
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].role).toBe('server');
    expect(result.acceleration).toBe('cuda');
    expect(result.notes.join(' ')).toContain('skipping');
  });

  it('defaults to fetching cudart when presence was not measured', () => {
    // A driver-only NVIDIA machine has nvcuda.dll and none of the three, so the
    // safe default is to download rather than to assume.
    const result = ok(plan('win32', 'x64', 'cuda'));
    expect(result.assets.map((a) => a.role)).toEqual(['server', 'cuda-runtime']);
  });

  it('falls back to CPU when the CUDA build has no matching cudart archive', () => {
    const withoutCudart = B10437_ASSETS.filter((n) => !n.startsWith('cudart-'));
    const result = ok(plan('win32', 'x64', 'cuda', { availableAssets: withoutCudart }));
    expect(result.acceleration).toBe('cpu');
    expect(result.fallback).not.toBeNull();
    expect(result.fallback.code).toBe('CUDA_RUNTIME_UNAVAILABLE');
    expect(result.fallback.reason).toContain('cublas64_13.dll');
  });

  it('pairs the cudart archive to the exact CUDA line of the server build', () => {
    const result = ok(plan('win32', 'x64', 'cuda', { cudaVariant: '12.4' }));
    expect(result.assets.map((a) => a.name)).toEqual([
      'llama-b10437-bin-win-cuda-12.4-x64.zip',
      'cudart-llama-bin-win-cuda-12.4-x64.zip',
    ]);
  });

  it('picks the highest CUDA line when several are published', () => {
    // 13.3 over 12.4 - a lexical sort would pick 12.4.
    expect(ok(plan('win32', 'x64', 'cuda')).assets[0].name).toBe('llama-b10437-bin-win-cuda-13.3-x64.zip');
  });

  it('falls back to CPU when the pinned CUDA line is not published', () => {
    const result = ok(plan('win32', 'x64', 'cuda', { cudaVariant: '11.8' }));
    expect(result.acceleration).toBe('cpu');
    expect(result.fallback.reason).toContain('11.8');
  });

  it('names the DLLs each CUDA line ships', () => {
    expect(cudaRuntimeDllNames('13.3')).toEqual(['cudart64_13.dll', 'cublas64_13.dll', 'cublasLt64_13.dll']);
    expect(cudaRuntimeDllNames('12.4')).toEqual(['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll']);
  });
});

describe('planLlamaAssets - archive shape', () => {
  it('uses zip on Windows and tar.gz elsewhere', () => {
    expect(ok(plan('win32', 'x64', 'cpu_x86')).assets[0].format).toBe('zip');
    expect(ok(plan('linux', 'x64', 'cpu_x86')).assets[0].format).toBe('tar.gz');
    expect(ok(plan('darwin', 'arm64', 'metal')).assets[0].format).toBe('tar.gz');
  });

  it('names the server binary with the platform extension', () => {
    expect(serverBinaryName('win32')).toBe('llama-server.exe');
    expect(serverBinaryName('linux')).toBe('llama-server');
    expect(serverBinaryName('darwin')).toBe('llama-server');
    expect(ok(plan('win32', 'x64', 'cpu_x86')).serverBinaryName).toBe('llama-server.exe');
  });

  it('tells a Windows CPU machine that a Vulkan build exists but is unreachable', () => {
    // hwfit types an Intel-GPU Windows box as cpu_x86; the CPU build is right,
    // but the user deserves to know a faster build exists that we cannot request.
    const result = ok(plan('win32', 'x64', 'cpu_x86'));
    expect(result.notes.join(' ')).toContain('Vulkan');
    expect(result.noteCodes).toContain('VULKAN_BUILD_NOT_REQUESTABLE');
  });

  it('carries the Vulkan note as a CODE, not only as English prose', () => {
    // `notes` is a developer diagnostic; 13 locales cannot render it. The code
    // is the half that can reach the screen, so it has to be there too.
    const linux = ok(plan('linux', 'x64', 'cuda'));
    expect(linux.acceleration).toBe('cpu');
    expect(linux.noteCodes).toContain('VULKAN_BUILD_NOT_REQUESTABLE');
  });

  it('does not claim a Vulkan build on macOS, where none is published', () => {
    const mac = ok(plan('darwin', 'x64', 'metal'));
    expect(mac.acceleration).toBe('cpu');
    expect(mac.noteCodes).not.toContain('VULKAN_BUILD_NOT_REQUESTABLE');
  });

  it('does not claim a Vulkan build when the release ships none for this target', () => {
    const withoutVulkan = B10437_ASSETS.filter((a) => !a.includes('vulkan'));
    const result = ok(plan('win32', 'x64', 'cpu_x86', { availableAssets: withoutVulkan }));
    expect(result.noteCodes).not.toContain('VULKAN_BUILD_NOT_REQUESTABLE');
  });
});

/**
 * Which CUDA line gets installed.
 *
 * llama.cpp ships 12.4 AND 13.3 for win/x64 in the same release. Picking the
 * newest unconditionally is a coin flip: a 13.x build on a pre-580 driver does
 * not error, it reports "Available devices: (none)", exits 0 and runs on the
 * CPU - after ~500 MB. Driver floors are NVIDIA's published minimums (CUDA 13.0
 * GA >=580.65.06, CUDA 12.0 GA >=525.60.13 / >=527.41 on Windows), and 610.62
 * is the driver measured on the reference box on 2026-08-15.
 */
describe('planLlamaAssets - the CUDA line is a driver decision', () => {
  const CUDA_12 = 'llama-b10437-bin-win-cuda-12.4-x64.zip';
  const CUDA_13 = 'llama-b10437-bin-win-cuda-13.3-x64.zip';

  it('takes the newest line when the measured driver clears its floor', () => {
    const result = ok(plan('win32', 'x64', 'cuda', { driverVersion: '610.62' }));
    expect(result.assets[0].name).toBe(CUDA_13);
    expect(result.cudaVariant).toBe('13.3');
    expect(result.noteCodes).toEqual([]);
  });

  it('drops to the older line on a driver that cannot load the newest, and says so', () => {
    // 552.22 is an r550 Windows driver: clears CUDA 12 (>=525), not CUDA 13.
    const result = ok(plan('win32', 'x64', 'cuda', { driverVersion: '552.22' }));
    expect(result.acceleration).toBe('cuda');
    expect(result.assets.map((a) => a.name)).toEqual([CUDA_12, 'cudart-llama-bin-win-cuda-12.4-x64.zip']);
    expect(result.cudaVariant).toBe('12.4');
    expect(result.noteCodes).toContain('CUDA_LINE_OLDER_FOR_DRIVER');
    expect(result.fallback).toBeNull();
  });

  it('falls back to CPU with CUDA_DRIVER_TOO_OLD when no line is loadable', () => {
    // 470.82 predates CUDA 12 entirely (floor 525), so neither line can run.
    const result = ok(plan('win32', 'x64', 'cuda', { driverVersion: '470.82' }));
    expect(result.acceleration).toBe('cpu');
    expect(result.fallback).not.toBeNull();
    expect(result.fallback.code).toBe('CUDA_DRIVER_TOO_OLD');
    expect(result.assets.map((a) => a.name)).toEqual(['llama-b10437-bin-win-cpu-x64.zip']);
  });

  it('offers the newest line when no driver was measured, but marks it unverified', () => {
    const result = ok(plan('win32', 'x64', 'cuda', { driverVersion: null }));
    expect(result.assets[0].name).toBe(CUDA_13);
    expect(result.noteCodes).toContain('CUDA_LINE_UNVERIFIED');
  });

  it('treats an unparseable driver string as not measured, not as new enough', () => {
    const result = ok(plan('win32', 'x64', 'cuda', { driverVersion: 'unknown' }));
    expect(result.noteCodes).toContain('CUDA_LINE_UNVERIFIED');
  });

  it('lets an explicit pin override the driver decision', () => {
    const result = ok(plan('win32', 'x64', 'cuda', { driverVersion: '610.62', cudaVariant: '12.4' }));
    expect(result.assets[0].name).toBe(CUDA_12);
    expect(result.cudaVariant).toBe('12.4');
    expect(result.noteCodes).toEqual([]);
  });

  it('will not silently prefer a CUDA line whose driver floor is unknown here', () => {
    // A future line with no entry in CUDA_MIN_DRIVER_MAJOR is unverifiable, not
    // safe: a known-good 13.3 must win over an unknown 14.0 on a 610 driver.
    const future = [...B10437_ASSETS, 'llama-b10437-bin-win-cuda-14.0-x64.zip'];
    const result = ok(plan('win32', 'x64', 'cuda', { driverVersion: '610.62', availableAssets: future }));
    expect(result.assets[0].name).toBe(CUDA_13);
    expect(result.noteCodes).toEqual([]);
  });

  it('uses an unknown-floor line only when nothing with a known floor is loadable', () => {
    const onlyFuture = [
      'llama-b10437-bin-win-cpu-x64.zip',
      'llama-b10437-bin-win-cuda-14.0-x64.zip',
      'cudart-llama-bin-win-cuda-14.0-x64.zip',
    ];
    const result = ok(plan('win32', 'x64', 'cuda', { driverVersion: '470.82', availableAssets: onlyFuture }));
    expect(result.assets[0].name).toBe('llama-b10437-bin-win-cuda-14.0-x64.zip');
    expect(result.noteCodes).toContain('CUDA_LINE_UNVERIFIED');
  });

  it('reports no cudaVariant for plans that are not CUDA ones', () => {
    expect(ok(plan('win32', 'x64', 'cpu_x86')).cudaVariant).toBeNull();
    expect(ok(plan('darwin', 'arm64', 'metal')).cudaVariant).toBeNull();
    expect(ok(plan('win32', 'x64', 'rocm')).cudaVariant).toBeNull();
  });
});
