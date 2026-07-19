# 17 tests-architecture

## Purpose (3-5 lines)

Maps Darhai's four-runner test stack: Vitest 4 unit/integration/bench suites (`vitest.config.ts`), Playwright-driven
Electron e2e (`playwright.config.ts` + `tests/e2e/fixtures.ts`), Bun-runtime tests (`bun test` scripts), and the
adversarial red-team layer (unit `*.redteam.test.ts` + e2e `redteam-*.e2e.ts`). Documents how the repo survives the
Node-vs-Electron-vs-Bun ABI split (better-sqlite3), Windows CI quirks, and the conventions enforced by
`AGENTS.md` + `.claude/skills/testing/SKILL.md` that any assimilated capability must follow.

## Entry points & lifecycle — how and when this code runs

- **Unit/integration**: `bun run test` → `vitest run` (`package.json` scripts). Vitest 4 "projects" split runs into a
  `node`-env project (`tests/unit/**/*.test.ts`, `tests/unit/**/test_*.ts`, `tests/integration/**/*.test.ts`,
  `tests/regression/**/*.test.ts` — note `tests/regression/` does not currently exist) and a `jsdom` project matching
  `tests/unit/**/*.dom.test.ts{,x}` plus one co-located file `src/renderer/components/layout/PageShell/PageShell.test.tsx`
  (`vitest.config.ts:22-52`). Global `testTimeout: 10000`, `globals: true` (`vitest.config.ts:19-20`).
- **Setup files**: node project loads `tests/vitest.setup.ts`; dom project loads `tests/vitest.dom.setup.ts`
  (`vitest.config.ts:36,50`). Both install a fake `global.electronAPI` (`emit`/`on`/`windowControls`).
- **Coverage**: `bun run test:coverage` → v8 provider, includes `src/**/*.{ts,tsx}` + `scripts/prepareBundledBun.js`;
  thresholds are all 0 — deliberately "informational until coverage ramps up" (`vitest.config.ts:58-96`); the ≥80%
  target lives in convention (`.claude/skills/testing/SKILL.md:94`), not in config.
- **E2E**: `bun run test:e2e` → `playwright test --config playwright.config.ts`; `testDir: './tests/e2e'`,
  `testMatch: '{specs,features}/**/*.e2e.ts'`, `workers: 1` and `fullyParallel: false` because all tests share ONE
  singleton Electron app instance (`playwright.config.ts:4-10`). Tests require a prior `bunx electron-vite build`
  (e2e loads static `out/`, no HMR — `tests/e2e/README.md:5-16`).
- **Bench**: `bun run bench` → `vitest bench` on `tests/bench/**/*.bench.ts` → `./bench-results.json`
  (`vitest.config.ts:54-57`); `bun run bench:db` → **Bun runtime** `bun test ./tests/bench/database.bench.bun.ts`.
- **Bun-runtime unit**: `bun run test:bun` → `bun test src/process/services/database/drivers/*.bun.test.ts`
  (co-located `BunSqliteDriver.bun.test.ts` in src — the one suffix Vitest never touches).
- **CI**: `.github/workflows/pr-checks.yml` runs the vitest suite as a 12-cell matrix
  `[ubuntu-latest, macos-14, windows-2022] × shard [1..4]` via `bunx vitest run --shard=N/4` (suite exceeds a 10-min
  single-runner cap; Windows runners are ~2.7x slower, 20-min timeout). Windows cells disable Defender realtime
  scanning (`Set-MpPreference -DisableRealtimeMonitoring $true`) before `bun install` — the single biggest Windows
  speed fix. Aggregator jobs preserve required-check names "Unit Tests (<os>)".

## Key modules — table: file -> responsibility

### Config & setup

| File | Responsibility |
|---|---|
| `vitest.config.ts` | Aliases mirroring tsconfig (`@/`, `@process/`, `@renderer/`, `@worker/`, `@mcp/*`); node+dom projects; bench + v8 coverage config |
| `playwright.config.ts` | E2E runner: 60s test / 10s expect timeouts, 1 worker, CI retries=1, github+html reporters, `outputDir tests/e2e/results` |
| `tests/vitest.setup.ts` | Node-env setup: registers `NodePlatformServices` via `registerPlatformServices()` so `getPlatformServices()` works; stubs `global.electronAPI` |
| `tests/vitest.dom.setup.ts` | jsdom setup: jest-dom matchers; global `vi.mock('electron-log/renderer')` (unmocked import HANGS at collection time — `testTimeout` can't bound it, lines 10-30); `lucide-react` wrapper stamping `data-testid="icon-<Name>"` (lines 36-53); ResizeObserver/IntersectionObserver/rAF/scrollTo mocks; localStorage polyfill probed via own-property descriptor to avoid Node's experimental `--localstorage-file` stderr warning (lines 117-142) |
| `scripts/postinstall.js` | Skips `electron-builder install-app-deps` when `CI=true` → CI keeps the Node-ABI better-sqlite3 prebuilt that vitest needs (see nativeSqlite gate) |

### Unit-test infrastructure

| File | Responsibility |
|---|---|
| `tests/unit/helpers/nativeSqlite.ts` | `describeNativeSqlite()` ABI gate: probes `BetterSqlite3Driver(':memory:')`; local dev (Electron-ABI build) → `describe.skip`; CI + unloadable → one HARD-FAILING test so coverage can never vanish silently (lines 29-73) |
| `tests/fixtures/fake-acp-cli/index.js` | Minimal ACP JSON-RPC 2.0 CLI over stdio (`initialize`, `session/new`, `session/prompt` streaming) for spawn-boundary unit tests |
| `tests/fixtures/fake-extension/` + `fake-extension.zip` | Extension manifest (`aion-extension.json`) + install-script fixture for extension loader/installer tests |

### Unit-test body (~910 files, grouped — naming is the router, not config)

| Path group | Responsibility |
|---|---|
| `tests/unit/*.test.ts` (flat root, ~350 files) | Legacy flat naming (`acpAdapter.test.ts`, `team-TeamSession.test.ts`, `wcore-*.test.ts`); also 3 legacy `test_*.ts` files matched by a dedicated include glob (`vitest.config.ts:31`) |
| `tests/unit/process/**` | Mirrors `src/process/**` (acp session/infra/compat, bridge, channels plugins tier1-3 + webhook verifiers, providers, services/{ijfw,skills,memory,semantic,wiki,workflow,kickoff,import,usage,voice}, team, task, utils) — the convention for all new main-process tests |
| `tests/unit/renderer/**` | Mirrors `src/renderer/**`; components/pages/hooks as `*.dom.test.tsx`, pure utils as `*.test.ts` |
| `tests/unit/common/**`, `tests/unit/bridge/**`, `tests/unit/channels/**`, `tests/unit/webserver/**`, `tests/unit/scripts/**` | Shared-code, bridge-layer, channel-plugin, webui-server and build-script suites |
| `tests/unit/**/*.redteam.test.ts` (~10 files) | Adversarial unit layer: `bridgeAllowlist*.redteam.test.ts` assert `isAllowedForRemote('subscribe-<key>')` denies fs/project/channel mutation keys for remote WebSocket callers; `bridge/fsBridge.redteam.confinement`, `bridge/projectBridge.redteam.confinement`, `bridge/modelBridge.ssrf`, `process/services/projectKnowledge.redteam` |
| Windows-quirk suites | `tests/unit/acpUtilsDecodeWindows.test.ts` (GBK stderr → readable text via `decodeWindowsError`); `tests/unit/process/utils/atomicWrite.windowsAcl.test.ts` (Node ignores `mode` on win32 → helper must `icacls` owner-only DACL; platform faked via `Object.defineProperty(process,'platform')`, `child_process` mocked so icacls asserts run on any host); `tests/unit/prepareBundledBun.test.ts` (`bun.exe` vs `bun`, `DARHAI_BUN_CACHE_DIR`/`DARHAI_BUN_VERSION` env) |

### Integration (`tests/integration/`, 16 files)

| File group | Responsibility |
|---|---|
| `bundled-bun-packaged.test.ts`, `i18n-packaged.test.ts`, `webui-favicon-build.test.ts`, `webui-pwa-build.test.ts` | Packaged-artifact integrity: locate newest `out/**/resources` (or `APP_RESOURCES_DIR`/`APP_ASAR_PATH` env, lines 32-52) and assert bundled bun manifest / i18n / PWA assets survived electron-builder; `it.skip` when no build exists |
| `process/acp/session/AcpSession.{lifecycle,prompt}.test.ts`, `acp-smoke.test.ts` | Real `AcpSession` against spawned fake CLI |
| `team-{mcp-server,real-components,stress-concurrency,stress-tcp}.test.ts` | Team engine under real component wiring + stress |
| `i18n.test.ts`, `i18n-performance.test.ts`, `autoUpdate.integration.test.ts`, `hub-install-flow.test.ts`, `process/services/ijfwMcpClient.integ.test.ts` | Cross-service flows (all matched by the same `tests/integration/**/*.test.ts` glob) |

### Bench (`tests/bench/`)

| File | Responsibility |
|---|---|
| `tests/bench/serialization.bench.ts` | `vitest bench`; mirrors `extractSearchPreviewText` from `src/process/services/database/index.ts` against realistic payload sizes |
| `tests/bench/database.bench.bun.ts` | Bun-only (`bun:test` + `bun:sqlite`); adapts Bun's Database to the app's `ISqliteDriver`/`IStatement` interfaces and runs `initSchema` benchmarks (lines 1-60) |

### E2E harness (`tests/e2e/`)

| File | Responsibility |
|---|---|
| `tests/e2e/fixtures.ts` | THE e2e core: singleton `ElectronApplication` per worker; packaged mode (CI default, resolves `out/win-unpacked/Wayland.exe` / `mac-*/Wayland.app` / `linux-unpacked/wayland`, lines 81-119) vs dev mode (`electron .`); env contract (lines 205-214); `ensureWaylandteamsBundleSymlink` (lines 132-160); `page` fixture waits for `electronAPI` + 300ms navigation-quiet (lines 372-388); manual screenshot-on-failure attach; **no `afterAll`** — cleanup on `process beforeExit` so the app survives all describe blocks (lines 409-448); separate `ambientTest` singleton with `DARHAI_AMBIENT=1` (lines 450-574) |
| `tests/e2e/helpers/bridge.ts` | `invokeBridge(page, key, data)` — reimplements the @office-ai/platform wire protocol from the renderer: `emit('subscribe-<key>', {id, data})` → resolve on `on()` payload whose `value.name === 'subscribe.callback-<key><id>'` (lines 26-39); default 10s timeout |
| `tests/e2e/helpers/cdpDriver.ts` | Spawn+CDP driver for specs needing their OWN Electron instance: Playwright's `electron.launch` Node-inspector attach freezes Chromium's remote-debugging bind, so this spawns with `--remote-debugging-port` and drives via `Runtime.evaluate` (lines 12-33); NOTE `ELECTRON_BIN` is a hardcoded macOS path (line 39) |
| `tests/e2e/helpers/mockAgentBinary.ts` | Spawn-boundary mock: writes a Node script speaking enough ACP (`initialize`/`session/new`/`session/prompt`/abort) to a tmp dir so `AcpConnection` can drive a real OS process; typed for 9 agent backends |
| `tests/e2e/helpers/mocks/mockMcpServer.ts` | Dependency-free stdio MCP server (JSON-RPC line protocol, one `echo` tool) for `specs/mcp.e2e.ts` |
| `tests/e2e/helpers/navigation.ts` | `ROUTES` constants + `navigateTo`/`goToGuid`/`goToSettings`/`goToChannelsTab`/`waitForSettle` |
| `tests/e2e/helpers/conversation.ts` | `sendMessageFromGuid`, `waitForAiReply` (handles `.markdown-shadow` Shadow DOM), `selectAgent`, `deleteConversation`, `runConversationCycle` |
| `tests/e2e/helpers/selectors.ts` | Centralized CSS/Arco-class selectors; the header comment (lines 1-8) claims the app has no `data-testid`, but that is STALE — `src/renderer` now carries ~550 `data-testid` attributes (memory/settings/newer surfaces); the selectors here simply predate them |
| `tests/e2e/helpers/assertions.ts` | `expectBodyContainsAny` (i18n-agnostic text check), `expectUrlContains`, `createErrorCollector` |
| `tests/e2e/helpers/assistantSettings.ts` | Assistant CRUD driven through UI clicks (drawer open/fill/save/delete/search) |
| `tests/e2e/helpers/auth.ts` | WebUI server e2e: starts server via `webui.start` bridge, fetches CSRF token + signed cookie from `GET /`, runs authed flows from Node fetch |
| `tests/e2e/helpers/extensions.ts` | `getExtensionSnapshot`/`getChannelPluginStatus` bridge-read helpers |
| `tests/e2e/helpers/teamConfig.ts` | `TEAM_SUPPORTED_BACKENDS` = claude/codex/gemini, filterable via `TEAM_AGENT` env |
| `tests/e2e/helpers/screenshots.ts` | Manual screenshots to `tests/e2e/screenshots/` |
| `tests/e2e/helpers/index.ts` | Barrel re-export — specs import everything from `'../helpers'` |

### E2E specs & fixtures

| Path group | Responsibility |
|---|---|
| `tests/e2e/specs/*.e2e.ts` (~100 flat files) | Main body: `agent-<backend>.e2e.ts` per CLI backend; `team-*.e2e.ts` (~35 files, rules in `tests/e2e/specs/README.md`: actions ONLY via leader chat box, `invokeBridge` restricted to setup/assert/cleanup, all 3 leader types via `for...of` over `TEAM_SUPPORTED_BACKENDS`); `ext-*.e2e.ts` extension system; `auth-*.e2e.ts` WebUI; `redteam-{csrf,extension,jwt,path-traversal,upload}.e2e.ts`; `ambient-mode/bubble.e2e.ts` using `ambientTest` |
| `tests/e2e/features/**` | Newer taxonomy tree — populated: `conversations/acp/{config,display,messaging,permissions,reliability,session,skills}/*.e2e.ts` (23 files); everything else (`assistants`, `pet`, `previews`, `remote/channels/*`, `settings/*`, `teams`, `workspaces`) is `.gitkeep` placeholders reserving the layout. `testMatch` already covers both trees |
| `tests/e2e/fixtures/extensions/` | Wrapper dir scanned by ExtensionLoader for `<child>/aion-extension.json`; contains `e2e-minimal/` test extension, `redteam.html`, and the auto-created `waylandteams-bundle` symlink |
| `tests/e2e/fixtures/team-imports/*.json` | Malicious/edge import payloads: `prototype-pollution.json`, `xss-task-description.json`, `oversize.json`, `deep-nested.json`, `invalid-skill-id.json`, valid sandbox/trusted — consumed by `team-import-security/robustness/sandbox/trusted` specs |
| `tests/e2e/specs/redteam-path-traversal.e2e.ts` | Reference red-team shape: 7 traversal vectors (naked `../`, single/double URL-encoding, absolute injection, `./` noise, symlink escape, prefix confusion) fired via renderer `fetch()` against `wayland-asset://` — "exactly where a malicious LLM-rendered string would land" (lines 1-44) |

## Contracts & data flow

- **Test-file suffix routing (the real contract)**: `*.test.ts` → vitest node; `*.dom.test.ts{,x}` → vitest jsdom;
  `*.bench.ts` → `vitest bench`; `*.e2e.ts` → Playwright; `*.bun.test.ts` / `*.bench.bun.ts` → Bun's `bun test`
  (invisible to vitest); `*.redteam.test.ts` → normal vitest, name marks adversarial intent. No config change is ever
  needed for a new test — placement + suffix decide everything.
- **E2E IPC wire protocol** (`tests/e2e/helpers/bridge.ts:26-39`): request `emit('subscribe-<key>', { id, data })`,
  response event name `subscribe.callback-<key><id>`; provider keys are the exact strings registered in
  `src/common/adapter/ipcBridge.ts` (troubleshooting pointer in `tests/e2e/README.md:245-252`). The same wire strings
  are the unit-level remote-security surface: `isAllowedForRemote('subscribe-<key>')` in
  `tests/unit/bridgeAllowlist.redteam.test.ts:10-24`.
- **E2E env vars** (`tests/e2e/fixtures.ts:205-214`): `DARHAI_EXTENSIONS_PATH` (= `examples/` + fixtures wrapper,
  joined `';'` on win32 / `':'` elsewhere, line 197), `DARHAI_EXTENSION_STATES_FILE` (mkdtemp sandbox
  `wayland-e2e-state-*`), `DARHAI_DISABLE_AUTO_UPDATE=1`, `DARHAI_DISABLE_DEVTOOLS=1`, `DARHAI_E2E_TEST=1`,
  `DARHAI_CDP_PORT=0`, optional `DARHAI_AMBIENT=1`. Mode selectors: `E2E_PACKAGED=1` / `E2E_DEV=1` / `CI` (lines
  162-167); bundle: `DARHAI_E2E_BUNDLE_PATH` (line 135); leader filter: `TEAM_AGENT` (`helpers/teamConfig.ts:8`).
- **Spawned processes**: Playwright spawns Electron (packaged exe or `electron .`); `mockAgentBinary.ts` +
  `tests/fixtures/fake-acp-cli/index.js` spawn Node processes speaking ACP JSON-RPC over stdio; `mockMcpServer.ts`
  speaks MCP JSON-RPC over stdio; `cdpDriver.ts` spawns Electron with `--remote-debugging-port` and talks raw CDP.
- **better-sqlite3 ABI contract** (`tests/unit/helpers/nativeSqlite.ts:12-27`): local postinstall electron-rebuilds
  (Electron ABI, GUI works, vitest skips native suites); CI postinstall skips the rebuild (`scripts/postinstall.js`)
  so the Node-ABI prebuilt loads and suites RUN; `npm rebuild better-sqlite3` flips a dev machine to Node ABI.
- **Packaged-test env**: `APP_RESOURCES_DIR` / `APP_ASAR_PATH` override artifact discovery
  (`tests/integration/bundled-bun-packaged.test.ts:32-52`); `DARHAI_BUN_CACHE_DIR` / `DARHAI_BUN_VERSION` drive the
  bundled-bun preparation tests (`tests/unit/prepareBundledBun.test.ts:18-19`).
- **File formats**: `aion-extension.json` (extension manifest, both fixture trees); team-import JSON payloads
  (`tests/e2e/fixtures/team-imports/`); `bench-results.json` (vitest bench output); Playwright HTML report at
  `tests/e2e/report/`, artifacts at `tests/e2e/results/` (gitignored).

## Conventions & invariants

1. **Placement mirrors src**: new tests go under `tests/unit/<process|renderer|common>/...` mirroring the source path
   (flat-root names are legacy). Suffix selects the environment — never edit `vitest.config.ts` for a new test.
2. **`bun run test` green before every commit; coverage ≥80% by convention** (`AGENTS.md` Testing section,
   `.claude/skills/testing/SKILL.md:88-96`); config thresholds are 0, so the gate is procedural, not mechanical.
3. **Quality rules** (`.claude/skills/testing/SKILL.md:56-83`): behavior-named tests, ≥1 failure path per describe,
   ≤3 expects per `it`, risk-first scenario selection, "mentally delete the logic — would the test still pass?".
4. **jsdom hygiene**: any module that transitively imports `electron-log/renderer` is only safe because of the global
   mock in `tests/vitest.dom.setup.ts:19-30` — never remove it; icon assertions must use Lucide PascalCase testids
   (`icon-Trash2`), not icon-park kebab ids (lines 32-35).
5. **Native suites** must use `describeNativeSqlite`, never bare `describe` + manual skip — the CI hard-fail guard is
   the whole point (`tests/unit/helpers/nativeSqlite.ts:23-27`).
6. **E2E singleton discipline**: no `test.afterAll` app teardown (each relaunch ~25-30s, `fixtures.ts:410-413`);
   specs must clean their own data (delete E2E-prefixed teams/conversations); `invokeBridge` for setup/assert/cleanup
   ONLY — user actions must go through the UI (`tests/e2e/specs/README.md:44-53`).
7. **E2E requires a fresh build** (`bunx electron-vite build`) — stale-`out/` is the #1 flake source
   (`tests/e2e/README.md:236-241`). Timeout tiers: UI 5-15s, AI reply 120s, team ops 60-120s.
8. **Selectors centralized** in `tests/e2e/helpers/selectors.ts` (its "no `data-testid`" header is stale — newer
   surfaces DO have testids; prefer them for new selectors); helpers imported via the `'../helpers'` barrel.
9. **Every security-sensitive surface gets a red-team twin**: bridge keys → `bridgeAllowlist*.redteam.test.ts`; file
   paths → `*.redteam.confinement.test.ts`; renderer-reachable protocols/uploads → `redteam-*.e2e.ts` probing from
   `page.evaluate(fetch(...))`; hostile input files live as fixtures, not inline strings.
10. **Windows is a first-class matrix OS**: platform-divergent code (spawn stderr encoding, ACL/mode, `.exe` naming,
    path-sep) gets an explicit test with `process.platform` faked via `Object.defineProperty` so it runs on all hosts
    (`atomicWrite.windowsAcl.test.ts:52-55`).

## Assimilation anchors

- **New main-process service tests** (ECC engine, Superpowers runner, Odysseus services): create
  `tests/unit/process/services/<domain>/<Feature>.test.ts` importing via `@process/` alias — imitate
  `tests/unit/process/services/ijfw/safeSpawn.test.ts` (spawn/env allowlist patterns) or
  `tests/unit/process/services/skills/skillLibrary.test.ts`. If it touches SQLite, gate with `describeNativeSqlite`
  from `tests/unit/helpers/nativeSqlite.ts` — imitate `tests/unit/process/services/usage/SqliteUsageEventRepository.test.ts`.
- **New IPC provider**: three-part contract — (a) bridge unit test mirroring `tests/unit/process/bridge/ijfwBridge.test.ts`;
  (b) a deny/allow row in `tests/unit/bridgeAllowlist.redteam.test.ts` (ECC precedent already exists there: the
  GateGuard toggle is asserted local-only, remote-denied); (c) e2e assertion via `invokeBridge(page, '<key>', ...)`.
- **New sidebar page / renderer surface**: `tests/unit/renderer/pages/<page>/<Component>.dom.test.tsx` — imitate the
  `tests/unit/renderer/pages/memory/*` cluster (20 files covering page shell, cards, drawers, dropdowns, status bar);
  hooks as `use<X>.dom.test.ts` beside them.
- **New e2e user flow**: `tests/e2e/specs/<feature>.e2e.ts` (or `tests/e2e/features/<area>/...` for the new taxonomy —
  placeholders already reserve `settings/skills`, `teams`, `workspaces`) importing `{ test, expect } from '../fixtures'`
  and helpers from `'../helpers'` — imitate `tests/e2e/specs/skills.e2e.ts` for a bridge+UI flow or
  `tests/e2e/features/conversations/acp/skills/skills-inject.e2e.ts` for the taxonomy style. Zero config changes.
- **New agent/CLI backend**: extend `MockBinaryAgent` in `tests/e2e/helpers/mockAgentBinary.ts` and add
  `tests/e2e/specs/agent-<name>.e2e.ts` mirroring `agent-claude.e2e.ts`; for the unit spawn boundary imitate
  `tests/fixtures/fake-acp-cli/index.js` + `tests/integration/acp-smoke.test.ts`.
- **New hostile-input feature** (imports, uploads, skill installs): add payload fixtures beside
  `tests/e2e/fixtures/team-imports/prototype-pollution.json` and probe from renderer context mirroring
  `tests/e2e/specs/redteam-path-traversal.e2e.ts`; schema-level twins mirror
  `tests/unit/process/team/importExport/safeParse.test.ts`.
- **Bun-runtime perf/DB work**: co-locate `*.bun.test.ts` next to the driver (mirror
  `src/process/services/database/drivers/BunSqliteDriver.bun.test.ts`) and wire a `bun test <glob>` script in
  `package.json` — vitest will ignore it by suffix.
