import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Message, Modal } from '@arco-design/web-react';
import {
  useMcpServers,
  useMcpAgentStatus,
  useMcpOperations,
  useMcpOAuth,
  useMcpServerCRUD,
  useMcpConnection,
} from '@renderer/hooks/mcp';
import type { McpOAuthStatus } from '@renderer/hooks/mcp/useMcpOAuth';
import type { IMcpServer } from '@/common/config/storage';
import { ipcBridge } from '@/common';
import AddMcpServerModal from '@renderer/pages/settings/components/AddMcpServerModal';
import type { McpRemovalFrame } from '@renderer/pages/settings/WCoreConfig/panes/types';
import { useMcpLibrary } from './hooks/useMcpLibrary';
import { ServerRow, type UIStatus } from './components/ServerRow';

// 4-state UI status derivation per RECON.md §5.
// error short-circuits first, then warn (needsLogin), then running (enabled + connected),
// else stopped (which absorbs disconnected / testing / undefined).
function deriveStatus(s: IMcpServer, oauth: McpOAuthStatus | undefined): UIStatus {
  if (s.status === 'error') return 'error';
  if (oauth?.needsLogin === true) return 'warn';
  if (s.enabled === true && s.status === 'connected') return 'running';
  return 'stopped';
}

/**
 * An `mcp_removal_result` frame, or null.
 *
 * The main-process capability already decoded and bounded every field; only the
 * discriminant is re-checked, because `IResponseMessage.data` is `unknown` at
 * the IPC seam.
 */
function readRemovalFrame(data: unknown): McpRemovalFrame | null {
  if (typeof data !== 'object' || data === null) return null;
  const { status } = data as { status?: unknown };
  if (status !== 'result' && status !== 'name_mismatch' && status !== 'undecodable') return null;
  return data as McpRemovalFrame;
}

/**
 * One withdrawal this page asked for, and what became of it.
 *
 * Keyed by the `requestId` the main process minted, which is also the engine's
 * declared correlation key - so a reply settles the ask it answers and nothing
 * else. `conversationId` is carried because each open Darhai Core chat is a
 * separate engine process holding its own copy of the tools: "2 tools
 * withdrawn" with no engine named is a claim about an unspecified session.
 */
type Withdrawal = {
  requestId: string;
  conversationId: string;
  /** The name Darhai asked about, so a mismatched answer can be judged. */
  requestedName: string;
  /** The engine's answer, or null while one is owed. */
  frame: McpRemovalFrame | null;
  /** Why the command never left this host. Null when it was sent. */
  notSent: string | null;
};

export function InstalledPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const library = useMcpLibrary();

  const [message, contextHolder] = Message.useMessage();
  const [showAddModal, setShowAddModal] = useState(false);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  /**
   * Request ids still awaiting a reply, readable from the stream handler.
   *
   * A ref because the subscription is registered once at mount: a handler
   * closing over state would keep comparing against the empty set it saw then.
   */
  const awaiting = useRef(new Map<string, string>());

  // Removing a server from the library rewrites the CLI agent configs, but a
  // Darhai Core session that is already running keeps serving its tools until
  // the engine is told to drop them. `handleRemove` now tells it; this is where
  // the engine's own account of what actually went comes back. A frame that
  // matches no outstanding ask is dropped: this page cannot say which engine or
  // which server it describes, and guessing is the failure it exists to remove.
  useEffect(() => {
    return ipcBridge.conversation.responseStream.on((msg) => {
      if (msg.type !== 'mcp_removal_result') return;
      const frame = readRemovalFrame(msg.data);
      if (frame === null) return;
      const conversationId = awaiting.current.get(frame.requestId);
      if (conversationId === undefined) return;
      if (conversationId !== msg.conversation_id) return;
      awaiting.current.delete(frame.requestId);
      setWithdrawals((previous) =>
        previous.map((entry) => (entry.requestId === frame.requestId ? { ...entry, frame } : entry))
      );
    });
  }, []);
  const { mcpServers, saveMcpServers } = useMcpServers();
  const { setAgentInstallStatus, checkSingleServerInstallStatus } = useMcpAgentStatus();
  const { syncMcpToAgents, removeMcpFromAgents } = useMcpOperations(mcpServers, message);
  const { oauthStatus, login } = useMcpOAuth();
  const crud = useMcpServerCRUD(
    mcpServers,
    saveMcpServers,
    syncMcpToAgents,
    removeMcpFromAgents,
    checkSingleServerInstallStatus,
    setAgentInstallStatus
  );
  const { testingServers, refreshServerStatuses } = useMcpConnection(mcpServers, saveMcpServers, message);

  // On first load, probe enabled servers so the status strip + per-row pills
  // reflect reality (connected + real tool counts) instead of stale config.
  // refreshServerStatuses is non-destructive and self-throttles via lastConnected.
  const didInitialRefresh = useRef(false);
  useEffect(() => {
    if (didInitialRefresh.current || mcpServers.length === 0) return;
    didInitialRefresh.current = true;
    void refreshServerStatuses(mcpServers);
  }, [mcpServers, refreshServerStatuses]);

  const fromLibrary = useMemo(() => mcpServers.filter((s) => s.source === 'library'), [mcpServers]);
  const custom = useMemo(() => mcpServers.filter((s) => s.source !== 'library'), [mcpServers]);

  const summary = useMemo(() => {
    let running = 0;
    let warn = 0;
    let error = 0;
    for (const s of mcpServers) {
      const status = deriveStatus(s, oauthStatus[s.id]);
      if (status === 'running') running++;
      else if (status === 'warn') warn++;
      else if (status === 'error') error++;
    }
    const tools = mcpServers.reduce((n, s) => n + (s.tools?.length ?? 0), 0);
    return { running, warn, error, tools };
  }, [mcpServers, oauthStatus]);

  const handleToggle = useCallback(
    async (s: IMcpServer) => {
      const enabling = !s.enabled;
      await crud.handleToggleMcpServer(s.id, enabling);
      // Probe right after enabling so the row resolves to its real state
      // (connected + tools, needs-auth, or error) instead of sitting on "Idle".
      if (enabling) void refreshServerStatuses([{ ...s, enabled: true }], { force: true });
    },
    [crud, refreshServerStatuses]
  );

  const handleReauth = useCallback(
    async (s: IMcpServer) => {
      const result = await login(s);
      if (result.success === true) {
        message.success(t('mcpLibrary.install.oauthSuccess', 'Authorized.'));
        return;
      }
      if (result.success === false && result.code === 'needs_byo') {
        // Drop the user onto the detail page where the BYO modal lives - the
        // installed-page row UI doesn't have room for the credential inputs.
        if (s.libraryEntryId) {
          navigate(`/settings/mcp-library/${encodeURIComponent(s.libraryEntryId)}`);
          return;
        }
      }
      message.error(
        t('mcpLibrary.install.oauthFailed', 'Authorization failed: {{error}}', {
          error: (result.success === false && result.error) || 'Unknown error',
        })
      );
    },
    [login, message, t, navigate]
  );

  const handleSettings = useCallback(
    (s: IMcpServer) => {
      if (s.source === 'library' && s.libraryEntryId) {
        navigate(`/settings/mcp-library/${encodeURIComponent(s.libraryEntryId)}`);
      } else {
        message.info(t('mcpLibrary.installed.customNoDetail', "Custom servers don't have a detail page yet."));
      }
    },
    [navigate, message, t]
  );

  const handleLogs = useCallback(() => {
    message.info(t('mcpLibrary.installed.logsToast', 'Log viewer coming soon.'));
  }, [message, t]);

  const handleReconnect = useCallback(
    async (s: IMcpServer) => {
      try {
        // Re-enable re-pushes the server config to every agent; running workers
        // pick it up on their next message via the MCP-changed refresh. Then
        // probe so the row + strip show the freshly resolved status and tools.
        await crud.handleToggleMcpServer(s.id, true);
        void refreshServerStatuses([{ ...s, enabled: true }], { force: true });
        message.success(
          t(
            'mcpLibrary.installed.reconnectToast',
            'Reconnecting {{name}} - agents will pick it up on the next message.',
            {
              name: s.name,
            }
          )
        );
      } catch {
        message.error(t('settings.mcpSyncError', 'Failed to sync MCP to agents.'));
      }
    },
    [crud, message, t, refreshServerStatuses]
  );

  const handleRemove = useCallback(
    (s: IMcpServer) => {
      Modal.confirm({
        title: t('mcpLibrary.installed.actionRemove', 'Remove'),
        content: (
          <>
            <div>
              {t(
                'mcpLibrary.installed.removeConfirm',
                'Remove {{name}} from your library? This will also uninstall it from all CLI agents.',
                { name: s.name }
              )}
            </div>
            {/* The old copy stopped at the line above, while a running engine
                went on serving the tools. Saying so up front is cheaper than
                the user discovering it mid-conversation. */}
            <div className='mt-2 text-t-tertiary'>
              {t('settings.wcoreConfig.mcpSession.removeEngineCaveat', {
                defaultValue: 'A Darhai Core chat that is already open keeps its tools until you restart that chat.',
              })}
            </div>
          </>
        ),
        okText: t('mcpLibrary.installed.actionRemove', 'Remove'),
        cancelText: t('mcpLibrary.installed.confirmCancel', 'Cancel'),
        okButtonProps: { status: 'danger' },
        onOk: async () => {
          await crud.handleDeleteMcpServer(s.id);
          // The library delete rewrites config files. Only this takes the tools
          // out of a chat that is ALREADY open, and it is asked of every live
          // engine because the user did not mean "in one of my chats".
          const outcome = await ipcBridge.wcoreEngine.withdrawMcpServer.invoke({ name: s.name });
          const sent = Array.isArray(outcome?.sent) ? outcome.sent : [];
          const refused = Array.isArray(outcome?.refused) ? outcome.refused : [];

          const opened: Withdrawal[] = [];
          for (const entry of sent) {
            if (typeof entry.requestId !== 'string' || entry.requestId.length === 0) continue;
            awaiting.current.set(entry.requestId, entry.conversationId);
            opened.push({
              requestId: entry.requestId,
              conversationId: entry.conversationId,
              requestedName: s.name,
              frame: null,
              notSent: null,
            });
          }
          for (const [index, entry] of refused.entries()) {
            opened.push({
              // Nothing was minted, so there is no correlation id to key on;
              // the index keeps the row distinct without inventing one.
              requestId: `not-sent-${entry.conversationId}-${index}-${Date.now()}`,
              conversationId: entry.conversationId,
              requestedName: s.name,
              frame: null,
              notSent:
                typeof entry.reason === 'string' && entry.reason.length > 0
                  ? entry.reason
                  : t('settings.wcoreConfig.mcpSession.withdrawNoReason', { defaultValue: 'no reason was given' }),
            });
          }
          if (opened.length > 0) setWithdrawals((previous) => [...previous, ...opened]);

          // The old copy told EVERY user to restart their chats. Restarting is
          // the remedy only when the engine could not be asked; when it was
          // asked, the notice above reports what it actually did.
          if (sent.length === 0) {
            message.warning(
              refused.length > 0
                ? t('settings.wcoreConfig.mcpSession.removedRestartHint', {
                    defaultValue: 'Removed. Restart any open Darhai Core chat to stop it offering {{name}}’s tools.',
                    name: s.name,
                  })
                : t('settings.wcoreConfig.mcpSession.removedNoEngine', {
                    defaultValue: 'Removed. No Darhai Core chat was open, so nothing was still serving its tools.',
                  })
            );
          }
        },
      });
    },
    [crud, message, t]
  );

  const handleAddSubmit = useCallback(
    (serverData: Omit<IMcpServer, 'id' | 'createdAt' | 'updatedAt'>) => {
      void crud.handleAddMcpServer(serverData);
    },
    [crud]
  );

  const handleAddBatch = useCallback(
    (servers: Omit<IMcpServer, 'id' | 'createdAt' | 'updatedAt'>[]) => {
      void crud.handleBatchImportMcpServers(servers);
    },
    [crud]
  );

  const renderRow = (s: IMcpServer) => {
    const entry = s.libraryEntryId ? library.entries.find((e) => e.id === s.libraryEntryId) : undefined;
    const oauth = oauthStatus[s.id];
    const status = deriveStatus(s, oauth);
    return (
      <ServerRow
        key={s.id}
        server={{
          id: s.id,
          name: entry?.name ?? s.name,
          source: s.source,
          libraryEntryId: s.libraryEntryId,
          status,
          toolCount: s.tools?.length ?? 0,
          publisher: entry?.id ?? s.name,
          enabled: s.enabled,
        }}
        iconUrl={entry?.iconUrl}
        oauthStatus={oauth}
        checking={testingServers[s.id] === true}
        onReauth={() => void handleReauth(s)}
        onSettings={() => handleSettings(s)}
        onRemove={() => handleRemove(s)}
        onToggle={() => void handleToggle(s)}
        onLogs={handleLogs}
        onReconnect={() => void handleReconnect(s)}
      />
    );
  };

  return (
    <div className='mcp-installed-page'>
      {contextHolder}
      <header className='mcp-page-head'>
        <h2>{t('mcpLibrary.installed.title', 'MCP Library - Installed')}</h2>
        <button className='mcp-btn-primary' onClick={() => setShowAddModal(true)}>
          {t('mcpLibrary.installed.addCustom', '+ Add custom MCP')}
        </button>
      </header>

      {withdrawals.length > 0 && (
        <div className='mb-3 flex flex-col gap-1.5' data-testid='engine-withdrawals'>
          {withdrawals.map(({ requestId, conversationId, requestedName, frame, notSent }) => (
            <div key={requestId} className='rounded border border-b-light p-2 text-xs text-t-secondary'>
              {/* WHICH engine. Each open chat is its own process with its own
                  copy of the tools, so an unattributed "2 tools withdrawn" is a
                  claim about a session the user cannot identify. */}
              <div className='text-t-tertiary'>
                {t('settings.wcoreConfig.mcpSession.withdrawScope', {
                  defaultValue: '{{name}} · engine of chat {{conversation}}',
                  name: requestedName,
                  conversation: conversationId,
                })}
              </div>
              {notSent !== null && (
                <span className='text-warning'>
                  {t('settings.wcoreConfig.mcpSession.withdrawNotSent', {
                    defaultValue: 'This chat could not be asked to drop it: {{reason}}',
                    reason: notSent,
                  })}
                </span>
              )}
              {frame === null && notSent === null && (
                <span>
                  {t('settings.wcoreConfig.mcpSession.withdrawPending', {
                    defaultValue: 'Asked this chat’s engine to drop it. Waiting for its answer…',
                  })}
                </span>
              )}
              {frame?.status === 'result' && (
                <>
                  {t('settings.wcoreConfig.mcpSession.withdrawn', {
                    defaultValue: '{{name}}: {{count}} tools withdrawn from the running engine.',
                    name: frame.name,
                    count: frame.removedToolCount,
                  })}
                  {frame.removedTools.length > 0 && (
                    <span className='ml-1 font-mono'>{frame.removedTools.join(', ')}</span>
                  )}
                  {frame.toolsTruncated && (
                    <span className='ml-1 text-t-tertiary'>
                      {t('settings.wcoreConfig.mcpSession.withdrawnTruncated', {
                        defaultValue: '(only the first names are listed)',
                      })}
                    </span>
                  )}
                  {/* The contract puts no enum on `outcome`; the only value it
                      ever exhibits is "removed". Shown verbatim rather than
                      compared against a literal this host invented. */}
                  <span className='ml-1 font-mono text-t-tertiary'>{frame.outcome}</span>
                </>
              )}
              {frame?.status === 'name_mismatch' && (
                <span className='text-warning'>
                  {t('settings.wcoreConfig.mcpSession.withdrawnMismatch', {
                    defaultValue:
                      'The engine answered about “{{reported}}” when asked about “{{requested}}”. Nothing is claimed about either.',
                    reported: frame.reportedName,
                    requested: frame.requestedName,
                  })}
                </span>
              )}
              {frame?.status === 'undecodable' && (
                <span className='text-warning'>
                  {t('settings.wcoreConfig.mcpSession.withdrawnUndecodable', {
                    defaultValue: 'The engine answered in a shape this build cannot read: {{detail}}',
                    detail: frame.detail,
                  })}
                  {/* The engine's own offending text, which the handler keeps
                      out of the log and puts in the frame precisely so it can be
                      shown to the user who asked. `detail` alone describes the
                      shape; this is the value. */}
                  {frame.offending !== undefined && (
                    <span className='ml-1 font-mono'>
                      {t('settings.wcoreConfig.mcpSession.withdrawnOffending', {
                        defaultValue: 'engine sent: {{value}}',
                        value: frame.offending,
                      })}
                    </span>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className='mcp-status-strip'>
        <div className='mcp-status-cell mcp-status-running'>
          <b>{summary.running}</b> {t('mcpLibrary.installed.statusRunningCountLabel', 'Running')}
        </div>
        <div className='mcp-status-cell mcp-status-warn'>
          <b>{summary.warn}</b> {t('mcpLibrary.installed.statusReauthCountLabel', 'Needs re-auth')}
        </div>
        <div className='mcp-status-cell mcp-status-error'>
          <b>{summary.error}</b> {t('mcpLibrary.installed.statusErrorCountLabel', 'Error')}
        </div>
        <div className='mcp-status-cell'>
          <b>{summary.tools}</b> {t('mcpLibrary.installed.statusToolCountLabel', 'Tools available')}
        </div>
      </div>

      <section>
        <header className='mcp-group-head'>
          <h3>{t('mcpLibrary.installed.fromLibrary', 'From Library')}</h3>
          <button onClick={() => navigate('/settings/mcp-library/browse')}>
            {t('mcpLibrary.installed.browseLibrary', '+ Browse library')}
          </button>
        </header>
        {fromLibrary.length === 0 ? (
          <div className='mcp-empty'>
            {t('mcpLibrary.installed.empty', 'No MCPs installed yet. Browse the library to add one.')}
          </div>
        ) : (
          <div className='mcp-server-list'>{fromLibrary.map(renderRow)}</div>
        )}
      </section>

      <section>
        <header className='mcp-group-head'>
          <h3>{t('mcpLibrary.installed.custom', 'Custom')}</h3>
          <button onClick={() => setShowAddModal(true)}>
            {t('mcpLibrary.installed.addCustom', '+ Add custom MCP')}
          </button>
        </header>
        {custom.length === 0 ? (
          <div className='mcp-empty'>{t('mcpLibrary.installed.customEmpty', 'No custom MCPs.')}</div>
        ) : (
          <div className='mcp-server-list'>{custom.map(renderRow)}</div>
        )}
      </section>

      <AddMcpServerModal
        visible={showAddModal}
        onCancel={() => setShowAddModal(false)}
        onSubmit={handleAddSubmit}
        onBatchImport={handleAddBatch}
      />
    </div>
  );
}
