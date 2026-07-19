# 09 process-bridge-ipc

## Purpose (3-5 lines)

The bridge layer is Darhai's entire renderer↔main IPC surface. Every cross-process contract is declared once in `src/common/adapter/ipcBridge.ts` (2,563 lines) as typed `buildProvider` (renderer→main request/response) / `buildEmitter` (main→renderer push) objects; `src/process/bridge/*` contains the ~68 main-process implementation modules that register `.provider()` handlers for those keys. All traffic flows over a single Electron IPC channel (or a WebSocket in WebUI/standalone mode) and is gated by a build-time-registered allowlist (`bridgeAllowlist.ts`), a remote-caller denylist, filesystem path confinement, and a rate-limited/dialog-gated `webui-direct-*` side family.

## Entry points & lifecycle

- **Electron main boot**: `src/index.ts:68` imports `initializeProcess` from `src/process/index.ts`, which side-effect-imports `src/process/utils/initBridge.ts` (`src/process/index.ts:20`). That module constructs SQLite repos/services and calls `initAllBridges(deps)` (`src/process/bridge/index.ts:84`) at module load — i.e. all provider handlers exist before any window is created. `initBridge.ts` also wires cost/usage/workflow bridges asynchronously after `getDatabase()` resolves (`src/process/utils/initBridge.ts:149-319`).
- **Adapter attach**: `src/common/adapter/main.ts` calls `bridge.adapter({emit,on})` at import time (line 38) and registers the single `ipcMain.handle(ADAPTER_BRIDGE_EVENT_KEY, ...)` dispatcher (line 83). Windows are attached per-`BrowserWindow` via `initMainAdapterWithWindow` (`src/common/adapter/main.ts:98`), called from `src/index.ts:602`; `emit` fan-outs serialize once and send to every live window plus all WebSocket clients (`main.ts:39-78`).
- **Preload**: `src/preload/main.ts:93` exposes `window.electronAPI` — `emit(name,data)` = `ipcRenderer.invoke('office-ai-bridge-adapter', JSON)` and `on(cb)` for pushed events — plus a small set of raw invoke channels that bypass the bridge library (`webui-direct-*`, `constitution:*`, `feedback:collect-logs`, `onboarding:detect|fluxMetrics`, `weixin:login:*`; lines 120-151).
- **Renderer adapter**: `src/common/adapter/browser.ts:24-41` binds the platform bridge to `electronAPI` when present; otherwise (WebUI in a browser) it opens a WebSocket to the page host (`browser.ts:42-248`) with queueing, exponential-backoff reconnect, `ping`/`pong` heartbeat, and `auth-expired` / close-code-1008 redirect to `/login`.
- **WebUI server path**: `src/process/webserver/adapter.ts:23` (`initWebAdapter`) registers a broadcaster into `src/common/adapter/registry.ts` and dispatches inbound WS messages through **both** `isAllowedInboundName` and `isAllowedForRemote` (`webserver/adapter.ts:36-47`) before hitting the shared bridge emitter.
- **Standalone (no Electron)**: `src/server.ts:110` calls `initBridgeStandalone()` (`src/process/utils/initBridgeStandalone.ts:54`), which registers the Electron-safe subset of bridges (skips dialog/windowControls/update/webui; swaps `shellBridge` → `shellBridgeStandalone`, `applicationBridge` → `applicationBridgeCore`). The adapter is `src/common/adapter/standalone.ts` (Node `EventEmitter` instead of `ipcMain`, same allowlist check at line 28).
- **Allowlist population**: keys only exist because `adapter/main.ts:17` / `standalone.ts:11` side-effect-import `./ipcBridge` — every `buildProvider`/`buildEmitter`/`buildStorage` call records its key at module load (`bridgeAllowlist.ts:74-115`). Without that import every renderer call would be rejected.
- **eccBridge lifecycle**: `initEccBridge()` registers `ecc.getStatus` / `ecc.setGateGuard` providers and schedules a background `seedEccIfAbsent()` of the bundled ECC harness 7s after launch (`src/process/bridge/eccBridge.ts:15-31`).

## Key modules

### src/common/adapter (contract + dispatch layer)

| File | Responsibility |
| --- | --- |
| `src/common/adapter/ipcBridge.ts` | Single source of truth for all IPC contracts: ~60 exported namespaces of typed providers/emitters + their param/result types. No logic — declarations only. |
| `src/common/adapter/bridgeAllowlist.ts` | C1 hardening: wraps `bridge.buildProvider`/`buildEmitter`/`storage.buildStorage` to record every declared key; `isAllowedInboundName` (lines 352-396) validates every inbound wire name; `isAllowedForRemote` (line 333) applies the remote WS denylist (`REMOTE_DENIED_PREFIXES` lines 131-143, `REMOTE_DENIED_KEYS` lines 154-319). |
| `src/common/adapter/main.ts` | Electron main adapter: serializes emits to all windows + WS broadcast, 50MB payload cap (line 36), the single `ipcMain.handle` inbound dispatcher with allowlist rejection (lines 83-94), `initMainAdapterWithWindow`. |
| `src/common/adapter/browser.ts` | Renderer adapter: `electronAPI` path (Electron) or WebSocket path (WebUI) with reconnect/auth handling; also registers the renderer logger provider. |
| `src/common/adapter/standalone.ts` | Standalone-server adapter over a Node `EventEmitter`; `dispatchMessage(name,data)` (line 41) is the WS→bridge entry used by `webserver/adapter.ts` in headless mode. |
| `src/common/adapter/registry.ts` | Electron-free shared state: WebSocket broadcaster registry (`registerWebSocketBroadcaster`/`broadcastToAll`) + the bridge emitter reference (`set/getBridgeEmitter`). |
| `src/common/adapter/constant.ts` | Wire constants: `ADAPTER_BRIDGE_EVENT_KEY = 'office-ai-bridge-adapter'` (line 7), `SHOW_OPEN_REQUEST_EVENT` (line 13). |
| `src/common/adapter/bridgeAllowlist.budgets.bun.test.ts` | Bun test asserting the cost/budget keys are remote-denied while read keys (e.g. `cron.list-jobs`) stay remote-allowed. |

### src/process/bridge (implementation layer)

| File | Responsibility |
| --- | --- |
| `index.ts` | `initAllBridges(deps)` — ordered registration of every bridge with injected services (`BridgeDependencies` at line 73); re-exports individual inits for standalone use. |
| `acpConversationBridge.ts` | ACP agent surface: `acp.*` providers (detect CLI path, available agents via `agentRegistry`, env check, health check, session mode/model/config-option get/set) against `AcpAgentManager`/`WCoreManager` tasks. |
| `ambientBridge.ts` | Ambient-mode bubble config persistence (`ambient.get/setBubblePosition`, `get/setEnabled`); window lifecycle itself lives in `ambientWindowManager`. |
| `applicationBridge.ts` | Electron-only app controls: restart, DevTools toggle/state, zoom, CDP status/config, start-on-boot; delegates platform-agnostic part to `applicationBridgeCore`. |
| `applicationBridgeCore.ts` | Platform-agnostic `application.systemInfo` / `getPath` / `updateSystemInfo` (registers approved dirs); used by both Electron and standalone. |
| `authBridge.ts` | Google OAuth for Gemini (`googleAuth.login/logout/status`) via `@office-ai/aioncli-core` cached-credential flow. |
| `bedrockBridge.ts` | `bedrock.test-connection` — dynamic-imports the Bedrock generator, temporarily swaps `AWS_*` env vars, probes a default model (`DEFAULT_BEDROCK_MODEL` at line 9). |
| `channelBridge.ts` | Messaging-channel plugins (Telegram/WhatsApp/Feishu/SMS...): plugin enable/disable/test, pairing approve/reject, authorized users, webhook token rotation + exposure resolution, settings sync, `channel.*` emitters. |
| `constitutionBridge.ts` | Raw `ipcMain.handle('constitution:*')` family: read/write/reset `~/.darhai/CONSTITUTION.md` + per-specialist overlays in `~/.darhai/specialists/<id>.md` (id regex-validated, rate-limited via `webuiDirectAuth`). |
| `conversationBridge.ts` | Core conversation CRUD + chat: create/get/update/remove/reset, `chat.send.message`, stop-stream, slash commands, side-questions (via `ConversationSideQuestionService`), workspace listing, warmup, title generation, confirmation store. |
| `costBridge.ts` | Cost observability + budgets: `cost.summary/byModel/byBackend/byConversation/byTeam/series` reads over `CostAnalyticsService`; `initCostBudgetBridge` wires `BudgetController` mutations (whole namespace remote-denied). |
| `cronBridge.ts` | Scheduled jobs: `cron.*` CRUD/run-now/confirm-proposal against `cronService` singleton + per-job skill files (`cronSkillFile`). |
| `databaseBridge.ts` | Read-only DB queries: conversation messages, user conversations, message search; lazily migrates file-stored conversations via `migrationUtils`. |
| `dialogBridge.ts` | Native open dialog (`dialog.showOpen`); every user-picked directory is registered into `userApprovedPaths` (line 9 import). |
| `documentBridge.ts` | Office document conversion requests routed to `conversionService` (word/excel extension sets at lines 17-18). |
| `eccBridge.ts` | ECC harness surface: `ecc.getStatus` / `ecc.setGateGuard` + delayed idempotent `seedEccIfAbsent()` background install (7s, line 15). |
| `extensionsBridge.ts` | Extension registry views: themes, assistants, agents, ACP adapters, MCP servers, skills, settings tabs, webui contributions, i18n merge, enable/disable + permissions, TTL-cached agent-activity snapshot (3s, line 12). |
| `feedbackBridge.ts` | Raw `ipcMain.handle('feedback:collect-logs')`: gzips recent electron-log files for bug reports (rate-limited). Side-effect-imported directly by `src/index.ts:72`. |
| `fileWatchBridge.ts` | `fs.watch`-based file watchers keyed by path; `stopAllFileWatchers()` (line 18) is the before-quit cleanup. |
| `fluxConnectorBridge.ts` | Flux Router compatibility connectors for opencode/codex CLIs: status/setup/remove; flux key never leaves main. |
| `fsBridge.ts` | Largest bridge (2,078 lines): all `fs.*` providers — dir listing, read/write/rename/remove, zip create/cancel, workspace copy, image base64, assistant rule/skill files, skill scan/import/symlink/export, custom external paths. Every renderer path passes `confinePath` or `resolveWithinApprovedDirectory` (lines 393-403, 946-956). |
| `geminiBridge.ts` | `gemini.subscription-status` via `geminiSubscription` service. |
| `geminiConversationBridge.ts` | Gemini `input.confirm.message` provider (MCP tool confirmation incl. "always allow"). |
| `hubBridge.ts` | Agent Hub extension install/uninstall/update/check-updates over `HubIndexManager`/`HubInstaller`/`HubStateManager` (namespace remote-denied). |
| `hwfitBridge.ts` | Hardware-fit model advisor: `hwfit.scan-hardware/rank-models/catalog-size` (read-only; spawns host probes, remote-denied). |
| `ijfwBridge.ts` | IJFW surface: zod-validated `ijfw.brain-invoke` against `ijfwMcpClient`, lifecycle status/get/check/trigger-install/skip-setup/runtime-mode. |
| `ijfwDropBridge.ts` | IJFW drop-tab: list/ingest/quarantine files in `~/.ijfw/dump` with main-side lstat/size/extension/containment checks (SEC-013). |
| `importBridge.ts` | `memory.import.*` handlers delegating to claude-mem / claude-native / ijfw archive importers, zod-validated. |
| `kickoffBridge.ts` | Kickoff suggestions: `suggest({assistantId})` (awaits cron readiness) + fire-and-forget telemetry. |
| `mcpBridge.ts` | MCP management: agent config aggregation, test connection, sync/remove to agents, OAuth status/login/logout, BYO credentials. |
| `memoryArchiveBridge.ts` | `memory.*` namespace over `ijfwArchiveService` + wiki promotion (`promoteEntry`/`undoPromotion`); `initPromotionSweep` starts the background sweep. |
| `migrationUtils.ts` | Lazy file→SQLite conversation migration helper used by databaseBridge. |
| `missionControlBridge.ts` | `mission-control.snapshot` one-shot unified task ledger (team tasks + cron) via `TaskLedgerService`. |
| `modelBridge.ts` | Legacy model/provider config surface (1,563 lines): `mode.get-model-list` (with protocol fix-up), save/get model config, protocol detection. |
| `notificationBridge.ts` | System notifications (`notification.show` provider + `showNotification()` for main-side callers) via platform services. |
| `officeWatchBridge.ts` | Word/Excel live preview: spawns `officecli watch <file> --port N` per file (line 187), port probing, status emitters, confinement of the watched path (lines 149-151). |
| `officecliInstaller.ts` | Degraded-case officecli installer: native consent dialog + version-pinned script download + SHA-256 verification (fail closed). |
| `onboardingBridge.ts` | Onboarding: `connect-flux` (OAuth+PKCE loopback), `connect-pasted-key` (provider auto-detect), `infer-focus`; raw `ipcMain` `onboarding:detect`/`fluxMetrics`. |
| `pathConfinement.ts` | Authorized-roots filesystem confinement: static app roots + registered workspace roots + DB-discovered workspaces (TTL 30s, line 42), sensitive-segment denylist (line 59), UNC/ADS/traversal rejection, symlink collapse — `confinePath()` at line 269. |
| `pendingSendBridge.ts` | SEC-8 asleep-engine pending-send store: hold/take/peek/clear over a main-memory-only Map; all four keys remote-denied. |
| `pptPreviewBridge.ts` | PPT live preview: same officecli-watch pattern as `officeWatchBridge` for `.pptx`. |
| `previewHistoryBridge.ts` | Preview snapshot history list/save/get-content via `previewHistoryService`. |
| `projectBridge.ts` | Projects: CRUD, conversation (re)parenting, `.darhai/` knowledge docs read/write, reference files, summaries + AI drafts, `project.changed` emitter; paths confined. |
| `remoteAgentBridge.ts` | Remote agent configs (openclaw gateway): CRUD in DB, ws/wss-only URL validation (SSRF guard), test-connection, handshake with device identity. |
| `shellBridge.ts` | Electron shell surface: open file/folder/external (scheme allowlist via `isAllowedExternalUrl`, line 244), open-with vscode/terminal/explorer (spawns `code`/`powershell.exe`/terminal emulators, lines 88-176), `shell.open-path` behind `confinePath` (line 297). |
| `shellBridgeStandalone.ts` | Same shell contract implemented with `child_process.execFile` for headless mode (cmd.exe `start` metachar rejection). |
| `skillsBridge.ts` | Skills library: scan/report/rescan (SkillGuard), import folder/git/zip/single-md (SkillImport), list/stats/get-body/update-body/save, pin, add-to-conversation, CLI-discovery toggle. |
| `speechToTextBridge.ts` | Thin `speech-to-text.transcribe` → `SpeechToTextService`. |
| `starOfficeBridge.ts` | Detects a running Star Office local server by port scanning (radius 24, concurrency 6) with hit/miss TTL cache. |
| `systemSettingsBridge.ts` | System settings get/set: close-to-tray, notifications, cron notifications, keep-awake (power blocker), route-through-flux, language change + `languageChanged` broadcast, upload-to-workspace, auto-preview. |
| `taskBridge.ts` | `task.stop-all` / `task.get-running-count` over `IWorkerTaskManager`. |
| `teamBridge.ts` | Team sessions: zod `.strict()` bounded schemas at the IPC boundary (W5 audit HIGH-1), roster suggestion, import/export, ritual resolver wiring. |
| `testCustomAgentConnection.ts` | Two-step custom ACP agent test: CLI existence (`which`/`where` via `execFileSync`) then spawn + ACP initialize. |
| `updateBridge.ts` | Manual GitHub-release update check/download + electron-updater auto-update (check/download/quit-and-install/status). |
| `usageBridge.ts` | Usage telemetry: eager provider registration with pre-DB buffering (`ensureUsageProviderRegistered`), event-type validation, frequently-used aggregation. |
| `userApprovedPaths.ts` | User-approved out-of-root write destinations (dialog-picked or main-resolved Desktop), FIFO-capped at 64 (line 33); `resolveWithinApprovedDirectory()` at line 113. |
| `voiceAssetBridge.ts` | Voice model asset download/cancel/exists + `wayland-asset://` local model base URL for the bundled Whisper ONNX. |
| `voiceSynthBridge.ts` | TTS `voice-synth.speak/stop` using `tools.textToSpeech` config from `ConfigStorage`. |
| `wcoreConfigBridge.ts` | Wayland Core engine `config.toml` sections + profile dirs (`wcoreConfig.*`, `wcoreProfiles.*`); SEC-6: setSection sanitizes the env-passthrough allowlist; all keys remote-denied. |
| `webuiBridge.ts` | WebUI server lifecycle: start/stop/status, password/username change, QR token mint/verify, paired devices, activity log — plus the gated raw `webui-direct-*` `ipcMain` handlers (lines 251-397). |
| `webuiDirectAuth.ts` | Guards for `webui-direct-*` and other raw families: `enforceRateLimit` (5 req/60s sliding window, lines 32-34), `requireConfirmation` (native main-process dialog, line 71), `verifyCurrentPassword` (bcrypt, line 105). |
| `webuiQR.ts` | Electron-free QR login: in-memory one-shot tokens (5-min expiry, lines 17-20), local-IP restriction that fails closed on missing client IP (lines 126-148), session token minting. |
| `weixinLoginBridge.ts` | WeChat login raw `ipcMain` family (`weixin:login:start` + qr/scanned/done pushes), rate-limited; single-listener semantics enforced in preload (RT-F4-03). |
| `wikiBridge.ts` | `wiki.*` namespace: index build/state + synthesizer + auto-sync sweep, zod-validated. |
| `windowControlsBridge.ts` | Window minimize/maximize/close/is-maximized + `registerWindowMaximizeListeners` emitter wiring. |
| `workflowBridge.ts` | Workflow launch surface: `registerWorkflowBridge()` eager stub registration + `initWorkflowBridge(svc)` late service swap (two-step boot mirrors usageBridge); autonomous step dispatch. |
| `workspaceSnapshotBridge.ts` | `fileSnapshot.*` (init/compare/baseline/stage/discard/branches) over `WorkspaceSnapshotService`; stale-snapshot cleanup on init. |
| `services/ActivitySnapshotBuilder.ts` | Builds the extension-facing agent-activity snapshot from conversations + worker tasks. |
| `services/ConversationSideQuestionService.ts` | ACP side-question execution with 30s timeout and backend support detection. |
| `services/SpeechToTextService.ts` | STT provider dispatch (OpenAI-compatible API or local Whisper via `WhisperLocal`). |
| `services/WebuiService.ts` | WebUI business logic: status assembly, LAN IP discovery, initial-admin-password handoff, password ops (lazy webserver import to break the cycle). |
| `__tests__/webuiQR.test.ts` | Tests for QR token expiry/one-shot/local-IP gating. |

## Contracts & data flow

**Wire protocol** (documented at `src/common/adapter/bridgeAllowlist.ts:22-27`, verified against `@office-ai/platform`):
- Provider invocation renderer→main: `subscribe-<key>`; response main→renderer: `subscribe.callback-<key><key><8hex>` (key doubled — the single-key form is accepted for back-compat, `bridgeAllowlist.ts:375-392`).
- Emitter events main→renderer: raw `<key>`. Renderer-side providers (main invokes renderer) must be listed in `RENDERER_PROVIDED_KEYS` — currently only `conversation.response.search.workspace` (`bridgeAllowlist.ts:49-52`).
- Everything rides one Electron channel: `'office-ai-bridge-adapter'` (`src/common/adapter/constant.ts:7`), JSON-stringified `{name, data}`, 50MB cap with a `bridge:error` notification on overflow (`main.ts:36-66`).

**Provider namespaces** (all in `src/common/adapter/ipcBridge.ts`; line = declaration): `shell` 66, `conversation` 80, `geminiConversation` 145, `application` 192, `update` 219, `autoUpdate` 231, `starOffice` 251, `dialog` 258, `fs` 265, `speechToText` 371, `voiceSynth` 375, `skills` 380, `voiceAsset` 457, `fileWatch` 470, `workspaceOfficeWatch` 478, `fileStream` 483, `fileSnapshot` 494, `googleAuth` 519, `onboarding` 527, `pendingSend` 574, `gemini` 588, `bedrock` 596, `mode` 611, `acpConversation` 637, `mcpService` 700, `codexConversation` 755, `openclawConversation` 761, `remoteAgent` 793, `database` 817, `previewHistory` 832, `preview` 842, `document` 854, `pptPreview` 862, `wordPreview` 871, `excelPreview` 880, `deepLink` 889, `windowControls` 904, `systemSettings` 914, `fluxConnector` 937, `ambient` 948, `notification` 963, `task` 969, `webui` 986, `cron` 1050, `missionControl` 1079, `hwfit` 1090, `extensions` 1445, `channel` 1495, `hub` 1578, `ijfw` 1622, `ecc` 1647, `modelRegistry` 1825, `wcoreToolKeys` 1896, `wcoreConfig` 1917, `wcoreProfiles` 1961, `team` 1990, `providerNicknames` 2104, `sync` 2114, `storage` 2123, `kickoff` 2140, `workflow` 2150, `usage` 2257, `cost` 2293, `memory` 2359, `wiki` 2428, `project` 2470.

**Security layering** (must pass ALL applicable gates):
1. Inbound allowlist — undeclared names rejected at `main.ts:89`, `standalone.ts:28`, `webserver/adapter.ts:36`.
2. Remote WS denylist — paired-device WebSocket callers additionally pass `isAllowedForRemote` (`webserver/adapter.ts:44`). Denied prefixes: `shell.`, `hub.`, `cost.` (`bridgeAllowlist.ts:131-143`). Denied exact keys (`bridgeAllowlist.ts:154-319`): fs mutation/raw-read (`write-file`, `read-file`, `create-zip-file`...), skill mutation, `modelRegistry.connect/rekey/detectKeys/resolveForChatStart` (C4: plaintext keys), `wcoreToolKeys.*`, `wcoreConfig.*`, `wcoreProfiles.*`, `pendingSend.*` (SEC-8), channel pairing/config, `webui.*` admin auth, onboarding credential writes, `hwfit.*`, `storage:*` destructive ops, **`ecc.set-gate-guard`** (line 308), and app-control keys (`restart-app`, `open-external`...).
3. Path confinement — every renderer-supplied fs path goes through `confinePath` (fsBridge, projectBridge, shellBridge `open-path`, officeWatchBridge) or `resolveWithinApprovedDirectory` (zip/write destinations).
4. Raw-`ipcMain` guards — `webui-direct-*`, `constitution:*`, `feedback:*`, `weixin:*` use `enforceRateLimit` (5/60s) + `requireConfirmation` native dialog + bcrypt `verifyCurrentPassword` (`webuiDirectAuth.ts:32-114`).

**Storage keys**: `buildStorage(ns)` registers wire keys `<ns>.storage.{get,set,clear,remove}` (`bridgeAllowlist.ts:106-115`); namespaces are `agent.chat`, `agent.chat.message`, `agent.config`, `agent.env` (`src/common/config/storage.ts:19-28`). ECC config lives in `ProcessConfig`: `ecc.gateGuardEnabled` (default **true**), `ecc.autoInstall`, `ecc.seedInProgress` (`src/process/services/eccSystemService.ts:81-108`).

**Spawned processes**: `officecli watch <file> --port N` (`officeWatchBridge.ts:187`, same pattern in `pptPreviewBridge.ts`) with consent-gated SHA-256-pinned installer fallback (`officecliInstaller.ts`); VS Code / PowerShell / terminal emulators (`shellBridge.ts:88-176`); custom ACP CLI probe (`testCustomAgentConnection.ts`); hardware probes `nvidia-smi`/`rocminfo`/`sysctl`/WMI behind `hwfit.*` (documented at `bridgeAllowlist.ts:290-297`). `bedrockBridge.ts` temporarily mutates `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_PROFILE` env vars during connection tests.

**In-memory stores (never persisted)**: QR login tokens (5-min one-shot, local-IP-gated, `webuiQR.ts:17-20`); pending-send message bodies (`pendingSendBridge.ts`); rate-limit buckets (`webuiDirectAuth.ts:36`); approved directories (FIFO 64, `userApprovedPaths.ts:33`); authorized fs roots (`pathConfinement.ts:45`).

**Response envelope**: older namespaces use `IBridgeResponse { success, data?, msg? }` (`ipcBridge.ts:1363-1367`); newer ones (skills, memory, wiki, ijfw, ecc) use `{ ok: true, ... } | { ok: false, error }` discriminated unions. Handlers must return structured errors — never throw across IPC.

## Conventions & invariants

- **Declare-before-implement**: a new IPC key MUST be declared in `src/common/adapter/ipcBridge.ts` via the wrapped `buildProvider`/`buildEmitter` from `bridgeAllowlist.ts` (never the raw platform factories) — otherwise dispatch rejects it. Storage namespaces likewise must use the wrapped `buildStorage`.
- **One init function per bridge**: `init<Name>Bridge(deps?)` registered in `initAllBridges` (`src/process/bridge/index.ts:84-151`); services are constructor-injected there, not imported as singletons inside handlers (with a few legacy exceptions like cronService).
- **Standalone parity**: any bridge that is Electron-free must also be registered in `initBridgeStandalone.ts`; Electron-only functionality is split out (`applicationBridge`/`applicationBridgeCore`, `shellBridge`/`shellBridgeStandalone`, `webuiBridge`/`webuiQR`+`WebuiService`).
- **Remote-threat review**: every new provider that writes, executes, or touches credentials must be added to `REMOTE_DENIED_KEYS`/`_PREFIXES` — the WS token proves a paired browser, not the trusted local user. Each entry carries a rationale comment; keep that style.
- **Secrets never cross IPC**: decrypted provider keys stay main-side (`IModelRegistryChatStartPayload` is main-only; renderer gets the secret-free `IModelRegistryChatStartHandle`, `ipcBridge.ts:1721-1798`). Presence-only views for tool keys (`IWcoreToolKeyPresence`).
- **Renderer paths are hostile**: fs providers validate via `confinePath`/`resolveWithinApprovedDirectory`; the allowlist validates names, never arguments.
- **Raw `ipcMain.handle` is exceptional**: only for zero-arg/read-only or dialog-gated destructive families, always guarded by `webuiDirectAuth` helpers, and its channels must be added to `src/preload/main.ts`.
- **Boundary validation with zod**: newer bridges (`teamBridge`, `ijfwBridge`, `importBridge`, `memoryArchiveBridge`, `wikiBridge`) use `.strict()` bounded schemas at the IPC boundary.
- **Two-step boot for early renderer calls**: if the renderer may call before the DB is ready, register providers eagerly with buffering/stub, swap the live service later (`usageBridge`, `workflowBridge`).

## Assimilation anchors

- **New feature namespace (the standard route)**: declare `export const myFeature = {...}` in `src/common/adapter/ipcBridge.ts` imitating `ecc` (line 1647, minimal) or `hwfit` (line 1090, typed read-only); implement `src/process/bridge/myFeatureBridge.ts` imitating `eccBridge.ts` (32 lines — the cleanest template: providers + background seeding); register in `initAllBridges` (`src/process/bridge/index.ts`) and, if Electron-free, in `initBridgeStandalone.ts`. Add any mutation keys to `REMOTE_DENIED_KEYS`.
- **ECC/Superpowers/harness settings + bundled-asset seeding**: `eccBridge.ts` + `@process/services/eccSystemService` (`ecc.gateGuardEnabled`/`ecc.autoInstall` ProcessConfig keys, delayed idempotent `seedEccIfAbsent`) is the exact existing model for "bundle an agent harness, seed it on launch, expose a Settings toggle". A Superpowers/ECC-deepening feature extends this pair rather than inventing a new pattern.
- **Embedded agent/MCP service exposure**: `ijfwBridge.ts` (zod-validated `brain-invoke` verb dispatch against `ijfwMcpClient`, structured `errorReason` enums for i18n) is the template for exposing any new in-process MCP/agent brain to the renderer; `ijfwDropBridge.ts` shows the companion main-side file-safety pattern.
- **Sidecar/daemon process per document or port**: mirror `officeWatchBridge.ts` (spawn at line 187 + port probe + status emitter + `confinePath` on the target) with `officecliInstaller.ts` for consent-gated binary acquisition — the pattern for any new preview/daemon capability.
- **Skill/workflow ingestion**: `skillsBridge.ts` (SkillGuard scan → SkillLibrary register → quarantine on `blocked`) plus the `skills.import.*` providers is where vendored Superpowers/ECC skills plug in; `skills.list` already supports `type: 'workflow' | 'agent-profile'` (`ipcBridge.ts:394-400`) for non-skill entries.
- **New persisted setting**: follow `systemSettingsBridge.ts` get/set pairs over `ProcessConfig` + a `*Changed` emitter when live sync to all renderers (desktop + WebUI) is needed (`system-settings:language-changed` pattern).
