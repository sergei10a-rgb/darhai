# 14 renderer-memory-settings-pages

## Purpose

The renderer's "management surfaces": the IJFW Memory Archive (`pages/memory/**`), its sibling Wiki concept browser (`pages/wiki/**`), the entire Settings tree (`pages/settings/**` — 20+ routed pages incl. `EccSettingsPanel`, `IjfwSettingsPanel`, and the 7-pane `WCoreConfig` engine console), and the hwfit Model Advisor (`pages/model-advisor/**`). These pages are the primary UI seam for ECC/IJFW/Superpowers/Odysseus assimilation: every harness toggle, memory verb, engine-config section, and skill/agent installer already surfaces here. All routes are registered in `src/renderer/components/layout/Router.tsx` (area 12); this area documents the page internals and their IPC contracts.

## Entry points & lifecycle

- **Routing** — every page is a `React.lazy` chunk mounted by `components/layout/Router.tsx`: `/memory` → `pages/memory/MemoryPage.tsx`; `/wiki` + `/wiki/:slug` → `pages/wiki/WikiHomePage.tsx` / `WikiDetailPage.tsx`; `/model-advisor` → `pages/model-advisor/index.tsx` (Router.tsx ~line 178); `/settings/*` block at Router.tsx lines 110–171 (incl. legacy redirects `providers|gemini|model→models`, `wcore→wcore-config`, `mcp→mcp-library/installed`, `skills-hub→skills`, `display→theme`, `system→general`; bare `/settings` → `/settings/models`).
- **Memory page state machine** — `MemoryPage.tsx` fetches `ipcBridge.ijfw.getStatus.invoke()` on mount (line 115), subscribes `ipcBridge.ijfw.onStatusChanged.on` (line 136), and has a 1.5 s safety timer that falls back to `not_installed` (line 134). `renderStateBranch` (lines 28–68) routes the six `IjfwLifecycleStatus` states: `not_installed`+`reason:'opt_out'` → `InstallerPitchCard`; plain `not_installed` → `AutoSettingUpCard` (auto-install fires at +5 s from app boot, not from this page); `installing|upgrading|installed_pending_activation` → `InstallingCard`; `install_failed` → `InstallFailedCard`; `installed_current` (and any unknown status) → `FullPanelShell`. The `installed_current` branch renders full-bleed (`isFullPanel`, lines 77–87) because FullPanelShell owns its own header grid — wrapping it in PageShell would double the title.
- **Settings pages** — each mounts inside `SettingsPageWrapper` (nav rail, ⌘K command palette, shortcuts overlay) or the newer `SettingsPageShell` (adds standardized PageHeader). `SettingsSider.tsx` re-renders the left rail in settings mode and lazily merges extension tabs via `extensionsIpc.getSettingsTabs.invoke()` (line 126, retried up to 20 attempts) + `extensionsIpc.stateChanged.on` (line 164).
- **WCoreConfig** — mounts at `/settings/wcore-config`; on mount probes engine liveness via `ipcBridge.acpConversation.getAvailableAgents.invoke()` looking for `backend === 'wcore'` (index.tsx lines 46–55); pane switching is pure local state (`WCoreRailKey`), no sub-routes.
- **Model Advisor** — `useModelAdvisor.ts` drives everything through SWR: hardware scan once (`hwfit/hardware` key), catalog size once, then re-ranks per `useCase/fitOnly/override` key change. Ranking runs in the main process; search filtering is client-side (lines 68–73).

## Key modules

### pages/memory (IJFW Memory Archive)

| File | Responsibility |
|---|---|
| `pages/memory/MemoryPage.tsx` | Route shell + 6-state lifecycle router (see above); full-bleed switch for the installed branch |
| `pages/memory/getActiveBrainScope.ts` | `useActiveBrainScope()`: conversation `workspace` → `{scope:'project',path}` else app sentinel `{scope:'app',path:'/'}` (lines 25–42) |
| `pages/memory/types/brain.ts` | `IjfwVerb` allowlist union for `ipcBridge.ijfw.brainInvoke` (18 verbs: `think`, `memory_*`, `wiki.*`, `cross_*`, `state`, `metrics`, …) — renderer-side single source of truth (lines 17–37) |
| `pages/memory/hooks/useMemoryIndex.ts` | Central data hook: parallel `memory.getStats/listEntries/getProjects/getTags` (lines 112–117), auto-refetch on `memory.onIndexChanged` (line 137), 150 ms search debounce (line 180), client-side `typeCounts` |
| `pages/memory/hooks/useSelectedEntry.ts` | Inspector selection synced to URL `?entry=<id>` (source of truth); fetches full body via `memory.getEntry` (line 40); Esc clears |
| `pages/memory/state-branches/FullPanelShell.tsx` (+`.module.css`) | Mail-style 4-row grid (topbar/filterbar/main/statusbar); keyboard ⌘K,`/`,⌘N; drag-drop `.md/.markdown/.txt/.json` → `memory.ingestFiles` (lines 340–350); promote → `memory.promote` (line 255); cursor pagination via `offset` (line 287); push-content 480 px drawer |
| `pages/memory/state-branches/AutoSettingUpCard.tsx` (+css) | Silent background-install surface; progressive disclosure at 8 s / 60 s (consts lines 33–34); help link → `/settings/ijfw` |
| `pages/memory/state-branches/InstallerPitchCard.tsx` (+css) | Opt-out re-enable surface: serially `ijfw.skipSetup({enabled:false})` then `ijfw.triggerInstall` (lines 44–45; order load-bearing) |
| `pages/memory/state-branches/InstallingCard.tsx` (+css) | Progress card; reads `ijfw.getRuntimeMode` (line 57); offers `application.restart` after `installed_pending_activation` (line 89) |
| `pages/memory/state-branches/InstallFailedCard.tsx` (+css) | Shows `errorReason`+stderr; Retry → `ijfw.triggerInstall` (line 57) |
| `pages/memory/state-branches/OnboardingEmptyState.tsx` (+css) | **Orphan** — no importers reference it; demonstrates `ijfw.brainInvoke` with verb `memory_store` (line 57). Candidate for deletion or reuse |
| `pages/memory/components/MemoryList.tsx` / `MemoryRow.tsx` (+css) | Virtual-ish entry list, J/K keyboard nav, in-list zero state, end-reached callback |
| `pages/memory/components/RightDrawer.tsx` / `Inspector.tsx` (+css) | Entry detail drawer; source context preview via `memory.readSourceContext({path,line,contextLines:50})` (RightDrawer line 109) |
| `pages/memory/components/ComposerModal.tsx` (+css) | Quick-add (⌘N): `memory.setQuickAdd({content,scope})` (line 97); tags are UI-only in v1 (documented DEVIATION, lines 12–15) |
| `pages/memory/components/ImportDrawer.tsx` (+css) | Import hub: `memory.import.claudeMem/obsidianVault/scanDevDir/processDropFolder` + `obsidianDetectVaults` (lines 97–198); drop-folder constant `~/Documents/Darhai-Memory/` (line 69) |
| `pages/memory/components/EmptyStateHero.tsx` (+css) | Zero-state CTA cards firing the same `memory.import.*` verbs (lines 82–108) |
| `pages/memory/components/MemoryStatusBar.tsx` (+css) | 28 px status: brain-live dot, CLI count, lastDream; polls `memory.import.getDropFolderStatus` (line 93); opens folder via `shell.openPath` (line 114) |
| `pages/memory/components/PromotionThresholdModal.tsx` (+css) | Lazy-loaded; `memory.getPromotionCandidates` + `setPromotionThreshold` + `setAutoPromoteEnabled` (lines 36–72) |
| `pages/memory/components/TopbarChips.tsx`, `StreakPill.tsx`, `ProjectDropdown.tsx`, `TimeDropdown.tsx`, `TypeDropdown.tsx` (+css each) | Filter-bar primitives; TimeDropdown exports `TimeWindow` (custom ranges collapse to `'all'` — server unsupported, FullPanelShell line 76) |
| `pages/memory/MemoryPage.module.css` | `.page` (centered states) vs `.pageFullBleed` on `var(--bg-base)` |

### pages/wiki (concept browser)

| File | Responsibility |
|---|---|
| `pages/wiki/WikiHomePage.tsx` (+css) | 3-column browser (By Topic / Updated this week / Emerging) + Most Referenced strip + graph toggle. Cold load `wiki.getState` (line 92), live via `wiki.stateChanged.on` (line 105), `wiki.synthesizeNow` / `synthesizeOrphan` (lines 156, 167). Topic chips are the `WikiTopicTag` union (lines 30–38) |
| `pages/wiki/WikiDetailPage.tsx` (+css) | Concept page: `wiki.getConcept({slug})` (line 108), wikilink `[[X\|alias]]` → `#wikilink:` markdown links (regex line 40), backlink resolve via `wiki.resolveBacklink` (line 127), `wiki.reSynthesize` (line 152) |
| `pages/wiki/components/ConceptCard.tsx`, `OrphanCard.tsx`, `BacklinkChip.tsx`, `RelatedConcepts.tsx`, `SourcesBlock.tsx`, `WikilinkRenderer.tsx`, `KnowledgeGraph.tsx` (+css each) | Presentational pieces; `KnowledgeGraph` is a dependency-free SVG force graph over `backlinkGraph` |
| `pages/wiki/__fixtures__/mockWikiState.ts` | Test/fixture `WikiState` |

### pages/settings

| File | Responsibility |
|---|---|
| `pages/settings/components/SettingsSider.tsx` | Settings-mode left rail. `BUILTIN_TAB_IDS` (lines 34–61) is the canonical ordered tab list (groups: WORKSPACE/AI MODELS/ENGINE/INTEGRATIONS/APPEARANCE/SYSTEM/ABOUT — incl. `ijfw` and `ecc` rows); `LEGACY_ANCHOR_REMAP` (line 67) keeps old extension anchors working; merges extension tabs |
| `pages/settings/components/SettingsPageWrapper.tsx` | Per-page chrome: padding/max-width, mobile nav, ⌘K CommandPalette, ShortcutsOverlay, `getBuiltinSettingsNavItems()` shared with the sider |
| `pages/settings/components/SettingsPageShell.tsx` | Wrapper + standardized `PageHeader` (title/subtitle/breadcrumb/savedIndicator) — the pattern for all post-redesign settings pages |
| `pages/settings/components/` modals (`AddMcpServerModal`, `AddModelModal`, `AddPlatformModal`, `ApiKeyEditorModal`, `EditModeModal`, `JsonImportModal`, `OneClickImportModal`) + `settings.css` | Shared legacy modal set; `AddPlatformModal`/`EditModeModal` call `ipcBridge.mode.fetchModelList` |
| `pages/settings/EccSettingsPanel.tsx` | `/settings/ecc`: bundled ECC harness status via `ipcBridge.ecc.getStatus` (line 32) + GateGuard toggle via `ecc.setGateGuard({enabled})` (line 54, optimistic w/ rollback). GateGuard off ⇒ main injects `ECC_GATEGUARD=off` into claude agent spawns (header comment lines 10–13) |
| `pages/settings/IjfwSettingsPanel.tsx` | `/settings/ijfw`: the **only** Skip toggle in the app (Decision 3b). Opt-out state = `getStatus` returns `not_installed`+`reason:'opt_out'` (line 39); writes `ijfw.skipSetup({enabled})` (line 62); manual-install hint `npx -y @ijfw/install@latest` (line 131) |
| `pages/settings/WCoreConfig/index.tsx` (+`WCoreConfig.module.css`) | Engine console: 7-key rail (`overview/services/tools/memory/security/profiles/runtime`), engine chip from `acpConversation.getAvailableAgents`, pinned fallback version const (line 25) |
| `pages/settings/WCoreConfig/panes/types.ts` | `WCoreRailKey` union (Constitution deliberately excluded — Desktop concept) |
| `pages/settings/WCoreConfig/panes/OverviewPane.tsx` | Engine status card (`acpConversation.getAvailableAgents`, line 54) |
| `pages/settings/WCoreConfig/panes/ServicesKeysPane.tsx` | Engine tool API keys: `wcoreToolKeys.list/set/delete` (lines 137–159) |
| `pages/settings/WCoreConfig/panes/ToolsPane.tsx` | Engine tool allow-list → `config.toml` `[tools].allow_list` via `useWcoreConfig` (lines 215–231) |
| `pages/settings/WCoreConfig/panes/MemoryPane.tsx` | `config.toml` `[memory]` section (lines 34–45) |
| `pages/settings/WCoreConfig/panes/SecurityPane.tsx` | `config.toml` `[security]` section (lines 47–58) |
| `pages/settings/WCoreConfig/panes/ProfilesPane.tsx` | Profile dirs: `wcoreProfiles.list/activate/remove/clone/create` (lines 48–89) |
| `pages/settings/WCoreConfig/panes/RuntimePane.tsx` | `[runtime]` mode (`local\|remote\|headless`) + concurrency slider; raw-engine toggle persisted at `ConfigStorage 'wcore.rawEngineMode'` (line 76) — read by WCoreManager at spawn to skip Desktop injection |
| `pages/settings/WCoreConfig/panes/Panes.module.css`, `components/ScopeLabel.tsx`, `ToolKeyCard.tsx`, `WcSegmented.tsx`, `WcSwitch.tsx` | Pane styling + form primitives |
| `pages/settings/WCoreSettings.tsx` | **Dead-ish**: subsumed into WCoreConfig; Router imports it but only `void WCoreSettings;` (Router.tsx lines 203–208) |
| `pages/settings/ModelsSettings/` (`index.tsx`, `BrowseModal`, `ManageProvider`, `CloudCredentialForm`, `providerCatalog.ts`, `components/{ConnectedRow,ConnectPanel,DetectedStrip,EmptyState,FluxRouterHero,GoogleButton}`, css) | `/settings/models` two-tier model registry UI over `useModelRegistry` hook (`ipcBridge.modelRegistry.*`); auto-refresh toggle (`modelRegistry.get/setAutoRefresh`, index.tsx); Google OAuth via `googleAuth.login`; deep-link resume via `consumePendingDeepLink` |
| `pages/settings/AgentSettings/` (`index.tsx`, `LocalAgents`, `RemoteAgents`, `RemoteAgentManagement`, `AgentCard`, `AgentHubModal`, `InlineAgentEditor`, `PresetManagement`, `FluxRouterCard`, `FluxSetupModal`, `agentScopes.ts`, css) | `/settings/agents` CLI/remote agent management: `acpConversation.getAvailableAgents/getLoadErrors`; custom agents persisted at `ConfigStorage 'acp.customAgents'`; remote CRUD `remoteAgent.list/create/update/delete/testConnection/handshake`; Flux router `fluxConnector.setup/remove/{codex,opencode}Status` + `systemSettings.setRouteThroughFlux` |
| `pages/settings/AgentsSettings/index.tsx` | Alias re-export of `AgentSettings` (plural route) |
| `pages/settings/AssistantSettings/` (9 files + types) | `/settings/assistants` assistant CRUD/editor drawer; file-picker via `dialog.showOpen`; presets in `ConfigStorage 'assistants'` |
| `pages/settings/SkillsSettings/` (`index.tsx`, `SkillRow`, `SkillDetailDrawer`, `FilterRail`, `ImportModal`, `BuildSkillModal`, `LibraryHealth`, `displayName.ts`, css) | `/settings/skills` skill library: `skills.list/stats/setPinned/updateBody/save/build.draft`, imports `skills.import.{git,zip,folder,singleSkillMd}`, CLI discovery toggle `skills.get/setCliDiscoveryEnabled` |
| `pages/settings/SkillsHubSettings.tsx` | Older skills-hub surface (route redirects to `/settings/skills`); heavy `fs.*` skill IPC: `listAvailableSkills`, `import/exportSkillWithSymlink`, `deleteSkill`, `getSkillPaths`, `addCustomExternalPath`, `detectAndCountExternalSkills`, `listBuiltinAutoSkills` |
| `pages/settings/McpLibrary/` (`BrowsePage`, `InstalledPage`, `DetailPage`, `hooks/useMcpLibrary.ts`, `types.ts`, 8 components, css) | Catalog-driven MCP library. Catalog is **Vite-bundled static data** (`import.meta.glob` over `@renderer/mcp-catalog/{entries/*.json,guides/*.md,icons/*.svg}`, useMcpLibrary.ts lines 14–35) validated with zod |
| `pages/settings/ChannelsIndex/` (`index.tsx`, `ChannelDetailPage`, `ChannelDetailLayout`, `ChannelSetupGuide`, `channelSetupGuides.ts`, `PendingPairings.tsx`, `details/**` — 26 per-channel `*Setup.tsx` files across chat/collab/email/integration/messaging/social) | `/settings/channels` messaging-channel hub: live status `channel.pluginStatusChanged.on`, disable `channel.disablePlugin`, pairing approve/reject `channel.approvePairing/rejectPairing` + `channel.pairingRequestsChanged.on`; each `details/*Setup.tsx` is a thin static setup-guide wrapper |
| `pages/settings/ConstitutionSettings/` (`index.tsx`, `SpecialistOverlays.tsx`, `SpecialistOverlayEditor.tsx`) | `/settings/constitution`: TipTap markdown editor over the Constitution file via **preload-direct** `window.electronAPI.readConstitution/writeConstitution/resetConstitution` (index.tsx lines 82–120, NOT ipcBridge); 500 ms debounced save; ~2,000-token adherence ceiling warnings; per-assistant overlays at `~/.darhai/specialists/<id>.md` via `read/writeConstitutionSpecialist` |
| `pages/settings/NotificationsSettings/index.tsx` | Toggles via `systemSettings.get/setNotificationEnabled`, `get/setCronNotificationEnabled` + `ConfigStorage 'notifications.{agentError,agentFinished,channelMessage,playSound,quietHours}'` |
| `pages/settings/StorageSettings/` (`index.tsx`, `UsageCard`, `DirectoriesCard`, `BackupCard`, `SyncCard`, `SyncPassphraseDialog`) | `/settings/storage`: `storage.resetAll/clearDir/openDir/importBackup`; E2E sync `sync.enable/disable/forceSync` |
| `pages/settings/VoiceSettings/` (`index.tsx`, `MicrophoneCheck`, `ProviderHintBanner`) | STT/TTS provider config in `ConfigStorage 'tools.speechToText'` / `'tools.textToSpeech'`; hints read `'model.config'` |
| `pages/settings/ImageGenSettings/index.tsx` | Image-gen model pick in `ConfigStorage 'tools.imageGenerationModel'` (+ `'mcp.agentInstallStatus'`) |
| `pages/settings/GeneralSettings/index.tsx`, `DisplaySettings/index.tsx`, `GeminiSettings.tsx`, `SystemSettings.tsx`, `WebuiSettings.tsx`, `CapabilitiesSettings.tsx` | Thin wrappers embedding shared `components/settings/SettingsModal/contents/*ModalContent` components (System/Display/Gemini/About/Webui/Tools) inside SettingsPageWrapper — the actual forms live in area "components/settings", not here. `WebuiSettings` adds `PairedDevicesCard` + `ActivityLogCard` (`webui.activityLog`) |
| `pages/settings/EditorSettings/index.tsx` | Editor prefs via `useEditorSettings` hook (autosave delay, default mode) |
| `pages/settings/ExtensionSettingsPage.tsx` | `/settings/ext/:tabId` generic host for extension-contributed tabs: `extensionsIpc.getSettingsTabs`, `getExtI18nForLocale` (line 73), `getAgentActivitySnapshot` (line 109) |
| `pages/settings/ToolsSettings/McpAgentStatusDisplay.tsx` | Residual MCP-agent status widget used by capabilities/tools content |

### pages/model-advisor (hwfit)

| File | Responsibility |
|---|---|
| `pages/model-advisor/index.tsx` | `/model-advisor` page in standard `PageShell width='full'`; wires panel/toolbar/table; gpuOnly toggle rebuilds override (lines 53–59) |
| `pages/model-advisor/useModelAdvisor.ts` | SWR data layer: `hwfit.scanHardware({fresh?})` (line 28, 62), `hwfit.catalogSize` (line 32), `hwfit.rankModels({useCase,fitOnly,sort:'score',limit:60,hardwareOverride?})` (lines 49–56) |
| `pages/model-advisor/gpuPresets.ts` | 10 simulated-rig presets; `name` must substring-match main-side `speedModel.ts GPU_BANDWIDTH` (comment lines 9–12); `buildOverride()` merges preset GPU onto real RAM/CPU |
| `pages/model-advisor/HardwarePanel.tsx` | Detected/simulated rig summary card |
| `pages/model-advisor/AdvisorToolbar.tsx` | Use-case select, search, fit-only, rig simulator, rescan |
| `pages/model-advisor/ModelTable.tsx` (+`ModelAdvisor.module.css`) | Ranked results table (fit badge, quant, est. speed) |

### Other page directories (inventory only — deep-dived in their own areas)

| Dir | One-liner |
|---|---|
| `pages/conversation/**`, `pages/guid/**` | Chat surface + new-chat launcher (area 13) |
| `pages/assistants/`, `pages/workflows/`, `pages/teams/` | Library pages ("third door" pickers) on the shared `PageShell`/`library/*` scaffolds |
| `pages/team/**` | Legacy multi-user team mode, gated by `TEAM_MODE_ENABLED` (Router.tsx ~156) |
| `pages/projects/`, `pages/conversations/` | Project umbrella (`ipcBridge.project.*`) + flat conversation list |
| `pages/cron/**` | `/scheduled` cron jobs UI; `pages/mission-control/**` — agent ledger + cost analytics |
| `pages/login/`, `pages/TestShowcase.tsx` | Web-mode auth; `/test/components` Arco showcase |

## Contracts & data flow

- **IPC provider namespaces consumed here** (all defined in `src/common/adapter/ipcBridge.ts`; channel string = the dotted key):
  - `ijfw.*` (lines 1622–1644): `get-status`, `status-changed` (emitter), `brain-invoke` (`{verb: IjfwVerb, args?}` → `IjfwInvokeResult`), `trigger-install`, `skip-setup`, `check-now`, `get-runtime-mode`, `drop-list/drop-ingest/drop-quarantine`.
  - `ecc.*` (lines 1647–1652): `ecc.get-status` → `{bundled, installed, gateGuardEnabled}`; `ecc.set-gate-guard` `{enabled}`.
  - `memory.*` (lines 2359–2423): stats/list/get/projects/tags, `promote`, `set-quick-add`, promotion candidates/threshold/auto-promote/undo/force-sweep, `read-source-context`, `index-changed` emitter, `import.{claude-mem,obsidian-vault,obsidian-detect-vaults,scan-dev-dir,process-drop-folder,get-drop-folder-status}`, `ingest-files`.
  - `wiki.*` (lines 2428–2462): `list-concepts`, `get-concept`, `synthesize-orphan`, `re-synthesize`, `resolve-backlink`, `get-backlink-graph`, `get-state`, `state-changed` emitter, `synthesize-now`.
  - `hwfit.*` (line 1090+): `scan-hardware`, `catalogSize`, `rankModels`.
  - Engine config: `wcoreConfig.getSection/setSection` (HUMAN-ONLY, remote-denied — SEC-6 note in `src/renderer/hooks/useWcoreConfig.ts` lines 15–20), `wcoreProfiles.*`, `wcoreToolKeys.*`.
  - Others: `acpConversation.getAvailableAgents/getLoadErrors`, `remoteAgent.*`, `fluxConnector.*`, `modelRegistry.*`, `googleAuth.login`, `skills.*`, `fs.*` (skills hub), `channel.*`, `storage.*`, `sync.*`, `webui.activityLog`, `systemSettings.*`, `extensions.*`, `dialog.showOpen`, `shell.openFile/openPath/openExternal`, `application.restart`, `mode.fetchModelList`.
- **Preload-direct (non-ipcBridge) API** — Constitution editor only: `window.electronAPI.{read,write,reset}Constitution` and `{read,write}ConstitutionSpecialist` (`ConstitutionSettings/index.tsx` lines 76–120; overlays at `~/.darhai/specialists/<id>.md`).
- **Shared types** — `src/common/types/memory.ts` (`MemoryEntry`, `MemoryType` = `decision|pattern|observation|session|wiki|preference`, `ListFilter`, `WikiConcept`, `WikiState`, `WikiTopicTag`), `src/common/types/hwfit.ts`, `src/common/types/ijfw.ts`.
- **ConfigStorage keys written by this area** (`@/common/config/storage`, backed by main-process config): `wcore.rawEngineMode`, `acp.customAgents`, `assistants`, `tools.imageGenerationModel`, `tools.speechToText`, `tools.textToSpeech`, `mcp.agentInstallStatus`, `notifications.quietHours` (reads also `notifications.{agentError,agentFinished,channelMessage,playSound}`, `model.config`).
- **URL state** — Memory inspector selection `?entry=<id>` (`useSelectedEntry.ts` lines 29–66); wiki detail `/wiki/:slug`; settings deep links `/settings/<tab>` + legacy anchors remapped by `LEGACY_ANCHOR_REMAP`.
- **File formats / paths surfaced in UI** — drag-drop & drop-folder ingest accepts `.md/.markdown/.txt/.json` (FullPanelShell line 340; drop folder `~/Documents/Darhai-Memory/`, ImportDrawer line 69); wiki pages live at `<project>/.ijfw/wiki/*.md` with sidecar index `<project>/.ijfw/wiki-state/index.json` (adapter comment above `wiki` namespace); MCP catalog is static JSON/MD/SVG bundled from `src/renderer/mcp-catalog/`.
- **Env vars** — only indirect: GateGuard toggle causes main to set `ECC_GATEGUARD=off` on claude agent spawns (EccSettingsPanel header comment); no renderer code reads env directly. No processes are spawned from this area — install/scan/rank all happen main-side behind the providers above.

## Conventions & invariants

- **Optimistic toggle with rollback** — every settings switch sets local state first, invokes, and restores the previous value on `!result.ok` or throw (EccSettingsPanel lines 47–71, IjfwSettingsPanel lines 55–85). Copy this exact shape for new toggles.
- **Subscription hygiene** — every emitter `.on()` returns an unsubscribe called in the effect cleanup, guarded by a `cancelled`/`disposed` flag (MemoryPage lines 92–147, useMemoryIndex lines 97–148, WikiHomePage lines 87–116).
- **Sync-throw-safe IPC** — wrap first invokes in async IIFE + try/catch because the dispatcher can throw synchronously pre-hydration (MemoryPage "Gemini H2" comment lines 101–128); pair with a wall-clock fallback timer for boot races.
- **Full-bleed vs PageShell** — pages owning their own header grid (FullPanelShell, WikiHomePage, WCoreConfig) render full-bleed; everything else uses `PageShell` (library pages, model-advisor) or `SettingsPageShell`/`SettingsPageWrapper` (settings). Never nest one inside the other.
- **i18n with inline defaults** — all strings via `t('key', {defaultValue})` or `t('key','fallback')`; key families: `memory.*`, `archive.*`, `wiki.*`, `settings.*`, `modelAdvisor.*`. New text must follow the `i18n` skill (modules in `src/common/config/i18n-config.json`).
- **`data-testid` on every interactive/stateful node** (e.g. `memory-full-panel`, `ecc-settings-gateguard-switch`, `ijfw-settings-skip-switch`) — tests target these, keep the naming `<area>-<element>` kebab pattern.
- **Human-only engine config** — anything writing `config.toml` must go through `useWcoreConfig`/`wcoreConfig.setSection`; it is remote-denied and must never be callable from agent flows (SEC-6).
- **Directory limits** — max 10 direct children per directory (AGENTS.md); page-private code stays under the page dir (`components/`, `hooks/`, `state-branches/`, `panes/`); CSS Modules per component; Arco components only (no raw interactive HTML — note WikiHomePage's raw `<button>`s predate this rule; don't imitate).
- **Verb allowlist** — new IJFW brain calls must extend `pages/memory/types/brain.ts` `IjfwVerb` rather than passing free strings.

## Assimilation anchors

1. **New harness settings panel (e.g. Superpowers/Odysseus toggle page)** — clone `pages/settings/EccSettingsPanel.tsx` wholesale (status tag + optimistic switch + `SettingsPageWrapper`); register: route in `Router.tsx` settings block (~line 152), tab id in `SettingsSider.tsx BUILTIN_TAB_IDS` (line 34) + `getBuiltinSettingsNavItems` in `SettingsPageWrapper.tsx`, a `buildProvider` pair in `src/common/adapter/ipcBridge.ts` next to `ecc` (line 1647), i18n keys under `settings.<name>.*`.
2. **New IJFW/brain verb surfaced in Memory UI** — add the verb to `pages/memory/types/brain.ts` `IjfwVerb` union, call through `ipcBridge.ijfw.brainInvoke` (pattern: `state-branches/OnboardingEmptyState.tsx` line 57); for indexed data prefer a dedicated `memory.*` provider mirroring `memory.promote` and refresh via `memory.onIndexChanged`.
3. **New engine-config pane (assimilating an ECC/Odysseus config domain into the engine console)** — add key to `WCoreRailKey` (`WCoreConfig/panes/types.ts`), create `panes/<Name>Pane.tsx` mirroring `MemoryPane.tsx` (`useWcoreConfig().getSection/setSection('<toml-section>')`), register in the `railEntries` array + `renderPane` switch of `WCoreConfig/index.tsx` (lines 57–125).
4. **New importer into Memory** — add a provider under the `memory.import.*` sub-namespace (`ipcBridge.ts` line 2397+), then a card in `components/ImportDrawer.tsx` and optionally `EmptyStateHero.tsx`; report `{count, errors[]}` like `claudeMem`.
5. **New top-level library/analysis page (e.g. an ECC skills marketplace)** — imitate `pages/model-advisor/`: folder with `index.tsx` on `PageShell`, one SWR data hook wrapping a main-side provider (like `useModelAdvisor.ts`), presentational children; route + sidebar entry belong to area 12 (`Router.tsx`, `Sider/`).
6. **Bundled static catalog pattern** — for shipping curated content (skill/agent catalogs) without a server, copy `McpLibrary/hooks/useMcpLibrary.ts`: `import.meta.glob` over a `src/renderer/<catalog>/` dir + zod validation, with Browse/Installed/Detail routes as in `Router.tsx` lines 137–142.
