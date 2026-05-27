import React, { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Check, ExternalLink } from 'lucide-react';
import { useMcpLibrary } from './hooks/useMcpLibrary';
import { useMcpServers } from '@renderer/hooks/mcp/useMcpServers';
import { SetupGuide } from './components/SetupGuide';
import { TierBadge } from './components/TierBadge';
import { MaintainerBadge } from './components/MaintainerBadge';

type Tab = 'overview' | 'setup-guide' | 'tools' | 'permissions' | 'changelog';

// Plan-shaped server record. The fields source/libraryEntryId are formally
// added in P8 — for P7 we read them through an `any` cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibraryServer = any;

export function DetailPage() {
  const { entryId } = useParams<{ entryId: string }>();
  const id = decodeURIComponent(entryId ?? '');
  const navigate = useNavigate();
  const library = useMcpLibrary();
  const { mcpServers } = useMcpServers();

  const entry = useMemo(() => library.getEntry(id), [library, id]);
  const guide = useMemo(
    () => (entry?.['x-wayland'].setupGuide ? library.getGuide(id) : null),
    [library, id, entry],
  );
  const installed = mcpServers.some((s: LibraryServer) => s.libraryEntryId === id);

  const [tab, setTab] = useState<Tab>('setup-guide');
  const [env, setEnv] = useState<Record<string, string>>({});

  if (!entry) return <div className="mcp-detail-page">Unknown entry: {id}</div>;

  const w = entry['x-wayland'];

  // P8 wires real install/oauth/etc. through the existing useMcpServerCRUD +
  // useMcpOAuth hooks (which both require parameters that P7 doesn't have
  // wired up yet). For now we accept the callbacks but no-op them — the
  // SetupGuide still mutates the local env state, which is the visible UI.
  const install = () => {
    // P8: addServer({ id: entry.name, command: pkg.runtimeHint, args: [pkg.identifier],
    //   env, source: 'library', libraryEntryId: entry.name } as any);
  };

  const onPrimary = (_action: string) => {
    // P8: delegate to useMcpOAuth.login(server) when action === 'oauth-flow'.
  };

  return (
    <div className="mcp-detail-page">
      <button
        className="mcp-back"
        onClick={() => navigate('/settings/mcp-library/browse')}
      >
        ← MCP Library
      </button>

      <header className="mcp-detail-head">
        <img className="mcp-detail-logo" src={w.iconUrl} alt="" />
        <div>
          <h1>{entry.title}</h1>
          {w.verifiedAt && (
            <span className="mcp-verified-pill">
              <Check size={12} /> Wayland verified
            </span>
          )}
          <div className="mcp-detail-pub">
            <a href={entry.websiteUrl} target="_blank" rel="noreferrer">
              {entry.name}
            </a>{' '}
            · v{entry.version} · {w.license ?? '—'}
          </div>
          <p className="mcp-detail-tagline">{entry.description}</p>
        </div>
        <div className="mcp-detail-actions">
          <button
            className="mcp-btn-primary"
            onClick={install}
            disabled={installed}
          >
            {installed ? 'Installed' : 'Install'}
          </button>
          {entry.websiteUrl && (
            <a
              className="mcp-btn"
              href={entry.websiteUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={12} /> View source
            </a>
          )}
        </div>
      </header>

      <div className="mcp-tabs">
        {(['overview', 'setup-guide', 'tools', 'permissions', 'changelog'] as Tab[]).map(
          (t) => (
            <button
              key={t}
              className={`mcp-tab ${tab === t ? 'is-active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t.replace('-', ' ').replace(/^./, (c) => c.toUpperCase())}
            </button>
          ),
        )}
      </div>

      <div className="mcp-detail-body">
        {tab === 'setup-guide' && guide && (
          <SetupGuide
            guide={guide}
            envValues={env}
            onEnvChange={(name, value) =>
              setEnv((prev) => ({ ...prev, [name]: value }))
            }
            onPrimary={onPrimary}
          />
        )}
        {tab === 'tools' && (
          <ul className="mcp-tool-groups">
            {w.toolGroups?.map((g) => (
              <li key={g.label}>
                <b>{g.label}</b> · {g.count} tools
              </li>
            ))}
          </ul>
        )}
        {tab === 'permissions' && w.auth.scopes && (
          <ul className="mcp-scope-list">
            {w.auth.scopes.map((s) => (
              <li key={s.name}>
                <code>{s.name}</code> — {s.plainLanguage}
              </li>
            ))}
          </ul>
        )}
        {tab === 'overview' && (
          <div className="mcp-overview">
            <div>
              <TierBadge tier={w.tier} /> <MaintainerBadge type={w.maintainerType} />
            </div>
            <dl>
              <dt>Transport</dt>
              <dd>{entry.packages[0].transport.type}</dd>
              <dt>Runtime</dt>
              <dd>{entry.packages[0].runtimeHint}</dd>
              <dt>Platforms</dt>
              <dd>{(w.platforms ?? ['all']).join(', ')}</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
