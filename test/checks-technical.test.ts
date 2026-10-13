import { describe, expect, it } from 'vitest';
import type { Check, Issue, PageData, SiteContext } from '../src/core/types.js';
import { checks as crawlability } from '../src/checks/crawlability.js';
import { checks as response } from '../src/checks/response.js';
import { checks as onpage } from '../src/checks/onpage.js';
import { checks as content } from '../src/checks/content.js';
import { checks as canonical } from '../src/checks/canonical.js';
import { checks as links } from '../src/checks/links.js';
import { checks as images } from '../src/checks/images.js';
import { checks as schema } from '../src/checks/schema.js';
import { checks as hreflang, hreflangProblem } from '../src/checks/hreflang.js';
import { checks as mobile } from '../src/checks/mobile.js';
import { checks as performance } from '../src/checks/performance.js';
import { checks as security } from '../src/checks/security.js';
import { checks as urls } from '../src/checks/urls.js';
import { checks as sitemaps } from '../src/checks/sitemaps.js';
import { checks as pagination } from '../src/checks/pagination.js';
import { checks as accessibility, contrastRatio } from '../src/checks/accessibility.js';
import { checks as jsRendering } from '../src/checks/js-rendering.js';
import { checks as analytics } from '../src/checks/analytics.js';
import { checks as cms } from '../src/checks/cms.js';
import { isIndexable, linkScores, simhashDistance } from '../src/checks/_util.js';
import {
  ORIGIN,
  htmlDoc,
  link,
  makeHome,
  makePage,
  makeSite,
  makeSitemap,
} from './helpers/factories.js';

const FILES: Record<string, Check[]> = {
  crawlability,
  response,
  onpage,
  content,
  canonical,
  links,
  images,
  schema,
  hreflang,
  mobile,
  performance,
  security,
  urls,
  sitemaps,
  pagination,
  accessibility,
  'js-rendering': jsRendering,
  analytics,
  cms,
};
const ALL = Object.values(FILES).flat();

function check(id: string): Check {
  const c = ALL.find((x) => x.def.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

function asList(out: Issue[] | Issue | null | void | undefined): Issue[] {
  return !out ? [] : Array.isArray(out) ? out : [out];
}

/** Run a check: page checks on `page` (or every page), site checks once. */
async function run(id: string, site: SiteContext, page?: PageData): Promise<Issue[]> {
  const c = check(id);
  if (c.kind === 'site') return asList(await c.run(site));
  const pages = page ? [page] : [...site.pages.values()];
  return pages.flatMap((p) => asList(c.run(p, site)));
}

async function runOne(id: string, page: PageData, extra: PageData[] = []) {
  return run(id, makeSite([makeHome(), page, ...extra]), page);
}

// ---------------------------------------------------------------------------
// Registry sanity
// ---------------------------------------------------------------------------

describe('technical check registry', () => {
  it('has at least 230 checks', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(230);
  });

  it('ids are unique, kebab-case and prefixed with their category', () => {
    const seen = new Set<string>();
    for (const c of ALL) {
      expect(seen.has(c.def.id), `duplicate ${c.def.id}`).toBe(false);
      seen.add(c.def.id);
      expect(c.def.id).toMatch(/^[a-z0-9-]+\.[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(c.def.id.startsWith(`${c.def.category}.`), c.def.id).toBe(true);
    }
  });

  it('every def has why/fix text, a pillar and a scope that matches its kind', () => {
    for (const c of ALL) {
      expect(c.def.why.length, c.def.id).toBeGreaterThan(30);
      expect(c.def.fix.length, c.def.id).toBeGreaterThan(10);
      expect(c.def.title.length, c.def.id).toBeGreaterThan(5);
      expect(['technical', 'content']).toContain(c.def.pillar);
      expect(c.def.scope).toBe(c.kind === 'page' ? 'page' : 'site');
      expect(['auto', 'guided', 'manual']).toContain(c.def.fixTier);
    }
  });

  it('accessibility checks sit in the content pillar', () => {
    for (const c of FILES.accessibility) expect(c.def.pillar).toBe('content');
  });

  it('no check throws on an empty or odd page', async () => {
    const odd = makePage({
      html: '',
      isHtml: true,
      headings: [],
      links: [],
      text: '',
      wordCount: 0,
      title: null,
      canonical: null,
      canonicalCount: 0,
    });
    const stub = makePage({
      url: `${ORIGIN}/blocked/`,
      status: 0,
      blockedByRobots: true,
      isHtml: false,
      html: '',
    });
    const site = makeSite([makeHome(), odd, stub]);
    for (const c of ALL) {
      if (c.kind === 'page')
        for (const p of site.pages.values()) expect(() => c.run(p, site)).not.toThrow();
      else await c.run(site);
    }
  });
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

describe('_util', () => {
  it('isIndexable respects noindex and canonical', () => {
    expect(isIndexable(makePage())).toBe(true);
    expect(isIndexable(makePage({ metaRobots: 'noindex, follow' }))).toBe(false);
    expect(isIndexable(makePage({ canonical: `${ORIGIN}/other/` }))).toBe(false);
    expect(isIndexable(makePage({ xRobotsTag: 'otherbot: noindex' }))).toBe(true);
    expect(isIndexable(makePage({ xRobotsTag: 'noindex' }))).toBe(false);
  });

  it('simhash distance counts differing bits', () => {
    expect(simhashDistance('ffffffffffffffff', 'ffffffffffffffff')).toBe(0);
    expect(simhashDistance('ffffffffffffffff', 'fffffffffffffffe')).toBe(1);
    expect(simhashDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });

  it('link score ranks the most linked page highest', () => {
    const pages = ['/a/', '/b/', '/c/'].map((p) =>
      makePage({ url: ORIGIN + p, links: [link('/a/')] }),
    );
    const site = makeSite([makeHome(['/a/', '/b/', '/c/']), ...pages]);
    const scores = linkScores(site);
    const a = scores.get(`${ORIGIN}/a/`)!;
    const c = scores.get(`${ORIGIN}/c/`)!;
    expect(a.rank).toBeGreaterThan(c.rank);
    expect(a.score).toBeGreaterThan(c.score);
  });

  it('hreflang code validation', () => {
    expect(hreflangProblem('en-GB')).toBeNull();
    expect(hreflangProblem('x-default')).toBeNull();
    expect(hreflangProblem('zh-Hant-TW')).toBeNull();
    expect(hreflangProblem('es-419')).toBeNull();
    expect(hreflangProblem('en-UK')).not.toBeNull();
    expect(hreflangProblem('en_GB')).not.toBeNull();
    expect(hreflangProblem('jp')).not.toBeNull();
  });

  it('contrast ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#777777', '#888888')!).toBeLessThan(1.5);
  });
});

// ---------------------------------------------------------------------------
// Crawlability
// ---------------------------------------------------------------------------

describe('crawlability', () => {
  it('flags a noindex page in the sitemap as high', async () => {
    const issues = await runOne('crawlability.noindex', makePage({ metaRobots: 'noindex' }));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('high');
    expect(await runOne('crawlability.noindex', makePage())).toHaveLength(0);
  });

  it('flags conflicting index/noindex sources', async () => {
    expect(
      await runOne(
        'crawlability.robots-conflict',
        makePage({ metaRobots: 'index, follow', xRobotsTag: 'noindex' }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne('crawlability.robots-conflict', makePage({ metaRobots: 'index, follow' })),
    ).toHaveLength(0);
  });

  it('flags an invalid element in head before the canonical', async () => {
    const bad = makePage({
      html: '<html><head><title>x</title><img src="/p.gif"><link rel="canonical" href="https://example.com/x"></head><body></body></html>',
    });
    expect(await runOne('crawlability.head-broken', bad)).toHaveLength(1);
    expect(
      await runOne(
        'crawlability.head-broken',
        makePage({ html: htmlDoc({ head: '<link rel="canonical" href="/x">' }) }),
      ),
    ).toHaveLength(0);
  });

  it('robots.txt: disallow all, 5xx, unsupported rules', async () => {
    const pages = [makeHome()];
    expect(
      await run(
        'crawlability.robots-blocks-all',
        makeSite(pages, { robots: 'User-agent: *\nDisallow: /\n' }),
      ),
    ).toHaveLength(1);
    expect(
      await run(
        'crawlability.robots-blocks-all',
        makeSite(pages, { robots: 'User-agent: *\nDisallow: /admin/\n' }),
      ),
    ).toHaveLength(0);
    expect(
      await run(
        'crawlability.robots-txt-server-error',
        makeSite(pages, { robots: '', robotsStatus: 503 }),
      ),
    ).toHaveLength(1);
    expect(
      await run(
        'crawlability.robots-unsupported-rules',
        makeSite(pages, { robots: 'User-agent: *\nNoindex: /private/\n' }),
      ),
    ).toHaveLength(1);
    expect(
      await run(
        'crawlability.robots-no-sitemap',
        makeSite(pages, { robots: 'User-agent: *\nDisallow:\n' }),
      ),
    ).toHaveLength(1);
    expect(
      await run(
        'crawlability.robots-no-sitemap',
        makeSite(pages, {
          robots: 'User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml\n',
        }),
      ),
    ).toHaveLength(0);
  });

  it('robots.txt blocking CSS/JS', async () => {
    const home = makeHome([], {
      scripts: [
        {
          src: `${ORIGIN}/assets/app.js`,
          inline: false,
          async: false,
          defer: true,
          type: null,
          bytes: 1000,
        },
      ],
    });
    expect(
      await run(
        'crawlability.robots-blocks-resources',
        makeSite([home], { robots: 'User-agent: *\nDisallow: /assets/\n' }),
      ),
    ).toHaveLength(1);
    expect(
      await run(
        'crawlability.robots-blocks-resources',
        makeSite([home], { robots: 'User-agent: *\nDisallow: /admin/\n' }),
      ),
    ).toHaveLength(0);
  });

  it('home page noindex is critical', async () => {
    expect(
      await run(
        'crawlability.homepage-noindex',
        makeSite([makeHome([], { metaRobots: 'noindex' })]),
      ),
    ).toHaveLength(1);
    expect(await run('crawlability.homepage-noindex', makeSite([makeHome()]))).toHaveLength(0);
  });

  it('GSC: not indexed, canonical mismatch, low CTR', async () => {
    const page = makePage();
    const site = makeSite([makeHome(), page], {
      external: {
        gsc: {
          property: 'sc-domain:example.com',
          range: { start: '2025-01-01', end: '2025-03-31' },
          totals: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
          pages: [{ url: page.url, clicks: 2, impressions: 4000, ctr: 0.0005, position: 2.1 }],
          queries: [],
          inspections: [
            {
              url: page.url,
              verdict: 'NEUTRAL',
              coverageState: 'URL is unknown to Google',
              googleCanonical: `${ORIGIN}/other/`,
            },
            {
              url: `${ORIGIN}/x/`,
              verdict: 'NEUTRAL',
              coverageState: 'Crawled - currently not indexed',
            },
          ],
        },
      },
    });
    expect(await run('crawlability.gsc-not-indexed', site)).toHaveLength(1);
    expect(await run('crawlability.gsc-crawled-not-indexed', site)).toHaveLength(1);
    expect(await run('crawlability.gsc-canonical-mismatch', site)).toHaveLength(1);
    expect(await run('crawlability.gsc-low-ctr', site)).toHaveLength(1);
    expect(check('crawlability.gsc-low-ctr').def.requires).toEqual(['gsc']);
  });
});

// ---------------------------------------------------------------------------
// Response and redirects
// ---------------------------------------------------------------------------

describe('response and redirects', () => {
  it('4xx/5xx, soft 404, robots stubs are not network errors', async () => {
    expect(
      await runOne('response.client-error', makePage({ status: 404, isHtml: true })),
    ).toHaveLength(1);
    expect(await runOne('response.server-error', makePage({ status: 502 }))).toHaveLength(1);
    expect(
      await runOne('response.network-error', makePage({ status: 0, blockedByRobots: true })),
    ).toHaveLength(0);
    expect(
      await runOne('response.network-error', makePage({ status: 0, error: 'timeout' })),
    ).toHaveLength(1);
    expect(
      await runOne(
        'response.soft-404',
        makePage({ title: 'Page not found | Example', wordCount: 40, text: 'Sorry' }),
      ),
    ).toHaveLength(1);
    expect(await runOne('response.soft-404', makePage())).toHaveLength(0);
  });

  it('random URL returning 200 is flagged', async () => {
    const site = makeSite([makeHome()]);
    site.fetcher = {
      fetch: async (url) => ({
        url,
        finalUrl: url,
        status: 200,
        ok: true,
        headers: {},
        redirects: [],
        body: '<html></html>',
        bytes: 10,
        truncated: false,
        contentType: 'text/html',
        ttfbMs: 1,
        totalMs: 1,
      }),
    };
    expect(await run('response.missing-page-returns-200', site)).toHaveLength(1);
    expect(await run('response.missing-page-returns-200', makeSite([makeHome()]))).toHaveLength(0);
  });

  it('redirect chain, temporary redirect and redirect to error', async () => {
    const dest = makePage({ url: `${ORIGIN}/gone/`, status: 404 });
    const chain = makePage({
      url: `${ORIGIN}/old/`,
      finalUrl: `${ORIGIN}/gone/`,
      status: 301,
      isHtml: false,
      html: '',
      redirects: [
        { url: `${ORIGIN}/old/`, status: 301 },
        { url: `${ORIGIN}/older/`, status: 302 },
      ],
    });
    const site = makeSite([makeHome(['/old/']), chain, dest]);
    expect(await run('redirects.chain', site, chain)).toHaveLength(1);
    expect(await run('redirects.temporary', site, chain)).toHaveLength(1);
    expect(await run('redirects.to-error', site, chain)).toHaveLength(1);
    expect(await run('redirects.linked-internally', site, chain)).toHaveLength(1);
  });

  it('meta refresh redirect', async () => {
    const p = makePage({
      html: htmlDoc({ head: '<meta http-equiv="refresh" content="0; url=/new/">' }),
    });
    expect(await runOne('redirects.meta-refresh', p)).toHaveLength(1);
    expect(await runOne('redirects.meta-refresh', makePage())).toHaveLength(0);
  });

  it('http not redirecting to https', async () => {
    const site = makeSite([makeHome()], { fetch: { 'http://example.com/': { status: 200 } } });
    expect(await run('redirects.http-not-redirected', site)).toHaveLength(1);
    const ok = makeSite([makeHome()], {
      fetch: { 'http://example.com/': { status: 301, headers: { location: `${ORIGIN}/` } } },
    });
    expect(await run('redirects.http-not-redirected', ok)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// On-page and headings
// ---------------------------------------------------------------------------

describe('onpage and headings', () => {
  it('title rules', async () => {
    expect(await runOne('onpage.title-missing', makePage({ title: null }))).toHaveLength(1);
    expect(
      await runOne('onpage.title-missing', makePage({ title: null, metaRobots: 'noindex' })),
    ).toHaveLength(0);
    expect(await runOne('onpage.title-too-long', makePage({ title: 'x'.repeat(80) }))).toHaveLength(
      1,
    );
    expect(
      await runOne('onpage.title-generic', makePage({ title: 'Home | Example' })),
    ).toHaveLength(1);
    expect(await runOne('onpage.title-generic', makePage())).toHaveLength(0);
  });

  it('duplicate titles across pages', async () => {
    const a = makePage({ url: `${ORIGIN}/a/`, title: 'Same title here' });
    const b = makePage({ url: `${ORIGIN}/b/`, title: 'Same title here' });
    const issues = await run('onpage.title-duplicate', makeSite([makeHome(), a, b]));
    expect(issues.map((i) => i.url).sort()).toEqual([a.url, b.url]);
  });

  it('meta description rules', async () => {
    expect(
      await runOne('onpage.description-missing', makePage({ metaDescription: null })),
    ).toHaveLength(1);
    expect(
      await runOne('onpage.description-too-short', makePage({ metaDescription: 'Too short' })),
    ).toHaveLength(1);
    expect(await runOne('onpage.description-too-long', makePage())).toHaveLength(0);
  });

  it('heading rules', async () => {
    expect(
      await runOne('headings.h1-missing', makePage({ headings: [{ level: 2, text: 'x' }] })),
    ).toHaveLength(1);
    expect(
      await runOne(
        'headings.h1-multiple',
        makePage({
          headings: [
            { level: 1, text: 'a' },
            { level: 1, text: 'b' },
          ],
        }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'headings.skipped-level',
        makePage({
          headings: [
            { level: 1, text: 'a' },
            { level: 3, text: 'b' },
          ],
        }),
      ),
    ).toHaveLength(1);
    expect(await runOne('headings.skipped-level', makePage())).toHaveLength(0);
    expect(
      await runOne('headings.no-subheadings', makePage({ headings: [{ level: 1, text: 'a' }] })),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Content and duplicates
// ---------------------------------------------------------------------------

describe('content and duplicates', () => {
  it('thin content, lorem ipsum, template leaks, mojibake', async () => {
    expect(
      await runOne('content.thin', makePage({ text: 'Short page with few words.', wordCount: 5 })),
    ).toHaveLength(1);
    expect(await runOne('content.thin', makePage())).toHaveLength(0);
    expect(
      await runOne('content.lorem-ipsum', makePage({ text: 'Lorem ipsum dolor sit amet' })),
    ).toHaveLength(1);
    expect(
      await runOne('content.template-leak', makePage({ text: 'Hello {{ user.name }}, welcome' })),
    ).toHaveLength(1);
    expect(
      await runOne('content.broken-encoding', makePage({ text: 'Weâ€™re open' })),
    ).toHaveLength(1);
    expect(await runOne('content.broken-encoding', makePage())).toHaveLength(0);
  });

  it('keyword stuffing', async () => {
    const stuffed = Array.from({ length: 400 }, (_, i) =>
      i % 8 === 0 ? 'plumber' : `word${i}`,
    ).join(' ');
    expect(
      await runOne('content.keyword-stuffing', makePage({ text: stuffed, mainText: stuffed })),
    ).toHaveLength(1);
    const natural = Array.from({ length: 400 }, (_, i) => `term${i % 120}`).join(' ');
    expect(
      await runOne('content.keyword-stuffing', makePage({ text: natural, mainText: natural })),
    ).toHaveLength(0);
  });

  it('exact and near duplicates', async () => {
    const a = makePage({ url: `${ORIGIN}/a/`, contentHash: 'same' });
    const b = makePage({ url: `${ORIGIN}/b/`, contentHash: 'same' });
    expect(await run('duplicates.exact', makeSite([makeHome(), a, b]))).toHaveLength(2);
    const c = makePage({ url: `${ORIGIN}/c/`, contentHash: 'c', simhash: 'ffffffffffffff00' });
    const d = makePage({ url: `${ORIGIN}/d/`, contentHash: 'd', simhash: 'ffffffffffffff01' });
    const e = makePage({ url: `${ORIGIN}/e/`, contentHash: 'e', simhash: '0000000000000000' });
    const near = await run('duplicates.near', makeSite([c, d, e]));
    expect(near.map((i) => i.url).sort()).toEqual([c.url, d.url]);
  });

  it('article without author or date', async () => {
    const art = makePage({ url: `${ORIGIN}/blog/my-post/`, og: { 'og:type': 'article' } });
    expect(await runOne('content.article-author-missing', art)).toHaveLength(1);
    expect(await runOne('content.article-date-missing', art)).toHaveLength(1);
    const withSd = makePage({
      url: `${ORIGIN}/blog/my-post/`,
      structuredData: [
        {
          format: 'json-ld',
          types: ['BlogPosting'],
          raw: {
            '@context': 'https://schema.org',
            '@type': 'BlogPosting',
            headline: 'x',
            author: { '@type': 'Person', name: 'Jo' },
            datePublished: '2025-01-01',
          },
        },
      ],
    });
    expect(await runOne('content.article-author-missing', withSd)).toHaveLength(0);
    expect(await runOne('content.article-date-missing', withSd)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Canonicals
// ---------------------------------------------------------------------------

describe('canonical', () => {
  it('missing, multiple, relative, to error, to noindex', async () => {
    expect(
      await runOne('canonical.missing', makePage({ canonical: null, canonicalCount: 0 })),
    ).toHaveLength(1);
    const multi = makePage({
      canonicalCount: 2,
      html: htmlDoc({
        head: '<link rel="canonical" href="https://example.com/a"><link rel="canonical" href="https://example.com/b">',
      }),
    });
    expect(await runOne('canonical.multiple', multi)).toHaveLength(1);
    expect(
      await runOne(
        'canonical.relative',
        makePage({ html: htmlDoc({ head: '<link rel="canonical" href="/x/">' }) }),
      ),
    ).toHaveLength(1);

    const target404 = makePage({ url: `${ORIGIN}/dead/`, status: 404 });
    expect(
      await runOne('canonical.to-error', makePage({ canonical: target404.url }), [target404]),
    ).toHaveLength(1);
    const targetNoindex = makePage({ url: `${ORIGIN}/hidden/`, metaRobots: 'noindex' });
    expect(
      await runOne('canonical.to-noindex', makePage({ canonical: targetNoindex.url }), [
        targetNoindex,
      ]),
    ).toHaveLength(1);
    expect(await runOne('canonical.to-noindex', makePage())).toHaveLength(0);
  });

  it('many pages canonicalised to the home page', async () => {
    const pages = [1, 2, 3, 4, 5, 6].map((i) =>
      makePage({ url: `${ORIGIN}/p${i}/`, canonical: `${ORIGIN}/` }),
    );
    expect(await run('canonical.all-to-homepage', makeSite([makeHome(), ...pages]))).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

describe('links', () => {
  it('broken internal links and links to redirects', async () => {
    const broken = makePage({ url: `${ORIGIN}/missing/`, status: 404 });
    const src = makePage({ links: [link('/missing/')] });
    expect(
      await run('links-internal.broken', makeSite([makeHome(), src, broken]), src),
    ).toHaveLength(1);
    expect(await run('links-internal.broken', makeSite([makeHome(), makePage()]))).toHaveLength(0);
  });

  it('orphans in sitemap', async () => {
    const orphan = makePage({ url: `${ORIGIN}/orphan/`, depth: -1 });
    const site = makeSite([makeHome(['/services/web-design/']), makePage(), orphan]);
    const issues = await run('links-internal.orphan', site);
    expect(issues.map((i) => i.url)).toEqual([orphan.url]);
  });

  it('generic anchors, nofollow internal, missing protocol', async () => {
    const generic = makePage({
      links: ['/a/', '/b/', '/c/'].map((p) => link(p, { text: 'Read more' })),
    });
    expect(await runOne('links-internal.generic-anchors', generic)).toHaveLength(1);
    expect(
      await runOne(
        'links-internal.nofollow',
        makePage({ links: [link('/x/', { rel: ['nofollow'] })] }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'links-internal.missing-protocol',
        makePage({ links: [link('/www.partner.com')] }),
      ),
    ).toHaveLength(1);
  });

  it('broken external links read crawler statuses', async () => {
    const page = makePage({ links: [link('https://other.org/x', { internal: false })] });
    const site = makeSite([makeHome(), page]);
    // No statuses recorded: nothing reported.
    expect(await run('links-external.broken', site, page)).toHaveLength(0);
  });

  it('dev hosts and affiliate links', async () => {
    expect(
      await runOne(
        'links-external.dev-host',
        makePage({ links: [link('http://localhost:3000/x', { internal: false })] }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'links-external.sponsored-unqualified',
        makePage({ links: [link('https://amzn.to/abc', { internal: false })] }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'links-external.sponsored-unqualified',
        makePage({ links: [link('https://amzn.to/abc', { internal: false, rel: ['sponsored'] })] }),
      ),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Images, schema, hreflang, mobile
// ---------------------------------------------------------------------------

describe('images', () => {
  it('alt text, weight, lazy above the fold', async () => {
    const img = (o = {}) => ({
      src: `${ORIGIN}/img/a.jpg`,
      alt: 'Team at work',
      width: 800,
      height: 600,
      ...o,
    });
    expect(
      await runOne('images.alt-missing', makePage({ images: [img({ alt: null })] })),
    ).toHaveLength(1);
    expect(
      await runOne('images.alt-missing', makePage({ images: [img({ alt: '' })] })),
    ).toHaveLength(0);
    expect(
      await runOne('images.alt-unhelpful', makePage({ images: [img({ alt: 'IMG_2041.jpg' })] })),
    ).toHaveLength(1);
    expect(
      await runOne('images.large', makePage({ images: [img({ bytes: 2_000_000 })] })).then(
        (i) => i[0].severity,
      ),
    ).toBe('high');
    expect(
      await runOne('images.lazy-above-fold', makePage({ images: [img({ loading: 'lazy' })] })),
    ).toHaveLength(1);
  });
});

describe('schema', () => {
  const sd = (raw: unknown, types: string[], error?: string) => ({
    format: 'json-ld' as const,
    types,
    raw,
    error,
  });

  it('invalid JSON, misspelled type', async () => {
    expect(
      await runOne(
        'schema.invalid-json',
        makePage({ structuredData: [sd(null, [], 'Unexpected token')] }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'schema.type-misspelled',
        makePage({
          structuredData: [
            sd({ '@context': 'https://schema.org', '@type': 'Organisation', name: 'X' }, [
              'Organisation',
            ]),
          ],
        }),
      ),
    ).toHaveLength(1);
  });

  it('product requires offers/review/rating; offer price format', async () => {
    const bare = { '@context': 'https://schema.org', '@type': 'Product', name: 'Widget' };
    expect(
      await runOne(
        'schema.product-incomplete',
        makePage({ structuredData: [sd(bare, ['Product'])] }),
      ),
    ).toHaveLength(1);
    const full = {
      ...bare,
      image: 'https://example.com/w.jpg',
      description: 'd',
      sku: '1',
      brand: { '@type': 'Brand', name: 'B' },
      offers: {
        '@type': 'Offer',
        price: '£1,000',
        priceCurrency: 'GBP',
        availability: 'https://schema.org/InStock',
        url: 'https://example.com/w',
      },
    };
    expect(
      await runOne(
        'schema.product-incomplete',
        makePage({ structuredData: [sd(full, ['Product', 'Offer'])] }),
      ),
    ).toHaveLength(0);
    expect(
      await runOne(
        'schema.offer-incomplete',
        makePage({ structuredData: [sd(full, ['Product', 'Offer'])] }),
      ),
    ).toHaveLength(1);
  });

  it('FAQ questions must be visible', async () => {
    const faq = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        {
          '@type': 'Question',
          name: 'Do you work weekends?',
          acceptedAnswer: { '@type': 'Answer', text: 'Yes' },
        },
      ],
    };
    expect(
      await runOne(
        'schema.faq-not-visible',
        makePage({ structuredData: [sd(faq, ['FAQPage', 'Question'])] }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'schema.faq-not-visible',
        makePage({
          text: 'Do you work weekends? Yes we do.',
          structuredData: [sd(faq, ['FAQPage', 'Question'])],
        }),
      ),
    ).toHaveLength(0);
  });

  it('organisation missing site-wide', async () => {
    expect(await run('schema.organization-missing', makeSite([makeHome()]))).toHaveLength(1);
  });
});

describe('hreflang', () => {
  it('missing return link', async () => {
    const en = makePage({
      url: `${ORIGIN}/en/`,
      hreflang: [
        { lang: 'en', href: `${ORIGIN}/en/`, source: 'html' },
        { lang: 'fr', href: `${ORIGIN}/fr/`, source: 'html' },
      ],
    });
    const fr = makePage({
      url: `${ORIGIN}/fr/`,
      lang: 'fr',
      hreflang: [
        { lang: 'fr', href: `${ORIGIN}/fr/`, source: 'html' },
        { lang: 'de', href: `${ORIGIN}/de/`, source: 'html' },
      ],
    });
    const issues = await run('hreflang.missing-return', makeSite([makeHome(), en, fr]));
    expect(issues.some((i) => i.url === en.url)).toBe(true);
    expect(
      await run(
        'hreflang.invalid-code',
        makeSite([en]),
        makePage({ hreflang: [{ lang: 'en-UK', href: ORIGIN, source: 'html' }] }),
      ),
    ).toHaveLength(1);
  });
});

describe('mobile', () => {
  it('viewport and zoom', async () => {
    expect(await runOne('mobile.viewport-missing', makePage({ viewport: null }))).toHaveLength(1);
    expect(
      await runOne(
        'mobile.zoom-disabled',
        makePage({ viewport: 'width=device-width, user-scalable=no' }),
      ),
    ).toHaveLength(1);
    expect(await runOne('mobile.zoom-disabled', makePage())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Performance, security, URLs, sitemaps, pagination
// ---------------------------------------------------------------------------

describe('performance', () => {
  it('ttfb, compression, render-blocking scripts', async () => {
    expect(
      await runOne('performance.ttfb-slow', makePage({ ttfbMs: 2000 })).then((i) => i[0].severity),
    ).toBe('high');
    expect(await runOne('performance.no-compression', makePage({ headers: {} }))).toHaveLength(1);
    expect(await runOne('performance.no-compression', makePage())).toHaveLength(0);
    const blocking = makePage({
      html: htmlDoc({ head: '<script src="/a.js"></script><script src="/b.js" defer></script>' }),
    });
    const issues = await runOne('performance.render-blocking-scripts', blocking);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('1 blocking script');
  });

  it('PSI checks read field data first and are skipped without psi', async () => {
    expect(check('performance.lcp').def.requires).toEqual(['psi']);
    const site = makeSite([makeHome()], {
      external: {
        psi: {
          [`${ORIGIN}/`]: {
            url: `${ORIGIN}/`,
            strategy: 'mobile',
            performanceScore: 40,
            lcpMs: 1000,
            field: { lcpMs: 4500 },
            opportunities: [],
          },
          [`desktop:${ORIGIN}/`]: {
            url: `${ORIGIN}/`,
            strategy: 'desktop',
            performanceScore: 95,
            lcpMs: 1200,
            opportunities: [],
          },
        },
      },
    });
    const lcp = await run('performance.lcp', site);
    expect(lcp).toHaveLength(1);
    expect(lcp[0].severity).toBe('high');
    expect(await run('performance.psi-score', site)).toHaveLength(1);
  });

  it('rendered timings', async () => {
    const p = makePage({
      rendered: {
        html: '',
        text: '',
        wordCount: 0,
        title: null,
        links: 0,
        headings: [],
        structuredData: [],
        consoleErrors: [],
        failedRequests: [],
        timings: { lcp: 5000 },
      },
    });
    expect(await runOne('performance.rendered-lcp', p)).toHaveLength(1);
  });
});

describe('security', () => {
  it('mixed content, insecure form, cookies, debug output', async () => {
    expect(
      await runOne(
        'security.mixed-content',
        makePage({ mixedContent: ['http://cdn.example.com/a.js'] }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'security.insecure-form',
        makePage({
          forms: [
            { action: 'http://example.com/send', method: 'post', inputs: 3, hasLabels: true },
          ],
        }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'security.cookie-not-secure',
        makePage({ headers: { 'set-cookie': 'sid=1; Path=/; HttpOnly' } }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'security.cookie-not-secure',
        makePage({ headers: { 'set-cookie': 'sid=1; Path=/; Secure; HttpOnly' } }),
      ),
    ).toHaveLength(0);
    expect(
      await runOne(
        'security.debug-output',
        makePage({
          html: '<b>Warning</b>:  Undefined variable $x in /var/www/a.php on line <b>12</b>',
        }),
      ),
    ).toHaveLength(1);
  });

  it('missing HSTS and exposed .git', async () => {
    expect(
      await run('security.hsts-missing', makeSite([makeHome([], { headers: {} })])),
    ).toHaveLength(1);
    expect(await run('security.hsts-missing', makeSite([makeHome()]))).toHaveLength(0);
    const site = makeSite([makeHome()], {
      fetch: {
        [`${ORIGIN}/.git/HEAD`]: {
          status: 200,
          body: 'ref: refs/heads/main\n',
          contentType: 'text/plain',
        },
      },
    });
    expect(await run('security.exposed-files', site)).toHaveLength(1);
  });
});

describe('urls', () => {
  it('session ids, tracking params, internal search', async () => {
    expect(
      await runOne('urls.session-id', makePage({ url: `${ORIGIN}/a/?PHPSESSID=abc` })),
    ).toHaveLength(1);
    expect(
      await runOne(
        'urls.tracking-parameters',
        makePage({ url: `${ORIGIN}/a/?utm_source=x`, canonical: `${ORIGIN}/a/?utm_source=x` }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'urls.internal-search-indexable',
        makePage({ url: `${ORIGIN}/?s=shoes`, canonical: `${ORIGIN}/?s=shoes` }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'urls.uppercase',
        makePage({ url: `${ORIGIN}/About-Us/`, canonical: `${ORIGIN}/About-Us/` }),
      ),
    ).toHaveLength(1);
    expect(await runOne('urls.uppercase', makePage())).toHaveLength(0);
  });
});

describe('sitemaps', () => {
  it('missing sitemap and bad URLs in sitemap', async () => {
    expect(await run('sitemaps.missing', makeSite([makeHome()]))).toHaveLength(1);
    const gone = makePage({ url: `${ORIGIN}/gone/`, status: 404 });
    const noidx = makePage({ url: `${ORIGIN}/hidden/`, metaRobots: 'noindex' });
    const site = makeSite([makeHome(), gone, noidx], {
      sitemaps: [makeSitemap([gone.url, noidx.url, `${ORIGIN}/`])],
    });
    expect(await run('sitemaps.error-urls', site)).toHaveLength(1);
    expect(await run('sitemaps.noindex-urls', site)).toHaveLength(1);
    expect(await run('sitemaps.missing', site)).toHaveLength(0);
  });

  it('lastmod sanity', async () => {
    const urls = Array.from({ length: 25 }, (_, i) => ({
      loc: `${ORIGIN}/p${i}/`,
      lastmod: '2025-01-01T00:00:00Z',
    }));
    expect(
      await run(
        'sitemaps.lastmod-uniform',
        makeSite([makeHome()], { sitemaps: [makeSitemap(urls)] }),
      ),
    ).toHaveLength(1);
    expect(
      await run(
        'sitemaps.lastmod-future',
        makeSite([makeHome()], {
          sitemaps: [makeSitemap([{ loc: `${ORIGIN}/`, lastmod: '2999-01-01' }])],
        }),
      ),
    ).toHaveLength(1);
  });
});

describe('pagination', () => {
  it('page 2 canonicalised to page 1', async () => {
    expect(
      await runOne(
        'pagination.canonical-to-first',
        makePage({ url: `${ORIGIN}/blog/page/2/`, canonical: `${ORIGIN}/blog/` }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'pagination.canonical-to-first',
        makePage({ url: `${ORIGIN}/blog/page/2/`, canonical: `${ORIGIN}/blog/page/2/` }),
      ),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Accessibility, JS rendering, analytics, CMS
// ---------------------------------------------------------------------------

describe('accessibility', () => {
  it('labels, link names, button names, duplicate ids', async () => {
    expect(
      await runOne(
        'accessibility.form-label-missing',
        makePage({
          html: htmlDoc({ body: '<form><input name="email" placeholder="Email"></form>' }),
        }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'accessibility.form-label-missing',
        makePage({
          html: htmlDoc({
            body: '<form><label for="e">Email</label><input id="e" name="email"></form>',
          }),
        }),
      ),
    ).toHaveLength(0);
    expect(
      await runOne(
        'accessibility.link-name-missing',
        makePage({ html: htmlDoc({ body: '<a href="/x"><svg></svg></a>' }) }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'accessibility.link-name-missing',
        makePage({ html: htmlDoc({ body: '<a href="/x"><img src="a.png" alt="Home"></a>' }) }),
      ),
    ).toHaveLength(0);
    expect(
      await runOne(
        'accessibility.button-name-missing',
        makePage({ html: htmlDoc({ body: '<button><i class="icon"></i></button>' }) }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'accessibility.duplicate-ids',
        makePage({ html: htmlDoc({ body: '<div id="a"></div><div id="a"></div>' }) }),
      ),
    ).toHaveLength(1);
    expect(await runOne('accessibility.lang-missing', makePage({ lang: null }))).toHaveLength(1);
  });
});

describe('js-rendering', () => {
  const rendered = (o: Partial<NonNullable<PageData['rendered']>> = {}) => ({
    html: '',
    text: '',
    wordCount: 900,
    title: 'T',
    links: 2,
    headings: [],
    structuredData: [],
    consoleErrors: [],
    failedRequests: [],
    ...o,
  });

  it('client-only content and content gap', async () => {
    expect(
      await runOne(
        'js-rendering.client-only',
        makePage({ wordCount: 5, text: 'x', rendered: rendered() }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'js-rendering.content-gap',
        makePage({ wordCount: 200, text: 'x', rendered: rendered() }),
      ),
    ).toHaveLength(1);
    expect(
      await runOne(
        'js-rendering.content-gap',
        makePage({ wordCount: 880, text: 'x', rendered: rendered() }),
      ),
    ).toHaveLength(0);
    expect(check('js-rendering.client-only').def.requires).toEqual(['render']);
  });

  it('canonical changed by JavaScript', async () => {
    const p = makePage({
      rendered: rendered({
        html: '<html><head><link rel="canonical" href="https://example.com/other/"></head><body></body></html>',
      }),
    });
    expect(await runOne('js-rendering.canonical-changed', p)).toHaveLength(1);
  });
});

describe('analytics', () => {
  it('duplicate GA4 and none detected', async () => {
    const dup = makeHome([], {
      html: htmlDoc({
        head: '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234"></script><script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234"></script>',
      }),
    });
    expect(await run('analytics.duplicate-ga4', makeSite([dup]), dup)).toHaveLength(1);
    expect(await run('analytics.none', makeSite([makeHome()]))).toHaveLength(1);
    expect(await run('analytics.none', makeSite([dup]))).toHaveLength(0);
  });
});

describe('cms', () => {
  it('WordPress defaults and SEO plugin conflicts', async () => {
    expect(
      await runOne('cms.wp-default-content', makePage({ title: 'Hello world! | My blog' })),
    ).toHaveLength(1);
    const both = makePage({
      html: htmlDoc({
        head: '<!-- This site is optimized with the Yoast SEO plugin --><!-- Search Engine Optimization by Rank Math -->',
      }),
    });
    expect(await runOne('cms.wp-seo-plugin-conflict', both)).toHaveLength(1);
  });

  it('WordPress user enumeration probe', async () => {
    const home = makeHome([], {
      html: htmlDoc({ head: '<link rel="stylesheet" href="/wp-content/themes/x/style.css">' }),
    });
    const site = makeSite([home], {
      fetch: {
        [`${ORIGIN}/?author=1`]: { status: 301, headers: { location: `${ORIGIN}/author/admin/` } },
      },
    });
    const issues = await run('cms.wp-user-enumeration', site);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('admin');
  });

  it('platform default domain links', async () => {
    expect(
      await runOne(
        'cms.platform-subdomain-links',
        makePage({ canonical: 'https://shop.myshopify.com/products/x' }),
      ),
    ).toHaveLength(1);
  });
});
