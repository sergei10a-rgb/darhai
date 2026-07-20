/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * PromotionThresholdModal - tune wiki auto-promotion settings.
 * Lazy-imported by W2's MemoryArchivePage via:
 *   lazy(() => import('@renderer/pages/memory/components/PromotionThresholdModal'))
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Message, Modal, Slider, Switch } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import styles from './PromotionThresholdModal.module.css';

// ===== Types =====

type Props = {
  onClose: () => void;
};

// ===== Component =====

const PromotionThresholdModal: React.FC<Props> = ({ onClose }) => {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useState<number>(90);
  const [autoPromote, setAutoPromote] = useState<boolean>(true);
  // Odysseus #2: auto-extract durable facts from conversations. OPT-IN, default OFF.
  const [autoExtract, setAutoExtract] = useState<boolean>(false);
  const [candidateCount, setCandidateCount] = useState<number>(0);
  const [formulaOpen, setFormulaOpen] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load initial state from IPC.
  useEffect(() => {
    void ipcBridge.memory.getPromotionCandidates.invoke().then((result) => {
      if (!result) return;
      setThreshold(result.threshold);
      setCandidateCount(result.candidates.length);
      if (typeof result.autoPromoteEnabled === 'boolean') {
        setAutoPromote(result.autoPromoteEnabled);
      }
    });
    // Auto-extract toggle is stored separately (its own settings file).
    void ipcBridge.memory.getAutoExtractEnabled.invoke().then((enabled) => {
      if (typeof enabled === 'boolean') setAutoExtract(enabled);
    });
  }, []);

  // Debounced candidate refresh when slider changes.
  const refreshCandidates = useCallback((value: number) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void ipcBridge.memory.getPromotionCandidates.invoke().then((result) => {
        if (!result) return;
        // Count candidates that would qualify at the pending threshold.
        const count = result.candidates.filter((c) => (c.score !== undefined ? c.score >= value : true)).length;
        setCandidateCount(count);
      });
    }, 200);
  }, []);

  const handleSliderChange = useCallback(
    (value: number | number[]) => {
      const v = Array.isArray(value) ? (value[0] ?? 90) : value;
      setThreshold(v);
      refreshCandidates(v);
    },
    [refreshCandidates]
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await ipcBridge.memory.setPromotionThreshold.invoke({ threshold });
      await ipcBridge.memory.setAutoPromoteEnabled.invoke({ enabled: autoPromote });
      await ipcBridge.memory.setAutoExtractEnabled.invoke({ enabled: autoExtract });
      Message.success(t('memory.archive.threshold_modal.save_success', 'Saved'));
      onClose();
    } catch {
      Message.error(t('memory.archive.threshold_modal.save_error', 'Failed to save settings'));
    } finally {
      setSaving(false);
    }
  }, [threshold, autoPromote, autoExtract, onClose, t]);

  return (
    <Modal
      visible
      title={t('memory.archive.threshold_modal.title', 'Tune auto-promotion')}
      onCancel={onClose}
      footer={null}
      className={styles.modal}
      data-testid='promotion-threshold-modal'
    >
      <div className={styles.body}>
        {/* Threshold slider */}
        <div className={styles.field} data-testid='threshold-field'>
          <div className={styles.labelRow}>
            <span className={styles.label}>
              {t('memory.archive.threshold_modal.threshold_label', 'Promotion threshold')}
            </span>
            <span className={styles.value} data-testid='threshold-value'>
              {threshold}
            </span>
          </div>
          <Slider min={0} max={100} value={threshold} onChange={handleSliderChange} data-testid='threshold-slider' />
          <p className={styles.hint} data-testid='candidate-hint'>
            {t('memory.archive.threshold_modal.live_preview', '{{count}} candidates at threshold {{value}}', {
              count: candidateCount,
              value: threshold,
            })}
          </p>
        </div>

        {/* Auto-promote toggle */}
        <div className={styles.field} data-testid='auto-promote-field'>
          <div className={styles.switchRow}>
            <span className={styles.label}>
              {t('memory.archive.threshold_modal.autopromo_label', 'Auto-promote on schedule')}
            </span>
            <Switch checked={autoPromote} onChange={setAutoPromote} data-testid='auto-promote-switch' />
          </div>
        </div>

        {/* Auto-extract toggle (Odysseus #2). Opt-in, default OFF. */}
        <div className={styles.field} data-testid='auto-extract-field'>
          <div className={styles.switchRow}>
            <span className={styles.label}>
              {t('memory.archive.threshold_modal.autoextract_label', 'Auto-extract memory from conversations')}
            </span>
            <Switch checked={autoExtract} onChange={setAutoExtract} data-testid='auto-extract-switch' />
          </div>
          <p className={styles.hint}>
            {t(
              'memory.archive.threshold_modal.autoextract_help',
              'When on, durable facts from your conversations are saved to memory automatically. Off by default; all data stays on your device.'
            )}
          </p>
        </div>

        {/* Score formula disclosure */}
        <div className={styles.field}>
          <Button
            type='text'
            size='small'
            onClick={() => setFormulaOpen((o) => !o)}
            data-testid='formula-disclosure-btn'
          >
            {`${formulaOpen ? t('common.hide', 'Hide') : t('common.show', 'Show')} ${t(
              'memory.archive.threshold_modal.score_formula_title',
              'Score formula'
            )}`}
          </Button>
          {formulaOpen && (
            <pre className={styles.formula} data-testid='score-formula'>
              {[
                t('memory.archive.threshold_modal.formula_decision', '+30 if type is decision or pattern'),
                t('memory.archive.threshold_modal.formula_refs', '+10 per project that references this entry'),
                t('memory.archive.threshold_modal.formula_referenced', '+5 per dereference hit'),
                t(
                  'memory.archive.threshold_modal.formula_tag',
                  '+20 if tagged decision, pattern, global, design, or architecture'
                ),
                t(
                  'memory.archive.threshold_modal.formula_recency',
                  '+15 if stored < 24h ago (decays linearly over 30 days)'
                ),
              ].join('\n')}
            </pre>
          )}
        </div>

        {/* Actions */}
        <div className={styles.actions}>
          <Button onClick={onClose} data-testid='cancel-btn'>
            {t('memory.archive.threshold_modal.cancel_btn', 'Cancel')}
          </Button>
          <Button type='primary' loading={saving} onClick={() => void handleSave()} data-testid='save-btn'>
            {t('memory.archive.threshold_modal.save_btn', 'Save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default PromotionThresholdModal;
