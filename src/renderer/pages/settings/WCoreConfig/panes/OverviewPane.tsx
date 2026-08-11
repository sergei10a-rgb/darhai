/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Brain, Globe, Link2, Server, Shield, Sparkles, Users, Wrench, Zap } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { useModelRegistry } from '@/renderer/hooks/useModelRegistry';
import { useEngineConfigPath } from '../components/useEngineConfigPath';
import { useEngineStatus } from '../components/useEngineStatus';
import styles from './Panes.module.css';
import type { EngineCapabilityFrame, EngineCapabilityHealth, EngineCapabilityRow } from './types';

/** Total provider catalog size: the headline "104 catalog" figure. */
const CATALOG_SIZE = 104;

/** The readiness record for ONE engine process. */
type CapabilityRecord = {
  /**
   * The conversation whose engine produced these rows.
   *
   * Kept because a second engine process is a second answer to the same
   * question. Blending two processes' outcomes into one table would let a
   * capability that failed in a dead session keep accusing a healthy one.
   *
   * `null` means the rows came from the main process's RETAINED record rather
   * than from frames this pane watched arrive. That record is reset on every
   * engine `ready`, so it always describes exactly one engine - Darhai just
   * cannot say which conversation it belongs to.
   *
   * A live frame arriving while the record is still unattributed is therefore
   * NOT folded in and NOT thrown away: whether those rows are this engine's own
   * earlier words or a dead engine's is a question only the main process can
   * answer, so the record is re-read instead of guessed at. See the stream
   * subscription below.
   */
  conversationId: string | null;
  rows: EngineCapabilityRow[];
};

/** What the mount-time pull found, before any live frame. */
type SnapshotState = {
  /** False until the main process answers; the table says "reading", not "empty". */
  settled: boolean;
  /** False until some engine published a `ready` in this app run. */
  contractKnown: boolean;
  /** True when the engine announced more capabilities than the record holds. */
  overflowed: boolean;
};

const CAPABILITY_HEALTHS: ReadonlySet<string> = new Set<EngineCapabilityHealth>(['ok', 'declined', 'changed']);

/**
 * A `capability_activation` frame, or null.
 *
 * The main process already validated these fields; this re-check exists because
 * `IResponseMessage.data` is `unknown` at the IPC seam and a renderer that
 * trusts it renders `undefined` into a table cell.
 */
function readCapabilityFrame(data: unknown): EngineCapabilityFrame | null {
  if (typeof data !== 'object' || data === null) return null;
  const frame = data as Record<string, unknown>;
  const { capability, stage, reason, health, remedy } = frame;
  if (typeof capability !== 'string' || capability.length === 0) return null;
  if (typeof stage !== 'string' || stage.length === 0) return null;
  if (typeof health !== 'string' || !CAPABILITY_HEALTHS.has(health)) return null;
  return {
    capability,
    stage,
    reason: typeof reason === 'string' && reason.length > 0 ? reason : null,
    health: health as EngineCapabilityHealth,
    remedy: remedy === 'config' || remedy === 'not_configurable' ? remedy : 'unknown',
  };
}

/**
 * Styling keys off `health`, never off `stage`.
 *
 * The stage set is open - a host comparing against the literal `'unavailable'`
 * is one engine bump away from silently painting a declined capability green.
 */
function healthClass(health: EngineCapabilityHealth): string {
  if (health === 'declined') return 'text-danger font-medium';
  if (health === 'changed') return 'text-warning font-medium';
  return 'text-success font-medium';
}

/** Fold one row in, last-write-wins per capability, first-seen order. */
function foldRow(base: readonly EngineCapabilityRow[], row: EngineCapabilityRow): EngineCapabilityRow[] {
  const at = base.findIndex((existing) => existing.capability === row.capability);
  if (at === -1) return [...base, row];
  const rows = base.slice();
  rows[at] = row;
  return rows;
}

/** Fold one frame into the record, last-write-wins per capability, first-seen order. */
function foldCapabilityFrame(
  previous: CapabilityRecord | null,
  conversationId: string,
  frame: EngineCapabilityFrame
): CapabilityRecord {
  const base = previous !== null && previous.conversationId === conversationId ? previous.rows : [];
  return { conversationId, rows: foldRow(base, frame) };
}

/**
 * Lay live rows over rows just read from the retained record.
 *
 * Both describe the same engine at that point - the record is re-read BECAUSE a
 * frame from a live engine arrived - so the only question is ordering, and a
 * frame this pane watched arrive is by definition not older than the record it
 * raced. Merging rather than replacing is what keeps the seven capabilities an
 * engine is NOT re-announcing when it revises the eighth.
 */
function mergeCapabilityRows(
  base: readonly EngineCapabilityRow[],
  newer: readonly EngineCapabilityRow[]
): EngineCapabilityRow[] {
  let rows = base.slice();
  for (const row of newer) rows = foldRow(rows, row);
  return rows;
}

/**
 * Rows from the main process's retained record.
 *
 * The health/remedy unions are re-narrowed rather than trusted: the bridge types
 * them as `string` (the main process grades them, the renderer's unions are a
 * copy), and a widened member reaching a `Record<Health, string>` lookup renders
 * `undefined` into a table cell.
 */
function readSnapshotRows(
  rows: readonly { capability: string; stage: string; reason: string | null; health: string; remedy: string }[]
): EngineCapabilityRow[] {
  const out: EngineCapabilityRow[] = [];
  for (const row of rows) {
    if (typeof row.capability !== 'string' || row.capability.length === 0) continue;
    if (typeof row.stage !== 'string' || row.stage.length === 0) continue;
    if (!CAPABILITY_HEALTHS.has(row.health)) continue;
    out.push({
      capability: row.capability,
      stage: row.stage,
      reason: typeof row.reason === 'string' && row.reason.length > 0 ? row.reason : null,
      health: row.health as EngineCapabilityHealth,
      remedy: row.remedy === 'config' || row.remedy === 'not_configurable' ? row.remedy : 'unknown',
    });
  }
  return out;
}

type OverviewPaneProps = {
  /**
   * The PINNED build, used only when no engine has reported a version.
   *
   * It is a fallback, not the answer: the pane reads the live semver from
   * `wcoreEngine.liveness` and labels the card so a reading is never mistaken
   * for the constant this prop carries.
   */
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
  // Whether an engine is RUNNING and which build it reported, both read from
  // the main process. This card used to ask `getAvailableAgents`, which answers
  // "does Darhai ship the Core backend" (always yes, no version) - so it said
  // "Running · <pinned constant>" with no engine process alive, while the
  // Runtime pane one click away correctly said no chat was open.
  const engine = useEngineStatus();
  // The ACTIVE profile, read rather than assumed. This card used to hardcode
  // "Default" and the path `~/.darhai/profiles/default` - wrong twice over: a
  // user on a named profile was told they were on the default one, and the
  // default profile does not live under `profiles/` at all (it maps to the
  // engine's native config dir). `list` already reports the real `dir`.
  const [activeProfile, setActiveProfile] = useState<{ name: string; dir?: string } | null>(null);
  const engineConfigPath = useEngineConfigPath();
  const { providers } = useModelRegistry();
  const [capabilities, setCapabilities] = useState<CapabilityRecord | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotState>({ settled: false, contractKnown: false, overflowed: false });

  /** Alive across the pane's life, so a late answer never sets state on a corpse. */
  const mounted = useRef(true);
  /** Newest pull wins; an earlier answer arriving late is dropped, not applied. */
  const pullSeq = useRef(0);
  /** True while the table shows the retained record and no live frame has replaced it. */
  const showingRetained = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Read the main process's retained readiness record.
   *
   * `attributeTo === null` is the MOUNT-TIME PULL, and the reason this table is
   * not permanently empty. Every `capability_activation` frame is emitted once
   * per engine process START - which happens while the user is in a chat, i.e.
   * while this pane is unmounted (`/conversation/:id` and
   * `/settings/wcore-config` are sibling routes). Subscribing alone means
   * subscribing after the only frames that will ever be sent, forever.
   *
   * A conversation id means the RE-READ: a live frame arrived while the table
   * still showed unattributed rows, so the record is read again and adopted
   * under the engine that spoke.
   */
  const pullRecord = useCallback((attributeTo: string | null, fallback: EngineCapabilityFrame | null): void => {
    const seq = ++pullSeq.current;
    ipcBridge.wcoreEngine.capabilitySnapshot
      .invoke()
      .then((result) => {
        if (!mounted.current || seq !== pullSeq.current) return;
        setSnapshot({
          settled: true,
          contractKnown: result.contractKnown === true,
          overflowed: result.overflowed === true,
        });
        const rows = readSnapshotRows(Array.isArray(result.activation) ? result.activation : []);
        if (attributeTo === null) {
          if (rows.length === 0) return;
          // Seeded under `null`, never under a conversation id this pane made
          // up, and only while nothing else has filled the table - a frame that
          // arrived during the pull is newer than what the pull returned.
          setCapabilities((previous) => {
            if (previous !== null) return previous;
            showingRetained.current = true;
            return { conversationId: null, rows };
          });
          return;
        }
        setCapabilities((previous) => {
          const live = previous !== null && previous.conversationId === attributeTo ? previous.rows : [];
          return { conversationId: attributeTo, rows: mergeCapabilityRows(rows, live) };
        });
      })
      .catch(() => {
        if (!mounted.current || seq !== pullSeq.current) return;
        // The record is unreadable. On mount the table says so via `settled`
        // rather than claiming the engine announced nothing; on a re-read the
        // frame that triggered it must still land, so it is folded in alone -
        // exactly what this pane did before the record could be re-read at all.
        setSnapshot((previous) => ({ ...previous, settled: true }));
        if (fallback !== null && attributeTo !== null) {
          setCapabilities((previous) => foldCapabilityFrame(previous, attributeTo, fallback));
        }
      });
  }, []);

  // The engine announces its own capability activation at every start - one
  // frame per lifecycle step, MEASURED at 24 frames over 8 capabilities on
  // v0.12.26. Darhai used to drop all of them, so `delegate_isolation:
  // isolation_not_enforced` - the engine stating that delegate isolation is NOT
  // being enforced, on a product that advertises sub-agents - was invisible.
  //
  // The subscription also covers what the mount pull cannot: an engine that
  // starts while Settings is already open.
  useEffect(() => {
    return ipcBridge.conversation.responseStream.on((message) => {
      if (message.type !== 'capability_activation') return;
      const frame = readCapabilityFrame(message.data);
      if (frame === null) return;
      if (showingRetained.current) {
        // The rows on screen belong to no conversation, so this frame can
        // neither be folded into them (that blends two engines when a new one
        // started) nor replace them (that drops the seven capabilities an
        // engine is not re-announcing while it revises the eighth -
        // `outcome_changed` and `health: 'changed'` exist precisely for that).
        // `CapabilityActivationRecord.accept` runs BEFORE the frame is emitted,
        // so the main process already holds the answer, this frame included.
        showingRetained.current = false;
        pullRecord(message.conversation_id, frame);
        return;
      }
      setCapabilities((previous) => foldCapabilityFrame(previous, message.conversation_id, frame));
    });
  }, [pullRecord]);

  useEffect(() => {
    pullRecord(null, null);
  }, [pullRecord]);

  useEffect(() => {
    let alive = true;
    ipcBridge.wcoreProfiles.list
      .invoke()
      .then((list) => {
        const active = Array.isArray(list) ? list.find((p) => p.active) : undefined;
        if (alive && active) setActiveProfile({ name: active.name, dir: active.dir });
      })
      .catch(() => {
        // Card falls back to the config path below; never invent a profile.
      });
    return () => {
      alive = false;
    };
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

  // Three states, not two: before the read lands, "Stopped" would be as
  // invented as "Running" was.
  const stopped = engine.settled && engine.engines === 0;
  // The engine's own semver when one reported it, the pinned build otherwise -
  // and the card SAYS which of the two it is showing.
  const liveVersion = engine.engineVersion.length > 0;
  const versionLabel = liveVersion ? engine.engineVersion : version;

  const capabilityRows = capabilities?.rows ?? [];

  const healthLabel = (health: EngineCapabilityHealth): string => {
    if (health === 'declined')
      return t('settings.wcoreConfig.overview.engineCaps.healthDeclined', { defaultValue: 'declined' });
    if (health === 'changed')
      return t('settings.wcoreConfig.overview.engineCaps.healthChanged', { defaultValue: 'outcome changed' });
    return t('settings.wcoreConfig.overview.engineCaps.healthOk', { defaultValue: 'active' });
  };

  /** Known reason tokens get a sentence; anything else is shown verbatim. */
  const reasonLabel = (reason: string): string => {
    const known: Record<string, string> = {
      disabled_by_config: t('settings.wcoreConfig.overview.engineCaps.reasonDisabledByConfig', {
        defaultValue: 'Turned off by configuration.',
      }),
      dependency_unavailable: t('settings.wcoreConfig.overview.engineCaps.reasonDependencyUnavailable', {
        defaultValue: 'Something it depends on is missing.',
      }),
      no_production_constructor: t('settings.wcoreConfig.overview.engineCaps.reasonNoProductionConstructor', {
        defaultValue: 'This engine build ships no working implementation of it.',
      }),
      runtime_path_unwired: t('settings.wcoreConfig.overview.engineCaps.reasonRuntimePathUnwired', {
        defaultValue: 'Built, but nothing in the engine calls it yet.',
      }),
      isolation_not_enforced: t('settings.wcoreConfig.overview.engineCaps.reasonIsolationNotEnforced', {
        defaultValue: 'Isolation is NOT being enforced on this platform.',
      }),
    };
    return known[reason] ?? reason;
  };

  /**
   * `config` does NOT mean Darhai knows which key. Only `smart_handoff`'s gate
   * was ever identified by measurement (`[compact] smart_enabled`, wired on the
   * Memory pane); `pricing_refresher` and `learned_policy` report the same token
   * with a key 20+ measured candidates failed to find. So the hint points at the
   * config file and stops - it never promises a switch that does not exist.
   */
  const remedyLabel = (remedy: EngineCapabilityRow['remedy']): string => {
    if (remedy === 'config')
      return t('settings.wcoreConfig.overview.engineCaps.remedyConfig', {
        defaultValue: 'A config key can turn it back on.',
      });
    if (remedy === 'not_configurable')
      return t('settings.wcoreConfig.overview.engineCaps.remedyNotConfigurable', {
        defaultValue: 'Not a setting - no switch to offer.',
      });
    return t('settings.wcoreConfig.overview.engineCaps.remedyUnknown', {
      defaultValue: 'Darhai does not know whether this is fixable.',
    });
  };

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
          <div className={styles.scValue} data-testid='engine-state'>
            <span className={stopped ? `${styles.liveDot} ${styles.stopped}` : styles.liveDot} />
            {!engine.settled
              ? t('settings.wcoreConfig.overview.scEngineChecking', { defaultValue: 'Checking…' })
              : stopped
                ? t('settings.wcoreConfig.overview.scEngineStopped', { defaultValue: 'Stopped' })
                : t('settings.wcoreConfig.overview.scEngineRunning', { defaultValue: 'Running' })}
          </div>
          <div className={styles.scMeta}>
            {/* The engine is spawned per chat, so "stopped" has a cause worth
                naming - and it is the same fact the Runtime pane states when
                its diagnostics button has nobody to ask. */}
            {stopped
              ? t('settings.wcoreConfig.overview.scEngineMetaIdle', {
                  defaultValue: 'no Darhai Core chat is open',
                })
              : t('settings.wcoreConfig.overview.scEngineMeta', { defaultValue: 'embedded · spawned in-process' })}
          </div>
        </div>
        <div className={styles.statusCard}>
          <div className={styles.scLabel}>
            {t('settings.wcoreConfig.overview.scVersion', { defaultValue: 'Version' })}
          </div>
          <div className={styles.scValue}>
            <span className={styles.scValueMono} data-testid='engine-version'>
              {versionLabel}
            </span>
          </div>
          <div className={styles.scMeta} data-testid='engine-version-meta'>
            {/* Names the product, not the upstream binary - and says whether the
                number above is a READING or the build Darhai was pinned to.
                Printing "pinned build" under a live semver, or the pinned
                constant under a label that promised a reading, are the same
                lie in opposite directions. */}
            {liveVersion
              ? t('settings.wcoreConfig.overview.scVersionMetaLive', {
                  defaultValue: 'Darhai Core · reported by the engine',
                })
              : t('settings.wcoreConfig.overview.scVersionMeta', { defaultValue: 'Darhai Core · pinned build' })}
          </div>
        </div>
        <div className={styles.statusCard}>
          <div className={styles.scLabel}>
            {t('settings.wcoreConfig.overview.scProfile', { defaultValue: 'Active Profile' })}
          </div>
          <div className={styles.scValue} data-testid='active-profile-name'>
            {activeProfile?.name ?? t('settings.wcoreConfig.overview.scProfileDefault', { defaultValue: 'Default' })}
          </div>
          <div className={`${styles.scMeta} ${styles.scMetaMono}`} data-testid='active-profile-dir'>
            {activeProfile?.dir ?? engineConfigPath ?? ''}
          </div>
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
              // Real path from the main process - it varies by platform AND by
              // active profile. Falls back to the bare filename, never to a
              // guessed location.
              path: engineConfigPath ?? 'config.toml',
              defaultValue:
                'Tools, Memory, Security and Profiles are the engine’s own: written to {{path}} and shared with the Darhai Core CLI.',
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

      {/* What the ENGINE says about itself, from `capability_activation`. */}
      <div className={styles.section} data-testid='engine-capabilities'>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>
            {t('settings.wcoreConfig.overview.engineCaps.title', { defaultValue: 'Engine capability readiness' })}
          </span>
          <span className={styles.sectionHeadLine} />
        </div>
        <div className={styles.hintText}>
          {t('settings.wcoreConfig.overview.engineCaps.body', {
            defaultValue:
              'Reported by the engine itself as it starts. A capability the engine declined is shown as declined - not as broken, and not as working.',
          })}
        </div>
        {snapshot.overflowed && (
          <div className='text-warning mt-1 text-xs' data-testid='engine-capabilities-overflowed'>
            {t('settings.wcoreConfig.overview.engineCaps.overflowed', {
              defaultValue: 'The engine announced more capabilities than Darhai retains; this table is incomplete.',
            })}
          </div>
        )}
        {capabilityRows.length === 0 ? (
          <div className={styles.emptyHint} data-testid='engine-capabilities-empty'>
            {/* Three different facts, never collapsed into one sentence: the
                record has not been read yet, no engine has ever spoken, or an
                engine spoke and announced nothing. Only the middle one is worth
                telling the user to open a chat about. */}
            {!snapshot.settled ? (
              <div>
                {t('settings.wcoreConfig.overview.engineCaps.loading', {
                  defaultValue: 'Reading what the engine reported…',
                })}
              </div>
            ) : snapshot.contractKnown ? (
              <div>
                {t('settings.wcoreConfig.overview.engineCaps.emptySilent', {
                  defaultValue: 'An engine started in this session but announced no capability readiness.',
                })}
              </div>
            ) : (
              <>
                <div>
                  {t('settings.wcoreConfig.overview.engineCaps.empty', {
                    defaultValue: 'The engine has not announced its capabilities yet.',
                  })}
                </div>
                <div className='text-t-tertiary mt-1'>
                  {t('settings.wcoreConfig.overview.engineCaps.emptyHint', {
                    defaultValue: 'They arrive when an engine process starts. Open a Darhai Core chat and come back.',
                  })}
                </div>
              </>
            )}
          </div>
        ) : (
          <table className='w-full border-collapse text-xs' data-testid='engine-capabilities-table'>
            <thead>
              <tr className='text-left text-t-tertiary'>
                <th className='py-1.5 pr-3 font-medium'>
                  {t('settings.wcoreConfig.overview.engineCaps.colCapability', { defaultValue: 'Capability' })}
                </th>
                <th className='py-1.5 pr-3 font-medium'>
                  {t('settings.wcoreConfig.overview.engineCaps.colStage', { defaultValue: 'Stage' })}
                </th>
                <th className='py-1.5 font-medium'>
                  {t('settings.wcoreConfig.overview.engineCaps.colDetail', { defaultValue: 'What that means' })}
                </th>
              </tr>
            </thead>
            <tbody>
              {capabilityRows.map((row) => (
                <tr key={row.capability} className='border-t border-b-light align-top'>
                  <td className='py-1.5 pr-3 font-mono text-t-primary'>{row.capability}</td>
                  <td className='py-1.5 pr-3'>
                    <span className={healthClass(row.health)}>{healthLabel(row.health)}</span>
                    <span className='ml-1.5 font-mono text-t-tertiary'>{row.stage}</span>
                  </td>
                  <td className='py-1.5 text-t-secondary'>
                    {row.reason === null ? (
                      <span className='text-t-tertiary'>
                        {t('settings.wcoreConfig.overview.engineCaps.noReason', {
                          defaultValue: 'The engine stated no reason.',
                        })}
                      </span>
                    ) : (
                      <>
                        <span>{reasonLabel(row.reason)}</span>
                        <span className='ml-1.5 text-t-tertiary'>{remedyLabel(row.remedy)}</span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default OverviewPane;
