import React from 'react';
import { Check, Settings, Trash2, FileText, LogIn } from 'lucide-react';

interface Server {
  id: string;
  source?: 'library' | 'custom';
  libraryEntryId?: string;
  status: 'running' | 'warn' | 'error' | 'stopped';
  toolCount?: number;
  publisher?: string;
  oauthState?: 'ok' | 'expired';
}

interface Props {
  server: Server;
  iconUrl?: string;
  onReauth: () => void;
  onSettings: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onLogs: () => void;
}

export function ServerRow({
  server,
  iconUrl,
  onReauth,
  onSettings,
  onRemove,
  onToggle,
  onLogs,
}: Props) {
  return (
    <div className={`mcp-server-row mcp-server-${server.status}`}>
      <img className="mcp-server-logo" src={iconUrl ?? 'icons/generic.svg'} alt="" />
      <div className="mcp-server-main">
        <div className="mcp-server-name">{server.id}</div>
        <div className="mcp-server-pub">{server.publisher ?? ''}</div>
      </div>
      <div className="mcp-server-stats">{server.toolCount ?? 0} tools</div>
      <div className="mcp-server-status">
        <span className={`mcp-status-pill mcp-status-${server.status}`}>
          <span className="mcp-dot" /> {server.status}
        </span>
      </div>
      <div className="mcp-server-actions">
        <button onClick={onToggle} title="Enable/disable">
          <Check size={15} />
        </button>
        {server.oauthState === 'expired' && (
          <button onClick={onReauth} className="mcp-btn-warn">
            <LogIn size={15} /> Re-authorize
          </button>
        )}
        <button onClick={onSettings} title="Edit env">
          <Settings size={15} />
        </button>
        <button onClick={onLogs} title="Logs">
          <FileText size={15} />
        </button>
        <button onClick={onRemove} title="Remove" className="mcp-danger">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}
