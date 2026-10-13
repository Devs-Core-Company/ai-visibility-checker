/**
 * Checks added or tightened after benchmark run 1 (bench/results/CHANGES.md). Each is a
 * general rule from a public standard; these tests use made-up sites.
 */
import { describe, expect, it } from 'vitest';
import type { Check, Issue, PageData, SiteContext } from '../src/core/types.js';
import { ALL_CHECKS } from '../src/checks/index.js';
import { autocompleteProblem } from '../src/checks/accessibility.js';
import { securityTxtProblems } from '../src/checks/security.js';
import { isSchemaType, isSubtypeOf } from '../src/checks/schema-vocabulary.js';
import { jsonSchemaProblems, toolInputSchemaProblems } from '../src/agentic/validate.js';
import { samplePagesAcrossSections } from '../src/agentic/bot-fetch.js';
import { textWidthPx } from '../src/report/serp.js';
import { ORIGIN, htmlDoc, link, makeHome, makePage, makeSite } from './helpers/factories.js';

function check(id: string): Check {
  const c = ALL_CHECKS.find((x) => x.def.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}
const asList = (o: Issue[] | Issue | null | void | undefined): Issue[] =>
  !o ? [] : Array.isArray(o) ? o : [o];
async function run(id: string, site: SiteContext, page?: PageData): Promise<Issue[]> {
  const c = check(id);
  if (c.kind === 'site') return asList(await c.run(site));
  const pages = page ? [page] : [...site.pages.values()];
  return pages.flatMap((p) => asList(c.run(p, site)));
}
const one = (id: string, page: PageData, extra: PageData[] = []) =>
  run(id, makeSite([makeHome(), page, ...extra]), page);
const jsonLd = (raw: unknown): PageData['structuredData'] => [
  { format: 'json-ld', types: [], raw },
];
const rendered = (over: Partial<NonNullable<PageData['rendered']>> = {}) => ({
  html: htmlDoc(),
  text: '',
  wordCount: 0,
  title: null,
  links: 0,
  headings: [],
  structuredData: [],
  consoleErrors: [],
  failedRequests: [],
  ...over,
});

describe('schema vocabulary', () => {
  it('knows schema.org types and subtypes', () => {
    expect(isSchemaType('Dentist')).toBe(true);
    expect(isSchemaType('DentalPractice')).toBe(false);
    expect(isSubtypeOf('Dentist', 'LocalBusiness')).toBe(true);
    expect(isSubtypeOf('BlogPosting', 'LocalBusiness')).toBe(false);
  });
  it('flags types that do not exist, not other vocabularies', async () => {
    const bad = makePage({
      structuredData: jsonLd({ '@context': 'https://schema.org', '@type': 'WebShop', name: 'x' }),
    });
    expect(await one('schema.type-unknown', bad)).toHaveLength(1);
    const good = makePage({
      structuredData: jsonLd({ '@context': 'https://schema.org', '@type': 'Store' }),
    });
    expect(await one('schema.type-unknown', good)).toHaveLength(0);
    const other = makePage({
      structuredData: jsonLd({
        '@context': { foaf: 'http://xmlns.com/foaf/0.1/' },
        '@type': 'foaf:Person',
      }),
    });
    expect(await one('schema.type-unknown', other)).toHaveLength(0);
  });
});

describe('schema.date-order', () => {
  it('flags an end before the start', async () => {
    const ev = (end: string) =>
      makePage({
        structuredData: jsonLd({
          '@type': 'Event',
          startDate: '2026-11-20T18:00:00+00:00',
          endDate: end,
        }),
      });
    expect(await one('schema.date-order', ev('2026-11-20T16:00:00+00:00'))).toHaveLength(1);
    expect(await one('schema.date-order', ev('2026-11-20T20:00:00+00:00'))).toHaveLength(0);
    expect(await one('schema.date-order', ev('2026-11-20'))).toHaveLength(0);
  });
});

describe('schema.localbusiness-missing', () => {
  it('flags the one location page without LocalBusiness markup', async () => {
    const loc = (slug: string, withLb: boolean) =>
      makePage({
        url: `${ORIGIN}/branches/${slug}`,
        contentHash: slug,
        structuredData: withLb ? jsonLd({ '@type': 'Dentist', name: slug }) : [],
      });
    const site = makeSite([makeHome(), loc('a', true), loc('b', true), loc('c', false)]);
    const out = await run('schema.localbusiness-missing', site);
    expect(out.map((i) => i.url)).toEqual([`${ORIGIN}/branches/c`]);
  });
});

describe('geo-entity.nap-page-mismatch', () => {
  const page = (tel: string) =>
    makePage({
      url: `${ORIGIN}/branches/bath`,
      text: 'Call us on 01632 960 245 to book.',
      structuredData: jsonLd({
        '@type': 'Dentist',
        '@id': `${ORIGIN}/branches/bath#b`,
        telephone: tel,
      }),
    });
  it('flags a markup phone the page does not show', async () => {
    expect(await one('geo-entity.nap-page-mismatch', page('+44 1632 960999'))).toHaveLength(1);
    expect(await one('geo-entity.nap-page-mismatch', page('+44 1632 960245'))).toHaveLength(0);
  });
});

describe('security headers', () => {
  it('reports each page that lacks a header the other pages send', async () => {
    const withCsp = (path: string) =>
      makePage({
        url: `${ORIGIN}${path}`,
        headers: { 'content-type': 'text/html', 'x-content-type-options': 'nosniff' },
      });
    const without = makePage({ url: `${ORIGIN}/prices`, headers: { 'content-type': 'text/html' } });
    const site = makeSite([withCsp('/'), withCsp('/a'), withCsp('/b'), without]);
    const out = await run('security.nosniff-missing', site);
    expect(out.map((i) => i.url)).toEqual([`${ORIGIN}/prices`]);
  });
  it('reports version leaks on the pages that have them', async () => {
    const leak = makePage({
      url: `${ORIGIN}/legal`,
      headers: { 'content-type': 'text/html', server: 'Apache/2.4.29 (Ubuntu)' },
    });
    const site = makeSite([makeHome(), makePage(), leak]);
    const out = await run('security.version-disclosure', site);
    expect(out.map((i) => i.url)).toEqual([`${ORIGIN}/legal`]);
  });
  it('reads security.txt against RFC 9116', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    expect(securityTxtProblems('Contact: mailto:a@b.c\n', now)[0]).toMatch(/Expires/);
    expect(
      securityTxtProblems('Contact: mailto:a@b.c\nExpires: 2027-03-01T00:00:00Z\n', now),
    ).toEqual([]);
    expect(
      securityTxtProblems('Contact: mailto:a@b.c\nExpires: 2025-01-01T00:00:00Z\n', now)[0],
    ).toMatch(/passed/);
  });
});

describe('content and links', () => {
  it('finds main content copied from one other page', async () => {
    const para = (n: number) =>
      `<p>${`Paragraph ${n} talks about gum care and cleaning in detail. `.repeat(3)}</p>`;
    const copied = [1, 2, 3, 4].map(para).join('');
    const a = makePage({
      url: `${ORIGIN}/blog/a`,
      contentHash: 'a',
      html: htmlDoc({ body: `<h1>A</h1>${copied}` }),
    });
    const b = makePage({
      url: `${ORIGIN}/services/b`,
      contentHash: 'b',
      html: htmlDoc({ body: `<h1>B</h1>${copied}${[5, 6, 7, 8, 9].map(para).join('')}` }),
    });
    const out = await run('duplicates.copied-content', makeSite([makeHome(), a, b]));
    expect(out.map((i) => i.url)).toEqual([`${ORIGIN}/blog/a`]);
  });
  it('flags a single generic anchor', async () => {
    const p = makePage({ links: [link('/pricing', { text: 'Click here' })] });
    expect(await one('links-internal.generic-anchors', p)).toHaveLength(1);
  });
  it('flags elements other than <li> directly in a list', async () => {
    const p = makePage({ html: htmlDoc({ body: '<ul><div>Intro</div><li>a</li></ul>' }) });
    expect(await one('accessibility.list-structure', p)).toHaveLength(1);
    const ok = makePage({ html: htmlDoc({ body: '<ul><li>a</li><script></script></ul>' }) });
    expect(await one('accessibility.list-structure', ok)).toHaveLength(0);
  });
  it('flags one image without dimensions, but not one sized in CSS', async () => {
    const img = { src: `${ORIGIN}/a.jpg`, alt: 'a' };
    expect(await one('images.dimensions-missing', makePage({ images: [img] }))).toHaveLength(1);
    const css = makePage({
      images: [img],
      html: htmlDoc({ body: `<img src="${ORIGIN}/a.jpg" alt="a" style="aspect-ratio: 4/3">` }),
    });
    expect(await one('images.dimensions-missing', css)).toHaveLength(0);
  });
  it('keeps 149-character descriptions and flags long ones', async () => {
    const d149 =
      'How software and AI agents can find the clinic’s booking API, its machine-readable catalogue and the agent discovery files we publish for them.'.padEnd(
        149,
        '.',
      );
    expect(
      await one('onpage.description-too-long', makePage({ metaDescription: d149 })),
    ).toHaveLength(0);
    expect(
      await one(
        'onpage.description-too-long',
        makePage({ metaDescription: 'Long words here. '.repeat(14) }),
      ),
    ).toHaveLength(1);
    expect(textWidthPx('’', 1000)).toBe(222);
  });
  it('does not call a redirect loop a chain', async () => {
    const loop = makePage({
      url: `${ORIGIN}/x`,
      status: 0,
      redirects: [
        { url: `${ORIGIN}/x`, status: 301 },
        { url: `${ORIGIN}/y`, status: 301 },
        { url: `${ORIGIN}/x`, status: 0 },
      ],
    });
    expect(await one('redirects.chain', loop)).toHaveLength(0);
    expect(await one('redirects.loop', loop)).toHaveLength(1);
  });
});

describe('accessibility and agentic', () => {
  it('validates autocomplete tokens', () => {
    expect(autocompleteProblem('email')).toBeNull();
    expect(autocompleteProblem('section-a shipping work tel')).toBeNull();
    expect(autocompleteProblem('off')).toBeNull();
    expect(autocompleteProblem('e-mail')).toMatch(/not an autofill/);
    expect(autocompleteProblem('phone')).toMatch(/not an autofill/);
    expect(autocompleteProblem('work name')).toMatch(/not an autofill/);
  });
  it('reports a low-contrast sample from the render', async () => {
    const p = makePage({
      rendered: rendered({
        layout: {
          viewportWidth: 1366,
          images: [],
          lowContrast: [
            {
              text: 'Grey',
              ratio: 2,
              fg: 'rgb(184,184,184)',
              bg: 'rgb(255,255,255)',
              large: false,
            },
          ],
        },
      }),
    });
    expect(await one('accessibility.low-contrast-rendered', p)).toHaveLength(1);
  });
  it('reports elements styled as clickable that are not controls', async () => {
    const p = makePage({
      rendered: rendered({
        layout: {
          viewportWidth: 1366,
          images: [],
          lowContrast: [],
          pointerNonControls: [{ html: '<div class="btn">', text: 'Book' }],
        },
      }),
    });
    expect(await one('accessibility.clickable-div', p)).toHaveLength(1);
  });
  it('validates JSON Schema for WebMCP tools', async () => {
    expect(
      jsonSchemaProblems({
        type: 'object',
        properties: { d: { type: 'string' } },
        required: ['d'],
      }),
    ).toEqual([]);
    const bad = { type: 'objekt', properties: { d: { type: 'date' } }, required: 'd' };
    expect(jsonSchemaProblems(bad)).toHaveLength(3);
    expect(toolInputSchemaProblems({ type: 'string' })[0]).toMatch(/object/);
    const p = makePage({
      rendered: rendered({
        webmcpTools: [{ name: 't', description: 'd', hasSchema: true, inputSchema: bad }],
      }),
    });
    expect(await one('agentic.webmcp-schema-invalid', p)).toHaveLength(1);
  });
  it('flags a loading placeholder that JavaScript replaces', async () => {
    const p = makePage({
      wordCount: 50,
      text: 'x',
      html: htmlDoc({ body: '<h1>Prices</h1><div id="t"><p>Loading prices…</p></div>' }),
      rendered: rendered({
        wordCount: 120,
        html: htmlDoc({ body: '<h1>Prices</h1><table><tr><td>Check-up £55</td></tr></table>' }),
      }),
    });
    expect(await one('js-rendering.loading-placeholder', p)).toHaveLength(1);
  });
  it('flags a section blocked for one AI bot', async () => {
    const team = makePage({ url: `${ORIGIN}/team/a` });
    const site = makeSite([makeHome(), team], {
      robots: 'User-agent: ClaudeBot\nDisallow: /team/\n\nUser-agent: *\nAllow: /\n',
    });
    const out = await run('ai-crawlers.path-blocked', site);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toMatch(/ClaudeBot/);
  });
  it('samples bot fetches across sections', () => {
    const pages = ['/blog/a', '/blog/b', '/blog/c', '/shop/x', '/shop/y'].map((p) =>
      makePage({ url: `${ORIGIN}${p}`, contentHash: p }),
    );
    const site = makeSite([makeHome(['/blog/a', '/blog/b', '/blog/c']), ...pages]);
    const picked = samplePagesAcrossSections(site, 3).map((p) => new URL(p.url).pathname);
    expect(picked.some((p) => p.startsWith('/shop/'))).toBe(true);
  });
  it('flags dead A2A endpoints, API catalog links and markdown alternates', async () => {
    const md = makePage({
      url: `${ORIGIN}/about`,
      html: htmlDoc({
        head: `<link rel="alternate" type="text/markdown" href="${ORIGIN}/about.md">`,
      }),
    });
    const site = makeSite([makeHome(), md], {
      fetch: { [`${ORIGIN}/a2a`]: { status: 404 }, [`${ORIGIN}/openapi.json`]: { status: 404 } },
    });
    site.probes.set('a2a-agent-card', {
      id: 'a2a-agent-card',
      url: `${ORIGIN}/.well-known/agent-card.json`,
      status: 200,
      found: true,
      parsed: { name: 'x', url: `${ORIGIN}/a2a` },
    });
    site.probes.set('api-catalog', {
      id: 'api-catalog',
      url: `${ORIGIN}/.well-known/api-catalog`,
      status: 200,
      found: true,
      parsed: {
        linkset: [
          { anchor: `${ORIGIN}/api/`, 'service-desc': [{ href: `${ORIGIN}/openapi.json` }] },
        ],
      },
    });
    expect(await run('agentic.a2a-endpoint-unreachable', site)).toHaveLength(1);
    expect(await run('agentic.api-catalog-broken-link', site)).toHaveLength(1);
    const mdOut = await run('llms-txt.markdown-alternate-broken', site);
    expect(mdOut.map((i) => i.url)).toEqual([`${ORIGIN}/about`]);
  });
});
