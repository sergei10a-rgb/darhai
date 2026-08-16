/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Mongolian voice install card: three components (audio.cpp STT runtime,
 * Nemotron GGUF model, kitten-mn TTS bundle) with per-component state, live
 * download progress, and one Install action that states the TOTAL download
 * size BEFORE fetching anything - the llama.cpp runtime's consent principle
 * ("this is the CPU build, 147 MB" comes before the download, not after).
 *
 * Also exports {@link NemotronInstallHint}, the small pointer the STT provider
 * select shows under 'nemotron-mn' while the components it needs are missing.
 */

import { CheckCircle2 } from 'lucide-react';
import { Button, Divider, Progress } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MONGOL_VOICE_COMPONENTS } from '@/common/types/mongolVoice';
import type { MongolVoiceComponent, MongolVoiceInstallProgress } from '@/common/types/mongolVoice';
import { componentState, useMongolVoice } from './useMongolVoice';

/** i18n label key per component. */
const LABEL_KEYS: Record<MongolVoiceComponent, string> = {
  'stt-runtime': 'settings.mongolVoice.componentSttRuntime',
  'stt-model': 'settings.mongolVoice.componentSttModel',
  'tts-bundle': 'settings.mongolVoice.componentTtsBundle',
};

/** Bytes -> whole decimal megabytes, the unit every size string shows. */
const toMb = (bytes: number): number => Math.round(bytes / 1_000_000);

/** Percent for a progress frame; verify/extract/finalize park the bar at 100. */
const toPercent = (p: MongolVoiceInstallProgress): number => {
  if (p.bytesTotal <= 0) return 0;
  return Math.min(100, Math.round((p.bytesDone / p.bytesTotal) * 100));
};

const ComponentRow: React.FC<{
  component: MongolVoiceComponent;
  installed: boolean;
  bytes: number;
  frame: MongolVoiceInstallProgress | undefined;
}> = ({ component, installed, bytes, frame }) => {
  const { t } = useTranslation();
  const sizeLabel = t('settings.mongolVoice.sizeMb', { size: toMb(bytes) });
  return (
    <div className='flex items-center justify-between gap-12px min-h-28px'>
      <div className='flex flex-col'>
        <span className='text-13px text-t-primary'>{t(LABEL_KEYS[component])}</span>
        <span className='text-12px text-t-tertiary'>{sizeLabel}</span>
      </div>
      {installed === true ? (
        <span className='flex items-center gap-6px text-12px text-[var(--success)]'>
          <CheckCircle2 size={14} />
          {t('settings.mongolVoice.stateInstalled')}
        </span>
      ) : frame !== undefined ? (
        <div className='flex items-center gap-8px w-45%'>
          <Progress percent={toPercent(frame)} animation className='flex-1' />
          <span className='text-12px text-t-tertiary whitespace-nowrap'>
            {frame.phase === 'download'
              ? t('settings.mongolVoice.stateDownloading')
              : t('settings.mongolVoice.stateFinalizing')}
          </span>
        </div>
      ) : (
        <span className='text-12px text-t-tertiary'>{t('settings.mongolVoice.stateNotInstalled')}</span>
      )}
    </div>
  );
};

export const MongolVoiceInstallCard: React.FC = () => {
  const { t } = useTranslation();
  const { status, progress, installing, error, installAll, cancelInstall } = useMongolVoice();

  if (status === null) return null;

  const missing = MONGOL_VOICE_COMPONENTS.filter((component) => {
    const state = componentState(status, component);
    return state.installed === false && state.supported === true;
  });
  const unsupported = MONGOL_VOICE_COMPONENTS.every(
    (component) => componentState(status, component).supported === false
  );
  const allInstalled = status.sttReady === true && status.ttsReady === true;
  const totalMb = toMb(missing.reduce((sum, component) => sum + componentState(status, component).bytes, 0));

  return (
    <div className='px-[12px] md:px-[32px] py-[24px] bg-[var(--color-bg-2)] rd-12px border-2 border-solid border-[var(--color-border-2)]'>
      <div className='flex flex-col gap-4px mb-8px'>
        <span className='text-14px text-t-primary'>{t('settings.mongolVoice.title')}</span>
        <span className='text-13px text-t-secondary'>{t('settings.mongolVoice.description')}</span>
      </div>

      <Divider className='mt-0px mb-16px' />

      <div className='flex flex-col gap-12px'>
        {MONGOL_VOICE_COMPONENTS.map((component) => {
          const state = componentState(status, component);
          return (
            <ComponentRow
              key={component}
              component={component}
              installed={state.installed}
              bytes={state.bytes}
              frame={progress[component]}
            />
          );
        })}
      </div>

      <div className='flex flex-col gap-8px mt-16px'>
        {unsupported === true ? (
          <span className='text-12px text-t-tertiary'>{t('settings.mongolVoice.unsupported')}</span>
        ) : allInstalled === true ? (
          <span className='flex items-center gap-6px text-12px text-[var(--success)]'>
            <CheckCircle2 size={14} />
            {t('settings.mongolVoice.installed')}
          </span>
        ) : installing === true ? (
          <div className='flex items-center gap-8px'>
            <Button size='small' onClick={() => void cancelInstall()}>
              {t('settings.mongolVoice.cancel')}
            </Button>
          </div>
        ) : (
          <div className='flex items-center gap-12px'>
            <Button type='primary' size='small' onClick={() => void installAll()}>
              {t('settings.mongolVoice.installAll')}
            </Button>
            {/* The consent line: the total the button will fetch, stated first. */}
            <span className='text-12px text-t-secondary'>
              {t('settings.mongolVoice.totalDownload', {
                size: t('settings.mongolVoice.sizeMb', { size: totalMb }),
              })}
            </span>
          </div>
        )}
        {error !== null && (
          <span className='text-12px text-[var(--danger)]'>
            {t('settings.mongolVoice.installError')}: {error.code}
            {error.message ? ` — ${error.message}` : ''}
          </span>
        )}
      </div>
    </div>
  );
};

/**
 * Shown under the STT provider select while 'nemotron-mn' is chosen but the
 * runtime + model it needs are not both installed - points at the install
 * card instead of letting the first transcription fail with an error code.
 */
export const NemotronInstallHint: React.FC = () => {
  const { t } = useTranslation();
  const { status } = useMongolVoice();
  if (status === null || status.sttReady === true) return null;
  return <span className='text-12px text-[var(--warning)]'>{t('settings.speechToTextNemotronInstallHint')}</span>;
};

export default MongolVoiceInstallCard;
