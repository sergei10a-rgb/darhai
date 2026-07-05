/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button, Input } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useWcoreConfig } from '@renderer/hooks/useWcoreConfig';
import WcSwitch from '../components/WcSwitch';
import WcSegmented from '../components/WcSegmented';
import ScopeLabel from '../components/ScopeLabel';
import styles from './Panes.module.css';

/**
 * SEC-6: env names matching this pattern are SECRET-bearing and must NEVER be
 * added to the engine's env-passthrough allowlist. The renderer rejects them in
 * the input; the main-process bridge filters again (defence in depth). Keep in
 * sync with `SENSITIVE_ENV_RE` in `wcoreConfigBridge.ts`.
 */
const SENSITIVE_ENV_RE = /(API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE[_-]?KEY|SESSION)/i;
/** A bare, well-formed environment variable name. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The approval-mode values mirror the engine's `[default].approval_mode`. */
const APPROVAL_VALUES = ['ask', 'auto-edit', 'yolo'] as const;
type ApprovalMode = (typeof APPROVAL_VALUES)[number];

type SecuritySection = {
  approval_mode?: string;
  env_passthrough?: string[];
  block_private_urls?: boolean;
  [key: string]: unknown;
};

const SecurityPane: React.FC = () => {
  const { t } = useTranslation();
  const { getSection, setSection } = useWcoreConfig();
  const [section, setLocal] = useState<SecuritySection | null>(null);
  const [draft, setDraft] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getSection<SecuritySection>('security').then((s) => {
      if (!cancelled) setLocal(s ?? {});
    });
    return () => {
      cancelled = true;
    };
  }, [getSection]);

  const persist = useCallback(
    (next: SecuritySection): void => {
      setLocal(next);
      void setSection('security', next);
    },
    [setSection]
  );

  const approvalMode: ApprovalMode = useMemo(() => {
    const m = section?.approval_mode;
    return (APPROVAL_VALUES as readonly string[]).includes(m ?? '') ? (m as ApprovalMode) : 'auto-edit';
  }, [section]);

  const envNames = useMemo(() => (Array.isArray(section?.env_passthrough) ? section!.env_passthrough! : []), [section]);

  const addEnv = useCallback((): void => {
    const name = draft.trim();
    if (name.length === 0) return;
    if (!ENV_NAME_RE.test(name)) {
      setInputError(t('settings.wcoreConfig.security.envInvalid', { defaultValue: 'Not a valid env var name.' }));
      return;
    }
    // SEC-6: reject secret-bearing names outright; never store them.
    if (SENSITIVE_ENV_RE.test(name)) {
      setInputError(
        t('settings.wcoreConfig.security.envSensitive', {
          defaultValue: 'That looks like a secret. Secret-bearing names can’t be passed to the sandbox.',
        })
      );
      return;
    }
    if (envNames.includes(name)) {
      setDraft('');
      return;
    }
    setInputError(null);
    setDraft('');
    persist({ ...section, env_passthrough: [...envNames, name] });
  }, [draft, envNames, persist, section, t]);

  const removeEnv = useCallback(
    (name: string): void => {
      persist({ ...section, env_passthrough: envNames.filter((n) => n !== name) });
    },
    [envNames, persist, section]
  );

  const approvalOptions = useMemo(
    () => [
      { value: 'ask', label: t('settings.wcoreConfig.security.approvalAsk', { defaultValue: 'Ask every time' }) },
      { value: 'auto-edit', label: t('settings.wcoreConfig.security.approvalAuto', { defaultValue: 'Auto-edit' }) },
      { value: 'yolo', label: t('settings.wcoreConfig.security.approvalYolo', { defaultValue: 'YOLO' }) },
    ],
    [t]
  );

  const blockPrivate = section?.block_private_urls !== false;

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <div className={styles.eyebrow}>Darhai Core</div>
        <h1 className={styles.title}>
          {t('settings.wcoreConfig.rail.security', { defaultValue: 'Security & Permissions' })}
        </h1>
        <p className={styles.sub}>
          {t('settings.wcoreConfig.security.subtitle', {
            defaultValue:
              'Control how much the engine can do without asking, and exactly which secrets reach the sandbox. Safe defaults already in place.',
          })}
        </p>
        <ScopeLabel />
      </div>

      {/* Approvals mode */}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>
            {t('settings.wcoreConfig.security.approvalsMode', { defaultValue: 'Approvals Mode' })}
          </span>
          <span className={styles.sectionHeadLine} />
        </div>
        <div className={styles.group}>
          <div className={styles.listRow}>
            <div>
              <div className={styles.lrLabel}>
                {t('settings.wcoreConfig.security.defaultPolicy', { defaultValue: 'Default approval policy' })}
              </div>
              <div className={styles.lrDesc}>
                {t('settings.wcoreConfig.security.defaultPolicyDesc', {
                  defaultValue: 'How edits & commands are confirmed',
                })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <WcSegmented
                options={approvalOptions}
                value={approvalMode}
                onChange={(v) => persist({ ...section, approval_mode: v })}
                label={t('settings.wcoreConfig.security.defaultPolicy', { defaultValue: 'Default approval policy' })}
              />
            </div>
          </div>
        </div>
        <div className={styles.hintText}>
          {t('settings.wcoreConfig.security.approvalHint', {
            defaultValue:
              'Auto-edit: file edits apply automatically; shell commands and network actions still ask. Recommended for most work.',
          })}
        </div>
      </div>

      {/* Env-passthrough allowlist (SEC-6: names only, no secrets) */}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>
            {t('settings.wcoreConfig.security.envAllowlist', { defaultValue: 'Env-passthrough Allowlist' })}
          </span>
          <span className={styles.pill}>
            {t('settings.wcoreConfig.security.envPill', { defaultValue: 'which env vars reach bash' })}
          </span>
          <span className={styles.sectionHeadLine} />
        </div>
        <div className={styles.group}>
          {envNames.length === 0 && (
            <div className={styles.emptyHint}>
              {t('settings.wcoreConfig.security.envEmpty', {
                defaultValue: 'No env vars are passed to the sandbox yet. Add a non-secret name below.',
              })}
            </div>
          )}
          {envNames.map((name) => (
            <div key={name} className={styles.listRow}>
              <div>
                <div className={`${styles.lrLabel} ${styles.lrLabelMono}`}>{name}</div>
                <div className={styles.lrDesc}>
                  {t('settings.wcoreConfig.security.envExposed', { defaultValue: 'Exposed to the sandboxed shell' })}
                </div>
              </div>
              <div className={styles.lrControl}>
                <Button
                  size='small'
                  icon={<X size={13} />}
                  onClick={() => removeEnv(name)}
                  aria-label={t('settings.wcoreConfig.security.envRemove', {
                    defaultValue: 'Remove {{name}}',
                    name,
                  })}
                />
              </div>
            </div>
          ))}
        </div>
        <div className={styles.addRow}>
          <Input
            value={draft}
            onChange={(v) => {
              setDraft(v);
              setInputError(null);
            }}
            onPressEnter={addEnv}
            placeholder={t('settings.wcoreConfig.security.envPlaceholder', {
              defaultValue: 'e.g. GITHUB_TOKEN_NAME, PATH, NODE_ENV (no secrets)',
            })}
            style={{ flex: 1, fontFamily: 'var(--wc-mono)' }}
          />
          <Button type='primary' icon={<Plus size={14} />} onClick={addEnv} disabled={draft.trim().length === 0}>
            {t('settings.wcoreConfig.security.envAdd', { defaultValue: 'Add' })}
          </Button>
        </div>
        {inputError && <div className={styles.addError}>{inputError}</div>}
        <div className={styles.hintText}>
          {t('settings.wcoreConfig.security.envSecretsNote', {
            defaultValue:
              'Only variable names are stored, never values, and secret-bearing names (API keys, tokens, passwords) are refused.',
          })}
        </div>
      </div>

      {/* Private URLs */}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>
            {t('settings.wcoreConfig.security.privateUrls', { defaultValue: 'Private URLs' })}
          </span>
          <span className={styles.sectionHeadLine} />
        </div>
        <div className={styles.group}>
          <div className={styles.listRow}>
            <div>
              <div className={styles.lrLabel}>
                {t('settings.wcoreConfig.security.blockPrivate', {
                  defaultValue: 'Block private & loopback fetches',
                })}
              </div>
              <div className={styles.lrDesc}>
                {t('settings.wcoreConfig.security.blockPrivateDesc', {
                  defaultValue: 'Stop the engine reaching 10.x, 192.168.x, localhost, and metadata endpoints',
                })}
              </div>
            </div>
            <div className={styles.lrControl}>
              <WcSwitch
                checked={blockPrivate}
                onChange={(next) => persist({ ...section, block_private_urls: next })}
                label={t('settings.wcoreConfig.security.blockPrivate', {
                  defaultValue: 'Block private & loopback fetches',
                })}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SecurityPane;
