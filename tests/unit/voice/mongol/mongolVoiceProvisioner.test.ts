/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  MongolVoiceProvisioner,
  type MongolVoiceDeps,
  type MongolVoiceProgress,
} from '@process/services/voice/mongol/MongolVoiceProvisioner';
import type { MongolVoiceProvisionError } from '@process/services/voice/mongol/MongolVoiceProvisioner';
import { STT_SERVER_RELPATH, type MongolVoicePinnedAsset } from '@process/services/voice/mongol/manifest';
import {
  VOICE_RECEIPT_NAME,
  componentInstallDir,
  isSttModelInstalled,
  isVoiceComponentInstalled,
  sttModelPath,
  voiceDownloadsDir,
  voiceStagingDir,
} from '@process/services/voice/mongol/installLayout';

let work: string;
let userData: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'darhai-mn-voice-prov-'));
  userData = path.join(work, 'userData');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Build a zip with JSZip - a different implementation than the reader under test. */
async function makeZip(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** A pinned asset whose sha256 matches `body`, so the fixture verifies like the real thing. */
function pinnedAsset(
  component: MongolVoicePinnedAsset['component'],
  body: Buffer,
  overrides: Partial<MongolVoicePinnedAsset> = {}
): MongolVoicePinnedAsset {
  const format = overrides.format === undefined ? 'zip' : overrides.format;
  const name = `${component}-test.${format === 'zip' ? 'zip' : 'gguf'}`;
  return {
    component,
    tag: `${component}-test-tag`,
    url: `https://example.invalid/${name}`,
    sha256: sha256(body),
    bytes: body.length,
    format,
    ...overrides,
  };
}

/** Serve asset bodies by URL suffix, recording every request and its Range header. */
function stubFetch(bodies: Record<string, Buffer>) {
  const requests: { url: string; range: string | null }[] = [];
  const fetchStub: typeof globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers((init?.headers as HeadersInit) || {});
    const range = headers.get('range');
    requests.push({ url, range });
    const found = Object.entries(bodies).find(([name]) => url.endsWith(name));
    if (!found) return new Response('not found', { status: 404 });
    let body = found[1];
    let status = 200;
    if (range) {
      const start = Number.parseInt(/bytes=(\d+)-/.exec(range)?.[1] || '0', 10);
      body = body.subarray(start);
      status = 206;
    }
    return new Response(new Uint8Array(body), { status });
  }) as typeof globalThis.fetch;
  return { fetchStub, requests };
}

/** A provisioner on a supported platform by default, wired to fakes. */
function makeProvisioner(deps: Partial<MongolVoiceDeps>): MongolVoiceProvisioner {
  return new MongolVoiceProvisioner(userData, { platform: 'win32', arch: 'x64', ...deps });
}

/** The body of a valid TTS bundle zip, entry file included. */
const BUNDLE_MANIFEST = {
  name: 'kitten-mn-tts',
  version: 1,
  api: 'kitten-v1',
  entry: 'python/python.exe',
  args: ['service/server.py', '--onnx', '--port', '{port}'],
  healthPath: '/api/status',
  speakPath: '/api/speak',
};

describe('MongolVoiceProvisioner - refusals before the network', () => {
  it('refuses an unpinned hash before any network call', async () => {
    const body = await makeZip({ [STT_SERVER_RELPATH]: 'SERVER' });
    const fetchSpy = vi.fn();
    const provisioner = makeProvisioner({
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      assets: [pinnedAsset('stt-runtime', body, { sha256: '' })],
    });

    await expect(provisioner.install('stt-runtime')).rejects.toThrow(/VOICE_HASH_UNPINNED/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('refuses an unsupported platform before any network call', async () => {
    const body = await makeZip({ [STT_SERVER_RELPATH]: 'SERVER' });
    const fetchSpy = vi.fn();
    const provisioner = makeProvisioner({
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      assets: [pinnedAsset('stt-runtime', body)],
      platform: 'darwin',
      arch: 'arm64',
    });

    await expect(provisioner.install('stt-runtime')).rejects.toThrow(/VOICE_PLATFORM_UNSUPPORTED/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('refuses a pre-aborted signal before any network call', async () => {
    const body = await makeZip({ [STT_SERVER_RELPATH]: 'SERVER' });
    const fetchSpy = vi.fn();
    const provisioner = makeProvisioner({
      fetch: fetchSpy as unknown as typeof globalThis.fetch,
      assets: [pinnedAsset('stt-runtime', body)],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(provisioner.install('stt-runtime', controller.signal)).rejects.toThrow(/VOICE_CANCELLED/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('reports no in-flight install to cancel when idle', () => {
    expect(makeProvisioner({}).cancel('stt-runtime')).toBe(false);
  });
});

describe('MongolVoiceProvisioner - integrity', () => {
  it('deletes a payload whose hash does not match and fails with a typed code', async () => {
    const body = await makeZip({ [STT_SERVER_RELPATH]: 'SERVER' });
    // Pin a digest the served bytes cannot match.
    const asset = pinnedAsset('stt-runtime', body, { sha256: 'a'.repeat(64) });
    const { fetchStub } = stubFetch({ 'stt-runtime-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });

    let err: MongolVoiceProvisionError | null = null;
    try {
      await provisioner.install('stt-runtime');
    } catch (e) {
      err = e as MongolVoiceProvisionError;
    }

    expect(err).not.toBeNull();
    expect(err.code).toBe('VOICE_HASH_MISMATCH');
    expect(err.message).toContain(sha256(body));
    // The corrupt file is gone, so the next attempt starts clean instead of
    // re-verifying (or resuming) corruption forever.
    expect(existsSync(path.join(voiceDownloadsDir(userData), 'stt-runtime-test.zip'))).toBe(false);
    expect(isVoiceComponentInstalled(userData, 'stt-runtime', asset.tag)).toBe(false);
  });
});

describe('MongolVoiceProvisioner - zip install (stt-runtime)', () => {
  it('downloads, verifies, extracts and installs through the real zip reader', async () => {
    const body = await makeZip({ [STT_SERVER_RELPATH]: 'FAKE SERVER', 'README.txt': 'DOCS' });
    const asset = pinnedAsset('stt-runtime', body);
    const { fetchStub, requests } = stubFetch({ 'stt-runtime-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });

    await provisioner.install('stt-runtime');

    expect(isVoiceComponentInstalled(userData, 'stt-runtime', asset.tag)).toBe(true);
    const installDir = componentInstallDir(userData, 'stt-runtime', asset.tag);
    expect(await readFile(path.join(installDir, STT_SERVER_RELPATH), 'utf8')).toBe('FAKE SERVER');

    const receipt = JSON.parse(await readFile(path.join(installDir, VOICE_RECEIPT_NAME), 'utf8'));
    expect(receipt.component).toBe('stt-runtime');
    expect(receipt.tag).toBe(asset.tag);
    expect(receipt.entryRelPath).toBe(STT_SERVER_RELPATH);
    expect(receipt.files).toEqual(['README.txt', STT_SERVER_RELPATH]);
    expect(receipt.asset.sha256).toBe(asset.sha256);

    // The verified archive is deleted after extraction, and staging is empty.
    expect(existsSync(path.join(voiceDownloadsDir(userData), 'stt-runtime-test.zip'))).toBe(false);
    expect(await readdir(voiceStagingDir(userData)).catch((): string[] => [])).toEqual([]);

    // A second install answers from disk without touching the network again.
    const downloadsBefore = requests.length;
    await provisioner.install('stt-runtime');
    expect(requests.length).toBe(downloadsBefore);
  });

  it('emits download, verify, extract and finalize progress in order, named for the component', async () => {
    const body = await makeZip({ [STT_SERVER_RELPATH]: 'S' });
    const asset = pinnedAsset('stt-runtime', body);
    const { fetchStub } = stubFetch({ 'stt-runtime-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });
    const events: MongolVoiceProgress[] = [];
    provisioner.on('progress', (p) => events.push(p));

    await provisioner.install('stt-runtime');

    expect([...new Set(events.map((e) => e.phase))]).toEqual(['download', 'verify', 'extract', 'finalize']);
    expect(events.every((e) => e.component === 'stt-runtime')).toBe(true);
    const downloads = events.filter((e) => e.phase === 'download');
    expect(downloads[downloads.length - 1].bytesDone).toBe(body.length);
    expect(downloads[downloads.length - 1].bytesTotal).toBe(body.length);
  });

  it('writes the receipt last, after extraction has finished', async () => {
    const body = await makeZip({ [STT_SERVER_RELPATH]: 'S' });
    const asset = pinnedAsset('stt-runtime', body);
    const { fetchStub } = stubFetch({ 'stt-runtime-test.zip': body });
    const order: string[] = [];
    const provisioner = makeProvisioner({
      fetch: fetchStub,
      assets: [asset],
      extractZip: vi.fn(async (_archive: string, dest: string) => {
        await mkdir(dest, { recursive: true });
        await writeFile(path.join(dest, STT_SERVER_RELPATH), 'S');
        // The receipt cannot exist yet, or a kill here would look installed.
        order.push(existsSync(path.join(dest, VOICE_RECEIPT_NAME)) ? 'receipt-early' : 'no-receipt-yet');
        return [{ relPath: STT_SERVER_RELPATH, bytes: 1, mode: null, kind: 'file' as const, linkTarget: null }];
      }),
    });

    await provisioner.install('stt-runtime');

    expect(order).toEqual(['no-receipt-yet']);
    expect(existsSync(path.join(componentInstallDir(userData, 'stt-runtime', asset.tag), VOICE_RECEIPT_NAME))).toBe(
      true
    );
  });

  it('leaves no receipt and reads as not installed when extraction dies midway', async () => {
    const body = await makeZip({ [STT_SERVER_RELPATH]: 'S' });
    const asset = pinnedAsset('stt-runtime', body);
    const { fetchStub } = stubFetch({ 'stt-runtime-test.zip': body });
    const provisioner = makeProvisioner({
      fetch: fetchStub,
      assets: [asset],
      extractZip: vi.fn(async (_archive: string, dest: string) => {
        // Half the tree lands, then the disk fills.
        await mkdir(dest, { recursive: true });
        await writeFile(path.join(dest, 'half.dll'), 'x');
        throw new Error('ENOSPC: no space left on device');
      }),
    });

    await expect(provisioner.install('stt-runtime')).rejects.toThrow(/ENOSPC/);

    expect(isVoiceComponentInstalled(userData, 'stt-runtime', asset.tag)).toBe(false);
    expect(existsSync(componentInstallDir(userData, 'stt-runtime', asset.tag))).toBe(false);
    // The failed attempt takes its staging tree with it.
    expect(await readdir(voiceStagingDir(userData)).catch((): string[] => [])).toEqual([]);
  });

  it('refuses a runtime archive that does not contain the server binary', async () => {
    const body = await makeZip({ 'README.txt': 'no server here' });
    const asset = pinnedAsset('stt-runtime', body);
    const { fetchStub } = stubFetch({ 'stt-runtime-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });

    await expect(provisioner.install('stt-runtime')).rejects.toThrow(/VOICE_ENTRY_MISSING/);
    expect(isVoiceComponentInstalled(userData, 'stt-runtime', asset.tag)).toBe(false);
  });
});

describe('MongolVoiceProvisioner - the TTS bundle contract', () => {
  it('refuses a bundle with no bundle.json and installs nothing', async () => {
    const body = await makeZip({ 'python/python.exe': 'PY', 'service/server.py': 'SRV' });
    const asset = pinnedAsset('tts-bundle', body);
    const { fetchStub } = stubFetch({ 'tts-bundle-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });

    await expect(provisioner.install('tts-bundle')).rejects.toThrow(/VOICE_BUNDLE_INVALID/);
    expect(isVoiceComponentInstalled(userData, 'tts-bundle', asset.tag)).toBe(false);
    expect(existsSync(componentInstallDir(userData, 'tts-bundle', asset.tag))).toBe(false);
  });

  it('refuses a bundle.json that does not satisfy the kitten-v1 contract', async () => {
    const body = await makeZip({
      'bundle.json': JSON.stringify({ ...BUNDLE_MANIFEST, api: 'kitten-v999' }),
      'python/python.exe': 'PY',
    });
    const asset = pinnedAsset('tts-bundle', body);
    const { fetchStub } = stubFetch({ 'tts-bundle-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });

    await expect(provisioner.install('tts-bundle')).rejects.toThrow(/VOICE_BUNDLE_INVALID/);
    expect(isVoiceComponentInstalled(userData, 'tts-bundle', asset.tag)).toBe(false);
  });

  it('refuses a bundle whose declared entry file is not in the archive', async () => {
    const body = await makeZip({
      'bundle.json': JSON.stringify(BUNDLE_MANIFEST),
      'service/server.py': 'SRV', // python/python.exe is missing
    });
    const asset = pinnedAsset('tts-bundle', body);
    const { fetchStub } = stubFetch({ 'tts-bundle-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });

    await expect(provisioner.install('tts-bundle')).rejects.toThrow(/VOICE_BUNDLE_INVALID/);
    expect(isVoiceComponentInstalled(userData, 'tts-bundle', asset.tag)).toBe(false);
  });

  it('installs a valid bundle and keys the receipt on its entry', async () => {
    const body = await makeZip({
      'bundle.json': JSON.stringify(BUNDLE_MANIFEST),
      'python/python.exe': 'PY',
      'service/server.py': 'SRV',
    });
    const asset = pinnedAsset('tts-bundle', body);
    const { fetchStub } = stubFetch({ 'tts-bundle-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });

    await provisioner.install('tts-bundle');

    expect(isVoiceComponentInstalled(userData, 'tts-bundle', asset.tag)).toBe(true);
    const receipt = JSON.parse(
      await readFile(path.join(componentInstallDir(userData, 'tts-bundle', asset.tag), VOICE_RECEIPT_NAME), 'utf8')
    );
    expect(receipt.entryRelPath).toBe('python/python.exe');
  });
});

describe('MongolVoiceProvisioner - single-file install (stt-model)', () => {
  it('verifies, then atomically renames the model into place', async () => {
    const body = Buffer.from('GGUF-FAKE-MODEL-BYTES', 'utf8');
    const asset = pinnedAsset('stt-model', body, { format: 'file', filename: 'model-test.gguf' });
    const { fetchStub } = stubFetch({ 'model-test.gguf': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });
    const events: MongolVoiceProgress[] = [];
    provisioner.on('progress', (p) => events.push(p));

    expect(isSttModelInstalled(userData, 'model-test.gguf', body.length)).toBe(false);
    await provisioner.install('stt-model');

    expect(isSttModelInstalled(userData, 'model-test.gguf', body.length)).toBe(true);
    expect(await readFile(sttModelPath(userData, 'model-test.gguf'))).toEqual(body);
    // No archive step: the payload is its own install.
    expect([...new Set(events.map((e) => e.phase))]).toEqual(['download', 'verify', 'finalize']);
    // Nothing lingers in downloads - the rename moved it, not copied it.
    expect(existsSync(path.join(voiceDownloadsDir(userData), 'model-test.gguf'))).toBe(false);
  });
});

describe('MongolVoiceProvisioner - upstream zip shapes', () => {
  it('extracts a backslash-separated archive into a real directory tree', async () => {
    // audio.cpp's release zips are built with Windows tooling and separate
    // paths with `\` in violation of APPNOTE. The extraction must produce
    // nested directories, not files with backslashes in their names.
    const body = await makeZip({
      [STT_SERVER_RELPATH]: 'FAKE SERVER',
      'models\\nemotron.cfg': 'CFG',
    });
    const asset = pinnedAsset('stt-runtime', body);
    const { fetchStub } = stubFetch({ 'stt-runtime-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });

    await provisioner.install('stt-runtime');

    const installDir = componentInstallDir(userData, 'stt-runtime', asset.tag);
    expect(await readFile(path.join(installDir, 'models', 'nemotron.cfg'), 'utf8')).toBe('CFG');
    const receipt = JSON.parse(await readFile(path.join(installDir, VOICE_RECEIPT_NAME), 'utf8'));
    // Receipt paths are normalised to `/`, so readiness probes resolve them.
    expect(receipt.files).toEqual([STT_SERVER_RELPATH, 'models/nemotron.cfg']);
    expect(isVoiceComponentInstalled(userData, 'stt-runtime', asset.tag)).toBe(true);
  });

  it('rejects a backslash parent-traversal entry and writes nothing outside staging', async () => {
    const body = await makeZip({
      [STT_SERVER_RELPATH]: 'FAKE SERVER',
      '..\\evil': 'ESCAPED',
    });
    const asset = pinnedAsset('stt-runtime', body);
    const { fetchStub } = stubFetch({ 'stt-runtime-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });

    await expect(provisioner.install('stt-runtime')).rejects.toThrow(/ARCHIVE_UNSAFE_ENTRY/);

    expect(isVoiceComponentInstalled(userData, 'stt-runtime', asset.tag)).toBe(false);
    // `..\evil` would have landed one level above the staging directory.
    expect(existsSync(path.join(voiceStagingDir(userData), 'evil'))).toBe(false);
    expect(await readdir(voiceStagingDir(userData)).catch((): string[] => [])).toEqual([]);
  });
});

describe('MongolVoiceProvisioner - concurrent installs of one component', () => {
  it('deduplicates concurrent installs into one download that both callers share', async () => {
    const body = await makeZip({ [STT_SERVER_RELPATH]: 'FAKE SERVER' });
    const asset = pinnedAsset('stt-runtime', body);
    const { fetchStub, requests } = stubFetch({ 'stt-runtime-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });

    // Reachable from the UI: close Settings mid-install, reopen, press
    // "Install" again while the first install is still running.
    await Promise.all([provisioner.install('stt-runtime'), provisioner.install('stt-runtime')]);

    // One in-flight job, one network fetch - never two streams racing into
    // the same `.part` file.
    expect(requests.length).toBe(1);
    expect(isVoiceComponentInstalled(userData, 'stt-runtime', asset.tag)).toBe(true);
  });

  it('cancel aborts the one shared in-flight install for every caller', async () => {
    const body = await makeZip({ [STT_SERVER_RELPATH]: 'FAKE SERVER' });
    const asset = pinnedAsset('stt-runtime', body);
    // A download that never completes until its signal aborts - so the install
    // is genuinely in flight when cancel() fires.
    const hangingFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const abort = (): void => {
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (init?.signal?.aborted === true) {
          abort();
          return;
        }
        init?.signal?.addEventListener('abort', abort, { once: true });
      })) as unknown as typeof globalThis.fetch;
    const provisioner = makeProvisioner({ fetch: hangingFetch, assets: [asset] });

    const first = provisioner.install('stt-runtime');
    const second = provisioner.install('stt-runtime');

    expect(provisioner.cancel('stt-runtime')).toBe(true);

    // Both callers observe the cancellation - the second must not keep an
    // unreachable download running with no controller left to abort it.
    await expect(first).rejects.toThrow(/VOICE_CANCELLED/);
    await expect(second).rejects.toThrow(/VOICE_CANCELLED/);
  });

  it('removes its abort listener from the external signal once the install settles', async () => {
    const body = await makeZip({ [STT_SERVER_RELPATH]: 'FAKE SERVER' });
    const asset = pinnedAsset('stt-runtime', body);
    const { fetchStub } = stubFetch({ 'stt-runtime-test.zip': body });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [asset] });
    const external = new AbortController();

    await provisioner.install('stt-runtime', external.signal);

    // A long-lived UI signal must not accumulate one listener per install.
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0);
  });
});

describe('MongolVoiceProvisioner - status', () => {
  it('reports supported, pinned, installed, tag and bytes per component', async () => {
    const runtimeBody = await makeZip({ [STT_SERVER_RELPATH]: 'S' });
    const modelBody = Buffer.from('GGUF', 'utf8');
    const runtime = pinnedAsset('stt-runtime', runtimeBody);
    const model = pinnedAsset('stt-model', modelBody, { format: 'file', filename: 'model-test.gguf' });
    const tts = pinnedAsset('tts-bundle', Buffer.from('x'), { sha256: '' });
    const { fetchStub } = stubFetch({ 'stt-runtime-test.zip': runtimeBody });
    const provisioner = makeProvisioner({ fetch: fetchStub, assets: [runtime, model, tts] });

    const before = provisioner.status();
    expect(before['stt-runtime']).toEqual({
      supported: true,
      pinned: true,
      installed: false,
      tag: runtime.tag,
      bytes: runtimeBody.length,
    });
    expect(before['stt-model'].installed).toBe(false);
    expect(before['tts-bundle'].pinned).toBe(false);

    await provisioner.install('stt-runtime');
    expect(provisioner.status()['stt-runtime'].installed).toBe(true);
  });

  it('reports every component unsupported on a platform with nothing to download', () => {
    const provisioner = makeProvisioner({ platform: 'linux', arch: 'x64' });
    const status = provisioner.status();
    expect(status['stt-runtime'].supported).toBe(false);
    expect(status['stt-model'].supported).toBe(false);
    expect(status['tts-bundle'].supported).toBe(false);
  });
});
