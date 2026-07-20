/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge allowlist (C1 hardening).
 *
 * The preload contract (`electronAPI.emit`) forwards arbitrary (name, data)
 * tuples from the renderer into the main-process bridge emitter. Without an
 * allowlist, a renderer XSS could call dangerous providers directly
 * (fs.writeFile, fs.removeEntry, shell.openExternal, etc.).
 *
 * This module is the single source of truth for which event names are
 * permitted to cross the renderer→main boundary. It works by wrapping the
 * platform's `bridge.buildProvider` / `bridge.buildEmitter` factories: every
 * declared key is recorded here at module-load time, and only those keys
 * (with their `subscribe-` / `subscribe.callback-` wire prefixes) are
 * accepted by the inbound dispatcher.
 *
 * Wire-protocol shape (see @office-ai/platform):
 *   - provider invocation: renderer → main as `subscribe-<key>`
 *   - provider response  : main → renderer as `subscribe.callback-<key><id>`
 *     (renderer-side providers reverse this - see RENDERER_PROVIDED_KEYS)
 *   - emitter event      : main → renderer as `<key>` (renderer never
 *     re-emits these inbound)
 *
 * A small set of constant control names (heartbeat, auth) is also allowed.
 */

import { bridge, storage } from '@office-ai/platform';

/** Keys registered via `buildProvider` (main-process providers, renderer invokes). */
const providerKeys = new Set<string>();

/** Keys registered via `buildEmitter` (main → renderer events). */
const emitterKeys = new Set<string>();

/**
 * Keys whose `provider` is registered in the RENDERER (so main `invoke`s and
 * renderer responds via `subscribe.callback-<key><id>`). The renderer is the
 * only side that emits the callback wire name for these keys, so the inbound
 * dispatcher must accept `subscribe.callback-<key>...` for each of them.
 *
 * Keep this list exhaustive - adding a renderer-side `.provider(fn)` requires
 * adding the key here.
 */
const RENDERER_PROVIDED_KEYS: ReadonlySet<string> = new Set([
  // src/renderer/pages/conversation/Workspace/hooks/useWorkspaceEvents.ts
  'conversation.response.search.workspace',
]);

/**
 * Control-plane names that don't go through buildProvider/buildEmitter but
 * are legitimate wire messages renderer → main (or webui → main).
 */
const CONTROL_ALLOWED: ReadonlySet<string> = new Set([
  // WebSocket heartbeat (browser webui only - Electron preload doesn't send pong,
  // but listing here keeps the allowlist consistent across both dispatchers).
  'pong',
  'ping',
  // File-selection bridge (WebUI mode). Browser sends `subscribe-show-open`
  // which the WebSocketManager intercepts BEFORE invoking the bridge emitter,
  // so it never reaches the dispatcher. Listed for documentation only.
]);

/**
 * Wrap `bridge.buildProvider` so every declared provider key is recorded.
 *
 * Returned object is identical in shape and behavior to the platform's
 * `buildProvider` - this is a pure side-effect wrapper.
 */
export function buildProvider<Data extends unknown, Params extends unknown = undefined>(
  key: string
): ReturnType<typeof bridge.buildProvider<Data, Params>> {
  providerKeys.add(key);
  return bridge.buildProvider<Data, Params>(key);
}

/**
 * Wrap `bridge.buildEmitter` so every declared emitter key is recorded.
 */
export function buildEmitter<Params extends unknown = undefined>(
  key: string
): ReturnType<typeof bridge.buildEmitter<Params>> {
  emitterKeys.add(key);
  return bridge.buildEmitter<Params>(key);
}

/**
 * Wrap `storage.buildStorage` so every namespace's `get`/`set`/`clear`/`remove`
 * wire key is recorded in the allowlist. The platform's internal `buildStorage`
 * calls `bridge.buildProvider` directly (NOT our wrapped `buildProvider`), so
 * without this wrapper every storage namespace silently bypasses C1.
 *
 * Wire keys per namespace (from @office-ai/platform internals):
 *   `<namespace>.storage.get`
 *   `<namespace>.storage.set`
 *   `<namespace>.storage.clear`
 *   `<namespace>.storage.remove`
 *
 * Behavior is otherwise identical to `storage.buildStorage` - pure side-effect
 * wrapper for allowlist registration.
 */
export function buildStorage<Refer = unknown>(
  namespace: string,
  options?: { debug: boolean }
): ReturnType<typeof storage.buildStorage<Refer>> {
  providerKeys.add(`${namespace}.storage.get`);
  providerKeys.add(`${namespace}.storage.set`);
  providerKeys.add(`${namespace}.storage.clear`);
  providerKeys.add(`${namespace}.storage.remove`);
  return options ? storage.buildStorage<Refer>(namespace, options) : storage.buildStorage<Refer>(namespace);
}

/**
 * Provider keys that a REMOTE (paired-device WebSocket) caller must never reach,
 * even though they pass {@link isAllowedInboundName} (which only gates the set of
 * names the trusted local renderer may use). The WebSocket token proves a paired
 * browser, not the local trusted user, so these write/exec/mutation providers are
 * default-DENIED for remote callers (WS-POSTAUTH-DISPATCH).
 *
 * This is a denylist, not a tiny whitelist: everything the paired WebUI legitimately
 * needs (conversation/chat/list/model/usage/memory/wiki/cron reads, etc.) stays
 * allowed; only the dangerous write/exec/install surface is removed.
 *
 * Matching is by key (the part after the `subscribe-` wire prefix), using exact
 * keys plus a small set of prefixes that cover whole dangerous namespaces.
 */
const REMOTE_DENIED_PREFIXES: readonly string[] = [
  // Shell execution / open-with handlers (cmd/explorer, open, xdg-open).
  'shell.',
  // Hub extension install/update/retry/uninstall - remote-reachable RCE chain.
  'hub.',
  // Cost observability (WS-D). There is no remote cost view today, so deny the
  // ENTIRE cost.* namespace to paired-device WebSocket callers: the read
  // aggregates (summary/byModel/byBackend/byConversation/byTeam/series) plus the
  // WS-F budget mutations (cost.upsertBudget / cost.deleteBudget) that land
  // later. byConversation/series in particular disclose per-conversation usage
  // and a fine-grained activity timeline. Local-renderer-only surface.
  'cost.',
  // Cookbook serve (download + auto-serve local models). The whole cookbook.*
  // namespace is remote-denied: `download` pulls a multi-GB GGUF and `serve`
  // spawns a llama-server / runs `ollama pull` on the host - a host-side
  // DoS/exec class a paired-device WebSocket caller must never drive. Even the
  // read verbs (list-downloads / serve-status / detect-backend) are denied for
  // consistency; they expose host-side install + model-cache state. The
  // renderer-local Model Advisor UI is unaffected; only remote WS callers are
  // blocked (matches how hwfit.* is denied wholesale).
  'cookbook.',
];
// Note: fs provider keys are registered WITHOUT an `fs.` prefix on the wire
// (e.g. `write-file`, `remove-entry`), so the dangerous fs surface is enumerated
// explicitly in REMOTE_DENIED_KEYS below rather than matched by prefix.

/**
 * Exact provider keys denied to remote WS callers. Covers the fs mutation/raw-read
 * surface (registered without an `fs.` wire prefix), skill/assistant mutation, MCP
 * agent-install mutation, and the app.* providers that can write settings, change
 * the CDP config, control startup, or restart the process.
 */
const REMOTE_DENIED_KEYS: ReadonlySet<string> = new Set([
  // --- Filesystem write / delete / rename / temp / raw-buffer reads ---
  'write-file',
  'remove-entry',
  'rename-entry',
  'read-file',
  'read-file-buffer',
  'create-temp-file',
  'create-upload-file',
  'fetch-remote-image',
  'add-custom-external-path',
  'remove-custom-external-path',
  // fs raw-read / enumeration / archive / workspace-copy surface (arbitrary path access).
  'get-file-metadata',
  'get-file-by-dir',
  'list-workspace-files',
  'get-image-base64',
  'create-zip-file',
  'copy-files-to-workspace',
  // --- Skill / assistant mutation (delete/write/import) ---
  'delete-skill',
  'delete-assistant-rule',
  'delete-assistant-skill',
  'write-assistant-rule',
  'write-assistant-skill',
  'import-skill',
  'skills.build.draft',
  'skills.import.folder',
  'skills.import.git',
  'skills.import.single-skill-md',
  'skills.import.zip',
  'skills.rescan-all',
  'skills.scan',
  'skills.set-pinned',
  // --- Model registry secret/write IPC (audit C4). `resolveForChatStart`
  //     returns a DECRYPTED plaintext provider key; connect/rekey/detectKeys
  //     mutate or disclose stored credentials. A paired WebUI must never reach
  //     these or it can harvest every stored provider key. ---
  'modelRegistry.connect',
  'modelRegistry.rekey',
  'modelRegistry.detectKeys',
  'modelRegistry.resolveForChatStart',
  // --- Wayland Core tool-backend key mutation (plant/clear a search API key) ---
  'wcoreToolKeys.set',
  'wcoreToolKeys.delete',
  // --- Wayland Core engine config.toml mutation (rewrite tool allow-list /
  //     sandbox policy / env passthrough). A remote caller reaching this could
  //     disable the sandbox or force-allow secrets into bash (SEC-6). ---
  'wcoreConfig.setSection',
  // Also deny the read: it discloses the engine's security/tools posture to a
  // paired WebUI client (no secret values, but defence-in-depth — SEC review F2).
  'wcoreConfig.getSection',
  // --- Wayland Core profile fs mutation (create/clone/activate/delete profile
  //     directories under the profiles root). Remote-denied (SEC-4). ---
  'wcoreProfiles.create',
  'wcoreProfiles.clone',
  'wcoreProfiles.activate',
  'wcoreProfiles.remove',
  // --- Asleep-engine pending-send store (SEC-8). Message bodies are PII/secrets
  //     held in main-process memory only. A remote caller must never read a held
  //     body (take/peek) or inject one (hold), nor drop another user's hold. ---
  'pendingSend.hold',
  'pendingSend.take',
  'pendingSend.peek',
  'pendingSend.clear',
  // --- Channel pairing (codes grant a remote user access to the assistant).
  //     Reading the pending codes discloses live access tokens; approve/reject
  //     mutate authorization. A paired WebUI must never harvest a pending code
  //     or self-approve, so deny all three to remote WS callers. ---
  'channel.get-pending-pairings',
  'channel.approve-pairing',
  'channel.reject-pairing',
  // --- Channel config / authorization mutation + disclosure. Same threat class
  //     as the pairing trio above: a paired WebUI must never reconfigure a
  //     channel (enable/disable a plugin, rotate the webhook token, sync
  //     settings such as WhatsApp mode='dedicated' + ownerNumbers which
  //     auto-authorizes an arbitrary number), revoke/disclose authorized users,
  //     or fire test-plugin (an outbound network call made with caller-supplied
  //     credentials). The read-only status providers the WebUI legitimately
  //     needs (channel.get-plugin-status / get-active-sessions /
  //     get-webhook-exposure and the channel.*-changed event emitters) stay
  //     allowed. ---
  'channel.enable-plugin',
  'channel.disable-plugin',
  'channel.rotate-webhook-token',
  'channel.sync-channel-settings',
  'channel.revoke-user',
  'channel.get-authorized-users',
  'channel.test-plugin',
  // --- WebUI admin auth surface (WS-POSTAUTH). The webui.* bridge providers are
  //     registered via buildProvider, so a paired-device WS caller passes
  //     isAllowedInboundName and reaches them with NO in-handler remote guard
  //     (unlike the gated `webui-direct-*` ipcMain handlers). These mint/return
  //     admin credentials or mutate auth: `start` returns the initial password,
  //     `reset-password` broadcasts a new plaintext admin password to every
  //     paired client, `change-password`/`change-username` rewrite the admin
  //     login with NO current-password check, `generate-qr-token` /
  //     `verify-qr-token` mint a full admin session token, and `stop` /
  //     `revoke-device` disrupt access. Deny all to remote callers; the
  //     read-only views (webui.get-status / list-paired-devices / activity-log)
  //     stay allowed for the paired UI. ---
  'webui.start',
  'webui.stop',
  'webui.change-password',
  'webui.change-username',
  'webui.reset-password',
  'webui.generate-qr-token',
  'webui.verify-qr-token',
  'webui.revoke-device',
  // --- Onboarding credential writes. connect-pasted-key persists a
  //     caller-supplied provider key (remote credential injection / overwrite of
  //     the legitimate key); connect-flux mints + persists a Flux provider
  //     credential via OAuth. Same class as modelRegistry.connect /
  //     wcoreToolKeys.set (already denied). The read-only onboarding.infer-focus
  //     stays allowed. ---
  'onboarding.connect-pasted-key',
  'onboarding.connect-flux',
  // --- Cost observability (WS-D / WS-F). The whole cost.* namespace is already
  //     denied to remote callers via the `cost.` prefix above; these exact keys
  //     are enumerated for documentation + defence-in-depth. byConversation +
  //     series leak per-conversation usage and a fine-grained activity timeline;
  //     upsertBudget / deleteBudget (added by WS-F) are mutations a paired WebUI
  //     must never reach. ---
  'cost.byConversation',
  'cost.series',
  'cost.upsertBudget',
  'cost.deleteBudget',
  'cost.listBudgets',
  // --- MCP mutation (agent install/remove, OAuth login/logout, credential set) ---
  'mcp.sync-to-agents',
  'mcp.remove-from-agents',
  'mcp.login-oauth',
  'mcp.logout-oauth',
  'mcp.set-byo-oauth-credentials',
  // --- Project knowledge draft (reads arbitrary filePaths to feed the model) ---
  'project.generate-knowledge-draft',
  // --- Hardware-fit model advisor (host probe). scan-hardware spawns
  //     nvidia-smi / rocminfo / sysctl / a PowerShell WMI probe on the host;
  //     rank-models falls through to scan-hardware when no hardwareOverride is
  //     supplied, so it too kicks off host probes. A paired-device WebSocket
  //     caller must not be able to drive these — repeated remote invocations
  //     amplify into a host-process spawn DoS. catalog-size is denied for
  //     consistency (it exposes the same read-only host-side surface). The
  //     renderer-local UI is unaffected; only remote WS callers are blocked. ---
  'hwfit.scan-hardware',
  'hwfit.rank-models',
  'hwfit.catalog-size',
  // --- Compare (Odysseus #6): runs a prompt through several models at once.
  //     Spends tokens and makes outbound provider calls (fan-out amplification),
  //     so a paired-device WebSocket caller must never drive it - only the
  //     trusted local user compares models. The local renderer UI is unaffected. ---
  'compare.run',
  // --- Fusion (OmniRoute idea): panel fan-out + a judge synthesis call. Spends
  //     even more tokens than compare, so a paired-device WebSocket caller must
  //     never drive it - local user only. ---
  'fusion.run',
  // --- Notes (Odysseus #9): every mutating verb writes persisted user content.
  //     A paired-device WebSocket caller must never create/edit/delete/reorder a
  //     note or flip its pin/archive/checklist state - only the trusted local
  //     user owns their notes. The read verbs (note.list / note.get) follow the
  //     cron read policy and stay allowed for the paired UI. ---
  'note.create',
  'note.update',
  'note.delete',
  'note.toggle-pin',
  'note.toggle-archive',
  'note.toggle-item',
  'note.reorder',
  // --- Calendar (Odysseus "calendar"): every mutating verb writes persisted user
  //     content. A paired-device WebSocket caller must never create/edit/delete an
  //     event - only the trusted local user owns their calendar. The read verbs
  //     (calendar.list / calendar.get) follow the cron read policy and stay allowed
  //     for the paired UI. ---
  'calendar.create',
  'calendar.update',
  'calendar.delete',
  // --- Documents (Odysseus "documents"): every mutating verb writes persisted
  //     user content, and the AI verbs (ai-edit / ai-suggest) spend model tokens +
  //     make outbound provider calls. A paired-device WebSocket caller must never
  //     create/edit/delete a document or drive an AI edit/suggest - only the trusted
  //     local user owns their documents. The read verbs (documents.list /
  //     documents.get) follow the cron read policy and stay allowed for the paired
  //     UI. Distinct from the untouched `document.convert` namespace. ---
  'documents.create',
  'documents.update',
  'documents.delete',
  'documents.ai-edit',
  'documents.ai-suggest',
  // --- Deep Research (Odysseus "deep research"): a run spends the user's search +
  //     LLM keys and makes many outbound calls (fan-out amplification); cancel stops
  //     a run. A paired-device WebSocket caller must never drive or stop a run - only
  //     the trusted local user. The read verbs (research.get-run / research.list-runs)
  //     follow the cron read policy and stay allowed for the paired UI. ---
  'research.start',
  'research.cancel',
  // --- Email AI Triage (Odysseus "email pollers"): send-draft is the single verb
  //     that turns a stored draft into a real outbound email over SMTP. It is a
  //     human-gated action for the trusted local user only; a paired-device
  //     WebSocket caller must never dispatch an email on the user's behalf, so it
  //     is remote-denied. The read verbs (email-triage.list / email-triage.get)
  //     follow the cron read policy and stay allowed for the paired UI. ---
  'email-triage.send-draft',
  // --- Storage destructive / disk operations ---
  'storage:changeDir',
  'storage:clearDir',
  'storage:openDir',
  'storage:resetAll',
  'storage:importBackup',
  // --- ecc harness: persisted config mutation (silently weakens agent gates) ---
  'ecc.set-gate-guard',
  // --- native pre-tool guard: persisted config mutation that gates AGENT TOOL
  //     EXECUTION at the WCore / ACP approval seams. Disabling it drops the
  //     destructive-command DENY floor, so a paired-device WebSocket caller must
  //     never flip it; the read (hookGuard.get-status) stays allowed. ---
  'hookGuard.set-enabled',
  // --- prompt compression: persisted config mutation (changes how prompts are
  //     transformed before every model call). A paired-device WebSocket caller
  //     must never flip it; the read (compression.get-mode) stays allowed. ---
  'compression.set-mode',
  // --- model routing: persisted config mutation (changes which model every
  //     background completion selects). A paired-device WebSocket caller must
  //     never flip it; the read (routing.get-strategy) stays allowed. ---
  'routing.set-strategy',
  // --- OmniRoute gateway (Phase 7b): `set-config` registers/deregisters the
  //     external-relay provider AND stores a credential (the gateway API key);
  //     `test-connection` makes an outbound fetch from the HOST to a
  //     caller-supplied URL. A paired-device WebSocket caller must never flip
  //     the relay on, plant a credential, or drive host-side probes. The read
  //     (omniroute-gateway.get-config) stays allowed - it discloses only
  //     enabled/baseUrl/hasApiKey, never the key itself. ---
  'omniroute-gateway.set-config',
  'omniroute-gateway.test-connection',

  // --- app.* / process control that writes or executes ---
  'app.set-start-on-boot',
  'app.set-zoom-factor',
  'app.update-cdp-config',
  'restart-app',
  'open-external',
  'open-file',
  'open-dev-tools',
  'show-item-in-folder',
]);

/**
 * Return true iff a provider invocation `name` (the full wire name, e.g.
 * `subscribe-write-file`) is permitted for a REMOTE WebSocket caller.
 *
 * This is applied IN ADDITION to {@link isAllowedInboundName}: a name must pass
 * BOTH to be dispatched from the WS path. Non-`subscribe-` names (control-plane
 * heartbeat, renderer-side callbacks) are unaffected here - the inbound allowlist
 * already constrains them and they carry no write/exec capability.
 *
 * @param name Full inbound wire name as received from the WebSocket client.
 * @returns `false` if the resolved provider key is in the remote denylist.
 */
export function isAllowedForRemote(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;

  // Only provider invocations carry capability; everything else (callbacks,
  // heartbeat) is already constrained by isAllowedInboundName.
  if (!name.startsWith('subscribe-')) return true;

  const key = name.slice('subscribe-'.length);
  if (REMOTE_DENIED_KEYS.has(key)) return false;
  for (const prefix of REMOTE_DENIED_PREFIXES) {
    if (key.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Return true iff `name` is a wire event that the renderer (or WebUI client)
 * is permitted to send to the main-process bridge emitter.
 */
export function isAllowedInboundName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;

  // Provider invocation: subscribe-<key>
  if (name.startsWith('subscribe-')) {
    const key = name.slice('subscribe-'.length);
    return providerKeys.has(key);
  }

  // Provider response from renderer-side provider: subscribe.callback-<key><key><id>
  //
  // The platform's actual wire format (verified against @office-ai/platform's
  // emitter source) is `subscribe.callback-${key}${i(key)}` where
  // `i(e) = e + Math.random().toString(16).slice(2,10)`. That expands to
  // `subscribe.callback-${key}${key}${random8hex}` - the key appears TWICE,
  // because the invoker side computes the id as `<key><8hex>` and the
  // emitter then prepends the key again when forming the callback name.
  //
  // An earlier draft of this allowlist expected `subscribe.callback-<key><id>`
  // (single key) and rejected legitimate callbacks, breaking the entire
  // provider response path - search-workspace responses to Claude/ACP
  // sessions stalled until the prompt timed out. Fix: accept the doubled
  // key prefix, then require exactly 8 lowercase hex chars as the suffix.
  if (name.startsWith('subscribe.callback-')) {
    const rest = name.slice('subscribe.callback-'.length);
    for (const key of RENDERER_PROVIDED_KEYS) {
      // Doubled-key form: `<key><key><8hex>` (the actual platform format).
      const doubledPrefix = key + key;
      if (rest.startsWith(doubledPrefix)) {
        const suffix = rest.slice(doubledPrefix.length);
        if (/^[0-9a-f]{8}$/.test(suffix)) return true;
      }
      // Single-key form: `<key><8hex>`. Kept for back-compat in case some
      // platform version (or test fixture) emits without the doubling.
      if (rest.startsWith(key)) {
        const suffix = rest.slice(key.length);
        if (/^[0-9a-f]{8}$/.test(suffix)) return true;
      }
    }
    return false;
  }

  // Control-plane names (heartbeat, etc.).
  return CONTROL_ALLOWED.has(name);
}

/** Test/diagnostics helper - never call from runtime hot paths. */
export function _getRegisteredKeysForTests(): {
  providers: ReadonlySet<string>;
  emitters: ReadonlySet<string>;
} {
  return { providers: providerKeys, emitters: emitterKeys };
}
