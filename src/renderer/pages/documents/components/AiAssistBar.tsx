/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '@arco-design/web-react';
import { Sparkles, Wand2 } from 'lucide-react';
import styles from '../Documents.module.css';

type AiAssistBarProps = {
  busy: boolean;
  /** Rewrite the document in place (AI edit -> new ai version). */
  onImprove: (instruction: string) => void;
  /** Propose non-destructive suggestions (accept / reject in the panel). */
  onSuggest: (instruction: string) => void;
};

/**
 * The AI assist bar: a single instruction field driving two actions - "Improve"
 * rewrites the document (an AI edit that mints a new version) and "Suggest"
 * proposes non-destructive changes rendered in the suggestions panel.
 */
const AiAssistBar: React.FC<AiAssistBarProps> = ({ busy, onImprove, onSuggest }) => {
  const { t } = useTranslation();
  const [instruction, setInstruction] = useState('');

  const trimmed = instruction.trim();
  const disabled = busy || trimmed.length === 0;

  return (
    <div className={styles.assistBar} data-testid='documents-assist-bar'>
      <Input
        className={styles.assistInput}
        value={instruction}
        placeholder={t('documents.ai.placeholder')}
        onChange={setInstruction}
        disabled={busy}
        aria-label={t('documents.ai.placeholder')}
        data-testid='documents-ai-instruction'
      />
      <Button
        type='primary'
        icon={<Wand2 size={15} />}
        loading={busy}
        disabled={disabled}
        onClick={() => onImprove(trimmed)}
        data-testid='documents-ai-improve'
      >
        {t('documents.ai.improve')}
      </Button>
      <Button
        icon={<Sparkles size={15} />}
        disabled={disabled}
        onClick={() => onSuggest(trimmed)}
        data-testid='documents-ai-suggest'
      >
        {t('documents.ai.suggest')}
      </Button>
    </div>
  );
};

export default AiAssistBar;
