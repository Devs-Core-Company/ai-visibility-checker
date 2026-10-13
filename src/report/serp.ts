/**
 * Search-result snippet preview: how wide a title and description render in
 * Google's desktop results (Arial 20px titles, 14px descriptions) and whether
 * they are likely to be cut off. Widths use Arial's advance widths, so they are
 * close estimates, not a guarantee: Google also rewrites titles.
 */

/** Advance widths of Arial in 1/1000 em for printable ASCII (32–126). */
const ARIAL: number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Pixel width limits Google's desktop layout uses before truncating (approximate). */
export const TITLE_LIMIT_PX = 580;
export const DESCRIPTION_LIMIT_PX = 920;
/** Below about this many characters a description gives AI little context. */
export const DESCRIPTION_AI_MIN_CHARS = 120;

/** Arial advance widths of common typographic punctuation outside ASCII. */
const PUNCT: Record<string, number> = {
  '\u2018': 222, // ‘
  '\u2019': 222, // ’
  '\u201C': 333, // “
  '\u201D': 333, // ”
  '\u2013': 556, // –
  '\u2014': 1000, // —
  '\u2026': 1000, // …
  '\u00B7': 278, // ·
  '\u2022': 350, // •
  '\u00A0': 278, // no-break space
  '\u00A3': 556, // £
  '\u20AC': 556, // €
};

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 32;
  if (code >= 32 && code <= 126) return ARIAL[code - 32]!;
  const punct = PUNCT[ch];
  if (punct !== undefined) return punct;
  if (/[À-ɏ]/.test(ch)) return 556; // accented Latin: about a lower-case letter
  if (/[　-鿿가-힯＀-￯]/.test(ch)) return 1000; // CJK, full width
  if (/\p{Extended_Pictographic}/u.test(ch)) return 1000;
  return 556;
}

/** Rendered width of `text` in Arial at `fontPx`. */
export function textWidthPx(text: string, fontPx: number): number {
  let units = 0;
  for (const ch of text) units += charWidth(ch);
  return Math.round((units / 1000) * fontPx);
}

/** Cut text to fit `limitPx`, adding an ellipsis like Google does. */
export function truncateToPx(text: string, fontPx: number, limitPx: number): string {
  if (textWidthPx(text, fontPx) <= limitPx) return text;
  const ell = textWidthPx(' …', fontPx);
  let out = '';
  for (const ch of text) {
    if (textWidthPx(out + ch, fontPx) + ell > limitPx) break;
    out += ch;
  }
  return `${out.replace(/\s+\S*$/, '')} …`;
}

export interface SerpRow {
  url: string;
  title: string;
  description: string;
  titlePx: number;
  titleChars: number;
  titleTruncated: boolean;
  descriptionPx: number;
  descriptionChars: number;
  descriptionTruncated: boolean;
  /** Description too short to give an AI assistant context. */
  descriptionThinForAi: boolean;
  /** What the result would show. */
  shownTitle: string;
  shownDescription: string;
}

export function serpRow(url: string, title: string | null, description: string | null): SerpRow {
  const t = (title ?? '').replace(/\s+/g, ' ').trim();
  const d = (description ?? '').replace(/\s+/g, ' ').trim();
  const titlePx = textWidthPx(t, 20);
  const descriptionPx = textWidthPx(d, 14);
  return {
    url,
    title: t,
    description: d,
    titlePx,
    titleChars: t.length,
    titleTruncated: titlePx > TITLE_LIMIT_PX,
    descriptionPx,
    descriptionChars: d.length,
    descriptionTruncated: descriptionPx > DESCRIPTION_LIMIT_PX,
    descriptionThinForAi: d.length < DESCRIPTION_AI_MIN_CHARS,
    shownTitle: truncateToPx(t, 20, TITLE_LIMIT_PX),
    shownDescription: truncateToPx(d, 14, DESCRIPTION_LIMIT_PX),
  };
}

export function serpSummary(rows: SerpRow[]) {
  return {
    pages: rows.length,
    titleTruncated: rows.filter((r) => r.titleTruncated).length,
    descriptionTruncated: rows.filter((r) => r.descriptionTruncated).length,
    descriptionThinForAi: rows.filter((r) => r.descriptionThinForAi).length,
    titleMissing: rows.filter((r) => !r.title).length,
    descriptionMissing: rows.filter((r) => !r.description).length,
  };
}
