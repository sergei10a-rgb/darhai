import React from 'react';
import { useTranslation } from 'react-i18next';
import type { CatalogIndexEntry } from '../types';
import { McpCard } from './McpCard';

interface Props {
  entries: CatalogIndexEntry[];
  installedIds: Set<string>;
  onSelect: (id: string) => void;
}

export function RecommendedGrid({ entries, installedIds, onSelect }: Props) {
  const { t } = useTranslation();
  return (
    <section className='mcp-rec-section'>
      <h3 className='mcp-rec-title'>{t('mcpLibrary.browse.recommendedTitle', '★ Recommended for you')}</h3>
      <div className='mcp-rec-grid'>
        {entries.map((e, i) => (
          <div key={e.id} className='mcp-rec-card-wrap'>
            {/* The share is interpolated rather than suffixed onto the number:
                several locales put the percent sign or the verb first. */}
            <div className='mcp-rec-rank'>
              #{i + 1} ·{' '}
              {t('mcpLibrary.browse.installRate', '{{percent}}% installed', {
                percent: Math.round(e.installRate * 100),
              })}
            </div>
            <McpCard entry={e} installed={installedIds.has(e.id)} onClick={() => onSelect(e.id)} />
          </div>
        ))}
      </div>
    </section>
  );
}
