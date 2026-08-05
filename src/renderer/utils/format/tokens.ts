// src/renderer/utils/format/tokens.ts
//
// Shared token + USD formatters for surfaces that show LLM usage rollups
// (W2d sidebar cost meter, future per-team / per-day reports). Kept
// dependency-free so they can be imported anywhere in the renderer.
//
// Format conventions chosen to read at sidebar density:
//   - tokens collapse to K/M/B with 1 decimal once over 1_000
//   - USD shows 2 decimals up to $100, then rounds to whole dollars (so a
//     "tokens · $12,345" rollup stays narrow in the sider)

/**
 * Render a token count in compact form (e.g. `1234 → "1.2K"`,
 * `1_500_000 → "1.5M"`). Numbers below 1_000 render as-is.
 *
 * Negative + non-finite inputs render as "0". `Math.floor` is used on the
 * single-decimal so we never round up across a magnitude boundary
 * (`999500` would otherwise become `"1.0M"`).
 */
export const formatTokenCount = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1_000) return Math.round(n).toString();
  if (n < 1_000_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}K`;
  if (n < 1_000_000_000) return `${(Math.floor(n / 100_000) / 10).toFixed(1)}M`;
  return `${(Math.floor(n / 100_000_000) / 10).toFixed(1)}B`;
};

/**
 * Render a USD value. Sub-$100 keeps 2 decimals (penny precision matters
 * for low-spend teams); $100+ rounds to whole dollars with thousands
 * separators so wider rollups stay readable.
 *
 * Negative + non-finite inputs render as "$0.00".
 */
export const formatUsd = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '$0.00';
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
};

/**
 * Render a tögrög value.
 *
 * Always whole tögrög with thousands separators - there is no sub-tögrög
 * denomination in circulation, and a decimal here would only add noise to a
 * number that is already four to seven digits long.
 *
 * A tiny non-zero spend renders as `<1₮` rather than `0₮`: rounding real money
 * down to zero makes a cost report look like nothing was spent.
 */
export const formatMnt = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0₮';
  if (n < 1) return '<1₮';
  return `${Math.round(n).toLocaleString('en-US')}₮`;
};

/**
 * Render a spend as dollars, with tögrög alongside when a rate is known.
 *
 * Dollars stay first because that is the currency the providers actually bill
 * in - the tögrög figure is a conversion, and presenting it as the primary
 * number would imply a precision the exchange rate does not have. When no rate
 * is available the dollar figure stands alone rather than showing a guess.
 */
export const formatSpend = (usd: number, mnt: number | null): string => {
  const dollars = formatUsd(usd);
  if (mnt === null || !Number.isFinite(mnt)) return dollars;
  return `${dollars} · ${formatMnt(mnt)}`;
};
