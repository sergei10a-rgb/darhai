/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A release exists before its assets do, and that must not read as "your
 * computer cannot run local models".
 *
 * MEASURED against the live GitHub API on 2026-08-15 (`GET
 * /repos/ggml-org/llama.cpp/releases?per_page=6`). Release b10442 was created
 * at 14:58:24Z and its 26 assets landed afterwards, one at a time:
 *
 *     +15 s  cudart-llama-bin-win-cuda-12.4-x64.zip     <- the first asset
 *     +37 s  llama-b10442-bin-macos-arm64.tar.gz
 *     +51 s  llama-b10442-bin-ubuntu-x64.tar.gz
 *     +53 s  llama-b10442-bin-win-cpu-x64.zip
 *     +64 s  llama-b10442-bin-win-cuda-13.3-x64.zip
 *     +92 s  llama-b10442-xcframework.zip              <- the last asset
 *
 * The five releases before it took 88-134 s to finish the same upload, and six
 * releases were published inside 19.5 h. Anything resolving `latest` inside one
 * of those windows sees a genuine release that lists no build for this machine,
 * and answers `LLAMACPP_UNSUPPORTED` - which the UI treats as terminal and
 * offers no retry for. The fixtures below are that measurement replayed: the
 * asset names are the real ones, and the "mid-upload" snapshots are exactly the
 * subsets that existed at t+20 s and t+40 s.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { LlamaCppProvisioner } from '@process/services/llamacpp/LlamaCppProvisioner';
import { LlamaReleaseClient } from '@process/services/llamacpp/releaseClient';
import { planLlamaAssets, type LlamaAssetPlan } from '@process/services/llamacpp/assetMap';

/** Every asset ggml-org/llama.cpp b10441 shipped, measured. */
const B10441_ASSETS = [
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.3-x64.zip',
  'cudart-llama-bin-win-cuda-13.4-arm64.zip',
  'llama-b10441-bin-android-arm64.tar.gz',
  'llama-b10441-bin-macos-arm64.tar.gz',
  'llama-b10441-bin-macos-x64.tar.gz',
  'llama-b10441-bin-ubuntu-arm64.tar.gz',
  'llama-b10441-bin-ubuntu-x64.tar.gz',
  'llama-b10441-bin-win-cpu-arm64.zip',
  'llama-b10441-bin-win-cpu-x64.zip',
  'llama-b10441-bin-win-cuda-12.4-x64.zip',
  'llama-b10441-bin-win-cuda-13.3-x64.zip',
  'llama-b10441-bin-win-vulkan-x64.zip',
];

/** b10442 at t+20 s: one asset uploaded, and it is a cudart archive. */
const B10442_AT_20S = ['cudart-llama-bin-win-cuda-12.4-x64.zip'];

/** b10442 at t+40 s: macOS and Linux arm64 are in, Windows and Linux x64 are not. */
const B10442_AT_40S = [
  'cudart-llama-bin-win-cuda-12.4-x64.zip',
  'cudart-llama-bin-win-cuda-13.3-x64.zip',
  'cudart-llama-bin-win-cuda-13.4-arm64.zip',
  'llama-b10442-bin-android-arm64.tar.gz',
  'llama-b10442-bin-macos-arm64.tar.gz',
  'llama-b10442-bin-macos-x64.tar.gz',
  'llama-b10442-bin-ubuntu-arm64.tar.gz',
];

/** b10442 complete, as it looked once the last asset landed at +92 s. */
const B10442_COMPLETE = B10441_ASSETS.map((name) => name.replace('b10441', 'b10442'));

type Snapshot = { tag: string; assets: string[] };

/**
 * The GitHub release API, serving a stack of releases newest-first.
 *
 * Records every URL, so a test can assert not just the answer but what it cost:
 * a complete `latest` must not provoke a second request.
 */
function stubApi(releases: Snapshot[]) {
  const urls: string[] = [];
  const body = (r: Snapshot) => ({
    tag_name: r.tag,
    draft: false,
    prerelease: false,
    assets: r.assets.map((name) => ({
      name,
      browser_download_url: `https://example.invalid/${r.tag}/${name}`,
      size: 18_477_132,
      digest: `sha256:${'a'.repeat(64)}`,
    })),
  });

  const fetchStub: typeof globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

    if (url.includes('/releases?per_page=')) return json(releases.map(body));
    const tagged = /\/releases\/tags\/(.+)$/.exec(url);
    if (tagged) {
      const hit = releases.find((r) => r.tag === decodeURIComponent(tagged[1]));
      return hit ? json(body(hit)) : new Response('not found', { status: 404 });
    }
    return json(body(releases[0]));
  }) as typeof globalThis.fetch;

  return { fetchStub, urls };
}

function provisionerFor(releases: Snapshot[]) {
  const { fetchStub, urls } = stubApi(releases);
  return {
    provisioner: new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
    }),
    urls,
  };
}

const MID_UPLOAD: Snapshot[] = [
  { tag: 'b10442', assets: B10442_AT_40S },
  { tag: 'b10441', assets: B10441_ASSETS },
];

describe('LlamaCppProvisioner.plan - a release that is still uploading', () => {
  it('answers with the previous release instead of calling Windows unsupported', async () => {
    // t+40 s: `llama-b10442-bin-win-cpu-x64.zip` does not exist yet (it lands
    // at +53 s), so planning b10442 for this machine has no asset to name.
    const { provisioner } = provisionerFor(MID_UPLOAD);

    const { release, plan } = await provisioner.plan({
      userDataDir: '/userData',
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });

    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(release.tag).toBe('b10441');
    expect(plan.assets.map((a) => a.name)).toEqual(['llama-b10441-bin-win-cpu-x64.zip']);
  });

  it('walks back for a Linux machine too, whose archive lands even later', async () => {
    const { provisioner } = provisionerFor(MID_UPLOAD);
    const { release, plan } = await provisioner.plan({
      userDataDir: '/userData',
      backend: 'cpu_x86',
      platform: 'linux',
      arch: 'x64',
    });
    expect(plan.kind).toBe('ok');
    expect(release.tag).toBe('b10441');
  });

  it('stays on the new release for a machine whose archive HAS landed', async () => {
    // macOS arm64 uploaded at +37 s, so at +40 s b10442 is already the right
    // answer for that machine. The walk-back is per-machine, not per-release.
    const { provisioner, urls } = provisionerFor(MID_UPLOAD);
    const { release, plan } = await provisioner.plan({
      userDataDir: '/userData',
      backend: 'metal',
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(plan.kind).toBe('ok');
    expect(release.tag).toBe('b10442');
    expect(urls.filter((u) => u.includes('per_page'))).toHaveLength(0);
  });

  it('walks back from a release whose FIRST asset has not landed either', async () => {
    // t+0-15 s: the release object exists with an empty asset array, which the
    // release client reports as malformed. That is still a release that an
    // older one can answer for.
    const { provisioner } = provisionerFor([
      { tag: 'b10442', assets: [] },
      { tag: 'b10441', assets: B10441_ASSETS },
    ]);
    const { release, plan } = await provisioner.plan({
      userDataDir: '/userData',
      backend: 'cuda',
      platform: 'win32',
      arch: 'x64',
    });
    expect(plan.kind).toBe('ok');
    expect(release.tag).toBe('b10441');
  });

  it('skips as many incomplete releases as it takes', async () => {
    const { provisioner } = provisionerFor([
      { tag: 'b10442', assets: B10442_AT_20S },
      { tag: 'b10441', assets: [] },
      { tag: 'b10437', assets: B10441_ASSETS.map((n) => n.replace('b10441', 'b10437')) },
    ]);
    const { release } = await provisioner.plan({
      userDataDir: '/userData',
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
    });
    expect(release.tag).toBe('b10437');
  });
});

describe('LlamaCppProvisioner.plan - what it must NOT walk back for', () => {
  it('costs nothing extra when the newest release is complete', async () => {
    const { provisioner, urls } = provisionerFor([
      { tag: 'b10442', assets: B10442_COMPLETE },
      { tag: 'b10441', assets: B10441_ASSETS },
    ]);
    const { release } = await provisioner.plan({
      userDataDir: '/userData',
      backend: 'cuda',
      platform: 'win32',
      arch: 'x64',
    });
    expect(release.tag).toBe('b10442');
    expect(urls).toHaveLength(1);
  });

  it('keeps a permanent platform verdict permanent, without a second request', async () => {
    // llama.cpp has never published a FreeBSD build; asking older releases is
    // pointless, and this must not turn into two API calls on every press.
    const { provisioner, urls } = provisionerFor(MID_UPLOAD);
    const { plan } = await provisioner.plan({
      userDataDir: '/userData',
      backend: 'cpu_x86',
      platform: 'freebsd',
      arch: 'x64',
    });
    expect(plan.kind).toBe('unsupported');
    if (plan.kind !== 'unsupported') return;
    expect(plan.cause).toBe('platform');
    expect(urls).toHaveLength(1);
  });

  it('never walks back from an explicitly pinned tag', async () => {
    // A pinned tag is a deliberate choice by the caller - an approved plan, or
    // a reinstall of the version already on disk. Substituting a different
    // release for it would be the very substitution this layer exists to stop.
    const { provisioner } = provisionerFor([
      { tag: 'b10442', assets: B10442_AT_40S },
      { tag: 'b10441', assets: B10441_ASSETS },
    ]);
    const { release, plan } = await provisioner.plan({
      userDataDir: '/userData',
      backend: 'cpu_x86',
      platform: 'win32',
      arch: 'x64',
      tag: 'b10442',
    });
    expect(release.tag).toBe('b10442');
    expect(plan.kind).toBe('unsupported');
  });

  it('reports unsupported when no recent release ships a build for this machine', async () => {
    // Not a window - a fact. Every recent release is complete and none of them
    // has an s390x build, so there is nothing to walk back to.
    const { provisioner } = provisionerFor([
      { tag: 'b10442', assets: B10442_COMPLETE },
      { tag: 'b10441', assets: B10441_ASSETS },
    ]);
    const { plan } = await provisioner.plan({
      userDataDir: '/userData',
      backend: 'cpu_arm',
      platform: 'linux',
      arch: 'ppc64',
    });
    expect(plan.kind).toBe('unsupported');
  });
});

/**
 * An approved plan crosses into `ensureInstalled` as a PLAN, and nothing below
 * re-decides it.
 *
 * The alternative - pinning the inputs and re-planning - is what shipped, and
 * it failed in the one way that mattered: `LlamaProvisionRequest` never carried
 * `driverVersion`, so a disclosure of "CPU build, because your driver predates
 * every CUDA build in this release" was reconstructed WITHOUT the driver and
 * came back as the newest CUDA line. These tests deliberately hand the
 * provisioner a plan that CONTRADICTS the request's other fields; if any of
 * them are still being read, the wrong archive is downloaded.
 */
describe('LlamaCppProvisioner.ensureInstalled - a pinned plan is installed verbatim', () => {
  let work: string;
  let userData: string;

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'darhai-plan-binding-'));
    userData = path.join(work, 'userData');
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  /** A flat Windows-shaped zip carrying a fake llama-server.exe. */
  async function serverZip(marker: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('llama-server.exe', marker);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  /** Serves the b10442 release plus every asset body, and records the downloads. */
  function stubTransport(bodies: Record<string, Buffer>) {
    const downloaded: string[] = [];
    const fetchStub: typeof globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('api.github.com')) {
        return new Response(
          JSON.stringify({
            tag_name: 'b10442',
            draft: false,
            assets: Object.entries(bodies).map(([name, body]) => ({
              name,
              browser_download_url: `https://example.invalid/${name}`,
              size: body.length,
              digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
            })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      const name = Object.keys(bodies).find((n) => url.endsWith(n));
      if (!name) return new Response('not found', { status: 404 });
      downloaded.push(name);
      return new Response(new Uint8Array(bodies[name]), { status: 200 });
    }) as typeof globalThis.fetch;
    return { fetchStub, downloaded };
  }

  it('fetches the CPU archive its plan names, not the CUDA one its backend asks for', async () => {
    const bodies: Record<string, Buffer> = {
      'llama-b10442-bin-win-cpu-x64.zip': await serverZip('CPU BUILD'),
      'llama-b10442-bin-win-cuda-13.3-x64.zip': await serverZip('CUDA BUILD'),
      'cudart-llama-bin-win-cuda-13.3-x64.zip': await serverZip('CUDART'),
    };
    const { fetchStub, downloaded } = stubTransport(bodies);
    const provisioner = new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
    });

    // Exactly what `resolve()` produces on a driver below every CUDA floor.
    const approved = planLlamaAssets({
      platform: 'win32',
      arch: 'x64',
      backend: 'cuda',
      tag: 'b10442',
      availableAssets: Object.keys(bodies),
      driverVersion: '470.82',
    });
    expect(approved.kind).toBe('ok');
    if (approved.kind !== 'ok') return;
    expect(approved.fallback.code).toBe('CUDA_DRIVER_TOO_OLD');

    const result = await provisioner.ensureInstalled({
      userDataDir: userData,
      plan: approved as LlamaAssetPlan,
      // Every one of these contradicts the plan, and every one of them used to
      // be what the install was rebuilt from.
      backend: 'cuda',
      platform: 'win32',
      arch: 'x64',
      cudaRuntimePresent: false,
    });

    expect(downloaded).toEqual(['llama-b10442-bin-win-cpu-x64.zip']);
    expect(result.receipt.acceleration).toBe('cpu');
    expect(result.receipt.fallback.code).toBe('CUDA_DRIVER_TOO_OLD');
  });

  it('keeps the disclosed CUDA line instead of re-picking the newest', async () => {
    const bodies: Record<string, Buffer> = {
      'llama-b10442-bin-win-cpu-x64.zip': await serverZip('CPU BUILD'),
      'llama-b10442-bin-win-cuda-12.4-x64.zip': await serverZip('CUDA 12 BUILD'),
      'cudart-llama-bin-win-cuda-12.4-x64.zip': await serverZip('CUDART 12'),
      'llama-b10442-bin-win-cuda-13.3-x64.zip': await serverZip('CUDA 13 BUILD'),
      'cudart-llama-bin-win-cuda-13.3-x64.zip': await serverZip('CUDART 13'),
    };
    const { fetchStub, downloaded } = stubTransport(bodies);
    const provisioner = new LlamaCppProvisioner({
      fetch: fetchStub,
      releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
    });

    // 552.22 is an r550 Windows driver: CUDA 12 (>=527.41) yes, 13 (>=580.65.06) no.
    const approved = planLlamaAssets({
      platform: 'win32',
      arch: 'x64',
      backend: 'cuda',
      tag: 'b10442',
      availableAssets: Object.keys(bodies),
      driverVersion: '552.22',
    });
    expect(approved.kind).toBe('ok');
    if (approved.kind !== 'ok') return;
    expect(approved.cudaVariant).toBe('12.4');

    await provisioner.ensureInstalled({
      userDataDir: userData,
      plan: approved as LlamaAssetPlan,
      backend: 'cuda',
      platform: 'win32',
      arch: 'x64',
    });

    expect(downloaded).toEqual(['llama-b10442-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip']);
  });
});
