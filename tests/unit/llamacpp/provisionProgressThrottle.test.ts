/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Progress must not cross IPC once per stream chunk.
 *
 * A 512.8 MB transfer at 53.1 MB/s used to emit thousands of `progress`
 * events, each one re-rendering the model table. The contract now: inside one
 * phase of one asset, at most one event per {@link PROGRESS_EMIT_INTERVAL_MS};
 * a phase or asset boundary always emits; and the final 100% of a sized
 * download always emits, so the bar cannot freeze short of full.
 *
 * The clock is injected (the provisioner's own `now` dep), so both directions
 * are held: a frozen clock collapses a many-chunk download to its boundary and
 * final events, and a clock that jumps past the interval lets every chunk
 * through.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  LlamaCppProvisioner,
  PROGRESS_EMIT_INTERVAL_MS,
  type LlamaProvisionProgress,
} from '@process/services/llamacpp/LlamaCppProvisioner';
import { LlamaReleaseClient } from '@process/services/llamacpp/releaseClient';

const TAG = 'b10437';
const SERVER_ASSET = `llama-${TAG}-bin-win-cpu-x64.zip`;
const CHUNK_SIZE = 64;

let work: string;
let userData: string;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'darhai-llamacpp-throttle-'));
  userData = path.join(work, 'userData');
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

async function makeServerZip(): Promise<Buffer> {
  const zip = new JSZip();
  // STORE so the archive is comfortably larger than CHUNK_SIZE and splits
  // into many chunks - the whole point of the test.
  zip.file('llama-server.exe', 'FAKE SERVER BINARY '.repeat(200));
  zip.file('ggml-base.dll', 'BASE '.repeat(200));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

/** Serve the release JSON whole and the asset body in CHUNK_SIZE pieces. */
function chunkedStub(body: Buffer, onChunk: () => void): typeof globalThis.fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes('api.github.com')) {
      return new Response(
        JSON.stringify({
          tag_name: TAG,
          assets: [
            {
              name: SERVER_ASSET,
              browser_download_url: `https://example.invalid/${SERVER_ASSET}`,
              size: body.length,
              digest: `sha256:${sha256(body)}`,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= body.length) {
          controller.close();
          return;
        }
        onChunk();
        controller.enqueue(new Uint8Array(body.subarray(offset, offset + CHUNK_SIZE)));
        offset += CHUNK_SIZE;
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof globalThis.fetch;
}

type Clock = { nowMs: number };

function makeProvisioner(fetchStub: typeof globalThis.fetch, clock: Clock): LlamaCppProvisioner {
  return new LlamaCppProvisioner({
    fetch: fetchStub,
    releaseClient: new LlamaReleaseClient({ fetch: fetchStub }),
    now: () => new Date(clock.nowMs),
  });
}

async function runInstall(
  provisioner: LlamaCppProvisioner
): Promise<{ events: LlamaProvisionProgress[]; downloads: LlamaProvisionProgress[] }> {
  const events: LlamaProvisionProgress[] = [];
  provisioner.on('progress', (p) => events.push(p));
  await provisioner.ensureInstalled({
    userDataDir: userData,
    backend: 'cpu_x86',
    platform: 'win32',
    arch: 'x64',
  });
  return { events, downloads: events.filter((e) => e.phase === 'downloading') };
}

describe('LlamaCppProvisioner - progress throttling', () => {
  it('collapses a many-chunk download to boundary + final under a frozen clock', async () => {
    const body = await makeServerZip();
    const chunkCount = Math.ceil(body.length / CHUNK_SIZE);
    expect(chunkCount).toBeGreaterThan(10);

    const clock: Clock = { nowMs: 0 };
    const provisioner = makeProvisioner(
      chunkedStub(body, () => undefined),
      clock
    );
    const { events, downloads } = await runInstall(provisioner);

    // With no time passing, the mid-download chunks are suppressed: what is
    // left is the phase-entry event and the guaranteed final 100%.
    expect(downloads.length).toBeLessThanOrEqual(2);
    expect(downloads.at(-1)?.bytesDone).toBe(body.length);
    expect(downloads.at(-1)?.bytesTotal).toBe(body.length);

    // Throttling byte spam must not eat the phase story.
    const phases = [...new Set(events.map((e) => e.phase))];
    expect(phases).toEqual(['downloading', 'verifying', 'extracting', 'installing', 'done']);
  });

  it('lets every chunk through once the interval has elapsed between them', async () => {
    const body = await makeServerZip();
    const chunkCount = Math.ceil(body.length / CHUNK_SIZE);

    const clock: Clock = { nowMs: 0 };
    // Each chunk arrives a full interval after the last, so nothing may be
    // suppressed - this is the counter-test that proves the gate is a clock,
    // not a fraction of events.
    const provisioner = makeProvisioner(
      chunkedStub(body, () => {
        clock.nowMs += PROGRESS_EMIT_INTERVAL_MS + 1;
      }),
      clock
    );
    const { downloads } = await runInstall(provisioner);
    expect(downloads.length).toBeGreaterThanOrEqual(chunkCount);
  });
});
