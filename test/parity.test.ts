/**
 * Tests for the feature-parity pass: the new checks, crawl options, PDF/TLS/DNS readers,
 * connectors (LanguageTool, Safe Browsing, backlinks, embeddings), reports (Excel, PDF,
 * branding, snippets), the Screaming Frog import, WordPress canonical/redirect writes,
 * fix overrides and the new MCP tools.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AvcConfig } from '../src/core/config.js';
import type { AuditResult, Check, Issue, PageData, SiteContext } from '../src/core/types.js';
import { ALL_CHECKS } from '../src/checks/index.js';
import { findRecipe, FALLBACK } from '../src/fixes/recipes/index.js';
import { ORIGIN, htmlDoc, link, makeHome, makePage, makeSite } from './helpers/factories.js';

function check(id: string): Check {
  const c = ALL_CHECKS.find((x) => x.def.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}
function list(out: Issue[] | Issue | null | void | undefined): Issue[] {
  return !out ? [] : Array.isArray(out) ? out : [out];
}
async function run(id: string, site: SiteContext, page?: PageData): Promise<Issue[]> {
  const c = check(id);
  if (c.kind === 'site') return list(await c.run(site));
  const pages = page ? [page] : [...site.pages.values()];
  return pages.flatMap((p) => list(c.run(p, site)));
}
const one = (id: string, page: PageData, extra: PageData[] = []) =>
  run(id, makeSite([makeHome(), page, ...extra]), page);

const NEW_IDS = [
  'onpage.description-thin-for-ai',
  'onpage.title-same-as-h1',
  'onpage.favicon-broken',
  'crawlability.noindex-nofollow',
  'response.doctype-missing',
  'redirects.mixed-status',
  'content.cannibalisation',
  'content.repeated-words',
  'content.spelling',
  'content.pdf-title-missing',
  'duplicates.semantic',
  'content.off-topic',
  'images.oversized-rendered',
  'sitemaps.no-image-entries',
  'security.tls-expired',
  'security.tls-expiring',
  'security.tls-invalid',
  'performance.unminified-assets',
  'mobile.horizontal-scroll',
  'mobile.tap-targets',
  'mobile.content-parity',
  'mobile.interstitial',
  'mobile.blocked-resources',
  'mobile.rendered-small-text',
  'accessibility.role-nesting',
  'accessibility.low-contrast-rendered',
  'pagination.deep-series',
  'links-external.unsafe',
  'analytics.no-ai-referrals',
  'geo-content.gated-content',
  'geo-content.no-first-party-facts',
  'agentic.link-header-missing',
  'agentic.dns-aid-missing',
  'agentic.auth-md-missing',
  'agentic.agent-skills-invalid',
  'agentic-commerce.acp-invalid',
];

describe('parity checks: registry', () => {
  it('every new check exists, with why/fix text and its own recipe', () => {
    for (const id of NEW_IDS) {
      const c = check(id);
      expect(c.def.why.length, id).toBeGreaterThan(40);
      expect(c.def.fix.length, id).toBeGreaterThan(20);
      const r = findRecipe(id);
      expect(r, id).not.toBe(FALLBACK);
      expect(r.id, id).toBe(id);
    }
  });

  it('new checks are quiet on a good page', async () => {
    const site = makeSite([makeHome(), makePage()], {
      fetch: { [`${ORIGIN}/favicon.ico`]: { status: 200, contentType: 'image/x-icon', body: 'x' } },
    });
    for (const id of NEW_IDS) {
      const out = await run(id, site);
      expect(out, id).toEqual([]);
    }
  });
});

describe('parity checks: on-page and technical', () => {
  it('description-thin-for-ai fires between 70 and 120 characters only', async () => {
    const d =
      'Fixed-price websites for small London firms, built in four weeks and cared for monthly.';
    expect(d.length).toBeGreaterThan(70);
    expect(d.length).toBeLessThan(120);
    expect(
      await one('onpage.description-thin-for-ai', makePage({ metaDescription: d })),
    ).toHaveLength(1);
    expect(
      await one('onpage.description-thin-for-ai', makePage({ metaDescription: 'Short' })),
    ).toHaveLength(0);
  });

  it('title-too-long also measures pixels', async () => {
    const wide = 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW'; // 40 chars, very wide
    const out = await one('onpage.title-too-long', makePage({ title: wide }));
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toMatch(/px/);
  });

  it('title-same-as-h1 fires when almost every title equals its H1', async () => {
    const pages = Array.from({ length: 6 }, (_, i) =>
      makePage({
        url: `${ORIGIN}/p${i}/`,
        title: `Topic number ${i}`,
        headings: [{ level: 1, text: `Topic number ${i}` }],
      }),
    );
    expect(await run('onpage.title-same-as-h1', makeSite([makeHome(), ...pages]))).toHaveLength(1);
  });

  it('favicon-broken fetches the declared icon', async () => {
    const home = makeHome();
    const site = makeSite([home], {
      fetch: { [home.favicon!]: { status: 404, contentType: 'text/html', body: 'nope' } },
    });
    expect(await run('onpage.favicon-broken', site)).toHaveLength(1);
    const ok = makeSite([home], {
      fetch: { [home.favicon!]: { status: 200, contentType: 'image/x-icon', body: 'x' } },
    });
    expect(await run('onpage.favicon-broken', ok)).toHaveLength(0);
  });

  it('noindex-nofollow fires on noindex pages with links', async () => {
    const page = makePage({
      metaRobots: 'noindex, nofollow',
      links: [link('/a/'), link('/b/'), link('/c/')],
    });
    expect(await one('crawlability.noindex-nofollow', page)).toHaveLength(1);
    expect(
      await one('crawlability.noindex-nofollow', makePage({ metaRobots: 'noindex, follow' })),
    ).toHaveLength(0);
  });

  it('doctype-missing', async () => {
    const { hasHtmlDoctype } = await import('../src/checks/response.js');
    expect(hasHtmlDoctype('﻿<!-- x -->\n<!DOCTYPE html><html>')).toBe(true);
    expect(hasHtmlDoctype('<html><head>')).toBe(false);
    expect(
      await one(
        'response.doctype-missing',
        makePage({ html: '<html><head></head><body>x</body></html>' }),
      ),
    ).toHaveLength(1);
  });

  it('redirects.mixed-status groups by section', async () => {
    const r = (path: string, status: number) =>
      makePage({
        url: `${ORIGIN}${path}`,
        finalUrl: `${ORIGIN}/new${path}`,
        status,
        redirects: [{ url: `${ORIGIN}${path}`, status }],
        isHtml: false,
      });
    const site = makeSite([makeHome(), r('/blog/a', 301), r('/blog/b', 301), r('/blog/c', 302)]);
    const out = await run('redirects.mixed-status', site);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toMatch(/\/blog/);
  });

  it('cannibalisation finds the same topic with different wording', async () => {
    const a = makePage({
      url: `${ORIGIN}/web-design-london/`,
      title: 'Web design in London | Example',
      headings: [{ level: 1, text: 'Web design London' }],
    });
    const b = makePage({
      url: `${ORIGIN}/london-web-design/`,
      title: 'London web design services',
      headings: [{ level: 1, text: 'London web design' }],
    });
    const out = await run('content.cannibalisation', makeSite([makeHome(), a, b]));
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toMatch(/2 pages/);
  });

  it('repeated words and spelling', async () => {
    const text = 'We build the the best websites. '.repeat(10);
    expect(await one('content.repeated-words', makePage({ text, wordCount: 60 }))).toHaveLength(1);
    const page = makePage();
    const site = makeSite([makeHome(), page], {
      external: {
        spelling: {
          server: 'http://lt',
          checked: 1,
          pages: [
            {
              url: page.url,
              language: 'en-GB',
              matches: [1, 2, 3].map((i) => ({
                message: 'Possible spelling mistake',
                context: `teh ${i}`,
                rule: 'MORFOLOGIK',
                category: 'TYPOS',
              })),
            },
          ],
        },
      },
    });
    expect(await run('content.spelling', site)).toHaveLength(1);
  });

  it('PDF titles', async () => {
    const pdf = makePage({
      url: `${ORIGIN}/guide.pdf`,
      isHtml: false,
      html: '',
      pdf: { title: 'Microsoft Word - guide_v3.docx', pages: 4 },
    });
    expect(await one('content.pdf-title-missing', pdf)).toHaveLength(1);
    const good = makePage({
      url: `${ORIGIN}/g.pdf`,
      isHtml: false,
      html: '',
      pdf: { title: 'Kitchen fitting guide' },
    });
    expect(await one('content.pdf-title-missing', good)).toHaveLength(0);
  });

  it('semantic duplicates skip pairs that are already near-exact copies', async () => {
    const a = makePage({ url: `${ORIGIN}/a/`, simhash: '0000000000000000' });
    const b = makePage({ url: `${ORIGIN}/b/`, simhash: 'ffffffffffffffff' });
    const site = makeSite([makeHome(), a, b], {
      external: {
        embeddings: {
          model: 'mock',
          pages: 2,
          similarPairs: [{ a: a.url, b: b.url, similarity: 0.95 }],
          outliers: [{ url: b.url, similarity: 0.2 }],
        },
      },
    });
    expect(await run('duplicates.semantic', site)).toHaveLength(1);
    expect(await run('content.off-topic', site)).toHaveLength(1);
  });

  it('images.oversized-rendered uses the rendered boxes', async () => {
    const page = makePage({
      images: [{ src: `${ORIGIN}/big.jpg`, alt: 'x', width: 2400, height: 1600, bytes: 900_000 }],
      rendered: {
        html: '',
        text: '',
        wordCount: 400,
        title: null,
        links: 10,
        headings: [],
        structuredData: [],
        consoleErrors: [],
        failedRequests: [],
        layout: {
          viewportWidth: 1366,
          images: [{ src: `${ORIGIN}/big.jpg`, width: 300, height: 200 }],
          lowContrast: [],
        },
      },
    });
    expect(await one('images.oversized-rendered', page)).toHaveLength(1);
  });

  it('sitemaps.no-image-entries', async () => {
    const pages = Array.from({ length: 5 }, (_, i) =>
      makePage({
        url: `${ORIGIN}/p${i}/`,
        images: [
          { src: `${ORIGIN}/a${i}.jpg`, alt: 'a' },
          { src: `${ORIGIN}/b${i}.jpg`, alt: 'b' },
        ],
      }),
    );
    const sitemaps = [
      {
        url: `${ORIGIN}/sitemap.xml`,
        status: 200,
        found: true,
        isIndex: false,
        urls: pages.map((p) => ({ loc: p.url })),
        children: [],
        errors: [],
        bytes: 100,
        gzip: false,
        source: 'default' as const,
      },
    ];
    expect(
      await run('sitemaps.no-image-entries', makeSite([makeHome(), ...pages], { sitemaps })),
    ).toHaveLength(1);
  });

  it('TLS checks read site.tls', async () => {
    const site = (tls: SiteContext['tls']) => makeSite([makeHome()], { extra: { tls } });
    expect(
      await run(
        'security.tls-expired',
        site({
          host: 'example.com',
          authorized: false,
          validTo: '2020-01-01T00:00:00.000Z',
          daysLeft: -5,
        }),
      ),
    ).toHaveLength(1);
    const soon = await run(
      'security.tls-expiring',
      site({
        host: 'example.com',
        authorized: true,
        validTo: '2030-01-01T00:00:00.000Z',
        daysLeft: 5,
      }),
    );
    expect(soon[0]?.severity).toBe('critical');
    expect(
      await run(
        'security.tls-invalid',
        site({
          host: 'example.com',
          authorized: false,
          error: 'ERR_TLS_CERT_ALTNAME_INVALID',
          validTo: '2030-01-01T00:00:00.000Z',
          daysLeft: 300,
        }),
      ),
    ).toHaveLength(1);
    // A connection failure (no certificate read) is inconclusive.
    expect(
      await run(
        'security.tls-invalid',
        site({ host: 'example.com', authorized: false, error: 'ECONNREFUSED' }),
      ),
    ).toHaveLength(0);
    const { summariseCert } = await import('../src/crawl/tls.js');
    const s = summariseCert(
      'example.com',
      {
        valid_to: 'Jan 10 00:00:00 2030 GMT',
        valid_from: 'Jan 10 00:00:00 2029 GMT',
        issuer: { O: "Let's Encrypt" } as never,
        subjectaltname: 'DNS:example.com, DNS:www.example.com',
      },
      true,
      undefined,
      Date.parse('2030-01-01T00:00:00Z'),
    );
    expect(s.daysLeft).toBe(9);
    expect(s.issuer).toBe("Let's Encrypt");
    expect(s.altNames).toEqual(['example.com', 'www.example.com']);
  });

  it('unminified assets fetches a sample of same-site files', async () => {
    const page = makePage({
      scripts: [
        { src: `${ORIGIN}/app.js`, inline: false, async: false, defer: true, type: null, bytes: 0 },
      ],
    });
    const body = Array.from(
      { length: 400 },
      (_, i) => `    // comment ${i}\n    function f${i}() {\n        return ${i};\n    }\n`,
    ).join('\n');
    const site = makeSite([makeHome(), page], {
      fetch: { [`${ORIGIN}/app.js`]: { status: 200, contentType: 'text/javascript', body } },
    });
    const out = await run('performance.unminified-assets', site);
    expect(out).toHaveLength(1);
    const { wasteShare } = await import('../src/checks/performance.js');
    expect(wasteShare('function a(){return 1}')).toBeLessThan(0.15);
  });

  it('phone render checks', async () => {
    const page = makePage({
      rendered: {
        html: '',
        text: '',
        wordCount: 800,
        title: null,
        links: 40,
        headings: [],
        structuredData: [],
        consoleErrors: [],
        failedRequests: [],
        mobile: {
          viewportWidth: 412,
          scrollWidth: 980,
          wordCount: 200,
          links: 10,
          smallTargets: [1, 2, 3, 4].map((i) => ({ text: `x${i}`, width: 16, height: 16 })),
          interstitial: { selector: 'div.newsletter', coverage: 0.8 },
          failedRequests: ['https://cdn.example.com/m.js (HTTP 403)'],
          minFontPx: 9,
        },
      },
    });
    for (const id of [
      'mobile.horizontal-scroll',
      'mobile.tap-targets',
      'mobile.content-parity',
      'mobile.interstitial',
      'mobile.blocked-resources',
      'mobile.rendered-small-text',
    ])
      expect(await one(id, page), id).toHaveLength(1);
  });

  it('role nesting and rendered contrast', async () => {
    const bad = makePage({
      html: htmlDoc({
        body: '<div><button role="tab">A</button></div><ul><li role="listitem">x</li></ul>',
      }),
    });
    const out = await one('accessibility.role-nesting', bad);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toMatch(/1 element/);
    const good = makePage({
      html: htmlDoc({
        body: '<div role="tablist"><button role="tab">A</button></div><table><tbody><tr role="row"><td role="cell">1</td></tr></tbody></table>',
      }),
    });
    expect(await one('accessibility.role-nesting', good)).toHaveLength(0);
    const contrast = makePage({
      rendered: {
        html: '',
        text: '',
        wordCount: 10,
        title: null,
        links: 0,
        headings: [],
        structuredData: [],
        consoleErrors: [],
        failedRequests: [],
        layout: {
          viewportWidth: 1366,
          images: [],
          lowContrast: [
            {
              text: 'light grey',
              ratio: 2.1,
              fg: 'rgb(200, 200, 200)',
              bg: 'rgb(255, 255, 255)',
              large: false,
            },
            {
              text: 'more grey',
              ratio: 3.2,
              fg: 'rgb(150, 150, 150)',
              bg: 'rgb(255, 255, 255)',
              large: false,
            },
          ],
        },
      },
    });
    expect(await one('accessibility.low-contrast-rendered', contrast)).toHaveLength(1);
  });

  it('deep pagination series without shortcuts', async () => {
    const pages = [1, 2, 3, 4, 5, 6, 7].map((n) =>
      makePage({
        url: n === 1 ? `${ORIGIN}/blog/` : `${ORIGIN}/blog/page/${n}/`,
        links: [
          ...(n > 1
            ? [link(n === 2 ? '/blog/' : `/blog/page/${n - 1}/`, { text: 'Previous' })]
            : []),
          ...(n < 7 ? [link(`/blog/page/${n + 1}/`, { text: 'Next' })] : []),
        ],
      }),
    );
    const out = await run('pagination.deep-series', makeSite([makeHome(), ...pages]));
    expect(out).toHaveLength(1);
    const { seriesKey } = await import('../src/checks/pagination.js');
    expect(seriesKey(`${ORIGIN}/blog/page/4/`)).toBe(`${ORIGIN}/blog/`);
    expect(seriesKey(`${ORIGIN}/shop?page=3&cat=2`)).toBe(`${ORIGIN}/shop?cat=2`);
  });

  it('unsafe links and GA4 AI referrals read connected data', async () => {
    const site = makeSite([makeHome()], {
      external: {
        safeBrowsing: {
          checked: 3,
          matches: [{ url: 'http://bad.test/', threat: 'MALWARE', pages: [`${ORIGIN}/`] }],
        },
        ga4: {
          property: 'properties/1',
          range: { start: '2026-01-01', end: '2026-01-28' },
          aiReferrals: [],
          landingPages: [],
        },
      },
    });
    expect(await run('links-external.unsafe', site)).toHaveLength(1);
    expect(await run('analytics.no-ai-referrals', site)).toHaveLength(1);
  });

  it('gated content and first-party facts', async () => {
    const paywall = makePage({
      structuredData: [
        {
          format: 'json-ld',
          types: ['Article'],
          raw: { '@context': 'https://schema.org', '@type': 'Article', isAccessibleForFree: false },
        },
      ],
    });
    const out = await one('geo-content.gated-content', paywall);
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toMatch(/without a hasPart/);
    const pages = Array.from({ length: 6 }, (_, i) => makePage({ url: `${ORIGIN}/s${i}/` }));
    expect(
      await run('geo-content.no-first-party-facts', makeSite([makeHome(), ...pages])),
    ).toHaveLength(1);
    const withFaq = [...pages, makePage({ url: `${ORIGIN}/faq/` })];
    expect(
      await run('geo-content.no-first-party-facts', makeSite([makeHome(), ...withFaq])),
    ).toHaveLength(0);
  });
});

describe('parity checks: agentic discovery', () => {
  const probe = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    url: `${ORIGIN}/${id}`,
    status: 200,
    found: true,
    ...over,
  });
  function siteWith(probes: ReturnType<typeof probe>[]): SiteContext {
    const s = makeSite([makeHome()]);
    for (const p of probes) s.probes.set(p.id, p as never);
    s.probes.set('robots-ai-signals', {
      id: 'robots-ai-signals',
      url: '',
      status: 200,
      found: false,
      parsed: [],
    });
    return s;
  }

  it('link header, DNS-AID, auth.md, skills index and ACP', async () => {
    const site = siteWith([
      probe('api-catalog', { url: `${ORIGIN}/.well-known/api-catalog` }),
      probe('link-headers', { found: false, parsed: {} }),
      probe('dns-aid', {
        found: false,
        parsed: { checked: ['_mcp._agents.example.com SVCB'], found: [], failed: false },
      }),
      probe('oauth-prm'),
      probe('auth-md', { found: false, status: 404 }),
      probe('agent-skills', { parsed: { skills: [{ name: 'x' }] } }),
      probe('acp-json', { parsed: { protocol: { name: 'acp' } } }),
    ]);
    for (const id of [
      'agentic.link-header-missing',
      'agentic.dns-aid-missing',
      'agentic.auth-md-missing',
      'agentic.agent-skills-invalid',
      'agentic-commerce.acp-invalid',
    ])
      expect(await run(id, site), id).toHaveLength(1);
    // Advertised in the Link header: quiet.
    const ok = siteWith([
      probe('api-catalog', { url: `${ORIGIN}/.well-known/api-catalog` }),
      probe('link-headers', { parsed: { 'api-catalog': [`${ORIGIN}/.well-known/api-catalog`] } }),
    ]);
    expect(await run('agentic.link-header-missing', ok)).toHaveLength(0);
  });

  it('DNS-AID packets and lookups', async () => {
    const { buildQuery, answerCount, lookupDnsAid } = await import('../src/agentic/dns-aid.js');
    const q = buildQuery('_mcp._agents.example.com', 64, Buffer.from([1, 2]));
    expect(q.subarray(0, 2)).toEqual(Buffer.from([1, 2]));
    expect(q.includes(Buffer.from('example'))).toBe(true);
    const resp = Buffer.alloc(12);
    resp.writeUInt16BE(1, 6);
    expect(answerCount(resp)).toBe(1);
    resp[3] = 3;
    expect(answerCount(resp)).toBe(0);
    const r = await lookupDnsAid('www.example.com', async (name, type) =>
      name.startsWith('_mcp') && type === 64 ? 1 : 0,
    );
    expect(r.found).toEqual(['_mcp._agents.example.com SVCB']);
    expect(r.failed).toBe(false);
    const offline = await lookupDnsAid('example.com', async () => -1);
    expect(offline.failed).toBe(true);
  });
});

describe('crawl options', () => {
  it('rewrites, limits, scope helpers and extraction', async () => {
    const o = await import('../src/crawl/options.js');
    expect(
      o.rewriteUrl('https://e.com/A/B?utm_source=x&id=2', {
        removeParams: ['utm_source'],
        lowercase: true,
      }),
    ).toBe('https://e.com/a/b?id=2');
    expect(
      o.rewriteUrl('https://e.com/old/x', { rewrite: [{ pattern: '/old/', replace: '/new/' }] }),
    ).toBe('https://e.com/new/x');
    expect(o.limitReason('https://e.com/a/b/c/d', { maxFolderDepth: 3 })).toMatch(/folders/);
    expect(o.limitReason('https://e.com/?a=1&b=2&c=3', { maxQueryParams: 2 })).toMatch(
      /parameters/,
    );
    expect(o.limitReason('https://e.com/x', { maxUrlLength: 10 })).toMatch(/longer/);
    expect(o.baseDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(o.onSubdomain('https://blog.example.com/x', 'www.example.com')).toBe(true);
    expect(o.onSubdomain('https://evil.com/x', 'example.com')).toBe(false);
    expect(o.startFolder('https://e.com/blog/post')).toBe('/blog/');
    expect(o.DANGEROUS_LINK.test('https://e.com/wp-login.php?action=logout')).toBe(true);
    expect(o.parseExtractorFlag('price=css:.price@data-amount')).toEqual({
      name: 'price',
      type: 'css',
      expr: '.price',
      attr: 'data-amount',
    });
    expect(o.parseExtractorFlag('nope')).toBeNull();
    expect(o.checkExtractors([{ name: 'bad', type: 'regex', expr: '(' }]).errors).toHaveLength(1);
    const html =
      '<html><body><span class="price" data-amount="10">£10</span><span class="price" data-amount="20">£20</span><p>SKU: AB-1</p></body></html>';
    expect(
      o.runExtractors(html, [
        { name: 'price', type: 'css', expr: '.price', attr: 'data-amount' },
        { name: 'sku', type: 'regex', expr: 'SKU: ([A-Z]+-\\d+)' },
        { name: 'prices', type: 'count', expr: 'class="price"' },
      ]),
    ).toEqual({ price: ['10', '20'], sku: ['AB-1'], prices: 2 });
    const page = makePage({
      html: htmlDoc({ body: '<article>One two three four</article><aside>noise noise</aside>' }),
    });
    o.applyContentArea(page, { contentSelector: 'article' });
    expect(page.wordCount).toBe(4);
  });

  it('presets resolve and merge', async () => {
    const p = await import('../src/crawl/presets.js');
    const wp = p.resolvePreset('wordpress:woocommerce')!;
    expect(wp.exclude!.some((x) => x.includes('wp-admin'))).toBe(true);
    expect(wp.exclude!.some((x) => x.includes('checkout'))).toBe(true);
    expect(p.resolvePreset('wordpress:nope')).toBeNull();
    expect(p.presetForStack('react-spa')?.render).toBe(true);
    expect(p.withPreset({ exclude: ['a'] }, { exclude: ['b'], render: 'auto' })).toEqual({
      exclude: ['a', 'b'],
      render: 'auto',
    });
  });

  it('reads PDF properties', async () => {
    const { extractPdfInfo, decodePdfString, pdfDate, isPdf } = await import('../src/crawl/pdf.js');
    const pdf =
      "%PDF-1.4\n1 0 obj << /Type /Pages /Kids [3 0 R] /Count 12 >> endobj\n5 0 obj << /Title (Kitchen guide \\(2026\\)) /Author <FEFF0041006E006E> /CreationDate (D:20260131120000+01'00') >> endobj\ntrailer << /Info 5 0 R >>";
    const info = extractPdfInfo(Buffer.from(pdf, 'latin1'));
    expect(info.title).toBe('Kitchen guide (2026)');
    expect(info.author).toBe('Ann');
    expect(info.pages).toBe(12);
    expect(info.created).toBe('2026-01-31T12:00:00+01:00');
    expect(decodePdfString('(a\\101b)')).toBe('aAb');
    expect(pdfDate('D:2024')).toBe('2024-01-01T00:00:00Z');
    expect(isPdf('application/pdf')).toBe(true);
    expect(isPdf('', 'https://e.com/x.pdf')).toBe(true);
  });

  it('crawls with list mode, rewriting and extraction against the fixture site', async () => {
    const { startFixtureServer } = await import('./fixtures/serve.js');
    const { crawlSite } = await import('../src/crawl/index.js');
    const fx = await startFixtureServer();
    try {
      const listed = await crawlSite({
        startUrl: `${fx.url.replace(/\/$/, '')}/`,
        urls: [`${fx.url.replace(/\/$/, '')}/about`],
        render: false,
        delayMs: 0,
        checkImages: false,
        extract: [{ name: 'h1', type: 'css', expr: 'h1' }],
      });
      const urls = [...listed.pages.keys()];
      expect(urls).toContain(`${fx.url.replace(/\/$/, '')}/about`);
      expect(urls.length).toBeLessThanOrEqual(3);
      const about = listed.pages.get(`${fx.url.replace(/\/$/, '')}/about`)!;
      expect(Array.isArray(about.extracted?.h1)).toBe(true);

      const folder = await crawlSite({
        startUrl: `${fx.url.replace(/\/$/, '')}/services/`,
        stayInFolder: true,
        render: false,
        delayMs: 0,
        checkImages: false,
        useSitemaps: false,
      });
      for (const u of folder.pages.keys())
        expect(
          new URL(u).pathname.startsWith('/services/') ||
            u === `${fx.url.replace(/\/$/, '')}/services/`,
        ).toBe(true);
    } finally {
      await fx.close();
    }
  });
});

describe('connectors', () => {
  const cfg = (patch: Partial<AvcConfig>): AvcConfig => ({
    dataDir: tmpdir(),
    sites: [],
    ai: { maxRunUsd: 1, maxMonthUsd: 1 },
    server: { port: 1, host: '127.0.0.1' },
    ...patch,
  });
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  it('LanguageTool: language, filtering and collection', async () => {
    const s = await import('../src/connect/spelling.js');
    expect(s.languageFor({ lang: 'en-gb' })).toBe('en-GB');
    expect(s.languageFor({ lang: 'fr' })).toBe('fr');
    expect(s.languageFor({ lang: null })).toBe('auto');
    expect(s.spellingServer(cfg({}))).toBeNull();
    expect(s.spellingServer(cfg({ spelling: { usePublicApi: true } }))).toBe(s.PUBLIC_LANGUAGETOOL);
    const matches = s.filterMatches(
      [
        {
          message: 'Typo',
          context: { text: 'the Acme teh', offset: 4, length: 4 },
          rule: { id: 'M', category: { id: 'TYPOS' } },
        },
        {
          message: 'Style',
          context: { text: 'x', offset: 0, length: 1 },
          rule: { id: 'S', category: { id: 'STYLE' } },
        },
      ],
      ['acme'],
    );
    expect(matches).toHaveLength(0);
    const page = makePage();
    const site = makeSite([makeHome(), page]);
    const calls: string[] = [];
    const data = await s.collectSpelling(
      site,
      cfg({ spelling: { server: 'http://lt:8081', maxPages: 1 } }),
      {
        fetch: (async (url: string) => {
          calls.push(String(url));
          return json({
            language: { code: 'en-GB' },
            matches: [
              {
                message: 'Typo',
                context: { text: 'a teh b', offset: 2, length: 3 },
                rule: { id: 'M', category: { id: 'TYPOS' } },
              },
            ],
          });
        }) as never,
      },
    );
    expect(calls[0]).toBe('http://lt:8081/v2/check');
    expect(data!.pages[0]!.matches).toHaveLength(1);
  });

  it('Safe Browsing sends outbound URLs only', async () => {
    const { collectSafeBrowsing, outboundLinks } = await import('../src/connect/safe-browsing.js');
    const page = makePage({
      links: [link('/x/'), link('https://bad.test/'), link('https://ok.test/')],
    });
    const site = makeSite([makeHome(), page]);
    expect([...outboundLinks(site).keys()].sort()).toEqual([
      'https://bad.test/',
      'https://ok.test/',
    ]);
    let sent: { threatInfo: { threatEntries: { url: string }[] } } | null = null;
    const r = await collectSafeBrowsing(site, 'KEY', {
      fetch: (async (_u: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return json({ matches: [{ threatType: 'MALWARE', threat: { url: 'https://bad.test/' } }] });
      }) as never,
    });
    expect(sent!.threatInfo.threatEntries).toHaveLength(2);
    expect(r.matches[0]).toMatchObject({
      url: 'https://bad.test/',
      threat: 'MALWARE',
      pages: [page.url],
    });
  });

  it('backlinks from Moz, Ahrefs and Majestic', async () => {
    const { fetchBacklinks, backlinkProvider } = await import('../src/connect/backlinks.js');
    expect(backlinkProvider(cfg({}))).toBeNull();
    const moz = await fetchBacklinks(cfg({ backlinks: { mozToken: 't' } }), 'example.com', {
      fetch: (async () =>
        json({ results: [{ domain_authority: 41, root_domains_to_root_domain: 120 }] })) as never,
    });
    expect(moz).toMatchObject({
      provider: 'moz',
      metrics: { domainAuthority: 41, referringDomains: 120 },
    });
    const ahrefs = await fetchBacklinks(cfg({ backlinks: { ahrefsToken: 't' } }), 'example.com', {
      fetch: (async (u: string) =>
        json(
          String(u).includes('domain-rating')
            ? { domain_rating: { domain_rating: 37 } }
            : { metrics: { live_refdomains: 80 } },
        )) as never,
    });
    expect(ahrefs?.metrics).toEqual({ domainRating: 37, referringDomains: 80 });
    const majestic = await fetchBacklinks(cfg({ backlinks: { majesticKey: 'k' } }), 'example.com', {
      fetch: (async () =>
        json({
          Code: 'OK',
          DataTables: { Results: { Data: [{ TrustFlow: 20, CitationFlow: 30 }] } },
        })) as never,
    });
    expect(majestic?.metrics).toEqual({ trustFlow: 20, citationFlow: 30 });
    const failed = await fetchBacklinks(cfg({ backlinks: { mozToken: 't' } }), 'example.com', {
      fetch: (async () => json({}, 401)) as never,
    });
    expect(failed?.error).toMatch(/401/);
  });

  it('embeddings: vectors, similar pairs and outliers (mock)', async () => {
    const e = await import('../src/ai/embeddings.js');
    expect(e.cosine([1, 0], [1, 0])).toBe(1);
    expect(e.cosine([1, 0], [0, 1])).toBe(0);
    const v = e.analyseVectors(
      ['a', 'b', 'c'],
      [
        [1, 0],
        [0.99, 0.01],
        [0, 1],
      ],
      0.9,
    );
    expect(v.similarPairs).toEqual([{ a: 'a', b: 'b', similarity: 1 }]);
    expect(e.embeddingsAvailable(cfg({}))).toBeNull();
    expect(
      e.embeddingsAvailable(
        cfg({ embeddings: { enabled: true }, ai: { maxRunUsd: 1, maxMonthUsd: 1, mock: true } }),
      ),
    ).toBe('mock');
    const pages = [
      'web design london studio',
      'london web design studio',
      'growing tomatoes in pots',
    ].map((t, i) =>
      makePage({
        url: `${ORIGIN}/p${i}/`,
        text: `${t} `.repeat(40),
        mainText: `${t} `.repeat(40),
        wordCount: 160,
      }),
    );
    const res = await e.computeEmbeddings(
      makeSite([...pages]),
      cfg({
        embeddings: { enabled: true, threshold: 0.9 },
        ai: { maxRunUsd: 1, maxMonthUsd: 1, mock: true },
      }),
    );
    expect(res?.similarPairs.map((p) => [p.a, p.b])).toEqual([[pages[0]!.url, pages[1]!.url]]);
  });
});

describe('reports, snippets and the AI helpers', () => {
  function result(): AuditResult {
    return {
      id: 'a1',
      version: '1',
      site: ORIGIN,
      startUrl: `${ORIGIN}/`,
      at: '2026-10-01T00:00:00Z',
      stack: { id: 'wordpress', confidence: 1, signals: [] },
      stats: {
        startedAt: '',
        finishedAt: '',
        pagesCrawled: 1,
        pagesQueuedNotCrawled: 0,
        maxPages: 1,
        maxDepth: 1,
        rendered: 0,
        errors: 0,
        durationMs: 0,
      },
      pages: [
        {
          url: `${ORIGIN}/`,
          finalUrl: `${ORIGIN}/`,
          status: 200,
          depth: 0,
          title: 'Home',
          metaDescription: 'Short',
          h1: 'Home',
          wordCount: 300,
          canonical: null,
          indexable: true,
          inlinks: 3,
          outlinks: 4,
          bytes: 1,
          ttfbMs: 1,
          schemaTypes: [],
          issues: 1,
          inSitemap: true,
          extracted: { price: ['10', '20'] },
        },
      ],
      issues: [
        { checkId: 'onpage.title-too-short', url: `${ORIGIN}/`, message: 'Title is 4 characters' },
      ],
      checks: {
        'onpage.title-too-short': {
          ...check('onpage.title-too-short').def,
          status: 'ran',
          affected: 1,
        },
      },
      score: { overall: 70, grade: 'C', pillars: [] },
      priorities: [{ checkId: 'onpage.title-too-short', affected: 1, impact: 1 }],
      probes: [],
      botFetches: [],
      robots: { found: true, status: 200, body: '' },
      sitemaps: [],
      external: {},
    };
  }

  it('Excel workbook is a valid ZIP with the expected sheets', async () => {
    const { auditToXlsx, columnName, extractionRows } = await import('../src/report/xlsx.js');
    expect(columnName(0)).toBe('A');
    expect(columnName(27)).toBe('AB');
    const buf = auditToXlsx(result());
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const text = buf.toString('latin1');
    for (const f of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet4.xml'])
      expect(text).toContain(f);
    expect(text).toContain('name="Extraction"');
    expect(extractionRows(result())).toEqual([
      ['URL', 'price'],
      [`${ORIGIN}/`, '10 | 20'],
    ]);
    // The archive's end record says how many files it holds.
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(buf.readUInt16LE(eocd + 10)).toBe(9);
  });

  it('HTML report branding and print mode', async () => {
    const { renderHtmlReport, safeColor } = await (async () => {
      const m = await import('../src/report/html.js');
      return m;
    })();
    const html = renderHtmlReport(result(), {
      branding: {
        brandName: 'Acme Agency',
        brandColor: '#ff0066',
        brandContact: 'hello@acme.test',
      },
      print: true,
    });
    expect(html).toContain('Acme Agency');
    expect(html).toContain('--azure:#ff0066');
    expect(html).toContain('hello@acme.test');
    expect(safeColor('red;}</style>')).toBeNull();
  });

  it('CSV extraction export and new formats', async () => {
    const { renderReport, parseFormats } = await import('../src/cli/services.js');
    expect(parseFormats('xlsx,pdf')).toEqual(['xlsx', 'pdf']);
    const files = renderReport(result(), 'csv', {});
    expect(files.map((f) => f.filename)).toEqual(
      expect.arrayContaining([expect.stringMatching(/extraction\.csv$/)]),
    );
  });

  it('snippet widths', async () => {
    const s = await import('../src/report/serp.js');
    expect(s.textWidthPx('iiii', 20)).toBeLessThan(s.textWidthPx('WWWW', 20));
    const row = s.serpRow('u', 'W'.repeat(40), 'short');
    expect(row.titleTruncated).toBe(true);
    expect(row.shownTitle.endsWith('…')).toBe(true);
    expect(row.descriptionThinForAi).toBe(true);
  });

  it('ask: rule-based answer without a model, model answer with one', async () => {
    const { askAboutAudit, auditBrief } = await import('../src/ai/ask.js');
    const r = await askAboutAudit(result(), 'what first?', {
      ai: { maxRunUsd: 1, maxMonthUsd: 1, mock: true },
    });
    expect(r.source).toBe('rules');
    expect(r.answer).toMatch(/Title is very short/);
    expect(auditBrief(result())).toMatch(/onpage.title-too-short/);
  });

  it('fix overrides add your own guidance', async () => {
    const { buildFix, applyOverride } = await import('../src/fixes/index.js');
    const def = check('onpage.title-too-short').def;
    const fix = buildFix(def, [{ checkId: def.id, url: `${ORIGIN}/`, message: 'x' }], {
      stack: { id: 'wordpress', confidence: 1, signals: [] },
      site: ORIGIN,
      overrides: {
        [def.id]: { note: 'Titles are approved by marketing.', steps: ['Ask Sam first.'] },
      },
    });
    expect(fix.steps[0]).toMatch(/approved by marketing/);
    expect(fix.steps[1]).toBe('Ask Sam first.');
    expect(
      applyOverride({ steps: ['a'], files: [] }, { steps: ['b'], replace: true }).steps,
    ).toEqual(['b']);
  });
});

describe('Screaming Frog import', () => {
  it('parses CSV and audits the rows', async () => {
    const { parseCsv, siteFromScreamingFrog } = await import('../src/crawl/import-csv.js');
    expect(parseCsv('a,"b,c","d ""e"""\r\n1,2,3\n')).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['1', '2', '3'],
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'avc-sf-'));
    const file = join(dir, 'internal_all.csv');
    writeFileSync(
      file,
      [
        'Address,Content Type,Status Code,Indexability,Indexability Status,Title 1,Meta Description 1,H1-1,Canonical Link Element 1,Word Count,Crawl Depth,Response Time,Size (bytes)',
        `https://shop.test/,text/html; charset=UTF-8,200,Indexable,,Home,"A short one",Welcome,https://shop.test/,420,0,0.2,30000`,
        `https://shop.test/a,text/html; charset=UTF-8,200,Indexable,,,,,https://shop.test/a,30,1,0.3,20000`,
        `https://shop.test/gone,text/html; charset=UTF-8,404,Non-Indexable,Client Error,,,,,0,1,0.1,100`,
      ].join('\n'),
    );
    const site = siteFromScreamingFrog(file);
    expect(site.pages.size).toBe(3);
    const a = site.pages.get('https://shop.test/a')!;
    expect(a.title).toBeNull();
    expect(a.wordCount).toBe(30);
    const { runAudit } = await import('../src/audit/index.js');
    const { IMPORT_CHECKS } = await import('../src/cli/commands/tools.js');
    const r = await runAudit(
      {
        url: site.startUrl,
        config: {
          dataDir: dir,
          sites: [],
          ai: { maxRunUsd: 1, maxMonthUsd: 1, mock: true },
          server: { port: 1, host: 'x' },
        },
        only: IMPORT_CHECKS,
      },
      {
        crawlSite: async () => site,
        runAgenticProbes: async () => {},
        fetchAsBots: async () => {},
        collectExternal: async () => {},
      },
    );
    const ids = new Set(r.issues.map((i) => i.checkId));
    expect(ids.has('onpage.title-missing')).toBe(true);
    expect(ids.has('response.client-error')).toBe(true);
    expect(
      [...ids].every((id) => !id.startsWith('ai-crawlers.') && !id.startsWith('security.')),
    ).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('WordPress: canonical writes and redirects', () => {
  function fakeWp(state: { settings: Record<string, unknown>; plugins?: string[] }) {
    const json = (d: unknown, s = 200) =>
      new Response(JSON.stringify(d), {
        status: s,
        headers: { 'content-type': 'application/json' },
      });
    return (async (input: string, init?: RequestInit) => {
      const u = new URL(String(input));
      const route = u.pathname.replace(/^\/wp-json/, '') || '/';
      if (route === '/' || route === '')
        return json({ name: 'Shop', namespaces: ['wp/v2', 'avc/v1'] });
      if (route === '/avc/v1/status')
        return json({
          helper: '1.1.0',
          seoPlugin: 'yoast',
          seoPlugins: state.plugins ?? ['yoast'],
        });
      if (route === '/wp/v2/users/me') return json({ capabilities: { manage_options: true } });
      if (route === '/wp/v2/settings') {
        if (init?.method === 'POST') Object.assign(state.settings, JSON.parse(String(init.body)));
        return json(state.settings);
      }
      return json({ message: 'nope' }, 404);
    }) as never;
  }

  it('plans and applies a redirect with a rollback snapshot', async () => {
    const { addWordPressRedirect } = await import('../src/fixes/apply/index.js');
    const dir = mkdtempSync(join(tmpdir(), 'avc-wp-'));
    const state = { settings: { avc_redirects: '' } as Record<string, unknown> };
    const config = {
      dataDir: dir,
      sites: [],
      ai: { maxRunUsd: 1, maxMonthUsd: 1 },
      server: { port: 1, host: 'x' },
    } as AvcConfig;
    const site = {
      id: 'shop.test',
      url: 'https://shop.test/',
      connections: { wordpress: { url: 'https://shop.test', user: 'u', appPassword: 'p' } },
    };
    const dry = await addWordPressRedirect({
      config,
      site,
      from: '/old',
      to: '/new',
      dryRun: true,
      fetch: fakeWp(state),
    });
    expect(dry.plan.changes[0]!.after).toBe(
      JSON.stringify([{ from: '/old', to: '/new', code: 301 }]),
    );
    expect(state.settings.avc_redirects).toBe('');
    const live = await addWordPressRedirect({
      config,
      site,
      from: '/old',
      to: '/new',
      dryRun: false,
      fetch: fakeWp(state),
    });
    expect(live.outcome.results[0]!.status).toBe('applied');
    expect(JSON.parse(String(state.settings.avc_redirects))).toEqual([
      { from: '/old', to: '/new', code: 301 },
    ]);
    expect(live.outcome.snapshotFile).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('cleanSelfUrl strips tracking parameters and fragments', async () => {
    const { cleanSelfUrl, CANONICAL_SELF } = await import('../src/fixes/apply/wordpress.js');
    expect(cleanSelfUrl('https://e.com/p?utm_source=x&id=2#top')).toBe('https://e.com/p?id=2');
    expect(CANONICAL_SELF.has('canonical.keeps-parameters')).toBe(true);
  });

  let php = true;
  try {
    execFileSync('php', ['-v']);
  } catch {
    php = false;
  }
  it.skipIf(!php)('helper PHP: canonical, redirects and the two-plugin guard', async () => {
    const { WP_HELPER_PHP } = await import('../src/fixes/apply/wp-helper.js');
    const dir = mkdtempSync(join(tmpdir(), 'avc-php2-'));
    writeFileSync(join(dir, 'avc-helper.php'), WP_HELPER_PHP);
    writeFileSync(
      join(dir, 'run.php'),
      `<?php
define('ABSPATH', '/');
define('WPSEO_VERSION', '25.0');
class WP_Error { public $code; function __construct($c, $m = '', $d = null) { $this->code = $c; } }
$GLOBALS['meta'] = array(); $GLOBALS['opts'] = array('avc_redirects' => '[{"from":"/old/","to":"https://shop.test/new","code":301}]'); $GLOBALS['hooks'] = array(); $GLOBALS['redirect'] = null;
function add_action($h, $cb, $p = 10) { $GLOBALS['hooks'][$h][] = $cb; }
function add_filter($h, $cb, $p = 10, $a = 1) { $GLOBALS['hooks'][$h][] = $cb; }
function get_post_meta($id, $k, $single) { return $GLOBALS['meta'][$id][$k] ?? ''; }
function update_post_meta($id, $k, $v) { $GLOBALS['meta'][$id][$k] = $v; }
function get_option($k, $d = '') { return $GLOBALS['opts'][$k] ?? $d; }
function sanitize_text_field($s) { return trim(strip_tags($s)); }
function sanitize_textarea_field($s) { return trim(strip_tags($s)); }
function esc_url_raw($u) { return $u; }
function untrailingslashit($s) { return rtrim($s, '/'); }
function wp_safe_redirect($to, $code, $by) { $GLOBALS['redirect'] = array($to, $code); throw new Exception('redirected'); }
require __DIR__ . '/avc-helper.php';
avc_helper_set_seo(5, array('canonical' => 'https://shop.test/p'));
$_SERVER['REQUEST_URI'] = '/old?x=1';
try { foreach ($GLOBALS['hooks']['template_redirect'] as $cb) $cb(); } catch (Exception $e) {}
echo json_encode(array('meta' => $GLOBALS['meta'][5], 'canonical' => avc_helper_get_seo(5)['canonical'], 'redirect' => $GLOBALS['redirect'], 'plugins' => avc_helper_seo_plugins()));
`,
    );
    const out = JSON.parse(execFileSync('php', [join(dir, 'run.php')], { encoding: 'utf8' }));
    expect(out.meta._yoast_wpseo_canonical).toBe('https://shop.test/p');
    expect(out.canonical).toBe('https://shop.test/p');
    expect(out.redirect).toEqual(['https://shop.test/new', 301]);
    expect(out.plugins).toEqual(['yoast']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('CLI helpers', () => {
  it('versions, launchers and feedback links', async () => {
    const t = await import('../src/cli/commands/tools.js');
    expect(t.compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(t.compareVersions('v2.0.0', '1.9.9')).toBe(1);
    expect(t.compareVersions('1.0.0', '1.0')).toBe(0);
    expect(t.desktopEntry('/usr/bin/node', '/opt/avc/bin/avc.mjs')).toContain(
      'Exec="/usr/bin/node" "/opt/avc/bin/avc.mjs" ui',
    );
    expect(t.shortcutPaths('/home/x', 'linux')[0]).toBe(
      '/home/x/.local/share/applications/avc-dashboard.desktop',
    );
    expect(t.shortcutPaths('/Users/x', 'darwin')[0]).toMatch(
      /Applications\/AI Visibility Checker\.app$/,
    );
    expect(t.feedbackUrl('It works')).toMatch(
      /^https:\/\/github\.com\/Devs-Core-Company\/ai-visibility-checker\/issues\/new\?title=It\+works/,
    );
    expect(await t.latestVersion((async () => new Response('{"version":"9.9.9"}')) as never)).toBe(
      '9.9.9',
    );
  });

  it('crawl flags become crawl options', async () => {
    const { crawlFlags } = await import('../src/cli/commands/audit.js');
    const c = crawlFlags(
      {
        format: 'html',
        out: 'x',
        preset: 'auto',
        removeParam: ['utm_source'],
        rewrite: ['/old/=>/new/'],
        extract: ['price=css:.price'],
        subdomains: true,
        maxFolderDepth: 4,
      },
      ['node', 'avc', '--no-follow-nofollow', '--no-mobile'],
    );
    expect(c).toMatchObject({
      preset: 'auto',
      removeParams: ['utm_source'],
      rewrite: [{ pattern: '/old/', replace: '/new/' }],
      extract: [{ name: 'price', type: 'css', expr: '.price' }],
      subdomains: true,
      maxFolderDepth: 4,
      followNofollow: false,
      mobileRender: false,
    });
    expect(() => crawlFlags({ format: 'html', out: 'x', rewrite: ['bad'] }, [])).toThrow(
      /regex=>replacement/,
    );
  });
});

describe('MCP: parity tools', () => {
  let tmp = '';
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'avc-mcp2-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('registers list_audits, pagespeed, generate_report, serp_preview, ask_audit, create_redirect and rollback', async () => {
    process.env.AVC_DATA_DIR = tmp;
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { buildMcpServer } = await import('../src/mcp/server.js');
    const server = buildMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of [
      'list_audits',
      'pagespeed',
      'generate_report',
      'serp_preview',
      'ask_audit',
      'create_redirect',
      'rollback',
    ])
      expect(names).toContain(n);
    await client.close();
  });
});

describe('parity: crawler robustness and detection', () => {
  it('converts simple XPath to CSS', async () => {
    const { xpathToCss, checkExtractors } = await import('../src/crawl/options.js');
    expect(xpathToCss('//div[@class="price"]/span/text()')).toEqual({
      css: 'div[class="price"] > span',
    });
    expect(xpathToCss("//meta[@name='description']/@content")).toEqual({
      css: 'meta[name="description"]',
      attr: 'content',
    });
    expect(xpathToCss('//ul[2]//a[contains(@href,"blog")]/@href')).toEqual({
      css: 'ul:nth-of-type(2) a[href*="blog"]',
      attr: 'href',
    });
    expect(xpathToCss('//div[position()>1]')).toBeNull();
    expect(checkExtractors([{ name: 'x', type: 'xpath', expr: 'count(//a)' }]).errors).toHaveLength(
      1,
    );
  });

  it('retries 429 answers and caps URLs per depth', async () => {
    const { createServer } = await import('node:http');
    const { crawlSite } = await import('../src/crawl/index.js');
    let hits = 0;
    const links = Array.from({ length: 8 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('');
    const srv = createServer((req, res) => {
      if (req.url === '/busy' && hits++ === 0) {
        res.writeHead(429, { 'retry-after': '0' });
        return res.end('slow down');
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><html><head><title>t</title></head><body><a href="/busy">busy</a>${links}</body></html>`,
      );
    }).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const origin = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const site = await crawlSite({
        startUrl: `${origin}/`,
        render: false,
        delayMs: 0,
        checkImages: false,
        useSitemaps: false,
        maxPerDepth: 4,
      });
      expect(site.pages.get(`${origin}/busy`)?.status).toBe(200);
      const depth1 = [...site.pages.values()].filter((p) => p.depth === 1);
      expect(depth1.length).toBeLessThanOrEqual(4);
    } finally {
      srv.close();
    }
  });

  it('detects Magento and Laravel', async () => {
    const { detectStack } = await import('../src/crawl/stack.js');
    const mk = (html: string) => makePage({ html, generator: null });
    expect(detectStack([mk('<script type="text/x-magento-init">{}</script>')], {}).id).toBe(
      'magento',
    );
    expect(
      detectStack([mk('<div wire:id="a"></div>')], { 'set-cookie': 'laravel_session=x; path=/' })
        .id,
    ).toBe('laravel');
    const { presetForStack } = await import('../src/crawl/presets.js');
    expect(presetForStack('magento')?.id).toBe('magento');
    expect(presetForStack('laravel')?.id).toBe('laravel');
  });

  it('uses a custom OpenAI-compatible endpoint for helpers only', async () => {
    const { languageModel } = await import('../src/ai/engines.js');
    const config = {
      dataDir: tmpdir(),
      sites: [],
      ai: {
        maxRunUsd: 1,
        maxMonthUsd: 1,
        openaiKey: 'k',
        openaiBaseUrl: 'http://localhost:11434/v1',
      },
      server: { port: 1, host: 'x' },
    } as AvcConfig;
    const entry = { engine: 'chatgpt' as const, via: 'direct' as const, model: 'llama3' };
    const helper = languageModel(entry, config, 'helper') as unknown as { provider: string };
    const engine = languageModel(entry, config) as unknown as { provider: string };
    expect(helper.provider).toMatch(/chat/);
    expect(engine.provider).not.toMatch(/chat/);
  });
});

describe('parity: own CDN hosts', () => {
  it('does not count listed CDN hosts as third party', async () => {
    const { isOwnCdn } = await import('../src/checks/performance.js');
    const site = makeSite([makeHome()]);
    site.options.cdns = ['assets.example-cdn.net'];
    expect(isOwnCdn('assets.example-cdn.net', site)).toBe(true);
    expect(isOwnCdn('img.assets.example-cdn.net', site)).toBe(true);
    expect(isOwnCdn('www.googletagmanager.com', site)).toBe(false);
  });
});
