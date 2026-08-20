/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The user-visible half of the token-count fix.
 *
 * Fixing `composePrompt` alone changes NOTHING the user sees: the Constitution
 * settings page and the specialist overlay editor each recomputed the estimate
 * themselves with `Math.ceil(value.length / 4)`. These tests read the number
 * that is actually rendered and compare it against the real tokenizer.
 */

import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
// Independent oracle - the real tokenizer, straight from the package.
import { countTokens as o200k } from 'gpt-tokenizer/encoding/o200k_base';

/** Interpolating `t` so `{{value}}` placeholders resolve to real numbers. */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, opts?: Record<string, unknown>) => {
      let out = typeof fallback === 'string' ? fallback : key;
      for (const [k, v] of Object.entries(opts ?? {})) {
        out = out.split(`{{${k}}}`).join(String(v));
      }
      return out;
    },
    i18n: { language: 'en-US', changeLanguage: vi.fn() },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@renderer/pages/conversation/Preview/components/editors/TipTapMarkdownEditor', () => ({
  default: ({ value }: { value: string }) => <div data-testid='editor'>{value.length}</div>,
}));

vi.mock('@renderer/pages/settings/ConstitutionSettings/SpecialistOverlays', () => ({
  default: () => <div data-testid='overlays' />,
}));

import ConstitutionSettings from '@renderer/pages/settings/ConstitutionSettings';
import SpecialistOverlayEditor from '@renderer/pages/settings/ConstitutionSettings/SpecialistOverlayEditor';
import { loadTokenEncoder, TOKEN_WARNING_TOKENS, tokenLevel } from '@/common/utils/tokenCount';
import enSettings from '@renderer/services/i18n/locales/en-US/settings.json';

/**
 * Mongolian Cyrillic, the case the character heuristic gets wrong.
 * MEASURED on this exact string below (see the premise assertion in each test).
 */
const CYRILLIC = `# Дархай — Үндсэн дүрэм

Хэрэглэгчтэй монгол кирилл үсгээр харилц. Тоо, босго, хязгаарыг хэзээ ч бүү таа —
хэмж. Завсрын биш эцсийн гаралтыг хэмж. Шалгуураа эсрэгээр нь шалга: «ажиллахгүй
байвал энэ тест унах уу?» гэж асуу.
`.repeat(24);

/** SettingsPageShell calls useNavigate(), so every render needs a Router. */
const renderInRouter = (node: React.ReactElement): void => {
  render(<MemoryRouter>{node}</MemoryRouter>);
};

/**
 * Reads the number out of the counter element. Matching on text alone is
 * ambiguous here - the ceiling warning copy also contains "2,000 tokens".
 */
const renderedTokenCount = async (testId: string): Promise<number> => {
  const node = await screen.findByTestId(testId);
  const match = /([\d,]+)\s+tokens/.exec(node.textContent ?? '');
  if (!match) throw new Error(`no token count in ${JSON.stringify(node.textContent)}`);
  return Number(match[1].replace(/,/g, ''));
};

beforeAll(async () => {
  await loadTokenEncoder();
});

beforeEach(() => {
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    readConstitution: vi.fn().mockResolvedValue(CYRILLIC),
    writeConstitution: vi.fn().mockResolvedValue(true),
    resetConstitution: vi.fn().mockResolvedValue(CYRILLIC),
    readConstitutionSpecialist: vi.fn().mockResolvedValue(CYRILLIC),
    writeConstitutionSpecialist: vi.fn().mockResolvedValue(true),
  };
});

describe('Constitution token counter (renderer)', () => {
  it('shows a Cyrillic count within 5% of the real tokenizer', async () => {
    const truth = o200k(CYRILLIC);
    // Guard the premise: this input really does break the old heuristic.
    expect(Math.ceil(CYRILLIC.length / 4)).toBeLessThan(truth * 0.75);

    renderInRouter(<ConstitutionSettings />);

    await waitFor(async () => {
      const shown = await renderedTokenCount('constitution-token-count');
      expect(shown).toBeGreaterThanOrEqual(truth * 0.95);
      expect(shown).toBeLessThanOrEqual(truth * 1.05);
    });
  });

  it('names the counter next to the number instead of showing a bare figure', async () => {
    renderInRouter(<ConstitutionSettings />);
    await waitFor(async () => {
      const node = await screen.findByTestId('constitution-token-count');
      expect(node.textContent).toMatch(/[\d,]+\s+tokens/);
      expect(node.textContent).toContain('o200k');
      expect(node.textContent).toContain('≈');
    });
  });

  it('fires the ceiling warning for a Cyrillic document that is over it', async () => {
    // MEASURED: this document is over 2,000 real tokens but under 2,000
    // heuristic "tokens", so the old code showed no warning at all.
    expect(o200k(CYRILLIC)).toBeGreaterThan(2000);
    expect(Math.ceil(CYRILLIC.length / 4)).toBeLessThan(2000);

    renderInRouter(<ConstitutionSettings />);
    // Located by test id, not by copy: the wording changed once already
    // (it used to claim the ceiling was being "approached" while firing only
    // after it had been passed), and a text-matched assertion would have had to
    // be edited alongside the bug rather than catching it.
    await screen.findByTestId('constitution-token-warning');
  });

  /**
   * The warning copy has to agree with the threshold that triggers it.
   *
   * `tokenLevel` returns 'warning' at tokens >= TOKEN_WARNING_TOKENS, i.e. the
   * guideline is already reached. Every locale nonetheless said the user was
   * "approaching" it - so the one line shown on screen contradicted the very
   * condition that produced it. Caught by eye at 2,767 tokens.
   */
  it('does not describe a passed threshold as one being approached', () => {
    expect(tokenLevel(TOKEN_WARNING_TOKENS)).toBe('warning');
    expect(tokenLevel(TOKEN_WARNING_TOKENS - 1)).toBe('ok');
    // English is the reference locale; the other twelve are translations of it.
    const warning = String(enSettings.constitutionPage.tokenWarning).toLowerCase();
    expect(warning).not.toContain('approaching');
    expect(warning).not.toContain('nearing');
  });

  it('counts the specialist overlay editor with the same module', async () => {
    const truth = o200k(CYRILLIC);
    renderInRouter(<SpecialistOverlayEditor id='spark' onClose={() => {}} />);

    await waitFor(async () => {
      const shown = await renderedTokenCount('overlay-token-count');
      expect(shown).toBeGreaterThanOrEqual(truth * 0.95);
      expect(shown).toBeLessThanOrEqual(truth * 1.05);
    });
  });
});
