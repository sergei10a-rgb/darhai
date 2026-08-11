import React from 'react';
import { useTranslation } from 'react-i18next';
import type { CatalogIndexEntry } from '../types';
import { McpCard } from './McpCard';

const labels: Record<string, string> = {
  communication: 'Communication',
  'files-and-docs': 'Files & Documents',
  calendar: 'Calendar & Scheduling',
  'developer-tools': 'Developer Tools',
  developer: 'Developer Tools',
  code: 'Code & Repos',
  'search-and-web': 'Search & Web',
  search: 'Search & Web',
  personal: 'Personal & Lifestyle',
  productivity: 'Productivity',
  automation: 'Automation',
  browser: 'Browser',
  crm: 'CRM',
  data: 'Data',
  devops: 'DevOps',
  'home-automation': 'Home Automation',
  infrastructure: 'Infrastructure',
  iot: 'IoT',
  knowledge: 'Knowledge',
  media: 'Media',
  news: 'News',
  observability: 'Observability',
  payments: 'Payments',
  research: 'Research',
  sales: 'Sales',
  tasks: 'Tasks',
};

interface Props {
  category: string;
  entries: CatalogIndexEntry[];
  installedIds: Set<string>;
  onSelect: (id: string) => void;
}

export function CategorySection({ category, entries, installedIds, onSelect }: Props) {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <section className='mcp-cat-section'>
      <header className='mcp-cat-head'>
        <h4>{labels[category] ?? category}</h4>
        {/* Plural-suffixed key rather than `{n} entries`: the category can hold
            exactly one connector, and i18next picks the form from the active
            language's Intl.PluralRules category. */}
        <span className='mcp-cat-count'>
          {t('mcpLibrary.browse.entryCount', {
            count: entries.length,
            defaultValue_one: '{{count}} entry',
            defaultValue_other: '{{count}} entries',
          })}
        </span>
      </header>
      <div className='mcp-grid'>
        {entries.map((e) => (
          <McpCard key={e.id} entry={e} installed={installedIds.has(e.id)} onClick={() => onSelect(e.id)} />
        ))}
      </div>
    </section>
  );
}
