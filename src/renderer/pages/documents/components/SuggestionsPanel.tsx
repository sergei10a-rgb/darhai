/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@arco-design/web-react';
import { Check, X } from 'lucide-react';
import type { AiSuggestion } from '@/common/types/documents';
import styles from '../Documents.module.css';

type SuggestionsPanelProps = {
  suggestions: AiSuggestion[];
  onAccept: (index: number) => void;
  onReject: (index: number) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
};

/**
 * The accept / reject panel for non-destructive AI suggestions. Each card shows
 * the find -> suggest diff plus the model's reason; accepting applies the change
 * to the document, rejecting discards it. Nothing is written until accepted.
 */
const SuggestionsPanel: React.FC<SuggestionsPanelProps> = ({
  suggestions,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
}) => {
  const { t } = useTranslation();
  if (suggestions.length === 0) return null;

  return (
    <div className={styles.suggestions} data-testid='documents-suggestions'>
      <div className={styles.suggestionsHeader}>
        <span className={styles.suggestionsTitle}>
          {t('documents.suggestions.title')} ({suggestions.length})
        </span>
        <div className={styles.suggestionsBulk}>
          <Button size='mini' type='text' onClick={onAcceptAll} data-testid='documents-suggestions-accept-all'>
            {t('documents.suggestions.acceptAll')}
          </Button>
          <Button size='mini' type='text' onClick={onRejectAll} data-testid='documents-suggestions-reject-all'>
            {t('documents.suggestions.rejectAll')}
          </Button>
        </div>
      </div>

      <ul className={styles.suggestionsList}>
        {suggestions.map((suggestion, index) => (
          <li key={`${suggestion.find}-${index}`} className={styles.suggestionCard} data-testid='documents-suggestion'>
            <div className={styles.suggestionDiff}>
              <span className={styles.suggestionFind}>{suggestion.find}</span>
              <span className={styles.suggestionArrow} aria-hidden='true'>
                →
              </span>
              <span className={styles.suggestionReplace}>{suggestion.suggest}</span>
            </div>
            <p className={styles.suggestionReason}>{suggestion.reason}</p>
            <div className={styles.suggestionActions}>
              <Button
                size='mini'
                type='primary'
                icon={<Check size={13} />}
                onClick={() => onAccept(index)}
                data-testid='documents-suggestion-accept'
              >
                {t('documents.suggestions.accept')}
              </Button>
              <Button
                size='mini'
                icon={<X size={13} />}
                onClick={() => onReject(index)}
                data-testid='documents-suggestion-reject'
              >
                {t('documents.suggestions.reject')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default SuggestionsPanel;
