/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serializable DOM probe for text that is *visibly* broken by long copy.
 *
 * Mongolian Cyrillic runs ~30-50% longer than the English it was translated
 * from, so labels that fit in the upstream layout can silently outgrow their
 * box. A screenshot baseline cannot tell "this label got longer" from "this
 * label is now unreadable", so this probe measures the live DOM instead.
 *
 * ## Reported (only when a *user* would see something wrong)
 *  - `hard-clip` - cut off by `overflow: hidden|clip` with no affordance to
 *    recover the rest: no ellipsis, no marquee, no scrollbar. Always a bug.
 *  - `severe-ellipsis` - an ellipsis is engaged (a designed degradation) but is
 *    hiding more than half the label. "Загварын тохир…" is a truncation;
 *    "Заг…" is a broken layout wearing one. Only the latter, via
 *    `minVisibleRatio`.
 *  - `viewport-escape` - ink painted past the window edge with nothing clipping
 *    or scrolling it.
 *  - `sibling-collision` - in-flow children of a row flexbox overlap, or one
 *    child's ink runs into the next one's box.
 *  - `pane-scroll` - a vertically-scrolling pane has developed horizontal
 *    overflow. Text inside a scrollable ancestor is reachable and so is never
 *    reported as clipped; without this rule the check would go silent across
 *    most of the settings UI. The sideways scrollbar is itself the defect.
 *
 * ## Deliberately NOT reported
 * Each is counted in `skipped`, so the leniency shows up in the report rather
 * than hiding in this comment:
 *  - `MarqueePillLabel` (`src/renderer/components/agent/MarqueePillLabel.tsx`)
 *    clips on purpose and scrolls the rest on hover. Detected structurally by
 *    its hidden absolutely-positioned `aria-hidden` measurement span, so it
 *    needs no app source change to opt out.
 *  - Ellipsis still showing most of the label - the design working as intended.
 *  - Anything inside an `overflow: auto|scroll` ancestor on the offending axis.
 *  - Form controls and `contenteditable`: unbounded user content, not a
 *    localization defect.
 *
 * Measurement uses a `Range` over each element's *own* text nodes rather than
 * `scrollWidth`, because inline elements size to their content (making
 * `scrollWidth === clientWidth` even while their text visibly escapes a
 * clipping ancestor further up).
 */

/** A viewport-space box. Mirrors the fields of DOMRect we actually use. */
type Box = { left: number; right: number; top: number; bottom: number };

export type OverflowKind = 'hard-clip' | 'severe-ellipsis' | 'viewport-escape' | 'sibling-collision' | 'pane-scroll';

export type OverflowFinding = {
  kind: OverflowKind;
  /** Short ancestor path, enough to locate the element in the source. */
  selector: string;
  /** Beginning of the offending text, for a readable failure message. */
  text: string;
  /** The measurement that justifies the finding. */
  detail: string;
};

export type OverflowReport = {
  root: string;
  rootFound: boolean;
  viewport: { width: number; height: number };
  /** Elements carrying their own visible text that were actually measured. */
  scanned: number;
  findings: OverflowFinding[];
  /** Reason -> count for every candidate that was deliberately not reported. */
  skipped: Record<string, number>;
};

export type OverflowOptions = {
  /** CSS selector for the surface to measure. */
  root: string;
  /** Overflow below this many px is antialiasing/rounding, not breakage. */
  horizontalTolerancePx: number;
  /** Vertical needs more slack: descenders and line-height routinely bleed. */
  verticalTolerancePx: number;
  /** An ellipsis showing less than this fraction of the label is a defect. */
  minVisibleRatio: number;
  /** Sibling overlap below this is layout rounding, not a collision. */
  collisionTolerancePx: number;
  /**
   * How far a vertical pane must overshoot before it counts as scrolling
   * sideways. Panes routinely carry a few px of imperceptible box-model slack,
   * whereas copy that outgrew its layout overshoots by tens to hundreds of px.
   */
  paneScrollTolerancePx: number;
  /**
   * Collision checks apply only to containers no taller than this. A button row
   * is short; the app shell is not. Without the cap, page-level columns get
   * compared against each other and a 1-3px box-model artifact reads as a
   * "collision" - noise that trains people to ignore the whole check.
   */
  maxRowHeightPx: number;
};

export const OVERFLOW_DEFAULTS: Omit<OverflowOptions, 'root'> = {
  horizontalTolerancePx: 2,
  verticalTolerancePx: 4,
  minVisibleRatio: 0.5,
  collisionTolerancePx: 4,
  paneScrollTolerancePx: 16,
  maxRowHeightPx: 200,
};

/**
 * Runs inside the page. Must stay entirely self-contained: Playwright ships
 * this function to the renderer as source text, so it cannot close over
 * anything from this module.
 */
export function probeOverflow(options: OverflowOptions): OverflowReport {
  const findings: OverflowFinding[] = [];
  const skipped: Record<string, number> = {};
  const note = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  const rootEl = document.querySelector(options.root);
  const report: OverflowReport = {
    root: options.root,
    rootFound: rootEl !== null,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scanned: 0,
    findings,
    skipped,
  };
  if (!rootEl) return report;

  const describe = (el: Element): string => {
    const parts: string[] = [];
    let node: Element | null = el;
    for (let depth = 0; node && depth < 4; depth++) {
      let piece = node.tagName.toLowerCase();
      if (node.id) piece += `#${node.id}`;
      const testId = node.getAttribute('data-testid');
      if (testId) piece += `[data-testid="${testId}"]`;
      const settingsId = node.getAttribute('data-settings-id');
      if (settingsId) piece += `[data-settings-id="${settingsId}"]`;
      const classes = (node.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (classes.length > 0) piece += `.${classes.join('.')}`;
      parts.unshift(piece);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const isRendered = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility !== 'visible') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    // `opacity` is not inherited into computed style, so the chain needs a walk.
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.getAttribute('aria-hidden') === 'true') return false;
      if (Number(getComputedStyle(node).opacity) === 0) return false;
    }
    return true;
  };

  const ownText = (el: Element): string => {
    let out = '';
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? '';
    }
    return out.replace(/\s+/g, ' ').trim();
  };

  /** True painted extent of the element's own text, ignoring any clipping. */
  const ownTextBox = (el: Element): Box | null => {
    const range = document.createRange();
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    let found = false;
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      if (!(node.textContent ?? '').trim()) continue;
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0.5 || rect.height <= 0.5) continue;
        found = true;
        left = Math.min(left, rect.left);
        right = Math.max(right, rect.right);
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
      }
    }
    return found ? { left, right, top, bottom } : null;
  };

  /** Padding box (the box `overflow` actually clips against), in viewport space. */
  const clientBox = (el: Element): Box => {
    const rect = el.getBoundingClientRect();
    if (el.clientWidth === 0 && el.clientHeight === 0) {
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }
    const left = rect.left + el.clientLeft;
    const top = rect.top + el.clientTop;
    return { left, top, right: left + el.clientWidth, bottom: top + el.clientHeight };
  };

  type Clipper = { el: Element; kind: 'clip' | 'scroll' } | null;

  /**
   * Nearest ancestor (or self) that constrains `axis`. Axes are resolved
   * independently because `overflow-x: hidden; overflow-y: auto` is the norm
   * for side rails - horizontally it really does cut text off, even though the
   * element is scrollable vertically.
   */
  const findClipper = (el: Element, axis: 'x' | 'y'): Clipper => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const value = axis === 'x' ? style.overflowX : style.overflowY;
      if (value === 'auto' || value === 'scroll') return { el: node, kind: 'scroll' };
      if (value === 'hidden' || value === 'clip') return { el: node, kind: 'clip' };
    }
    return null;
  };

  /** Structural signature of MarqueePillLabel's hidden measurement span. */
  const isMarquee = (el: Element): boolean => {
    for (const child of Array.from(el.children)) {
      if (child.getAttribute('aria-hidden') !== 'true') continue;
      const style = getComputedStyle(child);
      if (style.position === 'absolute' && style.visibility === 'hidden') return true;
    }
    return false;
  };

  const chainFind = (from: Element, to: Element, match: (el: Element) => boolean): Element | null => {
    for (let node: Element | null = from; node; node = node.parentElement) {
      if (match(node)) return node;
      if (node === to) break;
    }
    return null;
  };

  const classifyClip = (el: Element, clipper: Element, over: number, axis: 'x' | 'y', text: string): void => {
    if (chainFind(el, clipper, isMarquee)) {
      note('marquee-intentional');
      return;
    }
    const ellipsisEl =
      axis === 'x' ? chainFind(el, clipper, (n) => getComputedStyle(n).textOverflow === 'ellipsis') : null;
    if (ellipsisEl) {
      const visible = ellipsisEl.clientWidth || 1;
      const full = Math.max(ellipsisEl.scrollWidth, visible);
      const ratio = visible / full;
      if (ratio >= options.minVisibleRatio) {
        note('ellipsis-affordance');
        return;
      }
      findings.push({
        kind: 'severe-ellipsis',
        selector: describe(el),
        text,
        detail:
          `ellipsis hides ${(100 - ratio * 100).toFixed(0)}% of the label ` +
          `(${visible}px visible of ${full}px) on ${describe(ellipsisEl)}`,
      });
      return;
    }
    findings.push({
      kind: 'hard-clip',
      selector: describe(el),
      text,
      detail:
        `text is cut off by ${over.toFixed(1)}px on the ${axis} axis by ` +
        `${describe(clipper)} (overflow:hidden, no ellipsis, no marquee, no scrollbar)`,
    });
  };

  const candidates: Element[] = [rootEl, ...Array.from(rootEl.querySelectorAll('*'))];

  for (const el of candidates) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option') {
      note('form-control');
      continue;
    }
    if (el instanceof HTMLElement && el.isContentEditable) {
      note('contenteditable');
      continue;
    }
    const text = ownText(el);
    if (!text) continue;
    if (!isRendered(el)) {
      note('not-rendered');
      continue;
    }
    const box = ownTextBox(el);
    if (!box) {
      note('no-text-box');
      continue;
    }
    report.scanned++;
    const snippet = text.length > 80 ? `${text.slice(0, 80)}...` : text;

    const clipX = findClipper(el, 'x');
    if (clipX && clipX.kind === 'clip') {
      const cb = clientBox(clipX.el);
      const over = Math.max(box.right - cb.right, cb.left - box.left);
      if (over > options.horizontalTolerancePx) classifyClip(el, clipX.el, over, 'x', snippet);
    } else if (clipX && clipX.kind === 'scroll') {
      note('scrollable-x');
    } else {
      const overRight = box.right - report.viewport.width;
      const overLeft = -box.left;
      const escape = Math.max(overRight, overLeft);
      const hostRect = el.getBoundingClientRect();
      const hostOffscreen = hostRect.left >= report.viewport.width || hostRect.right <= 0;
      if (escape > options.horizontalTolerancePx && !hostOffscreen) {
        findings.push({
          kind: 'viewport-escape',
          selector: describe(el),
          text: snippet,
          detail:
            `text is painted ${escape.toFixed(1)}px outside the ${report.viewport.width}px window ` +
            `with nothing clipping or scrolling it`,
        });
      } else if (hostOffscreen) {
        note('offscreen-host');
      }
    }

    const clipY = findClipper(el, 'y');
    if (clipY && clipY.kind === 'clip') {
      const cb = clientBox(clipY.el);
      const over = Math.max(box.bottom - cb.bottom, cb.top - box.top);
      if (over > options.verticalTolerancePx) classifyClip(el, clipY.el, over, 'y', snippet);
    }
  }

  // --- Pass 2: collisions between siblings on a row ---------------------------
  // In a row flexbox, in-flow children cannot overlap unless something forces
  // them to, so an overlap is real breakage rather than a design choice.
  // Absolutely positioned and negative-margin children are excluded: making
  // things overlap is exactly what those two are usually for.
  const MAX_ROW_CHILDREN = 40;
  for (const parent of candidates) {
    const style = getComputedStyle(parent);
    if (style.display !== 'flex' && style.display !== 'inline-flex') continue;
    if (!style.flexDirection.startsWith('row')) continue;
    if (parent.children.length < 2 || parent.children.length > MAX_ROW_CHILDREN) continue;
    if (parent.getBoundingClientRect().height > options.maxRowHeightPx) {
      note('row-too-tall-for-collision-check');
      continue;
    }

    const kids: { el: Element; box: Box }[] = [];
    for (const child of Array.from(parent.children)) {
      const childStyle = getComputedStyle(child);
      if (childStyle.position !== 'static' && childStyle.position !== 'relative') {
        note('positioned-row-child');
        continue;
      }
      if (childStyle.marginLeft.startsWith('-') || childStyle.marginRight.startsWith('-')) {
        note('negative-margin-row-child');
        continue;
      }
      if (!isRendered(child)) continue;
      const rect = child.getBoundingClientRect();
      // Ink escapes the child's own box only when the child does not clip it.
      const right =
        childStyle.overflowX === 'visible'
          ? Math.max(rect.right, rect.left + child.clientLeft + child.scrollWidth)
          : rect.right;
      kids.push({ el: child, box: { left: rect.left, right, top: rect.top, bottom: rect.bottom } });
    }

    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i];
        const b = kids[j];
        const shortest = Math.min(a.box.bottom - a.box.top, b.box.bottom - b.box.top);
        if (shortest <= 0) continue;
        const vertical = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        // Less than half-height of shared vertical span means a wrapped row,
        // not two things fighting for the same spot.
        if (vertical < shortest * 0.5) continue;
        const horizontal = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        if (horizontal <= options.collisionTolerancePx) continue;
        findings.push({
          kind: 'sibling-collision',
          selector: describe(a.el),
          text: (a.el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
          detail:
            `overlaps sibling ${describe(b.el)} ` +
            `("${(b.el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}") ` +
            `by ${horizontal.toFixed(1)}px inside row ${describe(parent)}`,
        });
      }
    }
  }

  // --- Pass 3: panes that started scrolling sideways -------------------------
  // Opt-in horizontal scrollers are excluded: an author who writes
  // `overflow-x: auto` while pinning the other axis (tab strips, wide tables,
  // code blocks) meant it. A pane where BOTH axes resolve to auto/scroll only
  // ever asked to scroll vertically - CSS forces `overflow-x` to `auto` when
  // `overflow-y` is - so sideways movement there is unintended.
  for (const pane of candidates) {
    const tag = pane.tagName.toLowerCase();
    if (tag === 'pre' || tag === 'code' || tag === 'table') continue;
    const style = getComputedStyle(pane);
    const scrollsX = style.overflowX === 'auto' || style.overflowX === 'scroll';
    const scrollsY = style.overflowY === 'auto' || style.overflowY === 'scroll';
    if (!scrollsX) continue;
    if (!scrollsY) {
      note('opt-in-horizontal-scroller');
      continue;
    }
    const excess = pane.scrollWidth - pane.clientWidth;
    if (excess <= options.paneScrollTolerancePx) continue;
    if (!isRendered(pane)) continue;

    // Name the widest child so the failure points at a cause, not just a pane.
    // Descendants inside their *own* clipping or scrolling box are skipped: a
    // nested horizontal scroller legitimately extends far past the outer pane
    // and would otherwise always win this contest.
    const paneBox = clientBox(pane);
    const reachesPaneDirectly = (el: Element): boolean => {
      for (let node = el.parentElement; node && node !== pane; node = node.parentElement) {
        const s = getComputedStyle(node);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') return false;
      }
      return true;
    };
    let culprit: Element | null = null;
    let culpritOver = 0;
    for (const child of Array.from(pane.querySelectorAll('*'))) {
      const rect = child.getBoundingClientRect();
      if (rect.width < 1) continue;
      const over = rect.right - paneBox.right;
      if (over > culpritOver && reachesPaneDirectly(child)) {
        culpritOver = over;
        culprit = child;
      }
    }
    findings.push({
      kind: 'pane-scroll',
      selector: describe(pane),
      text: culprit ? (culprit.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) : '',
      detail:
        `vertical pane scrolls sideways: content is ${excess}px wider than its ${pane.clientWidth}px box` +
        (culprit ? `; widest child ${describe(culprit)} sticks out ${culpritOver.toFixed(1)}px` : ''),
    });
  }

  return report;
}

/** Renders a report as the body of an assertion message. */
export function formatOverflowReport(report: OverflowReport): string {
  const lines: string[] = [
    `root="${report.root}" found=${report.rootFound} viewport=${report.viewport.width}x${report.viewport.height} ` +
      `scanned=${report.scanned} findings=${report.findings.length}`,
  ];
  for (const finding of report.findings) {
    lines.push(`  [${finding.kind}] "${finding.text}"`);
    lines.push(`      at ${finding.selector}`);
    lines.push(`      ${finding.detail}`);
  }
  const skips = Object.entries(report.skipped);
  if (skips.length > 0) {
    lines.push(`  not reported: ${skips.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  return lines.join('\n');
}
