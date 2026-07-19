# 01 process-core-infra

## Purpose

Main-process bootstrap and core infrastructure of the Darhai Electron app: the entry file
`src/index.ts` (window creation, security hardening, lifecycle, quit cleanup), the process
subsystem initializer `src/process/index.ts`, the config/storage layer (`src/process/utils/initStorage.ts`),
the preload IPC surface (`src/preload/`), and the runtime-abstraction layer (`src/common/platform/`)
that lets the same process code run inside Electron or as a standalone Node server.

## Entry points & lifecycle — how and when this code runs

Electron `main` points at the bundle of `src/index.ts` (built by electron-vite to `out/main/index.js`).
Module-evaluation order inside `src/index.ts` is load-bearing:

1. `import './process/utils/configureChromium'` (src/index.ts:9) — MUST run before anything calls
   `app.getPath('userData')` (Electron caches the path). Sets dev app name (`Wayland-Dev` /
   `Wayland-Dev-2`, src/common/platform/index.ts:11-14), Chromium switches, and CDP remote-debugging port.
2. `import './process/utils/dnsOrder'` (src/index.ts:12) — side-effect `dns.setDefaultResultOrder('ipv4first')`.
3. Sentry main SDK is dynamically imported only when `SENTRY_DSN` is set (src/index.ts:37-55).
4. `import './process/utils/configureConsoleLog'` (src/index.ts:57) — patches global `console` into
   electron-log daily files (`<logs>/YYYY-MM-DD.log`, 10 MB cap).
5. Single-instance lock (src/index.ts:117-149): skipped when `DARHAI_E2E_TEST=1` or
   `DARHAI_MULTI_INSTANCE=1`; second instance forwards deep-link URL via `additionalData.deepLinkUrl`.
6. `protocol.registerSchemesAsPrivileged` for the `AION_ASSET_PROTOCOL` custom scheme
   (src/index.ts:196-206) — must run pre-ready.
7. CLI-mode flags parsed at module scope (src/index.ts:414-417): `--webui`, `--remote`,
   `--resetpass`, `--version`.
8. `app.whenReady()` → `applyRendererCsp()` (CSP on default session, src/index.ts:1144-1146),
   prefetch of quit-cleanup modules (src/index.ts:1149), then `handleAppReady` (src/index.ts:744).

`handleAppReady` sequence (src/index.ts:744-1068): register `wayland-asset://` protocol handler with
path allowlist (src/index.ts:774-791) → `initializeProcess()` → zoom restore → mode branch
(resetpass / webui / desktop). Desktop branch: `applyFirstRunDefaults()` →
`migrateCredentialsToSafeStorage_v1()` → tray setup → `createWindow()` → ambient window (opt-in) →
ACP detection → i18n language init → WebUI auto-restore → pending deep-link flush.

`initializeProcess` (src/process/index.ts:25-49) runs, in order: `initStorage()` →
`ExtensionRegistry.getInstance().initialize()` → `getChannelManager().initialize()` (each of the
latter two is non-fatal on error). Note src/process/index.ts:7 imports
`@/common/platform/register-electron` FIRST and src/process/index.ts:20 imports
`./utils/initBridge` for its side effects (all IPC bridges register at module load).
src/process/index.ts:16-18 sets `PREBUILDS_ONLY=1` when packaged (node-gyp-build guard).

Quit path: `before-quit` (src/index.ts:1202-1415) runs a 10s-capped cleanup with 2s per-step
budgets over prefetched modules — order: close SQLite → cron shutdown → workerTaskManager.clear →
ambient/team/channels/webserver/office-watch/ppt-preview/file-watch. `window-all-closed` respects
close-to-tray and WebUI mode (src/index.ts:1173-1182).

The standalone (no-Electron) twin entry is `src/server.ts`, which uses
`src/common/platform/register-node.ts` and `src/process/utils/initBridgeStandalone.ts` instead of
`register-electron` + `initBridge`.

## Key modules

| File | Responsibility |
|---|---|
| `src/index.ts` | Electron main entry: single-instance lock, CSP + webview/permission/navigation hardening (SEC-ELEC-01..03), `createWindow`, auto-updater + IJFW service kickoff, deep-link (`darhai://`) registration, powerMonitor cron recovery, ordered before-quit cleanup |
| `src/process/index.ts` | `initializeProcess()`: platform registration import, configureChromium import, initStorage, ExtensionRegistry, ChannelManager |
| `src/preload/main.ts` | contextBridge surface `window.electronAPI`: generic `emit`/`on` over the adapter channel + direct `ipcRenderer.invoke` channels (webui, constitution, onboarding, feedback, weixin login), tray IPC→DOM event relay |
| `src/preload/ambientPreload.ts` | Minimal `window.ambientAPI` for the ambient bubble window: `ambient:drag-start/drag-end/click` sends |
| `src/common/platform/IPlatformServices.ts` | Runtime-abstraction contract: `paths`, `worker` (fork), `power`, `notification`, `network` interfaces |
| `src/common/platform/ElectronPlatformServices.ts` | Electron impl: `app.getPath` paths, `utilityProcess.fork` (injects `DATA_DIR` env, ElectronPlatformServices.ts:72), powerSaveBlocker, Notification, `net.fetch` |
| `src/common/platform/NodePlatformServices.ts` | Node impl: `DATA_DIR`/`~/.darhai-server` paths, `child_process.fork` with `serialization:'advanced'`, no-op power/notification, global fetch |
| `src/common/platform/index.ts` | `registerPlatformServices`/`getPlatformServices` with lazy Electron auto-registration fallback (chunk-order safety net) + `getDevAppName()` |
| `src/common/platform/register-electron.ts` | Side-effect module: registers ElectronPlatformServices (first import of src/process/index.ts) |
| `src/common/platform/register-node.ts` | Side-effect module: registers NodePlatformServices (first import of server.ts) |
| `src/process/utils/initStorage.ts` | Storage bootstrap: JsonFileBuilder file stores, legacy-data migration, builtin skills/assistants/extension sync, builtin MCP server config, DB init, `ProcessConfig/ProcessChat/ProcessChatMessage/ProcessEnv` exports, `getSystemDir()`, `loadSkillsContent()` |
| `src/process/utils/initBridge.ts` | Side-effect bridge bootstrap (Electron path): wires SQLite repos → services (conversation, team, cron, cost, usage, workflow) → `initAllBridges` + eager provider registration + retention prunes + autonomous-step watchdog |
| `src/process/utils/initBridgeStandalone.ts` | Explicit bridge init for standalone mode; skips Electron-only bridges (dialog/windowControls/update/webui), swaps shellBridge → shellBridgeStandalone |
| `src/process/utils/initAgent.ts` | `setupAssistantWorkspace`: symlinks the bounded skill set (_builtin + pinned + enabledSkills, minus disabled/blocked) into CLI-native skills dirs of a temp workspace |
| `src/process/utils/configureChromium.ts` | Pre-ready side effects: dev userData isolation, headless Ozone flags for `--webui`/`--resetpass`, CDP port config/registry (`~/.darhai-cdp-registry.json`), `verifyCdpReady` |
| `src/process/utils/utils.ts` | Path helpers (`getConfigPath`/`getDataPath`/`getTempPath`, macOS CLI-safe symlinks), recursive dir read/copy/prune/verify, `ensureDirectory` |
| `src/process/utils/atomicWrite.ts` | `writeFileAtomic`/`writeFileSyncAtomic`: tmp-file + rename; for `mode:0o600` also applies owner-only Windows DACL via icacls |
| `src/process/utils/configMigration.ts` | Standalone-mode migration of Electron config into server config (`MIGRATABLE_KEYS` allowlist) + `IMPORT_CONFIG_FROM` manual import |
| `src/process/utils/credentialMigration.ts` | One-shot re-encryption of channel credentials from base64 → safeStorage `enc:v1:`; gated by `system.credentialsCryptoMigrated_v1` |
| `src/process/utils/firstRunDefaults.ts` | Once-per-install defaults (close-to-tray ON, start-on-boot ON); gated by `system.firstRunDefaultsApplied` |
| `src/process/utils/configureConsole.ts` | Windows `chcp 65001` (UTF-8 console) side effect |
| `src/process/utils/configureConsoleLog.ts` | electron-log setup: daily file name, levels, `Object.assign(console, log.functions)` |
| `src/process/utils/mainLogger.ts` | `mainLog/mainWarn/mainError`: console + `ipcBridge.application.logStream.emit` to renderer F12 |
| `src/process/utils/analyticsId.ts` | Persistent anonymous UUID in `<userData>/analytics.json` (0o600 atomic write) |
| `src/process/utils/deepLink.ts` | `darhai://` parsing (incl. base64 `data` param), pending-URL queue, emit via `ipcBridge.deepLink.received` |
| `src/process/utils/dnsOrder.ts` | Side effect: IPv4-first DNS resolution order |
| `src/process/utils/appMenu.ts` | `setupApplicationMenu()` from main-process i18n; rebuilt on language change |
| `src/process/utils/tray.ts` | Tray icon/menu, close-to-tray flag, quit flag; `refreshTrayMenu` on language change |
| `src/process/utils/zoom.ts` | UI zoom factor (0.8–1.3, step 0.05): restore from config, keyboard shortcuts per window |
| `src/process/utils/mainWindowLifecycle.ts` | `bindMainWindowReferences` (tray+deepLink+applicationBridge), `showOrCreateMainWindow` |
| `src/process/utils/mcpScriptDir.ts` | `__dirname`-based resolver for bundled MCP stdio scripts (`MCP_STDIO_SCRIPT_NAMES`, mcpScriptDir.ts:56-61) + startup canary `inspectMcpScripts` |
| `src/process/utils/webuiConfig.ts` | WebUI port/remote resolution (CLI > env > `<userData>/webui.config.json` > default) + desktop WebUI auto-restore from ProcessConfig |
| `src/process/utils/shellEnv.ts` | Login-shell env loading for GUI-launched app, PATH merging, bundled bun/npx resolution (AVX2 probe), node-bin discovery, env diagnostics |
| `src/process/utils/prewarmProviders.ts` | Pre-loads lazy AI SDKs (anthropic/genai/openai/bedrock) for backends referenced by enabled cron jobs |
| `src/process/utils/message.ts` | `ConversationManageWithDB`: per-conversation write queue batching message insert/accumulate into SQLite in UI-consistent order |
| `src/process/utils/osUserName.ts` | OS account display-name lookup (dscl/getent/PowerShell) for greeting; cached |
| `src/process/utils/openclawUtils.ts` | SHA-1 identity hash over `IDENTITY.md` + `SOUL.md` in a workspace |
| `src/process/utils/previewUtils.ts` | Re-exports NavigationInterceptor tool contract; preview-open plumbing to renderer |
| `src/process/utils/resetPasswordCLI.ts` | `--resetpass` CLI: bcrypt-reset WebUI password directly in DB, colored TTY output |
| `src/process/utils/safeExec.ts` | TTY-safe `spawn` (detached process-group) helpers to avoid SIGTTOU from CLI tools |
| `src/process/utils/backoff.ts` | Backoff policy computation (OpenClaw-lifted, MIT) |
| `src/process/utils/retry-policy.ts` | Channel retry engine driving backoff + error classification (OpenClaw-lifted) |
| `src/process/utils/channel-errors.ts` | Transient/permanent error classification, Retry-After parsing, `HttpStatusError` (OpenClaw-lifted) |
| `src/process/utils/workflowLaunchTargetResolver.ts` | Resolves default workflow launch target (backend+cliPath+model) from `guid.lastSelectedAgent` + AgentRegistry + `model.config`/`acp.config` |
| `src/process/utils/index.ts` | Barrel re-exporting the path/dir helpers from `utils.ts` |

## Contracts & data flow

**Preload / IPC.** The whole renderer↔main bridge multiplexes over ONE ipc channel:
`ADAPTER_BRIDGE_EVENT_KEY = 'office-ai-bridge-adapter'` (src/common/adapter/constant.ts:7), exposed as
`window.electronAPI.emit/on` (src/preload/main.ts:93-116). Payload is `JSON.stringify({name, data})`;
`name` is the ipcBridge provider/emitter key. Direct out-of-band `ipcRenderer.invoke` channels
(src/preload/main.ts:120-151): `webui-direct-reset-password`, `webui-direct-get-status`,
`webui-direct-change-password`, `webui-direct-change-username`, `webui-direct-generate-qr-token`,
`feedback:collect-logs`, `constitution:read|write|reset|readWithOverlay|listSpecialists|readSpecialist|writeSpecialist|deleteSpecialist`,
`onboarding:detect`, `onboarding:fluxMetrics`, `weixin:login:start` (+ `weixin:login:qr/scanned/done`
listeners with single-active-listener semantics, src/preload/main.ts:29-88). Tray events relayed as DOM
CustomEvents: `tray:navigate-to-guid`, `tray:navigate-to-conversation`, `tray:open-about`,
`tray:pause-all-tasks`, `tray:check-update` (src/preload/main.ts:155-167). Ambient window channels:
`ambient:drag-start`, `ambient:drag-end`, `ambient:click` (src/preload/ambientPreload.ts:12-16).
Preload bundle is loaded at `path.join(__dirname, '../preload/index.js')` (src/index.ts:479) with
`sandbox:true, contextIsolation:true, nodeIntegration:false, webviewTag:true` (src/index.ts:478-490).

**Config/storage files** (all under `getConfigPath()` = `<userData>/config`, symlinked on macOS to
`~/.darhai-config` / dev `~/.darhai-config-dev`, src/process/utils/utils.ts:102-106; work dir
`getDataPath()` = `<userData>/wayland` → `~/.darhai`, utils.ts:92-96):
- `wayland-config.txt` — main config store (`IConfigStorageRefer`), initStorage.ts:54-63,309-311
- `wayland-chat.txt` — conversation index; `wayland-chat-history/<conversationId>.txt` — per-conversation messages (initStorage.ts:357-389)
- `.darhai-env` — env store (`IEnvStorageRefer`); read synchronously at module load to resolve
  `wayland.dir` → optional custom `cacheDir`/`workDir` (initStorage.ts:303-307)
- On-disk format: `base64(encodeURIComponent(JSON))`, atomic 0o600 writes, serialized write chain
  (initStorage.ts:191-301). The four stores are injected into the shared `ConfigStorage/ChatStorage/ChatMessageStorage/EnvStorage`
  interceptors (initStorage.ts:955-958) and re-exported as `ProcessConfig/ProcessChat/ProcessChatMessage/ProcessEnv`
  (initStorage.ts:1240-1246) — the canonical main-process config API.
- Other userData files: `analytics.json` (analyticsId.ts:13), `cdp.config.json` (configureChromium.ts:79),
  `webui.config.json` (webuiConfig.ts:15), `~/.darhai-cdp-registry.json` (configureChromium.ts:78).
- Managed dirs under config: `assistants/`, `skills/` (user), `builtin-skills/` (+`_builtin/` auto),
  `cron-skills/` (initStorage.ts:54-63,394-427); `<userData>/extensions/` for bundled packs
  (initStorage.ts:81-111).

**Config keys touched here** (via `ProcessConfig`): `mcp.config`, `tools.imageGenerationModel`,
`assistants`, `acp.customAgents`, `migration.assistantsSplitCustom`, `migration.assistantEnabledFixed`,
`migration.builtinDefaultSkillsAdded_v2`, `migration.promptsI18nAdded` (initStorage.ts:981-1217),
`system.closeToTray`, `system.firstRunDefaultsApplied` (firstRunDefaults.ts:24-48),
`system.credentialsCryptoMigrated_v1` (credentialMigration.ts:28), `ui.zoomFactor` (src/index.ts:821),
`language` (src/index.ts:984), `ambient.enabled` (src/index.ts:933), `webui.desktop.enabled|allowRemote|port`
(webuiConfig.ts:16-18), `skills.preferences` (initAgent.ts:95), `guid.lastSelectedAgent` + `model.config`
+ `acp.config` (workflowLaunchTargetResolver.ts).

**Spawned processes & runtimes.**
- Workers: `getPlatformServices().worker.fork` → Electron `utilityProcess.fork` with `DATA_DIR`
  injected (ElectronPlatformServices.ts:66-75) or Node `child_process.fork` with
  `serialization:'advanced'` (NodePlatformServices.ts:80-92).
- Builtin MCP stdio children: external `node <script>` where script ∈ `MCP_STDIO_SCRIPT_NAMES`
  (mcpScriptDir.ts:56-61), resolved next to the main bundle (dev `out/main/`, packaged
  `app.asar.unpacked/out/main/`); config entries `BUILTIN_IMAGE_GEN_ID` / `BUILTIN_SEARCH_SKILLS_ID`
  written into `mcp.config` (initStorage.ts:710-899). Image-gen env contract:
  `DARHAI_IMG_PLATFORM/BASE_URL/API_KEY/MODEL` (initStorage.ts:729-737). Startup canary
  `inspectMcpScripts()` hard-fails packaged boot if scripts are missing (initStorage.ts:1004-1019).
- Default user-facing MCP entry: `npx -y chrome-devtools-mcp@latest`, disabled (initStorage.ts:661-686).
- Shell env for all children comes from `loadShellEnvironmentAsync()` merged into `process.env.PATH`
  (src/index.ts:1026-1036); bundled bun fallback + AVX2 probe live in shellEnv.ts.

**Env vars read by this area.** `SENTRY_DSN`, `DARHAI_E2E_TEST`, `DARHAI_MULTI_INSTANCE`,
`ELECTRON_RENDERER_URL`, `CI`/`GITHUB_ACTIONS`, `DARHAI_DISABLE_AUTO_UPDATE`, `DARHAI_DISABLE_IJFW`,
`DARHAI_AMBIENT` (src/index.ts), `DARHAI_CDP_PORT`, `DARHAI_DISABLE_SANDBOX` (configureChromium.ts),
`DARHAI_PORT`/`PORT`, `DARHAI_ALLOW_REMOTE`/`DARHAI_REMOTE`, `DARHAI_HOST` (webuiConfig.ts),
`DARHAI_EXTENSIONS_PATH` (dev extensions, referenced initStorage.ts:76), `DATA_DIR`, `LOGS_DIR`,
`IS_PACKAGED` (NodePlatformServices.ts:68-73), `IMPORT_CONFIG_FROM`, `IMPORT_CONFIG_OVERWRITE`
(initStorage.ts:967-969), `PREBUILDS_ONLY` (set, src/process/index.ts:17), `NVM_DIR` (src/index.ts:162),
`ACP_PERF` (shellEnv.ts:23).

**DB touchpoints.** `getDatabase()` (better-sqlite3) initialized in initStorage step 6
(initStorage.ts:1223-1230); initBridge.ts wires repositories over the shared driver and prunes
`usage_events` (90d) and `cost_events` (180d) on startup (initBridge.ts:145-174).

## Conventions & invariants

- **Import order is a contract**: `configureChromium` before any `app.getPath('userData')` caller;
  `register-electron`/`register-node` as FIRST import of the process entry; `configureConsoleLog`
  before modules that log. New early side-effect modules must slot into src/index.ts:7-57 knowingly.
- **No direct `app.getPath` in shared process code** — go through `getPlatformServices().paths` so the
  code stays runnable in standalone server mode (the only Electron-importing platform file is
  `ElectronPlatformServices.ts`, see its line 1 comment). Electron-vs-standalone divergence is handled
  by `hasElectronAppPath()` (utils.ts:14-16), not by `process.platform` checks.
- **Every Electron bridge added to `initBridge.ts` needs a standalone decision** in
  `initBridgeStandalone.ts` (init, skip, or a `*Standalone` variant — see its lines 7-13).
- **State files use atomic writes**; secret-bearing files pass `{mode:0o600}` and get Windows DACL
  hardening (atomicWrite.ts:23-39). Never plain `writeFile` for state.
- **Migrations are one-shot, flag-gated, non-fatal**: pattern = read `migration.*` / `system.*Migrated*`
  flag → do work → set flag; wrap in try/catch so app launch is never blocked (initStorage.ts:1044-1067,
  credentialMigration.ts:37-102). Leave the flag unset on partial failure so it retries.
- **Startup steps are timed** with `mark()` labels (`[Wayland:init]`, `[Wayland:ready]`,
  `[Wayland:process]`) and are individually non-fatal unless truly fatal (initializeProcess failure →
  `app.exit(1)`, src/index.ts:814-818).
- **Quit-side resources must join the before-quit chain**: prefetch the module in
  `prefetchCleanupModules` (src/index.ts:1116-1138), add a `withTimeout` step in `cleanup()`
  (src/index.ts:1279-1400), keep the 2s/10s budgets.
- **New preload APIs are explicit allowlists** — no generic `ipcRenderer` passthrough; prefer the
  adapter bridge (`ipcBridge.*` provider) over new raw channels; raw channels need listener-hygiene
  like the weixin single-listener pattern (src/preload/main.ts:29-63).
- **Renderer security triad is non-negotiable**: sandbox+contextIsolation+no nodeIntegration
  (src/index.ts:478-490); webviews get preload stripped and triad forced (src/index.ts:531-538);
  window.open denied globally (src/index.ts:347-365); CSP changes go through `buildRendererCsp`
  (src/index.ts:264-304) with hash-pinned inline scripts.
- App-managed resource dirs (`builtin-skills/`, bundled extensions) are prune-then-copy synced every
  launch and must never touch user-owned siblings (`skills/`, user extensions) — initStorage.ts:487-507.

## Assimilation anchors

1. **New always-on main-process service** (e.g. an ECC/IJFW daemon): follow the IJFW system-service
   pattern in src/index.ts:636-668 — dynamic `import('./process/services/<svc>')` inside
   `createWindow`/`handleAppReady`, guarded by `isCiRuntime || DARHAI_DISABLE_<X>=1 || DARHAI_E2E_TEST`,
   deferred via `setTimeout` so first paint is not blocked, errors logged not thrown. Closest analog:
   `ijfwSystemService` (also `autoUpdaterService`, src/index.ts:613-631). If it holds resources, add a
   cleanup step to `prefetchCleanupModules` + `cleanup()` (src/index.ts:1116-1138, 1279-1400).
2. **New service wired to SQLite + IPC** (repos/analytics/recorders): mirror the cost stack in
   src/process/utils/initBridge.ts:149-235 — construct `Sqlite*Repository(db.getDriver())` inside the
   `getDatabase().then(...)` block, expose via `init*Bridge(...)`, register renderer-callable providers
   eagerly before DB resolves if cold-start events matter (see `ensureUsageProviderRegistered`,
   initBridge.ts:134). Then decide its standalone fate in initBridgeStandalone.ts:54-106.
3. **New persistent config/flag**: add a key to `IConfigStorageRefer` (src/common/config/storage) and
   read/write through `ProcessConfig` (initStorage.ts:1240); for one-time behavior copy the
   `applyFirstRunDefaults` gate pattern (firstRunDefaults.ts:22-52); for data migrations copy the
   flag-gated blocks in initStorage.ts:1044-1067.
4. **New bundled agent-facing skill pack**: drop content under `src/process/resources/skills/` — it is
   synced to `<config>/builtin-skills/` on every boot by `initBuiltinAssistantRules`
   (initStorage.ts:432-611); auto-injected-for-all lives in `_builtin/` (initStorage.ts:417-419);
   per-assistant enablement flows through `ASSISTANT_PRESETS` → `getBuiltinAssistants()`
   (initStorage.ts:616-656) and workspace symlinks in initAgent.ts:58-120.
5. **New builtin MCP stdio tool**: add the script name to `MCP_STDIO_SCRIPT_NAMES`
   (mcpScriptDir.ts:56-61), emit it via `scripts/build-mcp-servers.js`, and ensure a config entry in
   `ensureBuiltinMcpServers` mirroring the search-skills block (initStorage.ts:818-884) — the canary
   (initStorage.ts:1004-1019) then guards it at boot.
6. **New preload capability**: add an allowlisted method on `window.electronAPI`
   (src/preload/main.ts:93-152) backed by an `ipcMain.handle` in the owning bridge, or preferably a new
   `ipcBridge.<domain>.<name>` provider so it also works over the WebUI transport; imitate the
   constitution API cluster (src/preload/main.ts:131-143).
