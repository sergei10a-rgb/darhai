/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The release-metadata lookup must not be able to hang forever.
 *
 * On a captive portal or blackholed DNS a `fetch` can sit unresolved for
 * minutes, and `plan()` was an unbounded spinner for exactly that long - the
 * one moment a user who just read "512.8 MB" is most likely to press Cancel.
 * These tests hold `getJson` to a hard deadline: a fetch that has not answered
 * within {@link RELEASE_FETCH_TIMEOUT_MS} is aborted and surfaces as the same
 * typed `LLAMACPP_OFFLINE` a refused connection does, because to the user both
 * are one fact: the network did not answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LlamaReleaseClient,
  LlamaReleaseError,
  RELEASE_FETCH_TIMEOUT_MS,
} from '@process/services/llamacpp/releaseClient';

/** A fetch that never settles on its own but honours its AbortSignal. */
const hangingFetch: typeof globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
  })) as typeof globalThis.fetch;

const RELEASE_BODY = JSON.stringify({
  tag_name: 'b10437',
  assets: [
    {
      name: 'llama-b10437-bin-win-cpu-x64.zip',
      browser_download_url: 'https://example.invalid/a.zip',
      size: 10,
      digest: `sha256:${'a'.repeat(64)}`,
    },
  ],
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LlamaReleaseClient - metadata fetch deadline', () => {
  it('aborts a hung fetch after the timeout with the typed offline error', async () => {
    const client = new LlamaReleaseClient({ fetch: hangingFetch });
    const settled = client.fetchRelease().then(
      () => 'resolved',
      (err: unknown) => err
    );
    await vi.advanceTimersByTimeAsync(RELEASE_FETCH_TIMEOUT_MS + 1);
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(LlamaReleaseError);
    const error = outcome as LlamaReleaseError;
    expect(error.code).toBe('LLAMACPP_OFFLINE');
    // The message names the deadline, so a log reader can tell a timeout from
    // a refused connection even though the code is shared.
    expect(error.message).toContain(String(RELEASE_FETCH_TIMEOUT_MS));
  });

  it('applies the same deadline to listRecent', async () => {
    const client = new LlamaReleaseClient({ fetch: hangingFetch });
    const settled = client.listRecent().then(
      () => 'resolved',
      (err: unknown) => err
    );
    await vi.advanceTimersByTimeAsync(RELEASE_FETCH_TIMEOUT_MS + 1);
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(LlamaReleaseError);
    expect((outcome as LlamaReleaseError).code).toBe('LLAMACPP_OFFLINE');
  });

  it('a fetch that answers inside the deadline is untouched', async () => {
    const fetchStub: typeof globalThis.fetch = (async () =>
      new Response(RELEASE_BODY, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const client = new LlamaReleaseClient({ fetch: fetchStub });
    const release = await client.fetchRelease();
    expect(release.tag).toBe('b10437');
    expect(release.assets).toHaveLength(1);
  });

  it('does not fire the abort after a completed request', async () => {
    // The timer must be cleared on success; a stray abort firing later must
    // not reject anything or leak an unhandled rejection.
    const fetchStub: typeof globalThis.fetch = (async () =>
      new Response(RELEASE_BODY, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof globalThis.fetch;
    const client = new LlamaReleaseClient({ fetch: fetchStub });
    await client.fetchRelease();
    await vi.advanceTimersByTimeAsync(RELEASE_FETCH_TIMEOUT_MS * 2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
