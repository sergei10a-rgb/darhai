/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Slider } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ConfigStorage } from '@/common/config/storage';
import { useWcoreConfig } from '@renderer/hooks/useWcoreConfig';
import WcSwitch from '../components/WcSwitch';
import WcSegmented from '../components/WcSegmented';
import ScopeLabel from '../components/ScopeLabel';
import { useRuntimeDiagnostics } from '../components/useRuntimeDiagnostics';
import styles from './Panes.module.css';
import type { McpExecutableReadiness, McpRemediation, RuntimeMcpServer } from './types';

const MODE_VALUES = ['local', 'remote', 'headless'] as const;
type RuntimeMode = (typeof MODE_VALUES)[number];

type RuntimeSection = {
  mode?: string;
  concurrency?: number;
  [key: string]: unknown;
};

const RuntimePane: React.FC = () => {
  const { t } = useTranslation();
  const { getSection, setSection } = useWcoreConfig();
  const [section, setLocal] = useState<RuntimeSection | null>(null);
  const [rawEngine, setRawEngine] = useState(false);

  // The engine answers `get_runtime_diagnostics` with its own view of how it is
  // bound, which config file actually won, which env override it ignored, and
  // why each MCP server did or did not come up - but ONLY when asked, and only
  // ever about the one engine process that was asked. The hook owns the ask and
  // the reply correlation; see its header for why "newest frame wins" is wrong.
  const { phase, frame: diagnostics, conversationId, engines, reason: askReason, ask } = useRuntimeDiagnostics();

  useEffect(() => {
    let cancelled = false;
    void getSection<RuntimeSection>('runtime').then((s) => {
      if (!cancelled) setLocal(s ?? {});
    });
    void ConfigStorage.get('wcore.rawEngineMode').then((v) => {
      if (!cancelled) setRawEngine(v === true);
    });
    return () => {
      cancelled = true;
    };
  }, [getSection]);

  const persist = useCallback(
    (next: RuntimeSection): void => {
      setLocal(next);
      void setSection('runtime', next);
    },
    [setSection]
  );

  const mode: RuntimeMode = useMemo(() => {
    const m = section?.mode;
    return (MODE_VALUES as readonly string[]).includes(m ?? '') ? (m as RuntimeMode) : 'local';
  }, [section]);
  const concurrency = typeof section?.concurrency === 'number' ? section.concurrency : 6;

  const modeOptions = useMemo(
    () => [
      { value: 'local', label: t('settings.wcoreConfig.runtime.modeLocal', { defaultValue: 'Local' }) },
      { value: 'remote', label: t('settings.wcoreConfig.runtime.modeRemote', { defaultValue: 'Remote' }) },
      {
        value: 'headless',
        label: t('settings.wcoreConfig.runtime.modeHeadless', { defaultValue: 'Headless server' }),
      },
    ],
    [t]
  );

  /**
   * The engine's twelve executable-readiness verdicts, in plain words.
   *
   * These and the remediation hints are the only engine enums this pane
   * translates. The rest (`role`, `disposition`, `connection`, `exposure`,
   * `transport`, `origin`, `working_directory`) are printed verbatim in mono:
   * they are the engine's own vocabulary, they appear that way in its logs and
   * config, and a translated `stdio` would be harder to act on, not easier.
   */
  const readinessLabels = useMemo<Record<McpExecutableReadiness, string>>(
    () => ({
      not_applicable: t('settings.wcoreConfig.runtime.readiness.notApplicable', {
        defaultValue: 'No executable involved',
      }),
      unchecked: t('settings.wcoreConfig.runtime.readiness.unchecked', { defaultValue: 'Not checked' }),
      resolved: t('settings.wcoreConfig.runtime.readiness.resolved', { defaultValue: 'Executable found' }),
      missing_effective_path: t('settings.wcoreConfig.runtime.readiness.missingEffectivePath', {
        defaultValue: 'No PATH was in effect for the launch',
      }),
      not_found: t('settings.wcoreConfig.runtime.readiness.notFound', { defaultValue: 'Executable not found' }),
      invalid_absolute_path: t('settings.wcoreConfig.runtime.readiness.invalidAbsolutePath', {
        defaultValue: 'The absolute path is not valid',
      }),
      invalid_executable: t('settings.wcoreConfig.runtime.readiness.invalidExecutable', {
        defaultValue: 'The command is not a valid executable',
      }),
      invalid_effective_environment: t('settings.wcoreConfig.runtime.readiness.invalidEffectiveEnvironment', {
        defaultValue: 'The launch environment is not valid',
      }),
      permission_denied: t('settings.wcoreConfig.runtime.readiness.permissionDenied', {
        defaultValue: 'Permission denied',
      }),
      not_executable: t('settings.wcoreConfig.runtime.readiness.notExecutable', {
        defaultValue: 'The file is not marked executable',
      }),
      probe_timed_out: t('settings.wcoreConfig.runtime.readiness.probeTimedOut', {
        defaultValue: 'The check timed out',
      }),
      unsupported_transport: t('settings.wcoreConfig.runtime.readiness.unsupportedTransport', {
        defaultValue: 'This transport is not supported',
      }),
    }),
    [t]
  );

  /** The engine's ten machine-readable "what to do about it" hints. */
  const remediationLabels = useMemo<Record<McpRemediation, string>>(
    () => ({
      open_active_config: t('settings.wcoreConfig.runtime.remediation.openActiveConfig', {
        defaultValue: 'Open the active config file',
      }),
      restart_desktop: t('settings.wcoreConfig.runtime.remediation.restartDesktop', { defaultValue: 'Restart Darhai' }),
      fix_gui_launch_path: t('settings.wcoreConfig.runtime.remediation.fixGuiLaunchPath', {
        defaultValue: 'Fix the PATH the app is launched with',
      }),
      install_executable: t('settings.wcoreConfig.runtime.remediation.installExecutable', {
        defaultValue: 'Install the missing program',
      }),
      fix_executable_permissions: t('settings.wcoreConfig.runtime.remediation.fixExecutablePermissions', {
        defaultValue: 'Fix the file permissions',
      }),
      review_server_config: t('settings.wcoreConfig.runtime.remediation.reviewServerConfig', {
        defaultValue: 'Review this server’s configuration',
      }),
      retry_connection: t('settings.wcoreConfig.runtime.remediation.retryConnection', {
        defaultValue: 'Try connecting again',
      }),
      retry_diagnostics: t('settings.wcoreConfig.runtime.remediation.retryDiagnostics', {
        defaultValue: 'Ask for diagnostics again',
      }),
      check_assistant_scope: t('settings.wcoreConfig.runtime.remediation.checkAssistantScope', {
        defaultValue: 'Check which assistant this server is scoped to',
      }),
      restart_to_load_resources: t('settings.wcoreConfig.runtime.remediation.restartToLoadResources', {
        defaultValue: 'Restart the session to load its resources',
      }),
    }),
    [t]
  );

  /**
   * The five per-server facts the card used to drop.
   *
   * They are not decoration: `resources_declared && !resources_exposed` IS the
   * `restart_to_load_resources` condition, `assistant_scoped` IS the
   * `check_assistant_scope` condition, and `deferred` is why a server sits at
   * `connection: configured` instead of `ready`. Printing the remediation hint
   * while withholding the fact that justifies it is the opposite of actionable.
   *
   * A `false` boolean produces NO chip - there is nothing to say about a server
   * that declares no resources - but the declared/exposed PAIR is always shown
   * together once resources exist, because "declared" alone reads as "working".
   */
  const serverFlags = useCallback(
    (server: RuntimeMcpServer): string[] => {
      const flags: string[] = [];
      if (server.deferred === true) {
        flags.push(
          t('settings.wcoreConfig.runtime.diagnostics.flagDeferred', { defaultValue: 'start deferred until first use' })
        );
      }
      if (server.resources_declared === true) {
        flags.push(
          server.resources_exposed === true
            ? t('settings.wcoreConfig.runtime.diagnostics.flagResourcesExposed', {
                defaultValue: 'resources declared and exposed',
              })
            : t('settings.wcoreConfig.runtime.diagnostics.flagResourcesHeld', {
                defaultValue: 'resources declared but NOT exposed yet',
              })
        );
      }
      if (server.assistant_scoped === true) {
        flags.push(
          t('settings.wcoreConfig.runtime.diagnostics.flagAssistantScoped', {
            defaultValue: 'scoped to one assistant',
          })
        );
      }
      return flags;
    },
    [t]
  );

  const toggleRawEngine = useCallback((next: boolean): void => {
    setRawEngine(next);
    // Refinement C: persist the preference only. The spawn seam (WCoreManager)
    // reads it to skip Desktop's model/skills/overlay injection. See the
    // TODO(orchestrator) marker there.
    void ConfigStorage.set('wcore.rawEngineMode', next);
  }, []);

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <div className={styles.eyebrow}>Darhai Core</div>
        <h1 className={styles.title}>{t('settings.wcoreConfig.rail.runtime', { defaultValue: 'Runtime' })}</h1>
        <p className={styles.sub}>
          {t('settings.wcoreConfig.runtime.subtitle', {
            defaultValue:
              'Where the engine actually runs. Embedded locally by default; switch to a remote box or a hosted headless server when you need to.',
          })}
        </p>
        <ScopeLabel />
      </div>

      <div className={styles.section}>
        <div className={styles.group}>
          <div className={styles.listRow}>
            <div>
              <div className={styles.lrLabel}>
                {t('settings.wcoreConfig.runtime.runtimeMode', { defaultValue: 'Runtime mode' })}
              </div>
              <div className={styles.lrDesc}>
                {t('settings.wcoreConfig.runtime.runtimeModeDesc', {
                  defaultValue: 'Currently: embedded local engine',
                })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <WcSegmented
                options={modeOptions}
                value={mode}
                onChange={(v) => persist({ ...section, mode: v })}
                label={t('settings.wcoreConfig.runtime.runtimeMode', { defaultValue: 'Runtime mode' })}
              />
            </div>
          </div>

          <div className={styles.listRow}>
            <div>
              <div className={`${styles.lrLabel} ${styles.lrLabelMono}`}>
                {t('settings.wcoreConfig.runtime.endpoint', { defaultValue: 'wcore endpoint' })}
              </div>
              <div className={styles.lrDesc}>
                {t('settings.wcoreConfig.runtime.endpointDesc', { defaultValue: 'Embedded · spawned in-process' })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <span className={`${styles.badge} ${styles.connected}`}>
                <span className={styles.bd} />
                {t('settings.wcoreConfig.runtime.running', { defaultValue: 'Running' })}
              </span>
            </div>
          </div>

          <div className={styles.listRow}>
            <div>
              <div className={styles.lrLabel}>
                {t('settings.wcoreConfig.runtime.concurrency', { defaultValue: 'Concurrency' })}
              </div>
              <div className={styles.lrDesc}>
                {t('settings.wcoreConfig.runtime.concurrencyDesc', { defaultValue: 'Max parallel sub-agents' })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <div className={styles.sliderWrap}>
                <Slider
                  min={1}
                  max={12}
                  step={1}
                  value={concurrency}
                  style={{ flex: 1, minWidth: 180 }}
                  onChange={(v) => persist({ ...section, concurrency: Number(v) })}
                />
                <span className={styles.sliderVal}>
                  {t('settings.wcoreConfig.runtime.agentsVal', {
                    defaultValue: '{{count}} agents',
                    count: concurrency,
                  })}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Refinement C: raw-engine-mode power-user toggle */}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>
            {t('settings.wcoreConfig.runtime.powerUser', { defaultValue: 'Power User' })}
          </span>
          <span className={styles.sectionHeadLine} />
        </div>
        <div className={styles.group}>
          <div className={styles.listRow}>
            <div>
              <div className={styles.lrLabel}>
                {t('settings.wcoreConfig.runtime.rawEngine', { defaultValue: 'Raw engine mode' })}
              </div>
              <div className={styles.lrDesc}>
                {t('settings.wcoreConfig.runtime.rawEngineDesc', {
                  defaultValue:
                    'Run the embedded engine on its own config, without overriding with Desktop’s model & skills.',
                })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <WcSwitch
                checked={rawEngine}
                onChange={toggleRawEngine}
                label={t('settings.wcoreConfig.runtime.rawEngine', { defaultValue: 'Raw engine mode' })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* The engine's own account of how it is bound and why each MCP behaved. */}
      <div className={styles.section} data-testid='runtime-diagnostics'>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>
            {t('settings.wcoreConfig.runtime.diagnostics.title', { defaultValue: 'Diagnostics' })}
          </span>
          <span className={styles.sectionHeadLine} />
          <Button
            size='mini'
            type='secondary'
            // `asking` ONLY - the IPC round-trip, which is bounded. `pending`
            // deliberately leaves the control live: an answer is owed by an
            // engine, this layer refuses to invent a timeout for it (see
            // `useRuntimeDiagnostics`), and Arco's `loading` blocks the handler
            // - so including it here made re-asking impossible and left
            // switching rail tabs as the only escape, which no copy suggests.
            loading={phase === 'asking'}
            onClick={ask}
            data-testid='diagnostics-ask'
          >
            {/* Keyed off the PHASE, not off whether an answer is currently
                held: re-asking clears the old snapshot, and a label that flipped
                back to "Ask the engine" mid-request would read as "nothing has
                happened yet". */}
            {phase === 'idle'
              ? t('settings.wcoreConfig.runtime.diagnostics.ask', { defaultValue: 'Ask the engine' })
              : t('settings.wcoreConfig.runtime.diagnostics.askAgain', { defaultValue: 'Ask again' })}
          </Button>
        </div>

        {/* WHICH engine answered. A snapshot describes ONE process, and with
            several chats open naming it is the difference between a readout and
            a guess. */}
        {conversationId !== null && (
          <div className='text-t-tertiary text-xs' data-testid='diagnostics-source'>
            {t('settings.wcoreConfig.runtime.diagnostics.source', {
              defaultValue: 'Engine of chat {{conversation}}',
              conversation: conversationId,
            })}
            {engines > 1 && (
              <>
                {' · '}
                {t('settings.wcoreConfig.runtime.diagnostics.otherEngines', {
                  defaultValue: '{{count}} Darhai Core chats are open; this is the most recently used one.',
                  count: engines,
                })}
              </>
            )}
          </div>
        )}

        {phase === 'no_engine' && (
          <div className={styles.emptyHint} data-testid='diagnostics-no-engine'>
            {t('settings.wcoreConfig.runtime.diagnostics.noEngine', {
              defaultValue: 'No Darhai Core chat is open, so there is no engine process to ask.',
            })}
          </div>
        )}

        {phase === 'refused' && (
          <div className={styles.callout} data-testid='diagnostics-not-sent'>
            <div className={styles.ctTitle}>
              {t('settings.wcoreConfig.runtime.diagnostics.notSentTitle', {
                defaultValue: 'The request was not sent',
              })}
            </div>
            <div className={styles.ctBody}>
              {askReason === null
                ? t('settings.wcoreConfig.runtime.diagnostics.notSentNoReason', {
                    defaultValue: 'Darhai was given no reason.',
                  })
                : askReason}
            </div>
          </div>
        )}

        {phase === 'pending' && (
          <div className={styles.emptyHint} data-testid='diagnostics-pending'>
            {t('settings.wcoreConfig.runtime.diagnostics.pending', {
              defaultValue: 'Asked the engine. Waiting for its answer…',
            })}
          </div>
        )}

        {/* Only before the first ask. Re-asking clears the held snapshot, and
            showing "the engine has not reported diagnostics" while a request is
            in flight would contradict the button beside it. */}
        {diagnostics === null && phase === 'idle' && (
          <div className={styles.emptyHint} data-testid='diagnostics-empty'>
            <div>
              {t('settings.wcoreConfig.runtime.diagnostics.empty', {
                defaultValue: 'The engine has not reported diagnostics.',
              })}
            </div>
            <div className='text-t-tertiary mt-1'>
              {t('settings.wcoreConfig.runtime.diagnostics.emptyHint', {
                defaultValue: 'It only reports them when asked. Use the button above.',
              })}
            </div>
          </div>
        )}

        {diagnostics?.status === 'unavailable' && (
          <div className={styles.callout} data-testid='diagnostics-unavailable'>
            <div className={styles.ctTitle}>
              {t('settings.wcoreConfig.runtime.diagnostics.unavailableTitle', {
                defaultValue: 'The engine declined to report diagnostics',
              })}
            </div>
            <div className={styles.ctBody}>
              {diagnostics.reason === 'unsupported_version'
                ? t('settings.wcoreConfig.runtime.diagnostics.reasonUnsupportedVersion', {
                    defaultValue: 'It does not serve the diagnostics version Darhai asked for.',
                  })
                : t('settings.wcoreConfig.runtime.diagnostics.reasonInvalidRequest', {
                    defaultValue: 'It rejected the request as malformed.',
                  })}
            </div>
            <div className={styles.ctBody}>
              {t('settings.wcoreConfig.runtime.diagnostics.versionLine', {
                defaultValue: 'Asked for v{{asked}} · this engine serves v{{served}}',
                asked: diagnostics.requestedVersion,
                served: diagnostics.supportedVersion,
              })}
            </div>
            {diagnostics.echoMismatch && (
              <div className={styles.ctBody}>
                {t('settings.wcoreConfig.runtime.diagnostics.echoMismatch', {
                  defaultValue: 'The engine echoed v{{echoed}}, which Darhai never sent.',
                  echoed: diagnostics.echoedVersion,
                })}
              </div>
            )}
          </div>
        )}

        {diagnostics?.status === 'undecodable' && (
          <div className={styles.callout} data-testid='diagnostics-undecodable'>
            <div className={styles.ctTitle}>
              {t('settings.wcoreConfig.runtime.diagnostics.undecodableTitle', {
                defaultValue: 'The engine answered in a shape this build cannot read',
              })}
            </div>
            <div className={styles.ctBody}>{diagnostics.detail}</div>
            {diagnostics.offending !== undefined && (
              <div className={`${styles.ctBody} font-mono`}>{diagnostics.offending}</div>
            )}
          </div>
        )}

        {diagnostics?.status === 'snapshot' && (
          <div className={styles.group} data-testid='diagnostics-snapshot'>
            {/* Process binding: what the "Running / embedded local engine" copy
                above only ever asserted, now reported. */}
            <div className={styles.listRow}>
              <div>
                <div className={styles.lrLabel}>
                  {t('settings.wcoreConfig.runtime.diagnostics.processTitle', { defaultValue: 'This engine process' })}
                </div>
                <div className={styles.lrDesc}>
                  {t('settings.wcoreConfig.runtime.diagnostics.engineMode', { defaultValue: 'mode' })}{' '}
                  <b className='font-mono'>{diagnostics.snapshot.process.engine_mode}</b>
                  {' · '}
                  {t('settings.wcoreConfig.runtime.diagnostics.profileBinding', {
                    defaultValue: 'profile binding',
                  })}{' '}
                  <b className='font-mono'>{diagnostics.snapshot.process.profile_binding}</b>
                  {' · '}
                  {t('settings.wcoreConfig.runtime.diagnostics.workspaceKind', { defaultValue: 'workspace' })}{' '}
                  <b className='font-mono'>{diagnostics.snapshot.process.workspace_kind}</b>
                  {/* Omitted entirely when the engine named no profile - an
                      empty "Profile: " row would read as "no profile". */}
                  {diagnostics.snapshot.process.profile_name !== undefined && (
                    <>
                      {' · '}
                      {t('settings.wcoreConfig.runtime.diagnostics.profileName', { defaultValue: 'profile' })}{' '}
                      <b className='font-mono'>{diagnostics.snapshot.process.profile_name}</b>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Config precedence: which config.toml actually won. */}
            <div className={styles.listRow}>
              <div className='w-full'>
                <div className={styles.lrLabel}>
                  {t('settings.wcoreConfig.runtime.diagnostics.sourcesTitle', { defaultValue: 'Config sources' })}
                </div>
                {diagnostics.snapshot.config_sources.length === 0 ? (
                  <div className={styles.lrDesc}>
                    {t('settings.wcoreConfig.runtime.diagnostics.sourcesEmpty', {
                      defaultValue: 'The engine reported no config source at all.',
                    })}
                  </div>
                ) : (
                  <table className='w-full border-collapse text-xs mt-1'>
                    <thead>
                      <tr className='text-left text-t-tertiary'>
                        <th className='py-1 pr-3 font-medium'>
                          {t('settings.wcoreConfig.runtime.diagnostics.colPrecedence', { defaultValue: 'Order' })}
                        </th>
                        <th className='py-1 pr-3 font-medium'>
                          {t('settings.wcoreConfig.runtime.diagnostics.colRole', { defaultValue: 'Role' })}
                        </th>
                        <th className='py-1 pr-3 font-medium'>
                          {t('settings.wcoreConfig.runtime.diagnostics.colDisposition', { defaultValue: 'Outcome' })}
                        </th>
                        <th className='py-1 font-medium'>
                          {t('settings.wcoreConfig.runtime.diagnostics.colPath', { defaultValue: 'Path' })}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Index-based keys, like the unreadable list below.
                          Nothing in the decoder makes `role` or `precedence`
                          distinct - the handler's own comment says nested
                          project configs may repeat a role - and duplicate keys
                          make React reconcile two real sources into one row, on
                          a readout whose entire point is that a missing row
                          must never read as "not configured". */}
                      {diagnostics.snapshot.config_sources
                        .toSorted((a, b) => a.precedence - b.precedence)
                        .map((source, index) => (
                          <tr key={`config-source-${index}`} className='border-t border-b-light'>
                            <td className='py-1 pr-3 font-mono text-t-tertiary'>{source.precedence}</td>
                            <td className='py-1 pr-3 font-mono text-t-primary'>{source.role}</td>
                            <td className='py-1 pr-3 font-mono text-t-secondary'>{source.disposition}</td>
                            <td className='py-1 font-mono text-t-secondary break-all'>
                              {source.display_path ?? (
                                <span className='text-t-tertiary font-sans'>
                                  {t('settings.wcoreConfig.runtime.diagnostics.pathUnknown', {
                                    defaultValue: 'not reported',
                                  })}
                                </span>
                              )}
                              {/* Two sources can name the same path and hold
                                  different bytes; the digest is the only thing
                                  that tells them apart. */}
                              {source.content_digest !== undefined && (
                                <div className='text-t-tertiary'>
                                  {t('settings.wcoreConfig.runtime.diagnostics.digest', { defaultValue: 'digest' })}{' '}
                                  {source.content_digest}
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Env overrides the engine refused to honour. */}
            <div className={styles.listRow}>
              <div className='w-full'>
                <div className={styles.lrLabel}>
                  {t('settings.wcoreConfig.runtime.diagnostics.overridesTitle', {
                    defaultValue: 'Ignored environment overrides',
                  })}
                </div>
                {diagnostics.snapshot.unsupported_overrides.length === 0 ? (
                  <div className={styles.lrDesc}>
                    {t('settings.wcoreConfig.runtime.diagnostics.overridesNone', {
                      defaultValue: 'The engine honoured every environment variable it was given.',
                    })}
                  </div>
                ) : (
                  <div className='flex flex-wrap gap-1.5 mt-1'>
                    {/* `name` is engine-controlled and never checked for
                        uniqueness by the decoder - index keys instead. */}
                    {diagnostics.snapshot.unsupported_overrides.map((entry, index) => (
                      <span key={`override-${index}`} className={styles.statChip}>
                        <span className='font-mono'>{entry.name}</span>
                        <b className='font-mono ml-1'>{entry.disposition}</b>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Per-server readiness: the "why is my MCP missing" answer. */}
            <div className={styles.listRow}>
              <div className='w-full'>
                <div className={styles.lrLabel}>
                  {t('settings.wcoreConfig.runtime.diagnostics.serversTitle', {
                    defaultValue: 'MCP servers, as the engine sees them',
                  })}
                </div>
                {diagnostics.snapshot.mcp_servers.length === 0 ? (
                  <div className={styles.lrDesc}>
                    {t('settings.wcoreConfig.runtime.diagnostics.serversEmpty', {
                      defaultValue: 'The engine has no MCP server configured.',
                    })}
                  </div>
                ) : (
                  <div className='flex flex-col gap-2 mt-1'>
                    {/* Two servers may share a `name` across origins (one
                        `project_config`, one `global_config`); the decoder does
                        not enforce distinctness, so a name key would collapse
                        them into one row and hide a configured server. */}
                    {diagnostics.snapshot.mcp_servers.map((server, index) => (
                      <div key={`mcp-server-${index}`} className='rounded border border-b-light p-2'>
                        <div className='font-mono text-t-primary'>{server.name}</div>
                        <div className={styles.lrDesc}>
                          {t('settings.wcoreConfig.runtime.diagnostics.connection', { defaultValue: 'connection' })}{' '}
                          <b className='font-mono'>{server.connection}</b>
                          {' · '}
                          {t('settings.wcoreConfig.runtime.diagnostics.exposure', { defaultValue: 'exposure' })}{' '}
                          <b className='font-mono'>{server.exposure}</b>
                          {' · '}
                          {t('settings.wcoreConfig.runtime.diagnostics.origin', { defaultValue: 'from' })}{' '}
                          <b className='font-mono'>{server.origin}</b>
                          {' · '}
                          <b className='font-mono'>{server.transport}</b>
                          {' · '}
                          {t('settings.wcoreConfig.runtime.diagnostics.toolCount', {
                            defaultValue: '{{count}} tools',
                            count: server.tool_count,
                          })}
                        </div>
                        <div className={styles.lrDesc}>
                          {readinessLabels[server.executable_readiness]}
                          {server.executable_basename !== undefined && (
                            <>
                              {' · '}
                              <span className='font-mono'>{server.executable_basename}</span>
                            </>
                          )}
                          {' · '}
                          {t('settings.wcoreConfig.runtime.diagnostics.workingDirectory', {
                            defaultValue: 'working directory',
                          })}{' '}
                          <b className='font-mono'>{server.working_directory}</b>
                          {server.failure !== undefined && (
                            <>
                              {' · '}
                              <span className='text-danger font-mono'>{server.failure}</span>
                            </>
                          )}
                        </div>
                        {serverFlags(server).length > 0 && (
                          <div className={styles.lrDesc} data-testid='mcp-server-flags'>
                            {serverFlags(server).join(' · ')}
                          </div>
                        )}
                        {server.remediation.length > 0 && (
                          <div className='flex flex-wrap gap-1.5 mt-1'>
                            {/* `remediation` is a bounded engine-controlled list
                                and the decoder does not de-duplicate it. */}
                            {server.remediation.map((hint, hintIndex) => (
                              <span key={`remediation-${hintIndex}`} className={styles.statChip}>
                                {remediationLabels[hint]}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* A hole in the inventory, named. Dropping these rows silently
                would make a configured server read as "not configured". */}
            {diagnostics.unreadable.length > 0 && (
              <div className={styles.listRow} data-testid='diagnostics-unreadable'>
                <div className='w-full'>
                  <div className={`${styles.lrLabel} text-warning`}>
                    {t('settings.wcoreConfig.runtime.diagnostics.unreadableTitle', {
                      defaultValue: '{{count}} entries this build cannot read',
                      count: diagnostics.unreadable.length,
                    })}
                  </div>
                  <div className='flex flex-col gap-0.5 mt-1'>
                    {diagnostics.unreadable.map((entry) => (
                      <div key={`${entry.list}-${entry.index}`} className={`${styles.lrDesc} font-mono break-all`}>
                        {entry.list}[{entry.index}]{entry.name === null ? '' : ` "${entry.name}"`} — {entry.reason}
                        {/* The engine's OWN offending value. The handler splits
                            every refusal in two on purpose: `reason` is
                            host-authored and may be logged, `offending` is
                            engine text kept OUT of the log and put in the frame
                            precisely so the renderer can show it to the user who
                            asked. Without it the row says "9 characters" where
                            it could say `entangled` - the one token that
                            identifies an engine upgrade. */}
                        {entry.offending !== undefined && (
                          <>
                            {' · '}
                            {t('settings.wcoreConfig.runtime.diagnostics.unreadableOffending', {
                              defaultValue: 'engine sent: {{value}}',
                              value: entry.offending,
                            })}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className={styles.infonote}>
        <div className={styles.inTitle}>
          {t('settings.wcoreConfig.runtime.headlessTitle', { defaultValue: 'Headless server mode' })}
        </div>
        <div className={styles.inBody}>
          {t('settings.wcoreConfig.runtime.headlessBody', {
            defaultValue:
              'Run Darhai Core as a long-lived server (one container per tenant) and reach it over LAN, Tailscale, or the hosted Pro tier.',
          })}
        </div>
      </div>
    </div>
  );
};

export default RuntimePane;
