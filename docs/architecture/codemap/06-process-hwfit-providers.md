# 06 process-hwfit-providers

## Purpose

Two independent main-process subsystems. **hwfit** (`src/process/services/hwfit/`) is the hardware-fit
model advisor ("Загвар зөвлөмж" / Cookbook): it probes the host's CPU/RAM/GPU, then ranks a bundled
local-LLM catalog (an Odysseus `hf_models.json` port) against that hardware with a pure 4-sub-score
pipeline. **providers** (`src/process/providers/`) is the cloud-model registry: key detection/discovery,
connection testing via real 1-token inference, a two-tier SQLite-persisted model catalog
(assembled from `/v1/models` + models.dev enrichment, curated for the picker), spawn-time secret
resolution, a 24h auto-refresh scheduler, and legacy `model.config` migration/mirroring.

## Entry points & lifecycle

- **hwfit**: registered by `initHwfitBridge()` (`src/process/bridge/hwfitBridge.ts:142`), called from
  `src/process/bridge/index.ts:136` during main-process IPC setup. Purely on-demand: the renderer's
  model-advisor page (`src/renderer/pages/model-advisor/*`) calls `hwfit.scanHardware` /
  `hwfit.rankModels` / `hwfit.catalogSize`. Hardware probes are cached 60s
  (`hwfit/hardwareDetect.ts:35`) with in-flight dedup (`hardwareDetect.ts:46-54`); `fresh=true` is the
  UI's Rescan. Remote (paired-device WebSocket) callers are denied hwfit entirely
  (`src/common/adapter/bridgeAllowlist.ts`).
- **providers**: registered by `initModelRegistryIpc()` (`src/process/providers/ipc/modelRegistryIpc.ts:1453`),
  called fire-and-forget from `src/process/bridge/index.ts:140`. Registration is synchronous once the DB
  opens; then `scheduleStartupMigration()` (`modelRegistryIpc.ts:1565`) defers to `app.whenReady()`:
  (1) one-time legacy `model.config` → registry migration (gated on `safeStorage` availability,
  `modelRegistryIpc.ts:1409-1435`), (2) post-upgrade catalog refresh gated by the
  `migration.modelRegistryCatalogDataVersion` cursor vs `CATALOG_DATA_VERSION = 1`
  (`modelRegistryIpc.ts:1554`, `1620-1637`), (3) `ModelRefreshScheduler.start()` — a 30-min wall-clock
  staleness poll, refresh-if-older-than-24h, launch-if-stale ≥12h, powerMonitor resume hook
  (`scheduler/ModelRefreshScheduler.ts:44-48,129-144`).
- **auth-failure detection** runs inside spawned-agent managers: `AcpAgentManager.maybeInvalidateProviderKeyOnAuthError`
  (`src/process/task/AcpAgentManager.ts:686-698`) calls `selectAuthFailureCulprits`
  (`providers/detection/authFailure.ts:36`) and flips the culprit provider row to `error/unauthorized`
  via `ProviderRepository.updateRegistryProviderState`. `WCoreManager` uses the same helpers.
- **spawn-time secret resolution**: `hydrateModelForSpawn` / `resolveModelSecretsForSpawn`
  (`modelRegistryIpc.ts:1249,1289`) are called by backend-spawn paths just before launching a chat
  process — the renderer and persisted conversations only ever hold the non-secret handle.

## Key modules

### hwfit (`src/process/services/hwfit/`)

| File | Responsibility |
|---|---|
| `index.ts` | Public entry: `rankCatalog(system, options)` wires bundled catalog → pure ranker; re-exports `scanHardware`, `getCatalog` |
| `types.ts` | Native shapes: `CatalogModel` (camelCase port of Odysseus `hf_models.json`), `HardwareProfile`, `FitResult`, `RankOptions`, `UseCase`/`RunMode`/`FitLevel` enums |
| `modelCatalog.ts` | Loads `data/modelCatalog.json` via static import (bundled at build time, no runtime fs read); frozen accessors `getCatalog`/`getCatalogSize` |
| `data/modelCatalog.json` | ~450KB bundled local-model catalog (HF repo id, params, quant, context, MoE fields, ggufSources) |
| `hardwareDetect.ts` | Host probes: nvidia-smi (PATH + absolute fallbacks, line 38), AMD via `/sys/class/drm` + rocminfo (147), Apple Silicon via sysctl (196), Windows single PowerShell/WMI probe (227-259); 60s cache + shared in-flight promise; never throws — degrades to CPU/RAM-only profile |
| `hardwareParse.ts` | Pure parsers for untrusted probe output: `parseNvidiaSmi`, `parseWindowsProbe` (JSON), `appleMetalBudgetGb`, `classifyAmdGfx` (rdna/cdna/gcn), `parseRocmGfx` |
| `fitScore.ts` | Pure ranking pipeline: use-case weights (line 30), speed/context targets, `inferUseCase`, `nativeQuant`/`quantBits`, `analyzeModel` (quant-at-context fitting w/ context-halving, line 245-267), platform serving-path filters (Apple/Windows/consumer-AMD ⇒ GGUF-only, multi-GPU ⇒ no GGUF tiers, line 470-535), sort + limit |
| `quantTables.ts` | Calibration tables: `QUANT_BYTES_PER_PARAM`, `QUANT_SPEED_MULT`, `QUANT_QUALITY_PENALTY`; `paramsB` parser ("7B"/"355M"/raw), MoE `activeParamsB`, `estimateMemoryGb` (line 229: weights + KV-cache×activeParams×ctx + 0.5GB overhead), prototype-safe `tableLookup` (line 148) |
| `speedModel.ts` | tok/s model: `GPU_BANDWIDTH` substring table (~90 GPUs incl. Apple M-series, line 20), harmonic CPU/GPU bandwidth blend for offload (line 177), backend fallback constants |

### providers (`src/process/providers/`)

| File | Responsibility |
|---|---|
| `index.ts` | Barrel: types + detection + catalog classifier exports |
| `types.ts` | `NativeProviderId` (33-member closed union, line 7-40), branded open `ProviderId` (line 50), Wave-0 two-tier contract: `RawModel`/`CatalogModel`/`CuratedModel`/`UsageTag` (line 76-127), `ProviderConnState`, `ConnectError` |
| `storage/ProviderRepository.ts` | SQLite repository over the three `model_registry_*` tables; encrypts creds via `safeStorage` (`encryptRegistryCreds`, line 59), discriminated `RegistryCredsResult` (`ok`/`not-found`/`undecryptable`, line 44), catalog stored as one JSON blob per (provider, model) |
| `ipc/modelRegistryIpc.ts` | The 1803-line integration hub: 15+ `modelRegistry.*` IPC handlers, `buildAndPersistCatalog` (line 348), connect/rekey shared flow w/ rekey-rollback (line 500), keyless `ollama-local` loopback-scoped refresh (line 414, 749), `refreshAllOnce` sweep (line 714), chat-start payload mapping tables (line 966-1080), spawn-secret resolution (line 1225-1296), startup migration + data-version refresh + scheduler wiring (line 1453-1637), `models.*` ProcessConfig accessors (line 1645-1675) |
| `detection/authFailure.ts` | Pure culprit selection: `isProviderKeyAuthFailure` (narrow regex, line 22 — 429/5xx must NOT match), `selectAuthFailureCulprits` matches injected env vars against backend auth vars |
| `detection/ConnectionTester.ts` | Real-inference probe: 1-token completion against a per-provider `TEST_MODEL` (line 62), stale-model fallback to `/v1/models` (line 145), degraded auth-only probe, status→`ConnectError` classification (line 378), 15s timeout |
| `detection/KeyDiscovery.ts` | Env-var + CLI config scan: `PROVIDER_ENV_VARS` (line 47), only `~/.codex/auth.json#OPENAI_API_KEY` file source (line 113); `scan()` returns `{providerId, source}` only — key material read on demand by `readValue()` (consent model) |
| `detection/ProviderDetector.ts` | Pure key-string → provider detection over `SORTED_PATTERNS`; bare `sk-` returns `ambiguous-sk` |
| `detection/providerKeyPatterns.ts` | Ordered prefix/structural rules (`sk-ant-`, `AIza`, `gsk_`, JWT→minimax…, line 16-184), `SK_BARE_CANDIDATES` for the race |
| `detection/skRaceResolver.ts` | Resolves ambiguous `sk-` keys by racing parallel `/v1/models` probes (800ms race window, line 11) |
| `detection/providerAuth.ts` | Single source of auth truth: `bearer` default, `anthropic` (x-api-key + version), `query` (Gemini `?key=`) (line 39) |
| `detection/providerEndpoints.ts` | `/v1/models` URL per provider (line 7-47); shared by SkRaceResolver, ConnectionTester, ApiProviderSource |
| `sources/CatalogSource.ts` | Source contract: `{ kind: 'api'\|'wcore'\|'cli', providerId: string, listModels() }`; `providerId` intentionally NOT `ProviderId` (CLI agent keys) |
| `sources/ApiProviderSource.ts` | `/v1/models` fetcher: 3 response shapes (OpenAI `data[]`, Gemini `models[]` + pageToken, Anthropic has_more/last_id), 50-page/32MB/5000-model caps (line 28-32), custom-baseUrl endpoint derivation (line 134), typed `ProviderSourceError` |
| `sources/CliAgentSource.ts` | CLI-agent models: only Codex is enumerable (`codex debug models --bundled` via `safeExecFile`, line 80-85); claude/gemini honestly return `[]` with `enumerable:false` |
| `sources/WaylandCoreSource.ts` | wcore is an engine, not a provider — `listModels()` returns `[]` by design |
| `sources/validateBaseUrl.ts` | SSRF gate: https-only (http loopback allowed in dev only), rejects loopback/link-local/private literal hosts (line 32-67); run at save AND before every scheduled refresh |
| `catalog/CatalogAssembler.ts` | Join stage: `RawModel[]` × models.dev registry → `CatalogModel[]`; provider-scoped lookup via `MODELS_DEV_PROVIDER_KEY` (line 55, exported), usage-tag derivation (line 212), id-derived `deriveFamily` w/ date-strip (line 284) |
| `catalog/Curator.ts` | Pure curation: text-only, group-by-family, newest-first, enriched-family eligibility, `KNOWN_LEGACY_IDS` blocklist (line 93), 540-day recency window vs catalog's own newest date (line 78), displayName dedup, flagship/previous roles; Flux tier ids always-enabled exception (line 315) |
| `catalog/providerCatalogStore.ts` | The ~100 connectable catalog PROVIDERS (separate concept from per-provider models): vendored `data/providerCatalog.generated.json` is routing authority + fail-safe floor; models.dev adds only `modelCount` metadata (line 173-182) |
| `catalog/catalogProvider.ts` | `RawCatalogEntry` (engine snake_case) ↔ `CatalogProviderEntry` (camelCase) mapping |
| `catalog/catalogCuration.ts` | Eligibility filter for engine catalog rows: missing-fields / native-collision / templated / local-only / anthropic-wire (line 120-137); `NATIVE_ID_MAP` compile-checked against `NativeProviderId` (line 28) |
| `catalog/fluxVirtualModels.ts` | Guarantees the four Flux tier ids exist in the flux-router catalog (appended as unenriched virtuals) |
| `catalog/ModelCatalog.ts` | Older in-memory per-provider model fetch/cache (W2A vintage) using classifier + capability detector; superseded by the two-tier store for the registry path |
| `catalog/ModelClassifier.ts` + `modelClassifierRules.ts` | Model id → `ModelTier` (flagship/everyday/fast/reasoning/legacy) via per-provider ordered regex rules; optional remote rule override |
| `catalog/ModelCapabilityDetector.ts` + `modelCapabilityRules.ts` | Model id → `Capability[]` (chat/vision/image/audio/embeddings/reasoning), additive regex rules |
| `catalog/ModelDisplayNames.ts` | Humanises raw model ids (strip vendor prefix/date/version, dot-normalise `3-5`→`3.5`, glossary caps) |
| `catalog/data/providerCatalog.generated.json` | Generated ~100-provider catalog (id/displayName/baseUrl/envVar/apiPath); built by `scripts/generateProviderCatalog.mjs` |
| `catalog/data/providers.vendored.toml` | Build-time fallback snapshot of the wcore engine `providers.toml` (read only by the generator script) |
| `enrichment/ModelsDevClient.ts` | models.dev fetch with 3-rung fallback: live (validated + atomic cache write) → userData cache → bundled snapshot → `{}` (line 39-56); 10s timeout, 32MB streaming cap |
| `enrichment/modelsDevSchema.ts` | Schema pin + validator for the registry payload; anchors on `anthropic`+`openai` presence (line 80) |
| `scheduler/ModelRefreshScheduler.ts` | Auto-refresh lifecycle: pure `isStale` (line 59), single-flight, online gate, exponential backoff capped 6h, before-quit teardown |
| `migration/legacyModelConfigMigration.ts` | One-time `model.config` → registry migration: groups legacy rows by resolved `ProviderId` (platform map line 151 + baseUrl fingerprints line 160), unions models/overrides/protocols, transactional provider+catalog writes, completion flag `migration.legacyModelConfigToRegistry` (line 74) set only on non-failing runs |
| `legacyModelConfigBridge.ts` | Write-through mirror registry → legacy `model.config` blob for 5 unrefactored legacy selectors; serial Promise mutex (line 115), rows tagged `__waylandModelRegistryBridge: v2:<providerId>` (line 48-62), mirrors curated-enabled ids only (line 138) |

## Contracts & data flow

**IPC namespaces** (defined in `src/common/adapter/ipcBridge.ts`):

- `hwfit.*` — channels `hwfit.scan-hardware`, `hwfit.rank-models`, `hwfit.catalog-size`
  (`ipcBridge.ts:1090-1100`). Remote-denied.
- `modelRegistry.*` — channels `modelRegistry.detectKeys|connect|testConnection|list|getCatalog|toggleModel|refresh|disconnect|rekey|curatedForAgent|getProviderCatalog|resolveForChatStart|refreshAll|getRefreshState|getAutoRefresh|setAutoRefresh` plus emitter `modelRegistry.list-changed` (`ipcBridge.ts:1825-1877`).

**Spawned processes / external commands** (all via `safeExecFile`, argv-array, no shell):

- `nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits` (`hwfit/hardwareDetect.ts:44`, fallback paths line 38-42, 8s timeout)
- `powershell.exe -NoProfile -NonInteractive -Command <WINDOWS_PS_PROBE>` (`hardwareDetect.ts:227-271`, 15s timeout)
- `sysctl -n machdep.cpu.brand_string | hw.memsize | iogpu.wired_limit_mb` (macOS, `hardwareDetect.ts:201-208`)
- `rocminfo` / `/opt/rocm/bin/rocminfo` (`hardwareDetect.ts:183`)
- `codex debug models --bundled` (`sources/CliAgentSource.ts:80-85`, 10s timeout)

**Network endpoints**: `PROVIDER_ENDPOINTS` map (`detection/providerEndpoints.ts:7`), inference-probe
URLs built in `ConnectionTester.buildInferenceRequest` (`ConnectionTester.ts:224`), models.dev
`https://models.dev/api.json` (`enrichment/ModelsDevClient.ts:27`), local Ollama
`http://127.0.0.1:11434/v1` + `/api/tags` probe (`modelRegistryIpc.ts:218,1369`).

**Env vars read**: `PROVIDER_ENV_VARS` (`detection/KeyDiscovery.ts:47` — `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY`, `GROQ_API_KEY`,
`OPENROUTER_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `TOGETHER_API_KEY`,
`FIREWORKS_API_KEY`, `PERPLEXITY_API_KEY`, `COHERE_API_KEY`, `CEREBRAS_API_KEY`);
`NODE_ENV` (`sources/validateBaseUrl.ts:72`).

**DB tables** (migration v39, `src/process/services/database/migrations.ts:1682-1722`):

- `model_registry_providers(provider_id PK, connected_via, state, error, creds_encrypted, created_at, updated_at)`
- `model_registry_catalog(provider_id, model_id, model_json, updated_at, PK(provider_id, model_id), FK→providers ON DELETE CASCADE)`
- `model_registry_overrides(provider_id, model_id, enabled, updated_at, PK(provider_id, model_id), FK CASCADE)`

**ProcessConfig keys**: `model.config` (legacy `IProvider[]` blob — bridge + migration),
`migration.legacyModelConfigToRegistry` (`legacyModelConfigMigration.ts:74`),
`migration.modelRegistryCatalogDataVersion` (`modelRegistryIpc.ts:1625`), `models.lastRefreshedAt`,
`models.announcedModelIds`, `models.autoRefresh` (`modelRegistryIpc.ts:1645-1675`).

**File formats / stores**: bundled `hwfit/data/modelCatalog.json` (camelCase `CatalogModel[]`);
`<userData>/modelsdev-cache.json` (last-good registry, mode 0600, atomic write —
`ModelsDevClient.ts:28,112`); `resources/modelsdev-snapshot.json` (bundled via electron-builder
extraResources — `ModelsDevClient.ts:134-141`); `catalog/data/providerCatalog.generated.json`
(generated by `scripts/generateProviderCatalog.mjs` from the engine's `providers.toml`, with
`providers.vendored.toml` as offline fallback).

**Credential flow (the load-bearing invariant)**: creds enter via `connect`/`rekey` IPC or KeyDiscovery
→ serialized JSON → `safeStorage.encryptString` → `creds_encrypted` column. They are decrypted only in
main, in three places: catalog build, connection test, and spawn-time secret resolution.
`resolveForChatStart` returns only the non-secret handle (`modelRegistryIpc.ts:855-865`); the key is
re-resolved fresh at every spawn by `hydrateModelForSpawn` (`modelRegistryIpc.ts:1289`) and never
persisted in the conversation blob nor sent to the renderer. `apiKey: undefined` (not `''`) is the
explicit "intentionally keyless local provider" signal (`modelRegistryIpc.ts:1206-1242`).

## Conventions & invariants

- **Never throw across a handler/probe boundary.** Every IPC handler returns a typed failure shape
  (`{ok:false, error}` / `[]`); every hardware probe degrades to a CPU-only profile; `ModelsDevClient`
  bottoms out at `{}`. New code in this area must follow this "typed failure, no exception" style.
- **Pure core, impure shell.** Scoring (`fitScore.ts`), parsing (`hardwareParse.ts`), curation
  (`Curator.ts`), staleness (`isStale`), auth-failure decisions (`authFailure.ts`) are pure and
  unit-testable; IO lives in detect/tester/client/IPC files. The Curator explicitly avoids `Date.now()`
  (reference date = catalog's newest release, `Curator.ts:78`).
- **Structural dependency injection.** Handlers depend on `ModelRegistryRepo` / `ModelRegistryDeps`
  slices (`modelRegistryIpc.ts:156-213`), not concrete classes; test fakes are in-memory objects.
- **Untrusted-input hardening at every boundary**: renderer overrides clamped in `hwfitBridge.ts:95-139`;
  prototype-safe `tableLookup` (`quantTables.ts:148`); streamed byte caps on HTTP bodies
  (`ApiProviderSource.ts:299`, `ModelsDevClient.ts:162`); pagination/model-count caps; schema-pinned
  models.dev validation.
- **SSRF discipline**: any stored custom `baseUrl` is validated by `validateProviderBaseUrl` before
  every unattended refresh (`modelRegistryIpc.ts:769-777`); the keyless `ollama-local` exemption is
  scoped to strict loopback only (`isLoopbackBaseUrl`, `modelRegistryIpc.ts:227-241`).
- **Auth-failure narrowness**: only unambiguous key-rejection strings may disable a provider
  (`authFailure.ts:22`); transient 429/5xx must never match. Extend the regex, never loosen it.
- **Single source of truth maps**: auth strategy (`providerAuth.ts`), models endpoint
  (`providerEndpoints.ts`), models.dev key mapping (`CatalogAssembler.ts:55` — cloud subset derived,
  never re-declared). New provider metadata goes in these maps, not inline.
- **Vendored catalog is routing authority**: models.dev may never contribute `baseUrl`/`apiPath`/`envVar`
  (`providerCatalogStore.ts` header + line 160-165).
- **Legacy compatibility is explicit and tagged**: bridge rows carry `__waylandModelRegistryBridge:
  v2:<providerId>`; migrations are cursor/flag-gated and idempotent; failed migrations retry next boot
  rather than half-complete.
- **Never fabricate model lists**: non-enumerable CLI returns `[]` + `enumerable:false`
  (`CliAgentSource.ts:34-52`); unenriched models are honestly `enriched:false`.
- **Naming residue**: `Wayland`/`wcore` identifiers (e.g. `User-Agent: Wayland/1.0` in
  `ConnectionTester.ts:300`, `WaylandCoreSource`, bridge tag key) survive the Darhai rebrand as
  internal identifiers — renames here touch persisted tags, so treat them as frozen wire constants.

## Assimilation anchors

1. **New IPC service namespace (e.g. an ECC skill-registry or workflow engine)** — mirror the hwfit
   trio: process service under `src/process/services/<name>/` with a pure core + `index.ts` facade,
   a validating bridge file `src/process/bridge/<name>Bridge.ts` (imitate
   `src/process/bridge/hwfitBridge.ts` clamping style), channel defs in
   `src/common/adapter/ipcBridge.ts` (imitate the `hwfit` block at line 1090), registration call in
   `src/process/bridge/index.ts:136`. Add remote-deny in `bridgeAllowlist.ts` if the surface is local-only.
2. **New credentialed provider / external AI backend** — the checklist is exactly the per-file maps:
   add to `NativeProviderId` (`providers/types.ts:7`), `PROVIDER_ENDPOINTS`, `PROVIDER_AUTH` (if not
   bearer), `TEST_MODEL` (`ConnectionTester.ts:62`), `PROVIDER_ENV_VARS` + `ENV_SCAN_ORDER`
   (`KeyDiscovery.ts:47,71`), key pattern (`providerKeyPatterns.ts`), `MODELS_DEV_PROVIDER_KEY`
   (`CatalogAssembler.ts:55`), `CHAT_START_PLATFORM`/`CHAT_START_BASE_URL`/`CHAT_START_NAME`
   (`modelRegistryIpc.ts:966,1010,1047`), `NATIVE_ID_MAP` (`catalogCuration.ts:28`). The `ollama-local`
   plumbing (`modelRegistryIpc.ts:216-241,414-429,749-767`) is the template for any keyless local daemon
   (e.g. an assimilated local vLLM/llama.cpp serve manager).
3. **New catalog source kind (e.g. skills-as-models, MCP-tool catalogs, Odysseus local models)** —
   implement `CatalogSource` (`sources/CatalogSource.ts:29`), imitating `CliAgentSource.ts` for
   spawn-based enumeration (safeExecFile + timeout + honest `[]`) or `ApiProviderSource.ts` for
   HTTP enumeration (caps + typed errors); wire it into `buildAndPersistCatalog`'s source-selection
   branch (`modelRegistryIpc.ts:370-388`).
4. **New one-time or versioned data migration** — imitate the pair: flag-gated one-shot
   (`migration/legacyModelConfigMigration.ts`, structural store/repo slices, transactional writes,
   retry-on-total-failure) and cursor-gated re-derivation (`CATALOG_DATA_VERSION` +
   `_runPostUpgradeCatalogRefresh`, `modelRegistryIpc.ts:1554,1687`). New SQLite tables follow
   migration v39's shape (`services/database/migrations.ts:1682`): FK CASCADE children keyed on the
   parent id, JSON blob columns for evolving shapes.
5. **Extending the hwfit advisor (Mongolian/custom model entries, serve-command generation,
   auto-download)** — the seam is pre-built: tag user-supplied catalog entries `source:
   'custom'|'discovered'` (`hwfit/types.ts:62-69`) and merge them over the bundled set in
   `modelCatalog.ts` (its header names this exact flow); new scoring inputs go in `quantTables.ts` /
   `speedModel.ts` calibration tables so `fitScore.ts` stays weight-driven. A serve/download
   orchestrator would be a NEW bridge namespace (hwfit is deliberately read-only —
   `hwfitBridge.ts:10-11`), imitating anchor 1.
6. **Background maintenance loops (e.g. skill-sync, memory compaction)** — imitate
   `ModelRefreshScheduler`: injected `runRefresh`/`now`/`isOnline` deps, pure `isStale` predicate,
   single-flight, wall-clock staleness (not naive setInterval), backoff, `before-quit` teardown,
   armed from the post-ready block in `modelRegistryIpc.ts:1588-1594`.
