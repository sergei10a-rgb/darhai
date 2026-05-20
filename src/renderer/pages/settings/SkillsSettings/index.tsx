/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Input } from '@arco-design/web-react';
import { Download, Sparkles } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso } from 'react-virtuoso';
import { ipcBridge } from '@/common';
import type { SkillStats } from '@/common/adapter/ipcBridge';
import type { SkillIndexEntry, SkillSource, SkillVerdict } from '@/common/types/skillTypes';
import SettingsPageShell from '@renderer/pages/settings/components/SettingsPageShell';
import BuildSkillModal from './BuildSkillModal';
import FilterRail from './FilterRail';
import LibraryHealth from './LibraryHealth';
import SkillDetailDrawer from './SkillDetailDrawer';
import SkillRow from './SkillRow';
import './SkillsSettings.module.css';

const SkillsSettings: React.FC = () => {
  const { t } = useTranslation(undefined, { keyPrefix: 'skills' });

  const [entries, setEntries] = useState<SkillIndexEntry[]>([]);
  const [stats, setStats] = useState<SkillStats | null>(null);
  const [pinnedNames, setPinnedNames] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [buildModalVisible, setBuildModalVisible] = useState(false);

  // Filter rail state — empty set = all selected (no filter applied)
  const [selectedSources, setSelectedSources] = useState<Set<SkillSource>>(new Set());
  const [selectedVerdicts, setSelectedVerdicts] = useState<Set<SkillVerdict>>(new Set());
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());

  // Detail drawer state
  const [selectedSkill, setSelectedSkill] = useState<SkillIndexEntry | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const fetchData = useCallback(async () => {
    const [list, s] = await Promise.all([
      ipcBridge.skills.list.invoke(),
      ipcBridge.skills.stats.invoke(),
    ]);
    setEntries(list);
    setStats(s);
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const filtered = useMemo(() => {
    let result = entries;

    // Text search
    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        (e) => e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)
      );
    }

    // Source filter (empty = show all)
    if (selectedSources.size > 0) {
      result = result.filter((e) => selectedSources.has(e.source));
    }

    // Verdict filter (empty = show all)
    if (selectedVerdicts.size > 0) {
      result = result.filter((e) =>
        selectedVerdicts.has(e.security?.verdict ?? 'unscanned')
      );
    }

    // Category filter (empty = show all)
    if (selectedCategories.size > 0) {
      result = result.filter(
        (e) => e.metadata.category != null && selectedCategories.has(e.metadata.category)
      );
    }

    return result;
  }, [entries, query, selectedSources, selectedVerdicts, selectedCategories]);

  const handleTogglePin = useCallback(async (name: string, pinned: boolean) => {
    // Optimistic update
    setPinnedNames((prev) => {
      const next = new Set(prev);
      if (pinned) next.add(name);
      else next.delete(name);
      return next;
    });
    try {
      await ipcBridge.skills.setPinned.invoke({ name, pinned });
      const s = await ipcBridge.skills.stats.invoke();
      setStats(s);
    } catch {
      // Revert on failure
      setPinnedNames((prev) => {
        const next = new Set(prev);
        if (pinned) next.delete(name);
        else next.add(name);
        return next;
      });
    }
  }, []);

  const handleRowClick = useCallback((entry: SkillIndexEntry) => {
    setSelectedSkill(entry);
    setDrawerOpen(true);
  }, []);

  const handleDrawerClose = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  const renderRow = useCallback(
    (_index: number, entry: SkillIndexEntry) => (
      <SkillRow
        key={entry.name}
        entry={entry}
        pinned={pinnedNames.has(entry.name)}
        onTogglePin={handleTogglePin}
        onClick={handleRowClick}
      />
    ),
    [pinnedNames, handleTogglePin, handleRowClick]
  );

  return (
    <SettingsPageShell
      title={t('title')}
      subtitle={t('lede', 'Everything your agent can do. One library — built in, imported, and discovered from your other CLI tools. Skills load only when a task needs them, so a library this size never costs you context.')}
      contentClassName='md:max-w-[1200px]'
    >
      <LibraryHealth stats={stats} />

      {/* Notice banner — explains the pinned/auto model so users don't try to
          toggle every skill on/off. Mirrors the mockup's amber-bordered hint
          ("You don't switch skills on and off ..."). Renders only once the
          library is loaded so a fresh install doesn't show a stat-free banner. */}
      {(stats?.total ?? 0) > 0 ? (
        <div
          className='rd-10px px-14px py-10px text-12px flex items-start gap-10px'
          style={{
            background: 'rgba(233,164,14,0.10)',
            border: '1px solid rgba(233,164,14,0.34)',
            color: 'var(--text-secondary)',
          }}
        >
          <span style={{ color: 'var(--warning, #e9a40e)', fontSize: 16, lineHeight: 1 }}>⚡</span>
          <span>
            {t(
              'banner.howItWorks',
              "You don't switch skills on and off. Wayland reads each task and loads the skills that fit — out of all your skills. Pin the handful you always want at hand; leave the rest to us.",
            )}
          </span>
        </div>
      ) : null}

      <div className='flex items-center gap-10px'>
        <Input.Search
          placeholder={t('search.placeholder')}
          value={query}
          onChange={(v) => setQuery(v)}
          style={{ flex: 1, maxWidth: 'unset' }}
          allowClear
        />
        <Button
          type='secondary'
          icon={<Download size={14} />}
          onClick={() => {
            // TODO: B12 wiring — open the existing import flow (folder/git/zip/single-md
            // already provided via ipcBridge.skills.import.*). The button is here so
            // the page matches the mockup affordance; the modal is a future follow-up.
            // eslint-disable-next-line no-alert
            window.alert(
              'Import flow is wired via IPC (folder / git / zip / single SKILL.md). The picker UI ships in the next pass.'
            );
          }}
        >
          {t('actions.import', 'Import skills')}
        </Button>
        <Button
          type='primary'
          icon={<Sparkles size={14} />}
          onClick={() => setBuildModalVisible(true)}
        >
          {t('actions.build')}
        </Button>
      </div>

      <BuildSkillModal
        visible={buildModalVisible}
        onClose={() => setBuildModalVisible(false)}
        onSaved={() => { void fetchData(); setBuildModalVisible(false); }}
      />

      <div
        className='skills-shell rd-12px overflow-hidden flex'
        style={{
          background: 'var(--fill-1)',
          border: '1px solid var(--border-1)',
        }}
      >
        <FilterRail
          entries={entries}
          selectedSources={selectedSources}
          selectedVerdicts={selectedVerdicts}
          selectedCategories={selectedCategories}
          onSourcesChange={setSelectedSources}
          onVerdictsChange={setSelectedVerdicts}
          onCategoriesChange={setSelectedCategories}
        />

        <div
          className='flex-1 min-w-0 flex flex-col'
          style={{ background: 'var(--bg)' }}
        >
          {/* Row-list header — count + filter summary, mirrors the mockup's
              "2,047 skills · showing all sources" affordance. */}
          {filtered.length > 0 ? (
            <div
              className='flex items-center justify-between px-16px py-10px text-11px uppercase font-semibold'
              style={{
                borderBottom: '1px solid var(--border-1)',
                color: 'var(--text-tertiary)',
                letterSpacing: '0.08em',
              }}
            >
              <span>
                {filtered.length.toLocaleString()} {filtered.length === 1 ? 'skill' : 'skills'}
              </span>
            </div>
          ) : null}

          {filtered.length === 0 ? (
            <div
              className='text-center text-13px py-40px'
              style={{ color: 'var(--text-secondary)' }}
            >
              {query.trim()
                ? t('search.empty')
                : entries.length === 0
                  ? t('search.emptyLibrary', 'No skills loaded yet — try importing one.')
                  : t('search.empty')}
            </div>
          ) : (
            <Virtuoso
              className='skills-virtuoso'
              style={{ height: Math.min(filtered.length * 84, 640) }}
              totalCount={filtered.length}
              data={filtered}
              itemContent={renderRow}
            />
          )}
        </div>
      </div>

      <SkillDetailDrawer
        entry={selectedSkill}
        open={drawerOpen}
        onClose={handleDrawerClose}
        onTogglePin={handleTogglePin}
      />
    </SettingsPageShell>
  );
};

export default SkillsSettings;
