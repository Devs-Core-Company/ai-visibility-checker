/**
 * Shared helpers for the AI-readiness checks (ai-crawlers, llms-txt, geo,
 * entity, agentic) and src/agentic. Pure functions plus per-site and per-page
 * memoisation, so twenty checks reading the same JSON-LD parse it once.
 */
import { parseHTML } from 'linkedom';
import type {
  Check,
  CheckDef,
  Issue,
  PageCheck,
  PageData,
  ProbeResult,
  SiteCheck,
  SiteContext,
} from '../core/types.js';

export type Doc = ReturnType<typeof parseHTML>['document'];
export type JsonNode = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Memoisation
// ---------------------------------------------------------------------------

const siteMemoStore = new WeakMap<object, Map<string, unknown>>();

/** Compute a value once per site (or any object) and key. */
export function memo<T>(owner: object, key: string, fn: () => T): T {
  let m = siteMemoStore.get(owner);
  if (!m) {
    m = new Map();
    siteMemoStore.set(owner, m);
  }
  if (!m.has(key)) m.set(key, fn());
  return m.get(key) as T;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Quick visible-text approximation of an HTML string (no DOM). */
export function roughText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<\/?(p|div|li|h[1-6]|br|tr|td|th|section|article|header|footer|nav|ul|ol)\b[^>]*>/gi,
      ' \n ',
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code =
          e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function truncate(s: string, n = 300): string {
  const c = collapse(s);
  return c.length > n ? `${c.slice(0, n - 1)}…` : c;
}

export function firstWords(text: string, n: number): string {
  const words = collapse(text).split(' ');
  return words.slice(0, n).join(' ');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Evidence string under the 500-char contract limit. */
export function ev(s: string | string[]): string {
  const v = Array.isArray(s) ? s.join('\n') : s;
  return v.length > 480 ? `${v.slice(0, 479)}…` : v;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

export function parseDoc(html: string): Doc {
  const safe = /<html[\s>]/i.test(html)
    ? html
    : `<!doctype html><html><head></head><body>${html}</body></html>`;
  return parseHTML(safe).document;
}

const docCache = new WeakMap<PageData, Doc | null>();

/** Parsed DOM of a page's raw HTML, cached. Null for non-HTML or parse failure. */
export function pageDoc(page: PageData): Doc | null {
  if (docCache.has(page)) return docCache.get(page)!;
  let doc: Doc | null = null;
  if (page.isHtml && page.html) {
    try {
      doc = parseDoc(page.html);
    } catch {
      doc = null;
    }
  }
  docCache.set(page, doc);
  return doc;
}

/** The main-content root: <main>, the sole <article>, or <body>. */
export function mainRoot(doc: Doc): Element | null {
  const main = doc.querySelector('main, [role="main"]');
  if (main) return main as unknown as Element;
  const articles = doc.querySelectorAll('article');
  if (articles.length === 1) return articles[0] as unknown as Element;
  return (doc.body as unknown as Element) ?? null;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export function safeUrl(u: string, base?: string): URL | null {
  try {
    return new URL(u, base);
  } catch {
    return null;
  }
}

export function pathOf(u: string): string {
  return safeUrl(u)?.pathname ?? u;
}

export function sameSite(a: string, b: string): boolean {
  const x = safeUrl(a);
  const y = safeUrl(b);
  if (!x || !y) return false;
  return x.host.replace(/^www\./, '') === y.host.replace(/^www\./, '');
}

/** Compare URLs ignoring fragment, trailing slash and default index files. */
export function urlKey(u: string): string {
  const x = safeUrl(u);
  if (!x) return u;
  let p = x.pathname.replace(/\/index\.(html?|php)$/i, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return `${x.protocol}//${x.host.replace(/^www\./, '').toLowerCase()}${p}${x.search}`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function isOkHtml(page: PageData): boolean {
  return page.isHtml && page.status >= 200 && page.status < 300 && Boolean(page.html);
}

export function robotsDirectives(page: PageData): string {
  return [page.metaRobots ?? '', page.xRobotsTag ?? ''].join(',').toLowerCase();
}

export function isNoindex(page: PageData): boolean {
  return /(^|[\s,:])(noindex|none)($|[\s,])/.test(robotsDirectives(page));
}

export function canonicalElsewhere(page: PageData): boolean {
  const c = page.canonical ?? page.canonicalHeader;
  if (!c) return false;
  return urlKey(c) !== urlKey(page.finalUrl || page.url);
}

export function isIndexable(page: PageData): boolean {
  return isOkHtml(page) && !isNoindex(page) && !canonicalElsewhere(page) && !page.blockedByRobots;
}

export function htmlPages(site: SiteContext): PageData[] {
  return memo(site, 'htmlPages', () => [...site.pages.values()].filter(isOkHtml));
}

export function indexablePages(site: SiteContext): PageData[] {
  return memo(site, 'indexablePages', () => htmlPages(site).filter(isIndexable));
}

export function homePage(site: SiteContext): PageData | undefined {
  return memo(site, 'homePage', () => {
    const keys = [site.startUrl, `${site.origin}/`, site.origin].map(urlKey);
    for (const p of site.pages.values()) {
      if (keys.includes(urlKey(p.url)) || keys.includes(urlKey(p.finalUrl))) return p;
    }
    return [...site.pages.values()].find((p) => p.depth === 0);
  });
}

export function inlinkCount(site: SiteContext, url: string): number {
  return site.inlinks.get(url)?.size ?? 0;
}

/** Indexable HTML pages ordered by internal inlinks (most linked first), excluding the home page. */
export function topLinkedPages(site: SiteContext, n: number): PageData[] {
  const home = homePage(site);
  return indexablePages(site)
    .filter((p) => p !== home)
    .map((p) => ({ p, n: inlinkCount(site, p.url) }))
    .sort((a, b) => b.n - a.n || a.p.depth - b.p.depth || a.p.url.localeCompare(b.p.url))
    .slice(0, n)
    .map((x) => x.p);
}

const ARTICLE_TYPES = [
  'Article',
  'BlogPosting',
  'NewsArticle',
  'TechArticle',
  'Report',
  'ScholarlyArticle',
  'HowTo',
];
const ARTICLE_PATH =
  /\/(blog|news|insights|articles?|guides?|posts?|learn|resources|knowledge|stories|journal|updates)\//i;

const LISTING_PATH = /\/(tag|tags|category|categories|author|authors|archive|page)(\/|$)/i;

/** Editorial content: Article-type schema, an article-ish URL, or an <article> with a <time>. */
export function isArticleLike(page: PageData): boolean {
  if (schemaTypes(page).some((t) => ARTICLE_TYPES.includes(t))) return true;
  // Archives and listings (tags, categories, authors, page 2…) list articles; they are not one.
  if (LISTING_PATH.test(pathOf(page.url))) return false;
  if (ARTICLE_PATH.test(pathOf(page.url)) && page.wordCount >= 300) return true;
  return /<article\b[\s\S]*?<time\b/i.test(page.html) && page.wordCount >= 300;
}

// ---------------------------------------------------------------------------
// Structured data (JSON-LD)
// ---------------------------------------------------------------------------

function collectNodes(value: unknown, out: JsonNode[], depth = 0): void {
  if (depth > 12 || !value) return;
  if (Array.isArray(value)) {
    for (const v of value) collectNodes(v, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const node = value as JsonNode;
  if (node['@type']) out.push(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === '@context') continue;
    if (v && typeof v === 'object') collectNodes(v, out, depth + 1);
  }
}

const nodeCache = new WeakMap<PageData, JsonNode[]>();

/** Every typed JSON-LD node on a page (top-level, @graph and nested). */
export function jsonLdNodes(page: PageData): JsonNode[] {
  let nodes = nodeCache.get(page);
  if (nodes) return nodes;
  nodes = [];
  for (const item of page.structuredData ?? []) {
    if (item.format === 'json-ld' && !item.error) collectNodes(item.raw, nodes);
  }
  nodeCache.set(page, nodes);
  return nodes;
}

export function typesOf(node: JsonNode): string[] {
  const t = node['@type'];
  const list = Array.isArray(t) ? t : [t];
  return list
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.replace(/^.*[/#:]/, ''));
}

export function schemaTypes(page: PageData): string[] {
  const set = new Set<string>();
  for (const item of page.structuredData ?? [])
    for (const t of item.types) set.add(t.replace(/^.*[/#:]/, ''));
  for (const n of jsonLdNodes(page)) for (const t of typesOf(n)) set.add(t);
  return [...set];
}

export function nodesOfType(page: PageData, types: string[]): JsonNode[] {
  return jsonLdNodes(page).filter((n) => typesOf(n).some((t) => types.includes(t)));
}

export function siteNodesOfType(
  site: SiteContext,
  types: string[],
): { page: PageData; node: JsonNode }[] {
  const out: { page: PageData; node: JsonNode }[] = [];
  for (const page of htmlPages(site))
    for (const node of nodesOfType(page, types)) out.push({ page, node });
  return out;
}

/** A string from a schema value: plain string, first array entry, or {name|url|@id}. */
export function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.length ? str(v[0]) : null;
  if (typeof v === 'object') {
    const o = v as JsonNode;
    return str(o.name) ?? str(o.url) ?? str(o['@id']) ?? str(o.contentUrl) ?? null;
  }
  return null;
}

export function strList(v: unknown): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(str).filter((x): x is string => Boolean(x));
}

export function has(node: JsonNode, key: string): boolean {
  const v = node[key];
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export const ORG_TYPES = [
  'Organization',
  'Corporation',
  'LocalBusiness',
  'ProfessionalService',
  'OnlineBusiness',
  'OnlineStore',
  'Store',
  'Restaurant',
  'MedicalBusiness',
  'MedicalOrganization',
  'LegalService',
  'FinancialService',
  'HomeAndConstructionBusiness',
  'AutomotiveBusiness',
  'EducationalOrganization',
  'NGO',
  'GovernmentOrganization',
  'NewsMediaOrganization',
  'SportsOrganization',
  'LodgingBusiness',
  'FoodEstablishment',
  'HealthAndBeautyBusiness',
  'Dentist',
  'Physician',
  'Attorney',
  'RealEstateAgent',
  'TravelAgency',
];

export const LOCAL_TYPES = ORG_TYPES.filter(
  (t) =>
    ![
      'Organization',
      'Corporation',
      'OnlineBusiness',
      'OnlineStore',
      'NGO',
      'EducationalOrganization',
      'GovernmentOrganization',
      'NewsMediaOrganization',
      'SportsOrganization',
    ].includes(t),
);

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

export function probe(site: SiteContext, id: string): ProbeResult | undefined {
  return site.probes?.get(id);
}

export function found(site: SiteContext, id: string): ProbeResult | undefined {
  const p = probe(site, id);
  return p?.found ? p : undefined;
}

export function probesRan(site: SiteContext): boolean {
  return Boolean(site.probes && site.probes.size > 0);
}

export function isJsonType(ct: string | undefined): boolean {
  return /json/i.test(ct ?? '');
}

export function looksHtml(body: string | undefined, ct?: string): boolean {
  return (
    /text\/html|application\/xhtml/i.test(ct ?? '') ||
    /^\s*<(!doctype|html|head|body)\b/i.test(body ?? '')
  );
}

// ---------------------------------------------------------------------------
// robots.txt groups (our own light parse, for the questions robots-parser cannot answer)
// ---------------------------------------------------------------------------

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
  line: number;
}

export interface RobotsGroup {
  agents: string[];
  agentLines: number[];
  rules: RobotsRule[];
  crawlDelay?: { value: number; line: number };
  startLine: number;
}

export interface RobotsParsed {
  groups: RobotsGroup[];
  sitemaps: { url: string; line: number }[];
  /** Non-standard lines kept for the AI-preference checks, e.g. Content-Signal. */
  extras: { key: string; value: string; line: number; group: RobotsGroup | null }[];
  bytes: number;
}

export function parseRobots(body: string): RobotsParsed {
  const groups: RobotsGroup[] = [];
  const sitemaps: RobotsParsed['sitemaps'] = [];
  const extras: RobotsParsed['extras'] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  const lines = body.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const text = raw.replace(/#.*$/, '').trim();
    if (!text) return;
    const m = text.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) return;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], agentLines: [], rules: [], startLine: line };
        groups.push(current);
      }
      current.agents.push(value);
      current.agentLines.push(line);
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (key === 'allow' || key === 'disallow') {
      if (current) current.rules.push({ type: key, path: value, line });
      return;
    }
    if (key === 'crawl-delay') {
      const n = Number(value);
      if (current && Number.isFinite(n)) current.crawlDelay = { value: n, line };
      return;
    }
    if (key === 'sitemap') {
      sitemaps.push({ url: value, line });
      return;
    }
    extras.push({ key, value, line, group: current });
  });
  return { groups, sitemaps, extras, bytes: Buffer.byteLength(body) };
}

export function robotsParsed(site: SiteContext): RobotsParsed {
  return memo(site, 'robotsParsed', () => parseRobots(site.robots?.found ? site.robots.body : ''));
}

/** The group that applies to a token under RFC 9309: exact (case-insensitive) match, else '*'. */
export function groupsFor(
  parsed: RobotsParsed,
  token: string,
): { groups: RobotsGroup[]; specific: boolean } {
  const t = token.toLowerCase();
  const specific = parsed.groups.filter((g) => g.agents.some((a) => a.toLowerCase() === t));
  if (specific.length) return { groups: specific, specific: true };
  return { groups: parsed.groups.filter((g) => g.agents.includes('*')), specific: false };
}

export function robotsUsable(site: SiteContext): boolean {
  const r = site.robots;
  return Boolean(
    r && r.found && r.status !== null && r.status >= 200 && r.status < 300 && !looksHtml(r.body),
  );
}

export function robotsLine(site: SiteContext, n: number): string {
  return site.robots.body.split(/\r?\n/)[n - 1]?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Check builders (never throw)
// ---------------------------------------------------------------------------

export type AiDef = Omit<CheckDef, 'scope'>;

export function pageCheck(def: AiDef, run: PageCheck['run']): Check {
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

export function siteCheck(def: AiDef, run: SiteCheck['run']): Check {
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

export function issue(checkId: string, message: string, extra: Partial<Issue> = {}): Issue {
  const out: Issue = { checkId, message, ...extra };
  if (out.evidence) out.evidence = ev(out.evidence);
  return out;
}

/** Verb agreement: vb(1, 'is', 'are') → 'is'. */
export function vb(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
