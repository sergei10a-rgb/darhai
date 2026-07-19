# 08 process-wcore-engine

## Purpose

Owns the embedded "Darhai Core" execution engine (the `wayland-core` Rust binary): resolving the
binary, spawning it per conversation, speaking its bidirectional JSON-Lines stdio protocol, building
its sandboxed environment, and managing its on-disk config surface (user `config.toml`, per-workspace
`.wcore.toml`, directory-isolated profiles, encrypted tool-backend keys). Also owns `AgentRegistry`,
the central registry of ALL detected execution engines (wcore, Gemini, ACP CLIs, remote, etc.), and
the build-time pipeline that downloads, SHA-verifies and bundles the engine binary into the app.

## Entry points & lifecycle

- **Build time**: `scripts/build-with-builder.js:466` calls `prepareWaylandCore()`
  (`scripts/prepareWaylandCore.js:361`) before electron-builder packs. It places
  `resources/bundled-wayland-core/{platform}-{arch}/wayland-core[.exe]` + `manifest.json`.
- **App start (main process)**: `src/process/bridge/index.ts:143` calls `initWcoreToolKeyIpc()`, then
  `initWcoreConfigBridge()` (`src/process/bridge/wcoreConfigBridge.ts:77`) which wires
  `wcoreConfig.*` and, via `initWcoreProfileIpc()` (`profileStore.ts:200`), `wcoreProfiles.*`.
  `agentRegistry.initialize()` runs at `src/process/bridge/index.ts:158` (also
  `src/process/utils/initBridgeStandalone.ts:102` for standalone mode).
- **Per conversation**: `src/process/services/ConversationServiceImpl.ts:201` →
  `createWCoreAgent()` (`src/process/utils/initAgent.ts:410`) → `WCoreManager`
  (`src/process/task/WCoreManager.ts:227`) constructs a `WCoreAgent` and calls `agent.start()`
  (`src/process/agent/wcore/index.ts:181`), which resolves the binary, hydrates the model's
  decrypted key, spawns the engine child process, waits ≤30 s for the `ready` event, injects stdio
  MCP servers and the preset-rules `init_history` payload.
- **Per turn**: `WCoreManager` calls `agent.send()/stop()/approveTool()/denyTool()/setConfig()/
  setMode()/ping()` (`index.ts:765-802`); stdout events flow back through `handleEvent()`
  (`index.ts:324`) → `onStreamEvent` → `this.emit('wcore.message', event)`
  (`WCoreManager.ts:239`).
- **Exit**: engine `exit` handler restores the workspace `.wcore.toml` and rejects/notifies
  (`index.ts:251-261`); `kill()` sends SIGTERM (`index.ts:808`).

## Key modules

| File | Responsibility |
| --- | --- |
| `src/process/agent/wcore/index.ts` | `WCoreAgent`: spawn (`spawn(binaryPath, args, …)` line 228), readline JSON-Lines decode (line 235), the full event-dispatch switch (~30 arms, lines 324-718), command send (line 760), `.wcore.toml` write/sanitize/restore with TOCTOU guard (lines 832-890), resume-fallback retry (lines 268-283) |
| `src/process/agent/wcore/binaryResolver.ts` | Binary resolution: bundled `resourcesPath` → dev `cwd()/resources` → PATH (lines 55-82); candidates `wayland-core` then `wcore` (line 17); `detectWCore()` runs `--version` for settings UI (line 91) |
| `src/process/agent/wcore/envBuilder.ts` | `buildSpawnConfig()` (line 183): CLI args, provider mapping (native anthropic/openai/bedrock/vertex + catalog-id passthrough, lines 93-117), reasoning-model `--max-tokens` default 32768 (lines 147-157), `.wcore.toml` compat content (line 321); `buildEngineSpawnEnv()` (line 457): SEC-1 env allowlist (lines 367-434) + provider creds + tool keys + `DARHAI_HOME` last (line 484) |
| `src/process/agent/wcore/protocol.ts` | Typed wire protocol: `WCoreEvent` union (line 92, ~30 variants), `WCoreCommand` union (line 282, 8 variants), `WCoreCapabilities` (line 51). Mirror of engine `wcore-protocol/src/events.rs` |
| `src/process/agent/wcore/configBridge.ts` | Read/write of the engine's user `config.toml`: lossless whole-file parse, atomic temp+fsync+rename write (line 121), single-flight write lock (lines 104-113), typed section accessors `[tools]/[security]/[memory]/[profiles]` (lines 169-206) |
| `src/process/agent/wcore/profilePaths.ts` | Pure path layer for Design-B profile isolation: name allowlist regex (line 43), `resolveProfileDir` realpath containment (line 97), `.active` marker (line 59), `nativeConfigDir()` mirroring engine `wayland_config_dir()` precedence (line 158), `resolveActiveConfigDir()` (line 179) |
| `src/process/agent/wcore/profileStore.ts` | Profile CRUD under `~/.darhai/profiles/<name>/`: list with best-effort stats (line 115), create/clone/activate/soft-delete-to-`.trash` (lines 138-192), `initWcoreProfileIpc()` wiring `wcoreProfiles.*` (line 200) |
| `src/process/agent/wcore/toolKeyStore.ts` | Encrypted-at-rest tool-backend keys via `ProviderRepository` under provider id `tool:<id>` (line 54); `TOOL_KEY_ENV_MAP` id→env-name table (lines 36-48); `collectForwardedEnv()` (line 98) |
| `src/process/agent/wcore/toolKeyIpc.ts` | Human-only `wcoreToolKeys.set/list/delete` handlers; presence-only listing (`{ id, hasKey }`, line 85); `initWcoreToolKeyIpc()` (line 114) |
| `src/process/agent/AgentRegistry.ts` | Singleton registry of ALL detected engines; wcore is always present/available (`createWCoreAgent()`, line 71: `{ id: 'wcore', name: 'Darhai Core', backend: 'wcore' }`); merge priority + backend dedup (lines 148-173); targeted `refresh*()` APIs under a mutation queue (line 175) |
| `src/process/agent/types.ts` | Re-export shim of `DetectedAgent` types from `src/common/types/detectedAgent` |
| `scripts/prepareWaylandCore.js` | Build-time engine fetcher: pre-placed-binary path (line 410), GitHub release download from `FerroxLabs/wayland-core` (lines 35-36) pinned to `DEFAULT_WCORE_VERSION = 'v0.10.0'` (line 187), SHA-256 gate before extract/exec (line 172), release-build fail-closed logic (`isReleaseBuild()`, line 104), manifest writer |
| `scripts/bundled-wcore-shasums.json` | Authoritative per-tag, per-platform SHA-256 of release *archives* (tags `v0.10.0`, `v0.9.6-rc.1`); bumped in lockstep with `DEFAULT_WCORE_VERSION` |
| `resources/bundled-wayland-core/win32-x64/` | The bundled payload: `wayland-core.exe` + `manifest.json` (`sourceType`, `sha256`, `version`, `skipped` fields; current local manifest says `local-prebuilt`, `verified: false`, engine `wayland-core 0.10.0`) |
| `src/process/bridge/wcoreConfigBridge.ts` | (adjacent, contract owner) `wcoreConfig.getSection/setSection` IPC over configBridge; sanitises `[security].env_passthrough` names via `SENSITIVE_ENV_RE` (line 35) — no API_KEY/SECRET/TOKEN/… names ever stored |

Sibling dirs `src/process/agent/{acp,gemini,nanobot,openclaw,remote}` are other engines (separate
codemap areas); `AgentRegistry` is their common aggregation point.

## Contracts & data flow

**Spawn contract** (`index.ts:228` + `envBuilder.ts:220-253`):
`spawn(binaryPath, args, { env, stdio: ['pipe','pipe','pipe'], cwd: workspace })` with args
`--json-stream --provider <p> --model <m> [--max-tokens N] [--max-turns N] [--system-prompt S]
[--auto-approve] (--resume <id> | --session-id <id>)`; `--base-url` for anthropic/openai paths
(trailing `/v1` stripped, `envBuilder.ts:176`). Raw-engine mode passes ONLY
`--json-stream` + session args (`envBuilder.ts:220-227`). Session id == Darhai
`conversation_id`; resume is chosen when the conversation already has DB messages
(`WCoreManager.ts:168-178`).

**Wire protocol** (`protocol.ts`): stdout = one JSON event per line (`WCoreEvent`); stdin = one JSON
command per line (`WCoreCommand`: `message`, `stop`, `tool_approve`, `tool_deny`, `init_history`,
`set_mode`, `set_config`, `add_mcp_server`, `ping`). `ready` carries `session_id` +
`capabilities`; unknown event types are logged at warn and dropped (`index.ts:712-717`) —
deliberately louder than the engine's "drop silently" Host Decoder Contract.

**Env vars into the engine** (`envBuilder.ts`):
- Allowlist-filtered `process.env` via `getEnhancedEnv` (`ENGINE_ENV_ALLOWLIST`, lines 367-434:
  PATH/HOME/Windows system/locale/proxy/TLS-CA/provider-auth names only).
- Provider creds injected unconditionally: `ANTHROPIC_API_KEY` (line 275), `OPENAI_API_KEY`
  (line 280), `AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_PROFILE` (lines 287-296),
  or a catalog provider's own scoped var from `providerCatalog.generated.json` `envVar`
  (line 267-268; e.g. `NOVITA_API_KEY`).
- Forwarded tool keys per `TOOL_KEY_ENV_MAP` (`toolKeyStore.ts:36-48`): `BRAVE_SEARCH_API_KEY`,
  `TAVILY_API_KEY`, `EXA_API_KEY`, `FIRECRAWL_API_KEY`, `ELEVENLABS_API_KEY`, `GROQ_API_KEY`,
  `FAL_API_KEY`, `HF_API_KEY`.
- `DARHAI_HOME` = active profile config dir, set LAST so nothing can override it
  (`envBuilder.ts:484`; resolved by `profilePaths.resolveActiveConfigDir()`).

**File formats / on-disk layout**:
- Per-workspace `<workspace>/.wcore.toml` (`index.ts:20`): temp provider-compat overrides
  (`[providers.openai.compat]` with `api_path` / `max_tokens_field`, `envBuilder.ts:321-341`),
  written on spawn, sanitized against attacker `providers` tables (RT-B6-07, `index.ts:53-76`),
  restored/deleted on exit unless a sibling agent rewrote it (`index.ts:870-890`).
- User `config.toml` in the active profile dir (`configBridge.ts`): engine-owned TOML; Darhai edits
  single top-level sections losslessly.
- Profiles: `~/.darhai/profiles/<name>/` (full config tree), `~/.darhai/profiles/.active` marker
  (plain name + newline), `~/.darhai/profiles/.trash/<name>-<ts>` soft deletes. `default` profile
  = native engine dir (`%APPDATA%/wayland-core` on Windows), never relocated
  (`profilePaths.ts:158-168`).
- Bundle: `resources/bundled-wayland-core/{platform}-{arch}/wayland-core[.exe]` + `manifest.json`
  (`prepareWaylandCore.js:594-606` shape: platform/arch/version/sourceType/sha256/files/skipped).

**IPC provider keys** (all defined in `src/common/adapter/ipcBridge.ts`):
- `wcoreToolKeys.set` / `.list` / `.delete` (lines 1896-1902).
- `wcoreConfig.getSection` / `.setSection` (lines 1917-1924).
- `wcoreProfiles.list` / `.create` / `.clone` / `.activate` / `.remove` (lines 1961-1972).
- Remote-denylist: `wcoreToolKeys.set/delete`, `wcoreConfig.setSection`, `wcoreConfig.getSection`,
  `wcoreProfiles.create/clone/activate/remove` are all listed in
  `src/common/adapter/bridgeAllowlist.ts:197-211` — human/renderer only, never reachable from the
  paired WebUI or the agent tool surface.

**Storage keys / DB**:
- Tool keys: rows in the `model_registry_providers` rail via `ProviderRepository.upsertRegistryProvider`
  with `providerId: 'tool:<id>'`, `connectedVia: 'tool-key'`, creds `{ key }` encrypted by
  safeStorage (`toolKeyStore.ts:71-78`). No new table.
- `ProcessConfig` key `'wcore.rawEngineMode'` (`WCoreManager.ts:205`) — read in main via
  ProcessConfig, NOT renderer-bridged ConfigStorage (channel spawns have no renderer; a bridged
  read would hang).
- Provider key hydration at dispatch: `hydrateModelForSpawn(model)` (`index.ts:195`) — the model
  blob crossing IPC carries only a non-secret handle; the decrypted key exists only for the spawn.

**Build-time env vars** (`prepareWaylandCore.js`): `WCORE_VERSION` (default `v0.10.0`),
`WCORE_SKIP=1` / `DARHAI_CORE_SKIP=1` (skip-manifest, no runtime fallback, lines 374-392),
`WCORE_FORCE_DOWNLOAD=1`, `WCORE_USE_LOCAL=1` (dev only), `WCORE_REQUIRE_VERIFIED=1`,
`WCORE_ARCH` (cross-compile, line 365). Release/CI builds (`isReleaseBuild()`, line 104) fail
closed: no unverified binary is ever bundled, `WCORE_ALLOW_UNVERIFIED` cannot downgrade.

## Conventions & invariants

- **Protocol mirroring**: every engine event variant shipped must be enumerated in `protocol.ts` AND
  given a handler arm in `index.ts handleEvent`; the default arm warns instead of silently dropping
  (`index.ts:699-717`) because a missing arm once silently dropped safety-critical
  `browser_policy_denied` events.
- **SEC-1 allowlisted spawn env**: never spread `process.env` into the engine; extend
  `ENGINE_ENV_ALLOWLIST` (`envBuilder.ts:367`) deliberately, biased to keeping auth/connectivity.
- **SEC-5 secret-marker rule**: any env var forwarded into the engine that carries a secret MUST have
  a name containing an engine-sandbox secret marker (`API_KEY` etc.) so the engine strips it from
  the agent's bash-tool context — alias unmarked names (`toolKeyStore.ts:33-35`).
- **Human-only credential/config IPC**: key-mutating and config-mutating providers go on the remote
  denylist (`bridgeAllowlist.ts:197-211`); listings return presence only, never plaintext
  (`toolKeyIpc.ts:81-91`).
- **App-owned `[providers.*]`**: `.wcore.toml` provider tables are always regenerated from app
  content; user/attacker TOML is parsed with a real TOML library and its `providers` key deleted;
  unparseable files fail closed (`index.ts:53-76`).
- **Atomic + serialized config writes**: all `config.toml` mutations go through temp+fsync+rename
  under the module write lock; whole-file lossless round-trip preserves unknown keys
  (`configBridge.ts:98-162`).
- **SEC-4 profile-name containment**: every renderer-supplied profile name passes
  `assertSafeProfileName` + realpath-of-parent containment before any fs op
  (`profilePaths.ts:66-110`); `default` is never deletable; deletes are soft (`.trash`).
- **Supply-chain gate**: release builds verify the engine archive SHA-256 against
  `scripts/bundled-wcore-shasums.json` BEFORE extract/copy/execute; bump shasums in lockstep with
  `DEFAULT_WCORE_VERSION`.
- **No hot profile switch**: activating a profile only writes the `.active` marker; running engines
  keep their spawn-time profile until restart (`profileStore.ts:160-171`).
- **Best-effort optional deps**: tool-key load and profile-dir resolution failures degrade
  (empty map / engine default dir) rather than blocking the spawn (`index.ts:171-179, 222-227`).

## Assimilation anchors

1. **New engine protocol event** (e.g. an ECC/IJFW-originated engine capability): add the variant to
   `WCoreEvent` in `src/process/agent/wcore/protocol.ts` and a handler arm in
   `src/process/agent/wcore/index.ts handleEvent()` — imitate the `tool_chunk` pair
   (`protocol.ts:169-175` + `index.ts:463-469`); renderer consumption comes via the
   `onStreamEvent` → `'wcore.message'` emit in `WCoreManager.ts:239`.
2. **New forwarded tool-backend key** (new search/voice/image provider for the engine's tools): one
   entry in `TOOL_KEY_ENV_MAP` (`toolKeyStore.ts:36-48`, name MUST contain `API_KEY`); IPC ids,
   presence listing and spawn-env forwarding all derive from that map automatically
   (`toolKeyIpc.ts:36`, `toolKeyStore.ts:98`).
3. **New engine `config.toml` section surface** (e.g. an assimilated ECC gate policy section): add
   typed accessors mirroring `getToolsSection`/`setToolsSection` (`configBridge.ts:169-176`); it is
   already reachable through the generic `wcoreConfig.getSection/setSection` IPC
   (`wcoreConfigBridge.ts:78-90`) — add a sanitizer branch there (mirror
   `sanitizeSecuritySection`, line 47) if the section is security-load-bearing.
4. **New stdio MCP injected into every wcore session** (e.g. an ECC-skill or memory MCP): build a
   `StdioMcpOption` and push it in `WCoreManager.start()` next to the team-guide branch
   (`WCoreManager.ts:186-192`); `WCoreAgent` forwards it verbatim as `add_mcp_server` before the
   first message (`index.ts:288-313`); set `awaitReady: true` only if the server does a ready
   handshake.
5. **New bundled sidecar binary** (any native helper an assimilated capability needs): copy the
   `scripts/prepareWaylandCore.js` + `scripts/bundled-wcore-shasums.json` pattern (pinned tag,
   archive SHA gate, manifest, skip-manifest), call it from `scripts/build-with-builder.js:466`
   beside `prepareWaylandCore()`, and resolve at runtime with a mirror of
   `src/process/agent/wcore/binaryResolver.ts` (bundled → dev-resources → PATH).
6. **New execution engine in the registry**: add a `create<X>Agent()`/detector and slot it into the
   dedup merge order in `src/process/agent/AgentRegistry.ts:163-173` (imitate
   `createWCoreAgent()`, line 71, or `detectOtherCliAgents()`, line 85, for PATH-detected CLIs);
   declare the new `kind` in `src/common/types/detectedAgent.ts`.
