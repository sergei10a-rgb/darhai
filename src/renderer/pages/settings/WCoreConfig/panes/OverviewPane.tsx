/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRight, BookOpen, Brain, Globe, Link2, Server, Shield, Sparkles, Users, Wrench, Zap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { useModelRegistry } from '@/renderer/hooks/useModelRegistry';
import styles from './Panes.module.css';

/** Total provider catalog size: the headline "104 catalog" figure. */
const CATALOG_SIZE = 104;
/** The engine's default profile, as written to disk by wayland-core. */
const DEFAULT_PROFILE_PATH = '~/.darhai/profiles/default';

type OverviewPaneProps = {
  /** Engine version for the VERSION stat card (live, else the pinned build). */
  version: string;
};

/** A single read-only "inherited from Desktop" row with a deep-link back. */
type InheritRow = {
  key: string;
  icon: React.ReactElement;
  name: string;
  /** Pre-resolved detail string (real data where available). */
  detail: string;
  /** Desktop settings route to deep-link into. */
  target: string;
};

/** Title-case a provider id for display (e.g. `openai` -> `OpenAI`). */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  google: 'Gemini',
};
const labelProvider = (id: string): string =>
  PROVIDER_LABELS[id.toLowerCase()] ?? id.charAt(0).toUpperCase() + id.slice(1);

const OverviewPane: React.FC<OverviewPaneProps> = ({ version }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [engineAvailable, setEngineAvailable] = useState<boolean | null>(null);
  const { providers } = useModelRegistry();

  useEffect(() => {
    void ipcBridge.acpConversation.getAvailableAgents.invoke().then((result) => {
      if (result.success) {
        setEngineAvailable(result.data.some((a) => a.backend === 'wcore'));
      }
    });
  }, []);

  const goDesktop = (route: string): void => {
    void navigate(`/settings/${route}`, { replace: true });
  };

  const providerCount = providers.length;

  // Honesty relabel: distinguish what the engine ACTUALLY receives from Desktop
  // this session (Models override, Skills + Assistants/Constitution via system
  // prompt) from what it does NOT (the user's Desktop MCP Library; only
  // Дархай's own operational MCPs are injected).
  const allocatedLabel = t('settings.wcoreConfig.overview.allocatedSession', {
    defaultValue: 'Allocated by Desktop · this session',
  });

  const inheritRows: InheritRow[] = useMemo(() => {
    // Model providers: real connected provider names + the catalog headline.
    const providerNames = providers.map((p) => labelProvider(p.providerId)).slice(0, 4);
    const modelsDetail =
      providerCount > 0
        ? t('settings.wcoreConfig.overview.inheritModelsDetail', {
            defaultValue: '{{names}} + {{catalog}} catalog · {{allocated}}',
            names: providerNames.join(', '),
            catalog: CATALOG_SIZE,
            allocated: allocatedLabel,
          })
        : t('settings.wcoreConfig.overview.inheritModelsEmpty', {
            defaultValue: '{{catalog}} provider catalog · {{allocated}}',
            catalog: CATALOG_SIZE,
            allocated: allocatedLabel,
          });

    return [
      {
        key: 'models',
        icon: <Sparkles size={16} />,
        name: t('settings.wcoreConfig.overview.inheritModels', { defaultValue: 'Models (override)' }),
        detail: modelsDetail,
        target: 'models',
      },
      {
        key: 'skills',
        icon: <Zap size={16} />,
        name: t('settings.wcoreConfig.overview.inheritSkills', { defaultValue: 'Skills' }),
        detail: t('settings.wcoreConfig.overview.skillsDetail', {
          defaultValue: 'Injected via system prompt · {{allocated}}',
          allocated: allocatedLabel,
        }),
        target: 'skills',
      },
      {
        key: 'assistants',
        icon: <BookOpen size={16} />,
        name: t('settings.wcoreConfig.overview.inheritAssistants', { defaultValue: 'Assistants & Constitution' }),
        detail: t('settings.wcoreConfig.overview.assistantsDetail', {
          defaultValue: 'Injected via system prompt · {{allocated}}',
          allocated: allocatedLabel,
        }),
        target: 'assistants',
      },
      {
        key: 'mcp',
        icon: <Server size={16} />,
        name: t('settings.wcoreConfig.overview.inheritMcp', { defaultValue: 'MCP Servers' }),
        detail: t('settings.wcoreConfig.overview.mcpDetail', {
          defaultValue: 'Дархай operational MCPs · your Desktop MCP library is separate',
        }),
        target: 'mcp-library/installed',
      },
    ];
  }, [providers, providerCount, allocatedLabel, t]);

  const stopped = engineAvailable === false;

  return (
    <div className={styles.pane}>
      {/* Pane head */}
      <div className={styles.head}>
        <div className={styles.eyebrow}>{t('settings.wcoreConfig.title', { defaultValue: 'Darhai Core' })}</div>
        <h1 className={styles.title}>{t('settings.wcoreConfig.overview.title', { defaultValue: 'Overview' })}</h1>
        <p className={styles.sub}>
          {t('settings.wcoreConfig.overview.subtitle', {
            defaultValue:
              'The engine behind every chat, workflow and agent. It is already running with smart defaults. This surface is where you tune what is under the hood.',
          })}
        </p>
      </div>

      {/* Engine status strip: 3 stat cards */}
      <div className={styles.statusStrip}>
        <div className={styles.statusCard}>
          <div className={styles.scLabel}>
            {t('settings.wcoreConfig.overview.scEngine', { defaultValue: 'Engine' })}
          </div>
          <div className={styles.scValue}>
            <span className={stopped ? `${styles.liveDot} ${styles.stopped}` : styles.liveDot} />
            {stopped
              ? t('settings.wcoreConfig.overview.scEngineStopped', { defaultValue: 'Stopped' })
              : t('settings.wcoreConfig.overview.scEngineRunning', { defaultValue: 'Running' })}
          </div>
          <div className={styles.scMeta}>
            {t('settings.wcoreConfig.overview.scEngineMeta', { defaultValue: 'embedded · spawned in-process' })}
          </div>
        </div>
        <div className={styles.statusCard}>
          <div className={styles.scLabel}>
            {t('settings.wcoreConfig.overview.scVersion', { defaultValue: 'Version' })}
          </div>
          <div className={styles.scValue}>
            <span className={styles.scValueMono}>{version}</span>
          </div>
          <div className={styles.scMeta}>
            {t('settings.wcoreConfig.overview.scVersionMeta', { defaultValue: 'wayland-core · pinned' })}
          </div>
        </div>
        <div className={styles.statusCard}>
          <div className={styles.scLabel}>
            {t('settings.wcoreConfig.overview.scProfile', { defaultValue: 'Active Profile' })}
          </div>
          <div className={styles.scValue}>
            {t('settings.wcoreConfig.overview.scProfileDefault', { defaultValue: 'Default' })}
          </div>
          <div className={`${styles.scMeta} ${styles.scMetaMono}`}>{DEFAULT_PROFILE_PATH}</div>
        </div>
      </div>

      {/* Inherited from Дархай Desktop (read-only, deep-links back) */}
      <div className={styles.section}>
        <div className={styles.inheritCard}>
          <div className={styles.inheritHead}>
            <Link2 size={19} />
            <div>
              <div className={styles.ihTitle}>
                {t('settings.wcoreConfig.overview.inheritedTitle', {
                  defaultValue: 'Allocated by Дархай Desktop',
                })}
              </div>
              <div className={styles.ihBody}>
                {t('settings.wcoreConfig.overview.inheritedBody', {
                  defaultValue:
                    'For this session, Desktop hands the engine your model (as an override) and injects Skills + Assistants/Constitution through its system prompt. Your Desktop MCP library is NOT passed through; only Дархай’s own operational MCPs are.',
                })}
              </div>
            </div>
          </div>

          {inheritRows.map((row) => (
            <div key={row.key} className={styles.inheritRow}>
              <span className={styles.inheritIcon}>{row.icon}</span>
              <div>
                <div className={styles.inheritName}>
                  {row.name}
                  <span className={styles.readOnlyTag}>
                    {t('settings.wcoreConfig.overview.readOnly', { defaultValue: 'read-only' })}
                  </span>
                </div>
                <div className={styles.inheritDetail}>{row.detail}</div>
              </div>
              <div
                role='button'
                tabIndex={0}
                onClick={() => goDesktop(row.target)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    goDesktop(row.target);
                  }
                }}
                className={styles.manageLink}
              >
                {t('settings.wcoreConfig.overview.manageInDesktop', {
                  defaultValue: 'Manage in Desktop Settings',
                })}
                <ArrowRight size={12} />
              </div>
            </div>
          ))}

          <div className={styles.engineOwnedLine}>
            {t('settings.wcoreConfig.overview.engineOwnedLine', {
              defaultValue:
                'Tools, Memory, Security and Profiles are the engine’s own: written to ~/.wayland-core/config.toml and shared with the Darhai Core CLI.',
            })}
          </div>
        </div>
      </div>

      {/* Configured in the engine: smart-defaults strip */}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>
            {t('settings.wcoreConfig.overview.configuredLabel', { defaultValue: 'Configured in the engine' })}
          </span>
          <span className={styles.pill}>
            {t('settings.wcoreConfig.overview.smartDefaults', { defaultValue: 'smart defaults active' })}
          </span>
          <span className={styles.sectionHeadLine} />
        </div>
        <div className={styles.statChipsRow}>
          <span className={styles.statChip}>
            <Wrench size={11} />
            {t('settings.wcoreConfig.overview.chipToolsOn', { defaultValue: 'tools on' })}
          </span>
          <span className={styles.statChip}>
            <Globe size={11} />
            {t('settings.wcoreConfig.overview.chipWebSearch', { defaultValue: 'web search' })}{' '}
            <b>{t('settings.wcoreConfig.overview.chipWebSearchVal', { defaultValue: 'DuckDuckGo' })}</b>
          </span>
          <span className={styles.statChip}>
            <Brain size={11} />
            {t('settings.wcoreConfig.overview.chipMemory', { defaultValue: 'memory' })}{' '}
            <b>{t('settings.wcoreConfig.overview.chipMemoryVal', { defaultValue: 'on · local' })}</b>
          </span>
          <span className={styles.statChip}>
            <Shield size={11} />
            {t('settings.wcoreConfig.overview.chipApprovals', { defaultValue: 'approvals' })}{' '}
            <b>{t('settings.wcoreConfig.overview.chipApprovalsVal', { defaultValue: 'Auto-edit' })}</b>
          </span>
          <span className={styles.statChip}>
            <Users size={11} />
            {t('settings.wcoreConfig.overview.chipProfiles', { defaultValue: 'profiles configured' })}
          </span>
        </div>
        <div className={styles.hintText}>
          {t('settings.wcoreConfig.overview.deeperHint', {
            defaultValue:
              'Everything above ships working. Open Tools, Services & Keys, or Security on the left to go deeper, or leave it; the engine just runs.',
          })}
        </div>
      </div>
    </div>
  );
};

export default OverviewPane;
