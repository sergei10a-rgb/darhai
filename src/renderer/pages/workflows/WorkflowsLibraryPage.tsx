/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WorkflowsLibraryPage — step #5 of the Skills/Workflows/Assistants split.
 *
 * Workflows used to live on the Skills page tagged `source:'wayland-library'`,
 * which made the page feel like a soup of "things the agent does" and
 * "recipes the user picks." This page is the new home for procedure-shaped,
 * user-invoked automation: the 107 vendored `type:'workflow'` entries from
 * the FoundrySkills bundle, plus any future imported or team-contributed
 * workflows.
 *
 * First cut surfaces a search box and a grid of WorkflowCards. Clicking a
 * card opens WorkflowDetailModal, which surfaces the workflow body and the
 * two affordances that justify the split: **Launch** (start a new chat
 * with the workflow loaded as the agent's first directive — wired in a
 * later iteration) and **Schedule** (open the existing Create Scheduled
 * Task modal with this workflow pre-filled — wired in step #6).
 *
 * Both buttons render as placeholders for now so the visible nav + detail
 * flow can land independently of the modal/launch wiring.
 */

import { Input } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { SkillIndexEntry } from '@/common/types/skillTypes';
import WorkflowCard from './WorkflowCard';
import WorkflowDetailModal from './WorkflowDetailModal';

const WorkflowsLibraryPage: React.FC = () => {
  const { t } = useTranslation(undefined, { keyPrefix: 'workflows' });

  const [workflows, setWorkflows] = useState<SkillIndexEntry[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SkillIndexEntry | null>(null);

  useEffect(() => {
    void ipcBridge.skills.list.invoke({ type: 'workflow' }).then((list) => setWorkflows(list));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workflows;
    return workflows.filter(
      (w) => w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q),
    );
  }, [workflows, query]);

  const handleCardClick = useCallback((entry: SkillIndexEntry) => {
    setSelected(entry);
  }, []);

  return (
    <div
      className='size-full overflow-y-auto px-32px py-24px'
      style={{ background: 'var(--bg)' }}
    >
      <div className='max-w-[1200px] mx-auto flex flex-col gap-20px'>
        <header>
          <h1
            className='text-24px font-semibold m-0'
            style={{ color: 'var(--text-primary)' }}
          >
            {t('title', 'Workflows')}
          </h1>
          <p
            className='text-14px mt-6px m-0'
            style={{ color: 'var(--text-secondary)' }}
          >
            {t(
              'subtitle',
              'Step-by-step recipes you can launch in one click or schedule to run automatically. Pick a workflow, choose your engine, and the agent will walk you through it.',
            )}
          </p>
        </header>

        <div className='flex items-center gap-12px'>
          <Input.Search
            placeholder={t('search.placeholder', 'Search workflows…')}
            value={query}
            onChange={(v) => setQuery(v)}
            style={{ flex: 1, maxWidth: 'unset' }}
            allowClear
          />
          <div className='text-12px shrink-0' style={{ color: 'var(--text-tertiary)' }}>
            {t('count', '{{count}} workflow available', { count: filtered.length })}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div
            className='text-center text-13px py-40px'
            style={{ color: 'var(--text-secondary)' }}
          >
            {query.trim()
              ? t('search.empty', 'No workflows match your search')
              : t(
                  'search.emptyLibrary',
                  'No workflows loaded yet. The bundled library will populate at next restart.',
                )}
          </div>
        ) : (
          <div
            className='grid gap-12px'
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
          >
            {filtered.map((w) => (
              <WorkflowCard key={w.name} entry={w} onClick={handleCardClick} />
            ))}
          </div>
        )}

        <WorkflowDetailModal entry={selected} onClose={() => setSelected(null)} />
      </div>
    </div>
  );
};

export default WorkflowsLibraryPage;
