/**
 * Shared helpers for the technical, content, accessibility and CMS checks.
 * Pure functions over PageData / SiteContext. Nothing here fetches.
 */
import { parseHTML } from 'linkedom';
import type {
  Check,
  CheckDef,
  Issue,
  PageCheck,
  PageData,
  SiteCheck,
  SiteContext,
} from '../core/types.js';
import { bareHost, normaliseUrl, TRACKING_PARAMS } from '../core/url.js';

export { TRACKING_PARAMS };

// ---------------------------------------------------------------------------
// Check builders
// ---------------------------------------------------------------------------

export type DefInput = Omit<CheckDef, 'scope'>;

/** A page check. The run function is wrapped so it can never throw. */
export function pageCheck(def: DefInput, run: PageCheck['run']): Check {
  return {
    kind: 'page',
    def: { ...def, scope: 'page' },
    run(page, site) {
      try {
        return run(page, site);
      } catch {
        return null;
      }
    },
  };
}

/** A site check. Issues may still carry a `url` when they point at one page. */
export function siteCheck(def: DefInput, run: SiteCheck['run']): Check {
  return {
    kind: 'site',
    def: { ...def, scope: 'site' },
    async run(site) {
      try {
        return await run(site);
      } catch {
        return null;
      }
    },
  };
}

/** Common documentation links. */
export const REF = {
  robotsMeta: 'https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag',
  robotsTxt: 'https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt',
  canonical:
    'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls',
  redirects: 'https://developers.google.com/search/docs/crawling-indexing/301-redirects',
  httpStatus: 'https://developers.google.com/search/docs/crawling-indexing/http-network-errors',
  soft404: 'https://developers.google.com/search/docs/crawling-indexing/http-network-errors#soft-404-errors',
  titles: 'https://developers.google.com/search/docs/appearance/title-link',
  snippets: 'https://developers.google.com/search/docs/appearance/snippet',
  links: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable',
  qualifyLinks: 'https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links',
  images: 'https://developers.google.com/search/docs/appearance/google-images',
  sitemaps: 'https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap',
  sitemapsProtocol: 'https://www.sitemaps.org/protocol.html',
  hreflang: 'https://developers.google.com/search/docs/specialty/international/localized-versions',
  structuredData:
    'https://developers.google.com/search/docs/appearance/structured-data/sd-policies',
  sdGallery: 'https://developers.google.com/search/docs/appearance/structured-data/search-gallery',
  mobile: 'https://developers.google.com/search/docs/crawling-indexing/mobile/mobile-sites-mobile-first-indexing',
  cwv: 'https://web.dev/articles/vitals',
  lcp: 'https://web.dev/articles/lcp',
  cls: 'https://web.dev/articles/cls',
  inp: 'https://web.dev/articles/inp',
  ttfb: 'https://web.dev/articles/ttfb',
  renderBlocking: 'https://developer.chrome.com/docs/lighthouse/performance/render-blocking-resources',
  https: 'https://developers.google.com/search/docs/crawling-indexing/https',
  mdnHeaders: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers',
  pagination: 'https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading',
  urlStructure: 'https://developers.google.com/search/docs/crawling-indexing/url-structure',
  helpfulContent: 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content',
  spam: 'https://developers.google.com/search/docs/essentials/spam-policies',
  js: 'https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics',
  wcag: 'https://www.w3.org/TR/WCAG22/',
  bingGuidelines: 'https://www.bing.com/webmasters/help/webmasters-guidelines-30fba23a',
  gscInspect: 'https://support.google.com/webmasters/answer/9012289',
  gscIndexing: 'https://support.google.com/webmasters/answer/7440203',
} as const;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export const CURRENT_YEAR = new Date().getFullYear();

export function truncate(s: string | null | undefined, n = 200): string {
  if (!s) return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function list(items: string[], n = 5): string {
  const shown = items.slice(0, n).join(', ');
  return items.length > n ? `${shown} and ${items.length - n} more` : shown;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function groupBy<T>(items: Iterable<T>, key: (t: T) => string | null | undefined) {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (k == null || k === '') continue;
    const arr = out.get(k);
    if (arr) arr.push(it);
    else out.set(k, [it]);
  }
  return out;
}

export function words(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

export function safeUrl(u: string | null | undefined): URL | null {
  if (!u) return null;
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

export function pathOf(u: string): string {
  return safeUrl(u)?.pathname ?? '';
}

export function hostOf(u: string): string {
  return safeUrl(u)?.hostname.toLowerCase() ?? '';
}

/** Normalised key for comparing URLs (scheme/host case, default port, fragment). */
export function urlKey(u: string | null | undefined): string {
  if (!u) return '';
  return normaliseUrl(u);
}

export function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return urlKey(a) === urlKey(b);
}

/** Same registrable-ish site: hosts equal once a leading www. is removed. */
export function sameSiteHost(a: string, b: string): boolean {
  const ha = hostOf(a);
  const hb = hostOf(b);
  return !!ha && bareHost(ha) === bareHost(hb);
}

export function header(page: { headers: Record<string, string> }, name: string): string | null {
  const v = page.headers?.[name.toLowerCase()];
  return v == null ? null : String(v);
}

// ---------------------------------------------------------------------------
// Page classification
// ---------------------------------------------------------------------------

/** HTML response with status 200 and no fetch error. */
export function isHtml200(page: PageData): boolean {
  return page.isHtml && page.status === 200 && !page.error;
}

/**
 * Robots directives that apply to Google for this page: meta robots, the
 * googlebot meta and X-Robots-Tag (lines aimed at other named bots excluded).
 */
export function robotsDirectives(page: PageData): Set<string> {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => {
    if (!s) return;
    for (const part of s.split(',')) {
      const d = part.trim().toLowerCase();
      if (!d) continue;
      if (d === 'none') {
        out.add('noindex');
        out.add('nofollow');
      } else out.add(d.replace(/\s*:\s*/, ':'));
    }
  };
  add(page.metaRobots);
  add(page.botMeta?.googlebot);
  for (const d of xRobotsDirectives(page.xRobotsTag, 'googlebot')) add(d);
  return out;
}

/**
 * Split an X-Robots-Tag value. Lines/segments prefixed with a bot token
 * ("otherbot: noindex") only apply to that bot.
 */
export function xRobotsDirectives(value: string | null | undefined, bot = 'googlebot'): string[] {
  if (!value) return [];
  const out: string[] = [];
  // Multiple headers are often joined with ", " — split on commas but keep bot prefixes.
  let currentBot: string | null = null;
  for (const raw of value.split(/,|\n/)) {
    let part = raw.trim();
    if (!part) continue;
    const m = /^([a-z0-9_-]+)\s*:\s*(.+)$/i.exec(part);
    if (m && !/^(max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i.test(m[1])) {
      currentBot = m[1].toLowerCase();
      part = m[2];
    }
    if (currentBot && currentBot !== bot.toLowerCase()) continue;
    out.push(part);
  }
  return out;
}

export function isNoindex(page: PageData): boolean {
  return robotsDirectives(page).has('noindex');
}

export function isNofollow(page: PageData): boolean {
  return robotsDirectives(page).has('nofollow');
}

/** The canonical the page declares (HTML first, then Link header). */
export function declaredCanonical(page: PageData): string | null {
  return page.canonical || page.canonicalHeader || null;
}

/** True when the page canonicalises to a different URL. */
export function isCanonicalisedAway(page: PageData): boolean {
  const c = declaredCanonical(page);
  if (!c) return false;
  return !sameUrl(c, page.url) && !sameUrl(c, page.finalUrl);
}

/** HTML 200, not noindex, not blocked by robots, not canonicalised elsewhere. */
export function isIndexable(page: PageData): boolean {
  return (
    isHtml200(page) && !page.blockedByRobots && !isNoindex(page) && !isCanonicalisedAway(page)
  );
}

/** Alias kept for readability in check files. */
export const isIndexableHtml = isIndexable;

export function htmlPages(site: SiteContext): PageData[] {
  return [...site.pages.values()].filter(isHtml200);
}

export function indexablePages(site: SiteContext): PageData[] {
  return [...site.pages.values()].filter(isIndexable);
}

export function isHttpsSite(site: SiteContext): boolean {
  return site.origin.startsWith('https:');
}

/** Query-string page numbers or /page/N/ paths. */
export function pageNumber(url: string): number | null {
  const u = safeUrl(url);
  if (!u) return null;
  for (const k of ['page', 'p', 'pg', 'paged', 'pagenum', 'pagenumber']) {
    const v = u.searchParams.get(k);
    if (v && /^\d+$/.test(v) && (k !== 'p' || u.searchParams.size === 1)) return Number(v);
  }
  const m = /\/(?:page|seite|pagina|p)\/(\d+)\/?$/i.exec(u.pathname);
  return m ? Number(m[1]) : null;
}

const ARTICLE_TYPES = new Set([
  'Article',
  'BlogPosting',
  'NewsArticle',
  'TechArticle',
  'Report',
  'ScholarlyArticle',
  'LiveBlogPosting',
]);
const ARTICLE_PATH = /\/(blog|news|articles?|insights|posts?|stories|journal|guides?|resources)\/[^/]+/i;

/** Best-effort: is this an article / blog post (not a listing page)? */
export function isArticleLike(page: PageData): boolean {
  if (page.structuredData.some((s) => s.types.some((t) => ARTICLE_TYPES.has(t)))) return true;
  if ((page.og['og:type'] || '').toLowerCase() === 'article') return true;
  const path = pathOf(page.url);
  return ARTICLE_PATH.test(path) && pageNumber(page.url) == null && !/\/(tag|category|author)\//i.test(path);
}

// ---------------------------------------------------------------------------
// Site lookups (cached per SiteContext)
// ---------------------------------------------------------------------------

const indexCache = new WeakMap<SiteContext, Map<string, PageData>>();

/** Map of url and finalUrl keys → page. */
export function pageIndex(site: SiteContext): Map<string, PageData> {
  let idx = indexCache.get(site);
  if (idx && idx.size >= site.pages.size) return idx;
  idx = new Map();
  for (const [k, p] of site.pages) {
    idx.set(urlKey(k), p);
    if (!idx.has(urlKey(p.url))) idx.set(urlKey(p.url), p);
  }
  // finalUrl keys only where nothing else claims them.
  for (const p of site.pages.values()) {
    const fk = urlKey(p.finalUrl);
    if (fk && !idx.has(fk)) idx.set(fk, p);
  }
  indexCache.set(site, idx);
  return idx;
}

/** The crawled page for a URL, if any. Looks up the URL as requested, not where it ended. */
export function findPage(site: SiteContext, url: string | null | undefined): PageData | undefined {
  if (!url) return undefined;
  const direct = site.pages.get(url);
  if (direct) return direct;
  return pageIndex(site).get(urlKey(url));
}

/** The page a URL ends up at after redirects (the page whose finalUrl matches, else the page). */
export function resolvePage(site: SiteContext, url: string): PageData | undefined {
  const p = findPage(site, url);
  if (!p) return undefined;
  if (p.redirects.length && !sameUrl(p.finalUrl, p.url)) {
    const target = site.pages.get(p.finalUrl) ?? pageIndex(site).get(urlKey(p.finalUrl));
    if (target && target !== p && target.redirects.length === 0) return target;
  }
  return p;
}

export function homePage(site: SiteContext): PageData | undefined {
  return (
    findPage(site, site.startUrl) ??
    findPage(site, site.origin + '/') ??
    [...site.pages.values()].find((p) => p.depth === 0)
  );
}

export function isHomepage(page: PageData, site: SiteContext): boolean {
  if (page.depth === 0) return true;
  const path = pathOf(page.finalUrl || page.url);
  return (path === '/' || path === '') && sameSiteHost(page.url, site.origin) && !safeUrl(page.url)?.search;
}

/** Number of distinct internal pages linking to this URL. */
export function inlinkCount(site: SiteContext, url: string): number {
  return inlinkSources(site, url).size;
}

export function inlinkSources(site: SiteContext, url: string): Set<string> {
  const direct = site.inlinks.get(url);
  if (direct) return direct;
  const key = urlKey(url);
  for (const [k, v] of site.inlinks) if (urlKey(k) === key) return v;
  return new Set();
}

/** Whether a page was redirected (status 3xx chain recorded). */
export function wasRedirected(page: PageData): boolean {
  return page.redirects.length > 0 && !sameUrl(page.url, page.finalUrl);
}

/**
 * Status for an external URL as recorded by the crawler, when it checked them.
 * Reads `site.externalStatuses` (Map<string, number> or plain object). Empty map otherwise.
 */
export function getExternalStatuses(site: SiteContext): Map<string, number> {
  const raw = (site as unknown as { externalStatuses?: unknown }).externalStatuses;
  if (raw instanceof Map) return raw as Map<string, number>;
  if (raw && typeof raw === 'object') {
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (typeof v === 'number') m.set(k, v);
    return m;
  }
  return new Map();
}

// ---------------------------------------------------------------------------
// Internal link score (PageRank-style), cached per site
// ---------------------------------------------------------------------------

export interface LinkScore {
  /** Raw PageRank share (sums to ~1 across HTML pages). */
  rank: number;
  /** 0–10 scale, log-normalised against the best-linked page. */
  score: number;
  /** 0–1 percentile among HTML pages (1 = best linked). */
  percentile: number;
}

const scoreCache = new WeakMap<SiteContext, Map<string, LinkScore>>();
export const PAGERANK_DAMPING = 0.85;
export const PAGERANK_ITERATIONS = 30;

/**
 * PageRank over followed internal links between crawled HTML 200 pages.
 * Links from noindex,nofollow pages and rel=nofollow links pass nothing.
 */
export function linkScores(site: SiteContext): Map<string, LinkScore> {
  const cached = scoreCache.get(site);
  if (cached) return cached;
  const nodes = htmlPages(site);
  const id = new Map<string, number>();
  nodes.forEach((p, i) => {
    id.set(urlKey(p.url), i);
    if (!id.has(urlKey(p.finalUrl))) id.set(urlKey(p.finalUrl), i);
  });
  const n = nodes.length;
  const out = new Map<string, LinkScore>();
  if (n === 0) {
    scoreCache.set(site, out);
    return out;
  }
  const edges: number[][] = nodes.map((p) => {
    if (isNofollow(p)) return [];
    const targets = new Set<number>();
    for (const l of p.links) {
      if (!l.internal || l.rel.includes('nofollow')) continue;
      let t = id.get(urlKey(l.href));
      if (t === undefined) {
        const r = findPage(site, l.href);
        if (r) t = id.get(urlKey(r.finalUrl));
      }
      if (t !== undefined && t !== id.get(urlKey(p.url))) targets.add(t);
    }
    return [...targets];
  });
  let pr = new Array<number>(n).fill(1 / n);
  for (let it = 0; it < PAGERANK_ITERATIONS; it++) {
    const next = new Array<number>(n).fill((1 - PAGERANK_DAMPING) / n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const e = edges[i];
      if (!e.length) dangling += pr[i];
      else for (const t of e) next[t] += (PAGERANK_DAMPING * pr[i]) / e.length;
    }
    for (let i = 0; i < n; i++) next[i] += (PAGERANK_DAMPING * dangling) / n;
    pr = next;
  }
  const max = Math.max(...pr);
  const min = Math.min(...pr);
  const sorted = [...pr].sort((a, b) => a - b);
  nodes.forEach((p, i) => {
    const r = pr[i];
    const score =
      max === min ? 10 : (10 * (Math.log(r) - Math.log(min))) / (Math.log(max) - Math.log(min));
    const below = sorted.findIndex((v) => v >= r);
    out.set(urlKey(p.url), {
      rank: r,
      score: Math.round(score * 10) / 10,
      percentile: n === 1 ? 1 : below / (n - 1),
    });
  });
  scoreCache.set(site, out);
  return out;
}

export function linkScore(site: SiteContext, url: string): LinkScore | undefined {
  return linkScores(site).get(urlKey(url));
}

// ---------------------------------------------------------------------------
// HTML parsing (cached per page)
// ---------------------------------------------------------------------------

const docCache = new WeakMap<object, Document>();

function parse(html: string): Document {
  const safe = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head></head><body>${html}</body></html>`;
  return parseHTML(safe).document as unknown as Document;
}

/** Parsed raw HTML of a page (linkedom). Cached. */
export function doc(page: PageData): Document {
  let d = docCache.get(page);
  if (!d) {
    d = parse(page.html || '');
    docCache.set(page, d);
  }
  return d;
}

/** Parsed rendered HTML, or null when not rendered. Cached. */
export function renderedDoc(page: PageData): Document | null {
  if (!page.rendered?.html) return null;
  const key = page.rendered;
  let d = docCache.get(key);
  if (!d) {
    d = parse(page.rendered.html);
    docCache.set(key, d);
  }
  return d;
}

/** Raw <head> markup (up to </head>, or the first 20 KB if there is no closing tag). */
export function rawHead(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  if (end >= 0) return html.slice(0, end);
  const body = html.search(/<body[\s>]/i);
  return html.slice(0, body >= 0 ? body : 20_000);
}

/** Raw markup after </head>. */
export function rawBody(html: string): string {
  const end = html.search(/<\/head\s*>/i);
  return end >= 0 ? html.slice(end) : html;
}

/** Text of an element as an accessible-name approximation (text + img alts). */
export function accessibleText(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) parts.push(node.textContent || '');
    else if (node.nodeType === 1) {
      const e = node as Element;
      const tag = e.tagName.toLowerCase();
      if (e.getAttribute('aria-hidden') === 'true') return;
      if (tag === 'script' || tag === 'style' || tag === 'template') return;
      if (tag === 'img' || (tag === 'input' && e.getAttribute('type') === 'image'))
        parts.push(e.getAttribute('alt') || '');
      else if (tag === 'svg') {
        const t = e.querySelector('title');
        parts.push(e.getAttribute('aria-label') || t?.textContent || '');
        return;
      }
      for (const c of Array.from(e.childNodes)) walk(c);
    }
  };
  walk(el);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Accessible name of an element: aria-label, aria-labelledby, content, title. */
export function accessibleName(el: Element, d: Document): string {
  const label = el.getAttribute('aria-label');
  if (label && label.trim()) return label.trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const txt = by
      .split(/\s+/)
      .map((id) => d.getElementById(id)?.textContent || '')
      .join(' ')
      .trim();
    if (txt) return txt;
  }
  const own = accessibleText(el);
  if (own) return own;
  return (el.getAttribute('title') || '').trim();
}

// ---------------------------------------------------------------------------
// Structured data helpers
// ---------------------------------------------------------------------------

export type SchemaNode = Record<string, unknown>;

/** Types of a node as an array of strings (schema: prefix and URL prefix removed). */
export function nodeTypes(node: SchemaNode): string[] {
  const t = node['@type'];
  const arr = Array.isArray(t) ? t : t == null ? [] : [t];
  return arr
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/i, ''));
}

/** Top-level JSON-LD nodes of a page (arrays and @graph flattened). */
export function topNodes(page: PageData): SchemaNode[] {
  const out: SchemaNode[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(push);
    else if (v && typeof v === 'object') {
      const o = v as SchemaNode;
      if (Array.isArray(o['@graph'])) (o['@graph'] as unknown[]).forEach(push);
      if (o['@type'] !== undefined) out.push(o);
    }
  };
  for (const s of page.structuredData) if (s.format === 'json-ld' && !s.error) push(s.raw);
  return out;
}

/** Every node with an @type anywhere in the JSON-LD (nested included). */
export function allNodes(page: PageData): SchemaNode[] {
  const out: SchemaNode[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || v == null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as SchemaNode;
    if (o['@type'] !== undefined) out.push(o);
    for (const val of Object.values(o)) walk(val, depth + 1);
  };
  for (const s of page.structuredData) if (s.format === 'json-ld' && !s.error) walk(s.raw, 0);
  return out;
}

export function nodesOfType(page: PageData, types: string[]): SchemaNode[] {
  const set = new Set(types);
  return allNodes(page).filter((n) => nodeTypes(n).some((t) => set.has(t)));
}

/** Plain string value of a property (first item if an array, `name`/`@id`/`url` if an object). */
export function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length ? str(v[0]) : null;
  if (typeof v === 'object') {
    const o = v as SchemaNode;
    return str(o.name) ?? str(o['@id']) ?? str(o.url) ?? str(o['@value']) ?? null;
  }
  return null;
}

/** True when a property is present and not empty. */
export function has(node: SchemaNode, prop: string): boolean {
  const v = node[prop];
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : v == null ? [] : [v as T];
}

/** ISO 8601 date or date-time (the forms schema.org and sitemaps accept). */
export const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/** Hamming distance between two 64-bit simhashes given as hex strings. */
export function simhashDistance(a: string, b: string): number {
  if (!a || !b) return 64;
  try {
    let x = BigInt('0x' + a) ^ BigInt('0x' + b);
    let n = 0;
    while (x) {
      x &= x - 1n;
      n++;
    }
    return n;
  } catch {
    return 64;
  }
}

/** Normalise text for duplicate comparisons. */
export function normText(s: string | null | undefined): string {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Text statistics
// ---------------------------------------------------------------------------

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“(])/)
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 3);
}

/** Rough English syllable count. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch Reading Ease for English text. Null when too short to judge. */
export function fleschReadingEase(text: string): number | null {
  const sents = sentences(text);
  const ws = words(text).filter((w) => /[a-z]/i.test(w));
  if (sents.length < 5 || ws.length < 150) return null;
  const syl = ws.reduce((s, w) => s + syllables(w), 0);
  return 206.835 - 1.015 * (ws.length / sents.length) - 84.6 * (syl / ws.length);
}

export function isEnglish(page: PageData): boolean {
  const lang = (page.lang || '').toLowerCase();
  if (lang) return lang.startsWith('en');
  const sample = ` ${page.text.slice(0, 3000).toLowerCase()} `;
  const hits = [' the ', ' and ', ' of ', ' to ', ' is ', ' for '].filter((w) =>
    sample.includes(w),
  ).length;
  return hits >= 4;
}

export const STOP_WORDS = new Set(
  (
    'a an and are as at be but by for from has have he her his i if in into is it its me my no not of on or our ' +
    'she so than that the their them then there these they this to too us was we were what when where which who ' +
    'why will with you your can do does did just more most about all also any been being both each few how only ' +
    'other over same some such up very out off own here should would could may might must shall yes our ours'
  ).split(' '),
);
