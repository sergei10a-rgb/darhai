/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Doctor check registry — wires each pure check (checks.ts) to Darhai's real
 * subsystems and returns the ordered {@link DoctorCheck} list the runner
 * executes.
 *
 * This is the ONLY doctor module that reaches into live singletons; the
 * checks themselves stay dependency-injected and unit-testable. Everything
 * here only READS other subsystems through their public APIs.
 *
 * Two hard-won upstream rules are kept:
 *  - config is read via `ProcessConfig`, never `ConfigStorage`: a bridge
 *    round-trip from inside a bridge provider (`doctor.run`) would deadlock on
 *    reentrancy and collapse into an opaque per-check timeout;
 *  - every dependency is bound lazily inside `run()`, so a broken subsystem
 *    import cannot prevent the OTHER checks from running.
 */

import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { getPlatformServices } from '@/common/platform';
import type { IMcpServer } from '@/common/config/storage';
import { OMNIROUTE_RUNTIME_PORT } from '@/common/types/omnirouteGateway';
import i18n from '@process/services/i18n';
import { isInstalled, listInstalledTags } from '@process/services/llamacpp';
import { getIjfwArchiveService } from '@process/services/memory/ijfwArchiveService';
import { testOmnirouteGatewayConnection } from '@process/services/omnirouteGateway/omnirouteGatewayService';
import { omnirouteRuntime } from '@process/services/omnirouteGateway/omnirouteRuntimeSingleton';
import { MongolVoiceProvisioner } from '@process/services/voice/mongol/MongolVoiceProvisioner';
import { resolveFfmpegBinary } from '@process/services/video/videoFrames';
import { resolveBuiltinMcpRuntime } from '@process/utils/builtinMcpRuntime';
import { ProcessConfig } from '@process/utils/initStorage';
import {
  checkBuiltinMcp,
  checkBunRuntime,
  checkDiskSpace,
  checkFfmpeg,
  checkLlamaRuntime,
  checkMemoryIndex,
  checkMongolVoice,
  type DoctorTranslate,
} from './checks';
import { checkOmniroute } from './checks';
import type { DoctorCheck } from './types';

/** The main-process translator, narrowed to the doctor's needs. */
const t: DoctorTranslate = (key, options) => i18n.t(key, options ?? {});

/** The app's per-user data directory (voice + llama.cpp install roots). */
function dataDir(): string {
  return getPlatformServices().paths.getDataDir();
}

/** Free bytes on the volume that holds the app's data directory. */
async function freeBytesUnderDataDir(): Promise<number> {
  const stats = await statfs(dataDir());
  return Number(stats.bavail) * Number(stats.bsize);
}

/**
 * Build the full ordered check list. Called per run so every check observes
 * the CURRENT state (a freshly installed runtime shows up without a restart).
 */
export function buildDoctorChecks(): DoctorCheck[] {
  return [
    {
      id: 'runtime.bun',
      titleKey: 'settings.doctor.checks.bun.title',
      category: 'runtime',
      run: async () =>
        checkBunRuntime({ resolveRuntime: resolveBuiltinMcpRuntime, fileExists: (path) => existsSync(path), t }),
    },
    {
      id: 'runtime.ffmpeg',
      titleKey: 'settings.doctor.checks.ffmpeg.title',
      category: 'runtime',
      run: async () => checkFfmpeg({ resolveBinary: resolveFfmpegBinary, t }),
    },
    {
      id: 'services.builtinMcp',
      titleKey: 'settings.doctor.checks.mcp.title',
      category: 'services',
      run: () =>
        checkBuiltinMcp({
          listServers: async () => ((await ProcessConfig.get('mcp.config')) ?? []) as IMcpServer[],
          t,
        }),
    },
    {
      id: 'services.omniroute',
      titleKey: 'settings.doctor.checks.omniroute.title',
      category: 'services',
      run: () =>
        checkOmniroute({
          getState: () => omnirouteRuntime.getStatus().state,
          probe: () => testOmnirouteGatewayConnection(`http://localhost:${OMNIROUTE_RUNTIME_PORT}`),
          t,
        }),
    },
    {
      id: 'models.llamacpp',
      titleKey: 'settings.doctor.checks.llama.title',
      category: 'models',
      run: async () =>
        checkLlamaRuntime({
          listTags: () => listInstalledTags(dataDir()),
          isTagInstalled: (tag) => isInstalled(dataDir(), tag),
          t,
        }),
    },
    {
      id: 'models.mongolVoice',
      titleKey: 'settings.doctor.checks.voice.title',
      category: 'models',
      run: async () => checkMongolVoice({ status: () => new MongolVoiceProvisioner(dataDir()).status(), t }),
    },
    {
      id: 'system.memoryIndex',
      titleKey: 'settings.doctor.checks.memory.title',
      category: 'system',
      run: async () => checkMemoryIndex({ indexStats: () => getIjfwArchiveService().indexStats(), t }),
    },
    {
      id: 'system.diskSpace',
      titleKey: 'settings.doctor.checks.disk.title',
      category: 'system',
      run: () => checkDiskSpace({ freeBytes: freeBytesUnderDataDir, t }),
    },
  ];
}
