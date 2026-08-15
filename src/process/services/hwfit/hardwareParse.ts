/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure parsers for hardware-probe command output.
 *
 * Every probe (nvidia-smi, WMI JSON, sysctl, rocminfo) is treated as UNTRUSTED
 * text: parsing is regex/split based, tolerates missing/garbage lines, and
 * never evals. Kept pure and side-effect-free so the parsing logic is unit
 * tested independently of the shell IO in hardwareDetect.ts.
 */

import type { DetectedGpu, HardwareBackend } from './types';

const MB_PER_GB = 1024;

/** One parsed NVIDIA GPU row (before indices are assigned). */
export type ParsedNvidiaGpu = {
  name: string;
  vramGb: number;
  /**
   * Installed driver version, e.g. "610.62". Empty when the probe did not
   * report one — which is a DIFFERENT answer from "old": it decides which CUDA
   * line llama.cpp is allowed to install, and an absent value must not be read
   * as permission to install the newest one.
   */
  driverVersion: string;
};

/**
 * Parse `nvidia-smi --query-gpu=memory.total,name,driver_version
 * --format=csv,noheader,nounits` output. Each line is "<mb>, <name>, <driver>".
 * Rows with a non-numeric memory value (unified-memory parts report "[N/A]")
 * are skipped here — the caller decides how to treat a GPU list that came back
 * empty. The third column is optional: an older probe (or a caller that asked
 * for two columns) still parses, with an empty driver version.
 */
export function parseNvidiaSmi(output: string): ParsedNvidiaGpu[] {
  if (!output) return [];
  const gpus: ParsedNvidiaGpu[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',').map((p) => p.trim());
    if (parts.length < 2) continue;
    const vramMb = Number.parseFloat(parts[0]);
    if (!Number.isFinite(vramMb) || vramMb <= 0) continue;
    const name = parts[1];
    if (!name) continue;
    gpus.push({ name, vramGb: vramMb / MB_PER_GB, driverVersion: parts[2] || '' });
  }
  return gpus;
}

/** True when nvidia-smi ran but could not talk to the driver. */
export function isNvidiaDriverError(output: string): boolean {
  const low = (output || '').toLowerCase();
  return (
    low.includes('nvml') ||
    low.includes('driver/library version mismatch') ||
    low.includes("couldn't communicate") ||
    low.includes('no devices were found') ||
    low.includes('failed to initialize')
  );
}

/** Assign sequential CUDA indices to parsed GPUs (row order = device index). */
export function withIndices(gpus: ParsedNvidiaGpu[]): DetectedGpu[] {
  return gpus.map((g, index) => ({ index, name: g.name, vramGb: round1(g.vramGb) }));
}

/** Result of parsing the Windows WMI/PowerShell JSON probe. */
export type ParsedWindowsInfo = {
  totalRamGb: number;
  availableRamGb: number;
  cpuCores: number;
  cpuName: string;
  gpuName: string | null;
  gpuVramGb: number | null;
  gpuCount: number;
  backend: HardwareBackend;
  /** NVIDIA driver version, or null when the probe did not report one. */
  gpuDriverVersion: string | null;
};

type RawWindowsJson = {
  ram_gb?: unknown;
  avail_gb?: unknown;
  cpu_name?: unknown;
  cpu_cores?: unknown;
  gpu_name?: unknown;
  gpu_vram_gb?: unknown;
  gpu_count?: unknown;
  gpu_backend?: unknown;
  gpu_driver?: unknown;
};

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number.parseFloat(value) : (value as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * Parse the compact JSON emitted by the Windows PowerShell hardware probe.
 * Returns null on any parse failure or when RAM comes back as 0 (a definitive
 * "probe failed" signal), so the caller can fall back gracefully.
 */
export function parseWindowsProbe(output: string): ParsedWindowsInfo | null {
  if (!output) return null;
  let raw: RawWindowsJson;
  try {
    raw = JSON.parse(output) as RawWindowsJson;
  } catch {
    return null;
  }
  const totalRamGb = round1(asNumber(raw.ram_gb, 0));
  if (totalRamGb <= 0) return null;

  const gpuNameRaw = asString(raw.gpu_name, '');
  const gpuName = gpuNameRaw || null;
  const backendRaw = asString(raw.gpu_backend, 'cpu_x86');
  const backend: HardwareBackend = backendRaw === 'cuda' ? 'cuda' : 'cpu_x86';

  return {
    totalRamGb,
    availableRamGb: round1(asNumber(raw.avail_gb, totalRamGb * 0.7)),
    cpuCores: Math.max(1, Math.trunc(asNumber(raw.cpu_cores, 1))),
    cpuName: asString(raw.cpu_name, 'unknown'),
    gpuName,
    gpuVramGb: gpuName ? round1(asNumber(raw.gpu_vram_gb, 0)) : null,
    gpuCount: Math.max(0, Math.trunc(asNumber(raw.gpu_count, gpuName ? 1 : 0))),
    backend,
    gpuDriverVersion: asString(raw.gpu_driver, '') || null,
  };
}

/**
 * Compute the usable Apple-Silicon GPU (Metal) budget from total unified RAM.
 * macOS lets Metal use most of unified memory but keeps more back on small
 * machines; these fractions track Apple's recommendedMaxWorkingSetSize defaults.
 */
export function appleMetalBudgetGb(totalGb: number): number {
  if (totalGb <= 0) return 0;
  let frac: number;
  if (totalGb <= 16) frac = 0.67;
  else if (totalGb <= 64) frac = 0.75;
  else frac = 0.8;
  return round1(totalGb * frac);
}

/** Parse `sysctl -n hw.memsize` (bytes) into GB. Returns 0 on failure. */
export function parseSysctlBytes(output: string): number {
  const n = Number.parseInt((output || '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / 1024 ** 3;
}

/**
 * Classify an AMD ISA target (e.g. "gfx1200") into a family. Drives the serving
 * decision: consumer RDNA => GGUF/llama.cpp; datacenter CDNA => vLLM-capable.
 */
export function classifyAmdGfx(gfx: string): { gfx: string; family: 'rdna' | 'cdna' | 'gcn' | 'unknown' } {
  const g = (gfx || '').toLowerCase().trim();
  const m = /^gfx(\d+[a-f]?)$/.exec(g);
  if (!m) return { gfx: '', family: 'unknown' };
  const digits = m[1];
  const two = digits.slice(0, 2);
  if (two === '10' || two === '11' || two === '12') return { gfx: g, family: 'rdna' };
  if (digits === '908' || digits === '90a' || two === '94' || two === '95') return { gfx: g, family: 'cdna' };
  if (digits.startsWith('9')) return { gfx: g, family: 'gcn' };
  return { gfx: g, family: 'unknown' };
}

/** Extract the first gfx target from rocminfo output. */
export function parseRocmGfx(output: string): string {
  const m = /gfx\d+[a-f]?/.exec(output || '');
  return m ? m[0] : '';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
