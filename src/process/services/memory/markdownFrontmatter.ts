/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure frontmatter parser for IJFW memory markdown files.
 * Handles the `---\nkey: value\n---\nbody` block format.
 * No external deps.
 */

type FrontmatterValue = string | string[];

type ParsedBlock = {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
};

/** Parse a YAML-like tags array: `[a, b, c]` → `['a', 'b', 'c']`. */
function parseTagsArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return trimmed ? [trimmed] : [];
  }
  const inner = trimmed.slice(1, -1);
  return inner
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Parse a single frontmatter block (lines between `---` markers). */
function parseFrontmatterBlock(fmText: string): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {};
  const lines = fmText.split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    if (key === 'tags') {
      result[key] = parseTagsArray(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Split a full IJFW memory markdown file into its constituent blocks.
 *
 * Format:
 *   <!-- ijfw-schema: v1 --> (optional file header — skipped)
 *   # Heading (optional file header — skipped)
 *   ---
 *   type: decision
 *   summary: ...
 *   stored: 2026-05-15T06:36:52.422Z
 *   tags: [a, b]
 *   ---
 *   body text ...
 *   ---
 *   type: pattern
 *   ...
 *
 * The file alternates between frontmatter sections (between `---` lines) and
 * body sections. A lone `---` line acts as a separator.
 */
export function parseMarkdownBlocks(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];

  // Normalise line endings.
  const text = content.replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  // Strip file-level header lines (comments, H1 headings).
  let startIdx = 0;
  while (startIdx < lines.length) {
    const line = lines[startIdx].trim();
    if (line.startsWith('<!--') || line.startsWith('#')) {
      startIdx++;
    } else {
      break;
    }
  }

  // State machine: collect frontmatter lines then body lines.
  type State = 'between' | 'in_frontmatter' | 'in_body';
  let state: State = 'between';
  let fmLines: string[] = [];
  let bodyLines: string[] = [];
  let currentFm: Record<string, FrontmatterValue> = {};

  const flush = () => {
    if (Object.keys(currentFm).length > 0 || bodyLines.length > 0) {
      blocks.push({
        frontmatter: currentFm,
        body: bodyLines.join('\n').trim(),
      });
    }
    currentFm = {};
    fmLines = [];
    bodyLines = [];
  };

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '---') {
      if (state === 'between') {
        // Start of a new frontmatter block.
        state = 'in_frontmatter';
        fmLines = [];
      } else if (state === 'in_frontmatter') {
        // End of frontmatter — parse it and start collecting body.
        currentFm = parseFrontmatterBlock(fmLines.join('\n'));
        bodyLines = [];
        state = 'in_body';
      } else {
        // `---` while in body = separator between entries.
        flush();
        state = 'in_frontmatter';
        fmLines = [];
      }
    } else if (state === 'in_frontmatter') {
      fmLines.push(line);
    } else if (state === 'in_body') {
      bodyLines.push(line);
    }
    // `between` state and non-`---` line: skip (file header territory).
  }

  // Flush the last block if we ended mid-body.
  if (state === 'in_body') {
    flush();
  }

  return blocks;
}
