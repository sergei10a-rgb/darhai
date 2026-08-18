/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

/**
 * The personal-dictionary table in the STT settings: a wrong → right pair list
 * the user edits, persisted as `tools.speechToText.personalDict` and applied by
 * NemotronStt after glossfix.
 *
 * The `t` mock resolves against the SHIPPED en-US bundle (the
 * CookbookServeControls pattern), so a key that never landed in the locale
 * files resolves to its own name and the name-based queries below fail.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async () => {
  const { readFileSync: read, existsSync: exists } = await import('node:fs');
  const { join: joinPath } = await import('node:path');
  const dir = joinPath(process.cwd(), 'src/renderer/services/i18n/locales/en-US');
  return {
    useTranslation: () => ({
      t: (key: string) => {
        const [namespace, ...path] = key.split('.');
        const file = joinPath(dir, `${namespace}.json`);
        let node: unknown = exists(file) ? JSON.parse(read(file, 'utf-8')) : undefined;
        for (const segment of path) {
          node = node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined;
        }
        return typeof node === 'string' ? node : key;
      },
    }),
  };
});

import PersonalDictEditor from '@renderer/pages/settings/VoiceSettings/PersonalDictEditor';

/** The same lookup the mock does, for assertions. */
function en(key: string): string {
  const [namespace, ...path] = key.split('.');
  const file = join(process.cwd(), 'src/renderer/services/i18n/locales/en-US', `${namespace}.json`);
  let node: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : undefined;
  for (const segment of path) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`en-US has no string at "${key}"`);
  return node;
}

afterEach(() => {
  cleanup();
});

describe('PersonalDictEditor', () => {
  it('renders every stored pair', () => {
    render(<PersonalDictEditor dict={{ коён: 'хоёр', жаргал: 'Жаргал' }} onChange={vi.fn()} />);
    expect(screen.getByText('коён')).toBeTruthy();
    expect(screen.getByText('хоёр')).toBeTruthy();
    expect(screen.getByText('жаргал')).toBeTruthy();
    expect(screen.getByText('Жаргал')).toBeTruthy();
  });

  it('says the list is empty instead of rendering a blank block', () => {
    render(<PersonalDictEditor dict={{}} onChange={vi.fn()} />);
    expect(screen.getByText(en('settings.speechToTextPersonalDictEmpty'))).toBeTruthy();
  });

  it('adds a trimmed pair through the two inputs and the Add button', async () => {
    const onChange = vi.fn();
    render(<PersonalDictEditor dict={{ коён: 'хоёр' }} onChange={onChange} />);

    await userEvent.type(screen.getByPlaceholderText(en('settings.speechToTextPersonalDictWrong')), ' жаргал ');
    await userEvent.type(screen.getByPlaceholderText(en('settings.speechToTextPersonalDictRight')), ' Жаргал ');
    await userEvent.click(screen.getByRole('button', { name: en('settings.speechToTextPersonalDictAdd') }));

    expect(onChange).toHaveBeenCalledWith({ коён: 'хоёр', жаргал: 'Жаргал' });
  });

  it('clears the inputs after a successful add', async () => {
    render(<PersonalDictEditor dict={{}} onChange={vi.fn()} />);
    const wrong = screen.getByPlaceholderText(en('settings.speechToTextPersonalDictWrong'));
    const right = screen.getByPlaceholderText(en('settings.speechToTextPersonalDictRight'));
    await userEvent.type(wrong, 'жаргал');
    await userEvent.type(right, 'Жаргал');
    await userEvent.click(screen.getByRole('button', { name: en('settings.speechToTextPersonalDictAdd') }));
    expect((wrong as HTMLInputElement).value).toBe('');
    expect((right as HTMLInputElement).value).toBe('');
  });

  it('refuses to add while either half of the pair is blank', async () => {
    const onChange = vi.fn();
    render(<PersonalDictEditor dict={{}} onChange={onChange} />);
    const add = screen.getByRole('button', { name: en('settings.speechToTextPersonalDictAdd') });

    await userEvent.click(add);
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.type(screen.getByPlaceholderText(en('settings.speechToTextPersonalDictWrong')), 'жаргал');
    await userEvent.click(add);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes exactly the pair whose Remove button was pressed', async () => {
    const onChange = vi.fn();
    render(<PersonalDictEditor dict={{ коён: 'хоёр', жаргал: 'Жаргал' }} onChange={onChange} />);

    const removeButtons = screen.getAllByRole('button', {
      name: en('settings.speechToTextPersonalDictRemove'),
    });
    expect(removeButtons).toHaveLength(2);
    await userEvent.click(removeButtons[0]);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Record<string, string>;
    expect(Object.keys(next)).toHaveLength(1);
  });
});
