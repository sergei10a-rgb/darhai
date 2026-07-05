/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, FileText, Lock } from 'lucide-react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { useWcoreConfig } from '@renderer/hooks/useWcoreConfig';
import WcSwitch from '../components/WcSwitch';
import WcSegmented from '../components/WcSegmented';
import ScopeLabel from '../components/ScopeLabel';
import styles from './Panes.module.css';

/**
 * One engine tool backend. `needsKey` marks a tool whose backend requires a
 * credential set under Services & Keys; `keyState` lets the chip show "on" once
 * a key is present (representative here; see CATALOG note below).
 */
type ToolDef = {
  id: string;
  descKey: string;
  descDefault: string;
  /** Shows a "needs key / needs auth" chip that deep-links to Services & Keys. */
  needsKey?: 'key' | 'auth';
  /** When the backend's key is already satisfied (e.g. the free web_search default). */
  keySatisfied?: boolean;
};

type ToolCategory = {
  id: 'file' | 'web' | 'media' | 'dev' | 'prod' | 'agent';
  labelKey: string;
  labelDefault: string;
  tools: readonly ToolDef[];
};

/**
 * REPRESENTATIVE engine tool catalogue. The embedded engine does not expose its
 * built-in tool list to the Desktop process programmatically, so this grouped
 * list mirrors the engine's ~46 documented built-in tools (and the approved
 * mockup-v3). The enable/disable STATE is real, read from / written to
 * `config.toml [tools].allow_list`; only the catalogue of available tool NAMES
 * is static. An empty/absent `allow_list` means "all tools on" (engine default),
 * so the UI seeds every tool on until the user revokes one.
 */
const CATEGORIES: readonly ToolCategory[] = [
  {
    id: 'file',
    labelKey: 'settings.wcoreConfig.tools.catFile',
    labelDefault: 'File & Code',
    tools: [
      { id: 'read', descKey: 'settings.wcoreConfig.tools.descRead', descDefault: 'Read any file in the workspace' },
      { id: 'write', descKey: 'settings.wcoreConfig.tools.descWrite', descDefault: 'Create or overwrite files' },
      { id: 'edit', descKey: 'settings.wcoreConfig.tools.descEdit', descDefault: 'Surgical string-replace edits' },
      { id: 'glob', descKey: 'settings.wcoreConfig.tools.descGlob', descDefault: 'Find files by pattern' },
      { id: 'grep', descKey: 'settings.wcoreConfig.tools.descGrep', descDefault: 'Search file contents by regex' },
      { id: 'bash', descKey: 'settings.wcoreConfig.tools.descBash', descDefault: 'Run shell commands in the sandbox' },
      {
        id: 'script',
        descKey: 'settings.wcoreConfig.tools.descScript',
        descDefault: 'Execute multi-line scripts (python/node)',
      },
    ],
  },
  {
    id: 'web',
    labelKey: 'settings.wcoreConfig.tools.catWeb',
    labelDefault: 'Web',
    tools: [
      {
        id: 'web_search',
        descKey: 'settings.wcoreConfig.tools.descWebSearch',
        descDefault: 'Search the web · free default, add a key for high volume',
        needsKey: 'key',
        keySatisfied: true,
      },
      {
        id: 'web_fetch',
        descKey: 'settings.wcoreConfig.tools.descWebFetch',
        descDefault: 'Fetch & read a URL as clean markdown',
      },
    ],
  },
  {
    id: 'media',
    labelKey: 'settings.wcoreConfig.tools.catMedia',
    labelDefault: 'Vision & Media',
    tools: [
      {
        id: 'vision_analyze',
        descKey: 'settings.wcoreConfig.tools.descVision',
        descDefault: 'Describe & reason over images',
      },
      {
        id: 'image_gen',
        descKey: 'settings.wcoreConfig.tools.descImageGen',
        descDefault: 'Generate images from a prompt',
        needsKey: 'key',
      },
      {
        id: 'transcribe',
        descKey: 'settings.wcoreConfig.tools.descTranscribe',
        descDefault: 'Speech & audio to text (Whisper)',
        needsKey: 'key',
      },
      { id: 'tts', descKey: 'settings.wcoreConfig.tools.descTts', descDefault: 'Text to speech · Piper (local)' },
      { id: 'pdf', descKey: 'settings.wcoreConfig.tools.descPdf', descDefault: 'Extract text & tables from PDFs' },
      { id: 'video', descKey: 'settings.wcoreConfig.tools.descVideo', descDefault: 'Sample & analyze video frames' },
    ],
  },
  {
    id: 'dev',
    labelKey: 'settings.wcoreConfig.tools.catDev',
    labelDefault: 'Dev',
    tools: [
      { id: 'git', descKey: 'settings.wcoreConfig.tools.descGit', descDefault: 'Stage, commit, branch, diff' },
      { id: 'github', descKey: 'settings.wcoreConfig.tools.descGithub', descDefault: 'PRs, issues, releases' },
      {
        id: 'gitlab',
        descKey: 'settings.wcoreConfig.tools.descGitlab',
        descDefault: 'Merge requests & pipelines',
        needsKey: 'key',
      },
      { id: 'kubectl', descKey: 'settings.wcoreConfig.tools.descKubectl', descDefault: 'Inspect & manage Kubernetes' },
      { id: 'aws', descKey: 'settings.wcoreConfig.tools.descAws', descDefault: 'AWS CLI operations' },
      { id: 'gcloud', descKey: 'settings.wcoreConfig.tools.descGcloud', descDefault: 'Google Cloud CLI operations' },
      {
        id: 'postgres',
        descKey: 'settings.wcoreConfig.tools.descPostgres',
        descDefault: 'Run SQL against your database',
        needsKey: 'key',
      },
    ],
  },
  {
    id: 'prod',
    labelKey: 'settings.wcoreConfig.tools.catProd',
    labelDefault: 'Productivity',
    tools: [
      {
        id: 'notion',
        descKey: 'settings.wcoreConfig.tools.descNotion',
        descDefault: 'Read & write Notion pages',
        needsKey: 'key',
      },
      { id: 'linear', descKey: 'settings.wcoreConfig.tools.descLinear', descDefault: 'Create & update Linear issues' },
      {
        id: 'discord',
        descKey: 'settings.wcoreConfig.tools.descDiscord',
        descDefault: 'Send messages to channels',
        needsKey: 'key',
      },
      {
        id: 'spotify',
        descKey: 'settings.wcoreConfig.tools.descSpotify',
        descDefault: 'Control playback & playlists',
        needsKey: 'auth',
      },
      {
        id: 'google_meet',
        descKey: 'settings.wcoreConfig.tools.descMeet',
        descDefault: 'Schedule & join meetings',
      },
      {
        id: 'homeassistant',
        descKey: 'settings.wcoreConfig.tools.descHass',
        descDefault: 'Control smart-home devices',
        needsKey: 'key',
      },
      { id: 'cron', descKey: 'settings.wcoreConfig.tools.descCron', descDefault: 'Schedule recurring agent runs' },
    ],
  },
  {
    id: 'agent',
    labelKey: 'settings.wcoreConfig.tools.catAgent',
    labelDefault: 'Agent',
    tools: [
      {
        id: 'delegate',
        descKey: 'settings.wcoreConfig.tools.descDelegate',
        descDefault: 'Spawn sub-agents for parallel work',
      },
      { id: 'todo', descKey: 'settings.wcoreConfig.tools.descTodo', descDefault: 'Track multi-step task progress' },
      {
        id: 'session_search',
        descKey: 'settings.wcoreConfig.tools.descSessionSearch',
        descDefault: 'Search past sessions & transcripts',
      },
      { id: 'memory', descKey: 'settings.wcoreConfig.tools.descMemory', descDefault: 'Read & write long-term memory' },
    ],
  },
];

/** Every known tool id, used to seed "all on" when allow_list is absent. */
const ALL_TOOL_IDS: readonly string[] = CATEGORIES.flatMap((c) => c.tools.map((t) => t.id));

type FilterKey = 'all' | ToolCategory['id'];

type ToolsPaneProps = {
  /** Deep-link to the Services & Keys pane (for needs-key chips). */
  onGoServices: () => void;
};

const ToolsPane: React.FC<ToolsPaneProps> = ({ onGoServices }) => {
  const { t } = useTranslation();
  const { getSection, setSection } = useWcoreConfig();
  const [filter, setFilter] = useState<FilterKey>('all');
  // `null` until loaded. A Set of enabled tool ids. Absent allow_list => all on.
  const [enabled, setEnabled] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getSection<{ allow_list?: string[] }>('tools').then((section) => {
      if (cancelled) return;
      const list = section?.allow_list;
      // An absent/empty allow_list means the engine runs every tool (default).
      setEnabled(new Set(Array.isArray(list) && list.length > 0 ? list : ALL_TOOL_IDS));
    });
    return () => {
      cancelled = true;
    };
  }, [getSection]);

  const persist = useCallback(
    (next: Set<string>): void => {
      // Persist the full allow_list (names only). We merge into the existing
      // section so unknown engine keys (auto_approve, skills, ...) survive.
      void getSection<Record<string, unknown>>('tools').then((prev) => {
        void setSection('tools', { ...prev, allow_list: Array.from(next).sort() });
      });
    },
    [getSection, setSection]
  );

  const toggle = useCallback(
    (id: string): void => {
      setEnabled((cur) => {
        const next = new Set(cur ?? ALL_TOOL_IDS);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        persist(next);
        return next;
      });
    },
    [persist]
  );

  const filters = useMemo(
    () =>
      [
        { value: 'all', label: t('settings.wcoreConfig.tools.filterAll', { defaultValue: 'All' }) },
        ...CATEGORIES.map((c) => ({ value: c.id, label: t(c.labelKey, { defaultValue: c.labelDefault }) })),
      ] as const,
    [t]
  );

  const visibleCats = filter === 'all' ? CATEGORIES : CATEGORIES.filter((c) => c.id === filter);
  const on = enabled ?? new Set<string>(ALL_TOOL_IDS);

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <div className={styles.eyebrow}>Darhai Core</div>
        <h1 className={styles.title}>{t('settings.wcoreConfig.rail.tools', { defaultValue: 'Tools' })}</h1>
        <p className={styles.sub}>
          {t('settings.wcoreConfig.tools.subtitle', {
            defaultValue:
              'Everything the engine can actually do, with sensible defaults already on. Toggle a tool to grant or revoke it across all profiles. Tools that need a credential link straight to where you set it.',
          })}
        </p>
        <ScopeLabel />
      </div>

      <div style={{ marginBottom: 8 }}>
        <WcSegmented
          options={filters}
          value={filter}
          onChange={(v) => setFilter(v as FilterKey)}
          label={t('settings.wcoreConfig.tools.filterLabel', { defaultValue: 'Filter tools by category' })}
        />
      </div>

      {visibleCats.map((cat) => {
        const onCount = cat.tools.filter((tool) => on.has(tool.id)).length;
        return (
          <div key={cat.id} className={styles.toolCat}>
            <div className={styles.toolCatLabel}>
              {t(cat.labelKey, { defaultValue: cat.labelDefault })}
              <span className={styles.toolCatCount}>
                {t('settings.wcoreConfig.tools.catCount', {
                  defaultValue: '{{total}} tools · {{on}} on',
                  total: cat.tools.length,
                  on: onCount,
                })}
              </span>
            </div>
            <div className={styles.group}>
              {cat.tools.map((tool) => (
                <div key={tool.id} className={styles.toolRow}>
                  <div>
                    <div className={styles.toolName}>
                      {tool.id}
                      {tool.needsKey &&
                        (tool.keySatisfied ? (
                          <span
                            role='button'
                            tabIndex={0}
                            onClick={onGoServices}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onGoServices();
                              }
                            }}
                            className={classNames(styles.chipKey, styles.ok)}
                          >
                            <Check size={9} />
                            {t('settings.wcoreConfig.tools.chipOnDdg', { defaultValue: 'on · DuckDuckGo' })}
                          </span>
                        ) : (
                          <span
                            role='button'
                            tabIndex={0}
                            onClick={onGoServices}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                onGoServices();
                              }
                            }}
                            className={styles.chipKey}
                          >
                            <Lock size={9} />
                            {tool.needsKey === 'auth'
                              ? t('settings.wcoreConfig.tools.chipNeedsAuth', { defaultValue: 'needs auth' })
                              : t('settings.wcoreConfig.tools.chipNeedsKey', { defaultValue: 'needs key' })}
                          </span>
                        ))}
                    </div>
                    <div className={styles.toolDesc}>{t(tool.descKey, { defaultValue: tool.descDefault })}</div>
                  </div>
                  <div className={styles.toolCtrl}>
                    <WcSwitch
                      size='xs'
                      checked={on.has(tool.id)}
                      onChange={() => toggle(tool.id)}
                      label={t('settings.wcoreConfig.tools.toggleLabel', {
                        defaultValue: 'Enable {{tool}}',
                        tool: tool.id,
                      })}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div className={styles.scopeLabel} style={{ marginTop: 20 }}>
        <FileText size={13} />
        {t('settings.wcoreConfig.tools.catalogNote', {
          defaultValue:
            'Tool list reflects the engine’s built-in catalogue. Enable/disable state is read from and written to your config.toml.',
        })}
      </div>
    </div>
  );
};

export default ToolsPane;
