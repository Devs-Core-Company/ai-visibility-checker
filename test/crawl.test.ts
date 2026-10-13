import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startFixtureServer, type FixtureServer } from './fixtures/serve.js';
import { createFetcher } from '../src/core/http.js';
import {
  extensionOf,
  isHttpUrl,
  normaliseUrl,
  pathOf,
  resolveUrl,
  sameSite,
} from '../src/core/url.js';
import { loadRobots, buildRobots } from '../src/crawl/robots.js';
import { loadSitemaps } from '../src/crawl/sitemaps.js';
import { extractPage } from '../src/crawl/extract.js';
import { detectStack } from '../src/crawl/stack.js';
import { hammingDistance, simhash } from '../src/crawl/text.js';
import {
  crawlSite,
  defaultCrawlOptions,
  externalLinkStatus,
  imageStatus,
} from '../src/crawl/index.js';
import type { FetchResult, SiteContext } from '../src/core/types.js';

let fx: FixtureServer;
const fetcher = () =>
  createFetcher({ userAgent: 'AVC-test/1.0', timeoutMs: 5000, maxBytes: 1024 * 1024 });

beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(async () => {
  await fx.close();
});

describe('url utils', () => {
  it('normalises', () => {
    expect(normaliseUrl('HTTPS://Example.COM:443/a%7eb?x=1#frag')).toBe(
      'https://example.com/a~b?x=1',
    );
    expect(normaliseUrl('http://example.com:80')).toBe('http://example.com/');
    expect(normaliseUrl('https://example.com/p?utm_source=x&id=2', { stripTracking: true })).toBe(
      'https://example.com/p?id=2',
    );
    expect(normaliseUrl('https://example.com/p?utm_source=x', { stripTracking: true })).toBe(
      'https://example.com/p',
    );
  });
  it('compares sites, resolves and inspects', () => {
    expect(sameSite('https://www.example.com/x', 'https://example.com')).toBe(true);
    expect(sameSite('http://example.com/x', 'https://example.com')).toBe(true);
    expect(sameSite('https://blog.example.com/x', 'https://example.com')).toBe(false);
    expect(resolveUrl('../a#b', 'https://e.com/x/y/z')).toBe('https://e.com/x/a');
    expect(resolveUrl('mailto:a@b.c', 'https://e.com')).toBeNull();
    expect(isHttpUrl('ftp://x')).toBe(false);
    expect(pathOf('https://e.com/a/b?q=1')).toBe('/a/b?q=1');
    expect(extensionOf('https://e.com/files/Guide.PDF?x=1')).toBe('pdf');
  });
});

describe('fetcher', () => {
  it('records each redirect hop', async () => {
    const r = await fetcher().fetch(`${fx.url}/old-pricing`);
    expect(r.status).toBe(200);
    expect(r.redirects.map((h) => h.status)).toEqual([301, 301]);
    expect(r.finalUrl).toBe(`${fx.url}/pricing`);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.ttfbMs).toBeGreaterThanOrEqual(0);
  });
  it('stops redirect loops and never throws', async () => {
    const r = await fetcher().fetch(`${fx.url}/loop-a`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/loop/i);
    const dead = await fetcher().fetch('http://127.0.0.1:1/');
    expect(dead.status).toBe(0);
    expect(dead.error).toBeTruthy();
    const bad = await fetcher().fetch('not a url');
    expect(bad.status).toBe(0);
  });
  it('can return the 3xx without following', async () => {
    const r = await fetcher().fetch(`${fx.url}/old-pricing`, { followRedirects: false });
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe('/pricing-2023');
  });
  it('times out', async () => {
    const r = await fetcher().fetch(`${fx.url}/slow`, { timeoutMs: 300 });
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/Timed out/);
  });
  it('truncates at maxBytes', async () => {
    const r = await fetcher().fetch(`${fx.url}/`, { maxBytes: 200 });
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(200);
  });
  it('decodes legacy charsets and sends auth only to its host', async () => {
    let seenAuth: string | undefined;
    const server = createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/html; charset=windows-1252' });
      res.end(Buffer.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const f = createFetcher({
      userAgent: 'x',
      timeoutMs: 3000,
      maxBytes: 1e6,
      auth: { user: 'a', pass: 'b' },
      authHost: '127.0.0.1',
    });
    const r = await f.fetch(`http://127.0.0.1:${port}/`);
    expect(r.body).toBe('<p>café</p>');
    expect(seenAuth).toBe(`Basic ${Buffer.from('a:b').toString('base64')}`);
    const g = createFetcher({
      userAgent: 'x',
      timeoutMs: 3000,
      maxBytes: 1e6,
      auth: { user: 'a', pass: 'b' },
      authHost: 'other.test',
    });
    await g.fetch(`http://127.0.0.1:${port}/`);
    expect(seenAuth).toBeUndefined();
    server.close();
  });
});

describe('robots', () => {
  it('parses groups, sitemaps and deciding lines', async () => {
    const robots = await loadRobots(fx.url, fetcher());
    expect(robots.found).toBe(true);
    expect(robots.sitemaps).toEqual([`${fx.url}/sitemap_index.xml`]);
    expect(robots.isAllowed(`${fx.url}/blog/x`, 'GPTBot')).toBe(false);
    expect(robots.isAllowed(`${fx.url}/blog/x`, 'Googlebot')).toBe(true);
    expect(robots.isAllowed(`${fx.url}/private/staff`, 'AVC')).toBe(false);
    expect(robots.isAllowed(`${fx.url}/`, 'CCBot')).toBe(false);
    expect(robots.decidingLine(`${fx.url}/blog/x`, 'GPTBot')).toEqual({
      line: 7,
      rule: 'Disallow: /blog/',
    });
  });
  it('treats 5xx as disallow-all and 404 as allow-all', () => {
    const down = buildRobots('https://e.com/robots.txt', '', {
      status: 503,
      found: false,
      unreachable: true,
    });
    expect(down.isAllowed('https://e.com/', 'Googlebot')).toBe(false);
    expect(down.decidingLine('https://e.com/', 'Googlebot')?.rule).toMatch(/503/);
    const none = buildRobots('https://e.com/robots.txt', '', { status: 404, found: false });
    expect(none.isAllowed('https://e.com/', 'GPTBot')).toBe(true);
  });
});

describe('sitemaps', () => {
  it('follows the index, gunzips and reads entries', async () => {
    const f = fetcher();
    const robots = await loadRobots(fx.url, f);
    const maps = await loadSitemaps(fx.url, robots, f);
    const index = maps.find((m) => m.url.endsWith('/sitemap_index.xml'))!;
    expect(index.isIndex).toBe(true);
    expect(index.source).toBe('robots');
    expect(index.children).toHaveLength(2);
    const pages = maps.find((m) => m.url.endsWith('/sitemap-pages.xml'))!;
    expect(pages.urls.length).toBe(8);
    expect(pages.urls[0]!.images).toBe(1);
    expect(pages.urls[0]!.hreflang?.[0]).toMatchObject({ lang: 'en-gb', source: 'sitemap' });
    expect(pages.errors.join(' ')).toMatch(/W3C date/);
    const blog = maps.find((m) => m.url.endsWith('.xml.gz'))!;
    expect(blog.gzip).toBe(true);
    expect(blog.urls.map((u) => u.loc)).toContain(`${fx.url}/blog/how-long-does-a-kitchen-take`);
    // /sitemap.xml is 404 but a sitemap was found elsewhere: not reported.
    expect(maps.some((m) => m.url.endsWith('/sitemap.xml'))).toBe(false);
  });
});

function fakeFetch(url: string, body: string, headers: Record<string, string> = {}): FetchResult {
  return {
    url,
    finalUrl: url,
    status: 200,
    ok: true,
    headers: { 'content-type': 'text/html', ...headers },
    redirects: [],
    body,
    bytes: body.length,
    truncated: false,
    contentType: 'text/html',
    ttfbMs: 1,
    totalMs: 2,
  };
}

describe('extractPage', () => {
  it('fills the HTML fields', async () => {
    const r = await fetcher().fetch(`${fx.url}/blog/how-long-does-a-kitchen-take`);
    const p = extractPage(r, { origin: fx.url, depth: 2 });
    expect(p.isHtml).toBe(true);
    expect(p.title).toBe('How long does a handmade kitchen take? | Northwind Joinery');
    expect(p.titleCount).toBe(1);
    expect(p.lang).toBe('en-GB');
    expect(p.canonical).toBe(`${fx.url}/blog/how-long-does-a-kitchen-take`);
    expect(p.charset).toBe('utf-8');
    expect(p.viewport).toContain('width=device-width');
    expect(p.generator).toBe('Hugo 0.128.0');
    expect(p.og['og:type']).toBe('article');
    const types = p.structuredData.flatMap((s) => s.types);
    expect(types).toEqual(
      expect.arrayContaining(['Article', 'Person', 'FAQPage', 'Question', 'Answer']),
    );
    const broken = p.structuredData.find((s) => s.error);
    expect(broken?.types).toEqual(['BreadcrumbList']); // lenient parse after a trailing comma
    expect(p.headings[0]).toEqual({ level: 1, text: 'How long does a handmade kitchen take?' });
    expect(p.lead.startsWith('Most handmade kitchens take eight to twelve weeks')).toBe(true);
    expect(p.wordCount).toBeGreaterThan(100);
    expect(p.mainText).toContain('eight to twelve weeks');
    expect(p.contentHash).toMatch(/^[0-9a-f]{40}$/);
    expect(p.simhash).toMatch(/^[0-9a-f]{16}$/);
    const nav = p.links.find((l) => l.text === 'About')!;
    expect(nav.region).toBe('nav');
    expect(nav.internal).toBe(true);
    const ext = p.links.find((l) => l.href.startsWith('https://www.gov.uk'))!;
    expect(ext.internal).toBe(false);
    expect(ext.region).toBe('main');
    const partner = p.links.find((l) => l.text === 'Our timber supplier')!;
    expect(partner.rel).toEqual(['nofollow', 'noopener']);
    expect(partner.region).toBe('footer');
    expect(partner.target).toBe('_blank');
    expect(p.images[0]).toMatchObject({
      src: `${fx.url}/images/logo.png`,
      alt: 'Northwind Joinery',
      width: 120,
    });
    expect(p.favicon).toBe(`${fx.url}/favicon.ico`);
    expect(p.stylesheets[0]!.href).toBe(`${fx.url}/assets/site.css`);
  });

  it('handles forms, microdata, bot meta, headers and mixed content', () => {
    const html = `<!doctype html><html><head><title>A</title><title>B</title>
      <meta name="robots" content="noindex"><meta name="GoogleBot" content="nosnippet"><meta name="gptbot" content="noindex">
      <link rel="canonical" href="/a"><link rel="canonical" href="/b">
      <link rel="alternate" hreflang="de" href="/de/"></head><body>
      <form action="/go" toolname="search_site"><input name="q"><input type="submit"></form>
      <div itemscope itemtype="https://schema.org/LocalBusiness"><span itemprop="name">X</span></div>
      <div vocab="https://schema.org/" typeof="Event"><span property="name">Open day</span></div>
      <img src="http://cdn.example.com/a.jpg"><script src="http://cdn.example.com/a.js"></script>
      <script>var a = 1;</script><style>p{}</style><iframe src="https://www.youtube.com/embed/x"></iframe>
      </body></html>`;
    const p = extractPage(
      fakeFetch('https://e.com/page', html, {
        'x-robots-tag': 'noai',
        link: '<https://e.com/c>; rel="canonical", <https://e.com/fr>; rel="alternate"; hreflang="fr"',
      }),
      { origin: 'https://e.com', depth: 1 },
    );
    expect(p.titleCount).toBe(2);
    expect(p.canonicalCount).toBe(2);
    expect(p.canonical).toBe('https://e.com/a');
    expect(p.canonicalHeader).toBe('https://e.com/c');
    expect(p.metaRobots).toBe('noindex');
    expect(p.botMeta).toEqual({ googlebot: 'nosnippet', gptbot: 'noindex' });
    expect(p.xRobotsTag).toBe('noai');
    expect(p.hreflang.map((h) => `${h.lang}:${h.source}`).sort()).toEqual(['de:html', 'fr:header']);
    expect(p.forms[0]).toMatchObject({
      action: 'https://e.com/go',
      method: 'get',
      inputs: 1,
      hasLabels: false,
      toolname: 'search_site',
    });
    expect(p.structuredData.map((s) => `${s.format}:${s.types.join(',')}`)).toEqual([
      'microdata:LocalBusiness',
      'rdfa:Event',
    ]);
    expect(p.mixedContent).toEqual(['http://cdn.example.com/a.jpg', 'http://cdn.example.com/a.js']);
    expect(p.images[0]!.alt).toBeNull();
    expect(p.inlineScriptBytes).toBe(10);
    expect(p.inlineStyleBytes).toBe(3);
    expect(p.iframes).toEqual(['https://www.youtube.com/embed/x']);
  });

  it('returns a shell for non-HTML', () => {
    const p = extractPage(
      {
        ...fakeFetch('https://e.com/a.pdf', '%PDF'),
        contentType: 'application/pdf',
        headers: { 'content-type': 'application/pdf' },
      },
      { origin: 'https://e.com', depth: 1 },
    );
    expect(p.isHtml).toBe(false);
    expect(p.links).toEqual([]);
  });
});

describe('simhash', () => {
  it('puts near-duplicates close together', () => {
    const base =
      'Handmade solid wood kitchens built in our Leeds workshop from oak walnut and ash for homes across Yorkshire. '.repeat(
        5,
      );
    const a = simhash(base);
    const b = simhash(base + ' Call us today.');
    const c = simhash(
      'A completely different text about the weather in Lisbon during the summer months and the best beaches. '.repeat(
        5,
      ),
    );
    expect(hammingDistance(a, b)).toBeLessThan(hammingDistance(a, c));
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(6);
  });
});

describe('detectStack', () => {
  const page = (html: string, generator: string | null = null) => ({
    ...extractPage(fakeFetch('https://e.com/', html), { origin: 'https://e.com', depth: 0 }),
    generator,
  });
  it('detects frameworks, CMSs, plugins and hosts', () => {
    expect(
      detectStack(
        [page('<script id="__NEXT_DATA__"></script><script src="/_next/static/a.js"></script>')],
        { 'x-vercel-id': 'x' },
      ),
    ).toMatchObject({ id: 'nextjs', host: 'vercel', cdn: 'vercel' });
    const wp = detectStack(
      [
        page(
          '<link href="/wp-content/themes/a.css"><!-- This site is optimized with the Yoast SEO plugin -->',
          'WordPress 6.6.1',
        ),
      ],
      { 'cf-ray': '1' },
    );
    expect(wp).toMatchObject({
      id: 'wordpress',
      seoPlugin: 'yoast',
      version: '6.6.1',
      cdn: 'cloudflare',
    });
    expect(detectStack([page('<img src="https://cdn.shopify.com/x.png">')], {}).id).toBe('shopify');
    expect(detectStack([page('<p>Plain</p>')], {}).id).toBe('static');
  });
});

describe('crawlSite', () => {
  let site: SiteContext;
  const events: string[] = [];
  beforeAll(async () => {
    site = await crawlSite(
      {
        startUrl: fx.url,
        delayMs: 0,
        concurrency: 4,
        render: false,
        checkExternalLinks: false,
        timeoutMs: 2000,
        exclude: ['/slow'],
      },
      (e) => events.push(e.type === 'phase' ? `phase:${e.phase}` : e.type),
    );
  }, 30_000);
  const get = (path: string) => site.pages.get(`${fx.url}${path}`);

  it('fills site context', () => {
    expect(site.origin).toBe(fx.url);
    expect(site.robots.found).toBe(true);
    expect(site.sitemaps.length).toBe(3);
    expect(site.stack.id).toBe('hugo');
    expect(site.probes.size).toBe(0);
    expect(site.stats.pagesCrawled).toBeGreaterThan(20);
    expect(events).toContain('phase:crawl');
    expect(defaultCrawlOptions('example.com').startUrl).toBe('https://example.com/');
  });

  it('records statuses, redirects and depth', () => {
    expect(get('/')!.depth).toBe(0);
    expect(get('/about')!.depth).toBe(1);
    expect(get('/blog/how-long-does-a-kitchen-take')!.depth).toBe(1);
    const chain = get('/old-pricing')!;
    expect(chain.status).toBe(301);
    expect(chain.redirects).toHaveLength(2);
    expect(chain.finalUrl).toBe(`${fx.url}/pricing`);
    expect(get('/pricing')!.status).toBe(200);
    expect(get('/pricing')!.title).toBe('Pricing | Northwind Joinery');
    expect(get('/server-error')!.status).toBe(500);
    expect(get('/blog/no-such-post')!.status).toBe(404);
    expect(get('/blog/no-such-post')!.discoveredFrom).toEqual([`${fx.url}/blog/page/2`]);
    expect(get('/x-robots')!.xRobotsTag).toBe('noindex, nofollow');
  });

  it('records non-HTML files and robots-blocked stubs', () => {
    const pdf = get('/docs/care-guide.pdf')!;
    expect(pdf.isHtml).toBe(false);
    expect(pdf.status).toBe(200);
    expect(pdf.contentType).toBe('application/pdf');
    expect(get('/images/logo.png')!.isHtml).toBe(false);
    const staff = get('/private/staff')!;
    expect(staff.blockedByRobots).toBe(true);
    expect(staff.status).toBe(0);
    expect(fx.requests).not.toContain('GET /private/staff');
  });

  it('tracks sitemaps, orphans, inlinks and duplicates', () => {
    expect(get('/about')!.inSitemap).toBe(true);
    expect(get('/team')!.inSitemap).toBe(false);
    const orphan = get('/orphan')!;
    expect(orphan.depth).toBe(-1);
    expect(orphan.discoveredFrom).toEqual([`${fx.url}/sitemap-pages.xml`]);
    expect(site.inlinks.get(`${fx.url}/orphan`)).toBeUndefined();
    expect(site.inlinks.get(`${fx.url}/about`)!.size).toBeGreaterThan(10);
    expect(get('/team')!.contentHash).toBe(get('/team-old')!.contentHash);
    expect(get('/kitchens-offer')!.canonical).toBe(`${fx.url}/services/kitchens`);
    expect(get('/noindex')!.metaRobots).toBe('noindex, follow');
    expect(get('/blog/page/2')!.pagination.prev).toBe(`${fx.url}/blog/`);
    // Query variants of the home page are separate URLs.
    expect(get('/?utm_source=footer')).toBeDefined();
  });

  it('HEADs images', () => {
    const statuses = imageStatus(site);
    expect(statuses.get(`${fx.url}/images/walnut-table.jpg`)).toBe(404);
    expect(statuses.get(`${fx.url}/images/oak-kitchen.jpg`)).toBe(200);
    const gallery = get('/gallery')!;
    expect(gallery.images.find((i) => i.src.endsWith('oak-kitchen.jpg'))!.bytes).toBe(2006);
    expect(gallery.images.find((i) => i.src.endsWith('oak-kitchen.jpg'))!.alt).toBeNull();
    expect(externalLinkStatus(site).size).toBe(0);
  });

  it('respects maxPages, maxDepth and include patterns', async () => {
    const small = await crawlSite({
      startUrl: fx.url,
      delayMs: 0,
      maxPages: 5,
      render: false,
      checkImages: false,
      useSitemaps: false,
    });
    expect(small.stats.pagesCrawled).toBe(5);
    expect(small.stats.pagesQueuedNotCrawled).toBeGreaterThan(0);
    const shallow = await crawlSite({
      startUrl: fx.url,
      delayMs: 0,
      maxDepth: 0,
      render: false,
      checkImages: false,
      useSitemaps: false,
    });
    expect(shallow.pages.size).toBe(1);
    const blogOnly = await crawlSite({
      startUrl: fx.url,
      delayMs: 0,
      include: ['/blog/'],
      render: false,
      checkImages: false,
      useSitemaps: false,
    });
    expect(
      [...blogOnly.pages.keys()].every((u) => u === `${fx.url}/` || u.includes('/blog/')),
    ).toBe(true);
  }, 30_000);
});
