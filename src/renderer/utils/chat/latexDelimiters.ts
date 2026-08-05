/**
 * Convert LaTeX-style math delimiters to dollar-sign delimiters
 * that remark-math can process.
 *
 * \[...\] → $$...$$ (block display math)
 * \(...\) → $...$  (inline math)
 *
 * Content inside fenced code blocks (``` or ~~~) and inline code spans (`)
 * is preserved unchanged.
 */
export function convertLatexDelimiters(text: string): string {
  const segments: string[] = [];
  let pos = 0;

  // Match fenced code blocks (``` or ~~~) and inline code spans
  const codeRegex = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

  let match;
  while ((match = codeRegex.exec(text)) !== null) {
    // Process text before this code segment
    if (match.index > pos) {
      segments.push(replaceDelimiters(text.slice(pos, match.index)));
    }
    // Keep code segment unchanged
    segments.push(match[0]);
    pos = match.index + match[0].length;
  }

  // Process remaining text after last code segment
  if (pos < text.length) {
    segments.push(replaceDelimiters(text.slice(pos)));
  }

  return segments.join('');
}

function replaceDelimiters(text: string): string {
  // Neutralize currency before remark-math sees it. A lone `$` immediately followed
  // by a digit (`$25`, `$2k`, `$50k+`) is a price, not a math delimiter - but
  // remark-math pairs two of them into an inline-math span and renders everything
  // between in italic KaTeX with the spaces collapsed and both `$` eaten. "between
  // $5 and $10" came out as garbled math, in any message that discussed money.
  //
  // Escaping to `\$` keeps it literal. `$$` display delimiters (a `$` preceded by
  // `$`) and already-escaped `\$` are both skipped by the lookbehind, and real
  // inline math starts with a non-digit (`$x$`, `$\alpha$`) so it is untouched.
  // This runs FIRST, before `\(...\)` becomes `$...$`, so converted math is never
  // re-examined by it.
  text = text.replace(/(?<![\\$])\$(?=\d)/g, () => '\\$');
  // Replace \[...\] with $$...$$ (block display math, supports multiline)
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_match, content: string) => `$$${content}$$`);
  // Replace \(...\) with $...$ (inline math)
  text = text.replace(/\\\(([\s\S]*?)\\\)/g, (_match, content: string) => `$${content}$`);
  return text;
}
