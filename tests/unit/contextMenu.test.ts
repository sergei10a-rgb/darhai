/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The app shipped with no right-click menu at all: no `context-menu` listener
 * was registered anywhere, so mouse-driven copy/paste was impossible and the
 * only way to move text was the keyboard.
 *
 * These tests pin the CONTEXT SENSITIVITY of the menu, which is the part that
 * silently rots - a menu that always shows every item is as wrong as no menu:
 * "Paste" over read-only prose does nothing, and an empty menu popping up on a
 * blank area is noise. Each case below asserts both what must be present and
 * what must be absent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

const hoisted = vi.hoisted(() => {
  const mockPopup = vi.fn();
  const mockMenuInstance = { popup: mockPopup };
  // Typed by the signature it stands in for: `vi.fn(() => x)` would infer a
  // zero-parameter call, making `mock.calls` a `[]` tuple that cannot be indexed.
  const mockBuildFromTemplate = vi.fn((_template: unknown[]) => mockMenuInstance);
  const mockWriteText = vi.fn();
  return { mockPopup, mockMenuInstance, mockBuildFromTemplate, mockWriteText };
});

const { mockPopup, mockBuildFromTemplate, mockWriteText } = hoisted;

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: mockBuildFromTemplate },
  clipboard: { writeText: mockWriteText },
}));

// Labels are asserted by key, so the menu's i18n wiring is verified without
// pinning any one language's wording.
vi.mock('@process/services/i18n', () => ({
  default: { t: vi.fn((key: string) => key) },
}));

type ContextMenuHandler = (event: unknown, params: Record<string, unknown>) => void;

interface FakeWindow {
  webContents: {
    on: ReturnType<typeof vi.fn>;
    copyImageAt: ReturnType<typeof vi.fn>;
  };
  handlers: Record<string, ContextMenuHandler>;
}

function createFakeWindow(): FakeWindow {
  const handlers: Record<string, ContextMenuHandler> = {};
  return {
    webContents: {
      on: vi.fn((event: string, handler: ContextMenuHandler) => {
        handlers[event] = handler;
      }),
      copyImageAt: vi.fn(),
    },
    handlers,
  };
}

/** Electron's ContextMenuParams, with the neutral "clicked empty space" defaults. */
function makeParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x: 10,
    y: 20,
    isEditable: false,
    selectionText: '',
    linkURL: '',
    mediaType: 'none',
    ...overrides,
  };
}

async function openMenu(params: Record<string, unknown>): Promise<FakeWindow> {
  const { attachContextMenu } = await import('@process/utils/contextMenu');
  const win = createFakeWindow();
  attachContextMenu(win as unknown as Electron.BrowserWindow);
  const handler = win.handlers['context-menu'];
  expect(handler, 'attachContextMenu must register a context-menu listener').toBeTypeOf('function');
  handler({}, params);
  return win;
}

function lastTemplate(): MenuItemConstructorOptions[] {
  expect(mockBuildFromTemplate).toHaveBeenCalled();
  // `mock.calls` is typed as a tuple of the mocked signature's params, which is
  // empty here - index it through `at()` and assert rather than casting blind,
  // so a template that was never built fails with a readable message.
  const call = mockBuildFromTemplate.mock.calls.at(-1);
  if (!call) throw new Error('Menu.buildFromTemplate was never called');
  return call[0] as MenuItemConstructorOptions[];
}

function rolesIn(template: MenuItemConstructorOptions[]): string[] {
  return template.filter((item) => item.role).map((item) => item.role as string);
}

function itemByRole(template: MenuItemConstructorOptions[], role: string): MenuItemConstructorOptions | undefined {
  return template.find((item) => item.role === role);
}

describe('attachContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers exactly one context-menu listener on the window webContents', async () => {
    const { attachContextMenu } = await import('@process/utils/contextMenu');
    const win = createFakeWindow();

    attachContextMenu(win as unknown as Electron.BrowserWindow);

    expect(win.webContents.on).toHaveBeenCalledTimes(1);
    expect(win.webContents.on.mock.calls[0][0]).toBe('context-menu');
  });

  describe('editable field with a selection', () => {
    it('offers cut, copy, paste, paste-as-plain-text and select-all, all enabled', async () => {
      const win = await openMenu(makeParams({ isEditable: true, selectionText: 'hello' }));

      const template = lastTemplate();
      expect(rolesIn(template)).toEqual(['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll']);
      expect(itemByRole(template, 'cut')?.enabled).toBe(true);
      expect(itemByRole(template, 'copy')?.enabled).toBe(true);
      expect(mockPopup).toHaveBeenCalledWith({ window: win });
    });

    it('labels every item from the i18n bundle rather than hardcoded text', async () => {
      await openMenu(makeParams({ isEditable: true, selectionText: 'hello' }));

      const labels = lastTemplate()
        .filter((item) => item.type !== 'separator')
        .map((item) => item.label);
      expect(labels).toEqual([
        'common.contextMenu.cut',
        'common.contextMenu.copy',
        'common.contextMenu.paste',
        'common.contextMenu.pasteAsPlainText',
        'common.contextMenu.selectAll',
      ]);
    });
  });

  describe('editable field with no selection', () => {
    it('still offers paste, but cut and copy are disabled', async () => {
      await openMenu(makeParams({ isEditable: true, selectionText: '' }));

      const template = lastTemplate();
      expect(rolesIn(template)).toContain('paste');
      expect(itemByRole(template, 'cut')?.enabled).toBe(false);
      expect(itemByRole(template, 'copy')?.enabled).toBe(false);
    });
  });

  describe('read-only prose with a selection', () => {
    it('offers copy and select-all but never paste', async () => {
      await openMenu(makeParams({ isEditable: false, selectionText: 'some quoted answer' }));

      const roles = rolesIn(lastTemplate());
      expect(roles).toContain('copy');
      expect(roles).toContain('selectAll');
      expect(roles).not.toContain('paste');
      expect(roles).not.toContain('pasteAndMatchStyle');
      expect(roles).not.toContain('cut');
    });

    it('leaves copy enabled', async () => {
      await openMenu(makeParams({ isEditable: false, selectionText: 'some quoted answer' }));

      expect(itemByRole(lastTemplate(), 'copy')?.enabled).not.toBe(false);
    });
  });

  describe('nothing actionable under the cursor', () => {
    it('does not build or pop up a menu at all', async () => {
      await openMenu(makeParams());

      expect(mockBuildFromTemplate).not.toHaveBeenCalled();
      expect(mockPopup).not.toHaveBeenCalled();
    });
  });

  describe('links', () => {
    it('offers copy-link-address on a plain (non-editable, unselected) link', async () => {
      await openMenu(makeParams({ linkURL: 'https://example.com/page' }));

      const labels = lastTemplate().map((item) => item.label);
      expect(labels).toContain('common.contextMenu.copyLinkAddress');
    });

    it('copies the link URL when the item is clicked', async () => {
      await openMenu(makeParams({ linkURL: 'https://example.com/page' }));

      const click = lastTemplate().find((entry) => entry.label === 'common.contextMenu.copyLinkAddress')?.click;
      expect(click).toBeTypeOf('function');
      (click as () => void)();

      expect(mockWriteText).toHaveBeenCalledWith('https://example.com/page');
    });
  });

  describe('images', () => {
    it('offers copy-image and copies at the click coordinates', async () => {
      const win = await openMenu(makeParams({ mediaType: 'image', x: 42, y: 84 }));

      const click = lastTemplate().find((entry) => entry.label === 'common.contextMenu.copyImage')?.click;
      expect(click).toBeTypeOf('function');
      (click as () => void)();

      expect(win.webContents.copyImageAt).toHaveBeenCalledWith(42, 84);
    });

    it('does not offer copy-image for non-image media', async () => {
      await openMenu(makeParams({ mediaType: 'video', selectionText: 'x' }));

      const labels = lastTemplate().map((item) => item.label);
      expect(labels).not.toContain('common.contextMenu.copyImage');
    });
  });
});
