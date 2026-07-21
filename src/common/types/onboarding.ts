/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Result of the first-run onboarding environment detection.
 *
 * Lives in `common` so both the main-process detector (`process/onboarding`)
 * and the renderer hook (`useOnboardingDetection`) share one shape without
 * the renderer importing Node-only main-process modules.
 *
 * This file must stay renderer-safe: no `node:` imports, no Electron imports.
 */
export type DetectionResult = {
  /** The user's display name (OS account name or resolved real name). */
  name: string;
  /** CLI tools found on PATH (e.g. `codex`, `claude`, `cursor`, `aider`). */
  clis: string[];
  /**
   * Execution engines found by the app's unified `AgentRegistry` - the same
   * scan that powers the model picker (Claude Code, Codex, Qwen Code, Kimi CLI,
   * OpenCode, Hermes, OpenClaw Gateway, Gemini CLI, Wayland Core, …). `kind` is
   * the registry `DetectedAgentKind` (`acp` | `gemini` | `wcore` |
   * `openclaw-gateway` | `nanobot` | `remote`).
   */
  agents: { id: string; kind: string; name: string }[];
  /** Provider env keys discovered in the shell environment / config files. */
  envKeys: string[];
  /** Whether a Claude Pro / `~/.claude` install was detected. */
  claudePro: boolean;
  /** Local Ollama daemon state. */
  ollama: {
    running: boolean;
    models: string[];
  };
};

/**
 * Result of connecting a single pasted API key during onboarding
 * (`ipcBridge.onboarding.connectPastedKey`). The provider is auto-detected via
 * the real `ProviderDetector` + `SkRaceResolver`, so a bare `sk-` key shared by
 * OpenAI/DeepSeek/Moonshot/Qwen is resolved to its true owner by live probe.
 *
 * `providerId` is the resolved/attempted registry provider id, surfaced so the
 * UI can confirm ("DeepSeek connected") or point to Settings on `needs-fields`.
 * Error reasons: `unrecognized` (not a known key shape), `no-match` (raced but
 * nothing accepted it), `needs-fields` (provider needs more than a key),
 * `failed` (detected but the connect/test did not stick).
 */
export type ConnectPastedKeyResult =
  | { ok: true; providerId: string }
  | { ok: false; error: 'unrecognized' | 'no-match' | 'needs-fields' | 'failed'; providerId?: string };
