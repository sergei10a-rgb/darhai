/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron';
import { Menu, clipboard } from 'electron';
import i18n from '@process/services/i18n';

/**
 * Right-click menu for a window's own renderer.
 *
 * Labels come from the main-process i18n instance (`@process/services/i18n`),
 * the same source `setupApplicationMenu` and `refreshTrayMenu` read - the main
 * process keeps its own i18next instance because the renderer's is not reachable
 * from here. The menu is rebuilt on every right click, so a language change is
 * picked up on the next click with no re-registration.
 *
 * Standard actions are declared as Electron roles rather than hand-written
 * clipboard calls: a role carries the platform accelerator, the native label
 * fallback, and dispatches to the focused webContents - which a manual
 * `clipboard.writeText` cannot do for `cut` or `paste` at all.
 */

/**
 * Build the menu for one right click, or an empty template when nothing under
 * the cursor is actionable.
 *
 * Returning empty (rather than a menu of greyed-out items) is deliberate: a
 * right click on blank chat background should feel like it did nothing, not pop
 * up a menu whose every entry is dead.
 */
function buildTemplate(params: ContextMenuParams, webContents: WebContents): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const hasSelection = Boolean(params.selectionText && params.selectionText.trim().length > 0);

  if (params.isEditable) {
    // Cut/copy stay visible but disabled with no selection, so the menu's shape
    // does not jump between clicks inside the same input.
    template.push(
      { role: 'cut', label: i18n.t('common.contextMenu.cut'), enabled: hasSelection },
      { role: 'copy', label: i18n.t('common.contextMenu.copy'), enabled: hasSelection },
      { role: 'paste', label: i18n.t('common.contextMenu.paste') },
      { role: 'pasteAndMatchStyle', label: i18n.t('common.contextMenu.pasteAsPlainText') },
      { type: 'separator' },
      { role: 'selectAll', label: i18n.t('common.contextMenu.selectAll') }
    );
  } else if (hasSelection) {
    // Read-only text: paste would be a no-op here, so it is omitted rather than
    // shown disabled - there is no state in which it could become available.
    template.push(
      { role: 'copy', label: i18n.t('common.contextMenu.copy') },
      { type: 'separator' },
      { role: 'selectAll', label: i18n.t('common.contextMenu.selectAll') }
    );
  }

  if (params.linkURL) {
    if (template.length > 0) template.push({ type: 'separator' });
    // No `copyLinkAddress` role exists in Electron (see the role union in
    // electron.d.ts), so this one item has to write the clipboard itself. The
    // URL comes from the hit-test params, not from page-controlled text.
    template.push({
      label: i18n.t('common.contextMenu.copyLinkAddress'),
      click: () => clipboard.writeText(params.linkURL),
    });
  }

  if (params.mediaType === 'image') {
    if (template.length > 0) template.push({ type: 'separator' });
    // copyImageAt re-runs the hit test at those coordinates and copies the
    // decoded bitmap; copying the src URL instead would paste a link, not a picture.
    template.push({
      label: i18n.t('common.contextMenu.copyImage'),
      click: () => webContents.copyImageAt(params.x, params.y),
    });
  }

  return template;
}

/**
 * Register the right-click menu on a window. Safe to call once per window; the
 * listener lives as long as the window's webContents.
 *
 * Note: `<webview>` guests have their own webContents and do not bubble
 * `context-menu` here, so preview panes keep whatever menu they define.
 */
export function attachContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const template = buildTemplate(params, win.webContents);
    if (template.length === 0) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}
