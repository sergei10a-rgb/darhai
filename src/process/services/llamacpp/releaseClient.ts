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

    let response: Response;
    try {
      response = await this.deps.fetch(url, {
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      });
    } catch (err) {
      throw new LlamaReleaseError('LLAMACPP_OFFLINE', err instanceof Error ? err.message : String(err));
    }
    if (!response.ok) {
      throw new LlamaReleaseError(
        'LLAMACPP_RELEASE_FETCH_FAILED',
        `${url} -> ${response.status} ${response.statusText || ''}`.trim()
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new LlamaReleaseError(
        'LLAMACPP_RELEASE_MALFORMED',
        `release JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!body || typeof body !== 'object') {
      throw new LlamaReleaseError('LLAMACPP_RELEASE_MALFORMED', 'release body is not an object');
    }
    const record = body as Record<string, unknown>;
    const resolvedTag = typeof record.tag_name === 'string' ? record.tag_name : '';
    if (resolvedTag.length === 0) {
      throw new LlamaReleaseError('LLAMACPP_RELEASE_MALFORMED', 'release has no tag_name');
    }
    const rawAssets = Array.isArray(record.assets) ? record.assets : [];
    const assets = rawAssets.map(toAsset).filter((a): a is LlamaReleaseAsset => a !== null);
    if (assets.length === 0) {
      throw new LlamaReleaseError('LLAMACPP_RELEASE_MALFORMED', `release ${resolvedTag} lists no usable assets`);
    }
    return { tag: resolvedTag, assets };
  }
}
