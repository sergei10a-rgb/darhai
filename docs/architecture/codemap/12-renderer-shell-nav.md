# 12 renderer-shell-nav

## Purpose

The renderer's application shell: bootstrap (`src/renderer/main.tsx`), the hash router with every page route (`components/layout/Router.tsx`), the three-region chrome (Titlebar / left Sider / content Outlet in `components/layout/Layout.tsx`), the entire sidebar navigation tree (`components/layout/Sider/**`), the global style system (`src/renderer/styles/**` + `uno.config.ts`), and the shared page scaffolding (`PageShell`, `library/*`). Every new page or nav destination in Darhai must be threaded through exactly these files, so this area is the primary integration surface for assimilating ECC/Superpowers/IJFW/Odysseus UIs.

## Entry points & lifecycle

1. `src/renderer/index.html` — Vite entry. `lang="mn"`, sets `data-theme` + `data-color-scheme` on `<html>` and `arco-theme` on `<body>` synchronously from `localStorage` keys `__wayland_theme` / `__wayland_colorScheme` before any JS bundle loads (anti-flash, lines 23–35 and 49–54). Loads `./main.tsx` as module.
2. `src/renderer/main.tsx` — boot order matters and is explicit in the file:
   - Sentry renderer init (lines 13–28): only when `VITE_SENTRY_DSN` env is set **and** `window.electronAPI` exists; dynamically imports `@sentry/electron/renderer` and applies the shared PII scrubber `createScrubPii()` from `src/common/utils/sentryPii`.
   - `./utils/ui/runtimePatches` then `@/common/adapter/browser` (browser IPC adapter) are imported before React (lines 31–34).
   - Styles import order (lines 60–63): `@fontsource-variable/inter` → `uno.css` → `styles/arco-override.css` → `styles/themes/index.css`. Arco base CSS is imported at line 51 (`@arco-design/web-react/dist/css/arco.css`) plus the React-19 adapter (`es/_util/react-19-adapter`, line 50).
   - i18n side-effect import `./services/i18n` (line 66), then `registerPwa()` (line 146; no-ops inside Electron per `services/registerPwa.ts:18`).
   - Provider stack (lines 106–115): `AuthProvider → ThemeProvider → PreviewProvider → ConversationTabsProvider`. `Config` (line 117) wraps Arco `ConfigProvider` with `theme.primaryColor '#4E5969'` and a per-language Arco locale map (`arcoLocales`, lines 98–104; Korean locale patched at 79–96). `App = HOC.Wrapper(Config)(Main)` uses `utils/ui/HOC.tsx` right-to-left wrapper composition.
   - `Main` (line 126) waits for `useAuth().ready`, then renders `<Router layout={<ConversationHistoryProvider><Layout sider={<Sider/>}/></ConversationHistoryProvider>}/>`.
3. `components/layout/Router.tsx` — `HashRouter`; `ProtectedLayout` (lines 72–89) gates all routes on `useAuth().status === 'authenticated'`, redirects to `/login` otherwise, and mounts `OnboardingOverlay` beside the layout. All pages are `React.lazy` chunks wrapped in `withRouteFallback` (Suspense + `AppLoader`). The layout element is passed in from main.tsx and rendered via `React.cloneElement` (line 85).
4. `components/layout/Layout.tsx` — mounts once per authenticated session; owns sider collapse/resize, custom-CSS injection, mobile detection, tray-event and main-log bridges, and the global ⌘K/Ctrl+K command palette.

## Key modules

| File | Responsibility |
|---|---|
| `src/renderer/index.html` | HTML shell; sync theme restore from localStorage; PWA manifest/icons; CSP note — Google Fonts `<link>` deliberately removed (`SEC-ELEC-02` comment, lines 15–19) |
| `src/renderer/main.tsx` | Bootstrap: Sentry, adapters, styles, i18n, provider stack, Arco ConfigProvider + locales, `createRoot` render |
| `components/layout/Router.tsx` | All routes (see contract table below), auth gating, lazy chunks, legacy-route redirects |
| `components/layout/Layout.tsx` | App chrome: Arco `Layout.Sider` + `Layout.Content`; collapse state; drag-to-resize with snap (consts lines 68–74); mobile overlay sider; custom-CSS load/heal/inject (lines 175–304); tray events (352–406); main-process log bridge (336–349); ⌘K palette host (110–161) |
| `components/layout/Titlebar/index.tsx` | Custom titlebar: sider toggle, in-app history back/forward, brand lockup images (theme-swapped via CSS), mobile center title from conversation/team IPC lookups (lines 191–242), workspace toggle, `WindowControls` on Win/Linux |
| `components/layout/Titlebar/titlebar.css` | Titlebar layout, drag-region, `app-titlebar__*` classes |
| `components/layout/WindowControls.tsx` | Min/max/restore/close via `ipcBridge.windowControls.*`; subscribes `maximizedChanged`; hides itself when the IPC invoke rejects (non-desktop) |
| `components/layout/Router.tsx` `PanelRoute` | Also mounts `ToastProvider` (settings toast system) above the router |
| `components/layout/AppLoader.tsx` | Full-viewport Arco `<Spin dot/>` route fallback |
| `components/layout/FlexFullContainer.tsx` | `flex-1 relative min-h-0` + absolute inner — standard "fill remaining height" wrapper |
| `components/layout/PwaPullToRefresh.tsx` | iOS-PWA-only pull-down-to-reload on `.layout-content`; inert in Electron |
| `components/layout/PageShell/PageShell.tsx` | Standard page scaffold: title/icon/count/subtitle/actions/filterRail/toolbar + width cap `narrow=800/standard=1120/full` (lines 29–40); wraps `LibraryPageHeader` |
| `components/layout/PageShell/PageShell.module.css`, `.test.tsx`, `index.ts` | Styles, tests, re-export |
| `components/layout/library/LibraryPageHeader.tsx` | h1 + icon + muted count + right-aligned actions slot |
| `components/layout/library/LibrarySectionHeader.tsx` | Section sub-headers within library pages |
| `components/layout/library/LibraryFilterRail.tsx` / `LibraryFilterRow.tsx` | Sticky left filter rail + row primitives used by Assistants/Workflows/Teams library pages |
| `components/layout/Sider/index.tsx` | Sider orchestrator: settings-mode swap to lazy `SettingsSider`; three-zone grid (topZone / scrollZone / footerZone, lines 219–342); all nav click handlers (cleanupSiderTooltips → blurActiveElement → closePreview → navigate); Cmd/Ctrl+Shift+L logout (lines 147–161, web only) |
| `components/layout/Sider/Sider.module.css` | Three-zone grid (`gridContainer` `grid-template-rows: auto 1fr auto`), overlay scrollbar, footer shadow, tightened context-menu rows |
| `components/layout/Sider/SiderItem.tsx` | Generic sidebar row: icon + truncated name + selected orange gradient & 2px brand active-rail (lines 74–90) + pin indicator + three-dot Arco `Dropdown/Menu` |
| `components/layout/Sider/SiderNav/index.ts` | Barrel for the 14 nav components |
| `SiderNav/SiderToolbar.tsx` | "New chat" (+ hover-scale animation via CSS module) and batch-mode toggle |
| `SiderNav/SiderSearchEntry.tsx` | Wraps `ConversationSearchPopover` from `pages/conversation/GroupedHistory` |
| `SiderNav/SiderSessionsEntry.tsx` | Nav row → `/conversations` (canonical simple-entry template, `data-testid='sider-sessions-entry'`) |
| `SiderNav/SiderProjectsEntry.tsx` | Nav row → `/projects` (`FolderKanban` icon) |
| `SiderNav/SiderMemoryEntry.tsx` | Nav row → `/memory`; orange 8px badge when `wiki.getState` → `orphanCandidates.length > 0`; subscribes `wikiBridge.stateChanged` (lines 45–65) |
| `SiderNav/SiderToolsGroup.tsx` | Collapsible "Tools" group wrapping 7 secondary entries; purely presentational (children passed in); expand state in localStorage `wayland.sidebar.tools.expanded` (line 14); active tint on header while collapsed |
| `SiderNav/SiderAssistantsEntry.tsx` | Nav row → `/assistants` (`LayoutGrid`) |
| `SiderNav/SiderFluxRouterEntry.tsx` | 4-state Flux Router status widget (connect/install/ollama/wired) from `useOnboardingDetection` + `window.electronAPI.onboardingFluxMetrics()` (lines 116–136); `install` opens `https://fluxrouter.ai/download` externally, others navigate to `/settings/models` |
| `SiderNav/SiderWorkflowsEntry.tsx` | Nav row → `/workflows` (`Workflow`) |
| `SiderNav/SiderScheduledEntry.tsx` | Nav row → `/scheduled` (`Clock`) |
| `SiderNav/SiderTeamsEntry.tsx` | Nav row → `/teams` (`Users`) |
| `SiderNav/SiderMissionControlEntry.tsx` | Nav row → `/mission-control` (`Gauge`) |
| `SiderNav/SiderModelAdvisorEntry.tsx` | Nav row → `/model-advisor` (`Cpu`) |
| `SiderNav/SiderActiveTeams.tsx` | "Active" running-team rows with token/USD cost meter (`useTeamCostMeter`); hidden when collapsed or none active; now rendered inside `SiderTeamsSection` |
| `Sider/SiderAccordion/SiderAccordionShell.tsx` | `@api-frozen` accordion primitive: chevron + icon + label + live badge (99+ cap), `aria-expanded`/`aria-controls`, Enter/Space toggle |
| `Sider/SiderAccordion/useSiderAccordionState.ts` | `@api-frozen` shared open/closed state for keys `scheduled|workflows|teams`; localStorage `sider.accordion.state.v1` + custom event `wayland:sider-accordion-changed` for same-renderer sibling reconciliation |
| `Sider/SiderAccordion/SiderScheduledSection.tsx` | Cron accordion: `useAllCronJobs`, cap 5 rows, route-aware auto-expand (also for `/conversation/:id` whose conv has a cron job via `job.metadata.conversationId`), hidden when `activeCount === 0` |
| `Sider/SiderAccordion/SiderWorkflowsSection.tsx` | In-flight workflows accordion: badge via `ipcBridge.workflow.countActive` (300ms debounce) + `workflow.sessionChanged`; full rows via `workflow.findAllActive` only while open; open-conversation + stop actions |
| `Sider/SiderAccordion/SiderTeamsSection.tsx` | Outer "Teams" accordion subsuming `SiderActiveTeams` (Running) + `TeamSiderSection` (My teams); live badge = count of agents with `status === 'active'`; hidden when user has no teams |
| `Sider/SiderAccordion/SiderRecentChatsSection.tsx` | Labelled non-collapsible Recent Chats header + lazy `WorkspaceGroupedHistory`; count via `ipcBridge.database.getUserConversations` (500ms debounce, filters health-check/team/project convs) + `conversation.listChanged` |
| `Sider/TeamSiderSection.tsx` | Per-team groups with pin (localStorage `team-pinned-ids`, line 28), rename/delete modals, active slot (`team-active-slot-${teamId}`, line 152), drag order |
| `Sider/ActiveTeamGroup.tsx` | Expand/collapse group per team inside TeamSiderSection |
| `Sider/DeleteTeamConfirmModal.tsx` | Arco Modal confirming team deletion |
| `Sider/siderOrder.ts` | Pure helpers: read/write/reconcile/sort/reorder stored order arrays (localStorage JSON string[]), group-aware, uses `@dnd-kit` `arrayMove` |
| `Sider/useStoredSiderOrder.ts` | Hook packaging siderOrder + `@dnd-kit` PointerSensor (8px activation) + `handleDragEnd`; persists on every change |
| `Sider/SortableSiderEntry.tsx` | `useSortable` wrapper div (opacity 0.45 while dragging) |
| `Sider/CronJobSiderSection/CronJobSiderSection.tsx` | Legacy (pre-accordion) cron section; auto-expand logic; batch conv fetch to avoid N+1 IPC |
| `Sider/CronJobSiderSection/CronJobSiderItem.tsx` | Single cron row: status dot, next-run, context actions (399 lines) |
| `Sider/SiderFooter.tsx` | Footer: Settings/back toggle (navigates `/settings/models` or last non-settings path), web-only logout, theme toggle (settings mode only), quick actions row |
| `Sider/SiderFooter/SiderFooterQuickActions.tsx` | Bug/Feedback · WebUI status (via `webui.getStatus` + subscribe) · GitHub link (`https://github.com/sergei10a-rgb/darhai`, line 26) |
| `src/renderer/styles/layout.css` | `.layout-sider` flex column fixes over Arco internals; chat-history/settings-sider collapse transitions; `prefers-reduced-motion` opt-outs |
| `src/renderer/styles/arco-override.css` | Typography system: `--forge-font` (Sora → Inter fallback) / `--forge-mono-font` (IBM Plex Mono); overrides `--arco-font-family`; misc non-theme Arco fixes |
| `src/renderer/styles/themes/index.css` | Imports `base.css` + `default-color-scheme.css` |
| `src/renderer/styles/themes/base.css` | Theme-independent: `--app-min-width: 360px`, `--titlebar-height: 36px`; binds `html,body { color: var(--color-text-1) }`; `.collapsed-hidden` behavior; keyframes |
| `src/renderer/styles/themes/default-color-scheme.css` | THE token source: brand orange `#ff6b35` both modes; overrides Arco `--primary-N`/`--arcoblue-N` RGB triples at root; strict spacing (`--space-1..9`), radius, type, motion scales; light = `:root`, dark = `[data-theme='dark']` |
| `src/renderer/styles/colors.ts` | TS-side color constants: `cssVars` map, `iconColors` (lines 105–113, used by SiderFooter), `diffColors`, `colorMapping` hex→var migration table |
| `src/renderer/styles/MIGRATION.md` | Color migration guide: prefer UnoCSS atomic classes → CSS vars, hex mapping table |
| `uno.config.ts` | UnoCSS: presetMini + presetExtra + presetWind3; semantic color theme (`t-primary`, `bg-1..10`, `aou-1..10`, brand); custom rules mapping Arco vars (`text-1..4`, `bg-fill-1..4`, `border-arco-1..4`, `bg-{color}-light-N`, `(bg|text|border)-{color}-1..9` → `rgb(var(--{color}-N))`); `flex-center` shortcut; RegExp content pipeline (glob strings break under electron-vite renderer root, comment lines 93–98) |
| `src/renderer/hooks/context/LayoutContext.tsx` | `{ isMobile, siderCollapsed, setSiderCollapsed }` — provided by Layout, consumed by Titlebar/Sider/PageShell |
| `src/renderer/hooks/context/NavigationHistoryContext.tsx` | In-app back/forward stack (MAX 50) driving Titlebar history buttons |
| `src/renderer/utils/ui/siderTooltip.ts` | `getSiderTooltipProps(enabled)` — canonical Tooltip prop bundle (popup container = `.layout-sider`, disabled on touch); `cleanupSiderTooltips()` removes detached Arco popups |

## Contracts & data flow

**Routes (Router.tsx, lines 102–195).** Active destinations: `/login`, `/guid`, `/conversation/:id`, `/conversations`, `/projects`, `/project/:projectId`, `/memory`, `/wiki`, `/wiki/:slug`, `/assistants`, `/workflows`, `/scheduled`, `/scheduled/:jobId`, `/mission-control`, `/model-advisor`, `/teams`, `/teams/new`, `/teams/:teamId/launch`, `/team/:id` (gated by `TEAM_MODE_ENABLED` from `src/common/config/constants`), `/test/components`, and `~25` `/settings/*` panes incl. `/settings/ijfw`, `/settings/ecc`, `/settings/ext/:tabId` (extension pages). Legacy redirects are declared inline (e.g. `/settings/providers→models` line 120, `/settings/mcp→mcp-library/installed` line 135). `/teams*` (launcher library) vs `/team/:id` (legacy multi-user mode) are intentionally distinct — comment lines 179–184.

**IPC bridge usage in this area** (all through `ipcBridge` from `@/common` = `src/common/adapter/ipcBridge`):
- `application.openDevTools` (Layout.tsx:41, 4-click logo debug), `application.logStream.on` (Layout.tsx:337 — main-process log mirror to DevTools console)
- `task.stopAll` (Layout.tsx:374, tray "pause all")
- `conversation.get` (Titlebar:228, CronJobSiderSection:50), `team.get` (Titlebar:203)
- `windowControls.isMaximized/minimize/maximize/unmaximize/close` + `maximizedChanged.on` (WindowControls.tsx:32–79)
- `wiki.getState` + `wiki.stateChanged.on` (SiderMemoryEntry:49–59)
- `workflow.countActive`, `workflow.findAllActive`, `workflow.sessionChanged.on` (SiderWorkflowsSection:59–100)
- `database.getUserConversations` + `conversation.listChanged.on` (SiderRecentChatsSection:36–63)
- `webui.getStatus` (SiderFooterQuickActions:51)
- Raw `window.electronAPI.onboardingFluxMetrics()` (SiderFluxRouterEntry:122 — one of the few non-ipcBridge escapes)

**window CustomEvents** (renderer-internal buses):
- Tray → Layout: `tray:navigate-to-guid`, `tray:navigate-to-conversation`, `tray:open-about`, `tray:pause-all-tasks`, `tray:check-update` (Layout.tsx:393–397); Layout → UpdateModal: `wayland-open-update-modal` (Layout.tsx:388)
- Theme CSS sync: `custom-css-updated` (Layout.tsx:218/243) + `storage` events on keys containing `customCss`/`css.activeThemeId`
- Accordion sibling sync: `wayland:sider-accordion-changed` (useSiderAccordionState.ts:17)
- Workspace panel: `WORKSPACE_STATE_EVENT` / `dispatchWorkspaceToggleEvent` from `utils/workspace/workspaceEvents` (Titlebar:19)

**localStorage keys owned here**: `__wayland_theme`, `__wayland_colorScheme` (index.html:25–26; written by `hooks/system/useTheme.ts` as `__wayland_theme_preference` cache line 23 and `hooks/ui/useColorScheme.ts` line 15), `wayland.sidebar.tools.expanded` (SiderToolsGroup:14), `sider.accordion.state.v1` (useSiderAccordionState:12), `wayland.sider.teamGroups` (useTeamGroupPersistence:9), `team-pinned-ids` (TeamSiderSection:28), `team-active-slot-${teamId}` (TeamSiderSection:152), caller-supplied `storageKey` string[] JSON via `siderOrder.ts`. sessionStorage: `aion:last-non-settings-path` (Titlebar:175).

**ConfigStorage keys** (main-process storage via `@/common/config/storage`): `customCss`, `css.activeThemeId`, `css.themes` (Layout.tsx:178–180, heal/persist at 203–211), `guid.lastSelectedAgent` (Layout.tsx:140, palette preset launch), `theme` (useTheme.ts:63/118).

**Env vars**: `VITE_SENTRY_DSN` (main.tsx:13) — only renderer-visible env consumed here.

**Theming contract**: `data-theme` attr on `<html>` + `arco-theme` attr on `<body>` (useTheme.ts:41–42); all colors resolve through CSS vars defined in `styles/themes/default-color-scheme.css`; UnoCSS classes are thin var wrappers (uno.config.ts). User custom CSS is injected as `<style id="user-defined-custom-css">` kept last in `<head>` via MutationObserver (Layout.tsx:258–304).

## Conventions & invariants

- **Arco only for interactive controls** (AGENTS.md): no raw `<button>/<input>` except in Titlebar/WindowControls where `app-titlebar__button` native buttons are the established exception for frameless-window chrome. Icons come from `lucide-react` in this area (AGENTS.md says `@icon-park/react`; the shell has standardized on lucide — follow the file you're touching).
- **Sider nav row template** (copy `SiderNav/SiderSessionsEntry.tsx`): two render branches — collapsed (icon-only, `w-full h-40px flex-center rd-8px`) and expanded (`h-40px px-10px gap-8px rd-0.5rem`, 28px icon slot, `collapsed-hidden` label span); active style is exactly `bg-[rgba(var(--primary-6),0.12)] text-primary`, idle hover `hover:bg-fill-3 active:bg-fill-4`; wrap in `<Tooltip {...siderTooltipProps} position='right'>`; add `data-testid='sider-<name>-entry'`.
- **Nav handlers live in `Sider/index.tsx`, not in entries** — entries receive `onClick`/`isActive` props (SiderToolsGroup doc comment lines 20–24 states this explicitly). Every handler runs the sequence `cleanupSiderTooltips(); blurActiveElement(); closePreview(); setIsBatchMode(false); navigate(...); onSessionClick?.()` (index.tsx:112–126).
- **Route activity** is computed in `Sider/index.tsx` from `pathname.startsWith(...)`; when adding a Tools-group entry also extend `isToolsChildActive` (index.tsx:176–182).
- **Accordion primitives are `@api-frozen`** (`SiderAccordionShell.tsx`, `useSiderAccordionState.ts`): do not change props/schema; add a new accordion by adding a key to the `AccordionKey` union and a new section component.
- **Badges**: IPC-fetch-on-mount + `cancelled`/`alive` guard + event subscription + debounce (300–500ms) — SiderMemoryEntry and SiderWorkflowsSection are the reference implementations; count-only providers preferred over full list fetches while closed.
- **Hide-when-empty** (v0.6.2.1): runtime accordions render `null` when they have nothing live (SiderScheduledSection:44, SiderTeamsSection comment); the TopZone entry remains the discover/create path.
- **Styling**: UnoCSS atomic classes with semantic tokens first; component-scoped `*.module.css` for anything complex; Arco overrides via `:global()` inside the module, never new global files; zero hardcoded hex (use `var(--…)` fallback pairs like `var(--orange, #FF7A45)` only for defensive fallbacks). Spacing/radius must land on the strict scales in `default-color-scheme.css`.
- **All user-facing strings via `t('…')`** with i18n keys in `locales/` modules (see `sider.*`, `conversations.siderEntry` etc.); `defaultValue` allowed as inline fallback.
- **Motion**: compositor-only transforms with `prefers-reduced-motion` opt-out (Sider.module.css:20–28, layout.css:108–120).
- **Lazy-load every route page** through `React.lazy` + `withRouteFallback`; keep dead-but-referenced chunks alive with `void Component;` (Router.tsx:206–209).
- **Directory limit**: ≤10 direct children per directory (AGENTS.md) — this is why SiderNav/SiderAccordion/SiderFooter/CronJobSiderSection are subdirectories.

## Assimilation anchors

1. **New sidebar page (the standard recipe)** — (a) page module under `src/renderer/pages/<feature>/`; (b) lazy import + `<Route>` in `components/layout/Router.tsx` (mirror `MemoryPage`, lines 53 + 191); (c) nav entry `components/layout/Sider/SiderNav/Sider<Feature>Entry.tsx` cloned from `SiderSessionsEntry.tsx` (or `SiderMemoryEntry.tsx` if it needs a live badge), exported from `SiderNav/index.ts`; (d) wire in `Sider/index.tsx` topZone or inside `SiderToolsGroup` + extend `isToolsChildActive`; (e) i18n key `sider.<feature>` in locales. This is the path for an ECC dashboard, Superpowers skill browser, or Odysseus panel.
2. **New settings pane** — add route `/settings/<name>` in Router.tsx mirroring `EccSettingsPanel`/`IjfwSettingsPanel` (lines 57–58, 151–152) and register it in `pages/settings/components/SettingsSider` (lazy-swapped in by `Sider/index.tsx:32,197`). ECC/IJFW already have panes here — new assimilated toolchains should follow the same pair.
3. **New live-status sidebar widget** — imitate `SiderNav/SiderFluxRouterEntry.tsx`: state machine resolved from detection + metrics, renders `null` when idle, pulse-dot tones from semantic tokens. Right shape for e.g. an ECC harness/daemon status or IJFW memory-health widget.
4. **New runtime accordion (live activity list)** — imitate `SiderAccordion/SiderWorkflowsSection.tsx`: add key to `AccordionKey` in `useSiderAccordionState.ts`, build section on `SiderAccordionShell`, badge from a cheap `countActive`-style IPC provider + change event, full rows fetched only while open, mount in `Sider/index.tsx` scrollZone. Right shape for running Superpowers plans or ECC epic pipelines.
5. **New full-page library surface** — build on `components/layout/PageShell/PageShell.tsx` + `library/LibraryFilterRail` exactly as `pages/workflows/WorkflowsLibraryPage` does; `width='standard'`, filter rail optional. Right shape for a vendored-skills catalog or agent library.
6. **New page-level design tokens** — extend `styles/themes/default-color-scheme.css` (both `:root` and `[data-theme='dark']`) and, if a Uno class is wanted, add the var wrapper in `uno.config.ts` theme colors — never inline hex.
