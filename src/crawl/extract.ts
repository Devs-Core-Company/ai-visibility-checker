/**
 * Turns one fetched response into a PageData record. Pure: no network.
 * HTML is parsed with linkedom; the main article with @mozilla/readability.
 */
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import type {
  FetchResult,
  HeadingRef,
  HreflangRef,
  ImageRef,
  LinkRef,
  PageData,
  StructuredDataItem,
} from '../core/types.js';
import { isHtmlContentType, normaliseUrl, resolveUrl, sameSite } from '../core/url.js';
import { countWords, normaliseForHash, oneLine, sha1, simhash, visibleText } from './text.js';

/** Raw HTML kept on PageData is cut here, to keep memory in check on big crawls. */
export const MAX_STORED_HTML = 2 * 1024 * 1024;
/** Readability is skipped above this size: it is slow on huge DOMs. */
const MAX_READABILITY_HTML = 1.5 * 1024 * 1024;

/** Meta names that address one crawler rather than all of them. */
const BOT_META_NAMES = new Set([
  'googlebot',
  'googlebot-news',
  'googlebot-image',
  'googlebot-video',
  'google-extended',
  'google',
  'bingbot',
  'msnbot',
  'adsbot-google',
  'gptbot',
  'chatgpt-user',
  'oai-searchbot',
  'claudebot',
  'claude-searchbot',
  'claude-user',
  'claude-web',
  'anthropic-ai',
  'perplexitybot',
  'perplexity-user',
  'ccbot',
  'applebot',
  'applebot-extended',
  'amazonbot',
  'bytespider',
  'meta-externalagent',
  'facebookbot',
  'duckduckbot',
  'yandex',
  'yandexbot',
  'baiduspider',
  'slurp',
  'cohere-ai',
  'diffbot',
  'mistralai-user',
  'youbot',
]);

type El = Element;

export interface ExtractContext {
  origin: string;
  depth: number;
  /** The URL as discovered (before redirects). Defaults to fetch.url. */
  url?: string;
}

/** An empty PageData shell for a fetch result (non-HTML, errors). */
export function basePage(fetch: FetchResult, ctx: ExtractContext): PageData {
  return {
    url: normaliseUrl(ctx.url ?? fetch.url),
    finalUrl: fetch.finalUrl,
    depth: ctx.depth,
    status: fetch.status,
    redirects: fetch.redirects,
    headers: fetch.headers,
    contentType: fetch.contentType,
    isHtml: false,
    bytes: fetch.bytes,
    ttfbMs: fetch.ttfbMs,
    totalMs: fetch.totalMs,
    ...(fetch.error ? { error: fetch.error } : {}),
    discoveredFrom: [],
    inSitemap: false,
    blockedByRobots: false,
    html: '',
    lang: null,
    title: null,
    titleCount: 0,
    metaDescription: null,
    metaDescriptionCount: 0,
    metaRobots: null,
    botMeta: {},
    xRobotsTag: fetch.headers['x-robots-tag'] ?? null,
    canonical: null,
    canonicalCount: 0,
    canonicalHeader:
      linkHeader(fetch.headers.link, fetch.finalUrl).find((l) => l.rel.includes('canonical'))
        ?.href ?? null,
    viewport: null,
    charset: null,
    og: {},
    twitter: {},
    headings: [],
    links: [],
    images: [],
    scripts: [],
    stylesheets: [],
    structuredData: [],
    hreflang: headerHreflang(fetch.headers.link, fetch.finalUrl),
    pagination: { next: null, prev: null },
    favicon: null,
    text: '',
    wordCount: 0,
    mainText: null,
    lead: '',
    contentHash: '',
    simhash: '',
    forms: [],
    iframes: [],
    mixedContent: [],
    inlineStyleBytes: 0,
    inlineScriptBytes: 0,
    generator: fetch.headers['x-generator'] ?? null,
  };
}

/** Whether a response is an HTML document. */
export function isHtmlResponse(fetch: FetchResult): boolean {
  if (isHtmlContentType(fetch.contentType)) return true;
  if (!fetch.contentType && /^\s*(<!doctype html|<html)/i.test(fetch.body.slice(0, 512)))
    return true;
  return false;
}

export function extractPage(fetch: FetchResult, ctx: ExtractContext): PageData {
  const page = basePage(fetch, ctx);
  if (!isHtmlResponse(fetch) || !fetch.body) {
    page.isHtml = isHtmlResponse(fetch);
    return page;
  }
  page.isHtml = true;
  const html = fetch.body;
  page.html = html.length > MAX_STORED_HTML ? html.slice(0, MAX_STORED_HTML) : html;
  const base = fetch.finalUrl || fetch.url;

  let document: Document;
  // linkedom needs an <html> root to build head/body; fragments get one.
  const source = /<html[\s>]/i.test(html.slice(0, 4096))
    ? html
    : `<!doctype html><html><head></head><body>${html}</body></html>`;
  try {
    ({ document } = parseHTML(source) as unknown as { document: Document });
  } catch (e) {
    page.error = `HTML could not be parsed: ${(e as Error).message}`;
    return page;
  }
  try {
    fillFromDocument(page, document, source, base, ctx.origin, fetch);
  } catch (e) {
    page.error = page.error ?? `Extraction failed: ${(e as Error).message}`;
  }
  return page;
}

function fillFromDocument(
  page: PageData,
  document: Document,
  html: string,
  pageBase: string,
  origin: string,
  fetch: FetchResult,
): void {
  // <base href> changes how relative links resolve.
  const baseEl = document.querySelector('base[href]');
  const base = (baseEl && resolveUrl(baseEl.getAttribute('href'), pageBase)) || pageBase;
  const abs = (v: string | null | undefined) => resolveUrl(v, base);
  const isHttps = pageBase.startsWith('https:');

  const htmlEl = document.documentElement;
  page.lang =
    htmlEl?.getAttribute('lang')?.trim() || htmlEl?.getAttribute('xml:lang')?.trim() || null;

  // ---- titles ----
  const titles = all(document, 'title').filter((t) => !t.closest('svg'));
  page.titleCount = titles.length;
  page.title = titles.length ? oneLine(titles[0]!.textContent) : null;

  // ---- meta ----
  const robotsParts: string[] = [];
  const descriptions: string[] = [];
  for (const m of all(document, 'meta')) {
    const name = (m.getAttribute('name') ?? '').trim().toLowerCase();
    const property = (m.getAttribute('property') ?? '').trim().toLowerCase();
    const content = m.getAttribute('content');
    const httpEquiv = (m.getAttribute('http-equiv') ?? '').toLowerCase();
    if (m.hasAttribute('charset') && !page.charset)
      page.charset = m.getAttribute('charset')!.trim().toLowerCase();
    if (httpEquiv === 'content-type' && !page.charset && content) {
      const cs = /charset\s*=\s*([\w.:-]+)/i.exec(content)?.[1];
      if (cs) page.charset = cs.toLowerCase();
    }
    if (content == null) continue;
    if (name === 'description') descriptions.push(content);
    else if (name === 'robots') robotsParts.push(content.trim());
    else if (name === 'viewport' && page.viewport === null) page.viewport = content.trim();
    else if (name === 'generator' && content.trim()) page.generator = content.trim();
    else if (BOT_META_NAMES.has(name) || (name.endsWith('bot') && name.length < 40)) {
      page.botMeta[name] = page.botMeta[name]
        ? `${page.botMeta[name]}, ${content.trim()}`
        : content.trim();
    }
    if (property.startsWith('og:')) page.og[property] ??= content.trim();
    else if (name.startsWith('og:')) page.og[name] ??= content.trim();
    if (name.startsWith('twitter:')) page.twitter[name] ??= content.trim();
    else if (property.startsWith('twitter:')) page.twitter[property] ??= content.trim();
  }
  page.metaDescriptionCount = descriptions.length;
  page.metaDescription = descriptions.length ? oneLine(descriptions[0]) : null;
  page.metaRobots = robotsParts.length ? robotsParts.join(', ') : null;
  if (!page.charset) {
    const cs = /charset\s*=\s*["']?([\w.:-]+)/i.exec(fetch.contentType)?.[1];
    if (cs) page.charset = cs.toLowerCase();
  }

  // ---- <link> elements ----
  const canonicals: string[] = [];
  const hreflang: HreflangRef[] = [...page.hreflang];
  for (const l of all(document, 'link')) {
    const rel = relTokens(l.getAttribute('rel'));
    const hrefRaw = l.getAttribute('href');
    const href = abs(hrefRaw);
    if (rel.includes('canonical')) canonicals.push(href ?? (hrefRaw ?? '').trim());
    if (rel.includes('alternate') && l.hasAttribute('hreflang') && href)
      hreflang.push({ lang: l.getAttribute('hreflang')!.trim(), href, source: 'html' });
    if (rel.includes('next') && href && !page.pagination.next) page.pagination.next = href;
    if ((rel.includes('prev') || rel.includes('previous')) && href && !page.pagination.prev)
      page.pagination.prev = href;
    if (rel.includes('stylesheet') && href)
      page.stylesheets.push({ href, media: l.getAttribute('media') });
    if (rel.includes('icon') && href && !page.favicon) page.favicon = href;
    if (
      isHttps &&
      href?.startsWith('http:') &&
      (rel.includes('stylesheet') ||
        rel.includes('icon') ||
        rel.includes('preload') ||
        rel.includes('manifest'))
    )
      page.mixedContent.push(href);
  }
  if (!page.favicon) {
    const apple = all(document, 'link').find((l) =>
      relTokens(l.getAttribute('rel')).some((r) => r.startsWith('apple-touch-icon')),
    );
    page.favicon = apple ? abs(apple.getAttribute('href')) : null;
  }
  page.canonicalCount = canonicals.length;
  page.canonical = canonicals[0] || null;
  page.hreflang = hreflang;

  // ---- headings ----
  page.headings = headingsOf(document);

  // ---- links ----
  const links: LinkRef[] = [];
  for (const a of all(document, 'a[href], area[href]')) {
    const href = abs(a.getAttribute('href'));
    if (!href) continue;
    let text = oneLine(a.textContent);
    if (!text) {
      const img = a.querySelector('img[alt]');
      text = oneLine(
        img?.getAttribute('alt') ?? a.getAttribute('aria-label') ?? a.getAttribute('title') ?? '',
      );
    }
    const link: LinkRef = {
      href,
      text: text.slice(0, 300),
      rel: relTokens(a.getAttribute('rel')),
      internal: sameSite(href, origin),
      region: regionOf(a),
    };
    const target = a.getAttribute('target');
    if (target) link.target = target;
    links.push(link);
  }
  page.links = links;

  // ---- images ----
  const images: ImageRef[] = [];
  for (const img of all(document, 'img')) {
    let srcRaw = img.getAttribute('src');
    if (!srcRaw || srcRaw.startsWith('data:'))
      srcRaw =
        img.getAttribute('data-src') ??
        img.getAttribute('data-lazy-src') ??
        img.getAttribute('data-original') ??
        srcRaw;
    const src = abs(srcRaw);
    if (!src) continue;
    const ref: ImageRef = {
      src,
      alt: img.hasAttribute('alt') ? (img.getAttribute('alt') ?? '') : null,
    };
    const w = intAttr(img.getAttribute('width'));
    const h = intAttr(img.getAttribute('height'));
    if (w !== undefined) ref.width = w;
    if (h !== undefined) ref.height = h;
    const loading = img.getAttribute('loading');
    if (loading) ref.loading = loading.toLowerCase();
    const srcset = img.getAttribute('srcset');
    if (srcset) ref.srcset = srcset;
    images.push(ref);
    if (isHttps && src.startsWith('http:')) page.mixedContent.push(src);
  }
  page.images = images;

  // ---- scripts ----
  let inlineScriptBytes = 0;
  const structured: StructuredDataItem[] = [];
  for (const s of all(document, 'script')) {
    const type = s.getAttribute('type');
    const src = abs(s.getAttribute('src'));
    const inline = !s.hasAttribute('src');
    const body = inline ? (s.textContent ?? '') : '';
    const bytes = Buffer.byteLength(body);
    const t = (type ?? '').toLowerCase().trim();
    if (t === 'application/ld+json') {
      structured.push(parseJsonLd(body));
    } else if (inline) inlineScriptBytes += bytes;
    page.scripts.push({
      src,
      inline,
      async: s.hasAttribute('async'),
      defer: s.hasAttribute('defer'),
      type,
      bytes,
    });
    if (isHttps && src?.startsWith('http:')) page.mixedContent.push(src);
  }
  page.inlineScriptBytes = inlineScriptBytes;
  structured.push(...microdata(document), ...rdfa(document));
  page.structuredData = structured;

  // ---- inline styles ----
  let styleBytes = 0;
  for (const st of all(document, 'style')) styleBytes += Buffer.byteLength(st.textContent ?? '');
  for (const el of all(document, '[style]'))
    styleBytes += Buffer.byteLength(el.getAttribute('style') ?? '');
  page.inlineStyleBytes = styleBytes;

  // ---- iframes + other mixed content ----
  for (const f of all(document, 'iframe')) {
    const src = abs(f.getAttribute('src'));
    if (src) {
      page.iframes.push(src);
      if (isHttps && src.startsWith('http:')) page.mixedContent.push(src);
    }
  }
  if (isHttps) {
    for (const el of all(
      document,
      'video[src], audio[src], source[src], embed[src], track[src], object[data], video[poster]',
    )) {
      for (const attr of ['src', 'data', 'poster']) {
        const v = abs(el.getAttribute(attr));
        if (v?.startsWith('http:')) page.mixedContent.push(v);
      }
    }
    for (const el of all(document, 'img[srcset], source[srcset]')) {
      for (const part of (el.getAttribute('srcset') ?? '').split(',')) {
        const u = abs(part.trim().split(/\s+/)[0]);
        if (u?.startsWith('http:')) page.mixedContent.push(u);
      }
    }
    page.mixedContent = [...new Set(page.mixedContent)];
  }

  // ---- forms ----
  for (const f of all(document, 'form')) {
    const fields = [...f.querySelectorAll('input, select, textarea')].filter((i) => {
      const t = (i.getAttribute('type') ?? '').toLowerCase();
      return !['hidden', 'submit', 'button', 'reset', 'image'].includes(t);
    });
    const hasLabels = fields.every((i) => fieldHasLabel(i, document));
    const form: PageData['forms'][number] = {
      action: abs(f.getAttribute('action')) ?? pageBase,
      method: (f.getAttribute('method') ?? 'get').toLowerCase(),
      inputs: fields.length,
      hasLabels,
    };
    const toolname = f.getAttribute('toolname');
    if (toolname) form.toolname = toolname;
    page.forms.push(form);
  }

  // ---- text ----
  const text = pageText(document);
  page.text = text;
  page.wordCount = countWords(text);

  // ---- Readability ----
  if (html.length <= MAX_READABILITY_HTML && page.wordCount > 0) {
    try {
      const { document: copy } = parseHTML(html) as unknown as { document: Document };
      const article = new Readability(copy, { charThreshold: 200 }).parse();
      if (article?.content) {
        const { document: art } = parseHTML(
          `<!doctype html><html><body>${article.content}</body></html>`,
        ) as unknown as {
          document: Document;
        };
        const t = visibleText(art.body as never);
        page.mainText = t || null;
      }
    } catch {
      page.mainText = null;
    }
  }

  page.lead = leadAfterH1(page);

  const norm = normaliseForHash(text);
  page.contentHash = norm ? sha1(norm) : '';
  page.simhash = simhash(text);
}

// ---------------------------------------------------------------------------

const CHROME_TAGS = new Set([
  'nav',
  'header',
  'footer',
  'aside',
  'role:navigation',
  'role:banner',
  'role:contentinfo',
  'role:complementary',
]);

/**
 * The page's visible main text: <main> when it holds at least 20 words, else
 * the body without nav/header/footer/aside, else the whole body. Used for
 * both raw and rendered HTML so the two word counts compare like for like.
 */
export function pageText(document: Document): string {
  const body = document.body ?? document.documentElement;
  const mainEl = document.querySelector('main, [role="main"]');
  const mainOnly = mainEl ? visibleText(mainEl as never) : '';
  if (countWords(mainOnly) >= 20) return mainOnly;
  const noChrome = visibleText(body as never, CHROME_TAGS);
  return countWords(noChrome) >= 20 ? noChrome : visibleText(body as never);
}

/** JSON-LD, microdata and RDFa found in a parsed document. */
export function structuredDataOf(document: Document): StructuredDataItem[] {
  const out: StructuredDataItem[] = [];
  for (const s of all(document, 'script')) {
    if ((s.getAttribute('type') ?? '').toLowerCase().trim() === 'application/ld+json')
      out.push(parseJsonLd(s.textContent ?? ''));
  }
  return [...out, ...microdata(document), ...rdfa(document)];
}

/** Headings in document order. */
export function headingsOf(document: Document): HeadingRef[] {
  return all(document, 'h1, h2, h3, h4, h5, h6').map((h) => ({
    level: Number(h.tagName.slice(1)) as HeadingRef['level'],
    text: oneLine(visibleText(h as never) || h.textContent),
  }));
}

function all(root: ParentNode, selector: string): El[] {
  try {
    return [...root.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

function relTokens(rel: string | null): string[] {
  return (rel ?? '').toLowerCase().split(/\s+/).filter(Boolean);
}

function intAttr(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

const REGION_BY_TAG: Record<string, LinkRef['region']> = {
  nav: 'nav',
  header: 'header',
  footer: 'footer',
  aside: 'aside',
  main: 'main',
  article: 'main',
};
const REGION_BY_ROLE: Record<string, LinkRef['region']> = {
  navigation: 'nav',
  banner: 'header',
  contentinfo: 'footer',
  complementary: 'aside',
  main: 'main',
};

function regionOf(el: El): LinkRef['region'] {
  let node: El | null = el.parentElement;
  while (node) {
    const role = node.getAttribute('role');
    if (role && REGION_BY_ROLE[role]) return REGION_BY_ROLE[role];
    const byTag = REGION_BY_TAG[node.tagName.toLowerCase()];
    if (byTag) return byTag;
    node = node.parentElement;
  }
  return 'other';
}

function fieldHasLabel(field: El, document: Document): boolean {
  if (
    field.getAttribute('aria-label')?.trim() ||
    field.getAttribute('aria-labelledby') ||
    field.getAttribute('title')
  )
    return true;
  if (field.closest('label')) return true;
  const id = field.getAttribute('id');
  if (id) {
    for (const l of all(document, 'label[for]')) if (l.getAttribute('for') === id) return true;
  }
  return false;
}

/** First ~300 chars of content after the first H1. */
function leadAfterH1(page: PageData): string {
  const source = page.text;
  const h1 = page.headings.find((h) => h.level === 1)?.text;
  let rest = source;
  if (h1) {
    const idx = source.indexOf(h1);
    if (idx >= 0) rest = source.slice(idx + h1.length);
  }
  rest = rest.replace(/\s+/g, ' ').trim();
  if (rest.length <= 300) return rest;
  const cut = rest.slice(0, 300);
  const space = cut.lastIndexOf(' ');
  return (space > 200 ? cut.slice(0, space) : cut).trim();
}

// ---- Structured data -------------------------------------------------------

export function parseJsonLd(body: string): StructuredDataItem {
  const raw = body.trim();
  try {
    const parsed = JSON.parse(raw);
    return { format: 'json-ld', types: jsonLdTypes(parsed), raw: parsed };
  } catch (e) {
    const error = (e as Error).message;
    // Many sites ship small mistakes; parse leniently so types are still known.
    const cleaned = raw
      .replace(/^\s*<!--/, '')
      .replace(/-->\s*$/, '')
      .replace(/^\s*\/\/<!\[CDATA\[|\/\/\]\]>\s*$/g, '')
      .replace(/,\s*([}\]])/g, '$1');
    try {
      const parsed = JSON.parse(cleaned);
      return { format: 'json-ld', types: jsonLdTypes(parsed), raw: parsed, error };
    } catch {
      return { format: 'json-ld', types: [], raw: null, error };
    }
  }
}

/** Every @type value, depth-first, including @graph members and nested entities. */
export function jsonLdTypes(data: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 12) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const t = obj['@type'];
    for (const v of Array.isArray(t) ? t : t ? [t] : []) {
      if (typeof v === 'string')
        out.push(v.replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/, ''));
    }
    for (const [k, v] of Object.entries(obj)) if (k !== '@context') visit(v, depth + 1);
  };
  visit(data, 0);
  return [...new Set(out)];
}

function microdata(document: Document): StructuredDataItem[] {
  const items: StructuredDataItem[] = [];
  for (const el of all(document, '[itemscope]')) {
    // Only top-level items; nested ones are part of their parent.
    if (el.hasAttribute('itemprop') && el.parentElement?.closest('[itemscope]')) continue;
    const types = typeNames(el.getAttribute('itemtype'));
    const nestedTypes: string[] = [];
    const props: Record<string, unknown> = {};
    for (const p of all(el, '[itemprop]')) {
      const name = p.getAttribute('itemprop')!;
      if (p.hasAttribute('itemscope')) {
        const nt = typeNames(p.getAttribute('itemtype'));
        nestedTypes.push(...nt);
        props[name] ??= { '@type': nt[0] ?? null };
        continue;
      }
      if (props[name] !== undefined) continue;
      props[name] = oneLine(
        p.getAttribute('content') ??
          p.getAttribute('href') ??
          p.getAttribute('src') ??
          p.getAttribute('datetime') ??
          p.textContent,
      ).slice(0, 500);
    }
    items.push({
      format: 'microdata',
      types: [...new Set([...types, ...nestedTypes])],
      raw: { '@type': types.length === 1 ? types[0] : types, ...props },
    });
  }
  return items;
}

function rdfa(document: Document): StructuredDataItem[] {
  const items: StructuredDataItem[] = [];
  for (const el of all(document, '[typeof]')) {
    if (el.parentElement?.closest('[typeof]')) continue;
    const types: string[] = [];
    const collect = (node: El) => {
      for (const t of (node.getAttribute('typeof') ?? '').split(/\s+/).filter(Boolean))
        types.push(t.replace(/^[\w-]+:/, '').replace(/^https?:\/\/schema\.org\//, ''));
    };
    collect(el);
    const props: Record<string, string> = {};
    for (const n of all(el, '[typeof]')) collect(n);
    for (const p of all(el, '[property]')) {
      const name = p.getAttribute('property')!.replace(/^[\w-]+:/, '');
      props[name] ??= oneLine(
        p.getAttribute('content') ?? p.getAttribute('href') ?? p.textContent,
      ).slice(0, 500);
    }
    items.push({
      format: 'rdfa',
      types: [...new Set(types)],
      raw: { '@type': types[0] ?? null, vocab: el.getAttribute('vocab'), ...props },
    });
  }
  return items;
}

function typeNames(itemtype: string | null): string[] {
  return (itemtype ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/\/$/, '').split(/[/#]/).pop() ?? t);
}

// ---- Link header -----------------------------------------------------------

/** Parse an HTTP Link header into { href, rel[], params }. */
export function linkHeader(
  value: string | undefined,
  base: string,
): { href: string; rel: string[]; params: Record<string, string> }[] {
  if (!value) return [];
  const out: { href: string; rel: string[]; params: Record<string, string> }[] = [];
  for (const m of value.matchAll(/<([^>]*)>\s*((?:;\s*[^;,]+=?(?:"[^"]*"|[^;,]*))*)/g)) {
    const href = resolveUrl(m[1], base);
    if (!href) continue;
    const params: Record<string, string> = {};
    for (const p of (m[2] ?? '').matchAll(/;\s*([\w*-]+)\s*(?:=\s*(?:"([^"]*)"|([^;,]*)))?/g)) {
      params[p[1]!.toLowerCase()] = (p[2] ?? p[3] ?? '').trim();
    }
    out.push({ href, rel: relTokens(params.rel ?? ''), params });
  }
  return out;
}

function headerHreflang(value: string | undefined, base: string): HreflangRef[] {
  return linkHeader(value, base)
    .filter((l) => l.rel.includes('alternate') && l.params.hreflang)
    .map((l) => ({ lang: l.params.hreflang!, href: l.href, source: 'header' as const }));
}
