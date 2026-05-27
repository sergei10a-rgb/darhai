import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMcpServers } from '@renderer/hooks/mcp/useMcpServers';
import { useMcpLibrary } from './hooks/useMcpLibrary';
import { ServerRow } from './components/ServerRow';

// P7 introduces the InstalledPage shell with grouping (library vs custom).
// Full CRUD/OAuth/agent-status wiring happens in P8 — at this stage these are
// no-ops so the page renders without throwing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Server = any;

const noop = () => {
  /* P8 hook */
};

export function InstalledPage() {
  const navigate = useNavigate();
  const { mcpServers } = useMcpServers();
  const library = useMcpLibrary();

  const fromLibrary = useMemo(
    () => mcpServers.filter((s: Server) => s.source === 'library'),
    [mcpServers],
  );
  const custom = useMemo(
    () => mcpServers.filter((s: Server) => s.source !== 'library'),
    [mcpServers],
  );

  const summary = {
    running: 0,
    warn: 0,
    error: 0,
    tools: mcpServers.reduce(
      (n: number, s: Server) => n + ((s as Server).toolCount ?? 0),
      0,
    ),
  };

  const renderRow = (s: Server) => {
    const entry = s.libraryEntryId
      ? library.entries.find((e) => e.id === s.libraryEntryId)
      : undefined;
    return (
      <ServerRow
        key={s.id}
        server={{
          id: s.id,
          source: s.source,
          libraryEntryId: s.libraryEntryId,
          status: s.status ?? 'stopped',
          toolCount: s.toolCount,
          publisher: entry?.id,
          oauthState: s.oauthState,
        }}
        iconUrl={entry?.iconUrl}
        onReauth={noop}
        onSettings={noop}
        onRemove={noop}
        onToggle={noop}
        onLogs={noop}
      />
    );
  };

  return (
    <div className="mcp-installed-page">
      <header className="mcp-page-head">
        <h2>MCP Library — Installed</h2>
        <button className="mcp-btn-primary" onClick={noop}>
          + Add custom MCP
        </button>
      </header>

      <div className="mcp-status-strip">
        <div className="mcp-status-cell mcp-status-running">
          <b>{summary.running}</b> Running
        </div>
        <div className="mcp-status-cell mcp-status-warn">
          <b>{summary.warn}</b> Needs re-auth
        </div>
        <div className="mcp-status-cell mcp-status-error">
          <b>{summary.error}</b> Error
        </div>
        <div className="mcp-status-cell">
          <b>{summary.tools}</b> Tools available
        </div>
      </div>

      <section>
        <header className="mcp-group-head">
          <h3>From Library</h3>
          <button onClick={() => navigate('/settings/mcp-library/browse')}>
            + Browse library
          </button>
        </header>
        {fromLibrary.length === 0 ? (
          <div className="mcp-empty">No library MCPs installed yet.</div>
        ) : (
          <div className="mcp-server-list">{fromLibrary.map(renderRow)}</div>
        )}
      </section>

      <section>
        <header className="mcp-group-head">
          <h3>Custom</h3>
          <button onClick={noop}>+ Add custom MCP</button>
        </header>
        {custom.length === 0 ? (
          <div className="mcp-empty">No custom MCPs.</div>
        ) : (
          <div className="mcp-server-list">{custom.map(renderRow)}</div>
        )}
      </section>
    </div>
  );
}
