import { beforeEach, describe, expect, it } from 'vitest';
import {
  collectComposedText,
  getRegisteredShadowRoots,
  readSelectionText,
  registerShadowRoot,
} from '@renderer/utils/shadowSelection';

/**
 * The expected strings in this file are not invented: they are what Chromium
 * 146.0.7680.216 (Electron 41.6.0) actually put on the clipboard for the same
 * DOM and the same drag gestures, measured with real `sendInputEvent` mouse
 * drags plus `webContents.copy()` (CRLF normalised to LF here).
 *
 * The same measurement showed `document.getSelection().toString()` returning
 * only "AAAA-LIGHT-ONE\n\n" for the light->shadow drag - that truncation is
 * the defect these tests pin down.
 */
const attachShadowParagraph = (hostId: string, text: string) => {
  const host = document.getElementById(hostId) as HTMLElement;
  const shadow = host.attachShadow({ mode: 'open' });
  const p = document.createElement('p');
  p.textContent = text;
  shadow.appendChild(p);
  return { shadow, text: p.firstChild as Text };
};

const textOf = (id: string) => document.getElementById(id)!.firstChild as Text;

const buildFixture = () => {
  document.body.innerHTML = `
    <div id="wrap">
      <p id="a">AAAA-LIGHT-ONE</p>
      <div id="h1"></div>
      <p id="c">CCCC-LIGHT-TWO</p>
      <div id="h2"></div>
      <p id="e">EEEE-LIGHT-THREE</p>
    </div>`;

  const one = attachShadowParagraph('h1', 'BBBB-SHADOW-ONE');
  const two = attachShadowParagraph('h2', 'DDDD-SHADOW-TWO');

  return {
    root: document.body,
    a: textOf('a'),
    c: textOf('c'),
    e: textOf('e'),
    shadowOne: one.shadow,
    shadowOneText: one.text,
    shadowTwo: two.shadow,
    shadowTwoText: two.text,
  };
};

describe('collectComposedText', () => {
  let fx: ReturnType<typeof buildFixture>;

  beforeEach(() => {
    fx = buildFixture();
  });

  it('keeps shadow-root prose when the selection stays inside one shadow root', () => {
    const text = collectComposedText(
      fx.root,
      { container: fx.shadowOneText, offset: 0 },
      { container: fx.shadowOneText, offset: fx.shadowOneText.length }
    );

    expect(text).toBe('BBBB-SHADOW-ONE');
  });

  it('keeps shadow-root prose when the selection runs from light DOM into a shadow root', () => {
    const text = collectComposedText(
      fx.root,
      { container: fx.a, offset: 0 },
      { container: fx.shadowOneText, offset: fx.shadowOneText.length }
    );

    expect(text).toBe('AAAA-LIGHT-ONE\n\nBBBB-SHADOW-ONE');
  });

  it('keeps shadow-root prose when the selection runs from a shadow root back into light DOM', () => {
    const text = collectComposedText(
      fx.root,
      { container: fx.shadowOneText, offset: 0 },
      { container: fx.c, offset: fx.c.length }
    );

    expect(text).toBe('BBBB-SHADOW-ONE\n\nCCCC-LIGHT-TWO');
  });

  it('keeps every shadow root when the selection spans two of them', () => {
    const text = collectComposedText(
      fx.root,
      { container: fx.shadowOneText, offset: 0 },
      { container: fx.shadowTwoText, offset: fx.shadowTwoText.length }
    );

    expect(text).toBe('BBBB-SHADOW-ONE\n\nCCCC-LIGHT-TWO\n\nDDDD-SHADOW-TWO');
  });

  it('reproduces the full five-block clipboard string Chromium produced', () => {
    const text = collectComposedText(fx.root, { container: fx.a, offset: 0 }, { container: fx.e, offset: fx.e.length });

    expect(text).toBe('AAAA-LIGHT-ONE\n\nBBBB-SHADOW-ONE\n\nCCCC-LIGHT-TWO\n\nDDDD-SHADOW-TWO\n\nEEEE-LIGHT-THREE');
  });

  it('honours partial offsets at both ends', () => {
    const text = collectComposedText(
      fx.root,
      { container: fx.a, offset: 5 },
      { container: fx.shadowOneText, offset: 4 }
    );

    expect(text).toBe('LIGHT-ONE\n\nBBBB');
  });

  it('leaves a light-DOM-only selection exactly as it was', () => {
    const text = collectComposedText(fx.root, { container: fx.c, offset: 0 }, { container: fx.c, offset: fx.c.length });

    expect(text).toBe('CCCC-LIGHT-TWO');
  });

  it('returns an empty string for a collapsed boundary pair', () => {
    const text = collectComposedText(
      fx.root,
      { container: fx.shadowOneText, offset: 3 },
      { container: fx.shadowOneText, offset: 3 }
    );

    expect(text).toBe('');
  });

  it('renders a <br> as a single newline inside one block', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const p = document.createElement('p');
    p.innerHTML = 'ONE<br>TWO';
    shadow.appendChild(p);

    const first = p.firstChild as Text;
    const last = p.lastChild as Text;
    const text = collectComposedText(
      document.body,
      { container: first, offset: 0 },
      { container: last, offset: last.length }
    );

    expect(text).toBe('ONE\nTWO');
  });
});

describe('registerShadowRoot', () => {
  beforeEach(() => {
    for (const root of getRegisteredShadowRoots()) {
      // Registry is module state; drop anything an earlier test left behind.
      registerShadowRoot(root)();
    }
    document.body.innerHTML = '';
  });

  it('exposes a registered root and forgets it once the returned disposer runs', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    const dispose = registerShadowRoot(shadow);
    expect(getRegisteredShadowRoots()).toContain(shadow);

    dispose();
    expect(getRegisteredShadowRoots()).not.toContain(shadow);
  });

  it('does not keep a duplicate entry when the same root registers twice', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    registerShadowRoot(shadow);
    const dispose = registerShadowRoot(shadow);

    expect(getRegisteredShadowRoots().filter((r) => r === shadow)).toHaveLength(1);
    dispose();
  });
});

describe('readSelectionText', () => {
  it('returns an empty string when there is no selection', () => {
    expect(readSelectionText(null)).toBe('');
  });

  it('falls back to the native selection text when no range is exposed', () => {
    const fake = {
      rangeCount: 0,
      isCollapsed: false,
      toString: () => 'NATIVE-TEXT',
    } as unknown as Selection;

    expect(readSelectionText(fake)).toBe('NATIVE-TEXT');
  });
});
