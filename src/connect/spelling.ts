/**
 * Spelling and grammar with LanguageTool (https://languagetool.org).
 *
 * Two ways to run it, both opt-in:
 * - your own server (Docker image or the standalone Java server): nothing leaves
 *   your network, no rate limit. Set `spelling.server` or AVC_LANGUAGETOOL_URL.
 * - the free public API, which receives the page text: `spelling.usePublicApi`.
 *   It is rate-limited, so fewer pages are checked and requests are spaced out.
 *
 * Only each page's main text is sent, so menus and footers do not add noise.
 */
import type { AvcConfig } from '../core/config.js';
import type { PageData, SiteContext, SpellingData } from '../core/types.js';
import type { FetchFn } from './google-api.js';

export const PUBLIC_LANGUAGETOOL = 'https://api.languagetool.org';
const MAX_CHARS = 6_000;
/** Rule categories that are mistakes rather than style suggestions. */
const MISTAKES = new Set([
  'TYPOS',
  'GRAMMAR',
  'CASING',
  'CONFUSED_WORDS',
  'PUNCTUATION',
  'COMPOUNDING',
]);

export function spellingServer(config: AvcConfig): string | null {
  const s = config.spelling;
  if (s?.server) return s.server.replace(/\/+$/, '');
  return s?.usePublicApi ? PUBLIC_LANGUAGETOOL : null;
}

/** LanguageTool language code for a page: its lang attribute (en-GB), the config, or auto. */
export function languageFor(page: Pick<PageData, 'lang'>, configured?: string): string {
  if (configured && configured !== 'auto') return configured;
  const l = (page.lang ?? '').trim();
  if (!l) return 'auto';
  const [base, region] = l.split(/[-_]/);
  if (!base) return 'auto';
  // LanguageTool wants a variant for English, German and Portuguese spelling.
  if (base.toLowerCase() === 'en') return region ? `en-${region.toUpperCase()}` : 'en-US';
  if (base.toLowerCase() === 'de') return region ? `de-${region.toUpperCase()}` : 'de-DE';
  if (base.toLowerCase() === 'pt') return region ? `pt-${region.toUpperCase()}` : 'pt-PT';
  return base.toLowerCase();
}

interface LtMatch {
  message?: string;
  context?: { text?: string; offset?: number; length?: number };
  rule?: { id?: string; category?: { id?: string } };
}

/** Keep real mistakes, drop ignored words and duplicates. */
export function filterMatches(
  matches: LtMatch[],
  ignore: string[] = [],
): SpellingData['pages'][number]['matches'] {
  const skip = new Set(ignore.map((w) => w.toLowerCase().trim()).filter(Boolean));
  const seen = new Set<string>();
  const out: SpellingData['pages'][number]['matches'] = [];
  for (const m of matches) {
    const category = m.rule?.category?.id ?? '';
    if (!MISTAKES.has(category)) continue;
    const ctx = m.context?.text ?? '';
    const word = ctx.slice(
      m.context?.offset ?? 0,
      (m.context?.offset ?? 0) + (m.context?.length ?? 0),
    );
    if (word && skip.has(word.toLowerCase())) continue;
    const key = `${m.rule?.id}|${word.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ message: m.message ?? '', context: ctx, rule: m.rule?.id ?? '', category });
  }
  return out;
}

/** Pages worth checking: indexable HTML with real text, most-linked first. */
function pickPages(site: SiteContext, n: number): PageData[] {
  return [...site.pages.values()]
    .filter((p) => p.isHtml && p.status === 200 && (p.mainText || p.text).split(/\s+/).length >= 80)
    .sort((a, b) => (site.inlinks.get(b.url)?.size ?? 0) - (site.inlinks.get(a.url)?.size ?? 0))
    .slice(0, n);
}

export async function collectSpelling(
  site: SiteContext,
  config: AvcConfig,
  opts: { fetch?: FetchFn; delayMs?: number } = {},
): Promise<SpellingData | null> {
  const server = spellingServer(config);
  if (!server) return null;
  const isPublic = server === PUBLIC_LANGUAGETOOL;
  const max = config.spelling?.maxPages ?? (isPublic ? 10 : 25);
  const f = opts.fetch ?? fetch;
  const delay = opts.delayMs ?? (isPublic ? 3_500 : 0);
  const pages: SpellingData['pages'] = [];
  let checked = 0;
  for (const p of pickPages(site, max)) {
    const language = languageFor(p, config.spelling?.language);
    const text = (p.mainText || p.text).slice(0, MAX_CHARS);
    const body = new URLSearchParams({ text, language });
    if (language === 'auto') body.set('preferredVariants', 'en-GB,de-DE,pt-PT');
    const res = await f(`${server}/v2/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    });
    if (res.status === 429) break; // public API limit: keep what we have
    if (!res.ok) throw new Error(`LanguageTool returned HTTP ${res.status} at ${server}`);
    const json = (await res.json()) as { matches?: LtMatch[]; language?: { code?: string } };
    checked++;
    const matches = filterMatches(json.matches ?? [], config.spelling?.ignore);
    pages.push({ url: p.url, language: json.language?.code ?? language, matches });
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
  return { server, checked, pages };
}
