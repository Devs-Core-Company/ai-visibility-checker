/**
 * End to end for the AI-readiness module: a local site with a firewall that
 * challenges some AI bots, discovery documents from test/fixtures/site/.well-known,
 * a flawed llms.txt and GEO/commerce pages. Crawl → probes → bot fetch → checks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import type { AddressInfo } from 'node:net';
import { FIXTURE_ROOT } from './fixtures/serve.js';
import { crawlSite } from '../src/crawl/index.js';
import {
  fetchAsBots,
  runAgenticProbes,
  sampleBotFetches,
  llmsTxtGrade,
  geoPageScore,
} from '../src/agentic/index.js';
import { checks as aiCrawlers } from '../src/checks/ai-crawlers.js';
import { checks as llmsTxt } from '../src/checks/llms-txt.js';
import { checks as geo } from '../src/checks/geo.js';
import { checks as entity } from '../src/checks/entity.js';
import { checks as agentic } from '../src/checks/agentic.js';
import type { Check, Issue, SiteContext } from '../src/core/types.js';

const ALL: Check[] = [...aiCrawlers, ...llmsTxt, ...geo, ...entity, ...agentic];

let origin = '';
let server: ReturnType<typeof createServer>;
let site: SiteContext;
let issues: Issue[] = [];

const html = (title: string, body: string, head = '') =>
  `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const nav = `<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/services">Services</a> <a href="/blog/what-is-a-widget">Guide</a> <a href="/products/blue-widget">Blue widget</a> <a href="/contact">Contact</a></nav></header>`;
const footer = `<footer><a href="https://www.linkedin.com/company/acme-widgets">LinkedIn</a> <a href="https://github.com/acme-widgets">GitHub</a></footer>`;

const words = (n: number, seed = 'widgets') =>
  Array.from({ length: n }, (_, i) => `${seed}${i % 7 === 0 ? '.' : ''}`).join(' ');

function pages(): Record<string, string> {
  const org = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${origin}/#organization`,
        name: 'Acme Widgets',
        url: `${origin}/`,
        logo: `${origin}/logo.png`,
        sameAs: ['https://www.linkedin.com/company/acme-widgets'],
      },
      { '@type': 'WebSite', name: 'Acme Widgets', url: `${origin}/` },
    ],
  };
  const article = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: 'What is a widget?',
    author: { '@type': 'Person', name: 'Jane Smith' },
    datePublished: '2026-08-01',
    dateModified: '2026-07-01',
    publisher: { '@type': 'Organization', name: 'Widget World Media', logo: `${origin}/logo.png` },
  };
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'How much does a widget cost?',
        acceptedAnswer: {
          '@type': 'Answer',
          text: 'A standard widget costs £40 including VAT and delivery in the UK.',
        },
      },
      {
        '@type': 'Question',
        name: 'Do you ship widgets to Mars?',
        acceptedAnswer: { '@type': 'Answer', text: 'No.' },
      },
    ],
  };
  const product = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Blue widget',
    offers: { '@type': 'Offer', price: '40.00', url: `${origin}/products/blue-widget` },
  };
  const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  return {
    '/': html(
      'Acme Widgets',
      `${nav}<main><h1>Acme Widgets</h1><p>Acme Widgets makes steel widgets for UK manufacturers, from single prototypes to runs of 10,000.</p><form role="search" action="/search"><input type="search" name="q"></form><p>${words(120)}</p></main>${footer}`,
      `<meta property="og:site_name" content="Acme Widget Company">${ld(org)}`,
    ),
    '/about': html(
      'About Acme Widgets',
      `${nav}<main><h1>About us</h1><p>${words(200, 'history')}</p></main>${footer}`,
    ),
    '/services': html(
      'Services',
      `${nav}<main><h1>Services</h1><p>Acme Widgets provides world-class, cutting-edge, seamless widget solutions with unparalleled synergy for every customer.</p><p>${words(200, 'service')}</p></main>${footer}`,
    ),
    '/contact': html(
      'Contact',
      `${nav}<main><h1>Contact us</h1><p>Use the form below to ask for a quote on any widget order.</p><form action="/send" method="post" toolname="request_quote"><input type="text" name="name"><input type="email" name="email"><textarea></textarea><div class="g-recaptcha"></div><button>Send</button></form><p>${words(160, 'contact')}</p></main>${footer}`,
    ),
    '/blog/what-is-a-widget': html(
      'What is a widget? | Acme Widgets',
      `${nav}<main><article><h1>What is a widget?</h1><p>Welcome to our blog! In this post we will talk about many things.</p><h2>How much does a widget cost?</h2><p>A standard widget costs £40 including VAT and delivery in the UK.</p><h2>FAQ</h2><p>${words(400, 'detail')}</p><h2>Further reading</h2><p>${words(300, 'more')}</p></article></main>${footer}`,
      `${ld(article)}${ld(faq)}`,
    ),
    '/products/blue-widget': html(
      'Blue widget | Acme Widgets',
      `${nav}<main><h1>Blue widget</h1><p>${words(200, 'blue')}</p></main>${footer}`,
      ld(product),
    ),
  };
}

function robots(): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Content-Signal: search=yes, ai-train=no, foo=maybe',
    '',
    'User-agent: OAI-SearchBot',
    'Disallow: /',
    '',
    'User-agent: GPT-Bot',
    'Disallow: /',
    '',
    'User-agent: Claude-SearchBot',
    'Disallow: /blog/',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
  ].join('\n');
}

function llms(): string {
  return [
    '# Acme Widgets',
    '',
    '## Pages',
    `- [Services](${origin}/services)`,
    `- [Missing page](${origin}/gone)`,
    '- [Contact](/contact): how to reach us',
    '- just some text',
  ].join('\n');
}

async function wellKnown(path: string): Promise<string | null> {
  const file = normalize(join(FIXTURE_ROOT, path));
  if (!file.startsWith(FIXTURE_ROOT)) return null;
  try {
    return (await readFile(file, 'utf8')).replaceAll('{{ORIGIN}}', origin);
  } catch {
    return null;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const u = new URL(req.url ?? '/', origin);
  const ua = String(req.headers['user-agent'] ?? '');
  const accept = String(req.headers.accept ?? '');
  const send = (
    status: number,
    body: string,
    type = 'text/html; charset=utf-8',
    extra: Record<string, string> = {},
  ) => {
    res.writeHead(status, { 'content-type': type, ...extra });
    res.end(body);
  };
  // Firewall: Cloudflare-style challenge for PerplexityBot, plain 403 for ClaudeBot,
  // and a path rule for Claude-User on /services.
  if (/PerplexityBot/i.test(ua))
    return send(
      403,
      '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>',
      'text/html',
      { 'cf-mitigated': 'challenge' },
    );
  if (/ClaudeBot/i.test(ua)) return send(403, 'Forbidden', 'text/plain');
  if (/Claude-User/i.test(ua) && u.pathname === '/services')
    return send(403, 'Forbidden', 'text/plain');

  if (u.pathname === '/robots.txt') return send(200, robots(), 'text/plain; charset=utf-8');
  if (u.pathname === '/llms.txt') return send(200, llms(), 'text/plain');
  if (u.pathname === '/llms-full.txt')
    return send(200, (await wellKnown('llms-full.txt'))!, 'text/markdown; charset=utf-8');
  if (u.pathname === '/sitemap.xml')
    return send(
      200,
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Object.keys(
        pages(),
      )
        .map((p) => `<url><loc>${origin}${p}</loc></url>`)
        .join('')}</urlset>`,
      'application/xml',
    );
  if (u.pathname.startsWith('/.well-known/')) {
    const body = await wellKnown(u.pathname);
    if (body === null) return send(404, html('Not found', '<h1>Not found</h1>'));
    const type = u.pathname.endsWith('api-catalog')
      ? 'application/linkset+json'
      : u.pathname.includes('signatures-directory')
        ? 'application/http-message-signatures-directory+json'
        : 'application/json';
    const cors = u.pathname.includes('agent-card') ? {} : { 'access-control-allow-origin': '*' };
    return send(200, body, type, cors);
  }
  if (u.pathname === '/openapi.json')
    return send(
      200,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Acme API', version: '1' },
        paths: { '/widgets': { get: {} } },
      }),
      'application/json',
    );
  const page = pages()[u.pathname];
  if (page) {
    if (accept.includes('text/markdown') && u.pathname === '/')
      return send(
        200,
        '# Acme Widgets\n\nAcme makes steel widgets.',
        'text/markdown; charset=utf-8',
      );
    const headers: Record<string, string> =
      u.pathname === '/' ? { link: `<${origin}/.well-known/api-catalog>; rel="api-catalog"` } : {};
    return send(200, page, 'text/html; charset=utf-8', headers);
  }
  return send(404, html('Not found', '<h1>Not found</h1><p>Sorry.</p>'));
}

async function runAll(s: SiteContext): Promise<Issue[]> {
  const out: Issue[] = [];
  for (const c of ALL) {
    if (c.kind === 'site') {
      const r = await c.run(s);
      if (r) out.push(...(Array.isArray(r) ? r : [r]));
    } else {
      for (const p of s.pages.values()) {
        const r = c.run(p, s);
        if (r) out.push(...(Array.isArray(r) ? r : [r]));
      }
    }
  }
  return out;
}

const ids = () => new Set(issues.map((i) => i.checkId));
const find = (id: string) => issues.filter((i) => i.checkId === id);

beforeAll(async () => {
  server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  site = await crawlSite({
    startUrl: `${origin}/`,
    render: false,
    delayMs: 0,
    maxPages: 30,
    checkImages: false,
    timeoutMs: 5000,
  });
  await runAgenticProbes(site);
  await fetchAsBots(site);
  issues = await runAll(site);
}, 60_000);

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('probes', () => {
  it('finds and parses the discovery documents', () => {
    for (const id of [
      'llms-txt',
      'llms-full-txt',
      'mcp-server-card',
      'a2a-agent-card',
      'oauth-as',
      'oauth-prm',
      'api-catalog',
      'openapi-json',
      'openapi-linked',
      'web-bot-auth',
      'md-home',
      'robots-ai-signals',
      'link-headers',
    ])
      expect(site.probes.get(id)?.found, id).toBe(true);
    for (const id of [
      'mcp-json',
      'a2a-agent-json',
      'openid-config',
      'ai-plugin',
      'ucp-profile',
      'feed',
    ])
      expect(site.probes.get(id)?.found, id).toBe(false);
    expect(
      (site.probes.get('link-headers')!.parsed as Record<string, string[]>)['api-catalog'],
    ).toEqual([`${origin}/.well-known/api-catalog`]);
  });

  it('keeps the request budget', () => {
    const fetched = [...site.probes.values()].filter(
      (p) => !['robots-ai-signals', 'link-headers'].includes(p.id),
    );
    expect(fetched.length).toBeLessThanOrEqual(30);
  });
});

describe('bot fetch', () => {
  it('compares bots with the browser and names the challenge', () => {
    expect(site.browserFetch?.status).toBe(200);
    const by = (t: string) => site.botFetches.find((b) => b.token === t)!;
    expect(by('PerplexityBot').verdict).toBe('blocked');
    expect(by('PerplexityBot').challenge).toBe('cloudflare');
    expect(by('ClaudeBot').verdict).toBe('blocked');
    expect(by('ClaudeBot').challenge).toBeNull();
    expect(by('GPTBot').verdict).toBe('ok');
  });

  it('samples key pages and catches path-level blocking', () => {
    const sample = sampleBotFetches(site)!;
    expect(sample.length).toBeGreaterThan(0);
    const services = sample.find((s) => s.url.endsWith('/services'));
    expect(services?.bots.find((b) => b.token === 'Claude-User')?.verdict).toBe('blocked');
    expect(find('ai-crawlers.sample-pages-blocked').some((i) => i.url?.endsWith('/services'))).toBe(
      true,
    );
  });
});

describe('ai-crawlers checks', () => {
  it('reports robots and firewall findings', () => {
    expect(find('ai-crawlers.search-bots-blocked')[0]?.evidence).toContain('OAI-SearchBot');
    expect(ids().has('ai-crawlers.misspelt-tokens')).toBe(true);
    expect(ids().has('ai-crawlers.firewall-challenge')).toBe(true);
    expect(ids().has('ai-crawlers.live-blocked')).toBe(true);
    expect(ids().has('ai-crawlers.backwards-policy')).toBe(true);
    expect(ids().has('ai-crawlers.googlebot-blocked')).toBe(false);
    expect(ids().has('ai-crawlers.robots-server-error')).toBe(false);
  });
});

describe('llms-txt checks', () => {
  it('validates structure and links', () => {
    for (const id of [
      'llms-txt.no-summary',
      'llms-txt.relative-links',
      'llms-txt.malformed-items',
      'llms-txt.broken-links',
      'llms-txt.quality-grade',
    ])
      expect(ids().has(id), id).toBe(true);
    expect(ids().has('llms-txt.missing')).toBe(false);
    expect(ids().has('llms-txt.no-h1')).toBe(false);
    const g = llmsTxtGrade(site)!;
    expect(g.grade).toBeGreaterThan(0);
    expect(g.grade).toBeLessThan(80);
    expect(g.reasons.length).toBeGreaterThan(0);
  });
});

describe('geo and entity checks', () => {
  it('flags the article', () => {
    const art = `${origin}/blog/what-is-a-widget`;
    const on = (id: string) => find(id).some((i) => i.url === art);
    expect(on('geo-content.no-answer-first')).toBe(true);
    expect(on('geo-content.faq-schema-mismatch')).toBe(true);
    expect(on('geo-content.date-invalid')).toBe(true);
    expect(on('geo-content.no-definition')).toBe(true);
    expect(find('geo-content.vague-language').some((i) => i.url?.endsWith('/services'))).toBe(true);
    const score = geoPageScore(
      site.pages.get(art) ?? [...site.pages.values()].find((p) => p.url === art)!,
    );
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(100);
  });

  it('flags entity gaps', () => {
    for (const id of [
      'geo-entity.brand-inconsistent',
      'geo-entity.publisher-mismatch',
      'geo-entity.org-no-contact',
      'geo-entity.social-not-in-sameas',
    ])
      expect(ids().has(id), id).toBe(true);
    expect(ids().has('geo-entity.no-organization')).toBe(false);
    expect(ids().has('geo-entity.no-about-page')).toBe(false);
  });
});

describe('agentic checks', () => {
  it('accepts valid fixtures and flags real problems', () => {
    for (const id of [
      'agentic.mcp-card-invalid',
      'agentic.a2a-card-invalid',
      'agentic.oauth-as-invalid',
      'agentic.prm-invalid',
      'agentic.oauth-issuer-mismatch',
      'agentic.oauth-no-pkce',
      'agentic.mcp-auth-no-prm',
      'agentic.api-catalog-invalid',
    ])
      expect(ids().has(id), id).toBe(false);
    for (const id of [
      'agentic.markdown-no-vary',
      'agentic.ai-preferences-invalid',
      'agentic.ai-preferences-conflict',
      'agentic.wellknown-no-cors',
      'agentic.webmcp-form-incomplete',
      'agentic.captcha-only-form',
      'agentic.no-search-action',
    ])
      expect(ids().has(id), id).toBe(true);
    expect(find('agentic.web-bot-auth-invalid')[0]?.evidence).toContain('not signed');
  });

  it('checks product data', () => {
    expect(ids().has('agentic-commerce.product-no-identifier')).toBe(true);
    expect(find('agentic-commerce.offer-incomplete')[0]?.evidence).toContain('priceCurrency');
  });

  it('never emits evidence over 500 characters', () => {
    for (const i of issues) expect((i.evidence ?? '').length).toBeLessThanOrEqual(500);
  });
});
