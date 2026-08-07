/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Proof that the Mongolian library locale reaches the actual components.
 *
 * The sibling test checks the locale object is complete. That is necessary and
 * not sufficient: an object can be perfect and still never be handed to
 * `ConfigProvider`, or be handed to it in a form the components ignore. These
 * render real Arco components and read the words that come out.
 *
 * The empty-state and pagination strings are the ones a Mongolian user meets
 * first and most often, and both come from the library rather than from
 * `locales/`.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConfigProvider, Empty, Pagination } from '@arco-design/web-react';
import dayjs from 'dayjs';
import { resolveArcoLocale } from '@renderer/services/i18n/arcoLocales';

const withLocale = (language: string, ui: React.ReactNode) =>
  render(React.createElement(ConfigProvider, { locale: resolveArcoLocale(language) }, ui));

describe('the library speaking Mongolian', () => {
  it('says "Мэдээлэл алга", not "No data"', () => {
    withLocale('mn-MN', React.createElement(Empty));
    expect(screen.getByText('Мэдээлэл алга')).toBeTruthy();
    expect(screen.queryByText('No data')).toBeNull();
  });

  it('counts pages in Mongolian', () => {
    withLocale('mn-MN', React.createElement(Pagination, { total: 40, showTotal: true, pageSize: 10 }));
    // `total: 'Нийт: {0}'` - the string that used to read "Total: 40".
    expect(screen.getByText(/Нийт: 40/)).toBeTruthy();
  });

  it('still speaks English when the language is English', () => {
    withLocale('en-US', React.createElement(Empty));
    expect(screen.getByText('No data')).toBeTruthy();
  });

  it('speaks German now that de-DE is wired up', () => {
    // One of the six languages that were falling through to English for no
    // reason other than a missing map entry.
    withLocale('de-DE', React.createElement(Empty));
    expect(screen.queryByText('No data')).toBeNull();
  });
});

describe('the Mongolian date format actually formats', () => {
  it('renders a real date, not the format string itself', () => {
    // The month/year formats carry literal Mongolian words that dayjs only
    // keeps out of the pattern if they are bracket-escaped. Get the escaping
    // wrong and the header reads "YYYY оны M-р сар" verbatim - which no unit
    // test on the locale object would notice, because the object is correct.
    const mn = resolveArcoLocale('mn-MN');
    const formatted = dayjs('2026-08-06').locale('mn').format(mn.Calendar.formatMonth);

    expect(formatted).toBe('2026 оны 8-р сар');
    expect(formatted).not.toContain('YYYY');
    expect(formatted).not.toContain('M-');
  });

  it('renders the year on its own the same way', () => {
    const mn = resolveArcoLocale('mn-MN');
    expect(dayjs('2026-08-06').locale('mn').format(mn.Calendar.formatYear)).toBe('2026 он');
  });

  it('has the Mongolian dayjs locale actually loaded', () => {
    // `dayjsLocale: 'mn'` is inert unless the locale file was imported. Without
    // it dayjs silently falls back to English weekday names.
    expect(dayjs('2026-08-06').locale('mn').format('dddd')).not.toMatch(/^[A-Za-z]+$/);
  });
});
