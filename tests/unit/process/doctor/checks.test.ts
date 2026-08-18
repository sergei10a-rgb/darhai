import { describe, it, expect } from 'vitest';
import {
  checkBuiltinMcp,
  checkBunRuntime,
  checkDiskSpace,
  checkFfmpeg,
  checkLlamaRuntime,
  checkMemoryIndex,
  checkMongolVoice,
  checkOmniroute,
  type DoctorTranslate,
} from '@process/doctor/checks';

/** Identity translator: assertions target keys, not translated copy. */
const t: DoctorTranslate = (key, options) => (options ? `${key}|${JSON.stringify(options)}` : key);

describe('checkBunRuntime', () => {
  it('passes when the bundled bun binary resolves and exists', () => {
    const out = checkBunRuntime({
      resolveRuntime: () => ({ command: 'C:/app/resources/bundled-bun/win32-x64/bun.exe' }),
      fileExists: () => true,
      t,
    });
    expect(out.status).toBe('pass');
    expect(out.detail).toContain('settings.doctor.checks.bun.ok');
  });

  it('warns when the runtime fell back to node (no bundled bun)', () => {
    const out = checkBunRuntime({ resolveRuntime: () => ({ command: 'node' }), fileExists: () => true, t });
    expect(out.status).toBe('warn');
    expect(out.detail).toBe('settings.doctor.checks.bun.fallback');
    expect(out.remediation).toBe('settings.doctor.checks.bun.fallbackFix');
  });

  it('fails when a resolved bun path does not exist on disk', () => {
    const out = checkBunRuntime({ resolveRuntime: () => ({ command: 'C:/gone/bun.exe' }), fileExists: () => false, t });
    expect(out.status).toBe('fail');
    expect(out.remediation).toBeDefined();
  });
});

describe('checkBuiltinMcp', () => {
  it('passes with the enabled/total counts when builtin servers are enabled', async () => {
    const out = await checkBuiltinMcp({
      listServers: async () => [
        { builtin: true, enabled: true, name: 'a' },
        { builtin: true, enabled: false, name: 'b' },
        { builtin: false, enabled: true, name: 'user-added' },
      ],
      t,
    });
    expect(out.status).toBe('pass');
    expect(out.detail).toContain('"enabled":1');
    expect(out.detail).toContain('"total":2');
  });

  it('warns when no builtin server is registered at all', async () => {
    const out = await checkBuiltinMcp({ listServers: async () => [{ builtin: false, enabled: true }], t });
    expect(out.status).toBe('warn');
    expect(out.detail).toBe('settings.doctor.checks.mcp.none');
  });

  it('warns when every builtin server is disabled', async () => {
    const out = await checkBuiltinMcp({
      listServers: async () => [
        { builtin: true, enabled: false },
        { builtin: true, enabled: false },
      ],
      t,
    });
    expect(out.status).toBe('warn');
    expect(out.detail).toContain('settings.doctor.checks.mcp.disabled');
  });
});

describe('checkLlamaRuntime', () => {
  it('warns (not fails) when nothing is installed - the runtime is optional', () => {
    const out = checkLlamaRuntime({ listTags: () => [], isTagInstalled: () => false, t });
    expect(out.status).toBe('warn');
  });

  it('fails when the newest tag has a broken receipt', () => {
    const out = checkLlamaRuntime({ listTags: () => ['b6000', 'b5000'], isTagInstalled: (tag) => tag !== 'b6000', t });
    expect(out.status).toBe('fail');
    expect(out.detail).toContain('b6000');
  });

  it('passes when the newest tag verifies', () => {
    const out = checkLlamaRuntime({ listTags: () => ['b6000'], isTagInstalled: () => true, t });
    expect(out.status).toBe('pass');
  });
});

describe('checkMongolVoice', () => {
  const state = (installed: boolean, supported = true) => ({ installed, supported });

  it('passes when all three supported components are installed', () => {
    const out = checkMongolVoice({
      status: () => ({ 'stt-runtime': state(true), 'stt-model': state(true), 'tts-bundle': state(true) }),
      t,
    });
    expect(out.status).toBe('pass');
    expect(out.detail).toContain('"installed":3');
  });

  it('warns and names the missing components on a partial install', () => {
    const out = checkMongolVoice({
      status: () => ({ 'stt-runtime': state(true), 'stt-model': state(false), 'tts-bundle': state(false) }),
      t,
    });
    expect(out.status).toBe('warn');
    expect(out.detail).toContain('stt-model, tts-bundle');
  });

  it('warns without a remediation when the platform supports no component', () => {
    const out = checkMongolVoice({
      status: () => ({ 'stt-runtime': state(false, false), 'stt-model': state(false, false) }),
      t,
    });
    expect(out.status).toBe('warn');
    expect(out.detail).toBe('settings.doctor.checks.voice.unsupported');
    expect(out.remediation).toBeUndefined();
  });
});

describe('checkFfmpeg', () => {
  it('passes with the resolved path', () => {
    const out = checkFfmpeg({ resolveBinary: () => 'C:/tools/ffmpeg.exe', t });
    expect(out.status).toBe('pass');
  });

  it('warns when ffmpeg is not on PATH', () => {
    const out = checkFfmpeg({ resolveBinary: () => null, t });
    expect(out.status).toBe('warn');
    expect(out.remediation).toBe('settings.doctor.checks.ffmpeg.missingFix');
  });
});

describe('checkOmniroute', () => {
  it('passes when the gateway answers the health probe', async () => {
    const out = await checkOmniroute({
      getState: () => 'idle',
      probe: async () => ({ ok: true, modelCount: 12 }),
      t,
    });
    expect(out.status).toBe('pass');
    expect(out.detail).toContain('"models":12');
  });

  it('fails when our own child claims to run but the port does not answer', async () => {
    const out = await checkOmniroute({
      getState: () => 'running',
      probe: async () => ({ ok: false, error: 'unreachable' }),
      t,
    });
    expect(out.status).toBe('fail');
  });

  it('warns when the gateway is simply not running (optional subsystem)', async () => {
    const out = await checkOmniroute({
      getState: () => 'idle',
      probe: async () => ({ ok: false, error: 'unreachable' }),
      t,
    });
    expect(out.status).toBe('warn');
  });
});

describe('checkMemoryIndex', () => {
  it('passes with the entry/project counts when the index has content', () => {
    const out = checkMemoryIndex({ indexStats: () => ({ total: 12, projects: 3 }), t });
    expect(out.status).toBe('pass');
    expect(out.detail).toContain('settings.doctor.checks.memory.ok');
    expect(out.detail).toContain('"total":12');
  });

  it('warns (never a false pass) when the index reports 0 entries - empty OR simply not initialized (M2)', () => {
    // An un-initialized singleton answers { total: 0 } exactly like a healthy
    // empty index; the check cannot tell them apart, so "pass" would be a lie.
    const out = checkMemoryIndex({ indexStats: () => ({ total: 0, projects: 0 }), t });
    expect(out.status).toBe('warn');
    expect(out.detail).toBe('settings.doctor.checks.memory.empty');
    expect(out.remediation).toBe('settings.doctor.checks.memory.emptyFix');
  });
});

describe('checkDiskSpace', () => {
  const GIB = 1024 * 1024 * 1024;

  it('fails below 1 GiB free', async () => {
    const out = await checkDiskSpace({ freeBytes: async () => 0.5 * GIB, t });
    expect(out.status).toBe('fail');
  });

  it('warns below 5 GiB free', async () => {
    const out = await checkDiskSpace({ freeBytes: async () => 3 * GIB, t });
    expect(out.status).toBe('warn');
    expect(out.detail).toContain('"freeGb":3');
  });

  it('passes with plenty of space', async () => {
    const out = await checkDiskSpace({ freeBytes: async () => 120 * GIB, t });
    expect(out.status).toBe('pass');
  });

  it('warns (cannot verify) when the probe itself throws', async () => {
    const out = await checkDiskSpace({
      freeBytes: async () => {
        throw new Error('statfs unsupported');
      },
      t,
    });
    expect(out.status).toBe('warn');
    expect(out.detail).toBe('settings.doctor.checks.disk.unknown');
  });
});
