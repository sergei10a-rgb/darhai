/**
 * Unit tests for composePrompt - the single composer that joins
 * Constitution + Specialist Overlay + backend basePrompt into the
 * system-slot string injected by every backend.
 *
 * Bridge module is fully mocked; no real fs, no real ~/.darhai/.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
// Independent oracle: the real tokenizer, imported straight from the package.
// The production code must agree with THIS, not with a character heuristic.
import { countTokens as o200k } from 'gpt-tokenizer/encoding/o200k_base';

vi.mock('@process/bridge/conversation/constitutionBridge', () => ({
  readConstitutionWithOverlay: vi.fn(),
}));

import { readConstitutionWithOverlay } from '@process/bridge/conversation/constitutionBridge';
import { composePrompt } from '@process/services/constitution/composePrompt';
import { loadTokenEncoder } from '@/common/utils/tokenCount';

const mockBridge = vi.mocked(readConstitutionWithOverlay);

const SEP = '\n\n---\n\n';

/**
 * A real Mongolian Cyrillic paragraph. `Math.ceil(len / 4)` undercounts this
 * by ~1.6x, which is the whole reason this file stopped asserting the
 * heuristic.
 */
const CYRILLIC = `# Дархай — Үндсэн дүрэм

Хэрэглэгчтэй монгол кирилл үсгээр харилц. Тоо, босго, хязгаарыг хэзээ ч бүү таа —
хэмж. Завсрын биш эцсийн гаралтыг хэмж. Шалгуураа эсрэгээр нь шалга.
`.repeat(12);

/**
 * Repo-style English markdown. MEASURED: 5,340 chars, len/4 = 1,335,
 * o200k_base = 1,464 - 8.8% apart, i.e. English was never the broken case.
 */
const ASCII = `## Code Conventions

- **Components**: PascalCase (\`Button.tsx\`, \`Modal.tsx\`)
- **Utilities**: camelCase (\`formatDate.ts\`)
- **Hooks**: camelCase with a \`use\` prefix (\`useTheme.ts\`)
- **Constants files**: camelCase (\`constants.ts\`)

Strict mode is enabled: no \`any\`, no implicit returns. Use the path aliases
\`@/*\`, \`@process/*\`, \`@renderer/*\`. Prefer \`type\` over \`interface\`.
Run \`bun run test\` before every commit; the coverage target is 80%.
`.repeat(12);

describe('composePrompt', () => {
  beforeAll(async () => {
    // composePrompt counts with the real tokenizer once it is loaded. Await it
    // here so every assertion below is deterministic.
    await loadTokenEncoder();
  });

  beforeEach(() => {
    mockBridge.mockReset();
  });

  it('returns constitution-only text when no assistantId and no basePrompt', () => {
    const constitution = '# Wayland Constitution\n\nBe direct.';
    mockBridge.mockReturnValue({ constitution, overlay: null });

    const result = composePrompt();

    expect(result.text).toBe(constitution);
    expect(result.hadOverlay).toBe(false);
    expect(result.approxTokens).toBe(o200k(constitution));
    expect(result.anthropicCacheControl).toEqual({ type: 'ephemeral' });
    expect(mockBridge).toHaveBeenCalledWith(undefined);
  });

  it('returns constitution-only text when assistantId is set but overlay file is missing', () => {
    const constitution = 'CONSTITUTION_BODY';
    mockBridge.mockReturnValue({ constitution, overlay: null });

    const result = composePrompt({ assistantId: 'builtin-word-creator' });

    expect(result.text).toBe(constitution);
    expect(result.hadOverlay).toBe(false);
    expect(result.approxTokens).toBe(o200k(constitution));
    expect(mockBridge).toHaveBeenCalledWith('builtin-word-creator');
  });

  it('joins constitution + overlay with separator when an overlay exists', () => {
    const constitution = 'CONSTITUTION_BODY';
    const overlay = 'OVERLAY_BODY';
    mockBridge.mockReturnValue({ constitution, overlay });

    const result = composePrompt({ assistantId: 'spark' });

    expect(result.text).toBe(`${constitution}${SEP}${overlay}`);
    expect(result.hadOverlay).toBe(true);
    expect(result.approxTokens).toBe(o200k(result.text));
  });

  it('joins constitution + overlay + basePrompt in exact order', () => {
    const constitution = 'C';
    const overlay = 'O';
    const basePrompt = 'BASE';
    mockBridge.mockReturnValue({ constitution, overlay });

    const result = composePrompt({ assistantId: 'copy', basePrompt });

    expect(result.text).toBe(`${constitution}${SEP}${overlay}${SEP}${basePrompt}`);
    expect(result.hadOverlay).toBe(true);
    // approxTokens always derived from final composed text
    expect(result.approxTokens).toBe(o200k(result.text));
  });

  it('returns basePrompt-only when constitution is missing', () => {
    const basePrompt = 'just a base prompt';
    mockBridge.mockReturnValue({ constitution: '', overlay: null });

    const result = composePrompt({ basePrompt });

    expect(result.text).toBe(basePrompt);
    expect(result.approxTokens).toBe(o200k(basePrompt));
    expect(result.hadOverlay).toBe(false);
  });

  it('always returns anthropicCacheControl of { type: "ephemeral" }', () => {
    // Case A: constitution-only
    mockBridge.mockReturnValueOnce({ constitution: 'X', overlay: null });
    const a = composePrompt();
    expect(a.anthropicCacheControl).toEqual({ type: 'ephemeral' });

    // Case B: constitution + overlay + base
    mockBridge.mockReturnValueOnce({ constitution: 'X', overlay: 'Y' });
    const b = composePrompt({ assistantId: 'foo', basePrompt: 'Z' });
    expect(b.anthropicCacheControl).toEqual({ type: 'ephemeral' });
  });

  it('approxTokens equals the real tokenizer count across compositions', () => {
    const cases: Array<{
      constitution: string;
      overlay: string | null;
      basePrompt?: string;
      assistantId?: string;
    }> = [
      { constitution: 'short', overlay: null },
      { constitution: 'a'.repeat(101), overlay: null },
      { constitution: 'a'.repeat(33), overlay: 'b'.repeat(17), assistantId: 'foo' },
      { constitution: 'C', overlay: 'O', basePrompt: 'BASE', assistantId: 'foo' },
      { constitution: '', overlay: null, basePrompt: 'x'.repeat(7) },
    ];

    for (const c of cases) {
      mockBridge.mockReturnValueOnce({ constitution: c.constitution, overlay: c.overlay });
      const result = composePrompt({ assistantId: c.assistantId, basePrompt: c.basePrompt });

      const parts = [c.constitution, c.overlay ?? '', c.basePrompt ?? ''].filter((p) => p && p.length > 0);
      const expectedText = parts.join(SEP);
      const expectedTokens = o200k(expectedText);

      expect(result.text).toBe(expectedText);
      expect(result.approxTokens).toBe(expectedTokens);
    }
  });

  it('does not propagate bridge errors; falls back to basePrompt with safe defaults', () => {
    // Silence the expected console.error noise for this assertion.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBridge.mockImplementation(() => {
      throw new Error('disk on fire');
    });

    // basePrompt='' case → text === ''
    const empty = composePrompt({ basePrompt: '' });
    expect(empty.text).toBe('');
    expect(empty.approxTokens).toBe(0);
    expect(empty.hadOverlay).toBe(false);
    expect(empty.anthropicCacheControl).toEqual({ type: 'ephemeral' });

    // basePrompt populated → text === basePrompt
    const withBase = composePrompt({ basePrompt: 'FALLBACK' });
    expect(withBase.text).toBe('FALLBACK');
    expect(withBase.approxTokens).toBe(o200k('FALLBACK'));
    expect(withBase.hadOverlay).toBe(false);
    expect(withBase.anthropicCacheControl).toEqual({ type: 'ephemeral' });

    errSpy.mockRestore();
  });

  /**
   * The regression this file exists to lock down.
   *
   * MEASURED on the shipped DEFAULT_CONSTITUTION (7,185 chars, 5,180 of them
   * non-ASCII): `Math.ceil(len / 4)` = 1,797, o200k_base = 2,882, cl100k_base
   * = 5,411. The heuristic is 38% low, so a Mongolian user was shown a number
   * that let the ceiling warning fire far too late.
   */
  it('counts Cyrillic within 5% of the real tokenizer (heuristic is ~38% low)', () => {
    mockBridge.mockReturnValue({ constitution: CYRILLIC, overlay: null });

    const truth = o200k(CYRILLIC);
    const heuristic = Math.ceil(CYRILLIC.length / 4);
    // Guard the premise: this input really does break the old heuristic.
    expect(heuristic).toBeLessThan(truth * 0.75);

    const result = composePrompt();
    expect(result.approxTokens).toBeGreaterThanOrEqual(truth * 0.95);
    expect(result.approxTokens).toBeLessThanOrEqual(truth * 1.05);
    expect(result.tokenCounter).toBe('o200k_base');
  });

  /**
   * English users must not regress. On ASCII prose the old heuristic was
   * already within ~1% of the truth, so the new counter has to stay there too.
   */
  it('stays stable for pure-ASCII input (no regression for English users)', () => {
    mockBridge.mockReturnValue({ constitution: ASCII, overlay: null });

    const truth = o200k(ASCII);
    const heuristic = Math.ceil(ASCII.length / 4);

    const result = composePrompt();
    expect(result.approxTokens).toBe(truth);

    // An English user sees essentially the number they saw before the change...
    const asciiDrift = Math.abs(truth - heuristic) / truth;
    expect(asciiDrift).toBeLessThan(0.1);

    // ...while a Cyrillic document moves by a multiple of that. The fix is
    // targeted at the case that was actually broken.
    const cyrillicDrift = Math.abs(o200k(CYRILLIC) - Math.ceil(CYRILLIC.length / 4)) / o200k(CYRILLIC);
    expect(cyrillicDrift).toBeGreaterThan(asciiDrift * 3);
  });

  it('labels which counter produced the number', () => {
    mockBridge.mockReturnValue({ constitution: 'X', overlay: null });
    expect(composePrompt().tokenCounter).toBe('o200k_base');
  });
});
