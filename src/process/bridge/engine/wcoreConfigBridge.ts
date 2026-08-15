/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge for the Wayland Core engine `config.toml` sections + profile
 * directories. Wires the typed `ipcBridge.wcoreConfig` / `ipcBridge.wcoreProfiles`
 * surfaces over the main-process `configBridge` + `profileStore` helpers.
 *
 * SECURITY (SEC-6) - HUMAN/RENDERER ONLY. `wcoreConfig.setSection` mutates the
 * engine's security-load-bearing runtime config. It is remote-denied in
 * `bridgeAllowlist.ts` and must NEVER be exposed to the agent/engine tool
 * surface: an agent that could call it could rewrite its own tool allow-list,
 * weaken approvals, or force a secret into the bash sandbox.
 *
 * The env-passthrough allowlist is the highest-risk field: it names which
 * environment variables reach sandboxed tools. This bridge therefore SANITISES
 * the `[security].env_passthrough` array on the way in - it strips any entry
 * whose name matches a sensitive pattern (API_KEY / SECRET / TOKEN / ...), and
 * it only ever stores NAMES (a passthrough allowlist is names-only by
 * construction; there is no value field). There is no "force-allow" path.
 */

import { getSection, setSection } from '@process/agent/wcore/configBridge';
import { resolveActiveConfigPath } from '@process/agent/wcore/profilePaths';
import { initWcoreProfileIpc } from '@process/agent/wcore/profileStore';
import { ipcBridge } from '@/common';

/**
 * Names matching this pattern are considered sensitive and are NEVER written to
 * the env-passthrough allowlist, even if a caller asks. Mirrors the renderer's
 * input-side rejection so the rule is enforced on BOTH sides (defence in depth).
 */
const SENSITIVE_ENV_RE = /(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE[_-]?KEY|SESSION)/i;

/** True if `name` is a sensitive env var name that must not be passed through. */
export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_RE.test(name);
}

/**
 * Sanitise the `[security]` section before persisting: the `env_passthrough`
 * array is filtered to safe, deduplicated NAMES only. Any other keys are
 * preserved verbatim (lossless). Returns a NEW object - never mutates input.
 */
export function sanitizeSecuritySection(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  const raw = value.env_passthrough;
  if (Array.isArray(raw)) {
    const seen = new Set<string>();
    const safe: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const name = entry.trim();
      // Names-only allowlist: reject anything that is not a bare env var name,
      // and reject sensitive names outright (SEC-6).
      if (name.length === 0 || name.length > 128) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      if (isSensitiveEnvName(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      safe.push(name);
    }
    out.env_passthrough = safe;
  }
  return out;
}

/**
 * Initialise the Wayland Core config + profile IPC handlers.
 *
 * `getSection` is a read; `setSection` is the human-only, remote-denied mutator
 * that always targets the real user `config.toml` (no caller-supplied path) and
 * sanitises the security section on the way in.
 */
export function initWcoreConfigBridge(): void {
  ipcBridge.wcoreConfig.getSection.provider(async ({ section }) => {
    return getSection<Record<string, unknown>>(section);
  });

  // Read-only: where the ACTIVE profile's config.toml really lives, so the
  // settings panes can name the file instead of guessing at it.
  ipcBridge.wcoreConfig.getConfigPath.provider(async () => {
    return resolveActiveConfigPath();
  });

  ipcBridge.wcoreConfig.setSection.provider(async ({ section, value }) => {
    try {
      const payload = section === 'security' ? sanitizeSecuritySection(value) : value;
      await setSection(section, payload);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  initWcoreProfileIpc();
}
