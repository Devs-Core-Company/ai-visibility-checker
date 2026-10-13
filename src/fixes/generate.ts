/**
 * Generators that turn crawl data into real artefacts: llms.txt, robots.txt rules for AI
 * crawlers, JSON-LD (Organization, WebSite, LocalBusiness, Article, FAQPage, BreadcrumbList),
 * an A2A agent card, an MCP server card and title/description suggestions.
 *
 * Everything here is deterministic except `generateMetaSuggestions`, which can ask a model
 * when a key is configured (and never when `config.ai.mock` is set).
 */
import { parseHTML } from 'linkedom';
import type { AvcConfig } from '../core/config.js';
import type { AuditResult, PageSummary } from '../core/types.js';
import { FIX_AI_BOTS, isManagedToken } from './bots.js';
import type { BrandFacts } from './types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Minimal shape the site-level generators need. AuditResult satisfies it. */
export interface SiteData {
  site: string; // origin
  pages?: PageSummary[];
  robots?: { found: boolean; body: string };
  sitemaps?: { url: string; found: boolean }[];
}

const TITLE_SEPARATORS = /\s+[|–—\-·•:»]\s+/;

function originOf(site: string): string {
  try {
    return new URL(site).origin;
  } catch {
    return site.replace(/\/+$/, '');
  }
}

function hostOf(site: string): string {
  try {
    return new URL(site).host.replace(/^www\./, '');
  } catch {
    return site;
  }
}

function okPages(pages: PageSummary[] = []): PageSummary[] {
  return pages.filter(
    (p) =>
      p.status === 200 &&
      p.indexable !== false &&
      !/\?/.test(p.url) &&
      !/\.(xml|txt|json|jpe?g|png|gif|webp|svg|css|js|zip|ico)$/i.test(new URL(p.url).pathname),
  );
}

function homeOf(data: SiteData): PageSummary | undefined {
  const origin = originOf(data.site);
  return (data.pages ?? []).find((p) => {
    try {
      const u = new URL(p.finalUrl || p.url);
      return u.origin === origin && (u.pathname === '/' || u.pathname === '');
    } catch {
      return false;
    }
  });
}

/**
 * The brand name: the title segment most pages share (e.g. "… | Acme"), else the first
 * segment of the home title, else the host.
 */
export function inferBrandName(data: SiteData): string {
  const titles = okPages(data.pages)
    .map((p) => p.title)
    .filter((t): t is string => !!t);
  const counts = new Map<string, number>();
  for (const t of titles) {
    const parts = t.split(TITLE_SEPARATORS);
    if (parts.length < 2) continue;
    for (const seg of [parts[0], parts[parts.length - 1]]) {
      const k = seg.trim();
      if (k.length >= 2 && k.length <= 40) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best && titles.length >= 2 && best[1] >= Math.max(2, Math.ceil(titles.length * 0.3)))
    return best[0];
  const home = homeOf(data)?.title;
  if (home) {
    const seg = home.split(TITLE_SEPARATORS)[0].trim();
    if (seg.length >= 2 && seg.length <= 40) return seg;
  }
  return hostOf(data.site);
}

/** Strip the brand segment from a page title: "Pricing | Acme" → "Pricing". */
export function cleanTitle(title: string | null, brand: string): string | null {
  if (!title) return null;
  const parts = title.split(TITLE_SEPARATORS).map((s) => s.trim());
  const kept = parts.filter((p) => p.toLowerCase() !== brand.toLowerCase());
  return (kept.length ? kept : parts).join(' – ').trim() || null;
}

function humanise(segment: string): string {
  const s = decodeURIComponent(segment)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : segment;
}

function truncateWords(s: string, max: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.5 ? cut.slice(0, at) : clean.slice(0, max)).replace(/[\s,;:–-]+$/, '');
}

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

export interface LlmsTxtOptions {
  name?: string;
  summary?: string;
  /** Extra paragraph under the summary (who it is for, what the site offers). */
  details?: string;
  maxPerSection?: number;
  maxTotal?: number;
  /** URL path prefixes to leave out (e.g. ['/tag/', '/author/']). */
  exclude?: string[];
}

const OPTIONAL_RE = /(privacy|cookie|terms|legal|imprint|impressum|disclaimer|accessibility|sitemap)/i;
const SKIP_RE = /\/(tag|tags|author|page|feed|wp-json|cart|checkout|account|login|search)(\/|$)/i;

interface LlmsEntry {
  url: string;
  title: string;
  description: string | null;
  section: string;
  optional: boolean;
  score: number;
}

function llmsEntries(data: SiteData, opts: LlmsTxtOptions): { name: string; entries: LlmsEntry[] } {
  const name = opts.name ?? inferBrandName(data);
  const origin = originOf(data.site);
  const seen = new Set<string>();
  const entries: LlmsEntry[] = [];
  const pages = okPages(data.pages);
  const segCount = new Map<string, number>();
  for (const p of pages) {
    const seg = new URL(p.finalUrl || p.url).pathname.split('/').filter(Boolean)[0];
    if (seg) segCount.set(seg, (segCount.get(seg) ?? 0) + 1);
  }
  for (const p of pages) {
    const u = new URL(p.finalUrl || p.url);
    if (u.origin !== origin) continue;
    if (u.pathname === '/' || u.pathname === '') continue;
    if (SKIP_RE.test(u.pathname)) continue;
    if (opts.exclude?.some((e) => u.pathname.startsWith(e))) continue;
    const key = u.origin + u.pathname.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const segs = u.pathname.split('/').filter(Boolean);
    const first = segs[0] ?? '';
    const grouped = segs.length > 1 || (segCount.get(first) ?? 0) > 2;
    const section = grouped && (segCount.get(first) ?? 0) >= 2 ? humanise(first) : 'Pages';
    const title =
      cleanTitle(p.title, name) ?? p.h1 ?? humanise(segs[segs.length - 1] ?? u.pathname);
    entries.push({
      url: u.href,
      title: title.replace(/[[\]]/g, ''),
      description: p.metaDescription ? truncateWords(p.metaDescription, 180) : null,
      section,
      optional: OPTIONAL_RE.test(u.pathname),
      // inlinks show what the site itself treats as important; shallow pages rank higher
      score: (p.inlinks ?? 0) * 2 - p.depth * 3 + Math.min(p.wordCount, 2000) / 400,
    });
  }
  return { name, entries };
}

/**
 * Build llms.txt (https://llmstxt.org): H1 name, blockquote summary, then sections of
 * `- [Title](url): description`, with legal pages under "## Optional".
 */
export function generateLlmsTxt(data: SiteData, opts: LlmsTxtOptions = {}): string {
  const { name, entries } = llmsEntries(data, opts);
  const home = homeOf(data);
  const summary =
    opts.summary ?? home?.metaDescription ?? `The official website of ${name} (${hostOf(data.site)}).`;
  const maxPer = opts.maxPerSection ?? 15;
  const maxTotal = opts.maxTotal ?? 100;
  const lines = [`# ${name}`, '', `> ${summary.replace(/\s+/g, ' ').trim()}`, ''];
  if (opts.details) lines.push(opts.details.trim(), '');
  const main = entries.filter((e) => !e.optional);
  const sections = new Map<string, LlmsEntry[]>();
  for (const e of main) {
    const list = sections.get(e.section) ?? [];
    list.push(e);
    sections.set(e.section, list);
  }
  // 'Pages' first, then the larger sections
  const order = [...sections.keys()].sort((a, b) =>
    a === 'Pages' ? -1 : b === 'Pages' ? 1 : (sections.get(b)!.length - sections.get(a)!.length) || a.localeCompare(b),
  );
  let total = 0;
  for (const s of order) {
    const list = sections
      .get(s)!
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPer);
    if (!list.length || total >= maxTotal) continue;
    lines.push(`## ${s}`, '');
    for (const e of list) {
      if (total >= maxTotal) break;
      lines.push(`- [${e.title}](${e.url})${e.description ? `: ${e.description}` : ''}`);
      total++;
    }
    lines.push('');
  }
  const optional = entries.filter((e) => e.optional).slice(0, 10);
  if (optional.length) {
    lines.push('## Optional', '');
    for (const e of optional) lines.push(`- [${e.title}](${e.url})`);
    lines.push('');
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * llms-full.txt: the same pages with their text inlined. AuditResult does not keep page
 * text, so pass it in `texts` (url → main text) from the crawl; pages without text get
 * their description only.
 */
export function generateLlmsFullTxt(
  data: SiteData,
  opts: LlmsTxtOptions & { texts?: Map<string, string> | Record<string, string>; maxChars?: number } = {},
): string {
  const { name, entries } = llmsEntries(data, { ...opts, maxPerSection: 1000 });
  const home = homeOf(data);
  const get = (u: string): string | undefined =>
    opts.texts instanceof Map ? opts.texts.get(u) : opts.texts?.[u];
  const maxChars = opts.maxChars ?? 2_000_000;
  const out = [`# ${name}`, '', `> ${home?.metaDescription ?? `The official website of ${name}.`}`, ''];
  let size = out.join('\n').length;
  for (const e of entries.filter((x) => !x.optional).sort((a, b) => b.score - a.score)) {
    const body = (get(e.url) ?? get(e.url.replace(/\/$/, '')) ?? e.description ?? '').trim();
    const block = `## ${e.title}\n\nSource: ${e.url}\n\n${body}\n`;
    if (size + block.length > maxChars) break;
    out.push(block);
    size += block.length;
  }
  return out.join('\n').trimEnd() + '\n';
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export type RobotsPolicy = 'allow-all-ai' | 'allow-search-block-training' | 'custom';

export interface RobotsOptions {
  /** For 'custom': token → decision. Tokens not listed are left as they are. */
  custom?: Record<string, 'allow' | 'block'>;
  /** Sitemap URLs to make sure are listed. */
  sitemaps?: string[];
  /**
   * Content-Signal line for the `*` group (Cloudflare's Content Signals Policy), e.g.
   * { search: 'yes', 'ai-input': 'yes', 'ai-train': 'no' }. Omit to leave it unchanged.
   */
  contentSignal?: Partial<Record<'search' | 'ai-input' | 'ai-train', 'yes' | 'no'>>;
}

export const AVC_BEGIN = '# BEGIN AVC AI crawler rules';
export const AVC_END = '# END AVC AI crawler rules';

interface RobotsGroup {
  start: number; // index of first UA line
  uaLines: { index: number; token: string }[];
  ruleLines: number[];
}

function parseGroups(lines: string[]): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let cur: RobotsGroup | null = null;
  let lastWasUa = false;
  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return;
    const key = m[1].toLowerCase();
    if (key === 'user-agent') {
      if (!cur || !lastWasUa) {
        cur = { start: index, uaLines: [], ruleLines: [] };
        groups.push(cur);
      }
      cur.uaLines.push({ index, token: m[2].trim() });
      lastWasUa = true;
    } else if (key === 'sitemap') {
      lastWasUa = false; // sitemap lines are global; they do not belong to a group
    } else {
      if (cur) cur.ruleLines.push(index);
      lastWasUa = false;
    }
  });
  return groups;
}

function decide(policy: RobotsPolicy, opts: RobotsOptions): Map<string, 'allow' | 'block'> {
  const out = new Map<string, 'allow' | 'block'>();
  if (policy === 'custom') {
    for (const [k, v] of Object.entries(opts.custom ?? {})) out.set(k, v);
    return out;
  }
  for (const b of FIX_AI_BOTS) {
    out.set(b.token, policy === 'allow-search-block-training' && b.purpose === 'training' ? 'block' : 'allow');
  }
  return out;
}

/**
 * Rewrite robots.txt so AI crawlers follow `policy`, keeping every other rule.
 *
 * - Existing groups for the managed tokens are removed (or the token is taken out of a
 *   shared group), and one managed block is written between BEGIN/END markers.
 * - Allowed bots get a copy of the `*` group's path rules (minus a blanket `Disallow: /`),
 *   because a bot that has its own group ignores `*` — copying keeps private paths private.
 * - Re-running replaces the managed block, so the output is stable.
 */
export function generateRobotsTxt(
  current: string | null | undefined,
  policy: RobotsPolicy,
  opts: RobotsOptions = {},
): string {
  let text = (current ?? '').replace(/\r\n/g, '\n');
  // drop a previous managed block
  const b = text.indexOf(AVC_BEGIN);
  const e = text.indexOf(AVC_END);
  if (b !== -1 && e > b) text = text.slice(0, b) + text.slice(e + AVC_END.length);
  let lines = text.split('\n');
  const decisions = decide(policy, opts);
  const managed = (t: string) =>
    [...decisions.keys()].some((k) => k.toLowerCase() === t.toLowerCase());

  const groups = parseGroups(lines);
  const remove = new Set<number>();
  for (const g of groups) {
    const hits = g.uaLines.filter((u) => managed(u.token));
    if (!hits.length) continue;
    if (hits.length === g.uaLines.length) {
      for (const u of g.uaLines) remove.add(u.index);
      for (const r of g.ruleLines) remove.add(r);
    } else {
      for (const u of hits) remove.add(u.index);
    }
  }
  // star group rules to copy into the allow group
  const star = groups.find((g) => g.uaLines.some((u) => u.token === '*'));
  const starRules = (star?.ruleLines ?? [])
    .map((i) => lines[i].replace(/#.*$/, '').trim())
    .filter((l) => /^(allow|disallow)\s*:/i.test(l))
    .filter((l) => !/^disallow\s*:\s*\/\*?\s*$/i.test(l))
    .filter((l) => !/^disallow\s*:\s*$/i.test(l))
    .map((l) => l.replace(/^(allow|disallow)\s*:\s*/i, (_m, k: string) => `${k[0].toUpperCase()}${k.slice(1).toLowerCase()}: `));

  lines = lines.filter((_l, i) => !remove.has(i));

  // Content-Signal in the * group
  if (opts.contentSignal && Object.keys(opts.contentSignal).length) {
    const signal = `Content-Signal: ${Object.entries(opts.contentSignal)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`;
    lines = lines.filter((l) => !/^\s*content-signal\s*:/i.test(l));
    const starIdx = lines.findIndex((l) => /^\s*user-agent\s*:\s*\*\s*$/i.test(l));
    if (starIdx === -1) {
      lines.unshift('User-agent: *', signal, 'Allow: /', '');
    } else {
      let j = starIdx + 1;
      while (j < lines.length && /^\s*user-agent\s*:/i.test(lines[j])) j++;
      lines.splice(j, 0, signal);
    }
  }

  const allowed = [...decisions.entries()].filter(([, d]) => d === 'allow').map(([t]) => t);
  const blocked = [...decisions.entries()].filter(([, d]) => d === 'block').map(([t]) => t);
  const block: string[] = [AVC_BEGIN, `# Policy: ${policy}. Re-run \`avc fix\` to regenerate this block.`];
  if (allowed.length) {
    block.push(...allowed.map((t) => `User-agent: ${t}`));
    block.push(...(starRules.length ? starRules : ['Allow: /']));
    block.push('');
  }
  if (blocked.length) {
    block.push(...blocked.map((t) => `User-agent: ${t}`), 'Disallow: /', '');
  }
  block.push(AVC_END);

  // keep sitemap lines at the end
  const sitemapLines = lines.filter((l) => /^\s*sitemap\s*:/i.test(l)).map((l) => l.trim());
  lines = lines.filter((l) => !/^\s*sitemap\s*:/i.test(l));
  for (const s of opts.sitemaps ?? []) {
    if (!sitemapLines.some((l) => l.toLowerCase().endsWith(s.toLowerCase()))) sitemapLines.push(`Sitemap: ${s}`);
  }
  const head = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const parts = [head, block.join('\n'), sitemapLines.join('\n')].filter((p) => p.trim());
  return parts.join('\n\n') + '\n';
}

/** Tokens a robots.txt currently blocks from `/` (useful for summaries and tests). */
export function blockedAiTokens(robots: string): string[] {
  const lines = robots.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const g of parseGroups(lines)) {
    const rules = g.ruleLines.map((i) => lines[i].replace(/#.*$/, '').trim().toLowerCase());
    const full = rules.some((r) => /^disallow\s*:\s*\/\*?$/.test(r)) && !rules.some((r) => /^allow\s*:\s*\/\s*$/.test(r));
    if (full) for (const u of g.uaLines) if (isManagedToken(u.token)) out.push(u.token);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function compact<T extends Json>(o: T): T {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) delete o[k];
  }
  return o;
}

export function generateOrganizationJsonLd(data: SiteData, brand: BrandFacts = {}): Json {
  const origin = originOf(brand.url ?? data.site);
  const home = homeOf(data);
  return compact({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${origin}/#organization`,
    name: brand.name ?? inferBrandName(data),
    url: `${origin}/`,
    logo: brand.logo,
    description: brand.description ?? home?.metaDescription ?? undefined,
    email: brand.email,
    telephone: brand.telephone,
    address: brand.address ? { '@type': 'PostalAddress', ...brand.address } : undefined,
    sameAs: brand.sameAs?.filter((u) => /^https?:\/\//.test(u)),
  });
}

export function generateWebSiteJsonLd(data: SiteData, brand: BrandFacts = {}): Json {
  const origin = originOf(brand.url ?? data.site);
  return compact({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${origin}/#website`,
    name: brand.name ?? inferBrandName(data),
    url: `${origin}/`,
    publisher: { '@id': `${origin}/#organization` },
  });
}

/** Organization + WebSite in one @graph — the usual site-wide block. */
export function generateSiteGraphJsonLd(data: SiteData, brand: BrandFacts = {}): Json {
  const org = generateOrganizationJsonLd(data, brand);
  const site = generateWebSiteJsonLd(data, brand);
  delete org['@context'];
  delete site['@context'];
  return { '@context': 'https://schema.org', '@graph': [org, site] };
}

export function generateLocalBusinessJsonLd(data: SiteData, brand: BrandFacts = {}): Json {
  const org = generateOrganizationJsonLd(data, brand);
  const origin = originOf(brand.url ?? data.site);
  return compact({
    ...org,
    '@type': brand.businessType ?? 'LocalBusiness',
    '@id': `${origin}/#localbusiness`,
    image: brand.logo,
    address: brand.address
      ? { '@type': 'PostalAddress', ...brand.address }
      : {
          '@type': 'PostalAddress',
          streetAddress: 'TODO street',
          addressLocality: brand.location ?? 'TODO town',
          postalCode: 'TODO',
          addressCountry: 'TODO (ISO code, e.g. GB)',
        },
    telephone: brand.telephone ?? 'TODO +44…',
    openingHours: brand.openingHours,
    parentOrganization: { '@id': `${origin}/#organization` },
  });
}

export interface ArticleInput {
  url: string;
  title: string | null;
  h1?: string | null;
  metaDescription?: string | null;
  datePublished?: string;
  dateModified?: string;
  author?: string;
  image?: string;
}

export function generateArticleJsonLd(page: ArticleInput, brand: BrandFacts = {}, site?: string): Json {
  const origin = originOf(site ?? brand.url ?? page.url);
  const name = brand.name ?? hostOf(origin);
  return compact({
    '@context': 'https://schema.org',
    '@type': 'Article',
    '@id': `${page.url}#article`,
    mainEntityOfPage: page.url,
    headline: truncateWords(page.h1 ?? cleanTitle(page.title, name) ?? page.title ?? '', 110),
    description: page.metaDescription ?? undefined,
    image: page.image,
    datePublished: page.datePublished ?? 'TODO YYYY-MM-DD',
    dateModified: page.dateModified ?? page.datePublished ?? 'TODO YYYY-MM-DD',
    author: page.author
      ? { '@type': 'Person', name: page.author }
      : { '@type': 'Person', name: 'TODO author name', url: 'TODO author page' },
    publisher: { '@id': `${origin}/#organization` },
  });
}

export interface QaPair {
  question: string;
  answer: string;
}

const Q_SELECTOR = 'h2, h3, h4, h5, dt, summary';

/** Question/answer pairs from HTML: headings, <dt> and <summary> ending in "?". */
export function extractFaqs(html: string, max = 30): QaPair[] {
  const { document } = parseHTML(html.includes('<html') ? html : `<html><body>${html}</body></html>`);
  const out: QaPair[] = [];
  const nodes = Array.from(document.querySelectorAll(Q_SELECTOR)) as Element[];
  for (const node of nodes) {
    const q = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!q.endsWith('?') || q.length < 8 || q.length > 250) continue;
    let answer = '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'summary') {
      const details = node.parentElement;
      answer = Array.from(details?.childNodes ?? [])
        .filter((n) => n !== node)
        .map((n) => (n as Element).textContent ?? '')
        .join(' ');
    } else if (tag === 'dt') {
      let sib = node.nextElementSibling;
      while (sib && sib.tagName.toLowerCase() === 'dd') {
        answer += ' ' + (sib.textContent ?? '');
        sib = sib.nextElementSibling;
      }
    } else {
      const level = Number(tag.slice(1));
      let sib = node.nextElementSibling;
      while (sib) {
        const t = sib.tagName.toLowerCase();
        if (/^h[1-6]$/.test(t) && Number(t.slice(1)) <= level) break;
        if (sib.querySelector?.(Q_SELECTOR) && /\?\s*$/.test(sib.querySelector(Q_SELECTOR)?.textContent ?? '')) break;
        answer += ' ' + (sib.textContent ?? '');
        sib = sib.nextElementSibling;
      }
      // heading wrapped in its own container: try the container's next sibling
      if (!answer.trim() && node.parentElement && node.parentElement.children.length === 1) {
        answer = node.parentElement.nextElementSibling?.textContent ?? '';
      }
    }
    answer = answer.replace(/\s+/g, ' ').trim();
    if (answer.length < 20) continue;
    out.push({ question: q, answer: answer.length > 2000 ? truncateWords(answer, 2000) : answer });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * FAQPage JSON-LD for a page. Pass `html` (raw or rendered) to extract Q&A, or `qa` pairs.
 * Returns null when the page has no visible questions — FAQ markup must match visible content.
 */
export function generateFaqJsonLd(page: { url: string; html?: string; qa?: QaPair[] }): Json | null {
  const qa = page.qa ?? (page.html ? extractFaqs(page.html) : []);
  if (!qa.length) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    '@id': `${page.url}#faq`,
    mainEntity: qa.map((p) => ({
      '@type': 'Question',
      name: p.question,
      acceptedAnswer: { '@type': 'Answer', text: p.answer },
    })),
  };
}

/** BreadcrumbList from the URL path; names come from crawled titles/H1s when known. */
export function generateBreadcrumbJsonLd(url: string, pages: PageSummary[] = [], brand?: string): Json {
  const u = new URL(url);
  const byPath = new Map<string, PageSummary>();
  for (const p of pages) {
    try {
      byPath.set(new URL(p.finalUrl || p.url).pathname.replace(/\/+$/, '') || '/', p);
    } catch {
      /* ignore */
    }
  }
  const segs = u.pathname.split('/').filter(Boolean);
  const name = brand ?? inferBrandName({ site: u.origin, pages });
  const items: Json[] = [{ '@type': 'ListItem', position: 1, name: 'Home', item: `${u.origin}/` }];
  let path = '';
  segs.forEach((seg, i) => {
    path += '/' + seg;
    const p = byPath.get(path);
    const label = (p && (p.h1 ?? cleanTitle(p.title, name))) || humanise(seg);
    items.push({
      '@type': 'ListItem',
      position: i + 2,
      name: truncateWords(label, 80),
      item: `${u.origin}${path}${u.pathname.endsWith('/') && i === segs.length - 1 ? '/' : ''}`,
    });
  });
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: items };
}

// ---------------------------------------------------------------------------
// Agentic artefacts
// ---------------------------------------------------------------------------

/**
 * An A2A agent card (/.well-known/agent-card.json). Only publish it if you run an A2A agent:
 * `endpoint` must be its real URL. Skills default to TODO placeholders built from services.
 */
export function generateAgentCard(
  brand: BrandFacts & { name: string; url: string },
  opts: { endpoint?: string; skills?: { id: string; name: string; description: string }[]; version?: string } = {},
): Json {
  const origin = originOf(brand.url);
  const skills =
    opts.skills ??
    (brand.services?.length
      ? brand.services.slice(0, 8).map((s) => ({
          id: s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          name: s,
          description: `Answer questions about ${brand.name}'s ${s} service and start an enquiry.`,
        }))
      : [
          {
            id: 'enquiry',
            name: 'Enquiries',
            description: `Answer questions about ${brand.name} and take an enquiry.`,
          },
        ]);
  return {
    protocolVersion: '0.3.0',
    name: `${brand.name} agent`,
    description: brand.description ?? `Agent for ${brand.name}.`,
    url: opts.endpoint ?? `${origin}/a2a`,
    preferredTransport: 'JSONRPC',
    version: opts.version ?? '1.0.0',
    provider: { organization: brand.name, url: origin },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: skills.map((s) => ({ ...s, tags: [], examples: [] })),
  };
}

/** An MCP server card describing a remote MCP server, served from /.well-known/mcp/server-card.json. */
export function generateMcpServerCard(
  brand: BrandFacts & { name: string; url: string },
  opts: { endpoint?: string; tools?: { name: string; description: string }[]; auth?: 'none' | 'oauth2' } = {},
): Json {
  const origin = originOf(brand.url);
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    name: `${hostOf(origin)}/mcp`,
    title: `${brand.name} MCP server`,
    description: brand.description ?? `Tools for working with ${brand.name}.`,
    version: '1.0.0',
    websiteUrl: origin,
    remotes: [{ type: 'streamable-http', url: opts.endpoint ?? `${origin}/mcp` }],
    authentication: opts.auth === 'oauth2' ? { type: 'oauth2', metadata: `${origin}/.well-known/oauth-protected-resource` } : { type: 'none' },
    tools: opts.tools ?? [],
  };
}

/** OAuth 2.0 Protected Resource Metadata (RFC 9728) for an API or MCP endpoint. */
export function generateProtectedResourceMetadata(origin: string, authServer: string, resourcePath = '/mcp'): Json {
  return {
    resource: `${originOf(origin)}${resourcePath}`,
    authorization_servers: [authServer],
    bearer_methods_supported: ['header'],
    scopes_supported: [],
  };
}

// ---------------------------------------------------------------------------
// Title and meta description suggestions
// ---------------------------------------------------------------------------

export interface MetaPageInput {
  url: string;
  title: string | null;
  metaDescription: string | null;
  h1?: string | null;
  /** First ~300 characters after the H1 (PageData.lead) or any main text. */
  lead?: string;
  text?: string;
}

export interface MetaSuggestion {
  url: string;
  title: { current: string | null; suggested: string; reason: string } | null;
  description: { current: string | null; suggested: string | null; reason: string } | null;
  source: 'rules' | 'model';
}

export const TITLE_MAX = 60;
export const DESC_MIN = 70;
export const DESC_MAX = 155;

function titleProblem(t: string | null, brand: string): string | null {
  if (!t || !t.trim()) return 'missing';
  if (t.length > TITLE_MAX) return `${t.length} characters; search results cut titles at about ${TITLE_MAX}`;
  if (t.trim().length < 15) return 'too short to say what the page is about';
  if (t.trim().toLowerCase() === brand.toLowerCase()) return 'only the brand name';
  return null;
}

function descProblem(d: string | null): string | null {
  if (!d || !d.trim()) return 'missing';
  if (d.length > 160) return `${d.length} characters; usually cut at about 155`;
  if (d.length < DESC_MIN) return `${d.length} characters; too short to summarise the page`;
  return null;
}

/** Rule-based suggestion. Proposes a value only where the current one has a problem (or `force`). */
export function suggestMetaRules(page: MetaPageInput, opts: { brand?: string; force?: boolean } = {}): MetaSuggestion {
  const brand = opts.brand ?? hostOf(page.url);
  const out: MetaSuggestion = { url: page.url, title: null, description: null, source: 'rules' };
  const tp = titleProblem(page.title, brand);
  if (tp || opts.force) {
    const base =
      page.h1?.trim() ||
      cleanTitle(page.title, brand) ||
      humanise(new URL(page.url).pathname.split('/').filter(Boolean).pop() ?? brand);
    const core = truncateWords(base, TITLE_MAX);
    const withBrand = `${core} – ${brand}`;
    const suggested =
      core.toLowerCase().includes(brand.toLowerCase()) || withBrand.length > TITLE_MAX ? core : withBrand;
    if (suggested !== page.title) out.title = { current: page.title, suggested, reason: tp ?? 'requested' };
  }
  const dp = descProblem(page.metaDescription);
  if (dp || opts.force) {
    const source = (page.lead || page.text || '').replace(/\s+/g, ' ').trim();
    let suggested: string | null = null;
    if (source.length >= 40) {
      const sentences = source.match(/[^.!?]+[.!?]+/g) ?? [source];
      let acc = '';
      for (const s of sentences) {
        if ((acc + s).trim().length > DESC_MAX) break;
        acc += s;
      }
      suggested = (acc.trim() || truncateWords(source, DESC_MAX)).trim();
      if (suggested.length < 50) suggested = truncateWords(source, DESC_MAX);
    } else if (page.metaDescription && page.metaDescription.length > 160) {
      suggested = truncateWords(page.metaDescription, DESC_MAX);
    }
    out.description = {
      current: page.metaDescription,
      suggested,
      reason: dp ?? 'requested',
    };
    if (!suggested) out.description.reason += '; no page text to summarise — write it by hand';
  }
  return out;
}

/** A configured model for writing suggestions, or null (mock mode or no key). */
export async function writerModel(config?: Pick<AvcConfig, 'ai'>): Promise<unknown | null> {
  const ai = config?.ai;
  if (!ai || ai.mock) return null;
  const id = ai.models?.writer;
  try {
    if (ai.gatewayKey) {
      const { createGateway } = await import('ai');
      return createGateway({ apiKey: ai.gatewayKey })(id ?? 'anthropic/claude-haiku-4.5');
    }
    if (ai.anthropicKey) {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({ apiKey: ai.anthropicKey })(id ?? 'claude-haiku-4-5');
    }
    if (ai.openaiKey) {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({ apiKey: ai.openaiKey })(id ?? 'gpt-4.1-mini');
    }
    if (ai.googleKey) {
      const { createGoogle } = await import('@ai-sdk/google');
      return createGoogle({ apiKey: ai.googleKey })(id ?? 'gemini-2.5-flash');
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Title + meta description suggestions for one page. Rule-based by default; when a model key is
 * configured (and not mock), asks the model and keeps its answer only if it fits the limits.
 */
export async function generateMetaSuggestions(
  page: MetaPageInput,
  opts: { brand?: string; config?: Pick<AvcConfig, 'ai'>; model?: unknown; force?: boolean } = {},
): Promise<MetaSuggestion> {
  const rules = suggestMetaRules(page, opts);
  if (!rules.title && !rules.description) return rules;
  const model = opts.model ?? (await writerModel(opts.config));
  if (!model) return rules;
  const text = (page.lead || page.text || '').slice(0, 3000);
  if (text.length < 40 && !page.h1) return rules;
  try {
    const { generateText } = await import('ai');
    const res = await generateText({
      model: model as Parameters<typeof generateText>[0]['model'],
      system:
        'You write page titles and meta descriptions. Plain, specific, British English, no hype, no invented facts or numbers. Reply with JSON only: {"title": string, "description": string}.',
      prompt: `Brand: ${opts.brand ?? hostOf(page.url)}
URL: ${page.url}
Current title: ${page.title ?? '(none)'}
Current description: ${page.metaDescription ?? '(none)'}
H1: ${page.h1 ?? '(none)'}
Page text:
${text}

Title: at most ${TITLE_MAX} characters, says what the page is, ends with " – ${opts.brand ?? hostOf(page.url)}" if it fits.
Description: ${DESC_MIN}-${DESC_MAX} characters, answers what the visitor gets, uses only facts from the page text.`,
      maxRetries: 1,
    });
    const m = /\{[\s\S]*\}/.exec(res.text);
    if (!m) return rules;
    const parsed = JSON.parse(m[0]) as { title?: string; description?: string };
    const out: MetaSuggestion = { ...rules, source: 'model' };
    if (rules.title && parsed.title && parsed.title.length <= TITLE_MAX && parsed.title.length >= 10)
      out.title = { ...rules.title, suggested: parsed.title.trim() };
    if (
      rules.description &&
      parsed.description &&
      parsed.description.length >= 50 &&
      parsed.description.length <= 165
    )
      out.description = { ...rules.description, suggested: parsed.description.trim() };
    return out;
  } catch {
    return rules;
  }
}

/** Convenience: site data from an AuditResult. */
export function siteData(result: AuditResult): SiteData {
  return { site: result.site, pages: result.pages, robots: result.robots, sitemaps: result.sitemaps };
}
