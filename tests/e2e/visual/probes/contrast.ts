/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serializable DOM probe for WCAG 2.x contrast, computed from live styles.
 *
 * Nothing here is read from a design token file: the whole point is to measure
 * what the compositor will actually paint, after CSS variables, theme
 * overrides, Arco defaults and `rgba()` alpha have all had their say.
 *
 * ## Method
 *  1. Resolve the element's `color`, including its alpha.
 *  2. Walk ancestors for the nearest opaque `background-color`, compositing
 *     every translucent layer above it back down (`src-over`).
 *  3. Composite the text colour over that background and compare relative
 *     luminance per WCAG's `(L1 + 0.05) / (L2 + 0.05)`.
 *
 * ## Honesty rules
 * A node whose background genuinely cannot be resolved - it sits over a
 * gradient, an image, or a colour syntax this parser does not understand - is
 * **skipped and counted**, never silently passed. `skippedTotal` and the
 * `skipped` breakdown are part of the report so a run that resolved almost
 * nothing cannot masquerade as a clean bill of health.
 *
 * ## Known approximations (documented rather than hidden)
 *  - `opacity` on an ancestor fades that element *and its subtree* as a group.
 *    Layer alphas are multiplied by the accumulated opacity from the root down,
 *    which is exact when layers do not overlap each other and close enough when
 *    they do. If any ancestor *above* the resolved opaque background is
 *    translucent, the node is skipped instead of guessed at.
 *  - `text-shadow` and `-webkit-text-stroke` can raise or lower real-world
 *    legibility; neither is modelled.
 *  - Disabled controls are skipped: WCAG 1.4.3 exempts inactive components.
 */

type Rgb = { r: number; g: number; b: number };
type Rgba = Rgb & { a: number };

export type ContrastViolation = {
  selector: string;
  text: string;
  /** Computed `color`, verbatim. */
  foreground: string;
  /** Resolved opaque background as `rgb(r, g, b)`. */
  background: string;
  ratio: number;
  required: number;
  fontSizePx: number;
  fontWeight: number;
  isLargeText: boolean;
};

export type ContrastReport = {
  root: string;
  rootFound: boolean;
  /** Text-bearing elements whose contrast was successfully computed. */
  scanned: number;
  violations: ContrastViolation[];
  skipped: Record<string, number>;
  skippedTotal: number;
};

export type ContrastOptions = {
  root: string;
  /** WCAG AA for normal text. */
  normalRatio: number;
  /** WCAG AA for large text. */
  largeRatio: number;
  /** Font size at or above which text counts as large. */
  largePx: number;
  /** Font size at or above which *bold* text counts as large. */
  largeBoldPx: number;
  /** Ignore misses smaller than this, so 4.4999 vs 4.5 is not a finding. */
  epsilon: number;
};

/**
 * Thresholds as specified for this suite. Note this is slightly more permissive
 * than axe-core, which requires 24px (or 18.66px bold) for the large-text
 * exemption; anything this probe reports would also be reported by axe-core.
 */
export const CONTRAST_DEFAULTS: Omit<ContrastOptions, 'root'> = {
  normalRatio: 4.5,
  largeRatio: 3,
  largePx: 18.66,
  largeBoldPx: 14,
  epsilon: 0.005,
};

/**
 * Runs inside the page. Must stay entirely self-contained: Playwright ships
 * this function to the renderer as source text.
 */
export function probeContrast(options: ContrastOptions): ContrastReport {
  const violations: ContrastViolation[] = [];
  const skipped: Record<string, number> = {};
  let skippedTotal = 0;
  const note = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
    skippedTotal++;
  };

  const rootEl = document.querySelector(options.root);
  const report: ContrastReport = {
    root: options.root,
    rootFound: rootEl !== null,
    scanned: 0,
    violations,
    skipped,
    skippedTotal,
  };
  if (!rootEl) return report;

  const parseColor = (raw: string): Rgba | null => {
    const value = raw.trim().toLowerCase();
    if (!value) return null;
    if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

    if (value.startsWith('#')) {
      const hex = value.slice(1);
      const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16);
      if (hex.length === 3 || hex.length === 4) {
        return {
          r: expand(hex[0]),
          g: expand(hex[1]),
          b: expand(hex[2]),
          a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
        };
      }
      if (hex.length === 6 || hex.length === 8) {
        return {
          r: expand(hex.slice(0, 2)),
          g: expand(hex.slice(2, 4)),
          b: expand(hex.slice(4, 6)),
          a: hex.length === 8 ? expand(hex.slice(6, 8)) / 255 : 1,
        };
      }
      return null;
    }

    const scaled = (token: string, scale: number): number =>
      token.endsWith('%') ? (parseFloat(token) / 100) * scale : parseFloat(token);

    // Handles both legacy `rgb(1, 2, 3)` and modern `rgb(1 2 3 / 40%)`.
    const rgb = /^rgba?\(([^)]+)\)$/.exec(value);
    if (rgb) {
      const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const out = {
        r: scaled(parts[0], 255),
        g: scaled(parts[1], 255),
        b: scaled(parts[2], 255),
        a: parts.length > 3 ? scaled(parts[3], 1) : 1,
      };
      return Number.isNaN(out.r + out.g + out.b + out.a) ? null : out;
    }

    // Chromium serialises wide-gamut authored colours in this form.
    const srgb = /^color\(srgb\s+([^)]+)\)$/.exec(value);
    if (srgb) {
      const parts = srgb[1].split(/[\s,/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const out = {
        r: scaled(parts[0], 1) * 255,
        g: scaled(parts[1], 1) * 255,
        b: scaled(parts[2], 1) * 255,
        a: parts.length > 3 ? scaled(parts[3], 1) : 1,
      };
      return Number.isNaN(out.r + out.g + out.b + out.a) ? null : out;
    }

    return null;
  };

  const over = (top: Rgba, bottom: Rgb): Rgb => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
  });

  const luminance = (c: Rgb): number => {
    const channel = (raw: number): number => {
      const v = Math.min(Math.max(raw, 0), 255) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  };

  const ratioOf = (a: Rgb, b: Rgb): number => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const opacityOf = (el: Element): number => {
    const value = Number(getComputedStyle(el).opacity);
    return Number.isNaN(value) ? 1 : value;
  };

  type BackgroundResult = { ok: true; color: Rgb; opacityAtNode: number } | { ok: false; reason: string };

  const resolveBackground = (el: Element): BackgroundResult => {
    // Nearest ancestor that stops light getting through: an opaque colour
    // resolves it, a background-image means we honestly cannot.
    const chain: Element[] = [];
    let terminator: Element | null = null;
    for (let node: Element | null = el; node; node = node.parentElement) {
      chain.push(node);
      const style = getComputedStyle(node);
      if (style.backgroundImage !== 'none') return { ok: false, reason: 'over-background-image' };
      const color = parseColor(style.backgroundColor);
      if (!color) return { ok: false, reason: `unparseable-background:${style.backgroundColor}` };
      if (color.a >= 0.999 && opacityOf(node) >= 0.999) {
        terminator = node;
        break;
      }
    }
    if (!terminator) return { ok: false, reason: 'no-opaque-background' };

    // A translucent ancestor above the opaque layer would blend it with the
    // page beneath; rather than guess, skip.
    for (let node = terminator.parentElement; node; node = node.parentElement) {
      if (opacityOf(node) < 0.999) return { ok: false, reason: 'translucent-ancestor-above-background' };
    }

    // Composite outermost -> innermost, folding in group opacity as we descend.
    let accumulated = 1;
    let base: Rgb | null = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i];
      accumulated *= opacityOf(node);
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (!color) return { ok: false, reason: 'unparseable-background' };
      if (!base) {
        base = { r: color.r, g: color.g, b: color.b };
        continue;
      }
      if (color.a > 0) base = over({ ...color, a: color.a * accumulated }, base);
    }
    if (!base) return { ok: false, reason: 'no-opaque-background' };
    return { ok: true, color: base, opacityAtNode: accumulated };
  };

  const describe = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    for (let depth = 0; node && depth < 4; depth++) {
      let piece = node.tagName.toLowerCase();
      if (node.id) piece += `#${node.id}`;
      const testId = node.getAttribute('data-testid');
      if (testId) piece += `[data-testid="${testId}"]`;
      const classes = (node.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (classes.length > 0) piece += `.${classes.join('.')}`;
      parts.unshift(piece);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const ownText = (el: Element): string => {
    let out = '';
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? '';
    }
    return out.replace(/\s+/g, ' ').trim();
  };

  const isRendered = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility !== 'visible') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    // Deliberately NOT filtered on viewport bounds: contrast is a property of
    // the resolved styles, not of the current scroll offset. Excluding
    // below-the-fold text would silently drop most of a long settings page and
    // make coverage depend on where the pane happened to be scrolled.
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.getAttribute('aria-hidden') === 'true') return false;
      if (opacityOf(node) === 0) return false;
    }
    return true;
  };

  for (const el of [rootEl, ...Array.from(rootEl.querySelectorAll('*'))]) {
    const text = ownText(el);
    if (!text) continue;
    if (!isRendered(el)) {
      note('not-rendered');
      continue;
    }
    if (el.closest('[disabled],[aria-disabled="true"],.arco-btn-disabled,.arco-input-disabled')) {
      note('disabled-control');
      continue;
    }

    const style = getComputedStyle(el);
    const fg = parseColor(style.color);
    if (!fg) {
      note(`unparseable-color:${style.color}`);
      continue;
    }
    if (fg.a === 0) {
      note('transparent-text');
      continue;
    }
    const fontSizePx = parseFloat(style.fontSize);
    if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) {
      note('no-font-size');
      continue;
    }

    const background = resolveBackground(el);
    // Narrow via `in` rather than `!background.ok`: the repo compiles with
    // strictNullChecks off, where truthiness on a boolean discriminant does not
    // narrow the union, but a property-presence check still does.
    if ('reason' in background) {
      note(background.reason);
      continue;
    }

    report.scanned++;
    const composited = over({ ...fg, a: fg.a * background.opacityAtNode }, background.color);
    const ratio = ratioOf(composited, background.color);
    const fontWeight = Number(style.fontWeight) || 400;
    const isLargeText = fontSizePx >= options.largePx || (fontSizePx >= options.largeBoldPx && fontWeight >= 700);
    const required = isLargeText ? options.largeRatio : options.normalRatio;

    if (ratio + options.epsilon < required) {
      const bg = background.color;
      violations.push({
        selector: describe(el),
        text: text.length > 60 ? `${text.slice(0, 60)}...` : text,
        foreground: style.color,
        background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        ratio: Math.round(ratio * 100) / 100,
        required,
        fontSizePx: Math.round(fontSizePx * 100) / 100,
        fontWeight,
        isLargeText,
      });
    }
  }

  report.skippedTotal = skippedTotal;
  return report;
}

/** Renders a report as the body of an assertion message. */
export function formatContrastReport(report: ContrastReport): string {
  const lines: string[] = [
    `root="${report.root}" found=${report.rootFound} resolved=${report.scanned} ` +
      `violations=${report.violations.length} skipped=${report.skippedTotal}`,
  ];
  for (const v of report.violations) {
    lines.push(
      `  ${v.ratio}:1 (needs ${v.required}:1) "${v.text}"` +
        `\n      at ${v.selector}` +
        `\n      fg=${v.foreground} bg=${v.background} font=${v.fontSizePx}px/${v.fontWeight}` +
        `${v.isLargeText ? ' [large]' : ''}`
    );
  }
  const skips = Object.entries(report.skipped).sort((a, b) => b[1] - a[1]);
  if (skips.length > 0) {
    lines.push(`  not evaluated: ${skips.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  return lines.join('\n');
}
