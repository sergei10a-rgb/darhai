/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal self-contained HTML shown in the user's browser at the end of the
 * OAuth callback (the loopback server has no other assets to serve). Kept tiny
 * and dependency-free; the text is bilingual to match Дархай's audience.
 */

function page(accent: string, heading: string, detail: string): string {
  return `<!doctype html><html lang="mn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${heading}</title></head><body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e8ec;display:grid;place-items:center;min-height:100vh"><main style="text-align:center;padding:2rem;max-width:28rem"><div style="width:3rem;height:3rem;margin:0 auto 1rem;border-radius:9999px;background:${accent}"></div><h1 style="font-size:1.25rem;margin:0 0 .5rem">${heading}</h1><p style="margin:0;color:#9aa0aa;line-height:1.5">${detail}</p></main></body></html>`;
}

/** Success page - the flow completed and the window can be closed. */
export function oauthSuccessHtml(detail: string): string {
  return page('#22c55e', 'Амжилттай нэвтэрлээ', detail);
}

/** Error page - shown when the callback carried an error or bad parameters. */
export function oauthErrorHtml(detail: string, extra?: string): string {
  return page('#ef4444', 'Нэвтрэлт бүтсэнгүй', extra ? `${detail} ${extra}` : detail);
}
