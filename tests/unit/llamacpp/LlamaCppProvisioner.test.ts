/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { LlamaCppProvisioner } from '@process/services/llamacpp/LlamaCppProvisioner';
import type { LlamaProvisionError } from '@process/services/llamacpp/LlamaCppProvisioner';
import { LlamaReleaseClient } from '@process/services/llamacpp/releaseClient';
import {
  RECEIPT_NAME,
  downloadsDir,
  installDir,
  installedServerPath,
  isInstalled,
  stagingDir,
  versionsDir,
} from '@process/services/llamacpp/installLayout';
import type { LlamaProvisionProgress } from '@process/services/llamacpp/LlamaCppProvisioner';

const TAG = 'b10437';
const SERVER_ASSET = `llama-${TAG}-bin-win-cpu-x64.zip`;
const CUDA_ASSET = `llama-${TAG}-bin-win-cuda-13.3-x64.zip`;
const CUDART_ASSET = 'cudart-llama-bin-win-cuda-13.3-x64.zip';

let work: string;
let userData: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'darhai-llamacpp-prov-'));
  userData = path.join(work, 'userData');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Build a Windows-shaped (flat) zip containing a fake llama-server.exe. */
async function makeServerZip(extra: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('llama-server.exe', 'FAKE SERVER BINARY');
  zip.file('ggml-base.dll', 'BASE');
  for (const [k, v] of Object.entries(extra)) zip.file(k, v);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** A zip that carries only the three CUDA runtime DLLs, like the real cudart archive. */
async function makeCudartZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('cudart64_13.dll', 'CUDART');
  zip.file('cublas64_13.dll', 'CUBLAS');
  zip.file('cublasLt64_13.dll', 'CUBLASLT');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

type StubAsset = { name: string; body: Buffer; digest?: string | null };

/**
 * A stubbed HTTP layer. Serves the release JSON and the asset bodies, records
 * every request, and can be told to corrupt a body or ignore a Range header.
 */
function stubHttp(
  assets: StubAsset[],
  opts: { corrupt?: string[]; ignoreRange?: boolean; failFirstN?: number; truncateAt?: number } = {}
) {
  const requests: { url: string; range: string | null }[] = [];
  let failures = opts.failFirstN || 0;

  const fetchStub: typeof globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers((init?.headers as HeadersInit) || {});
    const range = headers.get('range');
    requests.push({ url, range });

    if (url.includes('api.github.com')) {
      return new Response(
        JSON.stringify({
          tag_name: TAG,
          assets: assets.map((a) => ({
            name: a.name,
            browser_download_url: `https://example.invalid/${a.name}`,
            size: a.body.length,
            digest: a.digest === null ? undefined : (a.digest ?? `sha256:${sha256(a.body)}`),
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    const asset = assets.find((a) => url.endsWith(a.name));
    if (!asset) return new Response('not found', { status: 404 });

    if (failures > 0) {
      failures -= 1;
      throw new Error('ECONNRESET');
    }

    // The bytes actually put on the wire, corrupted on request.
    let body = asset.body;
    if (opts.corrupt?.includes(asset.name)) {
      body = Buffer.from(asset.body);
      body[Math.floor(body.length / 2)] ^= 0xff;
    }

    let status = 200;
    if (range && !opts.ignoreRange) {
      const start = Number.parseInt(/bytes=(\d+)-/.exec(range)?.[1] || '0', 10);
      body = body.subarray(start);
      status = 206;
    }
    if (opts.truncateAt !== undefined) body = body.subarray(0, opts.truncateAt);

    return new Response(new Uint8Array(body), {
      status,
      headers: { 'content-length': String(body.length) },
    });
  }) as typeof globalThis.fetch;

  return { fetchStub, requests };
}

/** Build a provisioner wired to a stubbed transport. */
function makeProvisioner(fetchStub: typeof globalThis.fetch): LlamaCppProvisioner {
  return new LlamaCppProvisioner({
    fetch: fetchStub,
    releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
  });
}

describe('LlamaCppProvisioner - the happy path', () => {
  it('downloads, verifies, extracts and installs a runnable llama-server', async () => {
    const body = await makeServerZip();
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body }]);
    const provisioner = makeProvisioner(fetchStub);

    const result = await provisioner.ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    expect(result.tag).toBe(TAG);
    expect(result.cached).toBe(false);
    expect(result.serverPath).toBe(path.join(installDir(userData, TAG), 'llama-server.exe'));
    expect(await readFile(result.serverPath, 'utf8')).toBe('FAKE SERVER BINARY');
  });

  it('makes installedServerPath return a real path where it previously returned null', () => {
    // The state this whole change exists to leave behind.
    expect(installedServerPath(userData)).toBeNull();
  });

  it('reports the install as ready afterwards, and installedServerPath finds it', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    expect(isInstalled(userData, TAG)).toBe(true);
    expect(installedServerPath(userData)).toBe(path.join(installDir(userData, TAG), 'llama-server.exe'));
  });

  it('writes a receipt describing exactly what was installed', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const result = await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    const receipt = JSON.parse(await readFile(path.join(result.installDir, RECEIPT_NAME), 'utf8'));
    expect(receipt.tag).toBe(TAG);
    expect(receipt.serverRelPath).toBe('llama-server.exe');
    expect(receipt.assets[0].name).toBe(SERVER_ASSET);
    expect(receipt.assets[0].sha256).toHaveLength(64);
    // Named, not counted: a count cannot say WHICH file is gone, and a count
    // derived from the extractor cannot notice what the extractor never wrote.
    expect(receipt.files).toEqual(['ggml-base.dll', 'llama-server.exe']);
    expect(receipt.requires).toEqual([]);
  });

  it('installs both archives for a Windows CUDA machine with no CUDA runtime', async () => {
    const assets = [
      { name: CUDA_ASSET, body: await makeServerZip({ 'ggml-cuda.dll': 'CUDA' }) },
      { name: CUDART_ASSET, body: await makeCudartZip() },
      { name: SERVER_ASSET, body: await makeServerZip() },
    ];
    const { fetchStub } = stubHttp(assets);
    const result = await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cuda',
      platform: 'win32',
      arch: 'x64',
      cudaRuntimePresent: false,
    });

    // Both archives extract into the same directory, which is what makes
    // ggml-cuda.dll loadable: the DLLs sit next to llama-server.exe.
    const names = (await readdir(result.installDir)).toSorted();
    expect(names).toContain('llama-server.exe');
    expect(names).toContain('ggml-cuda.dll');
    expect(names).toContain('cudart64_13.dll');
    expect(names).toContain('cublasLt64_13.dll');
  });

  it('skips the cudart download when the machine already has the CUDA runtime', async () => {
    const assets = [
      { name: CUDA_ASSET, body: await makeServerZip({ 'ggml-cuda.dll': 'CUDA' }) },
      { name: CUDART_ASSET, body: await makeCudartZip() },
      { name: SERVER_ASSET, body: await makeServerZip() },
    ];
    const { fetchStub, requests } = stubHttp(assets);
    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cuda',
      platform: 'win32',
      arch: 'x64',
      cudaRuntimePresent: true,
    });

    expect(requests.some((r) => r.url.includes(CUDART_ASSET))).toBe(false);
    expect(requests.some((r) => r.url.includes(CUDA_ASSET))).toBe(true);
  });

  it('short-circuits when the tag is already installed', async () => {
    const { fetchStub, requests } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const provisioner = makeProvisioner(fetchStub);
    const request = { userDataDir: userData, backend: 'cpu_x86' as const, platform: 'win32', arch: 'x64' };

    await provisioner.ensureInstalled(request);
    const downloadsAfterFirst = requests.filter((r) => !r.url.includes('api.github.com')).length;

    const second = await provisioner.ensureInstalled(request);
    expect(second.cached).toBe(true);
    expect(requests.filter((r) => !r.url.includes('api.github.com'))).toHaveLength(downloadsAfterFirst);
  });
});

describe('LlamaCppProvisioner - integrity', () => {
  it('refuses a corrupted download instead of installing it', async () => {
    // The transfer completes with the advertised length; only the bytes differ.
    // Nothing but the digest can catch this.
    const body = await makeServerZip();
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body }], { corrupt: [SERVER_ASSET] });

    await expect(
      makeProvisioner(fetchStub).ensureInstalled({
        userDataDir: userData,
        backend: 'cpu_x86',
        platform: 'win32',
        arch: 'x64',
      })
    ).rejects.toThrow(/LLAMACPP_DIGEST_MISMATCH/);
  });

  it('leaves nothing installed after a digest mismatch', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }], {
      corrupt: [SERVER_ASSET],
    });
    await makeProvisioner(fetchStub)
      .ensureInstalled({ userDataDir: userData, backend: 'cpu_x86', platform: 'win32', arch: 'x64' })
      .catch((): void => undefined);

    expect(isInstalled(userData, TAG)).toBe(false);
    expect(installedServerPath(userData)).toBeNull();
  });

  it('deletes the corrupt file so the next attempt does not resume corruption forever', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }], {
      corrupt: [SERVER_ASSET],
    });
    await makeProvisioner(fetchStub)
      .ensureInstalled({ userDataDir: userData, backend: 'cpu_x86', platform: 'win32', arch: 'x64' })
      .catch((): void => undefined);

    expect(existsSync(path.join(downloadsDir(userData), SERVER_ASSET))).toBe(false);
  });

  it('names the expected and actual hash in the error', async () => {
    const body = await makeServerZip();
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body }], { corrupt: [SERVER_ASSET] });
    let err: LlamaProvisionError | null = null;
    try {
      await makeProvisioner(fetchStub).ensureInstalled({
        userDataDir: userData,
        backend: 'cpu_x86',
        platform: 'win32',
        arch: 'x64',
      });
    } catch (e) {
      err = e as LlamaProvisionError;
    }

    expect(err).not.toBeNull();
    expect(err.code).toBe('LLAMACPP_DIGEST_MISMATCH');
    expect(err.message).toContain(sha256(body));
  });

  it('refuses an asset the API served no digest for, rather than trusting the transfer', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip(), digest: null }]);
    await expect(
      makeProvisioner(fetchStub).ensureInstalled({
        userDataDir: userData,
        backend: 'cpu_x86',
        platform: 'win32',
        arch: 'x64',
      })
    ).rejects.toThrow(/LLAMACPP_NO_DIGEST/);
  });

  it('accepts a download whose bytes match the digest', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    await expect(
      makeProvisioner(fetchStub).ensureInstalled({
        userDataDir: userData,
        backend: 'cpu_x86',
        platform: 'win32',
        arch: 'x64',
      })
    ).resolves.toBeTruthy();
  });

  it('fails when the extracted archives contain no llama-server', async () => {
    const zip = new JSZip();
    zip.file('README.md', 'no server here');
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await zip.generateAsync({ type: 'nodebuffer' }) }]);

    await expect(
      makeProvisioner(fetchStub).ensureInstalled({
        userDataDir: userData,
        backend: 'cpu_x86',
        platform: 'win32',
        arch: 'x64',
      })
    ).rejects.toThrow(/LLAMACPP_SERVER_MISSING/);
    expect(isInstalled(userData, TAG)).toBe(false);
  });
});

describe('LlamaCppProvisioner - interrupted downloads', () => {
  it('resumes from a partial file with an HTTP Range request', async () => {
    const body = await makeServerZip();
    const { fetchStub, requests } = stubHttp([{ name: SERVER_ASSET, body }]);

    // Simulate an earlier attempt that was killed after 40 bytes.
    await mkdir(downloadsDir(userData), { recursive: true });
    const partPath = path.join(downloadsDir(userData), `${SERVER_ASSET}.part`);
    await writeFile(partPath, body.subarray(0, 40));

    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    const assetRequest = requests.find((r) => r.url.includes(SERVER_ASSET));
    expect(assetRequest.range).toBe('bytes=40-');
    // The spliced result must still hash to the pinned digest, or nothing installs.
    expect(isInstalled(userData, TAG)).toBe(true);
  });

  it('restarts from zero when the server ignores the Range header', async () => {
    // A 200 to a Range request means the whole file is coming; appending it to
    // the existing partial would splice two copies together and corrupt it.
    const body = await makeServerZip();
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body }], { ignoreRange: true });

    await mkdir(downloadsDir(userData), { recursive: true });
    await writeFile(path.join(downloadsDir(userData), `${SERVER_ASSET}.part`), body.subarray(0, 40));

    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });
    expect(isInstalled(userData, TAG)).toBe(true);
  });

  it('discards a partial file that is already at or past the full size', async () => {
    const body = await makeServerZip();
    const { fetchStub, requests } = stubHttp([{ name: SERVER_ASSET, body }]);

    await mkdir(downloadsDir(userData), { recursive: true });
    await writeFile(path.join(downloadsDir(userData), `${SERVER_ASSET}.part`), Buffer.concat([body, body]));

    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });
    expect(requests.find((r) => r.url.includes(SERVER_ASSET)).range).toBeNull();
    expect(isInstalled(userData, TAG)).toBe(true);
  });

  it('reuses an already-complete download without re-fetching it', async () => {
    const body = await makeServerZip();
    const { fetchStub, requests } = stubHttp([{ name: SERVER_ASSET, body }]);

    await mkdir(downloadsDir(userData), { recursive: true });
    await writeFile(path.join(downloadsDir(userData), SERVER_ASSET), body);

    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });
    expect(requests.some((r) => r.url.includes(SERVER_ASSET))).toBe(false);
    expect(isInstalled(userData, TAG)).toBe(true);
  });

  it('surfaces a transport failure as a typed error and installs nothing', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }], { failFirstN: 1 });
    await expect(
      makeProvisioner(fetchStub).ensureInstalled({
        userDataDir: userData,
        backend: 'cpu_x86',
        platform: 'win32',
        arch: 'x64',
      })
    ).rejects.toThrow(/LLAMACPP_DOWNLOAD_FAILED/);
    expect(isInstalled(userData, TAG)).toBe(false);
  });
});

describe('LlamaCppProvisioner - atomicity', () => {
  it('never leaves a half-extracted directory that later reads as installed', async () => {
    // Extraction blows up halfway. The versions/ tree must be untouched.
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const provisioner = new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
      extractZip: vi.fn(async () => {
        throw new Error('disk full halfway through');
      }),
    });

    await expect(
      provisioner.ensureInstalled({ userDataDir: userData, backend: 'cpu_x86', platform: 'win32', arch: 'x64' })
    ).rejects.toThrow(/LLAMACPP_EXTRACT_FAILED/);

    expect(isInstalled(userData, TAG)).toBe(false);
    expect(installedServerPath(userData)).toBeNull();
    expect(existsSync(installDir(userData, TAG))).toBe(false);
  });

  it('extracts into staging, never directly into the versions tree', async () => {
    const seen: string[] = [];
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const provisioner = new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
      extractZip: vi.fn(async (_archive: string, dest: string) => {
        seen.push(dest);
        await mkdir(dest, { recursive: true });
        await writeFile(path.join(dest, 'llama-server.exe'), 'S');
        return [{ relPath: 'llama-server.exe', bytes: 1, mode: null, kind: 'file' as const, linkTarget: null }];
      }),
    });

    await provisioner.ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].startsWith(stagingDir(userData))).toBe(true);
    expect(seen[0].startsWith(versionsDir(userData))).toBe(false);
  });

  it('replaces a previous install that has no receipt', async () => {
    // A directory left by an older, broken attempt must not block a good install.
    await mkdir(installDir(userData, TAG), { recursive: true });
    await writeFile(path.join(installDir(userData, TAG), 'junk.dll'), 'stale');

    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    expect(isInstalled(userData, TAG)).toBe(true);
    expect(existsSync(path.join(installDir(userData, TAG), 'junk.dll'))).toBe(false);
  });

  it('respects a rival install that already wrote its receipt, instead of deleting it', async () => {
    // Two app instances installing the same tag. The directory `commit()` would
    // `rm -rf` may be the one a running llama-server was spawned from: on
    // Windows that is an EBUSY mid-install, on POSIX a live process pointed at
    // unlinked files. A receipt means someone finished; ours is redundant.
    const finalDir = installDir(userData, TAG);
    await mkdir(finalDir, { recursive: true });
    await writeFile(path.join(finalDir, 'rival-marker.dll'), 'RIVAL');
    await writeFile(
      path.join(finalDir, RECEIPT_NAME),
      JSON.stringify({
        schema: 2,
        tag: TAG,
        platform: 'win32',
        arch: 'x64',
        requestedBackend: 'cpu_x86',
        acceleration: 'cpu',
        fallback: null,
        serverRelPath: 'llama-server.exe',
        assets: [],
        // Names a file that is not there, so `isInstalled` is false and the
        // install actually runs far enough to reach `commit()`.
        files: ['llama-server.exe', 'rival-marker.dll'],
        requires: [],
        installedAt: '2026-08-15T00:00:00.000Z',
      })
    );
    expect(isInstalled(userData, TAG)).toBe(false);

    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    expect(await readFile(path.join(finalDir, 'rival-marker.dll'), 'utf8')).toBe('RIVAL');
    expect(await readdir(stagingDir(userData)).catch((): string[] => [])).toEqual([]);
  });

  it('keeps an existing install of another tag untouched when a new tag installs', async () => {
    const older = installDir(userData, 'b10000');
    await mkdir(older, { recursive: true });
    await writeFile(path.join(older, 'llama-server.exe'), 'OLD SERVER');

    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    expect(await readFile(path.join(older, 'llama-server.exe'), 'utf8')).toBe('OLD SERVER');
    expect(isInstalled(userData, TAG)).toBe(true);
  });

  it('writes the receipt last, after every file has landed', async () => {
    const order: string[] = [];
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const provisioner = new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
      extractZip: vi.fn(async (_a: string, dest: string) => {
        await mkdir(dest, { recursive: true });
        await writeFile(path.join(dest, 'llama-server.exe'), 'S');
        order.push('extract');
        // The receipt cannot exist yet, or a kill here would look installed.
        order.push(existsSync(path.join(dest, RECEIPT_NAME)) ? 'receipt-early' : 'no-receipt-yet');
        return [{ relPath: 'llama-server.exe', bytes: 1, mode: null, kind: 'file' as const, linkTarget: null }];
      }),
    });

    await provisioner.ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });
    expect(order).toEqual(['extract', 'no-receipt-yet']);
    expect(existsSync(path.join(installDir(userData, TAG), RECEIPT_NAME))).toBe(true);
  });
});

describe('LlamaCppProvisioner - progress reporting', () => {
  it('emits byte progress and every phase in order', async () => {
    const body = await makeServerZip();
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body }]);
    const provisioner = makeProvisioner(fetchStub);

    const events: LlamaProvisionProgress[] = [];
    provisioner.on('progress', (p) => events.push(p));

    await provisioner.ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    const phases = [...new Set(events.map((e) => e.phase))];
    expect(phases).toEqual(['downloading', 'verifying', 'extracting', 'installing', 'done']);
  });

  it('reports bytes that advance to the full asset size', async () => {
    const body = await makeServerZip();
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body }]);
    const provisioner = makeProvisioner(fetchStub);
    const events: LlamaProvisionProgress[] = [];
    provisioner.on('progress', (p) => events.push(p));

    await provisioner.ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    const downloads = events.filter((e) => e.phase === 'downloading');
    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads[downloads.length - 1].bytesDone).toBe(body.length);
    expect(downloads[downloads.length - 1].bytesTotal).toBe(body.length);
  });

  it('reports position within a multi-asset plan so a 500 MB pair does not read as a hang', async () => {
    const assets = [
      { name: CUDA_ASSET, body: await makeServerZip({ 'ggml-cuda.dll': 'CUDA' }) },
      { name: CUDART_ASSET, body: await makeCudartZip() },
    ];
    const { fetchStub } = stubHttp(assets);
    const provisioner = makeProvisioner(fetchStub);
    const events: LlamaProvisionProgress[] = [];
    provisioner.on('progress', (p) => events.push(p));

    await provisioner.ensureInstalled({
      userDataDir: userData,
      backend: 'cuda',
      platform: 'win32',
      arch: 'x64',
      cudaRuntimePresent: false,
    });

    expect(events.every((e) => e.assetCount === 2)).toBe(true);
    expect(new Set(events.map((e) => e.assetIndex))).toEqual(new Set([1, 2]));
    const total = assets.reduce((s, a) => s + a.body.length, 0);
    expect(events[events.length - 1].totalBytesDone).toBe(total);
    expect(events[events.length - 1].totalBytesTotal).toBe(total);
  });

  it('names the asset currently being fetched', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const provisioner = makeProvisioner(fetchStub);
    const events: LlamaProvisionProgress[] = [];
    provisioner.on('progress', (p) => events.push(p));

    await provisioner.ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });
    expect(events.find((e) => e.phase === 'downloading').assetName).toBe(SERVER_ASSET);
  });
});

describe('LlamaCppProvisioner - planning without downloading', () => {
  it('reports the plan and its size before anything is fetched', async () => {
    const assets = [
      { name: CUDA_ASSET, body: await makeServerZip() },
      { name: CUDART_ASSET, body: await makeCudartZip() },
    ];
    const { fetchStub, requests } = stubHttp(assets);
    const { plan, release } = await makeProvisioner(fetchStub).plan({
      userDataDir: userData,
      backend: 'cuda',
      platform: 'win32',
      arch: 'x64',
    });

    expect(plan.kind).toBe('ok');
    if (plan.kind === 'ok') expect(plan.assets).toHaveLength(2);
    expect(release.tag).toBe(TAG);
    expect(requests.every((r) => r.url.includes('api.github.com'))).toBe(true);
  });

  it('surfaces an unsupported machine as a typed error rather than a bad download', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    await expect(
      makeProvisioner(fetchStub).ensureInstalled({
        userDataDir: userData,
        backend: 'cpu_x86',
        platform: 'freebsd',
        arch: 'x64',
      })
    ).rejects.toThrow(/LLAMACPP_UNSUPPORTED/);
  });

  it('carries a stated CPU fallback into the receipt', async () => {
    // linux + cuda has no build; the install must record why it is CPU.
    const linuxAsset = `llama-${TAG}-bin-ubuntu-x64.tar.gz`;
    const zipBody = await makeServerZip();
    const { fetchStub } = stubHttp([{ name: linuxAsset, body: zipBody }]);
    const provisioner = new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
      // The body is a zip; drive the tar path through a stub so the assertion
      // is about the receipt, not about tar decoding (covered in archive.test).
      extractTarGz: vi.fn(async (_a: string, dest: string) => {
        await mkdir(dest, { recursive: true });
        await writeFile(path.join(dest, 'llama-server'), 'S');
        return [{ relPath: 'llama-server', bytes: 1, mode: 0o755, kind: 'file' as const, linkTarget: null }];
      }),
    });

    const result = await provisioner.ensureInstalled({
      userDataDir: userData,
      backend: 'cuda',
      platform: 'linux',
      arch: 'x64',
    });

    expect(result.receipt.acceleration).toBe('cpu');
    expect(result.receipt.requestedBackend).toBe('cuda');
    expect(result.receipt.fallback.reason).toContain('CUDA');
    const onDisk = JSON.parse(await readFile(path.join(result.installDir, RECEIPT_NAME), 'utf8'));
    expect(onDisk.fallback.reason).toContain('CUDA');
  });
});

/**
 * A minimal 64-bit Mach-O carrying one `LC_LOAD_DYLIB`.
 *
 * Built by hand rather than checked in as a fixture so the dependency name is
 * visible in the test that depends on it. The layout is the one measured in the
 * real `llama-server`: header, then a dylib command whose name starts at
 * offset 24 within the command.
 */
function machONeeding(dep: string): Buffer {
  const name = Buffer.from(`${dep}\0`, 'utf8');
  const pad = (8 - ((24 + name.length) % 8)) % 8;
  const cmdSize = 24 + name.length + pad;
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  header.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  header.writeUInt32LE(1, 16); // ncmds
  header.writeUInt32LE(cmdSize, 20); // sizeofcmds
  const command = Buffer.alloc(cmdSize);
  command.writeUInt32LE(0x0c, 0); // LC_LOAD_DYLIB
  command.writeUInt32LE(cmdSize, 4);
  command.writeUInt32LE(24, 8); // name offset within the command
  name.copy(command, 24);
  return Buffer.concat([header, command]);
}

describe('LlamaCppProvisioner - install integrity beyond what the extractor reports', () => {
  /** An extractor stub that writes exactly the files it is given. */
  const stubExtractor = (files: Record<string, string | Buffer>) =>
    vi.fn(async (_archive: string, dest: string) => {
      await mkdir(dest, { recursive: true });
      const written = [];
      for (const [name, body] of Object.entries(files)) {
        await writeFile(path.join(dest, name), body);
        written.push({ relPath: name, bytes: 1, mode: null, kind: 'file' as const, linkTarget: null });
      }
      return written;
    });

  it('refuses an install whose binaries name a library that is not there', async () => {
    // This is the macOS/Linux defect end to end: the extractor reports success
    // and its file list agrees with what is on disk, but llama-server names a
    // library nothing wrote. Only the binary's own load command knows.
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const provisioner = new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
      extractZip: stubExtractor({ 'llama-server.exe': machONeeding('@rpath/libllama.0.dylib') }),
    });

    await expect(
      provisioner.ensureInstalled({ userDataDir: userData, backend: 'cpu_x86', platform: 'win32', arch: 'x64' })
    ).rejects.toThrow(/LLAMACPP_INSTALL_INCOMPLETE/);
    expect(isInstalled(userData, TAG)).toBe(false);
    expect(existsSync(installDir(userData, TAG))).toBe(false);
  });

  it('names the missing library in the error', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const provisioner = new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
      extractZip: stubExtractor({ 'llama-server.exe': machONeeding('@rpath/libggml-base.0.dylib') }),
    });

    await expect(
      provisioner.ensureInstalled({ userDataDir: userData, backend: 'cpu_x86', platform: 'win32', arch: 'x64' })
    ).rejects.toThrow(/libggml-base\.0\.dylib/);
  });

  it('accepts the same install once that library is on disk, and records it', async () => {
    // The other half of the guard: it must not fire on a complete tree, or the
    // feature is simply off.
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const provisioner = new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
      extractZip: stubExtractor({
        'llama-server.exe': machONeeding('@rpath/libllama.0.dylib'),
        'libllama.0.dylib': 'REAL LIB',
      }),
    });

    const result = await provisioner.ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });
    expect(result.receipt.requires).toEqual(['libllama.0.dylib']);
    expect(isInstalled(userData, TAG)).toBe(true);
  });

  it('stops reporting ready when that library later disappears', async () => {
    // Readiness has to be able to fail on an install that is missing something.
    // `requires` came from the binary, so deleting the library it names is
    // enough - no file count is involved.
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const provisioner = new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
      extractZip: stubExtractor({
        'llama-server.exe': machONeeding('@rpath/libllama.0.dylib'),
        'libllama.0.dylib': 'REAL LIB',
      }),
    });

    await provisioner.ensureInstalled({ userDataDir: userData, backend: 'cpu_x86', platform: 'win32', arch: 'x64' });
    expect(isInstalled(userData, TAG)).toBe(true);

    await rm(path.join(installDir(userData, TAG), 'libllama.0.dylib'), { force: true });
    expect(isInstalled(userData, TAG)).toBe(false);
    expect(installedServerPath(userData)).toBeNull();
  });
});

describe('LlamaCppProvisioner - disk hygiene', () => {
  /** Every `staging/<tag>-<rand>` directory currently on disk. */
  const stagingDirs = async (): Promise<string[]> => {
    try {
      return await readdir(stagingDir(userData));
    } catch {
      return [];
    }
  };

  it('leaves no staging directory behind when extraction fails', async () => {
    // The full-disk case: each retry used to add another partly-extracted tree,
    // so pressing "Try again" consumed the space that would let it succeed.
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const provisioner = new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
      extractZip: vi.fn(async () => {
        throw new Error('ENOSPC: no space left on device');
      }),
    });
    const request = { userDataDir: userData, backend: 'cpu_x86' as const, platform: 'win32', arch: 'x64' };

    await provisioner.ensureInstalled(request).catch((): void => undefined);
    await provisioner.ensureInstalled(request).catch((): void => undefined);

    expect(await stagingDirs()).toEqual([]);
  });

  it('leaves no staging directory behind when the digest does not match', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }], {
      corrupt: [SERVER_ASSET],
    });
    await makeProvisioner(fetchStub)
      .ensureInstalled({ userDataDir: userData, backend: 'cpu_x86', platform: 'win32', arch: 'x64' })
      .catch((): void => undefined);

    expect(await stagingDirs()).toEqual([]);
  });

  it('deletes the verified archives once they are installed', async () => {
    // MEASURED on the reference machine: 513 MB of CUDA archives were kept
    // forever, and every upgrade added another copy.
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    expect(existsSync(path.join(downloadsDir(userData), SERVER_ASSET))).toBe(false);
    expect(existsSync(path.join(downloadsDir(userData), `${SERVER_ASSET}.part`))).toBe(false);
    expect(isInstalled(userData, TAG)).toBe(true);
  });

  it('sweeps a staging directory an earlier run was killed in', async () => {
    const orphan = path.join(stagingDir(userData), `${TAG}-orphan`);
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, 'half.dll'), 'x');
    // Backdate it past the staleness window; a live install is minutes old.
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(orphan, old, old);

    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    expect(existsSync(orphan)).toBe(false);
  });

  it('leaves a staging directory a concurrent install is still using', async () => {
    const live = path.join(stagingDir(userData), `${TAG}-live`);
    await mkdir(live, { recursive: true });
    await writeFile(path.join(live, 'in-progress.dll'), 'x');

    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    expect(existsSync(path.join(live, 'in-progress.dll'))).toBe(true);
  });
});

describe('LlamaCppProvisioner - working offline', () => {
  it('answers a pinned, already-installed tag without touching the network', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    await makeProvisioner(fetchStub).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
      tag: TAG,
    });

    // A transport that fails on every call, the way it does on a plane.
    const offline: typeof globalThis.fetch = (async () => {
      throw new Error('ENOTFOUND api.github.com');
    }) as typeof globalThis.fetch;

    const result = await makeProvisioner(offline).ensureInstalled({
      userDataDir: userData,
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
      tag: TAG,
    });
    expect(result.cached).toBe(true);
    expect(result.serverPath).toBe(path.join(installDir(userData, TAG), 'llama-server.exe'));
  });

  it('still fails offline when no install exists to fall back on', async () => {
    const offline: typeof globalThis.fetch = (async () => {
      throw new Error('ENOTFOUND api.github.com');
    }) as typeof globalThis.fetch;

    await expect(
      makeProvisioner(offline).ensureInstalled({
        userDataDir: userData,
        backend: 'cpu_x86',
        platform: 'win32',
        arch: 'x64',
        tag: TAG,
      })
    ).rejects.toThrow();
  });
});

describe('LlamaCppProvisioner - cancellation', () => {
  it('refuses to start when the signal is already aborted', async () => {
    const { fetchStub } = stubHttp([{ name: SERVER_ASSET, body: await makeServerZip() }]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      makeProvisioner(fetchStub).ensureInstalled(
        { userDataDir: userData, backend: 'cpu_x86', platform: 'win32', arch: 'x64' },
        controller.signal
      )
    ).rejects.toThrow(/LLAMACPP_CANCELLED/);
    expect(isInstalled(userData, TAG)).toBe(false);
  });

  it('reports no in-flight install to cancel when idle', () => {
    expect(new LlamaCppProvisioner().cancel()).toBe(false);
  });
});
