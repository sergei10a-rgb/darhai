/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reading a text selection that crosses a Shadow DOM boundary.
 *
 * Why this file exists - measured, not assumed. On Electron 41.6.0 /
 * Chromium 146.0.7680.216, real mouse drags across markdown prose rendered in
 * a shadow root produce this split:
 *
 *   gesture              document.getSelection().toString()   clipboard (Ctrl+C)
 *   light -> shadow      "AAAA-LIGHT-ONE\n\n"                 full text, correct
 *   shadow -> light      "BBBB-SHADOW-ONE"                    full text, correct
 *   shadow -> shadow     "BBBB-SHADOW-ONE"                    full text, correct
 *   inside one shadow    "SHADOW-PROSE" (isCollapsed: true)   full text, correct
 *
 * Chromium's own copy is shadow-aware, so Ctrl+C and Electron's `role: 'copy'`
 * need no help. What silently truncates is every code path that reads the
 * selection from JavaScript: composed text living inside shadow roots is
 * dropped, so a caller that only sees `toString()` believes the user selected
 * less than they did - or, when the selection sits wholly inside one shadow
 * root, that it is collapsed while text is plainly highlighted.
 *
 * `collectComposedText` walks the flattened (composed) tree between two
 * boundary points and descends through shadow roots, so callers get the text
 * the user actually highlighted.
 *
 * Slots are deliberately not resolved: the markdown renderer portals its
 * children straight into the shadow root and uses no `<slot>`, so unslotted
 * light children render nothing and are correctly skipped here.
 */

/** Tags that Chromium separates with a blank line when serialising a selection. */
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'TABLE',
  'TD',
  'TH',
  'TR',
  'UL',
]);

const DOCUMENT_FRAGMENT_NODE = 11;

export type ComposedBoundary = {
  container: Node;
  offset: number;
};

type Chunk = {
  text: string;
  block: Node;
};

type ScannedNode = {
  node: Node;
  path: number[];
  /** '\n' for <br>, otherwise the text node's data. */
  text: string;
  isText: boolean;
};

const asShadowRoot = (node: Node | null): ShadowRoot | null =>
  node && node.nodeType === DOCUMENT_FRAGMENT_NODE && 'host' in node ? (node as ShadowRoot) : null;

/**
 * Children in flattened-tree order: a host's shadow content replaces its light
 * children, which is what the user sees and therefore what they selected.
 */
const composedChildren = (node: Node): Node[] => {
  const shadowRoot = (node as Element).shadowRoot;
  if (shadowRoot) return Array.from(shadowRoot.childNodes);
  return Array.from(node.childNodes);
};

/** Inverse of `composedChildren`: step out of a shadow root onto its host. */
const composedParent = (node: Node): Node | null => {
  const parent = node.parentNode;
  if (!parent) return null;
  const shadowRoot = asShadowRoot(parent);
  return shadowRoot ? shadowRoot.host : parent;
};

/**
 * Index path from `root` down to `node` in flattened-tree order. Two paths
 * compared lexicographically give document order even across shadow
 * boundaries - an ordering a single Range cannot express, because its
 * boundary points must share one node tree.
 */
const composedIndexPath = (node: Node, root: Node): number[] => {
  const path: number[] = [];
  let current: Node | null = node;

  while (current && current !== root) {
    const parent = composedParent(current);
    if (!parent) break;
    const index = composedChildren(parent).indexOf(current);
    if (index < 0) break;
    path.unshift(index);
    current = parent;
  }

  return path;
};

const comparePaths = (a: number[], b: number[]): number => {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
};

/** Nearest block-level ancestor, used to decide where blank lines belong. */
const nearestBlock = (node: Node, root: Node): Node => {
  let current: Node | null = composedParent(node);
  while (current && current !== root) {
    if (current.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((current as Element).tagName)) {
      return current;
    }
    current = composedParent(current);
  }
  return root;
};

const isBlockElement = (node: Node | null | undefined): boolean =>
  !!node && node.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((node as Element).tagName);

const hasWhitespacePreservingAncestor = (node: Node, root: Node): boolean => {
  let current: Node | null = composedParent(node);
  while (current && current !== root) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const tag = (current as Element).tagName;
      if (tag === 'PRE' || tag === 'CODE' || tag === 'TEXTAREA') return true;
    }
    current = composedParent(current);
  }
  return false;
};

/**
 * What CSS does with a whitespace-only text node: between two block boxes it
 * disappears, between inline boxes it collapses to one space. Source
 * indentation between markdown blocks is the common case, and Chromium's own
 * clipboard output for the measured fixture contains none of it.
 */
const isMeaningfulSibling = (candidate: Node | undefined): boolean =>
  !!candidate && !(candidate.nodeType === Node.TEXT_NODE && !/\S/.test(candidate.nodeValue ?? ''));

const collapseFormattingWhitespace = (node: Node, root: Node): string | null => {
  if (hasWhitespacePreservingAncestor(node, root)) return node.nodeValue ?? '';

  const parent = composedParent(node);
  if (!parent) return null;

  const siblings = composedChildren(parent);
  const index = siblings.indexOf(node);

  let previous: Node | undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (isMeaningfulSibling(siblings[i])) {
      previous = siblings[i];
      break;
    }
  }
  let next: Node | undefined;
  for (let i = index + 1; i < siblings.length; i += 1) {
    if (isMeaningfulSibling(siblings[i])) {
      next = siblings[i];
      break;
    }
  }

  if (!previous || !next) return null;
  if (isBlockElement(previous) || isBlockElement(next)) return null;
  return ' ';
};

/** Every text node and <br> under `root`, in flattened-tree order. */
const scanComposedText = (root: Node): ScannedNode[] => {
  const found: ScannedNode[] = [];

  const visit = (node: Node, path: number[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue ?? '';
      if (!/\S/.test(raw)) {
        const collapsed = collapseFormattingWhitespace(node, root);
        if (collapsed) found.push({ node, path, text: collapsed, isText: false });
        return;
      }
      found.push({ node, path, text: raw, isText: true });
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'BR') {
      found.push({ node, path, text: '\n', isText: false });
      return;
    }
    const children = composedChildren(node);
    for (let i = 0; i < children.length; i += 1) {
      visit(children[i], [...path, i]);
    }
  };

  visit(root, []);
  return found;
};

/**
 * A boundary as a comparable position. Text boundaries keep their character
 * offset; element boundaries become the path of the child they point at, so
 * both kinds sort against a scanned node's path with the same comparison.
 */
const boundaryKey = (boundary: ComposedBoundary, root: Node): { path: number[]; charOffset: number } => {
  const path = composedIndexPath(boundary.container, root);
  if (boundary.container.nodeType === Node.TEXT_NODE) {
    return { path, charOffset: boundary.offset };
  }
  return { path: [...path, boundary.offset], charOffset: 0 };
};

/**
 * Text between two boundary points, following the composed tree so shadow-root
 * content is included instead of dropped.
 */
export const collectComposedText = (root: Node, start: ComposedBoundary, end: ComposedBoundary): string => {
  const startKey = boundaryKey(start, root);
  const endKey = boundaryKey(end, root);

  // Callers hand over anchor/focus in whatever order the user dragged.
  const pathOrder = comparePaths(startKey.path, endKey.path);
  const forward = pathOrder < 0 || (pathOrder === 0 && startKey.charOffset <= endKey.charOffset);
  const from = forward ? startKey : endKey;
  const to = forward ? endKey : startKey;

  const chunks: Chunk[] = [];

  for (const scanned of scanComposedText(root)) {
    const vsStart = comparePaths(scanned.path, from.path);
    const vsEnd = comparePaths(scanned.path, to.path);
    if (vsStart < 0 || vsEnd > 0) continue;

    const sliceStart = vsStart === 0 && scanned.isText ? from.charOffset : 0;
    const sliceEnd = vsEnd === 0 && scanned.isText ? to.charOffset : scanned.text.length;
    const text = scanned.text.slice(sliceStart, sliceEnd);
    if (!text) continue;

    chunks.push({ text, block: nearestBlock(scanned.node, root) });
  }

  let result = '';
  let previousBlock: Node | null = null;
  for (const chunk of chunks) {
    if (previousBlock && previousBlock !== chunk.block) result += '\n\n';
    result += chunk.text;
    previousBlock = chunk.block;
  }

  return result;
};

/**
 * Shadow roots that opted in. `Selection.getComposedRanges` only reveals
 * boundary points inside a shadow root that the caller passes in - otherwise
 * they stay retargeted to the host, which is exactly the truncation this
 * module exists to undo.
 */
const registeredShadowRoots = new Set<ShadowRoot>();

export const registerShadowRoot = (root: ShadowRoot): (() => void) => {
  registeredShadowRoots.add(root);
  return () => {
    registeredShadowRoots.delete(root);
  };
};

export const getRegisteredShadowRoots = (): ShadowRoot[] => Array.from(registeredShadowRoots);

type ComposedRangeCapableSelection = Selection & {
  getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
};

const composedBoundaries = (selection: Selection): { start: ComposedBoundary; end: ComposedBoundary } | null => {
  const capable = selection as ComposedRangeCapableSelection;

  if (typeof capable.getComposedRanges === 'function') {
    try {
      const [range] = capable.getComposedRanges({ shadowRoots: getRegisteredShadowRoots() });
      if (range) {
        return {
          start: { container: range.startContainer, offset: range.startOffset },
          end: { container: range.endContainer, offset: range.endOffset },
        };
      }
    } catch {
      // Engines without the options form fall through to the Range below.
    }
  }

  if (selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return {
    start: { container: range.startContainer, offset: range.startOffset },
    end: { container: range.endContainer, offset: range.endOffset },
  };
};

/**
 * The text the user actually highlighted, shadow roots included.
 *
 * Never returns less than the engine's own `toString()`: the composed walk is
 * an addition to the native result, not a replacement for it.
 */
export const readSelectionText = (
  selection: Selection | null = typeof document === 'undefined' ? null : document.getSelection()
): string => {
  if (!selection) return '';

  const native = selection.toString();
  const boundaries = composedBoundaries(selection);
  if (!boundaries) return native;

  const composed = collectComposedText(document, boundaries.start, boundaries.end);
  return composed.length > native.length ? composed : native;
};
