# 03 process-ijfw-memory

## Purpose

Main-process integration of IJFW, Darhai's local "Memory engine": a pure-JS MCP server installed
at `~/.ijfw/mcp-server`. This area owns (1) the full install lifecycle — offline bundle seeding,
npm-based bootstrap/upgrade, staged `.pending` activation with verify+rollback, health watching —
and (2) the runtime MCP client that speaks newline-delimited JSON-RPC to that server over stdio.
It backs the renderer Memory page (`ipcBridge.ijfw.*`), the team-mode verification gate, and the
per-project prelude blocks injected into `CLAUDE.md`/`AGENTS.md`.

## Entry points & lifecycle

- **Build time**: `scripts/build-with-builder.js:461` runs `node scripts/prepareIjfw.js` before
  electron-builder. `prepareIjfw.js` stages `@ijfw/install@1.6.3` (pinned, override via
  `IJFW_INSTALL_VER`; skip via `IJFW_SKIP=1`) into `resources/bundled-ijfw/mcp-server`
  (`scripts/prepareIjfw.js:29,42-76`). `electron-builder.yml:135-139` ships that tree as
  extraResource `bundled-ijfw`.
- **App boot** (`src/index.ts:636-668`): unless `isCiRuntime || DARHAI_DISABLE_IJFW=1 ||
  DARHAI_E2E_TEST=1`, the main window creation dynamically imports `ijfwSystemService`, then runs
  in order: `applyPendingUpgrade()` (activate a staged upgrade from the previous boot),
  `startHealthWatcher()` (watch `~/.ijfw`), and — deferred 5 s so first paint is never blocked by
  `npm view` — `bootstrap()`.
- **Bootstrap** (`src/process/services/ijfwSystemService.ts:399-545`): opt-out check
  (`IJFW_AUTO_INSTALL=never` env or `ijfw.skipSetup` config) → `seedFromBundleIfPresent()` copies
  the installer-bundled seed to `~/.ijfw/mcp-server` when absent (zero npm / zero network,
  `ijfwSystemService.ts:87-111`) → detect local install → resolve latest npm version (24 h cached)
  → if stale, lock + `npx ijfw-install`; fresh installs go live immediately, upgrades are staged
  to `~/.ijfw/mcp-server.pending` and activated next boot.
- **IPC registration**: `initIjfwBridge()` is called from `src/process/bridge/index.ts:114`
  (defined in `src/process/bridge/engine/extensions/ijfwBridge.ts:23-92`); the drop-tab providers are registered by
  `src/process/bridge/engine/extensions/ijfwDropBridge.ts:246-248`.
- **MCP child**: spawned lazily on the first `ijfwMcpClient.invoke()`
  (`src/process/services/ijfw/ijfwMcpClient.ts:164-229`, `ensureSpawned` at 291-318), respawned
  transparently after crashes with a 5 s backoff (`RESPAWN_BACKOFF_MS`, line 32).

## Key modules

| File | Responsibility |
| --- | --- |
| `src/process/services/ijfwSystemService.ts` | Install lifecycle: detect (`lstat` + PATH probe), bundle seed, bootstrap/upgrade via `npx ijfw-install`, `.pending` activation with `spawnTestVerify` + rollback, health watcher, status emitter (`emitStatus` → `ipcBridge.ijfw.onStatusChanged`, line 375-383) |
| `src/process/services/ijfw/ijfwMcpClient.ts` | Singleton stdio JSON-RPC client: verb→tool mapping (lines 44-82), request multiplexing by id, serialized stdin writes, MCP envelope unwrap (lines 96-121), degraded/full mode, crash recovery + respawn backoff |
| `src/process/services/ijfw/nodeRuntime.ts` | Resolves the JS runtime for the MCP child: bundled `bun` when present, else Electron-as-Node with `ELECTRON_RUN_AS_NODE=1` (dev only — packaged builds have the RunAsNode fuse off, lines 8-19) |
| `src/process/services/ijfw/safeSpawn.ts` | The ONLY module under `ijfw/**` allowed to import `child_process` for npm/npx (header, lines 6-9); resolves `npm-cli.js`/`npx-cli.js` via absolute trusted paths, never bare PATH (SEC-007, lines 39-78) |
| `src/process/services/ijfw/envAllowlist.ts` | `buildChildEnv()`: exact-key env allowlist (`PATH`, `HOME`, …, `IJFW_AUTO_INSTALL`, `IJFW_HOME`, `IJFW_LOG_LEVEL`; lines 10-28) — no prefix matching (SEC-005) |
| `src/process/services/ijfw/atomicFile.ts` | `writeAtomic` (temp + fdatasync + rename), `moveWithExdevFallback` (cross-device copy fallback), `ijfwCacheKey` (sha256 of app/electron/node versions, lines 82-90) |
| `src/process/services/ijfw/installLock.ts` | `~/.ijfw/.install-lock`: O_EXCL acquire, nonce-verified release, staleness = hostname + bootTime + `pidAlive` (lines 76-82) |
| `src/process/services/ijfw/entryResolver.ts` | Maps `mcp-server/package.json` `bin` (string or `bin['ijfw-mcp']`) → `main` → fallback `src/server.js` to the JS entry path |
| `src/process/services/ijfw/healthCheck.ts` | `watchInstallRoot()`: `fs.watch` on `~/.ijfw`, calls back with existence of `mcp-server` (macOS FSEvents caveat documented, lines 10-15) |
| `src/process/services/ijfw/preludeManager.ts` | Rewrites the block between `<!-- IJFW-PRELUDE-START/END -->` sentinels in per-project `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`.cursorrules` (lines 17-22); never injects markers into files that did not opt in (lines 57-71) |
| `src/process/services/ijfw/mcpWireProtocol.ts` | Newline-delimited JSON-RPC `encode`/`decode`; `MAX_LINE_BYTES` 10 MiB, `MAX_BUFFER_SIZE` 16 MiB, `DecodeError` quarantines the child (lines 21-24) |
| `src/process/services/ijfw/ipcSchemas.ts` | Renderer→main trust boundary: `ALLOWED_VERBS` (20 verbs, lines 16-45), per-verb zod schemas (lines 81-173), `validateInvocation` (allowlist + prototype-pollution scan + 1 MiB byte cap, lines 201-216), strict `jsonRpcResponseSchema` (lines 219-228) |
| `src/process/services/ijfw/degradedMode.ts` | `shortCircuitIfDegraded()` helper + one-per-session toast latch with i18n key `memory.degraded.toast` (line 25). Currently no external callers — reserved for memory-enrichment hooks |
| `scripts/prepareIjfw.js` | Build-time staging of the bundled seed: runs `npx … ijfw-install --dir <tmp> --no-marketplace --yes`, copies `mcp-server` into `resources/bundled-ijfw/`, prunes `.git`/`.github`/`test*.js` (lines 34-35, 79-82) |
| `resources/bundled-ijfw/mcp-server/` | The staged pure-JS IJFW server tree (`bin/`, `src/`, `data/`, `scripts/`, `templates/`, `tools/`, `package.json`, docs). One copy is valid for every platform/arch — no native binaries |

Nearest consumers (outside strict scope, read for contracts): `src/process/bridge/engine/extensions/ijfwBridge.ts`
(IPC providers), `src/process/bridge/engine/extensions/ijfwDropBridge.ts` (drop-tab file ingest into `~/.ijfw/dump`),
`src/process/team/TeamSession.ts:68` + `src/process/team/VerificationGate.ts` (inject
`ijfwMcpClient.invoke` as the cross-audit gate).

## Contracts & data flow

**IPC surface** (`src/common/adapter/ipcBridge.ts:1622-1644`, namespace `ipcBridge.ijfw`):

| Key | Channel | Shape |
| --- | --- | --- |
| `onStatusChanged` (emitter) | `ijfw.status-changed` | `IjfwStatusPayload` (`status` union at 1603-1609 + `version/reason/errorReason/stderr/offline/cliCount`) |
| `brainInvoke` | `ijfw.brain-invoke` | `{verb, args?}` → `IjfwInvokeResult` |
| `getStatus` | `ijfw.get-status` | cached status, else active `detectLocalInstall()` (`ijfwBridge.ts:44-65`) |
| `checkNow` | `ijfw.check-now` | refresh latest-version cache |
| `triggerInstall` | `ijfw.trigger-install` | fire `bootstrap()` (renderer Install button) |
| `skipSetup` | `ijfw.skip-setup` | persist opt-out flag |
| `getRuntimeMode` | `ijfw.get-runtime-mode` | `'degraded' \| 'full'` |
| `dropList` / `dropIngest` / `dropQuarantine` | `ijfw.drop-*` | file queue in `~/.ijfw/dump` (`ijfwDropBridge.ts:34-40`) |

**Verb pipeline** (renderer → MCP): `brainInvoke` → `brainInvokeArgsSchema` envelope check →
`validateInvocation` (allowlist + per-verb zod) → `ijfwMcpClient.invoke(verb, args)` →
verb resolution: `DIRECT_TOOL_MAP` maps 12 verbs (`memory_recall` → `ijfw_memory_recall`, …,
`cross_project_search` → `ijfw_cross_project_search`; `ijfwMcpClient.ts:55-68`), and 8
`BRAIN_VERBS` (`think`, `links`, `wiki.*`, `conflict.resolve`; lines 44-53) are wrapped into a
single `ijfw_brain` tool call with `{verb, args}` → JSON-RPC `tools/call` over stdin → response
validated by `jsonRpcResponseSchema` → MCP envelope `{content:[{type:'text',text:'<json>'}],
isError}` unwrapped to the real payload (`unwrapMcpResult`, `ijfwMcpClient.ts:96-121`).
All results use `IjfwInvokeResult` (`src/common/types/ijfw.ts:53-55`); failures carry one of 15
`IjfwErrorReason` enum codes (`ijfw.ts:14-29`) mapped to i18n keys in the renderer.

**Spawned processes** (all env-filtered via `buildChildEnv`):

| What | Where | Command |
| --- | --- | --- |
| MCP server child | `ijfwMcpClient.ts:320-327` | `spawn(rt.command, [entry])` — `rt` = bundled bun (`<resources>/bundled-bun/<platform>-<arch>/bun[.exe]`, `shellEnv.ts:132-148`) or Electron-as-Node in dev |
| Spawn-test verify | `ijfwSystemService.ts:589-672` | same runtime + entry; sends `tools/list` (id 1), success = a tool named `ijfw_*` within 5 s; exit-before-success = fail (SEC-003) |
| Version check | `ijfwSystemService.ts:218-221` | `safeSpawn({cmd:'npm', args:['view','@ijfw/install','version']})` |
| Install/upgrade | `ijfwSystemService.ts:451-460` | `safeSpawn({cmd:'npx', args:['-y','--package','@ijfw/install@<v>','ijfw-install','--yes']})` (fallback target `1.5.4` when offline, line 438) |
| CLI PATH probe | `ijfwSystemService.ts:154-158` | `spawnSync('where'\|'which', ['ijfw'])` with Homebrew paths appended |
| Build staging | `prepareIjfw.js:50-63` | `npx -y --package @ijfw/install@1.6.3 ijfw-install --dir <tmp> --no-marketplace --yes` |

**Env vars**: `DARHAI_DISABLE_IJFW`, `DARHAI_E2E_TEST` (boot guard, `src/index.ts:637`);
`IJFW_AUTO_INSTALL=never` (bootstrap opt-out, `ijfwSystemService.ts:400`); `IJFW_SKIP=1`,
`IJFW_INSTALL_VER` (build-time, `prepareIjfw.js:29,42`); forwarded-to-children allowlist incl.
`IJFW_HOME`, `IJFW_LOG_LEVEL` (`envAllowlist.ts:10-28`); `ELECTRON_RUN_AS_NODE=1` added only on
the dev Electron fallback (`nodeRuntime.ts:44`).

**Config/storage keys**: `ijfw.skipSetup` in `ProcessConfig`
(`src/common/config/storage.ts:180`; read at `ijfwSystemService.ts:390-397`).

**Files & formats**:

- `~/.ijfw/mcp-server` (+ `.pending` staged upgrade, `.prev` rollback copy) — install tree; entry
  resolved from its `package.json` (`entryResolver.ts:20-45`).
- `~/.ijfw/.install-lock` — JSON `LockMetadata {pid, startTime, bootTime, nonce, hostname}`
  (`installLock.ts:17-23`), mode 0600, O_EXCL create.
- `<userData>/ijfw-latest-cache-<16-hex>.json` — `{version, fetchedAt}`, 24 h TTL
  (`ijfwSystemService.ts:176-208`); key salt from `ijfwCacheKey()`.
- `~/.ijfw/dump` (+ `.quarantine`) — drop-tab ingest queue; ≤50 MB/file, ≤20 files, extensions
  `.md .txt .json .yaml .yml .csv` (`ijfwDropBridge.ts:27-29`).
- Per-project `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`.cursorrules` — IJFW-managed block between
  `<!-- IJFW-PRELUDE-START -->`/`<!-- IJFW-PRELUDE-END -->` sentinels (`preludeManager.ts:17-22`).
- `<project>/.ijfw/memory/*.md` and `.ijfw/wiki/` — written by the MCP server; Darhai's Memory
  Archive surface reads them directly from the filesystem, deliberately bypassing MCP for reads
  (`ipcBridge.ts:2340-2373`, `2423-2426`).
- Wire format: newline-delimited JSON-RPC 2.0 (`\n`-framed, CRLF-tolerant), not Content-Length
  framing (`mcpWireProtocol.ts:6-19`).

## Conventions & invariants

- **Single spawn gateway**: only `safeSpawn.ts` may import `child_process` under `ijfw/**`
  (`safeSpawn.ts:6-9`); `ijfwMcpClient.ts` carries an explicit reviewed eslint override (line 16).
  New spawns must route through `safeSpawn`/`resolveIjfwNodeRuntime`, never raw `spawn` + PATH.
- **Env hygiene**: every child gets `buildChildEnv()` — exact keys only, extras validated against
  `/^[A-Z][A-Z0-9_]*$/` (`envAllowlist.ts:30-45`). Never forward raw `process.env`.
- **Runtime resolution**: never rely on `ELECTRON_RUN_AS_NODE` in packaged builds — the RunAsNode
  fuse is off (`nodeRuntime.ts:8-19`); always go through `resolveIjfwNodeRuntime()`.
- **Trust boundary at the bridge**: renderer args must pass `validateInvocation` — verb allowlist,
  prototype-pollution key scan (`__proto__`/`prototype`/`constructor`, `ipcSchemas.ts:183-195`),
  1 MiB byte cap (bytes, not UTF-16 units), then per-verb zod. Schemas use `.passthrough()` as a
  containment perimeter, not an exhaustive contract (comment at `ipcSchemas.ts:123-127`) — the MCP
  server owns argument semantics.
- **Bridge stays thin**: no degraded-mode pre-gate in `ijfwBridge.ts` — `invoke()` owns respawn
  and returns structured failures (`ijfwBridge.ts:34-41`). Internal consumers receive
  `ijfwMcpClient.invoke` by injection and fail SOFT when IJFW is unavailable
  (`TeamSession.ts:63-70`).
- **Every failure exit is total**: install failures must both `emitStatus` and `syncPrelude`
  (`failWithReason` helper, `ijfwSystemService.ts:682-691`); child `error`+`exit` double-fire is
  latched with a `settled` flag (`ijfwSystemService.ts:475-497`).
- **Upgrade safety**: upgrades stage to `.pending`, activate next boot under the install lock,
  with symlink/ownership checks before AND after the swap (TOCTOU re-check,
  `ijfwSystemService.ts:551-571,749-776`), full JSON-RPC spawn-test, and `.prev` rollback.
- **Path safety**: never walk `/`, `$HOME`, or system roots as a "project dir"
  (`isUnsafeProjectRoot`, `ijfwSystemService.ts:300-352`); drop-ingest mirrors the same refusal
  (`ijfwDropBridge.ts:53-80`); export paths are positive-root contained to Downloads/Documents
  (SEC-002, `ipcSchemas.ts:57-68`).
- **Never touch foreign files**: prelude mutation requires pre-existing sentinels
  (`preludeManager.ts:67-71`); bundle seeding never clobbers an existing install
  (`ijfwSystemService.ts:96-101`).
- **Durability**: config/cache writes via `writeAtomic` (fdatasync-before-rename); directory moves
  via `moveWithExdevFallback`; Windows EBUSY/EPERM retried with backoff
  (`ijfwSystemService.ts:573-586`).
- **Errors are enums**: all user-visible failures flow as `IjfwErrorReason` codes; the renderer
  localizes. Never return raw error prose as the primary signal.
- **Test hooks**: module-level state exposes `__`-prefixed resetters
  (`__resetCacheForTests`, `__setRuntimeModeForTests`, `__resetForTests`,
  `__setTrustedNpmCliResolver`) — follow this naming for new stateful modules.

## Assimilation anchors

1. **Ship a new offline engine (ECC, Odysseus daemon, …)**: mirror the three-part bundle pipeline —
   a staging script like `scripts/prepareIjfw.js`, an `extraResources` entry like
   `electron-builder.yml:135-139`, and a first-run seeder like `seedFromBundleIfPresent()`
   (`ijfwSystemService.ts:87-111`). ECC already imitates this exactly: `scripts/prepareEcc.js`
   (header cites "mirroring bundled-ijfw") + `src/process/services/eccSystemService.ts`.
2. **Expose a new memory/brain capability to the renderer**: add the verb to `ALLOWED_VERBS` +
   `verbSchemas` (`ipcSchemas.ts:16-45,81-173`), then map it in `DIRECT_TOOL_MAP` (1:1 `ijfw_*`
   tool) or `BRAIN_VERBS` (`ijfw_brain` facade) in `ijfwMcpClient.ts:44-68`. No renderer plumbing
   needed — `ipcBridge.ijfw.brainInvoke` already carries any allowlisted verb. History warning
   baked into the code: schemas that drift from the server contract fail silently at the gate
   (`ipcSchemas.ts:150-172`), so verify against the live server.
3. **New long-lived sidecar process**: imitate `IjfwMcpClient` wholesale — lazy `ensureSpawned`,
   respawn backoff, id-multiplexed pending map, serialized write queue, `handleChildLoss`
   (`ijfwMcpClient.ts:136-444`) — plus `mcpWireProtocol.ts` framing and
   `resolveIjfwNodeRuntime()` for the runtime.
4. **New install-lifecycle service with UI status**: copy the `ijfwSystemService` shape — status
   union + payload in `ipcBridge.ts:1595-1644`, `emitStatus`/`getLastStatus` pair
   (`ijfwSystemService.ts:363-388`), provider bridge like `ijfwBridge.ts`, registration in
   `bridge/index.ts:114`, and the guarded deferred boot block at `src/index.ts:636-668`
   (env kill-switch + 5 s bootstrap deferral).
5. **Main-side workflow gate consuming a local engine**: imitate `VerificationGate` +
   `TeamSession.ts:67-70` — take the invoke function as a constructor parameter (testable, no
   singleton import in the gate), default to `advisory`, and fail SOFT on `unavailable`.
