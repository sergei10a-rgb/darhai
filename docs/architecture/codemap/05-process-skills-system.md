# 05 process-skills-system

## Purpose

The skills subsystem indexes, secures, retrieves, and serves SKILL.md-based capabilities from five
sources (vendored library, team bundle, user-authored, imported, CLI-discovered) plus a small set of
app-bundled builtin skills. It implements a **two-channel architecture**: agents natively receive only
a bounded set (`_builtin` + pinned + assistant `enabledSkills`, ~30 skills), while the full 2,105-entry
vendored library is reachable exclusively through the `wayland_search_skills` MCP tool (BM25 + optional
vector recall). Every mutation path passes through SkillGuard (regex + optional LLM scan) with a
fail-closed quarantine for `blocked` verdicts.

## Entry points & lifecycle

1. **App boot (storage init)** — `src/process/utils/initStorage.ts` `initBuiltinAssistantRules()`
   syncs `src/process/resources/skills/` → `<config>/builtin-skills/` (prune-then-copy, app-managed,
   overwrite-on-update; ~L484-502). User skills dir `<config>/skills/` and `<config>/cron-skills/`
   are created if missing (~L504-513). It also registers the built-in `wayland-search-skills` stdio
   MCP server into the MCP catalog (~L818-864).
2. **Bridge init** — `initSkillsBridge()` (`src/process/bridge/agent/skillsBridge.ts:20`) is called from
   `src/process/bridge/index.ts:129` (Electron) and `src/process/utils/initBridgeStandalone.ts:97`
   (standalone server). On entry it synchronously calls `loadTeamSkills()` (team bundle overlay) and
   fire-and-forget `loadCliSkills()` (opt-in CLI discovery), then registers all `skills.*` IPC providers.
3. **Lazy library load** — `SkillLibrary` is a singleton; `index.json` is parsed on the first
   `list()/get()/loadBody()` call (`SkillLibrary.ts:192-214`), then the optional bundled-workflows
   index is merged (main library wins on name conflict, `SkillLibrary.ts:232-254`).
4. **Per-turn retrieval** — `buildTurnSkillContext()` (`src/process/task/agentUtils.ts:135`) runs on
   every user message: cached BM25 retriever over the library (rebuilt only when entry count changes,
   `agentUtils.ts:119-120,164-168`), plus additive vector recall via
   `src/process/services/semantic/skillSemanticLane.ts` (`scheduleSkillReindex` at `agentUtils.ts:161`,
   `augmentSkillAdvertWithVector` at `agentUtils.ts:216-222`).
5. **Session start** — `prepareFirstMessageWithSkillsIndex()` (`agentUtils.ts:436-523`) injects the
   bounded skill index + on-disk skill locations into the first message; `setupAssistantWorkspace()`
   (`src/process/utils/initAgent.ts:58`) symlinks (`'junction'` on Windows, `initAgent.ts:146`) only
   the BOUNDED SET into CLI-native skill dirs (`initAgent.ts:46-48`).
6. **MCP stdio subprocess** — `scripts/build-mcp-servers.js` bundles
   `src/process/resources/builtinMcp/searchSkillsServerEntry.ts` → `out/main/builtin-mcp-search-skills.js`
   (`build-mcp-servers.js:99-100`); agent sessions spawn it as `node <script>` per the catalog entry
   registered in `initStorage.ts:825-841`. Inside that subprocess, SkillLibrary/SkillRetriever run
   standalone (hence the deliberate no-module-level-import of ProcessConfig, `SkillLibrary.ts:22-26`).

## Key modules

| File | Responsibility |
|---|---|
| `src/process/services/skills/SkillLibrary.ts` | Singleton in-memory index of all skill sources. Lazy-loads `index.json` + optional `bundled-workflows` index; `registerSource()` merges additional sources (later wins, L264-277); `list()/get()/stats()` filtered queries; `loadBody()` reads markdown on demand — absolute paths honored for external sources, relative resolved against `resourceDir` with a `bodies/` fallback (L379-430); refuses `blocked` bodies (L385-388); `rescanIfStale()` on-demand rescan against `SKILL_SCANNER_VERSION` (L439-457). Path resolution probes dev / packaged (`process.resourcesPath`) / stdio-subprocess layouts (L51-118). |
| `src/process/services/skills/SkillRetriever.ts` | Pure-TS BM25 (k1=1.5, b=0.75, L62-63) over name+description+tags+category. Unicode tokenizer `/[\p{L}\p{N}_-]+/gu` (L50) so Cyrillic/Mongolian queries match. `buildIndex()` excludes `blocked` entries (L99); `retrieve()` returns `{name, description, score, matchedTerms}` (L144-192). Singleton + `resetInstance()`. |
| `src/process/services/skills/SkillGuard.ts` | Layered scan orchestrator: regex rules + optional LLM layer. `scan(skills, {llm, llmCall})` → `SkillSecurityReport[]`; verdict = `clean` / `review` (any finding) / `blocked` (any `critical` finding) (L45-49). `llmScanned` reflects whether the LLM layer actually ran (L21-27). Explicitly a WARNING system — the agent permission system is the enforcement boundary (L11-18). |
| `src/process/services/skills/skillGuardRules.ts` | `SKILL_GUARD_RULES` (L58-153): 7 regex/heuristic rules over body + description + tags — credential-access (critical), network-exfiltration (critical), shell-execution (critical), filesystem-write (medium), instruction-override (medium), obfuscation (medium, base64 blob + decode-run), index-poisoning (low, tag/content ratio). Evidence truncated at 120 chars (L23). |
| `src/process/services/skills/skillGuardLlmScan.ts` | Injectable LLM-scan seam: `LlmScanCall` type (L16); without an injected call, returns `{findings: [], ran: false}` per skill (L35-47) so reports never claim a scan that didn't happen. No production model is wired yet. |
| `src/process/services/skills/SkillImport.ts` | Hardened importer for 4 vectors: folder / git / zip / single SKILL.md, all landing in `~/.darhai/skills/imported/<name>/` (`IMPORTED_DIR`, L28). Folder: rejects symlink root and symlink children (L189-198, L335-338). Git: allowlist `https://` or `git@host:` only (L130-134), `git clone --depth 1` via `exec` (L80-82). Zip (JSZip): rejects multi-SKILL.md zips (L241-247), symlink entries, zip-slip via mixed-separator-safe `resolveContainedEntry` (L155-166), 16 MiB/entry + 64 MiB total caps (L144-145), strips non-`.md`, warns on executable refs (L137). Every import → `SkillGuard.scan({llm:true})`; `blocked` → quarantine, else `registerSource` with `source:'imported'` (L349-390). Full `SkillImportIo` seam for tests (L34-97). |
| `src/process/services/skills/SkillQuarantine.ts` | Moves blocked skills to `~/.darhai/skills/.quarantine/<name>/` (`QUARANTINE_DIR`, L22). `quarantine()` (move on disk, L45), `quarantineFromMemory()` (builder-modal flow: body never touches the live tree, L66-74), `isQuarantined()` (L76). Injectable `SkillQuarantineIo`. |
| `src/process/services/skills/CliSkillDiscovery.ts` | Opt-in scan of `~/.claude/skills/`, `~/.codex/skills/`, `~/.gemini/skills/` (L45-52) for `<dir>/SKILL.md`; parses via `parseFrontmatter` from AcpSkillManager (L94); registers entries as `source:'cli-discovered'` with `sourceLabel` per CLI (L100-108). Gated on config `skills.cliDiscovery.enabled` (default off, L143-156); idempotent latch (L113, 138-140); restart required to re-scan. |
| `src/process/bridge/agent/skillsBridge.ts` | All `skills.*` IPC providers (see Contracts). Also owns the skill-builder save flow: kebab-cases the name, **scans before writing** (C3, L196-207), quarantines blocked bodies from memory, else writes `~/.darhai/skills/<kebab>/SKILL.md` + registers `source:'user'` (L209-226). `updateBody` restricts edits to `user`/`imported` sources and re-scans before persisting (L93-118). |
| `src/process/resources/skills/` (builtin) | App-bundled skills synced to `<config>/builtin-skills/`. Top level (advertised, opt-in per assistant): `book-chapter-draft`, `book-copy-editor`, `book-developmental-editor`, `book-nonfiction-architect`, `book-production`, `book-publisher`, `book-story-architect`, `cli-setup`, `hermes-setup`, `mermaid`, `moltbook`, `morph-ppt`, `morph-ppt-3d`, `officecli-academic-paper`, `officecli-data-dashboard`, `officecli-docx`, `officecli-financial-model`, `officecli-pitch-deck`, `officecli-pptx`, `officecli-word-form`, `officecli-xlsx`, `openclaw-setup`, `pdf`, `star-office-helper`, `story-roleplay`, `wayland-webui-setup`, `weixin-file-send`. `_builtin/` (auto-injected for ALL agents): `cron`, `office-cli`, `skill-creator`. Loader: `resolveBuiltinDir('src/process/resources/skills')` in `initStorage.ts:470` (viteStaticCopy strips the prefix when packaged, L437-461; standalone-server fallbacks L472-480). |
| `src/process/resources/skills-library/` | Vendored library: `index.json` (2,105 entries: 1,973 `skill`, 107 `workflow`, 25 `agent-profile`; all `source:'wayland-library'`), `bodies/{agents,skills,workflows}/...` markdown trees, `discovery-queries.json` (2,003 retrieval eval queries, `{query, should_match, category_hint, should_not_match}`, topN 10). Packaged via `extraResources` to `<resources>/skills-library` (`SkillLibrary.ts:64-74`). |
| `src/process/resources/builtinMcp/searchSkillsServer.ts` | Factory for the `wayland_search_skills` tool handler: builds BM25 index once over `library.list()` (L48-56), retrieves, then loads bodies inline (blocked bodies drop out via `loadBody` null, L74-79). Dep-injectable for tests. |
| `src/process/resources/builtinMcp/searchSkillsServerEntry.ts` | Stdio MCP subprocess entrypoint (`@modelcontextprotocol/sdk` McpServer + StdioServerTransport, L45-94); zod input schema `{query: string, limit?: int ≤100}` (L56-65); tool description documents the second-channel contract (L28-43). |

Closely-coupled adjacents (contracts cross into this area):

| File | Coupling |
|---|---|
| `src/common/types/skillTypes.ts` | Canonical types: `SkillSource` (5 values, L11), `SkillType`, `SkillVerdict`, `SkillThreat`, `SkillIndexEntry`, `SkillSecurityReport`, `SKILL_SCANNER_VERSION = 1` (L64). |
| `src/process/task/AcpSkillManager.ts` | Bounded-set channel: `parseFrontmatter()` (L72-138, tolerant of flat CLI frontmatter) — also imported by CliSkillDiscovery; singleton keyed by `enabledSkills|exclude|prefsRevision` (L189-199); skips `_builtin` in optional-skill scan (L368). |
| `src/process/task/agentUtils.ts` | Per-turn advert + auto-load; first-message skills index + on-disk location text incl. hard cron-skill routing rule (L470-493). |
| `src/process/utils/initStorage.ts` | Dir owners: `getSkillsDir` (L401), `getBuiltinSkillsCopyDir` (L409), `getAutoSkillsDir` (L417), `getCronSkillsDir` (L425); `loadSkillsContent()` resolution order `_builtin` → builtin-skills → user skills, flat-file fallback (L1308-1316) with module-level cache (L1282). |
| `src/process/utils/initAgent.ts` | Workspace symlinking of the bounded set; blocked/disabled skills never symlinked (L112-117, 136-137). |
| `src/process/extensions/data/bundle-vendored/teamSkillMerge.ts` | Team bundle overlay: probes `~/dev/waylandteams` + userData variants for `contributes/skills.json` (L58-71), registers `source:'team'` entries with absolute paths; category derived from name prefix (L83-87); idempotent (L159-161). |
| `src/process/services/semantic/skillSemanticLane.ts` | Vector lane over the same corpus: `skillDocs()` excludes blocked (L34-36); background reindex latch (L59-84); additive-only advert augmentation (L94-126). |
| `src/process/bridge/workspace/fsBridge.ts` | Legacy/parallel skill IPC: `read-builtin-skill` (L1218), `list-available-skills` (L1268, skips `_builtin` at L1289, dedupe builtin>extension>custom at L1352-1358), `list-builtin-auto-skills` (L1373). |

## Contracts & data flow

**IPC provider keys** (defined `src/common/adapter/ipcBridge.ts:380-454`, provided in `skillsBridge.ts`):

- `skills.scan`, `skills.get-report`, `skills.rescan-all`
- `skills.import.folder` `{srcPath}`, `skills.import.git` `{url}`, `skills.import.zip` `{zipPath}`,
  `skills.import.single-skill-md` `{srcPath}` → all return `ImportResult {imported, quarantined, warnings}`
- `skills.list` `{type?}` (defaults to `'skill'` so workflows/agent-profiles don't pad the Skills page,
  `skillsBridge.ts:64-71`), `skills.stats` (mirrors the same filter, L73-79)
- `skills.get-body`, `skills.update-body` (errors: `not-found | read-only | no-writable-path | blocked`)
- `skills.set-pinned`, `skills.add-to-conversation` `{conversationId, name}`
- `skills.cli-discovery.get` / `skills.cli-discovery.set`
- `skills.build.draft` (stub template today, `skillsBridge.ts:166-187`), `skills.save`
- Legacy fs channel: `read-builtin-skill` (`ipcBridge.ts:300`), `list-available-skills` (L323),
  `list-builtin-auto-skills` (L325), `detect-and-count-external-skills` (L352)

**Spawned processes**: `node out/main/builtin-mcp-search-skills.js` — stdio MCP server, catalog id
`builtin-search-skills`, server name `wayland-search-skills`, tool `wayland_search_skills`
(`builtinMcp/constants.ts:13-15`); registered/path-refreshed on every boot (`initStorage.ts:818-864`).
`SkillImport.importGit` shells out to `git clone --depth 1` (`SkillImport.ts:80-82`).

**Config/storage keys** (ProcessConfig; typed in `src/common/config/storage.ts:341`):

- `skills.preferences` = `{pinned: string[], disabled: string[], revision: number}` — revision bump
  invalidates the AcpSkillManager singleton cache; seeded once by `src/common/config/skillsMigration.ts`.
- `skills.cliDiscovery.enabled` = boolean, default off, restart required.

**Filesystem layout** (all owner paths):

- `~/.darhai/skills/<name>/SKILL.md` — user-authored (skill builder)
- `~/.darhai/skills/imported/<name>/` — imports (`SkillImport.ts:28`)
- `~/.darhai/skills/.quarantine/<name>/` — blocked (`SkillQuarantine.ts:22`)
- `<userData>/config/builtin-skills/` (+ `_builtin/`), `<userData>/config/skills/`,
  `<userData>/config/cron-skills/<jobId>/SKILL.md` (`initStorage.ts:54-63,399-427`)
- `<resources>/skills-library/{index.json,bodies/}` and `<resources>/bundled-workflows/` when packaged

**DB**: `skills.add-to-conversation` writes `conversation.extra.sessionSkills: string[]` and
`conversation.extra.loadedSkills: {name, description}[]` via `getDatabase()` (`skillsBridge.ts:131-160`).
No dedicated skills table — the index is in-memory + on-disk JSON/markdown.

**File formats**:

- `SKILL.md` — YAML-ish frontmatter parsed by regex (`AcpSkillManager.ts:72-138`): required `name`;
  optional `description`, `type`, and an indented `metadata:` block
  (`author/version/tags/category/subcategory/difficulty/model/tools/depends`; tags/depends are
  space-delimited scalars).
- `skills-library/index.json` — array of `SkillIndexEntry`; vendored entries carry paths **relative to
  `bodies/`** (loadBody tries literal then `bodies/`-prefixed, `SkillLibrary.ts:421-429`); `security`
  ships as `{verdict:'unscanned', scannerVersion:0}` and is upgraded lazily by `rescanIfStale`.
- `discovery-queries.json` — retrieval eval set (not loaded at runtime by this area).

## Conventions & invariants

- **Blocked is fail-closed at every layer**: `loadBody` returns null (`SkillLibrary.ts:385`), BM25 index
  excludes (`SkillRetriever.ts:99`), vector docs exclude (`skillSemanticLane.ts:35`), workspace symlink
  skips (`initAgent.ts:136-137`), `add-to-conversation` rejects (`skillsBridge.ts:135`), MCP results drop
  (`searchSkillsServer.ts:74-79`). New consumers of skill bodies MUST re-check the verdict themselves.
- **Scan before persist**: no skill body reaches the live tree until SkillGuard returns a verdict
  (`skillsBridge.ts:196-207` save, L107-114 updateBody, `SkillImport._scanAndRegister`). Blocked bodies
  go to quarantine, never to `~/.darhai/skills/`.
- **Two-channel rule**: library-only entries are NEVER symlinked into agent workspaces
  (`initAgent.ts:46-48`); the full library is reachable only via `wayland_search_skills`.
- **Singleton + `resetInstance()` test hook** — SkillLibrary, SkillRetriever, AcpSkillManager all follow
  it; module-level idempotency latches for one-shot loaders (`CliSkillDiscovery.ts:113`,
  `teamSkillMerge.ts:43`) with `__resetForTests` escapes.
- **IO seams for anything touching disk/network**: `SkillImportIo`, `SkillQuarantineIo`,
  `SkillLibraryOptions.readFile` — production defaults live next to the type; tests inject.
- **Keep the MCP subprocess bundle lean**: never import `ProcessConfig`/`mainLogger` at module level in
  `services/skills/*`; use lazy `await import('@process/utils/initStorage')` and treat storage
  unavailability as a safe default (`SkillLibrary.ts:22-26,359-367`, `CliSkillDiscovery.ts:144-156`).
- **Name-collision policy**: lazy index load keeps first (`SkillLibrary.ts:200-205`); bundled workflows
  lose to the main library (L249); `registerSource` later-wins with a warning (L264-277) — so overlay
  sources (team/user/imported/CLI) can shadow vendored entries.
- **Path semantics encode source**: absolute `path` ⇒ external source read directly; relative ⇒ vendored,
  resolved under `resourceDir` (`SkillLibrary.ts:399-429`). `updateBody` uses "absolute + source
  user/imported" as its writability test.
- **Unicode-aware tokenization everywhere retrieval happens** (`SkillRetriever.ts:50`,
  `agentUtils.ts:114`) — ASCII-only regexes silently break Mongolian search; don't regress this.
- **Rescans are lazy, never on the boot path** (`SkillLibrary.ts:438`, `rescanIfStale`); bump
  `SKILL_SCANNER_VERSION` (`skillTypes.ts:64`) whenever rules change so stale reports self-invalidate.

## Assimilation anchors

1. **New skill source (e.g. an ECC/Superpowers/Odysseus pack discovered on disk)** — write a loader
   mirroring `src/process/services/skills/CliSkillDiscovery.ts` (idempotent latch, config-flag gate,
   `parseFrontmatter`, `SkillLibrary.getInstance().registerSource()` with a new `SkillSource` value added
   to `src/common/types/skillTypes.ts:11`), and call it from `initSkillsBridge()`
   (`src/process/bridge/agent/skillsBridge.ts:25-30`) next to `loadTeamSkills()`/`loadCliSkills()`. The closest
   analog for a manifest-driven bundle is `teamSkillMerge.ts` (absolute-path entries + derived category).
2. **Vendoring a large skill corpus** — extend `src/process/resources/skills-library/index.json` +
   `bodies/` (relative paths, `security.verdict:'unscanned'`), or for a separate optional corpus copy the
   `bundled-workflows` pattern: own resource dir + `resolveBundledWorkflowsDir`-style probe +
   graceful-no-op merge (`SkillLibrary.ts:97-118,232-254`). Remember `electron-builder.yml`
   `extraResources` so the packaged app finds it via `process.resourcesPath`.
3. **New always-on builtin skill (auto-injected for every agent)** — add
   `src/process/resources/skills/_builtin/<name>/SKILL.md` (imitate `_builtin/cron/`); the initStorage
   sync (`initStorage.ts:484-502`) and workspace symlinker (`initAgent.ts:126-148`) pick it up with zero
   code. Opt-in bundled skills go one level up (imitate `officecli-docx/`).
4. **New guard rule / threat class** — append to `SKILL_GUARD_RULES`
   (`src/process/services/skills/skillGuardRules.ts:58`), extend `SkillThreat`
   (`skillTypes.ts:14-21`), and bump `SKILL_SCANNER_VERSION` (`skillTypes.ts:64`) so `rescanIfStale`/
   `skills.rescan-all` re-evaluate the corpus. Wiring a real LLM scanner means implementing
   `LlmScanCall` (`skillGuardLlmScan.ts:16`) and passing it where `{llm:true}` is requested.
5. **New skills IPC capability** — declare the typed channel in the `skills` namespace of
   `src/common/adapter/ipcBridge.ts:380-454`, provide it in `skillsBridge.ts` (imitate
   `skills.update-body` for anything that writes: source check → guard scan → persist → registerSource).
6. **New agent-facing retrieval tool (e.g. workflow/agent-profile search for assimilated frameworks)** —
   copy the factory + stdio-entry pair `searchSkillsServer.ts` / `searchSkillsServerEntry.ts`, add an
   esbuild entry in `scripts/build-mcp-servers.js:95-101`, constants in
   `src/process/resources/builtinMcp/constants.ts`, and catalog registration in
   `initStorage.ts:818-864`.
