/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import classNames from 'classnames';
import React, { useId } from 'react';
import styles from './CardDisclosureHeader.module.css';

/**
 * The expand/collapse summary row shared by the in-transcript activity cards.
 *
 * WHY IT EXISTS. Both cards previously shipped `<div className={styles.header}
 * onClick={...}>` - no `role`, no `tabIndex`, no key handling. A keyboard or
 * screen-reader user could neither reach the control nor learn that a control
 * was there; nothing was hidden from them only because both cards happen to
 * default to expanded. Two copies of the same defect is also two places to fix
 * it, so the row is one component now.
 *
 * WHY NOT AN ARCO COMPONENT. AGENTS.md bans raw interactive HTML in favour of
 * `@arco-design/web-react`, and Arco has no primitive for a bare inline
 * disclosure row: `Collapse` brings panel chrome, borders and its own layout,
 * which would repaint every transcript card. So this follows the repo's own
 * accessible-disclosure precedent instead - `SiderAccordionShell` uses exactly
 * this shape (`role='button'` + `tabIndex` + `aria-expanded` + `aria-controls`
 * + Enter/Space) - and puts it behind ONE component rather than open-coding
 * ARIA attributes in each card.
 */
export const CardDisclosureHeader: React.FC<{
  expanded: boolean;
  onToggle: () => void;
  /** Visible summary text; also the control's accessible name. */
  label: string;
  /** `id` of the region this row controls, so the toggle announces its target. */
  bodyId: string;
  /** Status glyph shown before the arrow (spinner, tick, dot). */
  leading?: React.ReactNode;
  /**
   * Typography of the summary. `strong` for the workflow run card, whose title
   * is the run's name; `muted` for sub-agent activity, which is deliberately
   * quieter than the conversation around it.
   */
  emphasis?: 'strong' | 'muted';
  'data-testid'?: string;
}> = ({ expanded, onToggle, label, bodyId, leading, emphasis = 'strong', 'data-testid': testId }) => {
  const fallbackId = useId();

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Enter and Space are what a native button answers to; `preventDefault`
    // stops Space from scrolling the transcript out from under the user.
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onToggle();
    }
  };

  return (
    <div
      role='button'
      tabIndex={0}
      aria-expanded={expanded}
      aria-controls={bodyId || fallbackId}
      aria-label={label}
      className={classNames(styles.header, emphasis === 'muted' && styles.muted)}
      onClick={onToggle}
      onKeyDown={handleKeyDown}
      data-testid={testId ?? 'card-disclosure-header'}
    >
      {leading}
      {/* Decorative: `aria-expanded` already carries the state, and reading
          "black right-pointing triangle" adds nothing. */}
      <span className={classNames(styles.arrow, expanded && styles.arrowExpanded)} aria-hidden='true'>
        {'▶'}
      </span>
      <span className={styles.summary}>{label}</span>
    </div>
  );
};

export default CardDisclosureHeader;
