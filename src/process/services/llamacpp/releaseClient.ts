/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitHub Releases lookup for ggml-org/llama.cpp.
 *
 * The only reason this exists as its own layer is the digest. GitHub's release
 * API returns a per-asset `digest` field (`"sha256:<hex>"`, verified present on
 * b10437 and on every older release sampled back to b10284), which is the
 * integrity anchor for the whole provisioner: the archive is checked against
 * what the API said, not against a length or a content-type the transfer itself
 * supplied. An asset with no digest is refused rather than trusted.
 */

/** Errors this layer raises. */
export type LlamaReleaseErrorCode = 'LLAMACPP_OFFLINE' | 'LLAMACPP_RELEASE_FETCH_FAILED' | 'LLAMACPP_RELEASE_MALFORMED';

export class LlamaReleaseError extends Error {
  constructor(
    public readonly code: LlamaReleaseErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'LlamaReleaseError';
  }
}

/** One downloadable release asset. */
export type LlamaReleaseAsset = {
  name: string;
  url: string;
  bytes: number;
  /** Lowercase hex sha256 from the API, or null when the API served none. */
  sha256: string | null;
};

export type LlamaRelease = {
  tag: string;
  assets: LlamaReleaseAsset[];
};

const DEFAULT_REPO = 'ggml-org/llama.cpp';
const API_BASE = 'https://api.github.com';

/**
 * Hard deadline for one metadata request, headers AND body.
 *
 * On a captive portal or blackholed DNS a fetch can sit unresolved for
 * minutes, and `plan()` was an unbounded spinner for exactly that long - the
 * one moment a user who just read a download size is most likely to press
 * Cancel, and the one window where the provisioner's own AbortController does
 * not exist yet. The healthy case is nowhere near this: the metadata fetch
 * MEASURED 595 ms on the reference machine, so 15 s is ~25x headroom.
 */
export const RELEASE_FETCH_TIMEOUT_MS = 15_000;

/**
 * How many recent releases {@link LlamaReleaseClient.listRecent} asks for.
 *
 * MEASURED on 2026-08-15: ggml-org/llama.cpp published b10434, b10435, b10436,
 * b10437, b10441 and b10442 inside 19.5 h, and each one's 26 assets finished
 * uploading 88-134 s after the release itself was created. Six is therefore
 * about a day of history - far more than the one or two steps a walk-back past
 * a still-uploading release needs, and still a single API request.
 */
const RECENT_RELEASE_COUNT = 6;

export type LlamaReleaseClientDeps = {
  fetch: typeof globalThis.fetch;
  repo: string;
};

/** Pull the `sha256:<hex>` half out of GitHub's digest field. */
function parseDigest(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(raw.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Map one raw API asset object into our shape, or null when unusable. */
function toAsset(raw: unknown): LlamaReleaseAsset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name : '';
  const url = typeof r.browser_download_url === 'string' ? r.browser_download_url : '';
  if (name.length === 0 || url.length === 0) return null;
  const size = typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : 0;
  return { name, url, bytes: size, sha256: parseDigest(r.digest) };
}

/** Every usable asset of one raw release record. */
function assetsOf(record: Record<string, unknown>): LlamaReleaseAsset[] {
  const raw = Array.isArray(record.assets) ? record.assets : [];
  return raw.map(toAsset).filter((a): a is LlamaReleaseAsset => a !== null);
}

/**
 * Fetch a llama.cpp release. Omit `tag` for the latest.
 *
 * Note the deliberate asymmetry with `ModelDownloadManager`: a GGUF on Hugging
 * Face carries no pinned hash, so that path warns and proceeds. A GitHub
 * release asset does carry one, so this path has no reason to be lenient.
 */
export class LlamaReleaseClient {
  private readonly deps: LlamaReleaseClientDeps;

  constructor(deps?: Partial<LlamaReleaseClientDeps>) {
    this.deps = {
      fetch: (input, init) => globalThis.fetch(input, init),
      repo: DEFAULT_REPO,
      ...deps,
    };
  }

  async fetchRelease(tag?: string): Promise<LlamaRelease> {
    const suffix = tag ? `/tags/${encodeURIComponent(tag)}` : '/latest';
    const url = `${API_BASE}/repos/${this.deps.repo}/releases${suffix}`;
    const body = await this.getJson(url);

    if (!body || typeof body !== 'object') {
      throw new LlamaReleaseError('LLAMACPP_RELEASE_MALFORMED', 'release body is not an object');
    }
    const record = body as Record<string, unknown>;
    const resolvedTag = typeof record.tag_name === 'string' ? record.tag_name : '';
    if (resolvedTag.length === 0) {
      throw new LlamaReleaseError('LLAMACPP_RELEASE_MALFORMED', 'release has no tag_name');
    }
    const assets = assetsOf(record);
    if (assets.length === 0) {
      // A release created seconds ago genuinely has none yet - GitHub creates
      // the release first and uploads afterwards. Callers resolving `latest`
      // treat this as "ask an older one", not as "this repo is broken".
      throw new LlamaReleaseError('LLAMACPP_RELEASE_MALFORMED', `release ${resolvedTag} lists no usable assets`);
    }
    return { tag: resolvedTag, assets };
  }

  /**
   * The most recent releases, newest first, skipping drafts and any release
   * that lists no usable asset yet.
   *
   * This exists for one reason: a GitHub release is published BEFORE its assets
   * finish uploading, so `latest` can name a release that does not yet contain
   * the archive this machine needs. MEASURED on ggml-org/llama.cpp b10442
   * (2026-08-15): created 14:58:24Z, first asset +15 s, `win-cpu-x64` +53 s,
   * last asset +92 s - and the five releases before it took 88-134 s. Without a
   * second opinion, everything resolved inside that window reports the machine
   * as having no build at all. See {@link LlamaCppProvisioner.plan}.
   *
   * `/releases` (unlike `/latest`) also lists prereleases; llama.cpp marks none
   * of its `b*` builds as one, and a prerelease that shipped the asset is still
   * a better answer than "your computer cannot run local models".
   */
  async listRecent(limit: number = RECENT_RELEASE_COUNT): Promise<LlamaRelease[]> {
    const url = `${API_BASE}/repos/${this.deps.repo}/releases?per_page=${limit}`;
    const body = await this.getJson(url);
    if (!Array.isArray(body)) {
      throw new LlamaReleaseError('LLAMACPP_RELEASE_MALFORMED', 'release list body is not an array');
    }
    const releases: LlamaRelease[] = [];
    for (const raw of body) {
      if (!raw || typeof raw !== 'object') continue;
      const record = raw as Record<string, unknown>;
      if (record.draft === true) continue;
      const tag = typeof record.tag_name === 'string' ? record.tag_name : '';
      if (tag.length === 0) continue;
      const assets = assetsOf(record);
      if (assets.length === 0) continue;
      releases.push({ tag, assets });
    }
    return releases;
  }

  /**
   * One GET against the API, with this layer's error codes.
   *
   * Bounded by {@link RELEASE_FETCH_TIMEOUT_MS}: the AbortController covers
   * the whole exchange - a fetch whose headers never arrive AND a body that
   * stalls mid-stream both abort - and surfaces as `LLAMACPP_OFFLINE`, because
   * to the caller a network that will not answer and a network that is absent
   * are the same fact. The message still names the deadline so a log reader
   * can tell the two apart.
   */
  private async getJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
    const timedOut = (): boolean => controller.signal.aborted;
    try {
      let response: Response;
      try {
        response = await this.deps.fetch(url, {
          headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
          signal: controller.signal,
        });
      } catch (err) {
        throw new LlamaReleaseError(
          'LLAMACPP_OFFLINE',
          timedOut()
            ? `${url}: no response within ${RELEASE_FETCH_TIMEOUT_MS} ms`
            : err instanceof Error
              ? err.message
              : String(err)
        );
      }
      if (!response.ok) {
        throw new LlamaReleaseError(
          'LLAMACPP_RELEASE_FETCH_FAILED',
          `${url} -> ${response.status} ${response.statusText || ''}`.trim()
        );
      }
      try {
        return await response.json();
      } catch (err) {
        if (timedOut()) {
          throw new LlamaReleaseError(
            'LLAMACPP_OFFLINE',
            `${url}: response body stalled past ${RELEASE_FETCH_TIMEOUT_MS} ms`
          );
        }
        throw new LlamaReleaseError(
          'LLAMACPP_RELEASE_MALFORMED',
          `release JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      clearTimeout(deadline);
    }
  }
}
