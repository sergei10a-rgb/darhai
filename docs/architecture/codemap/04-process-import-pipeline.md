# 04 process-import-pipeline

## Purpose

The memory import pipeline (internally "W1a import services") pulls knowledge from external
sources into the IJFW memory store as frontmatter-markdown `MemoryEntry` files. Sources: Claude
Code native memory (`~/.claude/projects/*/memory/*.md`), the third-party `claude-mem` SQLite DB,
Obsidian vaults, other IJFW projects found on disk, a live drop folder, and drag-dropped files
from the renderer. Everything lands in one target directory and is picked up by the memory index
watcher (`src/process/services/memory/ijfwArchiveService.ts`, covered in the memory area).

## Entry points & lifecycle

- `initImportBridge()` (`src/process/bridge/knowledge/importBridge.ts:75`) is called once at main-process
  startup from `initAllBridges()` (`src/process/bridge/index.ts:121`). It registers all
  `memory.import.*` + `memory.ingest-files` IPC providers.
- At the end of `initImportBridge()` (`src/process/bridge/knowledge/importBridge.ts:298`),
  `startDropWatcherIfNeeded()` (`importBridge.ts:304-321`) auto-starts a singleton chokidar
  watcher on `~/Documents/Darhai-Memory` (module-level handle `_dropWatcherHandle`,
  `importBridge.ts:56`). It is also lazily re-attempted on every `processDropFolder` call
  (`importBridge.ts:212`). Nothing in the codebase calls `handle.stop()` — the watcher lives for
  the process lifetime.
- Every other flow is renderer-driven via IPC from the memory page:
  - `src/renderer/pages/memory/components/ImportDrawer.tsx:97-198` (all four import cards)
  - `src/renderer/pages/memory/components/EmptyStateHero.tsx:82-108` (CTA cards on empty state)
  - `src/renderer/pages/memory/components/MemoryStatusBar.tsx:93` (drop-folder status chip)
  - `src/renderer/pages/memory/state-branches/FullPanelShell.tsx:350` (drag-drop → `ingestFiles`)
- Importer services are pure async functions (no classes, no singletons except the drop watcher)
  and can also be invoked directly in tests (`tests/unit/process/services/import/*.test.ts`).

## Key modules

| File | Responsibility |
| ---- | -------------- |
| `src/process/bridge/knowledge/importBridge.ts` | Registers the `memory.import.*` and `memory.ingest-files` IPC providers; zod-validates args; enforces the vault path allowlist; resolves the target memory dir; filters "source absent" pseudo-errors; owns the drop-watcher singleton; implements drag-drop ingest inline. |
| `src/process/services/import/claudeNativeImporter.ts` | Walks `~/.claude/projects/<proj>/memory/*.md` (skipping `MEMORY.md`, `claudeNativeImporter.ts:32`), re-frontmatters each file as an observation, writes `claude-<sha1(proj:file)[0:12]>.md`. |
| `src/process/services/import/claudeMemImporter.ts` | Opens `~/.claude-mem/claude-mem.db` read-only via better-sqlite3, reads the `observation` table, writes `observation-<sanitized-id>.md` per row. |
| `src/process/services/import/obsidianImporter.ts` | `detectVaults()` scans `~/Documents` (depth 4) for `.obsidian/` dirs; `runObsidianImport()` walks a vault's `.md` files (skipping `.obsidian`, `.trash`, hidden dirs, symlinks), caps to most-recent N, and writes `obsidian-<sha256(relPath)[0:16]>.md`; `readConfinedVaultFile()` is the TOCTOU-hardened reader. |
| `src/process/services/import/obsidianVaultConfig.ts` | Reads Obsidian's own `obsidian.json` (per-OS path) to list configured vaults and to build the trusted-path set used by the bridge's vault-path allowlist. |
| `src/process/services/import/devScanImporter.ts` | `scanForMemoryDirs()` walks home dir + every drive root (depth 1-2, `SKIP_DIR_NAMES` filter) for `<proj>/.ijfw/memory/` dirs not in `~/.ijfw/registry.md`; `runDevScanImport()` re-imports their `.md` blocks (via `parseMarkdownBlocks`) as `devscan-<sha1>.md`. |
| `src/process/services/import/dropFolderWatcher.ts` | Chokidar watcher (depth 0) + one-shot processor for `~/Documents/Darhai-Memory`; ingests `.md`/`.txt`/`.json`, wraps in frontmatter, writes `dropped-<ts>-<name>.md`, deletes the original; 30s basename dedup window; exposes status (`path`, `watching`, `ingestedToday`). |

Note: the bridge also imports `claudeMemImporter.ts` and `dropFolderWatcher.ts` — they are part of
this pipeline even though only four services are usually named; all six files above live in
`src/process/services/import/` (6 of the 10-children directory limit used).

## Contracts & data flow

### IPC provider keys

Declared in `src/common/adapter/ipcBridge.ts:2397-2420` (channel names via `buildProvider` from
`src/common/adapter/bridgeAllowlist.ts`; the allowlist is enforced at dispatch in
`src/common/adapter/main.ts:85`):

| Bridge path | Channel | Args → Result |
| ----------- | ------- | ------------- |
| `memory.import.claudeMem` | `memory.import.claude-mem` | `void` → `{ count, errors[] }` (native + DB importers combined, `importBridge.ts:81-100`) |
| `memory.import.obsidianVault` | `memory.import.obsidian-vault` | `{ vaultPath }` → `{ count, errors[], total?, capped? }` |
| `memory.import.obsidianDetectVaults` | `memory.import.obsidian-detect-vaults` | `void` → `{ vaults: { path, mdCount }[] }` (config ∪ Documents scan, config wins, `importBridge.ts:165-183`) |
| `memory.import.scanDevDir` | `memory.import.scan-dev-dir` | `void` → `{ count, projectsFound, errors[] }` (only candidates with `alreadyInRegistry === false` are imported, `importBridge.ts:191`) |
| `memory.import.processDropFolder` | `memory.import.process-drop-folder` | `void` → `{ count, errors[] }` |
| `memory.import.getDropFolderStatus` | `memory.import.get-drop-folder-status` | `void` → `{ path, watching, ingestedToday }` |
| `memory.ingestFiles` | `memory.ingest-files` | `{ files: { name, content, scope? }[] }` → `{ ok, ingested, errors[] }` (handled inline in `importBridge.ts:228-295`) |

### Validation at the bridge boundary

- `obsidianVaultSchema`: `vaultPath` string 1..2048 (`importBridge.ts:32`).
- `ingestFilesSchema`: 1..50 files, `name` 1..255, `content` ≤ 500,000 chars, `scope` enum
  `project|global` (`importBridge.ts:34-42`).
- Vault path allowlist: after `~` expansion + `path.resolve`, the path must be inside `os.homedir()`
  OR present (lexically or via `realpath`) in `getConfiguredVaultPaths()` — vaults Obsidian itself
  registered (`importBridge.ts:123-140`).

### Spawned processes, env vars, DB

- **No child processes** are spawned anywhere in this area (unique among Darhai pipelines).
- Env vars read: `APPDATA` (`obsidianVaultConfig.ts:37`) and `XDG_CONFIG_HOME`
  (`obsidianVaultConfig.ts:43`) — only to locate `obsidian.json`.
- DB: read-only `better-sqlite3` open of `~/.claude-mem/claude-mem.db`
  (`claudeMemImporter.ts:103`); single query
  `SELECT id, title, body, project, created_at, tags FROM observation`
  (`claudeMemImporter.ts:112`). A missing table is logged, not fatal. Darhai owns no tables here.

### Filesystem contract (the real "storage layer")

Target directory: `resolveMemoryDir()` (`importBridge.ts:59-73`). **Currently always returns
`~/.ijfw/memory`** — the project-scoped branch is an acknowledged stub (comment at
`importBridge.ts:64-68`); the ijfwArchiveService lookup is attempted, then discarded. Any
per-project import targeting must fix this function.

Input formats:

- Claude Code native memory: `~/.claude/projects/<proj>/memory/*.md`, one fact per file with
  `name`/`description`/`type` frontmatter; `MEMORY.md` index skipped (`claudeNativeImporter.ts:32`).
- `obsidian.json`: `{ vaults: { <id>: { path, ts, open? } } }` at
  `%APPDATA%/obsidian/obsidian.json` (win), `~/Library/Application Support/obsidian/obsidian.json`
  (mac), `$XDG_CONFIG_HOME/obsidian/obsidian.json` (linux) (`obsidianVaultConfig.ts:34-45`).
- IJFW registry: `~/.ijfw/registry.md`, pipe-separated lines, first field = project path,
  `#`/`<!--` lines are comments (`devScanImporter.ts:34-49`).
- Drop folder: `~/Documents/Darhai-Memory`, extensions `.md`/`.txt`/`.json` only
  (`dropFolderWatcher.ts:20-23`); originals are **deleted after successful write**
  (`dropFolderWatcher.ts:170-175`).

Output format — the MemoryEntry markdown contract every importer emits:

```
---
type: observation            (dev-scan preserves the source's type)
summary: <≤200 chars, newlines collapsed>
stored: <ISO 8601, from source mtime/created_at or now>
project: <source project / vault name / "global">
tags: [a, b]
source: claude-code | claude-mem | obsidian | dev-scan | drop-folder | drag-drop
source_file: <basename>      (claude-code, drop-folder)  |  source_path: <path>  (obsidian, dev-scan)
---
<body>
```

One deviation: drag-drop ingest in the bridge writes a different frontmatter shape
(`id`/`created`/`scope` keys instead of `stored`/`project`/`tags`, `importBridge.ts:270-280`) and
preserves pre-existing frontmatter verbatim, as does the drop folder
(`dropFolderWatcher.ts:128-130`).

Destination filename = dedup key (existence check → `skipped++`):

| Source | Filename | Where |
| ------ | -------- | ----- |
| claude-code | `claude-<sha1(proj:file)[0:12]>.md` | `claudeNativeImporter.ts:133-134` |
| claude-mem | `observation-<id sanitized [^a-zA-Z0-9_-]→_ ≤64>.md` | `claudeMemImporter.ts:126-128` |
| obsidian | `obsidian-<sha256(relPath)[0:16]>.md` | `obsidianImporter.ts:112-114,339` |
| dev-scan | `devscan-<sha1(projPath:file:summary[0:80])[0:12]>.md` | `devScanImporter.ts:262-265` |
| drop-folder | `dropped-<epoch-ms>-<sanitized name>.md` | `dropFolderWatcher.ts:113-116,165` |
| drag-drop | `dropped-<epoch-ms>-<sanitized name>.md` | `importBridge.ts:253-257` |

Caps and limits: `OBSIDIAN_MAX_FILES = 2000`, most-recent-by-mtime wins and `capped: true` is
returned (`importBridge.ts:49`, `obsidianImporter.ts:317-332`); vault md-count preview capped at
`MD_COUNT_CAP = 9999` (`obsidianVaultConfig.ts:32`); drop dedup window `DEDUP_WINDOW_MS = 30_000`
(`dropFolderWatcher.ts:28`).

## Conventions & invariants

1. **Importers never throw.** Every `run*Import` returns `{ imported, skipped, errors[] }` (plus
   source-specific fields) and converts all failures to `errors` entries; absent sources return
   early with a note. The bridge additionally try/catches and coerces to
   `{ count: 0, errors: [String(err)] }` (`importBridge.ts:96-99` et al.).
2. **"Source not present" is not an error.** Notes matching `ABSENT_SOURCE_NOTE`
   (`/not found/i`, `/No Claude Code memory found/i`, `importBridge.ts:52`) are filtered before
   reaching the renderer. New importers for optional sources must emit greppable absence notes.
3. **Deterministic dest filename = idempotency.** Re-running any import skips existing files; ids
   derive from stable source identity (path/row id), never from randomness.
4. **Path confinement is mandatory.** Renderer-supplied paths are `~`-expanded and resolved in the
   main process only; vault paths pass the home-or-configured allowlist (`importBridge.ts:123-140`);
   `ingestFiles` names reject `..` `/` `\` (`importBridge.ts:248`); sanitized ids are re-checked
   with `path.resolve(dest).startsWith(memDir + sep)` (`claudeMemImporter.ts:129-135`,
   `claudeNativeImporter.ts:136-139`); vault reads go through `readConfinedVaultFile`
   (O_NOFOLLOW + post-open `realpath` + `fstat` regular-file check,
   `obsidianImporter.ts:190-237`); all directory walks skip symlinks and hidden dirs
   (`obsidianImporter.ts:245-251`, `devScanImporter.ts:131-136`).
5. **Frontmatter value escaping.** Every emitted value collapses `[\r\n]+` to a space and slices
   to ≤500 chars (`buildFrontmatter`, e.g. `claudeNativeImporter.ts:52-54`); summaries additionally
   slice to 200. This prevents frontmatter injection from source content.
6. **chokidar safety.** Watchers use `depth: 0`, `ignoreInitial: true`, `followSymlinks: false`
   (`dropFolderWatcher.ts:202-207`) — per "HANDOFF §10 chokidar safety" (`dropFolderWatcher.ts:10`).
7. **Logging.** `electron-log` with a bracketed area tag: `[import]` in the bridge,
   `[claudeMemImporter]` / `[obsidianImporter]` / `[devScanImporter]` / `[dropFolderWatcher]` in
   services. Success paths log counts, never content.
8. **Duplication debt (known):** `buildFrontmatter` is copy-pasted 5× (`claudeNativeImporter.ts:46`,
   `claudeMemImporter.ts:34`, `devScanImporter.ts:193`, `obsidianImporter.ts:147`,
   `dropFolderWatcher.ts:97`). Only `devScanImporter.ts:15` reuses the shared parser
   (`parseMarkdownBlocks` from `src/process/services/memory/markdownFrontmatter.ts:128`).
9. **Tests exist for every module**: `tests/unit/process/services/import/{claudeMemImporter,
   claudeNativeImporter,devScanImporter,dropFolderWatcher,obsidianImporter}.test.ts` and
   `tests/unit/process/bridge/importBridge.ingestFiles.test.ts`. New importers ship with a matching
   unit test; importers take an `opts` override (`ijfwMemoryDir`, `projectsRoot`, `dropFolder`,
   `configPathOverride`) precisely so tests never touch real user dirs.

## Assimilation anchors

1. **New import source (ECC session archives, Superpowers memory, Odysseus vault, …):** add
   `src/process/services/import/<x>Importer.ts` exporting `run<X>Import(opts?: { ijfwMemoryDir?:
   string; ...overrides }) → { imported, skipped, errors[] }`, mirroring
   `src/process/services/import/claudeNativeImporter.ts` (filesystem source) or
   `claudeMemImporter.ts` (SQLite source). Then: (a) declare a provider under `memory.import` in
   `src/common/adapter/ipcBridge.ts:2397-2415` with a `memory.import.<kebab>` channel, (b) add a
   handler block in `initImportBridge()` (`src/process/bridge/knowledge/importBridge.ts:75`) following the
   claudeMem block (`importBridge.ts:81-100`) — zod-validate args, `resolveMemoryDir()`, filter
   absent-source notes, log `[import] <name> done`. Watch the 10-children directory limit
   (AGENTS.md): `import/` holds 6 files; a 5th+ new importer forces a subdirectory split.
2. **New import UI surface:** add a card to
   `src/renderer/pages/memory/components/ImportDrawer.tsx` (imitate the Claude card,
   `ImportDrawer.tsx:119-131` + `:272-299`) and optionally
   `EmptyStateHero.tsx:42-108`; i18n keys under `archive.import.<source>.*`
   (typed as `memory.archive.import.*` in `src/renderer/services/i18n/i18n-keys.d.ts:993+`).
3. **Live folder-based ingestion for a new capability** (e.g. auto-ingesting dropped skills or
   plans): mirror `src/process/services/import/dropFolderWatcher.ts` wholesale — depth-0 chokidar,
   extension allowlist, 30s basename dedup, frontmatter wrap, unlink-only-after-write — and manage
   its singleton handle from the owning bridge like `startDropWatcherIfNeeded()`
   (`importBridge.ts:304-321`).
4. **Disk-wide discovery of installed capability roots** (finding ECC/Superpowers/Odysseus
   installs): mirror `scanForMemoryDirs()` (`src/process/services/import/devScanImporter.ts:151`) —
   `candidateDevRoots()` (home + all drive letters, `devScanImporter.ts:81-111`), `SKIP_DIR_NAMES`
   OS-tree filter (`devScanImporter.ts:58-74`), depth-2 walk, registry-based already-known check.
5. **Project-scoped import targeting:** `resolveMemoryDir()` (`importBridge.ts:59-73`) is the
   single choke point every handler uses; making imports land in a project's `.ijfw/memory` (not
   just global) means completing this one function — no importer changes needed since all accept
   `ijfwMemoryDir`.
6. **DRY refactor anchor when touching this area:** extract the 5 duplicated `buildFrontmatter`
   copies into `src/process/services/memory/` next to `markdownFrontmatter.ts` before adding a 6th
   copy.
