/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hardware detection for the model advisor.
 *
 * Every shell probe goes through Darhai's `safeExecFile` (argv array, NO shell)
 * so untrusted GPU names never reach a shell interpreter — there is no command
 * injection surface. Each probe is timeout-capped; any failure (missing binary,
 * driver error, parse failure) degrades gracefully to a CPU/RAM-only profile
 * rather than throwing. The result is cached briefly so filter changes in the
 * UI don't re-probe the rig on every keystroke.
 */

import os from 'node:os';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { safeExecFile } from '@process/utils/safeExec';
import type { DetectedGpu, HardwareBackend, HardwarePlatform, HardwareProfile } from './types';
import {
  appleMetalBudgetGb,
  classifyAmdGfx,
  isNvidiaDriverError,
  parseNvidiaSmi,
  parseRocmGfx,
  parseSysctlBytes,
  parseWindowsProbe,
  withIndices,
} from './hardwareParse';

const PROBE_TIMEOUT_MS = 8000;
const WINDOWS_PROBE_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 60_000;

/** nvidia-smi absolute-path candidates for hosts with a minimal PATH / WSL. */
const NVIDIA_PATH_CANDIDATES: readonly string[] = [
  '/usr/bin/nvidia-smi',
  '/usr/local/cuda/bin/nvidia-smi',
  '/usr/lib/wsl/lib/nvidia-smi',
];

/**
 * `driver_version` is queried alongside the memory/name pair because the
 * llama.cpp provisioner has to choose between the CUDA 12.x and 13.x builds of
 * the same release, and that choice is a driver fact: a 13.x build on a pre-580
 * driver reports "Available devices: (none)", exits 0, and runs on the CPU.
 * Measured on the reference box (2026-08-15): `8188, NVIDIA GeForce RTX 4070
 * Laptop GPU, 610.62`. Same single spawn - one more column, no extra probe.
 */
const NVIDIA_QUERY_ARGS = ['--query-gpu=memory.total,name,driver_version', '--format=csv,noheader,nounits'];

let cache: { ts: number; profile: HardwareProfile } | null = null;

/**
 * In-flight probe promise. When a scan is running, concurrent (non-fresh)
 * callers await the SAME promise instead of each spawning their own host probe
 * — without this, N simultaneous rank passes fan out into N nvidia-smi /
 * PowerShell spawns because the cache is only written AFTER the probe resolves.
 */
let inflight: Promise<HardwareProfile> | null = null;

/** Run an executable via safeExecFile, returning stdout or null on any failure. */
async function tryExec(file: string, args: string[], timeout = PROBE_TIMEOUT_MS): Promise<string | null> {
  try {
    const { stdout } = await safeExecFile(file, args, { timeout });
    return stdout;
  } catch {
    return null;
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function currentPlatform(): HardwarePlatform {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

function cpuInfo(): { cpuName: string; cpuCores: number } {
  const cpus = os.cpus();
  const cpuName = cpus[0]?.model?.trim() || 'unknown';
  const cpuCores = cpus.length || 1;
  return { cpuName, cpuCores };
}

function totalRamGb(): number {
  return round1(os.totalmem() / 1024 ** 3);
}

function availableRamGb(): number {
  return round1(os.freemem() / 1024 ** 3);
}

/** A detected GPU pool, or null when the probe found nothing/failed. */
type GpuDetection = {
  gpuName: string;
  gpuVramGb: number;
  gpuCount: number;
  gpus: DetectedGpu[];
  backend: HardwareBackend;
  gpuFamily?: string;
  unifiedMemory?: boolean;
  /** NVIDIA driver version when the probe stated one, else null. */
  gpuDriverVersion?: string | null;
};

/** Detect NVIDIA GPUs via nvidia-smi (PATH first, then absolute candidates). */
async function detectNvidia(): Promise<{ detection: GpuDetection | null; error: string | null }> {
  let out = await tryExec('nvidia-smi', NVIDIA_QUERY_ARGS);
  if (!out) {
    // Sequential on purpose: try each fallback path only if the previous one
    // produced nothing, and stop at the first that succeeds. Running these in
    // parallel would spawn redundant probes for a machine with one GPU.
    for (const candidate of NVIDIA_PATH_CANDIDATES) {
      if (!existsSync(candidate)) continue;
      // eslint-disable-next-line no-await-in-loop
      out = await tryExec(candidate, NVIDIA_QUERY_ARGS);
      if (out) break;
    }
  }
  if (!out) return { detection: null, error: null };

  if (isNvidiaDriverError(out)) {
    const firstLine = out.trim().split('\n')[0]?.slice(0, 140) || 'NVIDIA driver error';
    return { detection: null, error: firstLine };
  }

  const parsed = parseNvidiaSmi(out);
  if (parsed.length === 0) return { detection: null, error: null };

  const gpus = withIndices(parsed);
  const totalVram = round1(gpus.reduce((sum, g) => sum + g.vramGb, 0));
  return {
    detection: {
      gpuName: gpus[0].name,
      gpuVramGb: totalVram,
      gpuCount: gpus.length,
      gpus,
      backend: 'cuda',
      gpuDriverVersion: parsed[0].driverVersion || null,
    },
    error: null,
  };
}

/** Detect AMD GPUs on Linux via /sys DRM entries + rocminfo family. */
async function detectAmd(): Promise<GpuDetection | null> {
  if (process.platform !== 'linux') return null;
  // Read the DRM card list; every read is guarded so a missing sysfs node is
  // simply skipped rather than throwing.
  const readOr = (p: string): string | null => {
    try {
      return readFileSync(p, { encoding: 'utf-8' }).trim();
    } catch {
      return null;
    }
  };

  let cardEntries: string[];
  try {
    cardEntries = readdirSync('/sys/class/drm').filter((e) => e.startsWith('card') && !e.includes('-'));
  } catch {
    return null;
  }

  const cards: DetectedGpu[] = [];
  let index = 0;
  for (const entry of cardEntries) {
    const base = `/sys/class/drm/${entry}/device`;
    if (readOr(`${base}/vendor`) !== '0x1002') continue;
    const vram = Number.parseInt(readOr(`${base}/mem_info_vram_total`) || '', 10);
    const vis = Number.parseInt(readOr(`${base}/mem_info_vis_vram_total`) || '', 10);
    const gtt = Number.parseInt(readOr(`${base}/mem_info_gtt_total`) || '', 10);
    let vramBytes = Math.max(Number.isFinite(vram) ? vram : 0, Number.isFinite(vis) ? vis : 0);
    if (vramBytes <= 0) vramBytes = Number.isFinite(gtt) ? gtt : 0;
    if (vramBytes <= 0) continue;
    const name = readOr(`${base}/product_name`) || `AMD GPU (${entry})`;
    cards.push({ index: index++, name, vramGb: round1(vramBytes / 1024 ** 3) });
  }

  if (cards.length === 0) return null;
  const rocmOut = (await tryExec('rocminfo', [])) || (await tryExec('/opt/rocm/bin/rocminfo', [])) || '';
  const { family } = classifyAmdGfx(parseRocmGfx(rocmOut));
  return {
    gpuName: cards[0].name,
    gpuVramGb: round1(cards.reduce((sum, c) => sum + c.vramGb, 0)),
    gpuCount: cards.length,
    gpus: cards,
    backend: 'rocm',
    gpuFamily: family,
    unifiedMemory: false,
  };
}

/** Detect Apple Silicon (Metal) via sysctl. macOS + arm64 only. */
async function detectAppleSilicon(): Promise<GpuDetection | null> {
  if (process.platform !== 'darwin') return null;
  if (process.arch !== 'arm64') return null;

  const brand = (await tryExec('sysctl', ['-n', 'machdep.cpu.brand_string']))?.trim() || 'Apple Silicon';
  const memOut = await tryExec('sysctl', ['-n', 'hw.memsize']);
  const totalGb = parseSysctlBytes(memOut || '');
  if (totalGb <= 0) return null;

  let vramGb = appleMetalBudgetGb(totalGb);
  const wired = await tryExec('sysctl', ['-n', 'iogpu.wired_limit_mb']);
  const wiredMb = Number.parseInt((wired || '').trim(), 10);
  if (Number.isFinite(wiredMb) && wiredMb > 0) vramGb = round1(wiredMb / 1024);

  const gpu: DetectedGpu = { index: 0, name: brand, vramGb };
  return {
    gpuName: brand,
    gpuVramGb: vramGb,
    gpuCount: 1,
    gpus: [gpu],
    backend: 'metal',
    unifiedMemory: true,
  };
}

/**
 * Single PowerShell/WMI probe for Windows: RAM, CPU, GPU (nvidia-smi first,
 * WMI Win32_VideoController fallback). Uses safeExecFile (argv, no shell); the
 * PowerShell payload is a constant string with no interpolated input.
 */
const WINDOWS_PS_PROBE = `
$r = @{}
$os = Get-CimInstance Win32_OperatingSystem
$r.ram_gb = [math]::Round($os.TotalVisibleMemorySize / 1048576, 1)
$r.avail_gb = [math]::Round($os.FreePhysicalMemory / 1048576, 1)
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$r.cpu_name = $cpu.Name
$r.cpu_cores = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
try {
  $nv = nvidia-smi --query-gpu=memory.total,name,driver_version --format=csv,noheader,nounits 2>$null
  if ($LASTEXITCODE -eq 0 -and $nv) {
    $gpus = @()
    foreach ($line in $nv -split "\`n") {
      $p = $line -split ','
      if ($p.Count -ge 2) {
        $drv = ''
        if ($p.Count -ge 3) { $drv = $p[2].Trim() }
        $gpus += [pscustomobject]@{name = $p[1].Trim(); vram_mb = [double]$p[0].Trim(); driver = $drv }
      }
    }
    $r.gpu_name = $gpus[0].name
    $r.gpu_vram_gb = [math]::Round(($gpus | Measure-Object -Property vram_mb -Sum).Sum / 1024, 1)
    $r.gpu_count = $gpus.Count
    $r.gpu_backend = 'cuda'
    $r.gpu_driver = $gpus[0].driver
  }
} catch {}
if (-not $r.gpu_name) {
  $wmiGpu = Get-CimInstance Win32_VideoController | Where-Object { $_.AdapterRAM -gt 0 } | Select-Object -First 1
  if ($wmiGpu) {
    $r.gpu_name = $wmiGpu.Name
    $r.gpu_vram_gb = [math]::Round($wmiGpu.AdapterRAM / 1073741824, 1)
    $r.gpu_count = 1
    $r.gpu_backend = 'cpu_x86'
  }
}
$r | ConvertTo-Json -Compress
`;

function powershellExe(): string {
  // pwsh (PS7) is not guaranteed on PATH for safeExecFile; the built-in
  // Windows PowerShell is always present at this name.
  return 'powershell.exe';
}

async function detectWindows(): Promise<HardwareProfile | null> {
  const out = await tryExec(
    powershellExe(),
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PS_PROBE],
    WINDOWS_PROBE_TIMEOUT_MS
  );
  const parsed = parseWindowsProbe(out || '');
  if (!parsed) return null;

  const gpus: DetectedGpu[] =
    parsed.gpuName && parsed.gpuCount > 0
      ? Array.from({ length: parsed.gpuCount }, (_, i) => ({
          index: i,
          name: parsed.gpuName as string,
          vramGb: round1((parsed.gpuVramGb || 0) / parsed.gpuCount),
        }))
      : [];

  return {
    totalRamGb: parsed.totalRamGb,
    availableRamGb: parsed.availableRamGb,
    cpuCores: parsed.cpuCores,
    cpuName: parsed.cpuName,
    hasGpu: Boolean(parsed.gpuName),
    gpuName: parsed.gpuName,
    gpuVramGb: parsed.gpuVramGb,
    gpuCount: parsed.gpuCount,
    gpus,
    backend: parsed.backend,
    platform: 'windows',
    gpuError: null,
    gpuDriverVersion: parsed.gpuDriverVersion,
  };
}

/** Build a CPU/RAM-only profile (no GPU). Never throws. */
function cpuOnlyProfile(gpuError: string | null): HardwareProfile {
  const { cpuName, cpuCores } = cpuInfo();
  const backend: HardwareBackend = process.arch === 'arm64' || process.arch === 'arm' ? 'cpu_arm' : 'cpu_x86';
  return {
    totalRamGb: totalRamGb(),
    availableRamGb: availableRamGb(),
    cpuCores,
    cpuName,
    hasGpu: false,
    gpuName: null,
    gpuVramGb: null,
    gpuCount: 0,
    gpus: [],
    backend,
    platform: currentPlatform(),
    gpuError,
  };
}

/** Run the actual host probes and compose a profile. Never throws. */
async function probeHardware(): Promise<HardwareProfile> {
  try {
    if (process.platform === 'win32') {
      return (await detectWindows()) ?? cpuOnlyProfile(null);
    }
    const apple = await detectAppleSilicon();
    if (apple) {
      return fromGpuDetection(apple);
    }
    const { detection, error } = await detectNvidia();
    const gpu = detection ?? (await detectAmd());
    return gpu ? fromGpuDetection(gpu) : cpuOnlyProfile(error);
  } catch (err) {
    // Defensive: no probe should throw past its own guard, but never let an
    // unexpected error crash the advisor — degrade to CPU/RAM-only.
    const message = err instanceof Error ? err.message : String(err);
    return cpuOnlyProfile(message.slice(0, 140));
  }
}

/**
 * Scan the host hardware and return a profile the ranker can score against.
 * Cached for {@link CACHE_TTL_MS}; pass `fresh` to bypass the cache (the UI's
 * "Rescan" button). Always resolves — a probe failure yields a CPU/RAM-only
 * profile, never a rejection.
 *
 * Concurrent (non-fresh) callers share a single in-flight probe: the cache is
 * only written once the probe resolves, so without deduplication N parallel
 * `rankModels` invocations would each spawn their own host probe. `fresh=true`
 * always runs a probe (the UI's explicit Rescan) but still joins/refreshes the
 * shared in-flight slot so a burst of rescans collapses to one probe.
 */
export async function scanHardware(fresh = false): Promise<HardwareProfile> {
  const now = Date.now();
  if (!fresh && cache && now - cache.ts < CACHE_TTL_MS) {
    return cache.profile;
  }

  // Join an already-running probe rather than spawning a redundant one.
  if (inflight) {
    return inflight;
  }

  const run = (async (): Promise<HardwareProfile> => {
    const profile = await probeHardware();
    cache = { ts: Date.now(), profile };
    return profile;
  })();

  inflight = run;
  try {
    return await run;
  } finally {
    // Clear the slot only if it is still ours (a later fresh scan may have
    // replaced it); a subsequent call then starts a new probe or hits the cache.
    if (inflight === run) {
      inflight = null;
    }
  }
}

/** Compose a full profile from a GPU detection + os CPU/RAM info. */
function fromGpuDetection(gpu: GpuDetection): HardwareProfile {
  const { cpuName, cpuCores } = cpuInfo();
  return {
    totalRamGb: totalRamGb(),
    availableRamGb: availableRamGb(),
    cpuCores,
    cpuName,
    hasGpu: true,
    gpuName: gpu.gpuName,
    gpuVramGb: gpu.gpuVramGb,
    gpuCount: gpu.gpuCount,
    gpus: gpu.gpus,
    backend: gpu.backend,
    platform: currentPlatform(),
    gpuFamily: gpu.gpuFamily,
    unifiedMemory: gpu.unifiedMemory,
    gpuError: null,
    gpuDriverVersion: gpu.gpuDriverVersion === undefined ? null : gpu.gpuDriverVersion,
  };
}

/** Clear the cache and any in-flight probe (test helper / forced rescan path). */
export function clearHardwareCache(): void {
  cache = null;
  inflight = null;
}
