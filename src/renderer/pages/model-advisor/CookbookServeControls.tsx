/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Message, Progress, Select, Space, Tag, Tooltip } from '@arco-design/web-react';
import { Copy, Download, FolderOpen, Loading, PlayOne, Power } from '@icon-park/react';
import type { CookbookBackend } from '@/common/types/cookbook';
import type { CookbookController } from './useCookbookServe';
import styles from './ModelAdvisor.module.css';

type CookbookServeControlsProps = {
  modelId: string;
  controller: CookbookController;
};

/** i18n key per backend (the value is DATA, never interpolated into a command). */
const BACKEND_LABEL_KEY: Record<CookbookBackend, string> = {
  vllm: 'modelAdvisor.cookbook.backend.vllm',
  ollama: 'modelAdvisor.cookbook.backend.ollama',
  'llama-server': 'modelAdvisor.cookbook.backend.llamaServer',
  none: 'modelAdvisor.cookbook.backend.none',
};

/**
 * Per-row download + serve controls for a GGUF-capable model. The backend is the
 * one chosen for THIS user's hardware (OS + GPU vendor + VRAM), shown as a label
 * or - when the hardware supports more than one - an override selector. Renders
 * one of:
 *  - a backend chooser + Serve/Download button (idle),
 *  - a progress bar + Cancel (downloading),
 *  - a status pill + Stop (this model is serving / starting),
 *  - the degraded copy-command + locate-binary affordance (no backend installed).
 */
const CookbookServeControls: React.FC<CookbookServeControlsProps> = ({ modelId, controller }) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [override, setOverride] = useState<CookbookBackend | null>(null);

  const dl = controller.downloads[modelId];
  const prog = controller.progress[modelId];
  const status = controller.serveStatus;
  const { viable, chosen } = controller.selection;
  const selected: CookbookBackend = override && viable.includes(override) ? override : chosen;
  const isServingThis = status.modelId === modelId;
  const isDownloading = dl?.status === 'downloading' || (!!prog && dl?.status !== 'downloaded');
  const isDownloaded = dl?.status === 'downloaded';
  // vLLM and ollama self-download; only llama.cpp needs a GGUF cached first.
  const needsGguf = selected === 'llama-server' || selected === 'none';

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const copyCommand = async (): Promise<void> => {
    if (!status.serveCommand) return;
    await navigator.clipboard.writeText(status.serveCommand);
    Message.success(t('modelAdvisor.cookbook.copied'));
  };

  /** The chosen-backend label, or an override Select when >1 backend is viable. */
  const backendChooser = (): React.ReactNode => {
    if (viable.length > 1) {
      return (
        <Tooltip content={t('modelAdvisor.cookbook.backendTip')}>
          <Select
            size='mini'
            value={selected}
            onChange={(v) => setOverride(v as CookbookBackend)}
            className={styles.backendSelect}
            aria-label={t('modelAdvisor.cookbook.backendTip')}
          >
            {viable.map((b) => (
              <Select.Option key={b} value={b}>
                {t(BACKEND_LABEL_KEY[b])}
              </Select.Option>
            ))}
          </Select>
        </Tooltip>
      );
    }
    if (viable.length === 1) {
      return (
        <Tooltip content={t('modelAdvisor.cookbook.backendTip')}>
          <Tag color='arcoblue' size='small'>
            {t(BACKEND_LABEL_KEY[viable[0]])}
          </Tag>
        </Tooltip>
      );
    }
    return null;
  };

  // ── This model is the active serve ────────────────────────────────────────
  if (isServingThis && (status.state === 'starting' || status.state === 'downloading')) {
    return (
      <Tag icon={<Loading className={styles.spin} />} color='arcoblue'>
        {status.state === 'downloading'
          ? t('modelAdvisor.cookbook.status.downloading')
          : t('modelAdvisor.cookbook.status.starting')}
      </Tag>
    );
  }

  if (isServingThis && status.state === 'ready') {
    return (
      <Space size={6}>
        <Tag color='green'>{t('modelAdvisor.cookbook.status.ready', { port: status.port })}</Tag>
        <Button size='mini' icon={<Power />} loading={busy} onClick={() => run(controller.stopServe)}>
          {t('modelAdvisor.cookbook.stop')}
        </Button>
      </Space>
    );
  }

  if (isServingThis && status.state === 'needs_backend') {
    return (
      <div className={styles.serveDegraded}>
        <span className={styles.serveHint}>{t('modelAdvisor.cookbook.needsBackend')}</span>
        <Space size={6}>
          <Button size='mini' icon={<Copy />} onClick={() => void copyCommand()}>
            {t('modelAdvisor.cookbook.copyCommand')}
          </Button>
          <Button size='mini' icon={<FolderOpen />} loading={busy} onClick={() => run(controller.locateBackend)}>
            {t('modelAdvisor.cookbook.locate')}
          </Button>
        </Space>
      </div>
    );
  }

  if (isServingThis && status.state === 'error') {
    return (
      <Space size={6}>
        <Tooltip content={status.error ?? ''}>
          <Tag color='red'>{t('modelAdvisor.cookbook.status.error')}</Tag>
        </Tooltip>
        <Button
          size='mini'
          type='primary'
          loading={busy}
          onClick={() => run(() => controller.serve(modelId, selected))}
        >
          {t('modelAdvisor.cookbook.retry')}
        </Button>
      </Space>
    );
  }

  // ── Downloading ───────────────────────────────────────────────────────────
  if (isDownloading) {
    const pct =
      prog && prog.totalBytes && prog.totalBytes > 0
        ? Math.min(100, Math.round((prog.bytesDownloaded / prog.totalBytes) * 100))
        : undefined;
    return (
      <Space size={6}>
        <Progress
          size='small'
          className={styles.dlProgress}
          percent={pct ?? 0}
          status='normal'
          showText={pct !== undefined}
        />
        <Button size='mini' status='danger' onClick={() => void controller.cancelDownload(modelId)}>
          {t('modelAdvisor.cookbook.cancel')}
        </Button>
      </Space>
    );
  }

  // ── Idle: backend chooser + primary action ────────────────────────────────
  // llama.cpp pre-caches the GGUF (Download) before Serve; vLLM/ollama self-pull
  // straight from Serve.
  const primary =
    needsGguf && !isDownloaded ? (
      <Button size='mini' icon={<Download />} loading={busy} onClick={() => run(() => controller.download(modelId))}>
        {t('modelAdvisor.cookbook.download')}
      </Button>
    ) : (
      <Button
        size='mini'
        type='primary'
        icon={<PlayOne />}
        loading={busy}
        onClick={() => run(() => controller.serve(modelId, selected))}
      >
        {t('modelAdvisor.cookbook.serve')}
      </Button>
    );

  return (
    <Space size={6}>
      {backendChooser()}
      {primary}
    </Space>
  );
};

export default CookbookServeControls;
