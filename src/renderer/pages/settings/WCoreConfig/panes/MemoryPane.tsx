/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Slider } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useWcoreConfig } from '@renderer/hooks/useWcoreConfig';
import WcSwitch from '../components/WcSwitch';
import WcSegmented from '../components/WcSegmented';
import ScopeLabel from '../components/ScopeLabel';
import styles from './Panes.module.css';

const PROVIDER_VALUES = ['local', 'honcho', 'mem0'] as const;
type MemoryProvider = (typeof PROVIDER_VALUES)[number];

type MemorySection = {
  enabled?: boolean;
  provider?: string;
  recall_budget?: number;
  auto_consolidate?: boolean;
  [key: string]: unknown;
};

/**
 * The engine's `[compact]` section.
 *
 * `smart_enabled` is the ONE gate identified by measurement: with it set, the
 * engine's `smart_handoff` capability moves from
 * `unavailable / disabled_by_config` to `declared -> configured -> constructed
 * -> ready` in an otherwise-empty isolated home. Without it, smart compaction is
 * off for every Darhai user and the Overview readiness table says so.
 *
 * `smart_handoff_to_memory` is what makes this pane the right home rather than
 * Runtime: the handoff target is long-term memory.
 */
type CompactSection = {
  smart_enabled?: boolean;
  smart_handoff_to_memory?: boolean;
  [key: string]: unknown;
};

const MemoryPane: React.FC = () => {
  const { t } = useTranslation();
  const { getSection, setSection } = useWcoreConfig();
  const [section, setLocal] = useState<MemorySection | null>(null);
  const [compact, setCompact] = useState<CompactSection | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getSection<MemorySection>('memory').then((s) => {
      if (!cancelled) setLocal(s ?? {});
    });
    void getSection<CompactSection>('compact').then((s) => {
      if (!cancelled) setCompact(s ?? {});
    });
    return () => {
      cancelled = true;
    };
  }, [getSection]);

  const persist = useCallback(
    (next: MemorySection): void => {
      setLocal(next);
      void setSection('memory', next);
    },
    [setSection]
  );

  const persistCompact = useCallback(
    (next: CompactSection): void => {
      setCompact(next);
      void setSection('compact', next);
    },
    [setSection]
  );

  const enabled = section?.enabled !== false;
  const provider: MemoryProvider = useMemo(() => {
    const p = section?.provider;
    return (PROVIDER_VALUES as readonly string[]).includes(p ?? '') ? (p as MemoryProvider) : 'local';
  }, [section]);
  const budget = typeof section?.recall_budget === 'number' ? section.recall_budget : 5000;
  const autoConsolidate = section?.auto_consolidate !== false;
  // MEASURED default: absent means OFF. `!== false` (the idiom used above for
  // options the engine defaults ON) would draw this switch on while the engine
  // reports the capability `disabled_by_config`.
  const smartCompaction = compact?.smart_enabled === true;
  const smartHandoffToMemory = compact?.smart_handoff_to_memory === true;

  const providerOptions = useMemo(
    () => [
      {
        value: 'local',
        label: t('settings.wcoreConfig.memory.providerLocal', { defaultValue: 'Local (SQLite + BM25)' }),
      },
      { value: 'honcho', label: t('settings.wcoreConfig.memory.providerHoncho', { defaultValue: 'Honcho' }) },
      { value: 'mem0', label: t('settings.wcoreConfig.memory.providerMem0', { defaultValue: 'Mem0' }) },
    ],
    [t]
  );

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <div className={styles.eyebrow}>Darhai Core</div>
        <h1 className={styles.title}>{t('settings.wcoreConfig.rail.memory', { defaultValue: 'Memory' })}</h1>
        <p className={styles.sub}>
          {t('settings.wcoreConfig.memory.subtitle', {
            defaultValue:
              'The engine remembers across sessions: facts, preferences, and project context that persist and compound. On by default, stored locally.',
          })}
        </p>
        <ScopeLabel />
      </div>

      <div className={styles.section}>
        <div className={styles.group}>
          <div className={styles.listRow}>
            <div>
              <div className={styles.lrLabel}>
                {t('settings.wcoreConfig.memory.longTerm', { defaultValue: 'Long-term memory' })}
              </div>
              <div className={styles.lrDesc}>
                {t('settings.wcoreConfig.memory.longTermDesc', { defaultValue: 'Persist learnings between sessions' })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <WcSwitch
                checked={enabled}
                onChange={(next) => persist({ ...section, enabled: next })}
                label={t('settings.wcoreConfig.memory.longTerm', { defaultValue: 'Long-term memory' })}
              />
            </div>
          </div>

          <div className={styles.listRow}>
            <div>
              <div className={styles.lrLabel}>
                {t('settings.wcoreConfig.memory.provider', { defaultValue: 'Provider' })}
              </div>
              <div className={styles.lrDesc}>
                {t('settings.wcoreConfig.memory.providerDesc', {
                  defaultValue: 'Where memories are stored & recalled · local by default',
                })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <WcSegmented
                options={providerOptions}
                value={provider}
                onChange={(v) => persist({ ...section, provider: v })}
                label={t('settings.wcoreConfig.memory.provider', { defaultValue: 'Provider' })}
              />
            </div>
          </div>

          <div className={styles.listRow}>
            <div>
              <div className={styles.lrLabel}>
                {t('settings.wcoreConfig.memory.recallBudget', { defaultValue: 'Recall budget' })}
              </div>
              <div className={styles.lrDesc}>
                {t('settings.wcoreConfig.memory.recallBudgetDesc', {
                  defaultValue: 'Max tokens of memory injected per turn',
                })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <div className={styles.sliderWrap}>
                <Slider
                  min={500}
                  max={8000}
                  step={500}
                  value={budget}
                  style={{ flex: 1, minWidth: 180 }}
                  onChange={(v) => persist({ ...section, recall_budget: Number(v) })}
                />
                <span className={styles.sliderVal}>
                  {t('settings.wcoreConfig.memory.tokensVal', {
                    defaultValue: '{{count}} tokens',
                    count: budget,
                  })}
                </span>
              </div>
            </div>
          </div>

          <div className={styles.listRow}>
            <div>
              <div className={styles.lrLabel}>
                {t('settings.wcoreConfig.memory.autoConsolidate', { defaultValue: 'Auto-consolidate' })}
              </div>
              <div className={styles.lrDesc}>
                {t('settings.wcoreConfig.memory.autoConsolidateDesc', {
                  defaultValue: 'Nightly dream-cycle: promote patterns, prune stale',
                })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <WcSwitch
                checked={autoConsolidate}
                onChange={(next) => persist({ ...section, auto_consolidate: next })}
                label={t('settings.wcoreConfig.memory.autoConsolidate', { defaultValue: 'Auto-consolidate' })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Engine `[compact]`: smart compaction, off by default. */}
      <div className={styles.section} data-testid='smart-compaction'>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>
            {t('settings.wcoreConfig.memory.compactionLabel', { defaultValue: 'Context compaction' })}
          </span>
          <span className={styles.sectionHeadLine} />
        </div>
        <div className={styles.group}>
          <div className={styles.listRow}>
            <div>
              <div className={styles.lrLabel}>
                {t('settings.wcoreConfig.memory.smartCompaction', { defaultValue: 'Smart compaction' })}
              </div>
              <div className={styles.lrDesc}>
                {t('settings.wcoreConfig.memory.smartCompactionDesc', {
                  defaultValue:
                    'Let the engine shrink a long conversation on its own instead of running the context to the limit. Off unless you turn it on.',
                })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <WcSwitch
                checked={smartCompaction}
                onChange={(next) => persistCompact({ ...compact, smart_enabled: next })}
                label={t('settings.wcoreConfig.memory.smartCompaction', { defaultValue: 'Smart compaction' })}
              />
            </div>
          </div>

          <div className={styles.listRow}>
            <div>
              <div className={styles.lrLabel}>
                {t('settings.wcoreConfig.memory.smartHandoff', { defaultValue: 'Hand compacted context to memory' })}
              </div>
              <div className={styles.lrDesc}>
                {smartCompaction
                  ? t('settings.wcoreConfig.memory.smartHandoffDesc', {
                      defaultValue: 'What is compacted away is written to long-term memory instead of dropped.',
                    })
                  : /* MEASURED: this key alone changes nothing - `smart_enabled`
                       is what activates the capability. Saying so is better than
                       an enabled switch that silently does nothing. */
                    t('settings.wcoreConfig.memory.smartHandoffGated', {
                      defaultValue: 'Does nothing until smart compaction is on.',
                    })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <WcSwitch
                checked={smartCompaction && smartHandoffToMemory}
                disabled={!smartCompaction}
                onChange={(next) => persistCompact({ ...compact, smart_handoff_to_memory: next })}
                label={t('settings.wcoreConfig.memory.smartHandoff', {
                  defaultValue: 'Hand compacted context to memory',
                })}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MemoryPane;
