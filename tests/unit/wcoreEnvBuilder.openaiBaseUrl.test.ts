/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The engine's INTERNAL tools need OPENAI_BASE_URL, not just `--base-url`.
 *
 * `--base-url` steers the engine's own chat completions. Its bundled tools
 * (video_analyze and the other vision helpers) build a separate OpenAI client
 * from the OPENAI_BASE_URL environment variable, so without it they hit
 * api.openai.com with the user's provider key. Measured live on an OpenRouter
 * chat: `video_analyze` returned "Incorrect API key provided: sk-or-v1***",
 * the agent looped retrying the failure, and one video attachment consumed
 * 1.4M tokens.
 *
 * The two carry DIFFERENT shapes on purpose: the engine appends
 * `/v1/chat/completions` to `--base-url` (so the trailing `/v1` is stripped),
 * while OPENAI_BASE_URL follows the OpenAI SDK convention and keeps it.
 */

import { describe, expect, it } from 'vitest';
import { buildSpawnConfig } from '../../src/process/agent/wcore/envBuilder';
import type { TProviderWithModel } from '../../src/common/config/storage';

const OPTS = { workspace: '/tmp/ws' };

const makeModel = (over: Partial<TProviderWithModel> = {}): TProviderWithModel =>
  ({
    id: 'uuid-1',
    platform: 'openai-compatible',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'sk-or-v1-test',
    useModel: 'anthropic/claude-opus-5-fast',
    model: ['anthropic/claude-opus-5-fast'],
    ...over,
  }) as TProviderWithModel;

const flagValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

describe('buildSpawnConfig: OPENAI_BASE_URL for engine-internal tools', () => {
  it('exports OPENAI_BASE_URL with the /v1 suffix intact', () => {
    const { env } = buildSpawnConfig(makeModel(), OPTS as never);
    expect(env.OPENAI_BASE_URL).toBe('https://openrouter.ai/api/v1');
  });

  it('still passes --base-url stripped of the trailing /v1 (engine convention)', () => {
    const { args } = buildSpawnConfig(makeModel(), OPTS as never);
    expect(flagValue(args, '--base-url')).toBe('https://openrouter.ai/api');
  });

  it('the two forms differ - stripping both would double the /v1 on chat calls', () => {
    const { args, env } = buildSpawnConfig(makeModel(), OPTS as never);
    expect(env.OPENAI_BASE_URL).not.toBe(flagValue(args, '--base-url'));
  });

  it('carries the provider key alongside, so tools authenticate against the same host', () => {
    const { env } = buildSpawnConfig(makeModel(), OPTS as never);
    expect(env.OPENAI_API_KEY).toBe('sk-or-v1-test');
  });

  it('a keyless local backend still gets its loopback URL exported', () => {
    const { env } = buildSpawnConfig(
      makeModel({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' }),
      OPTS as never
    );
    expect(env.OPENAI_BASE_URL).toBe('http://127.0.0.1:11434/v1');
    // Placeholder key: the engine hard-requires one for --provider openai.
    expect(env.OPENAI_API_KEY).toBeTruthy();
  });

  it('a model with no base URL exports none (the engine falls back to its own default)', () => {
    const { args, env } = buildSpawnConfig(makeModel({ baseUrl: '' }), OPTS as never);
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(args).not.toContain('--base-url');
  });
});
