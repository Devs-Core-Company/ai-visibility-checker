/**
 * Test factories for PageData and SiteContext. Build a "good" page by default
 * and override only what a test cares about.
 */
import type {
  FetchResult,
  Fetcher,
  LinkRef,
  PageData,
  SiteContext,
  SitemapInfo,
} from '../../src/core/types.js';
import { buildRobots } from '../../src/crawl/robots.js';
import { normaliseUrl } from '../../src/core/url.js';

export const ORIGIN = 'https://example.com';

/** Simple HTML document matching the default page fields. */
export function htmlDoc(opts: { head?: string; body?: string; lang?: string } = {}): string {
  return `<!doctype html><html lang="${opts.lang ?? 'en-GB'}"><head><meta charset="utf-8"><title>Example page</title>${opts.head ?? ''}</head><body><main>${opts.body ?? '<h1>Example page</h1><p>Some text.</p>'}</main></body></html>`;
}

const LOREM_FREE_TEXT =
  'Our team builds fast websites for small businesses in London. We plan, design and launch each site, then look after it every month. ';

export function link(href: string, overrides: Partial<LinkRef> = {}): LinkRef {
  const abs = new URL(href, ORIGIN).toString();
  return {
    href: abs,
    text: 'Our services',
    rel: [],
    internal: new URL(abs).host === new URL(ORIGIN).host,
    region: 'main',
    ...overrides,
  };
}

export function makePage(overrides: Partial<PageData> = {}): PageData {
  const url = overrides.url ?? `${ORIGIN}/services/web-design/`;
  const text = overrides.text ?? LOREM_FREE_TEXT.repeat(30);
  const wordCount = overrides.wordCount ?? text.split(/\s+/).filter(Boolean).length;
  const base: PageData = {
    url,
    finalUrl: url,
    depth: 1,
    status: 200,
    redirects: [],
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-encoding': 'br',
      'cache-control': 'max-age=300',
      'strict-transport-security': 'max-age=31536000',
    },
    contentType: 'text/html; charset=utf-8',
    isHtml: true,
    bytes: 30_000,
    ttfbMs: 120,
    totalMs: 300,
    discoveredFrom: [`${ORIGIN}/`],
    inSitemap: true,
    blockedByRobots: false,
    html: htmlDoc(),
    lang: 'en-GB',
    title: 'Web design for small businesses in London | Example',
    titleCount: 1,
    metaDescription:
      'We design, build and look after fast websites for small businesses in London. Fixed prices, monthly care plans and clear timelines.',
    metaDescriptionCount: 1,
    metaRobots: null,
    botMeta: {},
    xRobotsTag: null,
    canonical: url,
    canonicalCount: 1,
    canonicalHeader: null,
    viewport: 'width=device-width, initial-scale=1',
    charset: 'utf-8',
    og: { 'og:title': 'Web design', 'og:description': 'Websites', 'og:image': `${ORIGIN}/og.jpg` },
    twitter: { 'twitter:card': 'summary_large_image' },
    headings: [
      { level: 1, text: 'Web design for small businesses' },
      { level: 2, text: 'How we work' },
      { level: 2, text: 'Pricing' },
    ],
    links: [link('/'), link('/contact/', { text: 'Contact us' })],
    images: [],
    scripts: [],
    stylesheets: [],
    structuredData: [],
    hreflang: [],
    pagination: { next: null, prev: null },
    favicon: `${ORIGIN}/favicon.ico`,
    text,
    wordCount,
    mainText: text,
    lead: text.slice(0, 300),
    contentHash: `hash-${url}`,
    simhash: 'ffffffffffffffff',
    forms: [],
    iframes: [],
    mixedContent: [],
    inlineStyleBytes: 0,
    inlineScriptBytes: 0,
    generator: null,
  };
  return { ...base, ...overrides, wordCount };
}

export function makeFetcher(responses: Record<string, Partial<FetchResult>> = {}): Fetcher {
  return {
    async fetch(url) {
      const r = responses[url];
      return {
        url,
        finalUrl: r?.finalUrl ?? url,
        status: r?.status ?? 404,
        ok: (r?.status ?? 404) < 400,
        headers: r?.headers ?? {},
        redirects: r?.redirects ?? [],
        body: r?.body ?? '',
        bytes: (r?.body ?? '').length,
        truncated: false,
        contentType: r?.contentType ?? 'text/html',
        ttfbMs: 50,
        totalMs: 60,
      };
    },
  };
}

export interface SiteOptions {
  robots?: string;
  robotsStatus?: number;
  sitemaps?: SitemapInfo[];
  fetch?: Record<string, Partial<FetchResult>>;
  external?: SiteContext['external'];
  extra?: Record<string, unknown>;
}

/** Build a SiteContext; inlinks are derived from the pages' internal links. */
export function makeSite(pages: PageData[], opts: SiteOptions = {}): SiteContext {
  const map = new Map<string, PageData>();
  for (const p of pages) map.set(normaliseUrl(p.url), p);
  const inlinks = new Map<string, Set<string>>();
  for (const p of pages)
    for (const l of p.links) {
      if (!l.internal || l.href === p.url) continue;
      const k = normaliseUrl(l.href);
      (inlinks.get(k) ?? inlinks.set(k, new Set()).get(k)!).add(p.url);
    }
  const status = opts.robotsStatus ?? (opts.robots != null ? 200 : 404);
  const robots = buildRobots(`${ORIGIN}/robots.txt`, opts.robots ?? '', {
    status,
    found: status === 200,
  });
  const site: SiteContext = {
    startUrl: `${ORIGIN}/`,
    origin: ORIGIN,
    host: new URL(ORIGIN).host,
    pages: map,
    inlinks,
    robots,
    sitemaps: opts.sitemaps ?? [],
    stack: { id: 'unknown', confidence: 0, signals: [] },
    probes: new Map(),
    botFetches: [],
    browserFetch: null,
    external: opts.external ?? {},
    fetcher: makeFetcher(opts.fetch),
    options: {
      startUrl: `${ORIGIN}/`,
      maxPages: 500,
      maxDepth: 10,
      concurrency: 4,
      delayMs: 0,
      userAgent: 'test',
      respectRobots: true,
      render: false,
      renderLimit: 0,
      useSitemaps: true,
      checkExternalLinks: false,
      checkImages: false,
      timeoutMs: 1000,
      maxBytes: 1_000_000,
    },
    stats: {
      startedAt: '',
      finishedAt: '',
      pagesCrawled: pages.length,
      pagesQueuedNotCrawled: 0,
      maxPages: 500,
      maxDepth: 10,
      rendered: 0,
      errors: 0,
      durationMs: 0,
    },
  };
  return Object.assign(site, opts.extra ?? {});
}

export function makeSitemap(
  urls: (string | { loc: string; lastmod?: string })[],
  overrides: Partial<SitemapInfo> = {},
): SitemapInfo {
  return {
    url: `${ORIGIN}/sitemap.xml`,
    status: 200,
    found: true,
    isIndex: false,
    urls: urls.map((u) => (typeof u === 'string' ? { loc: u } : u)),
    children: [],
    errors: [],
    bytes: 1000,
    gzip: false,
    source: 'robots',
    ...overrides,
  };
}

/** A home page at depth 0 linking to the given paths. */
export function makeHome(paths: string[] = [], overrides: Partial<PageData> = {}): PageData {
  return makePage({
    url: `${ORIGIN}/`,
    depth: 0,
    discoveredFrom: [],
    title: 'Example: web design and care plans for small businesses',
    links: paths.map((p) => link(p, { text: `Page ${p}` })),
    ...overrides,
  });
}
