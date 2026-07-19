# 13 renderer-conversation

## Purpose

The conversation surface: everything under `src/renderer/pages/conversation/`. It renders a chat for all 7 conversation types (`acp`, `codex`, `gemini`, `wcore`, `openclaw-gateway`, `nanobot`, `remote`), streams agent output into a virtualized message list with per-type message cards, hosts the right-hand Workspace file tree, the multi-tab Preview panel (viewers + editors + HTML renderer), the sidebar workspace-grouped history, per-workspace conversation tabs, and the (currently unmounted) SkillRuleGenerator. It is the single largest renderer area (189 files, ~35k lines) and the primary UI integration point for any new agent capability.

## Entry points & lifecycle

1. Route `/conversation/:id` (`src/renderer/components/layout/Router.tsx:106`) lazy-loads `src/renderer/pages/conversation/index.tsx`. That component: closes the Preview panel on conversation change (`index.tsx:21-31`), fetches the conversation via SWR key `` `conversation/${id}` `` → `ipcBridge.conversation.get.invoke` (`index.tsx:33-35`), re-mutates on `ipcBridge.conversation.listChanged` `updated` events (`index.tsx:40-47`), triggers auto-title sync when the title is still the localized default (`index.tsx:49-55`), registers the conversation as a tab via `ConversationTabsContext.openTab` (`index.tsx:58-62`), then renders `ChatConversation`.
2. `components/ChatConversation.tsx` dispatches on `conversation.type`: `wcore`/`gemini` get dedicated panel components owning model-selection state (`ChatConversation.tsx:436-451`); `acp`/`codex`/`openclaw-gateway`/`nanobot`/`remote` are built in a `useMemo` switch (`ChatConversation.tsx:323-403`; `codex` is legacy and reuses `AcpChat` with `backend='codex'`, line 343-363). If a `workflowSessionId` exists (router state or `conversation.extra.workflowSessionId`, lines 290-298) the chat node is wrapped in `WorkflowSurface` inside a `ChatLayout` with `hideHeader` (lines 455-540), and the workflow session subscription is hoisted once here (N+1 fix, lines 300-310).
3. Each platform `*Chat.tsx` wraps its subtree in `MessageListProvider` (HOC) + `ConversationProvider`, calls `useMessageLstCache(conversation_id)` to hydrate history from SQLite (`Messages/hooks.ts:376-441`, `database.getConversationMessages` with pageSize 10000, merging DB rows with already-streamed messages by `msg_id`/content length), and mounts `MessageList` + a `ConversationChatConfirm`-wrapped SendBox.
4. Streaming lifecycle: each platform's `use*Message` hook subscribes to its response stream (see contracts), transforms events via `transformMessage` from `@/common/chat/chatLib`, and funnels them through `useAddOrUpdateMessage` (`Messages/hooks.ts:299-363`) which batches via setTimeout and merges by `msg_id`/`callId`/`toolCallId` with a WeakMap index cache.
5. Two contexts are mounted app-wide in `main.tsx` (see codemap 12), not per-page: `PreviewProvider` and `ConversationTabsProvider` — both restore state from localStorage at construction.

## Key modules

### Root, utils, hooks

| File | Responsibility |
|---|---|
| `index.tsx` | Route component: SWR fetch, preview close-on-switch, auto-title, tab registration (see lifecycle) |
| `components/ChatConversation.tsx` | Per-type chat dispatcher + workflow wrapping + header assembly (skills indicator, cron manager, model selector, StarOffice card) |
| `utils/detectPlatform.ts` | `detectMobileViewportOrTouch`, `isMacEnvironment`, `isWindowsEnvironment` (UA/viewport probes) |
| `utils/createConversationParams.ts` | Builds `ICreateConversationParams` for CLI agents / preset assistants; resolves preferred mode+model from `ConfigStorage` (`acp.config`, `gemini.config`, `wcore.config`, `acp.cachedModels`, `model.config`); flux-auto default rule (lines 89-114) |
| `utils/conversationCache.ts` | `refreshConversationCache` — re-fetch conversation and `mutate` its SWR key |
| `utils/layoutCalc.ts` | Pure layout math + constants (`MIN_CHAT_RATIO 25`, `MIN_WORKSPACE_RATIO 12`, `MIN_CHAT_PANEL_PX 360`, `WORKSPACE_HEADER_HEIGHT 32`, lines 1-8) |
| `utils/newConversationName.ts` | `applyDefaultConversationName` — force localized default title on new sessions |
| `hooks/ConversationTabsContext.tsx` | Workspace-tab state provider; persists `{openTabs, activeTabId}` to localStorage `wayland_conversation_tabs` (`storageKeys.ts:23`, effect lines 82-94); only conversations with `extra.customWorkspace` become tabs (lines 100-110); auto-close on `conversation.deleted` emitter event (229-233) |
| `hooks/useConversationAgents.ts` | Lists available CLI agents + preset assistants (incl. `ipcBridge.extensions.getAssistants`) for the tab-strip "+" menu |
| `hooks/useContainerWidth.ts` | ResizeObserver container-width tracker |
| `hooks/useLayoutConstraints.ts` | Clamps workspace/chat-preview split ratios so all panels stay ≥ min px |
| `hooks/usePreviewAutoCollapse.ts` | Auto-collapses left sider + workspace when preview opens; restores after |
| `hooks/useTitleRename.ts` | Inline title edit state; default path `ipcBridge.conversation.update` (line 72) + `updateTabName`, overridable via `onRenameTitle` |
| `hooks/useWorkspaceCollapse.ts` | Right workspace panel collapse: localStorage `STORAGE_KEYS.WORKSPACE_PANEL_COLLAPSE` + per-conv `workspace-preference-${convId}` + `WORKSPACE_TOGGLE_EVENT`/`WORKSPACE_HAS_FILES_EVENT` DOM events |

### Chat chrome (`components/`)

| File | Responsibility |
|---|---|
| `components/ChatLayout/index.tsx` | 3-panel layout engine: header (title editor / minimap / AgentBadge / headerExtra), chat, Preview panel, workspace sider; two `useResizableSplit` instances with storage keys `chat-workspace-split-ratio` (line 128) and `chat-preview-split-ratio` (line 151); `hideHeader` for workflow chrome (line 62) |
| `components/ChatLayout/chat-layout.css` | Header glass style, right-sider, mobile-unified header classes |
| `components/ChatLayout/WorkspacePanelHeader.tsx` | Workspace panel header + `DesktopWorkspaceToggle` expand button |
| `components/ChatLayout/MobileWorkspaceOverlay.tsx` | Mobile: backdrop + fixed workspace panel + floating collapse handle |
| `components/ChatLayout/WorkspaceOpenButton.tsx` | "Open workspace in…" (VS Code/Terminal/Explorer) via `ipcBridge.shell.*`; preference in localStorage `workspace-open-preference` |
| `components/ChatSider.tsx` | Chooses `ChatWorkspace` per type with `eventPrefix` (`acp`/`codex`/`wcore`; gemini default) — only types with `extra.workspace` |
| `components/ChatTitleEditor.tsx` | Presentational inline title editor (state from `useTitleRename`) |
| `components/ConversationChatConfirm.tsx` | Tool-permission banners above the sendbox; loads via `conversation.confirmation.list`, subscribes `add`/`update`/`remove`, answers via `conversation.confirmation.confirm` (line 54); auto-confirm via `conversation.approval.check` for gemini/wcore (lines 34-49) |
| `components/ConversationSkillsIndicator.tsx` | Badge listing `conversation.extra.loadedSkills`; navigates to skill library |
| `components/AddSkillToChatButton.tsx` | Skill picker popover → `ipcBridge.skills.addToConversation` |
| `components/ConversationTabs.tsx` | Workspace tab strip: switch/close/context menus, "+" new conversation via `buildCliAgentParams`/`buildPresetAssistantParams` + `conversation.createWithConversation` |
| `components/ConversationTitleMinimap/index.tsx` | Header minimap trigger + panel (message outline + in-conversation search) |
| `components/ConversationTitleMinimap/useMinimapPanel.ts` | Minimap state: item extraction, search, keyboard nav, jump dispatch (`CHAT_MESSAGE_JUMP_EVENT`) |
| `components/ConversationTitleMinimap/minimapTypes.ts` / `minimapUtils.ts` / `ConversationTitleMinimap.module.css` | Types, pure helpers, styles |
| `components/ChatHistory.tsx` | Flat timeline-grouped history list (rename/delete/cron indicator) — older sidebar list, still exported |
| `components/WorkspaceCollapse.tsx` | Simple collapsible section wrapper used by GroupedHistory |
| `components/SkillRuleGenerator.tsx` | **Unmounted** (import commented at `ChatConversation.tsx:43`). Generates a skill/rule from conversation history: prompt asks agent to `write_file` + echo content between `---PRESET_BEGIN---`/`---PRESET_END---` (line 228), captures it from `conversation.responseStream` (lines 236-249), registers preset into `ConfigStorage('assistants')` + `acpConversation.refreshCustomAgents` (lines 269-288); "Load Rule" modal reads workspace `.json/.md/.py/.txt` and injects as a system-instruction message (lines 79-110) |

### Message rendering (`Messages/`)

| File | Responsibility |
|---|---|
| `Messages/MessageList.tsx` | Virtualized list (react-virtuoso); pre-groups consecutive `codex turn_diff`→`file_summary` and `tool_group`/`acp_tool_call`→`tool_summary` (lines 177-254); per-type render switch (lines 119-155); target-message highlight/jump via router state and `CHAT_MESSAGE_JUMP_EVENT` (lines 271-339); `Image.PreviewGroup` wrapper; `useAutoPreviewOfficeFiles` |
| `Messages/hooks.ts` | Message-list context (`createContext` triple), `useAddOrUpdateMessage` batched compose with msg_id/callId/toolCallId index, `useMessageLstCache` DB hydration + stream merge, `useRemoveMessageByMsgId`, `beforeUpdateMessageList` interceptor stack |
| `Messages/useAutoScroll.ts` | Follow-output auto-scroll + scroll-to-bottom button state (150ms programmatic-scroll guard) |
| `Messages/types.ts` | `WriteFileResult`, `ImageGenerationResult` tool-result shapes |
| `Messages/constants.ts` | Text/collapse sizing constants (21px/line, 4-line collapse) |
| `Messages/messages.css` | Message list styles |
| `Messages/components/MessageText.tsx` | Markdown text bubble; strips workflow `WORKFLOW_STEP_CONTEXT` envelope + `[workflow_answer …]` tags on render (header comment, lines 1-9); delegates workflow bodies to `WorkflowMessageBody` |
| `Messages/components/WorkflowMessageBody.tsx` | Workflow-conversation assistant body (step markers → `workflowApplyStepMarker` from ConversationContext) |
| `Messages/components/MessageThinking.tsx` + `.module.css` | Collapsible "thinking" stream with duration |
| `Messages/components/MessageToolCall.tsx` | Gemini single tool-call row |
| `Messages/components/MessageToolGroup.tsx` | Gemini tool-group card (largest message card, 586 lines: statuses, diffs, image results, confirmation options) |
| `Messages/components/MessageToolGroupSummary.tsx` + `.css` | Collapsed summary row for a run of tool messages |
| `Messages/components/MessageAgentStatus.tsx` | Unified ACP agent status line (connecting/authenticated/…) |
| `Messages/components/MessagePlan.tsx` | Plan entries checklist card |
| `Messages/components/MessageTips.tsx` | Info/error tip line |
| `Messages/components/MessageSkillSuggest.tsx` | Wraps `SkillSuggestCard` for `skill_suggest` messages |
| `Messages/components/SkillSuggestCard.tsx` | Save-suggested-skill card → `ipcBridge.cron.saveSkill` / `cron.hasSkill` |
| `Messages/components/CronProposeCard.tsx` + `.module.css` | Cron proposal card → `ipcBridge.cron.confirmProposal` (line 94) or open modal via emitter `cron.modal.openWithProposal` (line 114) |
| `Messages/components/MessageCronTrigger.tsx` | "Triggered by schedule" divider row |
| `Messages/components/MessageCronBadge.tsx` | Small cron badge for message headers |
| `Messages/components/SubAgentActivityCard.tsx` + `.module.css` | `sub_agent` message card (agentName/status/body, merged by parentCallId in hooks.ts:224-244) |
| `Messages/components/SelectionReplyButton.tsx` | Floating "reply to selection" button (Shadow-DOM-aware selection) → emits `sendbox.reply` |
| `Messages/components/TeammateMessageAvatar.tsx` | Team-mode sender avatar (SWR `['team-conversation', id]`) |
| `Messages/acp/MessageAcpPermission.tsx` | ACP permission request card → `conversation.confirmMessage.invoke` (line 66) |
| `Messages/acp/MessageAcpToolCall.tsx` | ACP tool-call card (status tag, content blocks, diff/terminal renders) |
| `Messages/acp/MessageAvailableCommands.tsx` | Slash-command list card (currently rendered as `null` in MessageList line 151-152) |
| `Messages/codex/MessageCodexToolCall.tsx` | Codex tool-call dispatcher to ToolCallComponent displays |
| `Messages/codex/MessageFileChanges.tsx` | `file_summary` diff card + exported `parseDiff` |
| `Messages/codex/ToolCallComponent/BaseToolCallDisplay.tsx` | Shared collapsible tool-call frame |
| `Messages/codex/ToolCallComponent/ExecCommandDisplay.tsx` | Shell exec display (command/output) |
| `Messages/codex/ToolCallComponent/PatchDisplay.tsx` | Apply-patch display |
| `Messages/codex/ToolCallComponent/TurnDiffDisplay.tsx` | Turn-diff display |
| `Messages/codex/ToolCallComponent/McpToolDisplay.tsx` | MCP tool invocation display |
| `Messages/codex/ToolCallComponent/WebSearchDisplay.tsx` | Web-search display |
| `Messages/codex/ToolCallComponent/GenericDisplay.tsx` | Fallback display |

### Platform adapters (`platforms/`)

| File | Responsibility |
|---|---|
| `platforms/acp/AcpChat.tsx` | ACP/codex chat shell: ConversationProvider + MessageList + auth-failure card (emitter `acp.auth.failed.card`) + AcpSendBox |
| `platforms/acp/AcpSendBox.tsx` | ACP composer: draft (`getSendBoxDraftHook('acp')`), slash commands, file attach, mode selector, Flux routing badges, command queue integration, `team.sendMessage(ToAgent)` vs `acpConversation.sendMessage` (lines 191-209), stop via `conversation.stop` |
| `platforms/acp/useAcpMessage.ts` | ACP stream reducer: `acpConversation.responseStream.on` (line 327); running/aiProcessing/thought/tokenUsage/routing state machine per event type (lines 131-321); hydrates running state + persisted `extra.lastTokenUsage` from `conversation.get` (lines 353-385) |
| `platforms/acp/useAcpInitialMessage.ts` | Sends pending first message stored by the guid page in sessionStorage `` `acp_initial_message_${conversationId}` `` (line 36) |
| `platforms/acp/acpAuthFailure.ts` | Auth-failure signature classifier + per-backend `AcpAuthRemedy` descriptors (flux-routable, cliLoginCmd, provider key) |
| `platforms/acp/claudeCodeAuth.ts` | `isClaudeCodeOAuthRejection` helper |
| `platforms/assertBridgeSuccess.ts` | Throws on `{success:false}` bridge results |
| `platforms/useConversationCommandQueue.ts` | Per-conversation command queue: sessionStorage `` `conversation-command-queue/${conversationId}` `` (line 67), limits `MAX_QUEUED_COMMANDS 20` / input 20k chars / 50 files / 256KB state (lines 20-23); SWR-backed state, pause/resume/reorder, executes next item when `isBusy` transitions false; exported pure validators |
| `platforms/gemini/GeminiChat.tsx` | Gemini chat shell (`HOC.Wrapper(MessageListProvider, LocalImageView.Provider)`) |
| `platforms/gemini/GeminiSendBox.tsx` | Gemini composer: `geminiConversation.sendMessage` (line 282) or team send; quota fallback hookup; `gemini.*` emitter events |
| `platforms/gemini/useGeminiMessage.ts` | Gemini stream reducer on `geminiConversation.responseStream` (line 107); streamRunning/hasActiveTools/waitingResponse states |
| `platforms/gemini/useGeminiInitialMessage.ts` | Initial-message side effect (sessionStorage handoff, gemini variant) |
| `platforms/gemini/GeminiModelSelector.tsx` | Header model dropdown (also used disabled for other backends) |
| `platforms/gemini/useGeminiModelSelection.ts` | Model selection state: providers list, mode lookup, `handleSelectModel` persisting via `conversation.update` |
| `platforms/gemini/useGeminiQuotaFallback.ts` | On quota errors, prompts + auto-switches to fallback model |
| `platforms/wcore/WCoreChat.tsx` | Built-in engine chat shell + AcpAuthFailureCard (emitter `wcore.auth.failed.card`) |
| `platforms/wcore/WCoreSendBox.tsx` | WCore composer: generic `conversation.sendMessage` (line 229); initial-message keys `` `wcore_initial_message_${id}` ``/`` `wcore_initial_processed_${id}` `` (lines 295-296); dynamic mode list from capabilities |
| `platforms/wcore/useWCoreMessage.ts` | WCore stream reducer on generic `conversation.responseStream` (line 120); usage from `stream_end` |
| `platforms/wcore/WCoreModelSelector.tsx` / `useWCoreModelSelection.ts` | WCore model dropdown + selection state (kills agent on switch via `conversation.stop`, `ChatConversation.tsx:230`) |
| `platforms/openclaw/OpenClawChat.tsx` | OpenClaw gateway chat shell (+ `LocalImageView` root) |
| `platforms/openclaw/OpenClawSendBox.tsx` | OpenClaw composer: `openclawConversation.getRuntime` bootstrap (lines 61, 254), `openclawConversation.responseStream` (287), `openclawConversation.sendMessage` (440, 566) |
| `platforms/openclaw/StarOfficeMonitorCard.tsx` | Detects local OpenClaw live-monitor URL via `starOffice.detectUrl` (line 74); caches in localStorage `wayland.openclaw.monitorUrl` / `wayland.starOffice.url` (lines 16-17); opens in Preview URL tab |
| `platforms/nanobot/NanobotChat.tsx` / `NanobotSendBox.tsx` | Nanobot shell + composer over generic `conversation.responseStream`/`conversation.sendMessage` (SendBox lines 182, 254) — the minimal platform template |
| `platforms/remote/RemoteChat.tsx` / `RemoteSendBox.tsx` | Remote-agent shell + composer (generic stream/send; resolves agent via `remoteAgent.get` from `extra.remoteAgentId`, SendBox lines 227-229) |

### Preview panel (`Preview/`)

| File | Responsibility |
|---|---|
| `Preview/context/PreviewContext.tsx` | Core provider: multi-tab state, smart tab reuse (filePath > fileName > title > content<100KB, lines 206-251), save via `fs.writeFile` (420), agent streaming via `fileStream.contentUpdate.on` with 500ms/file debounce + `isStreaming` flag (483-565), 1s mtime polling of active tab via `fs.getFileMetadata`/`readFile`/`getImageBase64` (571-634), `preview.open` from emitter **and** IPC (638-659), sendbox handler registry, DOM-snippet store; persists tabs to localStorage `wayland_preview_tabs` / `wayland_preview_active_tab_id` (legacy `wayland_preview_state`), text-types only, ≤80k chars (lines 76-93) |
| `Preview/context/PreviewToolbarExtrasContext.tsx` | Viewer→toolbar slot injection (`left`/`right` ReactNodes) |
| `Preview/context/index.ts` | Barrel |
| `Preview/components/PreviewPanel/PreviewPanel.tsx` | Main panel: view mode (`source`/`preview`/`editor`), split-screen (`useResizableSplit` key `preview-panel-split-ratio`, line 200), edit mode + dirty confirm, inspect mode, content-type dispatch (markdown/html/diff/code editors at 393-401; viewers pdf/ppt/word/excel/image/url at 706-722) |
| `Preview/components/PreviewPanel/PreviewTabs.tsx` | Tab bar (switch, close, dirty dot, overflow fades) |
| `Preview/components/PreviewPanel/PreviewToolbar.tsx` | Toolbar: view-mode toggles, edit/save/done, history, download, open-external, split, inspect |
| `Preview/components/PreviewPanel/PreviewContextMenu.tsx` | Tab context menu (close current/others/all) |
| `Preview/components/PreviewPanel/PreviewConfirmModals.tsx` | Exit-edit / close-dirty-tab confirms |
| `Preview/components/PreviewPanel/PreviewHistoryDropdown.tsx` | Git-based version dropdown (restore/select) |
| `Preview/components/PreviewPanel/preview.css` / `index.ts` | Styles / barrel |
| `Preview/components/viewers/MarkdownViewer.tsx` | Markdown render (largest viewer; mermaid/code blocks) |
| `Preview/components/viewers/CodeViewer.tsx` | Read-only syntax-highlighted code |
| `Preview/components/viewers/DiffViewer.tsx` | Unified diff render |
| `Preview/components/viewers/HTMLViewer.tsx` | Blob-URL iframe HTML view with serialized inspector script, parent `postMessage` bridge |
| `Preview/components/viewers/ImageViewer.tsx` | Image display (base64) |
| `Preview/components/viewers/PDFViewer.tsx` | PDF display |
| `Preview/components/viewers/OfficeDocViewer.tsx` | Word/Office doc display |
| `Preview/components/viewers/OfficeWatchViewer.tsx` | Shared `officecli watch` child-process viewer (live Office rendering via local server) |
| `Preview/components/viewers/ExcelViewer.tsx` | Spreadsheet display |
| `Preview/components/viewers/PptViewer.tsx` | Presentation display |
| `Preview/components/viewers/URLViewer.tsx` | Web page tab (webview/iframe; used by StarOffice monitor + agent web previews) |
| `Preview/components/viewers/index.ts` | Barrel |
| `Preview/components/editors/TextEditor.tsx` | Monaco code editor |
| `Preview/components/editors/MarkdownEditor.tsx` | Plain markdown editor (split-screen source side) |
| `Preview/components/editors/TipTapMarkdownEditor.tsx` + `.module.css` | WYSIWYG markdown editor (TipTap), gated to `.md/.markdown/.mdx` (`PreviewPanel.tsx:55`) |
| `Preview/components/editors/slashMenu.tsx` | TipTap slash-command popup (`SLASH_ITEMS`, line 61) |
| `Preview/components/editors/frontmatter.ts` | Frontmatter split/join for TipTap round-trip |
| `Preview/components/editors/HTMLEditor.tsx` | HTML source editor with live render |
| `Preview/components/editors/index.ts` | Barrel |
| `Preview/components/renderers/HTMLRenderer.tsx` | HTML render engine: Electron `<webview>` (preferred) vs sandboxed Blob-URL iframe fallback (opaque origin, no `allow-same-origin`, lines 433-451); inlines relative resources for iframe; inspect-mode injection; height auto-sizing |
| `Preview/components/renderers/htmlInspectScript.ts` | `generateInspectScript` — injected element-picker script (hover outline, click→copy/post snippet) |
| `Preview/components/renderers/SelectionToolbar.tsx` | Floating "Add to chat" toolbar over text selections in HTML preview |
| `Preview/components/renderers/index.ts` / `components/index.ts` | Barrels |
| `Preview/hooks/usePreviewHistory.ts` | Version history via `previewHistory.save`/`list`/`getContent` IPC (git snapshots) |
| `Preview/hooks/usePreviewKeyboardShortcuts.ts` | Cmd/Ctrl+S save shortcut |
| `Preview/hooks/useScrollSync.ts` / `useScrollSyncHelpers.ts` | Editor↔preview scroll sync (rAF; external requests via `data-target-scroll-percent` MutationObserver) |
| `Preview/hooks/useTabOverflow.ts` | IntersectionObserver tab fade indicators |
| `Preview/hooks/useThemeDetection.ts` | Light/dark theme probe for editors |
| `Preview/hooks/index.ts` / `Preview/index.ts` | Barrels (module public API: `PreviewPanel`, `PreviewProvider`, `usePreviewContext`) |
| `Preview/constants.ts` | `DEFAULT_SPLIT_RATIO 50`, `MIN/MAX_SPLIT_WIDTH 20/80`, `FILE_TYPES_WITH_BUILTIN_OPEN`, debounce times |
| `Preview/fileUtils.ts` | `FILE_EXTENSION_MAP: Record<PreviewContentType, ext[]>` + extension helpers — the ext→viewer routing table |
| `Preview/types.ts` | Re-exports `PreviewContentType` etc. from `@/common/types/preview`; `ViewMode` |
| `Preview/README.en.md` | Module documentation (accurate as of review) |

### Sidebar history (`GroupedHistory/`)

| File | Responsibility |
|---|---|
| `GroupedHistory/index.tsx` | Workspace-grouped sidebar history: dnd-kit sortable rows, batch mode, project assignment, export modals |
| `GroupedHistory/ConversationRow.tsx` | Single row (title, generating spinner, unread dot, cron indicator, menu) |
| `GroupedHistory/SortableConversationRow.tsx` / `DragOverlayContent.tsx` | dnd-kit sortable wrapper / drag ghost |
| `GroupedHistory/ConversationSearchPopover.tsx` + `.css` | Global full-text search: `database.searchConversationMessages` (line 211); recent keywords in localStorage `conversation.historySearch.recentKeywords` (line 27); navigates with `{targetMessageId, fromConversationSearch}` router state consumed by `MessageList` |
| `GroupedHistory/hooks/useConversations.ts` | Grouped data from `ConversationHistoryContext`; workspace auto-expand-once; scroll-active-into-view |
| `GroupedHistory/hooks/useConversationListSync.ts` | Marks conversations "generating" from all response streams (acp/gemini/codex/openclaw); completion-unread badges via `conversation.turnCompleted.on` (line 205) |
| `GroupedHistory/hooks/useConversationActions.ts` | Rename (`conversation.update`), delete (`conversation.remove` + emitter `conversation.deleted`), open workspace |
| `GroupedHistory/hooks/useBatchSelection.ts` | Multi-select set for batch export/delete |
| `GroupedHistory/hooks/useDragAndDrop.ts` | Sort-order persistence for rows/workspaces |
| `GroupedHistory/hooks/useExport.ts` | Export conversations as Markdown/JSON (+workspace files) into a zip via `fs.createZip`/`cancelZip`, `dialog.showOpen` |
| `GroupedHistory/hooks/useVisibleConversationIds.ts` | Flattened visible-id list respecting expansion state |
| `GroupedHistory/hooks/useWorkspaceExpansionState.ts` | Expanded-workspace ids in localStorage `WORKSPACE_EXPANSION_STORAGE_KEY` + change event |
| `GroupedHistory/types.ts` | Row/group/export types |
| `GroupedHistory/utils/exportHelpers.ts` | Markdown/JSON builders, zip assembly, IO timeout |
| `GroupedHistory/utils/groupingHelpers.ts` / `sortOrderHelpers.ts` / `visibleConversationOrder.ts` | Pure grouping/sort/visibility helpers |

### Workspace file tree (`Workspace/`)

| File | Responsibility |
|---|---|
| `Workspace/index.tsx` | Container composing all workspace hooks; renders tab bar (Files / Changes), toolbar, Arco Tree, dialogs, context menu |
| `Workspace/hooks/useWorkspaceTree.ts` | Tree state/load/refresh/selection (via `conversation.getWorkspace`) |
| `Workspace/hooks/useWorkspaceEvents.ts` | Listeners: conversation switch reset, agent stream auto-refresh (`tool_group`/`acp_tool_call`/`codex_tool_call`), `${eventPrefix}.workspace.refresh`, `${eventPrefix}.selected.file.clear`, outside-click |
| `Workspace/hooks/useWorkspaceFileOps.ts` | Open/reveal/delete/rename/preview/add-to-chat (emits `${eventPrefix}.selected.file*`); preview routes into PreviewContext by extension |
| `Workspace/hooks/useWorkspaceModals.ts` | Modal + context-menu state |
| `Workspace/hooks/useWorkspacePaste.ts` | Paste/import files → `fs.copyFilesToWorkspace` |
| `Workspace/hooks/useWorkspaceDragImport.ts` | OS drag-drop import into workspace |
| `Workspace/hooks/useWorkspaceSearch.ts` | Debounced tree search + WebUI host file selector |
| `Workspace/hooks/useWorkspaceMigration.ts` | Workspace migration flow (directory pick, cron migration prompt, execution) |
| `Workspace/hooks/useWorkspaceCollapse.ts` | Tree section collapse, localStorage `STORAGE_KEYS.WORKSPACE_TREE_COLLAPSE` (distinct from `hooks/useWorkspaceCollapse.ts` panel hook) |
| `Workspace/hooks/useFileChanges.ts` | Git-style change list via `fileSnapshot.compare` |
| `Workspace/components/FileChangeList.tsx` | Changes tab: stage/unstage/discard/reset per file via `fileSnapshot.*` IPC family |
| `Workspace/components/WorkspaceTabBar.tsx` | Files/Changes tab switcher |
| `Workspace/components/WorkspaceToolbar.tsx` | Search box, add, refresh, collapse buttons |
| `Workspace/components/WorkspaceContextMenu.tsx` | Node right-click menu |
| `Workspace/components/WorkspaceDialogs.tsx` | Rename/delete dialogs |
| `Workspace/components/MigrationModal.tsx` | Migration confirm modal |
| `Workspace/components/PasteConfirmModal.tsx` | Paste-files confirm |
| `Workspace/utils/treeHelpers.ts` | Tree transform/path helpers |
| `Workspace/utils/filePreview.ts` | `PREVIEW_SUPPORTED_EXTENSIONS` set |
| `Workspace/types.ts` / `workspace.css` / `README.en.md` | Types / styles / docs |

## Contracts & data flow

**IPC — streams consumed** (main→renderer): `acpConversation.responseStream` (`useAcpMessage.ts:327`), `geminiConversation.responseStream` (`useGeminiMessage.ts:107`), `conversation.responseStream` (wcore `useWCoreMessage.ts:120`, nanobot/remote sendboxes, SkillRuleGenerator capture), `openclawConversation.responseStream` (`OpenClawSendBox.tsx:287`), `codexConversation.responseStream` (GroupedHistory list sync), `conversation.listChanged`, `conversation.turnCompleted` (`useConversationListSync.ts:205`), `conversation.confirmation.add/update/remove`, `fileStream.contentUpdate` (`PreviewContext.tsx:487`), `preview.open` (`PreviewContext.tsx:653`), `modelRegistry.listChanged`.

**IPC — invokes** (key ones): `conversation.get/update/stop/remove/create/createWithConversation/sendMessage/getWorkspace/getAssociateConversation`, `conversation.confirmation.confirm|list`, `conversation.confirmMessage` (ACP permission, `MessageAcpPermission.tsx:66`), `conversation.approval.check`, `acpConversation.sendMessage|refreshCustomAgents`, `geminiConversation.sendMessage`, `openclawConversation.sendMessage|getRuntime`, `team.sendMessage|sendMessageToAgent|updateWorkspace`, `database.getConversationMessages|getUserConversations|searchConversationMessages`, `fs.readFile/writeFile/getFileMetadata/getImageBase64/getFilesByDir/copyFilesToWorkspace/createZip/cancelZip/fetchRemoteImage`, `fileSnapshot.compare/stageFile/stageAll/unstageFile/unstageAll/discardFile/resetFile/getBaselineContent/dispose`, `previewHistory.save/list/getContent`, `skills.addToConversation`, `cron.confirmProposal/saveSkill/hasSkill`, `starOffice.detectUrl`, `remoteAgent.get`, `extensions.getAssistants`, `onboarding.connectFlux`, `shell.openFile/showItemInFolder/openExternal/openFolderWith/checkToolInstalled`, `dialog.showOpen`, `mode.getModelConfig`, `application.getPath`. No process is spawned from this area — all execution happens in main-process services behind these bridge keys.

**Message shape**: `TMessage` union from `src/common/chat/chatLib.ts` — types rendered here: `text, tips, tool_call, tool_group, agent_status, acp_permission, acp_tool_call, codex_permission (null), codex_tool_call, plan, thinking, skill_suggest, cron_trigger, cron_propose, sub_agent, available_commands (null)` (`Messages/MessageList.tsx:119-155`). Streaming merge identity: `msg_id` (text/thinking/plan/sub_agent), `content.callId` (tool_call), `content.toolCallId` (codex), `content.update.toolCallId` (acp) — `Messages/hooks.ts:30-297`.

**localStorage keys**: `wayland_conversation_tabs` (tabs), `wayland_preview_tabs` + `wayland_preview_active_tab_id` (+legacy `wayland_preview_state`), `chat-workspace-split-ratio`, `chat-preview-split-ratio`, `preview-panel-split-ratio`, `workspace-open-preference`, `STORAGE_KEYS.WORKSPACE_PANEL_COLLAPSE`, `STORAGE_KEYS.WORKSPACE_TREE_COLLAPSE`, `workspace-preference-${convId}`, `conversation.historySearch.recentKeywords`, `wayland.openclaw.monitorUrl`, `wayland.starOffice.url`, GroupedHistory `WORKSPACE_EXPANSION_STORAGE_KEY`.
**sessionStorage keys**: `acp_initial_message_${id}`, `wcore_initial_message_${id}` + `wcore_initial_processed_${id}`, `conversation-command-queue/${id}`.

**Renderer emitter events** (from `@/renderer/utils/emitter`): `chat.history.refresh` (fired after every send/create), `${prefix}.selected.file` / `.append` / `.clear` and `${prefix}.workspace.refresh` where prefix ∈ `acp|gemini|wcore|codex|openclaw-gateway|nanobot|remote`, `acp.auth.failed.card`, `wcore.auth.failed.card`, `conversation.deleted`, `preview.open`, `sendbox.fill`, `sendbox.reply`, `cron.modal.openWithProposal`, `staroffice.install.request/finished`. DOM CustomEvents: `CHAT_MESSAGE_JUMP_EVENT` (minimap/search → MessageList), `WORKSPACE_TOGGLE_EVENT`/`WORKSPACE_HAS_FILES_EVENT` (workspace collapse).

**Config storage** (`ConfigStorage`): reads `acp.config`, `gemini.config`, `wcore.config`, `acp.cachedModels`, `model.config`, `acp.customAgents`; writes `assistants` (SkillRuleGenerator preset registration). DB tables are touched only via the `database.*`/`conversation.*` bridge (SQLite in main, see codemap 11).

**Conversation `extra` fields consumed here**: `workspace`, `customWorkspace`, `backend`, `sessionMode`, `cachedConfigOptions`, `currentModelId`, `agentName`, `cronJobId`, `loadedSkills`, `workflowSessionId`, `acpSessionId`/`acpSessionUpdatedAt` (cleared on clone, `ChatConversation.tsx:138-142`), `lastTokenUsage`/`lastContextLimit`, `remoteAgentId`.

## Conventions & invariants

- **Platform pattern is fixed**: every backend = `platforms/<name>/` with `<Name>Chat.tsx` (MessageListProvider HOC + ConversationProvider + MessageList + ConversationChatConfirm + SendBox), `<Name>SendBox.tsx`, and a `use<Name>Message.ts` stream reducer. Draft state via `getSendBoxDraftHook('<type>', …)`; file selection via the `${prefix}.selected.file*` emitter protocol.
- **All agent output enters the UI through `useAddOrUpdateMessage`** — never mutate the message list directly; merge/dedup semantics live only in `Messages/hooks.ts`. New streaming message types must define a merge rule there and a render case in `MessageList.tsx`.
- **Message list is immutable + memoized**: `MessageItem` is `React.memo` keyed on id/content/position/type (`MessageList.tsx:157-163`); compose functions always return new arrays.
- **Send flow invariant**: send → optimistic `chat.history.refresh` emit → errors classified by `classifyAcpAuthFailure` → remedy card, not raw error text. When `isBusy`, sends are enqueued in the command queue instead of dropped (`AcpSendBox.tsx:286-297`).
- **Preview never fights the user**: streaming updates and mtime-poll updates are skipped when `tab.isDirty` or while a save is in flight (`PreviewContext.tsx:538, 595`); tab reuse is identity-based (filePath first).
- **Sandboxing**: browser-fallback HTML preview uses Blob-URL iframes with opaque origin and no `allow-same-origin` (`HTMLRenderer.tsx:433-451`); inspector scripts communicate via `postMessage` only.
- **Persistence discipline**: UI state → localStorage (guarded try/catch, validated on parse); one-shot handoffs → sessionStorage; durable data → main process via IPC. Big content (>80k chars) is never persisted to localStorage (`PreviewContext.tsx:81`).
- **i18n**: all user-visible strings use `useTranslation` keys under `conversation.*`, `messages.*`, `acp.*`, `starOffice.*` (with `defaultValue` fallbacks).
- **Naming/structure** follows `.claude/skills/architecture`: ≤10 direct children per directory (why `Messages/components`, `Preview/components/{viewers,editors,renderers}` are split), Arco components only, UnoCSS utilities + CSS Modules.

## Assimilation anchors

1. **New agent backend/engine (e.g. an ECC-orchestrator or Odysseus engine surface)** → create `platforms/<name>/{<Name>Chat.tsx, <Name>SendBox.tsx}` mirroring `platforms/nanobot/NanobotChat.tsx` + `NanobotSendBox.tsx` (the minimal template using generic `conversation.sendMessage`/`conversation.responseStream`); register the type in `components/ChatConversation.tsx` switch (~line 364-390), `hooks/ConversationTabsContext.tsx:21` type union, `components/ChatSider.tsx` eventPrefix map, and `GroupedHistory/hooks/useConversationListSync.ts` stream list.
2. **New agent-output card (review report, plan gate, memory-recall, team status)** → add the message type to `TMessage` in `src/common/chat/chatLib.ts`, a merge rule in `Messages/hooks.ts` `composeMessageWithIndex` (imitate the `sub_agent` block, lines 224-244), a render case in `Messages/MessageList.tsx:119-155`, and a card component mirroring `Messages/components/SubAgentActivityCard.tsx` (status+body) or `Messages/components/CronProposeCard.tsx` (actionable confirm/adjust card with IPC callback).
3. **New per-conversation header action (e.g. "run checkpoint review", memory toggle)** → add to `headerExtraNode` in `components/ChatConversation.tsx:567-592` (and the gemini/wcore panel variants at lines 189-199/250-260), mirroring `components/AddSkillToChatButton.tsx` for a popover-with-IPC or `CronJobManager` for a stateful manager.
4. **New Preview content type (e.g. mermaid graph, eval report, diff-review)** → extend `PreviewContentType` in `src/common/types/preview`, map extensions in `Preview/fileUtils.ts` `FILE_EXTENSION_MAP`, add a viewer in `Preview/components/viewers/` (imitate `DiffViewer.tsx` for text-based, `OfficeWatchViewer.tsx` for external-process rendering), and a dispatch branch in `Preview/components/PreviewPanel/PreviewPanel.tsx:644-722`. Services can open it programmatically via `ipcBridge.preview.open` or emitter `preview.open` (`PreviewContext.tsx:638-659`).
5. **Skill/rule generation from conversation (ECC `skill-create` / Superpowers `writing-skills` analog)** → resurrect `components/SkillRuleGenerator.tsx` (currently commented out at `ChatConversation.tsx:43`): its capture protocol (`---PRESET_BEGIN---` sentinel over `conversation.responseStream`, lines 236-249) and preset registration into `ConfigStorage('assistants')` + `acpConversation.refreshCustomAgents` is the existing end-to-end path to turn a session into a reusable assistant.
6. **Autonomous multi-step drivers (loops, plan execution)** → enqueue follow-up prompts through `platforms/useConversationCommandQueue.ts` (`enqueue`, pause/resume, sessionStorage-persisted) instead of racing `sendMessage`; busy-state detection comes free from the platform `use*Message` hooks.
