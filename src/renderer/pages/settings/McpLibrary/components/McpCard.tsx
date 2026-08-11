import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Plus } from 'lucide-react';
import type { CatalogIndexEntry } from '../types';
import { TierBadge } from './TierBadge';
import { MaintainerBadge } from './MaintainerBadge';

interface Props {
  entry: CatalogIndexEntry;
  installed: boolean;
  onClick: () => void;
}

export function McpCard({ entry, installed, onClick }: Props) {
  const { t } = useTranslation();
  const isWaylandBuilt = entry.maintainerType === 'wayland';
  return (
    <div
      className={`mcp-card ${installed ? 'is-installed' : ''} ${isWaylandBuilt ? 'is-wayland-built' : ''}`}
      onClick={onClick}
      role='button'
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className='mcp-card-top'>
        <img className='mcp-card-logo' src={entry.iconUrl} alt='' />
        <div className='mcp-card-meta'>
          <div className='mcp-card-name'>
            {entry.name}
            {entry.verifiedByWayland && <Check className='mcp-card-verified-tick' size={13} />}
          </div>
          <div className='mcp-card-publisher'>{entry.id}</div>
        </div>
      </div>
      <div className='mcp-card-desc'>{entry.shortDescription}</div>
      <div className='mcp-card-tags'>
        <TierBadge tier={entry.tier} />
        <MaintainerBadge type={entry.maintainerType} />
      </div>
      <div className='mcp-card-footer'>
        <button
          className={`mcp-install-btn ${installed ? 'is-installed' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          {/* The two states reuse the install-flow keys already shipped in
              every locale rather than minting card-only duplicates. */}
          {installed ? (
            <>
              <Check size={12} /> {t('mcpLibrary.install.installed', 'Installed')}
            </>
          ) : (
            <>
              <Plus size={12} /> {t('mcpLibrary.install.button', 'Install')}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
