# 10 process-extensions-hub

## Purpose

The extension system lets Darhai load third-party/vendored capability bundles ("extensions") from
disk at runtime: each extension is a directory with an `aion-extension.json` manifest that can
contribute ACP adapters, MCP servers, assistants, agents, skills, channel plugins, themes,
settings tabs, WebUI routes, model providers, and i18n. The **Hub** is the install pipeline on top
of it: a signed local index + remote mirror index of downloadable extension zips, with SHA-512
integrity verification, a native confirmation dialog, forked lifecycle hooks, and hot-reload of the
registry. `data/bundle-vendored/` is a third leg: in-repo vendored data (waylandteams assistants,
25 agent-profile personas, team skills) merged into the live registry at init.

## Entry points & lifecycle

- **Electron main boot**: `src/process/index.ts:34` — `initializeProcess()` calls
  `ExtensionRegistry.getInstance().initialize()` after `initStorage()` and before ChannelManager.
  Failure is logged but does NOT abort app startup (`src/process/index.ts:35-38`).
- **Headless server boot**: `src/server.ts:97` runs the same `initialize()`.
- **IPC wiring**: `initHubBridge()` registers all `hub.*` providers — called from
  `src/process/bridge/index.ts:133` and `src/process/utils/initBridgeStandalone.ts:87`.
- **Registry init sequence** (`src/process/extensions/ExtensionRegistry.ts:112-228`):
  `ExtensionLoader.loadAll()` → engine-compat filter (`:120`) → dependency validation + topological
  sort (`:127-150`) → restore persisted enable/disable states (`:155-176`) → run
  `onInstall`/`onActivate` hooks for enabled extensions via `needsInstallHook` (`:179-201`) →
  `savePersistedStates` (`:204`) → `resolveContributions()` (`:206`). Concurrent callers fold onto
  a cached `initializePromise` (INIT-1, `:76-93`); `whenInitialized()` (`:106-109`) is the "wait
  until ready" hook consumed by `src/process/bridge/kickoffBridge.ts:100` (with a
  `Promise.race` timeout).
- **Install flow** (`src/process/extensions/hub/HubInstaller.ts:112-227`): renderer invokes
  `hub.install` → native confirm dialog → resolve zip (bundled-first) → verify SHA-512 → extract →
  move into install target dir → `markExtensionForReinstall` → `ExtensionRegistry.hotReload()` →
  `agentRegistry.refreshAll()` → post-install capability verification → state broadcast.
- **Hot reload**: `ExtensionRegistry.hotReload()` (`ExtensionRegistry.ts:494-522`) builds a NEW
  registry instance in the background and atomically swaps the singleton only after successful
  init, then emits `REGISTRY_RELOADED` on the event bus. `ExtensionWatcher`
  (`lifecycle/hotReload.ts:14-63`) fs-watches scan dirs for `aion-extension.json` changes with a
  1 s debounce — note it is exported from `src/process/extensions/index.ts:9` but currently has
  **no production call site** (only `HubInstaller` triggers `hotReload()` today).
- **Renderer consumers**: `src/renderer/hooks/agent/useHubAgents.ts` (invokes
  `hub.getExtensionList`, subscribes `hub.onStateChanged`, filters `hubs.includes('acpAdapters')`)
  and `src/renderer/pages/settings/AgentSettings/AgentHubModal.tsx`.

## Key modules

| File | Responsibility |
|---|---|
| `src/process/extensions/constants.ts` | All path/env constants: manifest filename, scan-source priority, hub URLs, bundled-resources dirs, install target (details in Contracts). |
| `src/process/extensions/index.ts` | Barrel: re-exports registry, loader, watcher, resolvers, lifecycle, sandbox, protocol, storage, types for the rest of the process layer. |
| `src/process/extensions/types.ts` | Zod schemas + TS types for the whole manifest: `ExtensionMetaSchema` (name/semver/apiVersion/engine/i18n/lifecycle/permissions, `:38-151`), per-contribution schemas, `ExtContributesSchema` with cross-ID duplicate validation (`:421-534`), `RESERVED_NAME_PREFIXES = ['aion-','internal-','builtin-','system-']` (`:12`), `LoadedExtension`, `ExtensionState`. |
| `src/process/extensions/ExtensionLoader.ts` | Scans each source dir for subdirs (accepting symlinked dirs, `:63-73`) containing `aion-extension.json`; parses JSONC (`strip-json-comments`), resolves `$file:` refs then `${env:VAR}` templates, validates via `ExtensionManifestSchema.safeParse` (`:106-137`); first-source-wins dedupe by name (`:38-44`). |
| `src/process/extensions/ExtensionRegistry.ts` | Singleton orchestrator: init pipeline, enable/disable with lifecycle hooks + persistence (`:235-311`), permission summaries (`:339-352`), contribution caches + getters (`:399-470`), atomic `hotReload` (`:494-522`), vendored overlay + agent-profile merge in `resolveContributions` (`:377-396`). |
| `src/process/extensions/hub/HubIndexManager.ts` | Merges trusted local bundled `index.json` with remote index; **pins the `dist` block (tarball+integrity) to the local value for any name present in the trusted index** (RT-B4-03, `:68-84`); resolves `bundled` flag by zip existence (`:86-90`); schema-version gate (`:105-114`); remote fetch tries `HUB_REMOTE_URLS` in order with 5 s timeout (`:134-156`). Singleton `hubIndexManager`. |
| `src/process/extensions/hub/HubInstaller.ts` | Install/retry pipeline (see Entry points). Post-install `contributeVerifiers` currently verify `acpAdapters` only, against `agentRegistry.getDetectedAgents()` (`:39-87`). `retryInstall` deliberately delegates to full `install()` so on-disk-tampered code is never re-executed unverified (RT-B4-06, `:248-260`). Singleton `hubInstaller`. |
| `src/process/extensions/hub/HubStateManager.ts` | Transient install/uninstall states + persistent `installError` (written into extension-states file, `:49-71`); every transition broadcast via `ipcBridge.hub.onStateChanged.emit` (`:42`); status derivation priority: transient > install_failed > (update check TODO, commented `:152-166`) > all contributed acpAdapters detected → `installed` > `not_installed` (`:138-177`). Singleton `hubStateManager`. |
| `src/process/extensions/lifecycle/lifecycle.ts` | Runs manifest lifecycle hooks (`onInstall`/`onActivate`/`onDeactivate`/`onUninstall`) in a **forked child** running `lifecycleRunner.js` (`:141-152`), cwd = extension dir, env = `getEnhancedEnv()`; path-traversal guard on script path (`:126-131`); per-hook timeouts 120s/60s/30s/30s with SIGKILL (`:56-61`, `:98-103`); emits event-bus lifecycle events (`:185-243`). |
| `src/process/extensions/lifecycle/lifecycleRunner.ts` | The forked child. `script` hooks load via `eval('require')(scriptPath)` with FULL Node privileges — explicitly documented as NOT a sandbox (`:14-31`); `shell` hooks restricted to allowlist `['bun','bunx']` (`:58-69`), spawned with `shell:true` on win32 (`:71-76`). IPC protocol: `{type:'script'|'shell',…}` in, `{success,error?}` out (`:103-123`). |
| `src/process/extensions/lifecycle/statePersistence.ts` | Persists per-extension `{enabled,disabledAt,disabledReason,installed,lastVersion,installError}` to `extension-states.json` (schema `version: 1`, `:30-48`); 500 ms-debounced atomic write (tmp+rename, `:94-140`); `needsInstallHook` first-install/upgrade detection (`:148-164`); `markExtensionForReinstall` clears `installed` so hotReload re-runs `onInstall` (`:170-177`). |
| `src/process/extensions/lifecycle/ExtensionEventBus.ts` | Global `EventEmitter` (maxListeners 200): system events `extension.activated/.deactivated/.installed/.uninstalled`, `registry.reloaded`, `states.persisted` (`:13-26`); namespaced custom events `` `${extensionName}:${eventName}` `` (`:68-71`). Singleton `extensionEventBus`. |
| `src/process/extensions/lifecycle/hotReload.ts` | `ExtensionWatcher`: recursive `fs.watch` on all scan dirs, reacts only to `aion-extension.json` basename (`:25-29`), 1 s debounce → `ExtensionRegistry.hotReload()` (`:49-62`). Exported but not instantiated anywhere in production code. |
| `src/process/extensions/data/bundle-vendored/README.md` | Provenance: vendored snapshot of the `waylandteams` bundle (assistants + launcher docs) so worktree-isolated meta-agents can read it; W1a-only edit policy; sync-back plan. |
| `src/process/extensions/data/bundle-vendored/assistants.json` | Vendored assistant manifest — currently 55 entries (27 `kind:'team'` launchers + 28 `kind:'specialist'`; README's "45" lags). Fields include `standing`, `teammates`, `rituals`, `kickoffs`, `enabledSkills`, `contextFile`. |
| `src/process/extensions/data/bundle-vendored/launchers/*.md` | 25 launcher prose docs (`affiliate-site-engine.md` … `validate-before-build.md`) referenced by the vendored assistants' `contextFile`s. |
| `src/process/extensions/data/bundle-vendored/vendoredAssistantOverlay.ts` | `applyVendoredOverlay()`: static-imports `assistants.json` (build-time inline so it works packaged, `:47-51`) and patches ONLY missing `standing`/`teammates`/`rituals`/`kickoffs` onto live-loaded assistants; strips `ext-` id prefix for lookup (`:178`); empty `kickoffs` array counts as missing (G-M-4, `:209-217`); cached, test-reset hook. |
| `src/process/extensions/data/bundle-vendored/agentProfileMerge.ts` | `mergeVendoredAgentProfiles()`: reads `skills-library/index.json` (path-probe `:83-99`), converts the 25 `type:'agent-profile'` entries into self-contained assistants (SKILL.md body → `context` + `prompts.system`, lucide avatar map `:171-208`, category mapping `:151-161`, curated `enabledSkills` from `agentProfileSkills.json`); appends id-deduped — live records win (`:311-333`). |
| `src/process/extensions/data/bundle-vendored/agentProfileSkills.json` | Curated skill-slug arrays per agent-profile (25 keys, e.g. `executive-communicator`), BM25-derived + hand-audited. |
| `src/process/extensions/data/bundle-vendored/teamSkillMerge.ts` | `loadTeamSkills()`: loads waylandteams `contributes/skills.json` from `~/dev/waylandteams` or app-support candidates (`:58-71`), registers entries on the `SkillLibrary` singleton with `source:'team'`, `sourceLabel:'Дархай багууд'`, category derived from name prefix (`:83-87`). Called once from `src/process/bridge/skillsBridge.ts:25` (NOT from ExtensionRegistry). |

Adjacent extension subsystems (same directory tree, separate codemap area): `resolvers/*` (per-contribution converters, all using `toAssetUrl` + `isPathWithinDirectory`), `resolvers/utils/*` (env/`$file:` templating, semver engine validation, dependency topo-sort, dist-entry resolution), `sandbox/*` (permission analysis, worker-thread "sandbox" — `sandboxWorker.ts` documents it is NOT a security sandbox; `ExtensionStorage`/`createSandbox` not yet wired), `protocol/*` (`wayland-asset://` protocol + allowlist, Figma-style extension UI bridge).

## Contracts & data flow

**IPC provider keys** (`src/common/adapter/ipcBridge.ts:1578-1593`, providers in
`src/process/bridge/hubBridge.ts:6-53`):

| Key | Direction | Notes |
|---|---|---|
| `hub.get-extension-list` | invoke → `IHubAgentItem[]` | loads indexes then derives status |
| `hub.install` | invoke `{name}` | full install pipeline; gated by native dialog |
| `hub.retry-install` | invoke `{name}` | delegates to install |
| `hub.update` | invoke `{name}` | currently identical to install (`hubBridge.ts:41-48`) |
| `hub.check-updates` | invoke → `[]` | stub (`hubBridge.ts:37-39`) |
| `hub.uninstall` | invoke `{name}` | returns "Uninstall not supported yet." (`hubBridge.ts:50-52`) |
| `hub.state-changed` | emitter | `{name, status: HubExtensionStatus, error?}` from `HubStateManager.setTransientState` |

**Remote-WS denial**: the entire `hub.` namespace is on the paired-device WebSocket denylist
(`src/common/adapter/bridgeAllowlist.ts:135` — "remote-reachable RCE chain"). The second gate is
`requireConfirmation` (`src/process/bridge/webuiDirectAuth.ts:71-90`), a main-process
`dialog.showMessageBox` a compromised renderer cannot spoof (`HubInstaller.ts:124-138`).

**Spawned processes / runtimes**:
- `fork(lifecycleRunner.js)` per lifecycle hook — Node child, cwd = extension dir, env =
  `getEnhancedEnv()` from `@process/utils/shellEnv` (`lifecycle/lifecycle.ts:141-152`).
- Inside the child: `spawn(cliCommand)` restricted to `bun`/`bunx` (`lifecycleRunner.ts:58-76`).
- Archive extraction: `execAsync('tar -xf …')` on win32, `execAsync('unzip -o …')` elsewhere
  (`HubInstaller.ts:169-173`).
- Downloads go through `getPlatformServices().network.fetch` (`HubInstaller.ts:303-312`,
  `HubIndexManager.ts:144`).

**Env vars**:
- `DARHAI_EXTENSIONS_PATH` — extra scan dirs, `;`/`:`-separated, highest priority (`constants.ts:11,25-29`).
- `DARHAI_STRICT_ENV` — global strict mode for `${env:VAR}` manifest templates (`constants.ts:12`; consumed by `resolvers/utils/envResolver.ts`).
- `DARHAI_HUB_URL` — comma-separated custom hub mirrors, prepended to defaults (`constants.ts:38-55`).
- `DARHAI_E2E_TEST=1` — scan env dirs only (hermetic E2E) (`constants.ts:97,112`).
- `DARHAI_EXTENSION_STATES_FILE` — override for the states file path (`statePersistence.ts:13-22`).
- `DARHAI_EXTENSION_DEBUG` — security-log verbosity in `resolvers/ChannelPluginResolver.ts`.

**Filesystem layout / storage**:
- Scan sources, priority order (`constants.ts:94-123`): env dirs → `getDataPath()/extensions`
  (`~/.darhai/extensions`) → Electron appData `extensions` dir. `getInstallTargetDir()` = first
  source (`constants.ts:130-134`) — Hub installs land there so the loader finds them next scan.
- Bundled hub resources: `<resourcesPath>/hub` packaged, `<cwd>/resources/hub` dev
  (`constants.ts:62-67`).
- Download cache: `getDataPath()/cache/hub/<name>.zip` (`HubInstaller.ts:90-92`); extract temp:
  `<installTarget>/.tmp/<name>` (`HubInstaller.ts:94-96`).
- Persisted states: `getDataPath()/extension-states.json`, schema `{version:1, extensions:{…}}`
  (`statePersistence.ts:30-48`).

**File formats**:
- `aion-extension.json` — JSONC manifest; supports `$file:<path>` indirection and `${env:VAR}`
  templates before Zod validation (`ExtensionLoader.ts:111-130`). Name: kebab-case, 2-64 chars,
  reserved prefixes rejected (`types.ts:40-47`).
- Hub index `index.json` — `IHubIndex {schemaVersion, generatedAt, extensions}`
  (`src/common/types/hub.ts:48-52`); `HUB_SUPPORTED_SCHEMA_VERSION = 1` (`constants.ts:35`);
  entries carry `dist: {tarball (relative path only), integrity (sha512-SRI), unpackedSize}`,
  `engines.wayland`, `hubs[]`, `contributes` as string-ID arrays.
- Extension archive — `.zip`, optionally wrapping content in a `package/` dir which is unwrapped
  (`HubInstaller.ts:176-198`); must contain `aion-extension.json` at root.
- `resources/hub/` currently ships 4 bundled extensions (`aionext-auggie/-codebuddy/-opencode/
  -qwen`, each contributing one ACP adapter) + `index.json`; `resources/hub/manifest.json` is a
  hub-repo release manifest (dist-latest asset list) NOT read by app code — only `index.json` is
  consumed (`HubIndexManager.ts:118`).

**Remote mirrors** (`constants.ts:42-45`): `https://raw.githubusercontent.com/sergei10a-rgb/darhaiHub/dist-latest/` then `https://cdn.jsdelivr.net/gh/sergei10a-rgb/darhaiHub@dist-latest/`.

## Conventions & invariants

- **Everything that installs must funnel through `HubInstaller.install()`**: retry and update both
  delegate to it so archive re-verification + the native confirm dialog can never be skipped
  (`HubInstaller.ts:229-267`). `skipConfirm` is internal-only, never plumbed from IPC (`:110`).
- **Integrity rules**: only `sha512-<base64>` SRI accepted; missing hash = hard failure for remote
  archives, tolerated only for code-signed bundled archives (`HubInstaller.ts:323-360`); absolute
  tarball URLs in an index are rejected (`:283-286`); for names present in the trusted local index,
  the remote index can never substitute the `dist` block (`HubIndexManager.ts:68-84`).
- **Lifecycle hooks never run inline**: always a forked child with timeout + SIGKILL; hook script
  path must resolve inside the extension dir (`lifecycle.ts:126-131`); shell hooks only `bun`/`bunx`.
  Treat any hook execution as arbitrary-code execution (see the DANGER block,
  `lifecycleRunner.ts:14-31`) — do not add remote-reachable paths to it.
- **Atomic swap on reload**: never mutate the live registry during rebuild; build a new instance
  then swap (`ExtensionRegistry.ts:494-522`). State writes are debounced + tmp-rename-atomic
  (`statePersistence.ts:94-130`).
- **First-source-wins**: duplicate extension names across scan sources are skipped with a warning
  (`ExtensionLoader.ts:38-44`); env dirs outrank user dirs so explicit paths always win.
- **Contribution IDs must be unique** within a manifest, and agent IDs must not collide with
  assistant IDs — enforced by `validateContributeIds` (`types.ts:421-515`).
- **Vendored overlays are non-destructive**: live/hand-curated records always win; overlays fill
  only missing fields (`vendoredAssistantOverlay.ts:168-225`) or append only non-colliding ids
  (`agentProfileMerge.ts:311-333`); all are cached with `__reset…ForTests()` hooks and degrade to
  no-ops on unreadable input.
- **Status broadcast discipline**: every hub state transition goes through
  `hubStateManager.setTransientState` so the renderer emitter fires exactly once per transition
  (`HubStateManager.ts:26-43`).
- **Naming**: extension names kebab-case, reserved prefixes `aion-`, `internal-`, `builtin-`,
  `system-` refused (`types.ts:12-16`); registry-side ids for extension contributions are
  `ext-`-prefixed (see overlay prefix-strip, `vendoredAssistantOverlay.ts:161-164,178`).

## Assimilation anchors

1. **New contribution type** (e.g. ECC "rules" or Odysseus "workflows" as first-class contributes):
   add a Zod schema + key in `ExtContributesSchemaBase` (`src/process/extensions/types.ts:517-530`)
   with duplicate-ID validation in `validateContributeIds` (`types.ts:421`), a resolver mirroring
   `src/process/extensions/resolvers/SkillResolver.ts`, a cache + getter wired into
   `ExtensionRegistry.resolveContributions()` (`ExtensionRegistry.ts:360-397`), and the string-ID
   key in `HubContributes` (`src/common/types/hub.ts:14-25`).
2. **Vendoring a skill/agent pack into the app repo** (ECC/Superpowers style): imitate
   `data/bundle-vendored/agentProfileMerge.ts` — static JSON import + pure merge function called
   from `ExtensionRegistry.resolveContributions` (`ExtensionRegistry.ts:390-394`) — for
   assistant-shaped data, or imitate `teamSkillMerge.ts` + its call site
   `src/process/bridge/skillsBridge.ts:25` for skill-shaped data registered on `SkillLibrary`.
   Follow the non-destructive-merge + cached + test-reset pattern.
3. **New installable hub extension**: package a zip whose root has `aion-extension.json`, drop it in
   `resources/hub/` and append an entry to `resources/hub/index.json` mirroring the
   `aionext-qwen` record (name/displayName/engines.wayland/hubs/contributes/dist with sha512 SRI);
   publish the same artifacts to the `sergei10a-rgb/darhaiHub` `dist-latest` branch for remote
   installs (`constants.ts:42-45`).
4. **Post-install verification for a new capability**: add a verifier to `contributeVerifiers` in
   `src/process/extensions/hub/HubInstaller.ts:39-66`, keyed by the `HubContributes` field —
   `acpAdapters` is the existing analog (checks against `agentRegistry.getDetectedAgents()`).
5. **Heavy setup work at install time** (CLI download, model fetch): declare a manifest
   `lifecycle.onInstall` hook (`types.ts:107-118`) — script file or `{shell:{cliCommand:'bun'|'bunx'}}`
   only — and rely on the forked-runner timeout model (`lifecycle/lifecycle.ts:56-61`); the analogs
   are the bundled `aionext-*` extensions whose onInstall installs the agent CLI.
6. **New hub IPC surface**: add a `buildProvider` under the `hub` namespace in
   `src/common/adapter/ipcBridge.ts:1578-1593` and wire it in
   `src/process/bridge/hubBridge.ts`; keep any code-executing operation behind
   `requireConfirmation` (`HubInstaller.ts:124-138`) and remember `hub.` stays on the remote-WS
   denylist (`src/common/adapter/bridgeAllowlist.ts:135`).
7. **Cross-subsystem reactions** (e.g. re-index memory after an extension lands): subscribe to
   `ExtensionSystemEvents` on `extensionEventBus`
   (`src/process/extensions/lifecycle/ExtensionEventBus.ts:13-26`) — `REGISTRY_RELOADED` is the
   authoritative "contributions changed" signal emitted by both hot-reload paths.
