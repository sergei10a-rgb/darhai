/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mechanical guard against untranslated, un-pluralised user-facing text.
 *
 * Two defects motivated this file, both found by looking at the running app:
 *
 *   1. MCP Library > Installed rendered `{server.toolCount ?? 0} tools` - a
 *      raw English suffix on an interpolated number. It was wrong in English
 *      too: at one tool it read "1 tools".
 *   2. Keys that DO interpolate `{{count}}` but carry no plural variant are the
 *      same bug one layer down. `scripts/check-i18n.js` cannot see either -
 *      it validates the keys that reach `t()`, not the text that never did.
 *
 * MEASURED, not assumed (i18next 26.2.0, `compatibilityJSON` unset => v4 JSON):
 *
 *   - `_one` / `_few` / `_many` / `_other` suffixes ARE resolved, via
 *     `Intl.PluralRules` for the active language.
 *   - A locale that lacks the suffix its own rule selects falls through to
 *     `fallbackLng` - i.e. silently back to English.
 *   - A plain `defaultValue` string does NOT pluralise; only
 *     `defaultValue_one` / `defaultValue_other` do.
 *   - A base key alongside the suffixed ones is inert while `count` is passed
 *     (the suffix wins) and is kept so check-i18n's literal-key scan resolves.
 *   - `workflows.count` (only `count_other` exists) renders the literal string
 *     "workflows.count" at count 1 today. That is what an incomplete set costs.
 *
 * Baselines below are RATCHETS: they list what already existed when the guard
 * was written, itemised rather than wildcarded. Fixing an entry never fails the
 * test; adding one does.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { listRendererTsx, scanRenderer, type TextFinding } from '../helpers/rendererTextScan';

const REPO_ROOT = path.resolve(__dirname, '../..');
const LOCALES_DIR = path.join(REPO_ROOT, 'src/renderer/services/i18n/locales');
const I18N_CONFIG = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'src/common/config/i18n-config.json'), 'utf-8')
) as { supportedLanguages: string[]; referenceLanguage: string; modules: string[] };

const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

/**
 * English text already painted outside `t()` when this guard landed, as
 * [text, how many places render it]. Keyed on the text rather than on
 * file:line so that moving or reformatting a file cannot turn the baseline red
 * on its own - only genuinely new English can.
 */

/** The `{n} noun` shape: an interpolated value with an English suffix. */
const KNOWN_COUNT_LABELS: ReadonlyArray<readonly [string, number]> = [
  ['/100 - auto-promotes at', 1], // pages/memory/components/Inspector.tsx
  ['categories →', 1], // pages/settings/SkillsSettings/FilterRail.tsx
  ['of', 1], // pages/memory/components/RightDrawer.tsx
  ['sources &middot;', 1], // pages/wiki/components/KnowledgeGraph.tsx
  ['steps', 1], // pages/guid/components/workflow/WorkflowLaunchOverlay.tsx
  ['· line', 1], // pages/memory/components/Inspector.tsx
  ['× this week', 1], // pages/memory/components/Inspector.tsx
];

/** Any other English JSX text node. */
const KNOWN_ENGLISH_TEXT: ReadonlyArray<readonly [string, number]> = [
  ['Agent is writing…', 1], // pages/conversation/Preview/components/editors/TipTapMarkdownEditor.tsx
  ['Asia Pacific (Singapore)', 2], // pages/settings/components/AddPlatformModal.tsx, pages/settings/components/EditModeModal.tsx
  ['Asia Pacific (Sydney)', 2], // pages/settings/components/AddPlatformModal.tsx, pages/settings/components/EditModeModal.tsx
  ['Asia Pacific (Tokyo)', 2], // pages/settings/components/AddPlatformModal.tsx, pages/settings/components/EditModeModal.tsx
  ['Blue Tag', 1], // pages/TestShowcase.tsx
  ['Body loaded', 1], // pages/guid/components/workflow/WorkflowLaunchOverlay.tsx
  ['Button', 1], // pages/TestShowcase.tsx
  ['Canada (Central)', 2], // pages/settings/components/AddPlatformModal.tsx, pages/settings/components/EditModeModal.tsx
  ['Cancel', 1], // pages/TestShowcase.tsx
  ['Channels', 1], // components/settings/SettingsModal/contents/WebuiModalContent.tsx
  ['Checking IJFW status…', 1], // pages/memory/MemoryPage.tsx
  ['ClawHub integration is not yet available.', 1], // pages/settings/SkillsSettings/ImportModal.tsx
  ['Clear filters', 1], // pages/memory/components/MemoryList.tsx
  ['Collapse - Accordion Panel', 1], // pages/TestShowcase.tsx
  ['Composing directive', 1], // pages/guid/components/workflow/WorkflowLaunchOverlay.tsx
  ['Confirm', 1], // pages/TestShowcase.tsx
  ['Continue with Google', 1], // pages/settings/ModelsSettings/components/EmptyState.tsx
  ['Copy', 1], // pages/memory/components/Inspector.tsx
  ['Core', 1], // pages/settings/WCoreConfig/index.tsx
  ["Couldn't read source:", 1], // pages/memory/components/RightDrawer.tsx
  ['Custom styles: no border, border-radius 8px.', 1], // pages/TestShowcase.tsx
  ['Darhai Core', 7], // pages/settings/WCoreConfig/panes/MemoryPane.tsx, pages/settings/WCoreConfig/panes/ProfilesPane.tsx, pages/settings/WCoreConfig/panes/RuntimePane.tsx, pages/settings/WCoreConfig/panes/SecurityPane.tsx, pages/settings/WCoreConfig/panes/ServicesKeysPane.tsx, pages/settings/WCoreConfig/panes/ToolsPane.tsx, pages/settings/WCoreSettings.tsx
  ['Data:', 1], // pages/conversation/Messages/codex/ToolCallComponent/GenericDisplay.tsx
  ['Default Button', 1], // pages/TestShowcase.tsx
  ['Displays all component styles customized in arco-override.css', 1], // pages/TestShowcase.tsx
  [
    'Enabling WebUI remote access (LAN) alone is usually not sufficient for WeCom callbacks. WeCom servers require a publicly accessible HTTPS address.',
    1,
  ], // components/settings/SettingsModal/contents/channels/ChannelModalContent.tsx
  ['Enter select', 1], // pages/memory/components/Inspector.tsx
  ['Error Message', 1], // pages/TestShowcase.tsx
  ['Esc', 4], // components/cmdk/CommandPalette.tsx, components/settings/shared/CommandPalette/CommandPalette.tsx, components/settings/shared/ShortcutsOverlay/ShortcutsOverlay.tsx, pages/memory/components/MemoryStatusBar.tsx
  ['Esc close', 1], // pages/memory/components/Inspector.tsx
  ['Europe (Frankfurt)', 2], // pages/settings/components/AddPlatformModal.tsx, pages/settings/components/EditModeModal.tsx
  ['Europe (Ireland)', 2], // pages/settings/components/AddPlatformModal.tsx, pages/settings/components/EditModeModal.tsx
  ['Features: border-radius 12px, custom close button, theme background color.', 1], // pages/TestShowcase.tsx
  ['Fetching workflow body', 1], // pages/guid/components/workflow/WorkflowLaunchOverlay.tsx
  ['File(', 1], // pages/guid/components/GuidActionRow.tsx
  ['Gray Tag', 1], // pages/TestShowcase.tsx
  ['Green Tag', 1], // pages/TestShowcase.tsx
  ['How to apply', 1], // pages/memory/components/Inspector.tsx
  ['Info Message', 1], // pages/TestShowcase.tsx
  ['Input', 1], // pages/conversation/Messages/components/tools/MessageToolGroupSummary.tsx
  ['LAN Callback URL:', 1], // components/settings/SettingsModal/contents/channels/ChannelModalContent.tsx
  ['Last touched', 1], // pages/guid/components/workflow/WorkflowResumePrompt.tsx
  ['Loading source…', 1], // pages/memory/components/RightDrawer.tsx
  ['Loading…', 3], // components/settings/SettingsModal/contents/ExtensionSettingsTabContent.tsx, pages/settings/ExtensionSettingsPage.tsx
  ['Local Callback URL:', 1], // components/settings/SettingsModal/contents/channels/ChannelModalContent.tsx
  ['Message - Notification', 1], // pages/TestShowcase.tsx
  ['Modal - Dialog', 1], // pages/TestShowcase.tsx
  ['Next', 1], // pages/TestShowcase.tsx
  ['No "How to apply" recorded', 1], // pages/memory/components/Inspector.tsx
  ['No "Why" recorded', 1], // pages/memory/components/Inspector.tsx
  ['No concepts link to this page yet.', 1], // pages/wiki/WikiDetailPage.tsx
  ['No matches. Try removing a filter or clearing the search.', 1], // pages/memory/components/MemoryList.tsx
  ['No providers connected yet. Connect one above - the fastest start is', 1], // pages/settings/ModelsSettings/components/EmptyState.tsx
  ['None', 1], // components/settings/SettingsModal/contents/channels/integration/IrcConfigForm.tsx
  ['Open Custom Modal', 1], // pages/TestShowcase.tsx
  ['Open file', 1], // pages/memory/components/Inspector.tsx
  ['Orange Tag', 1], // pages/TestShowcase.tsx
  ['Outline Button', 1], // pages/TestShowcase.tsx
  ['Output', 1], // pages/conversation/Messages/components/tools/MessageToolGroupSummary.tsx
  ['PASTE', 1], // pages/conversation/Workspace/index.tsx
  ['PLAIN', 1], // components/settings/SettingsModal/contents/channels/integration/IrcConfigForm.tsx
  ['Parsing', 1], // pages/guid/components/workflow/WorkflowLaunchOverlay.tsx
  ['Pending', 1], // pages/settings/AssistantSettings/AssistantEditDrawer.tsx
  ['Preparing workflow…', 1], // pages/guid/components/workflow/WorkflowLaunchOverlay.tsx
  ['Previous', 1], // pages/TestShowcase.tsx
  ['Primary Button', 1], // pages/TestShowcase.tsx
  ['Promotion score', 1], // pages/memory/components/Inspector.tsx
  ['Public Callback URL (configured value):', 1], // components/settings/SettingsModal/contents/channels/ChannelModalContent.tsx
  ['Ready when you are →', 1], // pages/guid/components/workflow/WorkflowLaunchOverlay.tsx
  ['Recommended: use a reverse proxy with a TLS certificate, or expose via Cloudflare Tunnel / ngrok.', 1], // components/settings/SettingsModal/contents/channels/ChannelModalContent.tsx
  ['Red Tag', 1], // pages/TestShowcase.tsx
  ['Reload this view', 1], // components/ErrorBoundary.tsx
  ['Resume', 1], // pages/guid/components/workflow/WorkflowResumePrompt.tsx
  ['Resume from Step', 1], // pages/guid/components/workflow/WorkflowResumePrompt.tsx
  ['Round Button', 1], // pages/TestShowcase.tsx
  ['Security', 1], // pages/settings/SkillsSettings/SkillDetailDrawer.tsx
  ['Select a memory to inspect it', 1], // pages/memory/components/Inspector.tsx
  ['Show All Types', 1], // pages/TestShowcase.tsx
  ['Show all', 1], // pages/settings/SkillsSettings/FilterRail.tsx
  ['Showing lines', 1], // pages/memory/components/RightDrawer.tsx
  ['Something went wrong', 1], // components/ErrorBoundary.tsx
  ['Source file:', 1], // pages/wiki/WikiDetailPage.tsx
  ['Start fresh', 1], // pages/guid/components/workflow/WorkflowResumePrompt.tsx
  ['Steps - Step Indicator', 1], // pages/TestShowcase.tsx
  ['Steps detected', 1], // pages/guid/components/workflow/WorkflowLaunchOverlay.tsx
  ['Success Message', 1], // pages/TestShowcase.tsx
  ['Summary', 1], // pages/memory/components/Inspector.tsx
  ['Tag - Labels (Dark Mode Optimized)', 1], // pages/TestShowcase.tsx
  ['Tags', 1], // pages/memory/components/Inspector.tsx
  ['This is a custom modal wrapped using ModalWrapper.', 1], // pages/TestShowcase.tsx
  ['This is the content area of the collapse panel. Any content can be placed here.', 1], // pages/TestShowcase.tsx
  ['Tip: Switch to dark mode to see the optimized appearance', 1], // pages/TestShowcase.tsx
  ['Tool Call ID:', 3], // pages/conversation/Messages/acp/MessageAcpToolCall.tsx, pages/conversation/Messages/codex/ToolCallComponent/BaseToolCallDisplay.tsx, pages/conversation/Messages/codex/ToolCallComponent/GenericDisplay.tsx
  ['US East (N. Virginia)', 2], // pages/settings/components/AddPlatformModal.tsx, pages/settings/components/EditModeModal.tsx
  ['US West (Oregon)', 2], // pages/settings/components/AddPlatformModal.tsx, pages/settings/components/EditModeModal.tsx
  ['Use in the wild', 1], // pages/memory/components/Inspector.tsx
  ['Used', 1], // pages/memory/components/Inspector.tsx
  ['Warning Message', 1], // pages/TestShowcase.tsx
  ['WeCom Callback URL Instructions', 1], // components/settings/SettingsModal/contents/channels/ChannelModalContent.tsx
  ['WebUI', 1], // components/settings/SettingsModal/contents/WebuiModalContent.tsx
  ['Why', 1], // pages/memory/components/Inspector.tsx
  ['Workflow active', 1], // pages/guid/components/workflow/WorkflowLaunchOverlay.tsx
  ['Yes', 1], // pages/guid/components/workflow/AskCard.tsx
  ['base', 1], // components/settings/SettingsModal/contents/ToolsModalContent.tsx
  ['chrome-devtools', 1], // components/settings/SettingsModal/contents/SystemModalContent/DevSettings.tsx
  ['ext', 3], // pages/conversation/components/navigation/ConversationTabs.tsx, pages/guid/GuidPage.tsx, pages/settings/AssistantSettings/AssistantEditDrawer.tsx
  ['http://127.0.0.1:', 1], // components/settings/SettingsModal/contents/SystemModalContent/DevSettings.tsx
  ['npx -y @ijfw/install@latest', 1], // pages/settings/IjfwSettingsPanel.tsx
  ['playwright', 1], // components/settings/SettingsModal/contents/SystemModalContent/DevSettings.tsx
  ['side-by-side', 3], // components/media/Diff2Html.tsx, pages/conversation/Preview/components/viewers/text/DiffViewer.tsx
  ['small', 1], // components/settings/SettingsModal/contents/ToolsModalContent.tsx
  ['↑/↓ navigate', 1], // pages/memory/components/Inspector.tsx
  ['📄 Read source ·', 1], // pages/memory/components/RightDrawer.tsx
  ['📥 Drop to ingest', 1], // pages/memory/state-branches/FullPanelShell.tsx
];

/**
 * Plural key sets that predate this guard and do not cover every category
 * their locale can select. Each one is a live defect: at the missing category
 * i18next falls back to English, or - when no locale has the form - echoes the
 * raw key. Listed so they are visible, not so they are forgiven.
 */
const KNOWN_INCOMPLETE_PLURALS: ReadonlySet<string> = new Set([
  'memory.archive.banner.review_btn',
  'missionControl.meta.blockedBy',
  'models.toast.newModels',
  'onboarding.chips.ollama',
  'projects.knowledge.fileAdded',
  'skills.import.scan.finding',
  'workflows.count',
]);

/**
 * Reference-locale strings that interpolate `{{count}}` without a plural
 * variant. Every one of them reads wrong at count 1 in at least one supported
 * language. New keys must not join this list.
 */
const KNOWN_UNPLURALISED_COUNT_KEYS: ReadonlySet<string> = new Set([
  'agent.setup.alternativesFound',
  'assistants.totalCount',
  'calendar.footer.count',
  'calendar.month.more',
  'common.viewMoreLines',
  'compare.footer.count',
  'conversation.commandQueue.files',
  'conversation.history.batchDeleteConfirm',
  'conversation.history.batchDeleteSuccess',
  'conversation.history.batchExportConfirm',
  'conversation.history.exportDialogBatchDescription',
  'conversation.history.selectedCount',
  'conversation.minimap.count',
  'conversation.workspace.changes.deletions',
  'conversation.workspace.changes.insertions',
  'conversation.workspace.changes.summary',
  'conversation.workspace.pasteConfirm_multipleFiles',
  'cron.error.conversationBusy',
  'cron.taskCount',
  'documents.footer.count',
  'mcp.confirm.queued',
  'mcp.daysAgo',
  'mcp.hoursAgo',
  'mcp.minutesAgo',
  'memory.archive.banner.candidates_ready',
  'memory.archive.composer.charCount',
  'memory.archive.filters.candidates_subline',
  'memory.archive.import.claudeMem.count',
  'memory.archive.import.claudeMem.success',
  'memory.archive.import.devScan.count',
  'memory.archive.import.devScan.success',
  'memory.archive.import.dropFolder.count',
  'memory.archive.import.dropFolder.success',
  'memory.archive.import.obsidian.count',
  'memory.archive.import.obsidian.success',
  'memory.archive.inspector.derefs_subtitle',
  'memory.archive.list.chip_count',
  'memory.archive.row.used_pill',
  'memory.archive.stats.delta_today',
  'memory.archive.stats.delta_week',
  'memory.archive.statusbar.cli_count',
  'memory.archive.threshold_modal.live_preview',
  'memory.wiki.concept.synthesizedFrom',
  'memory.wiki.detail.hiddenSourcesOne',
  'memory.wiki.detail.hiddenSourcesOther',
  'memory.wiki.detail.showAll',
  'memory.wiki.detail.statusTotalConcepts',
  'memory.wiki.detail.synthesizedFromMem',
  'memory.wiki.home.conceptCount',
  'memory.wiki.home.status.concepts',
  'memory.wiki.home.status.memoriesSynthesized',
  'memory.wiki.orphan.projects',
  'memory.wiki.orphan.projectsSingular',
  'memory.wiki.orphan.references',
  'messages.availableCommands',
  'messages.fileChangesCount',
  'missionControl.tabs.goalsWithCount',
  'modelAdvisor.hardware.cores',
  'models.toast.andMore',
  'notes.footer.count',
  'onboarding.flow.chips.ollama',
  'preview.excel.sheetCount',
  'preview.largeTextTruncatedHint',
  'projects.card.chatCount',
  'projects.knowledge.fileAddedPartial',
  'research.footer.count',
  'research.meta.rounds',
  'research.meta.sources',
  'research.settings.roundsCount',
  'settings.addModelMoreCount',
  'settings.agentsPage.moreDetected',
  'settings.mcpImportedSuccess',
  'settings.mcpRemoveStarted',
  'settings.mcpSyncStarted',
  'settings.mcpToolsLoaded',
  'settings.modelsPage.homePicker.searchMatches',
  'settings.modelsPage.homePicker.useCountBadge',
  'settings.modelsPage.manage.contextWindow',
  'settings.modelsPage.manage.statusLine',
  'settings.modelsPage.row.modelCount',
  'settings.omnirouteGateway.testOk',
  'settings.skillsHub.importAllSuccess',
  'settings.skillsHub.recommendSuccess',
  'settings.skippedCount',
  'settings.storagePage.sync.itemsCount',
  'settings.wcoreConfig.memory.tokensVal',
  'settings.wcoreConfig.overview.inheritMcpDetail',
  'settings.wcoreConfig.profiles.skillsChip',
  'settings.wcoreConfig.profiles.toolsChip',
  'settings.wcoreConfig.runtime.agentsVal',
  'settings.wcoreConfig.runtime.diagnostics.otherEngines',
  'settings.wcoreConfig.runtime.diagnostics.toolCount',
  'settings.wcoreConfig.runtime.diagnostics.unreadableTitle',
  'settings.webui.activityLog.viewAll',
  'sider.accordion.showMore',
  'sider.emergingConcepts',
  'skills.scan.done',
  'skills.search.resultsCount',
  'teams.card.rolesCount',
  'teams.group.standingHint',
  'teams.group.teamsHint',
  'teams.totalCount',
  'workflow.header.skillCount',
]);

/** Flatten a locale module into dotted keys. */
function flatten(node: unknown, prefix: string, out: Record<string, string>): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const full = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') out[full] = value;
    else flatten(value, full, out);
  }
}

function loadModule(lang: string, moduleName: string): Record<string, string> | null {
  const file = path.join(LOCALES_DIR, lang, `${moduleName}.json`);
  if (!fs.existsSync(file)) return null;
  const flat: Record<string, string> = {};
  flatten(JSON.parse(fs.readFileSync(file, 'utf-8')), '', flat);
  return flat;
}

/** Findings grouped by their text, so the ratchet compares like with like. */
function tally(findings: TextFinding[]): Map<string, TextFinding[]> {
  const byText = new Map<string, TextFinding[]>();
  for (const finding of findings) {
    const bucket = byText.get(finding.text);
    if (bucket === undefined) byText.set(finding.text, [finding]);
    else bucket.push(finding);
  }
  return byText;
}

/**
 * Every finding whose text appears more often than the baseline allows,
 * rendered as `file:line  "text"` so the failure names the place to fix.
 */
function regressions(findings: TextFinding[], allowed: ReadonlyArray<readonly [string, number]>): string[] {
  const budget = new Map(allowed);
  const out: string[] = [];
  for (const [text, group] of tally(findings)) {
    const permitted = budget.get(text) ?? 0;
    for (const finding of group.slice(permitted)) {
      out.push(`${finding.file}:${finding.line}  ${JSON.stringify(finding.text)}`);
    }
  }
  return out.toSorted();
}

describe('renderer user-facing text', () => {
  const findings = scanRenderer(REPO_ROOT);

  it('scans the renderer tree it claims to cover', () => {
    // A walk that silently reached nothing would make every assertion below
    // pass on an empty set. 553 non-test .tsx files existed when this landed.
    const files = listRendererTsx(path.join(REPO_ROOT, 'src/renderer'), REPO_ROOT);
    expect(files.length).toBeGreaterThan(400);
  });

  it('adds no new English count label rendered outside t()', () => {
    const found = findings.filter((f) => f.kind === 'count-label');
    expect(regressions(found, KNOWN_COUNT_LABELS)).toEqual([]);
  });

  it('adds no new English JSX text rendered outside t()', () => {
    const found = findings.filter((f) => f.kind === 'text');
    expect(regressions(found, KNOWN_ENGLISH_TEXT)).toEqual([]);
  });

  it('renders the MCP Library entirely through t()', () => {
    // The page this guard was written for. It carries no baseline at all, so
    // any English literal reintroduced here fails immediately.
    const inMcpLibrary = findings.filter((f) => f.file.includes('pages/settings/McpLibrary/'));
    expect(inMcpLibrary.map((f) => `${f.file}:${f.line}  ${JSON.stringify(f.text)}`)).toEqual([]);
  });
});

describe('i18n plural coverage', () => {
  /** Every `base` in the reference locale that has at least one plural variant. */
  const pluralBases: Array<{ module: string; base: string }> = [];
  for (const moduleName of I18N_CONFIG.modules) {
    const flat = loadModule(I18N_CONFIG.referenceLanguage, moduleName);
    if (flat === null) continue;
    const bases = new Set<string>();
    for (const key of Object.keys(flat)) {
      const match = key.match(/^(.*)_(zero|one|two|few|many|other)$/);
      if (match !== null) bases.add(match[1]);
    }
    for (const base of bases) pluralBases.push({ module: moduleName, base });
  }

  it('finds the plural key sets it is meant to police', () => {
    // A scan that silently matched nothing would pass every assertion below.
    expect(pluralBases.length).toBeGreaterThan(10);
  });

  it('covers every plural category each locale can actually select', () => {
    const gaps: string[] = [];
    for (const { module: moduleName, base } of pluralBases) {
      if (KNOWN_INCOMPLETE_PLURALS.has(`${moduleName}.${base}`)) continue;
      for (const lang of I18N_CONFIG.supportedLanguages) {
        const flat = loadModule(lang, moduleName);
        if (flat === null) {
          gaps.push(`${lang}/${moduleName}.json is missing`);
          continue;
        }
        // The categories the language can select, straight from CLDR - not a
        // hand-written table that would drift from the runtime.
        for (const category of new Intl.PluralRules(lang).resolvedOptions().pluralCategories) {
          if (typeof flat[`${base}_${category}`] !== 'string') {
            gaps.push(`${lang}/${moduleName}.json: ${base}_${category} missing`);
          }
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it('pluralises every reference string that interpolates {{count}}', () => {
    const unpluralised: string[] = [];
    for (const moduleName of I18N_CONFIG.modules) {
      const flat = loadModule(I18N_CONFIG.referenceLanguage, moduleName);
      if (flat === null) continue;
      for (const [key, value] of Object.entries(flat)) {
        if (!/\{\{\s*count\s*\}\}/.test(value)) continue;
        if (PLURAL_SUFFIXES.some((suffix) => key.endsWith(`_${suffix}`))) continue;
        // A base key that has plural siblings is inert, not a defect.
        if (PLURAL_SUFFIXES.some((suffix) => typeof flat[`${key}_${suffix}`] === 'string')) continue;
        const dotted = `${moduleName}.${key}`;
        if (KNOWN_UNPLURALISED_COUNT_KEYS.has(dotted)) continue;
        unpluralised.push(dotted);
      }
    }
    expect(unpluralised.toSorted()).toEqual([]);
  });
});
