# 02 process-services-general

Scope: `src/process/services/*` excluding `ijfw*`, `import/`, `skills/`, `hwfit/`, `database/`.
Covers 15 top-level service files and 15 subdirectories (completion, constitution, cost, cron,
i18n, kickoff, mcpServices, memory, missionControl, projectKnowledge, semantic, usage, voice,
wiki, workflow). Every claim below was verified against the code at the cited path/line.

## Purpose

This area is the main-process service layer of Darhai: everything between the IPC bridges
(`src/process/bridge/*`) and the agent/task runtime (`src/process/task/*`, `src/process/agent/*`).
It owns conversations/projects CRUD, the ECC harness installer, cost/budget observability, cron
scheduling, workflow sessions, hybrid semantic retrieval, MCP config management across 8 CLI
backends, voice runtimes, per-project knowledge, and memory/wiki promotion. Services here never
talk to the DOM; persistence goes through `services/database` repositories or plain filesystem.

## Entry points & lifecycle

- **Module-load wiring** — `src/process/utils/initBridge.ts` is the composition root: it builds
  `ConversationServiceImpl` (line 47-48), `TeamSessionService`, calls `initAllBridges` (line 63),
  starts `cronService.init()` and publishes its readiness via `setCronReadyPromise`
  (initBridge.ts:82-120), then inside a `getDatabase().then` wires usage logger, cost recorder +
  analytics + budgets (initBridge.ts:149-198) and the `WorkflowSessionService`
  (initBridge.ts:218-235).
- **Delayed background seeding** — `src/process/bridge/eccBridge.ts:27-31` fires
  `seedEccIfAbsent()` 7 s after launch (`SEED_DELAY_MS`, line 15); the ECC install is idempotent
  and self-skipping. `WorkspaceSnapshotService.cleanupStaleSnapshots()` runs fire-and-forget at
  bridge init (`src/process/bridge/workspaceSnapshotBridge.ts:14`).
- **Per-conversation lifecycle** — `ConversationServiceImpl.createConversation` runs on every new
  chat (dispatched from conversationBridge); `ensureWorkspaceEccHooks` runs on agent spawn
  (`src/process/task/AcpAgentManager.ts:1217`); `CostRecorder.recordTurnFinish` runs at every
  backend turn-finish; cron timers fire on schedule via `croner`.
- **Lazy-on-first-use** — kickoff engine (`kickoff/kickoffSingleton.ts:23`), semantic index
  (`semantic/SemanticIndexService.ts:60`), embedding model download, geminiOAuth generator,
  `ModelPricing` snapshot load are all constructed only when first called.
- **Watchdogs / sweeps** — `workflow/autonomousWatchdog.ts` (5-min interval, 30-min stall
  threshold, lines 24-27); `memory/promotionSweep.ts` periodic promotion; `wiki/wikiAutoSync.ts`
  synthesis sweep; startup prune of `usage_events` (90 d) and `cost_events` (180 d)
  (initBridge.ts:145-173).

## Key modules

### Top-level files

| File | Responsibility |
|---|---|
| `src/process/services/eccSystemService.ts` | Installs the bundled ECC harness into `~/.claude` on first run (never-clobber policy), materializes ECC hooks per workspace, exposes GateGuard toggle |
| `src/process/services/IConversationService.ts` | Contract: `CreateConversationParams` (typed `extra` incl. `projectId`, `presetRules`, `enabledSkills`), migration params |
| `src/process/services/ConversationServiceImpl.ts` | Conversation CRUD + agent-factory dispatch by `params.type` (gemini/acp/openclaw-gateway/nanobot/remote/wcore, lines 165-207); injects project knowledge (133-152); message-copy migration with integrity check (110-120) |
| `src/process/services/conversationServiceSingleton.ts` | Singleton: `ConversationServiceImpl` + `SqliteConversationRepository` (line 16) |
| `src/process/services/IProjectService.ts` | Contract: project CRUD + conversation re-parenting |
| `src/process/services/ProjectServiceImpl.ts` | Project CRUD; bootstraps `.darhai/` knowledge on create/workspace-set (43-49, 65-72); assign/detach conversation via `extra.projectId` merge (83-99) |
| `src/process/services/projectServiceSingleton.ts` | Singleton wiring mirroring conversationServiceSingleton (19-22) |
| `src/process/services/WorkspaceSnapshotService.ts` | Git-based change tracking per workspace: `git-repo` mode (real repo, stage/unstage/discard) vs `snapshot` mode (bare temp gitdir baseline); stale-snapshot cleanup |
| `src/process/services/autoUpdaterService.ts` | electron-updater singleton; per-platform channels (`latest-win-arm64`, `latest-arm64`, lines 28-34); manual download, status broadcast callback |
| `src/process/services/ccSwitchModelSource.ts` | Reads cc-switch tool state (`~/.cc-switch/settings.json` + `cc-switch.db` sqlite, `~/.claude/settings.json`, lines 78-85) to derive Claude model slots + provider env |
| `src/process/services/conversionService.ts` | Document conversions: docx→md (mammoth+turndown), md→docx, xlsx↔json with embedded-image extraction (yauzl+DOMParser), pptx→json (vendored `@/vendor/pptx2json`), html→pdf via hidden BrowserWindow `printToPDF` (545-598) |
| `src/process/services/geminiSubscription.ts` | Gemini OAuth credential presence check via `@office-ai/aioncli-core` `Storage.getOAuthCredsPath()`; 5-min cache + inflight dedupe (19-28) |
| `src/process/services/ijfwSystemService.ts` | (out of scope — see area 03 process-ijfw-memory) |
| `src/process/services/openclawConflictDetector.ts` | Detects OpenClaw Lark/Telegram channels using same credentials as Darhai Channels; reads `~/.openclaw/openclaw.json` etc. (63-69) |
| `src/process/services/previewHistoryService.ts` | Preview panel snapshot store: `<cacheDir>/preview-history/<sha1(identity)>/index.json` + `<id>.md`, max 50 versions per target (line 25) |
| `src/process/services/titleGenerationService.ts` | AI conversation titles via `oneShotComplete`, 10 s cap (line 20), null-on-failure fallback to truncation |

### Subdirectories

| File | Responsibility |
|---|---|
| `completion/oneShot.ts` | One-shot stateless LLM call: picks cheapest-fast or best model by name heuristics over configured providers (26-38, 91-101); routes raw REST by flavor — Anthropic `/v1/messages` (183), Gemini `/v1beta/models/:generateContent` (203), OpenAI `/chat/completions` (225) |
| `completion/geminiOAuth.ts` | Fallback for "Continue with Google" users (no API key): Code Assist generator from aioncli-core, model `gemini-2.5-flash-lite` (line 26), browser-launch suppressed (71-75) |
| `constitution/composePrompt.ts` | Composes Constitution + specialist overlay (`~/.darhai/specialists/<id>.md`) + base prompt with `\n\n---\n\n` separators; stable across turns for prompt caching; returns `anthropicCacheControl` marker (41-62) |
| `cost/types.ts` | Cost domain types: `CostEvent` (cost_events, migration_v48), `Budget` (budgets, migration_v49), repository interfaces (171-200) |
| `cost/CostRecorder.ts` | One `cost_events` row per turn: 'engine' path = cumulative-gauge delta with per-conversation baseline clamp (111-138); 'computed' = tokens × `ModelPricing`; 'unknown' = tokens only. Process-wide via `setCostRecorder`/`getCostRecorder` (204-211) |
| `cost/ModelPricing.ts` | Token→USD from bundled `resources/modelsdev-snapshot.json` (USD per 1M tokens); `undefined` for unknown models — never guesses (60-71) |
| `cost/CostAnalyticsService.ts` | Read-only queries over cost_events: summary/byModel/byBackend/byConversation/byTeam/series |
| `cost/BudgetController.ts` | Budget CRUD + period spend (local-time day/week/month, 33-47); `warn` = one-time non-blocking alert post-turn (157-177); `pause` = resumable pre-turn gate `canStartTurn` (137-149) |
| `cost/SqliteCostRepository.ts`, `cost/SqliteBudgetRepository.ts` | Synchronous prepared-statement repos over the shared driver; prune contract |
| `cost/gatewayUsage.ts` | Guarded parser for untyped OpenClaw/Remote gateway `usage` payloads — tokens only, never fabricates totals |
| `cron/CronService.ts` | Core scheduler (885 lines): loads enabled jobs at init, `croner` timers, missed-job detection + announcements, orphan cleanup, retry/powerSaveBlocker management |
| `cron/CronStore.ts` | `CronJob` type (schedule kinds `at`/`every`/`cron`, 13-16) + row mapping over `cron_jobs` table (212) |
| `cron/SqliteCronRepository.ts` / `ICronRepository.ts` / `ICronEventEmitter.ts` / `ICronJobExecutor.ts` | Thin repository + DI seams for the scheduler |
| `cron/IpcCronEventEmitter.ts` | Emits `ipcBridge.cron.onJobCreated/Updated/Executed/Removed` + native notifications (14-32) |
| `cron/WorkerTaskManagerJobExecutor.ts` | Executes jobs through `workerTaskManager.getOrBuildTask(conversationId, {yoloMode:true})` (93-96); resolves/creates conversations, model override for `existing` mode, applies agent mode/configOptions |
| `cron/CronBusyGuard.ts` | Per-conversation busy state + `onceIdle` callbacks |
| `cron/cronSkillFile.ts` | Per-job `SKILL.md` (YAML frontmatter + Instructions section) under `getCronSkillsDir()/<jobId>` (15-17); build/parse round-trip |
| `cron/BuiltinRoutinesSeeder.ts` | Seeds bundled routines from `src/process/resources/bundled-workflows/routines.json` (packaged as `<resources>/bundled-workflows`) as DISABLED wcore cron jobs tagged `configOptions.kind='routine'` (36-39); idempotent |
| `cron/SkillSuggestWatcher.ts` | Watches workspace `SKILL_SUGGEST.md` after cron runs; emits skill-suggest events on content hash change |
| `cron/cronReadiness.ts` | Pub/sub for cron init: `setCronReadyPromise` / `waitForCronReady(timeoutMs)` — soft signal, must be timeout-paired (12-16) |
| `cron/cronServiceSingleton.ts` | Wires CronService with Sqlite repo + IPC emitter + worker executor (17-22) |
| `i18n/index.ts` | Main-process i18next; static locale imports (8 langs incl. `mn-MN`, 20-42); saved `language` ProcessConfig key wins, else product default `i18nConfig.defaultLanguage` = mn-MN (64-69) |
| `kickoff/types.ts` | Kickoff cascade types + thresholds (`RITUAL_RECENT_WINDOW_MS` 4 h, thread gates, 117-121) |
| `kickoff/SignalCollector.ts` | One-pass main-process signal snapshot (conversation repo + cron + team repo); per-source error swallowing (35-53) |
| `kickoff/SuggestionEngine.ts` | 5-level cascade (ritual → recent thread → seeded cold-start library → beginner fallback → notRendered), deterministic per-day shuffle seeded `hash(installUuid+assistantId+dateKey)` (23-51) |
| `kickoff/installUuid.ts` | Persistent 32-hex install id under ProcessConfig `app.installUuid` (line 40); host-stable fallback when persistence fails |
| `kickoff/seededShuffle.ts` | FNV-1a + mulberry32 deterministic shuffle; `Math.imul` load-bearing (22-33) |
| `kickoff/kickoffSingleton.ts` | Lazy `getKickoffEngine()` (23-30) |
| `mcpServices/McpProtocol.ts` | `IMcpProtocol` contract + `AbstractMcpAgent` base (op queue, connection test via `@modelcontextprotocol/sdk` stdio/sse/streamableHttp transports, 11-14); `McpSource` type (22) |
| `mcpServices/McpService.ts` | Coordinator: 8 agents keyed claude/codebuddy/qwen/gemini/wayland/codex/opencode/wcore (83-92); service-wide operation lock (37-44); fork-Gemini routes to DarhaiMcpAgent (107-113) |
| `mcpServices/McpOAuthService.ts` | MCP server OAuth via aioncli-core; monkey-patches `OAuthUtils` for RFC 9728 trailing-slash and same-origin-prefix (Linear) resource mismatches (24-80) |
| `mcpServices/validateMcpServer.ts` | Validation of MCP server defs incl. env entries |
| `mcpServices/agents/ClaudeMcpAgent.ts` | Shells `claude mcp list/add/remove` (line 57) with sanitized env (`NODE_OPTIONS:''`, `TERM:'dumb'`, 20-22) |
| `mcpServices/agents/{Codebuddy,Codex,Gemini,Opencode,Qwen}McpAgent.ts` | Same pattern per CLI (codex tolerates `env`/`env_vars` shapes, CodexMcpAgent.ts:38-60) |
| `mcpServices/agents/DarhaiMcpAgent.ts` | Backend `'wayland'`: MCP config lives in ProcessConfig key `mcp.config` (line 45); read/merge only, remove is renderer-owned no-op (117-120) |
| `mcpServices/agents/WCoreMcpAgent.ts` | wayland-core Rust engine: config path via `<binary> --config-path` (55-60), TOML read/write via smol-toml |
| `memory/ijfwArchiveService.ts` | (functionally IJFW — detailed in area 03) Reads `.ijfw/memory/*.md`, in-memory index, per-root dir watchers, frontmatter clamps; roots via `memory/memoryRoots.ts` (home-scoped root always indexed), lexical search via `memory/memorySearch.ts` |
| `memory/markdownFrontmatter.ts` | Pure `---` block parser; JSON-quoted scalars prevent YAML break-out (28-39) |
| `memory/promotionScore.ts` | Pure 0-100 promotion score: +30 decision/pattern, +10/cross-ref, +5/referencedBy, +20 promoted tags, +15 recency decay (32-65) |
| `memory/promotionSweep.ts` | Periodic auto-promotion; settings persisted at `~/.config/wayland-dev/memory-archive-settings.json` (line 62), threshold default 90 |
| `memory/wikiWriter.ts` | Promotes entries to `.ijfw/wiki/`; `.promoted.json` sidecar, 24 h undo queue (line 34), per-dir mutex, atomic tmp+rename writes (56-60) |
| `memory/sourceReader.ts` | Windowed source-file read for the archive drawer; `.md/.txt/.markdown` only, home-dir-confined, 500 KB cap (17-18, 57-67) |
| `missionControl/TaskLedgerService.ts` | Read-only merge of team tasks + cron jobs into `MissionControlSnapshot`; per-source degradation (21-48); status ranking (126-135) |
| `projectKnowledge/bootstrap.ts` | Creates `{workspace}/.darhai/` with CONTEXT.md/rules.md/decisions.md + `reference/` (32-46); write-if-absent idempotency (50-57) |
| `projectKnowledge/knowledge.ts` | Read/write knowledge docs; strips seeded boilerplate so unedited docs inject nothing (96-109); `loadProjectKnowledgeBlock` composes the injected system-rules block (116+) |
| `semantic/types.ts` | Retrieval types; namespaces `'skills' \| 'memory'` (24) |
| `semantic/EmbeddingService.ts` | Lazy ONNX embedder `Xenova/multilingual-e5-small` 384-dim, pinned HF commit SHA (34-45); degraded→null offline; `MAX_EMBED_CHARS` 2048 (68); batch 16 |
| `semantic/SqliteVecStore.ts` | sqlite-vec vec0 tables `vec_<ns>` + `vec_<ns>_meta` in the main DB (12-17); unavailable ⇒ safe no-ops |
| `semantic/fingerprint.ts` / `semantic/fusion.ts` | Pure: doc fingerprints; layered-fallback (min cosine 0.35, fusion.ts:25) + RRF (k=60) |
| `semantic/HybridRetriever.ts` | Vector KNN → keyword lane fallback per namespace; `MAX_REINDEX_DOCS` 20000 (47); keyword lane rebound each call (66-70) |
| `semantic/SemanticIndexService.ts` | Singleton wiring: embedder cache at `getDataPath()/models` (80), sqlite-vec extension via `createRequire` (34-48), per-namespace retrievers |
| `semantic/skillSemanticLane.ts` | Skill doc builder + BM25 `SkillRetriever` keyword lane; background reindex scheduler. Memory has no vector lane - e5 scores gibberish and correct matches in the same band, so memory membership is lexical (memorySearch.ts) |
| `usage/types.ts` | Closed `UsageEventType` union (launchpad/guid/dashboard/workflow.* events, 12-39); repo interface with prune |
| `usage/UsageEventLogger.ts` | Append with UUID/timestamp defaults; metadata cap 2048 bytes (14); errors swallowed |
| `usage/SqliteUsageEventRepository.ts` | usage_events table (migration v40) repo |
| `usage/FrequentlyUsedAggregator.ts` | Top-N models from `guid.model_selected` events, 7 d window (24-25) |
| `voice/TextToSpeechService.ts` | Routes by `config.provider`: `kokoro-local` \| `system-native` (macOS `say`) (47-58) |
| `voice/KokoroLocal.ts` | Kokoro ONNX TTS; binary `~/.darhai/voice/bin/<platform>-<arch>/kokoro-cli(.exe)`, models `~/.darhai/voice/kokoro-models` (32-35); injectable runtime seam |
| `voice/WhisperLocal.ts` | whisper.cpp STT; binary+model under `<userData>/voice/` (48-51 — deliberately same tree the Settings download buttons use) |
| `voice/VoiceAssetManager.ts` | Streamed downloads with SHA-256 verify, tmp+rename; typed `VoiceAssetDownloadError` (17-25) |
| `voice/voiceAssetRegistry.ts` | Main-process authority on asset id→URL→dest (whisper GGML models, kokoro model/voices, 33-50) |
| `voice/voiceBinaryManifest.ts` | Per-platform binary manifest (whisper.cpp v1.7.1 release URLs, 37-56) + `acquireBinary` |
| `wiki/wikiIndex.ts` | Scans `<project>/.ijfw/wiki/*.md`, parses frontmatter, builds backlink graph → `.ijfw/wiki-state/index.json` (Obsidian-safe, 5-9) |
| `wiki/wikiSynthesizer.ts` | MemoryEntry[]→WikiConcept; keyword topic inference; LLM path stubbed, heuristic fallback always valid (8-14) |
| `wiki/wikiAutoSync.ts` | Periodic synthesis of unseen entries; writes concept files with path-traversal guard (34-42); emits `wiki.state-changed` |
| `wiki/wikilinkResolver.ts` | `[[wikilink]]` parse/resolve helpers |
| `workflow/parseSteps.ts` | Extracts `## Step N:` or `**Step N:**` headers (36-37); max 30 steps, 8 KB excerpts (24-25) |
| `workflow/applyTransition.ts` | Pure monotonic step-status resolver; source precedence user > worker > parent (43-46) |
| `workflow/composeWorkflowSystemPrompt.ts` | Static WORKFLOW_PROTOCOL block — byte-identical per session for prompt caching (7-11) |
| `workflow/composeStepContext.ts` | Per-turn dynamic `workflow_step_context` block prepended to user input (8-18) |
| `workflow/WorkflowSessionRepository.ts` | workflow_sessions table (migrations v41/v42) repo |
| `workflow/WorkflowSessionService.ts` | Session lifecycle: start (parse steps, resolve skills, create conversation, telemetry), transitions, asks, completion; fully DI'd (24-29) |
| `workflow/dispatchAutonomousStep.ts` | "Run autonomously" v1: spawns a child conversation carrying `extra.autonomousDispatch={parentWorkflowSessionId,stepN,dispatchId}` (17-23); completion listener in initBridge.ts:243+ flips the parent step |
| `workflow/autonomousWatchdog.ts` | Force-errors steps `running` > 30 min; sweeps every 5 min (24-27) |
| `workflow/workflowSessionServiceSingleton.ts` | `setWorkflowSessionService`/`getWorkflowSessionService` — null before initBridge wiring, callers soft-fail (30-41) |

## Contracts & data flow

**IPC provider keys** (declared in `src/common/adapter/ipcBridge.ts`, allowlisted in
`src/common/adapter/bridgeAllowlist.ts`):
- ECC: `ecc.get-status` (ipcBridge.ts:1649), `ecc.set-gate-guard` (1651).
- Cron: `cron.list-jobs`, `cron.add-job`, `cron.update-job`, `cron.remove-job`, `cron.run-now`,
  `cron.save-skill`, `cron.has-skill`, `cron.confirm-proposal` (1052-1068); emitters
  `cron.job-created/updated/removed/executed` (1070-1074).
- Cost: `cost.summary/byModel/byBackend/byConversation/byTeam/series`,
  `cost.upsertBudget/deleteBudget/listBudgets`, emitter `cost.budgetAlert` (2298-2337).
- Kickoff: `kickoff.suggest`, `kickoff.telemetry` (2141-2142).
- Workflow: `workflow.start/resolveSkills/findActive/findAllActive/updateSessionState/`
  `dispatchAutonomousStep/delete-session/count-active`, emitter `workflow.session-changed`
  (2182-2228).

**Spawned processes & runtimes**:
- ECC installer: `electronUtilityProcess.fork(<resources>/bundled-ecc/scripts/install-apply.js,
  ['--profile','full','--target','claude'])` — utilityProcess is the only sanctioned Node runtime
  in packaged builds (RunAsNode fuse off) (eccSystemService.ts:154-164); HOME/USERPROFILE pinned
  to `os.homedir()` (134-145); 180 s timeout (34); stdout must be drained (166-167).
- Git: `execFile('git', ...)` throughout WorkspaceSnapshotService (e.g. 115, 435-465); snapshot
  commits use identity `user.name=Wayland` / `snapshot@wayland.local` (456-458).
- MCP CLI agents: `claude mcp list` etc. via safeExec (ClaudeMcpAgent.ts:57); wcore binary
  `--config-path` (WCoreMcpAgent.ts:55); `where/which` + PowerShell `Get-Command` fallback for
  CLI detection (McpService.ts:46-80).
- Voice: `execFile` of `kokoro-cli(.exe)`, `whisper-cli(.exe)`, macOS `say`
  (TextToSpeechService.ts:25, KokoroLocal.ts:35, WhisperLocal.ts:51).
- One-shot LLM: direct `fetch` to Anthropic/Gemini/OpenAI-compatible endpoints, UA `Wayland/1.0`
  (oneShot.ts:183-244).

**Env vars**: `ECC_GATEGUARD=off` injected into claude spawns when GateGuard disabled
(`src/process/task/AcpAgentManager.ts:574-577`); `DARHAI_ALLOW_MODEL_DOWNLOAD=0` forbids
embedding-model fetch (EmbeddingService.ts:56-58); `OPENCLAW_CONFIG_PATH`/`CLAWDBOT_CONFIG_PATH`/
`OPENCLAW_STATE_DIR` read by openclawConflictDetector.ts:54-63; cc-switch surfaces
`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` (ccSwitchModelSource.ts:109-112).

**ProcessConfig keys** (via `@process/utils/initStorage`): `ecc.autoInstall`,
`ecc.gateGuardEnabled`, `ecc.seedInProgress` (eccSystemService.ts:81-108); `mcp.config`
(DarhaiMcpAgent.ts:45); `app.installUuid` (installUuid.ts:40); `language` (i18n/index.ts:64).

**DB tables** (shared better-sqlite3 driver via `getDatabase().getDriver()`): `cost_events`
(migration_v48), `budgets` (v49), `cron_jobs` (CronStore.ts:212), `usage_events` (v40),
`workflow_sessions` (v41/v42), vector tables `vec_skills`/`vec_memory` + `_meta` shadows
(SqliteVecStore.ts:12-17). Cost/budget rows deliberately have NO foreign keys (cost/types.ts:18).

**File formats / on-disk artifacts**:
- ECC: marker `~/.claude/ecc/install-state.json`, plugin cache `~/.claude/plugins/cache/ecc`
  (eccSystemService.ts:64-65); hooks source `~/.claude/hooks/hooks.json` → copied into
  `<workspace>/.claude/settings.local.json` atomically, only when no `hooks` key exists
  (204-232).
- Project knowledge: `{workspace}/.darhai/{CONTEXT.md,rules.md,decisions.md,reference/}`
  (bootstrap.ts:32-46).
- Cron skills: `getCronSkillsDir()/<jobId>/SKILL.md` YAML-frontmatter files (cronSkillFile.ts:15).
- Bundled routines: `src/process/resources/bundled-workflows/{routines.json,index.json}`
  (packaged as `<resources>/bundled-workflows`, BuiltinRoutinesSeeder.ts:56-72).
- Preview history: `<cacheDir>/preview-history/<sha1>/index.json` + `<snapshotId>.md`.
- Workspace snapshots: bare gitdirs `<workDir>/.darhai-snapshots/wayland-snapshot-*`
  (WorkspaceSnapshotService.ts:17-18).
- Memory/wiki: `.ijfw/memory/*.md`, `.ijfw/wiki/*.md`, `.ijfw/wiki-state/index.json`,
  `.promoted.json` sidecar; sweep settings `~/.config/wayland-dev/memory-archive-settings.json`.
- Pricing snapshot: `resources/modelsdev-snapshot.json` (ModelPricing.ts:25).
- cc-switch: `~/.cc-switch/{settings.json,cc-switch.db}` (read-only).
- Voice assets: `<userData>/voice/**` (whisper) and `~/.darhai/voice/**` (kokoro).

## Conventions & invariants

1. **Interface → Impl → singleton module**: `IXService` + `XServiceImpl` + `xServiceSingleton.ts`
   ("extracted to avoid circular deps") — see conversation/project pairs. Heavy cross-module
   access uses the `setX()/getX()` published-singleton pattern with null-tolerant getters
   (workflowSessionServiceSingleton.ts:30-41, CostRecorder.ts:204-211, cronReadiness.ts:20-26).
2. **Repositories are synchronous** prepared-statement classes over `ISqliteDriver`; append-only
   tables MUST expose `prune(cutoffMs)` and get a startup prune (initBridge.ts:145-173).
3. **Never block user flows**: telemetry, knowledge injection, ECC hook writes, budget hooks are
   all try/catch + `console.warn`/`log.warn`, never rethrown into the chat path
   (e.g. ConversationServiceImpl.ts:149-151, CostRecorder.ts:97-104).
4. **Never-clobber user-owned state**: ECC seeding skips on any foreign artifact
   (eccSystemService.ts:52-76); `settings.local.json` writes bail if `hooks` exists or the file
   is unparseable (219-225); `.darhai/` bootstrap is write-if-absent (bootstrap.ts:50-57).
5. **Atomic writes** for shared JSON/markdown: tmp + rename (eccSystemService.ts:229-231,
   wikiWriter.ts:56-60).
6. **Fail-soft retrieval ladder**: vector → keyword; missing model/extension degrades, never
   errors (SemanticIndexService header, EmbeddingService header). Untrusted corpus text is
   clamped (MAX_EMBED_CHARS, ijfwArchiveService.ts:42-44) and never executed.
7. **Prompt-cache stability**: any system-prompt composition must be byte-stable across turns —
   dynamic content goes in per-turn user-channel blocks (composePrompt.ts:27-31,
   composeWorkflowSystemPrompt.ts:7-11 vs composeStepContext.ts).
8. **CLI child processes** get sanitized env (`getEnhancedEnv()` + `NODE_OPTIONS:''`,
   `TERM:'dumb'`, `NO_COLOR:'1'`) and timeouts; heavy MCP ops serialize behind an operation
   queue (McpService.ts:32-44).
9. **IPC naming**: `domain.action` keys defined once in `src/common/adapter/ipcBridge.ts` and
   added to `bridgeAllowlist.ts`; a new domain = new namespace object + allowlist entries.
10. **Structure rule** (AGENTS.md): max 10 direct children per directory; new sub-domains get
    their own folder (as cost/, cron/, workflow/ do).
11. **Pure logic split from I/O**: score formulas, fusion, transitions, parsers are dependency-
    free pure modules with colocated `.bun.test.ts`/vitest tests (promotionScore, fusion,
    applyTransition, parseSteps, seededShuffle).

## Assimilation anchors

1. **New bundled-harness installer (Superpowers / IJFW / Odysseus payloads)** — mirror
   `src/process/services/eccSystemService.ts` end-to-end: stage payload via a `scripts/prepare*.js`
   into `resources/bundled-<name>`, classify-install with a completion marker written last,
   sentinel ProcessConfig key for interrupted seeds, `utilityProcess.fork` with pinned
   HOME/USERPROFILE, and a delayed idempotent kick in a bridge mirroring
   `src/process/bridge/eccBridge.ts` (7 s `SEED_DELAY_MS`). Wire status/toggles as
   `<name>.get-status` IPC keys next to `ecc.get-status` (ipcBridge.ts:1649).
2. **New per-spawn env/behavior toggle (e.g. more ECC gates, IJFW modes)** — copy the GateGuard
   triple: ProcessConfig key with default-on semantics (eccSystemService.ts:98-109), bridge
   provider (`eccBridge.ts:20-23`), env injection at the spawn site
   (`src/process/task/AcpAgentManager.ts:574-577`), settings panel
   `src/renderer/pages/settings/EccSettingsPanel.tsx`.
3. **New workspace-scoped config materialization (hooks, rules, skills for a workspace)** —
   imitate `ensureWorkspaceEccHooks` (eccSystemService.ts:204-236): write into
   `<workspace>/.claude/settings.local.json` (machine-local, gitignored), non-destructive,
   atomic; call it from the agent-spawn path next to AcpAgentManager.ts:1217.
4. **New observability/metering domain** — mirror the `cost/` package layout: `types.ts` with
   repo interfaces + NO-FK table, `SqliteXRepository`, read-only analytics service, recorder
   with `setX/getX` process singleton, DB migration, wiring inside the `getDatabase().then`
   block of `initBridge.ts` (149-198), and `x.*` IPC providers modeled on `cost.summary`
   (ipcBridge.ts:2298).
5. **New bundled autonomous routine / scheduled capability** — mirror
   `cron/BuiltinRoutinesSeeder.ts` (definitions in `src/process/resources/bundled-workflows/routines.json`,
   seeded DISABLED, tagged via `agentConfig.configOptions.kind`, `executionMode:
   'new_conversation'`, wcore backend); for one-shot agent delegation mirror
   `workflow/dispatchAutonomousStep.ts` (child conversation + `extra.*` back-pointer +
   completion listener in initBridge.ts:243 + watchdog backstop).
6. **New retrieval corpus (e.g. ECC skills, Odysseus docs)** — add a namespace to
   `semantic/types.ts:24`, then a lane module mirroring `semantic/skillSemanticLane.ts`
   (doc builder + keyword lane + `SemanticIndexService.getInstance().getRetriever(ns, lane)`);
   vec tables are created per namespace automatically by `SqliteVecStore`.
7. **New MCP-target backend** — subclass `AbstractMcpAgent`
   (`mcpServices/McpProtocol.ts:112`) and register it in the `McpService` constructor map
   (McpService.ts:83-92); config-file backends imitate `WCoreMcpAgent`, ProcessConfig-backed
   ones imitate `DarhaiMcpAgent`, CLI-shelling ones imitate `ClaudeMcpAgent`.
8. **New per-project knowledge channel** — extend `projectKnowledge/knowledge.ts`
   (KNOWLEDGE_FILE map, 30-34) and the injection point
   `ConversationServiceImpl.injectProjectKnowledge` (133-152), which writes into BOTH
   `extra.presetRules` (gemini/wcore) and `extra.presetContext` (acp) — any new backend must
   read one of those two fields.
