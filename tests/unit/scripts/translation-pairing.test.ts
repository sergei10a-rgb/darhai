import { describe, it, expect } from 'vitest';
import {
  documentLinksTo,
  gitBlobHash,
  parseTranslationManifest,
  parseTranslationPairingCliArgs,
  renderTranslationManifest,
  structuralSignature,
  structuralSignatureDiff,
  switcherTarget,
} from '../../../scripts/translation-pairing.ts';

describe('gitBlobHash', () => {
  it('matches `git hash-object` for the empty blob', () => {
    // Arrange / Act
    const hash = gitBlobHash(Buffer.from('', 'utf8'));

    // Assert — verified against `printf '' | git hash-object --stdin`
    expect(hash).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('matches `git hash-object` for ASCII content', () => {
    expect(gitBlobHash(Buffer.from('hello', 'utf8'))).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  });

  it('matches `git hash-object` for UTF-8 Cyrillic content (byte length, not char length)', () => {
    // 'Дархай\n' is 13 bytes in UTF-8; a char-length hash would diverge here.
    expect(gitBlobHash(Buffer.from('Дархай\n', 'utf8'))).toBe('9c1aac958e29c098966092ac7c5ef4a0a2d33e98');
  });
});

describe('parseTranslationManifest', () => {
  const valid = JSON.stringify({
    pairs: [
      {
        en: 'docs/x.en.md',
        mn: 'docs/x.md',
        enHash: 'a'.repeat(40),
        mnHash: 'b'.repeat(40),
      },
    ],
  });

  it('parses a well-formed manifest', () => {
    const manifest = parseTranslationManifest(valid);
    expect(manifest.pairs).toHaveLength(1);
    expect(manifest.pairs[0]).toEqual({
      en: 'docs/x.en.md',
      mn: 'docs/x.md',
      enHash: 'a'.repeat(40),
      mnHash: 'b'.repeat(40),
    });
  });

  it('rejects invalid JSON', () => {
    expect(() => parseTranslationManifest('{ not json')).toThrow(/not valid JSON/);
  });

  it('rejects an unsupported top-level field', () => {
    expect(() => parseTranslationManifest('{"pairs":[],"extra":1}')).toThrow(/unsupported field/);
  });

  it('rejects a non-array pairs field', () => {
    expect(() => parseTranslationManifest('{"pairs":{}}')).toThrow(/"pairs" must be an array/);
  });

  it('rejects an en path that is itself a .mn.md file', () => {
    const bad = JSON.stringify({
      pairs: [{ en: 'docs/x.mn.md', mn: 'docs/x.md', enHash: 'a'.repeat(40), mnHash: 'b'.repeat(40) }],
    });
    expect(() => parseTranslationManifest(bad)).toThrow(/\.en must be an English/);
  });

  it('rejects a non-40-hex hash', () => {
    const bad = JSON.stringify({
      pairs: [{ en: 'docs/x.en.md', mn: 'docs/x.md', enHash: 'xyz', mnHash: 'b'.repeat(40) }],
    });
    expect(() => parseTranslationManifest(bad)).toThrow(/enHash must be a 40-hex/);
  });

  it('rejects the same file appearing in two pairs', () => {
    const bad = JSON.stringify({
      pairs: [
        { en: 'docs/x.en.md', mn: 'docs/shared.md', enHash: 'a'.repeat(40), mnHash: 'b'.repeat(40) },
        { en: 'docs/y.en.md', mn: 'docs/shared.md', enHash: 'c'.repeat(40), mnHash: 'd'.repeat(40) },
      ],
    });
    expect(() => parseTranslationManifest(bad)).toThrow(/appears in more than one pair/);
  });

  it('round-trips through render with a trailing newline', () => {
    const manifest = parseTranslationManifest(valid);
    const rendered = renderTranslationManifest(manifest);
    expect(rendered.endsWith('}\n')).toBe(true);
    expect(parseTranslationManifest(rendered)).toEqual(manifest);
  });
});

describe('structuralSignature', () => {
  it('records ATX heading depths in order', () => {
    const sig = structuralSignature('# A\n\n## B\n\n### C\n\n## D\n');
    expect(sig.headings).toEqual([1, 2, 3, 2]);
  });

  it('does NOT treat a # inside a fenced code block as a heading', () => {
    // This is the load-bearing property: code is not prose. A naive line scanner
    // would count the '# still code' line as an h1 and pass a broken translation.
    const md = '# Real heading\n\n```bash\n# still code, not a heading\necho hi\n```\n';
    const sig = structuralSignature(md);
    expect(sig.headings).toEqual([1]);
    expect(sig.code).toHaveLength(1);
  });

  it('captures fenced code verbatim including the info string', () => {
    const md = '```ts\nconst x = 1;\n```\n';
    const sig = structuralSignature(md);
    expect(sig.code).toEqual(['ts\nconst x = 1;']);
  });

  it('records GFM table dimensions as rows x columns', () => {
    const md = '| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n';
    const sig = structuralSignature(md);
    expect(sig.tables).toEqual(['3x3']); // header + 2 body rows, 3 columns
  });

  it('collects inline links, images, and autolinks', () => {
    const md = '![alt](img.png) and [text](page.md) and <https://example.com>\n';
    const sig = structuralSignature(md);
    expect(sig.links).toEqual(['img.png', 'page.md', 'https://example.com']);
  });

  it('excludes the language switcher target from links', () => {
    const md = '# T\n\n[English](x.en.md) | Монгол\n\n[body](other.md)\n';
    const sig = structuralSignature(md, ['x.en.md']);
    expect(sig.links).toEqual(['other.md']); // switcher target dropped, body link kept
  });

  it('does not mistake a link inside a fence for a document link', () => {
    const md = '```md\n[not a real link](trap.md)\n```\n\n[real](keep.md)\n';
    const sig = structuralSignature(md);
    expect(sig.links).toEqual(['keep.md']);
  });
});

describe('structuralSignatureDiff', () => {
  const enMd = '# Title\n\n## Section\n\n```ts\nconst x = 1;\n```\n\n[a](en-a.md) [b](en-b.md)\n';
  const mnMd = '# Гарчиг\n\n## Хэсэг\n\n```ts\nconst x = 1;\n```\n\n[а](mn-a.md) [б](mn-b.md)\n';

  it('is empty for structurally identical documents in different languages', () => {
    const diff = structuralSignatureDiff(structuralSignature(enMd), structuralSignature(mnMd));
    expect(diff).toEqual([]);
  });

  it('treats links as count-only: differing targets with equal count do NOT diverge', () => {
    // en links to en-a.md/en-b.md, mn to mn-a.md/mn-b.md — same count, so a
    // per-locale cross-doc link must not turn the gate red.
    const diff = structuralSignatureDiff(structuralSignature(enMd), structuralSignature(mnMd));
    expect(diff.some((d) => d.includes('link'))).toBe(false);
  });

  it('flags a differing link COUNT', () => {
    const fewer = '# Гарчиг\n\n## Хэсэг\n\n```ts\nconst x = 1;\n```\n\n[а](mn-a.md)\n';
    const diff = structuralSignatureDiff(structuralSignature(enMd), structuralSignature(fewer));
    expect(diff.some((d) => d.includes('link count differs'))).toBe(true);
  });

  it('flags a changed code block (translated code is a bug)', () => {
    const translatedCode = mnMd.replace('const x = 1;', 'const x = 2;');
    const diff = structuralSignatureDiff(structuralSignature(enMd), structuralSignature(translatedCode));
    expect(diff.some((d) => d.includes('code block'))).toBe(true);
  });

  it('flags a changed heading structure', () => {
    const extraHeading = `${mnMd}\n### Нэмэлт\n`;
    const diff = structuralSignatureDiff(structuralSignature(enMd), structuralSignature(extraHeading));
    expect(diff.some((d) => d.includes('heading'))).toBe(true);
  });
});

describe('documentLinksTo / switcherTarget', () => {
  it('finds a switcher link by counterpart basename', () => {
    expect(switcherTarget('docs/foo.en.md')).toBe('foo.en.md');
    expect(documentLinksTo('# T\n\n[English](foo.en.md) | Монгол\n', 'foo.en.md')).toBe(true);
  });

  it('returns false when no link points at the counterpart', () => {
    expect(documentLinksTo('# T\n\nno switcher here\n', 'foo.en.md')).toBe(false);
  });
});

describe('parseTranslationPairingCliArgs', () => {
  it('defaults to a corpus check with no args', () => {
    expect(parseTranslationPairingCliArgs([], 'check')).toEqual({ mode: 'check', anchors: [] });
  });

  it('scopes a check to named anchors', () => {
    expect(parseTranslationPairingCliArgs(['docs/a.md', 'docs/b.md'], 'check')).toEqual({
      mode: 'check',
      anchors: ['docs/a.md', 'docs/b.md'],
    });
  });

  it('treats --list as a corpus-only report', () => {
    expect(parseTranslationPairingCliArgs(['--list'], 'check')).toEqual({ mode: 'list', anchors: [] });
  });

  it('rejects --list combined with paths', () => {
    expect(() => parseTranslationPairingCliArgs(['--list', 'docs/a.md'], 'check')).toThrow(/takes no other flags/);
  });

  it('requires refresh to name pairs or pass --all', () => {
    expect(() => parseTranslationPairingCliArgs([], 'write')).toThrow(/requires the pair/);
  });

  it('accepts refresh --all', () => {
    expect(parseTranslationPairingCliArgs(['--all'], 'write')).toEqual({ mode: 'write', anchors: [] });
  });

  it('rejects unknown flags', () => {
    expect(() => parseTranslationPairingCliArgs(['--bogus'], 'check')).toThrow(/unknown flag/);
  });
});
