/**
 * Unit tests for the AI-readiness module: bot list, challenge detection,
 * verdicts, llms.txt parsing, validators (against the .well-known fixtures),
 * AI preference parsing, GEO score and the check registry rules.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_ROOT } from './fixtures/serve.js';
import { extractPage } from '../src/crawl/extract.js';
import { buildRobots } from '../src/crawl/robots.js';
import {
  AI_BOTS,
  botByUserAgent,
  detectChallenge,
  verdictFor,
  parseLlmsTxt,
  geoPageScore,
  validateAgentCard,
  validateMcpCard,
  validateOAuthAS,
  validatePRM,
  validateApiCatalog,
  validateSignatureDirectory,
  validateOpenId,
  validateX402,
  parseAiPreference,
  inspectFeed,
  parseLinkHeader,
} from '../src/agentic/index.js';
import { parseRobots } from '../src/checks/_ai-util.js';
import { checks as aiCrawlers } from '../src/checks/ai-crawlers.js';
import { checks as llmsTxt } from '../src/checks/llms-txt.js';
import { checks as geo } from '../src/checks/geo.js';
import { checks as entity } from '../src/checks/entity.js';
import { checks as agentic } from '../src/checks/agentic.js';
import type {
  Check,
  FetchResult,
  Fetcher,
  Issue,
  PageData,
  SiteContext,
} from '../src/core/types.js';

const ORIGIN = 'https://example.com';
const fixture = (p: string) =>
  JSON.parse(
    readFileSync(join(FIXTURE_ROOT, '.well-known', p), 'utf8').replaceAll('{{ORIGIN}}', ORIGIN),
  );

function fetchResult(
  url: string,
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): FetchResult {
  return {
    url,
    finalUrl: url,
    status,
    ok: status >= 200 && status < 300,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    redirects: [],
    body,
    bytes: body.length,
    truncated: false,
    contentType: headers['content-type'] ?? 'text/html; charset=utf-8',
    ttfbMs: 10,
    totalMs: 20,
  };
}

function page(path: string, html: string, headers: Record<string, string> = {}): PageData {
  return extractPage(fetchResult(`${ORIGIN}${path}`, html, 200, headers), {
    origin: ORIGIN,
    depth: path === '/' ? 0 : 1,
  });
}

const noFetch: Fetcher = {
  async fetch(url) {
    return { ...fetchResult(url, '', 0), error: 'offline' };
  },
};

function site(pages: PageData[], robotsBody = '', robotsStatus: number | null = 200): SiteContext {
  return {
    startUrl: `${ORIGIN}/`,
    origin: ORIGIN,
    host: 'example.com',
    pages: new Map(pages.map((p) => [p.url, p])),
    inlinks: new Map(),
    robots: buildRobots(`${ORIGIN}/robots.txt`, robotsBody, {
      status: robotsStatus,
      found: robotsStatus === 200 && robotsBody.length > 0,
    }),
    sitemaps: [],
    stack: { id: 'unknown', confidence: 0, signals: [] },
    probes: new Map(),
    botFetches: [],
    browserFetch: null,
    external: {},
    fetcher: noFetch,
    options: {
      startUrl: `${ORIGIN}/`,
      maxPages: 10,
      maxDepth: 3,
      concurrency: 1,
      delayMs: 0,
      userAgent: 'test',
      respectRobots: true,
      render: false,
      renderLimit: 0,
      useSitemaps: false,
      checkExternalLinks: false,
      checkImages: false,
      timeoutMs: 1000,
      maxBytes: 1e6,
    },
    stats: {
      startedAt: '',
      finishedAt: '',
      pagesCrawled: pages.length,
      pagesQueuedNotCrawled: 0,
      maxPages: 10,
      maxDepth: 3,
      rendered: 0,
      errors: 0,
      durationMs: 0,
    },
  };
}

const ALL: Check[] = [...aiCrawlers, ...llmsTxt, ...geo, ...entity, ...agentic];

async function run(id: string, s: SiteContext): Promise<Issue[]> {
  const c = ALL.find((x) => x.def.id === id)!;
  const out: Issue[] = [];
  if (c.kind === 'site') {
    const r = await c.run(s);
    if (r) out.push(...(Array.isArray(r) ? r : [r]));
  } else
    for (const p of s.pages.values()) {
      const r = c.run(p, s);
      if (r) out.push(...(Array.isArray(r) ? r : [r]));
    }
  return out;
}

describe('check registry', () => {
  it('has at least 90 checks with unique, correctly prefixed ids', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(90);
    const ids = ALL.map((c) => c.def.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of ALL) {
      expect(c.def.id.startsWith(`${c.def.category}.`), c.def.id).toBe(true);
      expect(c.def.id).toMatch(/^[a-z-]+\.[a-z0-9-]+$/);
      expect(c.def.why.length, c.def.id).toBeGreaterThan(40);
      expect(c.def.fix.length, c.def.id).toBeGreaterThan(10);
      expect(c.def.scope).toBe(c.kind);
    }
    expect(aiCrawlers.every((c) => c.def.pillar === 'ai-access')).toBe(true);
    expect(llmsTxt.every((c) => c.def.pillar === 'ai-access')).toBe(true);
    expect([...geo, ...entity].every((c) => c.def.pillar === 'geo')).toBe(true);
    expect(agentic.every((c) => c.def.pillar === 'agentic')).toBe(true);
  });

  it('checks do not throw on an empty site', async () => {
    const s = site([]);
    for (const c of ALL) if (c.kind === 'site') await c.run(s);
  });
});

describe('bots', () => {
  it('has unique tokens and a review date', () => {
    const tokens = AI_BOTS.map((b) => b.token.toLowerCase());
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(AI_BOTS.length).toBeGreaterThanOrEqual(35);
  });

  it('identifies bots from user agents', () => {
    for (const b of AI_BOTS.filter((x) => x.ua))
      expect(botByUserAgent(b.ua!)?.token, b.token).toBe(b.token);
    expect(botByUserAgent('Mozilla/5.0 (Macintosh) Chrome/141 Safari/537.36')).toBeUndefined();
    expect(botByUserAgent('Mozilla/5.0 (compatible; Claude-SearchBot/1.0)')?.token).toBe(
      'Claude-SearchBot',
    );
    expect(botByUserAgent('NotGPTBotish')).toBeUndefined();
  });
});

describe('challenge detection and verdicts', () => {
  it('names the product', () => {
    expect(detectChallenge(403, { 'cf-mitigated': 'challenge' }, '')).toBe('cloudflare');
    expect(detectChallenge(503, {}, '<title>Just a moment...</title>')).toBe('cloudflare');
    expect(detectChallenge(429, {}, '<h1>Vercel Security Checkpoint</h1>')).toBe('vercel');
    expect(
      detectChallenge(403, {}, '<script src="https://geo.captcha-delivery.com/x"></script>'),
    ).toBe('datadome');
    expect(detectChallenge(403, {}, 'Access Denied ... Reference #18.2f3e')).toBe('akamai');
    expect(detectChallenge(403, {}, '<div id="px-captcha"></div>')).toBe('perimeterx');
    expect(detectChallenge(403, {}, 'Incapsula incident ID: 123')).toBe('imperva');
    expect(detectChallenge(403, {}, 'Access Denied - Sucuri Website Firewall')).toBe('sucuri');
    expect(
      detectChallenge(200, {}, '<p>Please verify you are human</p><div class="g-recaptcha"></div>'),
    ).toBe('captcha');
    expect(detectChallenge(200, {}, '<html><body><h1>Welcome</h1></body></html>')).toBeNull();
  });

  it('compares with the browser', () => {
    const ok = { status: 200, words: 500, challenge: null };
    expect(verdictFor(ok, ok)).toBe('ok');
    expect(verdictFor({ status: 403, words: 3, challenge: null }, ok)).toBe('blocked');
    expect(verdictFor({ status: 200, words: 100, challenge: null }, ok)).toBe('differs');
    expect(
      verdictFor(
        { status: 403, words: 3, challenge: null },
        { status: 403, words: 3, challenge: 'cloudflare' },
      ),
    ).toBe('inconclusive');
    expect(verdictFor({ status: 0, words: 0, challenge: null, error: 'ECONNRESET' }, ok)).toBe(
      'error',
    );
  });
});

describe('llms.txt', () => {
  it('parses the llmstxt.org structure', () => {
    const p = parseLlmsTxt(
      '# Acme\n\n> Widgets for UK makers.\n\nDetails here.\n\n## Docs\n- [Guide](https://a.com/g): how to\n- [Rel](/r)\n- text only\n\n## Optional\n- [Old](https://a.com/o)\n',
      'https://a.com/llms.txt',
    );
    expect(p.title).toBe('Acme');
    expect(p.summary).toBe('Widgets for UK makers.');
    expect(p.details).toBe('Details here.');
    expect(p.sections.map((s) => s.name)).toEqual(['Docs', 'Optional']);
    expect(p.links).toHaveLength(3);
    expect(p.links[0]!.note).toBe('how to');
    expect(p.links[1]!.abs).toBe('https://a.com/r');
    expect(p.relativeLinks).toBe(1);
    expect(p.nonLinkItems).toHaveLength(1);
  });

  it('parses the fixture llms-full.txt as markdown', () => {
    const p = parseLlmsTxt(readFileSync(join(FIXTURE_ROOT, 'llms-full.txt'), 'utf8'));
    expect(p.firstIsH1).toBe(true);
    expect(p.sections.length).toBeGreaterThanOrEqual(2);
  });
});

describe('validators', () => {
  it('accepts the valid fixtures', () => {
    expect(validateAgentCard(fixture('agent-card.json')).errors).toEqual([]);
    expect(validateMcpCard(fixture('mcp/server-card.json')).errors).toEqual([]);
    expect(validateMcpCard(fixture('mcp/server-card.json')).info.authRequired).toBe(true);
    expect(validateOAuthAS(fixture('oauth-authorization-server'), ORIGIN)).toMatchObject({
      valid: true,
      warnings: [],
    });
    expect(validatePRM(fixture('oauth-protected-resource'), ORIGIN).valid).toBe(true);
    expect(validateApiCatalog(fixture('api-catalog'), 'application/linkset+json')).toMatchObject({
      valid: true,
      warnings: [],
    });
    expect(
      validateSignatureDirectory(fixture('http-message-signatures-directory'), {
        'content-type': 'application/http-message-signatures-directory+json',
        signature: 'x',
        'signature-input': 'y',
      }),
    ).toMatchObject({ valid: true, warnings: [] });
  });

  it('rejects broken documents', () => {
    const card = fixture('agent-card.json');
    delete card.skills;
    card.url = 'http://agents.example.com/a2a';
    const v = validateAgentCard(card);
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toMatch(/skills/);
    expect(v.errors.join(' ')).toMatch(/HTTPS/);
    expect(
      validateOAuthAS(
        { ...fixture('oauth-authorization-server'), issuer: 'https://login.other.com' },
        ORIGIN,
      ).valid,
    ).toBe(false);
    expect(
      validateOAuthAS({
        ...fixture('oauth-authorization-server'),
        code_challenge_methods_supported: ['plain'],
      }).warnings.join(' '),
    ).toMatch(/S256/);
    expect(validatePRM({ authorization_servers: [] }).valid).toBe(false);
    expect(validateOpenId({ issuer: ORIGIN }).errors.length).toBeGreaterThan(3);
    expect(validateApiCatalog({ items: [] }).valid).toBe(false);
    expect(
      validateSignatureDirectory({
        keys: [{ kty: 'OKP', crv: 'Ed25519', x: 'a', d: 'secret' }],
      }).errors.join(' '),
    ).toMatch(/private key/);
    expect(validateMcpCard({ description: 'x' }).valid).toBe(false);
    expect(
      validateX402({
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base',
            payTo: '0xabc',
            maxAmountRequired: '1000',
            description: 'Report',
          },
        ],
      }).valid,
    ).toBe(true);
    expect(validateX402({ accepts: [] }).valid).toBe(false);
  });

  it('parses AI preference lines, feeds and Link headers', () => {
    expect(parseAiPreference('Content-Signal', 'search=yes, ai-train=no', 3)).toMatchObject({
      values: { search: 'yes', 'ai-train': 'no' },
      problems: [],
    });
    expect(parseAiPreference('Content-Usage', 'train-ai=n', 4)!.problems).toEqual([]);
    expect(parseAiPreference('Content-Signal', 'ai-training=maybe', 5)!.problems.length).toBe(2);
    expect(parseAiPreference('Disallow', '/', 1)).toBeNull();
    expect(inspectFeed('<rss><channel><item></item><item></item></channel></rss>')).toMatchObject({
      kind: 'rss',
      items: 2,
    });
    expect(
      parseLinkHeader(
        '</.well-known/api-catalog>; rel="api-catalog", <https://x.com/a>; rel=alternate',
        ORIGIN,
      ),
    ).toEqual({
      'api-catalog': [`${ORIGIN}/.well-known/api-catalog`],
      alternate: ['https://x.com/a'],
    });
  });

  it('parses robots groups and extras', () => {
    const r = parseRobots(
      'User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\nCrawl-delay: 30\n\nUser-agent: *\nAllow: /\nContent-Signal: search=yes\nSitemap: https://x.com/s.xml',
    );
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0]!.agents).toEqual(['GPTBot', 'ClaudeBot']);
    expect(r.groups[0]!.crawlDelay?.value).toBe(30);
    expect(r.extras[0]).toMatchObject({ key: 'content-signal', line: 8 });
    expect(r.sitemaps[0]!.url).toBe('https://x.com/s.xml');
  });
});

describe('page and site checks on hand-built sites', () => {
  it('robots.txt 5xx is critical', async () => {
    const s = site([page('/', '<html><body><h1>Hi</h1></body></html>')], '', 503);
    expect(await run('ai-crawlers.robots-server-error', s)).toHaveLength(1);
  });

  it('empty app shell and snippet opt-outs', async () => {
    const shell = page(
      '/app',
      '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
    );
    const nosnip = page(
      '/n',
      `<html><head><title>N</title><meta name="robots" content="max-snippet:0, noai"></head><body><main><h1>N</h1><p>${'word '.repeat(200)}</p></main></body></html>`,
    );
    const s = site([shell, nosnip]);
    expect((await run('ai-crawlers.empty-shell', s))[0]?.url).toBe(`${ORIGIN}/app`);
    expect((await run('ai-crawlers.page-nosnippet', s))[0]?.url).toBe(`${ORIGIN}/n`);
    expect((await run('ai-crawlers.page-noai', s))[0]?.url).toBe(`${ORIGIN}/n`);
  });

  it('wildcard rules catching AI bots and legacy Anthropic tokens', async () => {
    const s = site(
      [page('/', '<html><body><h1>Hi</h1></body></html>')],
      'User-agent: *\nDisallow: /\n\nUser-agent: Googlebot\nAllow: /\n\nUser-agent: anthropic-ai\nDisallow: /\n',
    );
    const w = await run('ai-crawlers.wildcard-catches-ai', s);
    expect(w[0]?.evidence).toContain('OAI-SearchBot');
    expect(await run('ai-crawlers.googlebot-blocked', s)).toHaveLength(0);
    expect(await run('ai-crawlers.legacy-tokens-only', s)).toHaveLength(0); // ClaudeBot is blocked via *
  });

  it('GEO score rewards an answer-first, sourced, dated article', () => {
    const good = page(
      '/blog/what-is-geo',
      `<html><head><title>What is GEO?</title><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: 'What is GEO?', author: { '@type': 'Person', name: 'Ana Lee', url: `${ORIGIN}/authors/ana` }, datePublished: '2026-09-01', dateModified: '2026-09-20' })}</script></head><body><main><article><h1>What is GEO?</h1><p class="byline">By Ana Lee</p><time datetime="2026-09-20">20 September 2026</time><p>Generative engine optimisation (GEO) is the practice of making content easy for AI answer engines such as ChatGPT and Perplexity to find, quote and cite.</p><h2>How is GEO different from SEO?</h2><p>SEO targets ranked links; GEO targets the passages an engine quotes in 2026.</p><ul><li>Answer first</li><li>Cite sources</li></ul><table><tr><td>SEO</td><td>GEO</td></tr></table><h2>What does it cost?</h2><p>Most audits take 3 to 5 days and cost £1,500 according to <a href="https://www.ons.gov.uk/x">ONS data</a>.</p><h2>Why do sources matter?</h2><p>Engines prefer 12% more cited passages.</p></article></main></body></html>`,
    );
    const bad = page(
      '/blog/x',
      `<html><head><title>X</title></head><body><main><h1>Our world-class seamless solutions</h1><p>Welcome to our blog! ${'lorem ipsum dolor '.repeat(120)}</p></main></body></html>`,
    );
    expect(geoPageScore(good).score).toBeGreaterThanOrEqual(75);
    expect(geoPageScore(bad).score).toBeLessThan(35);
    expect(geoPageScore(bad).tips.length).toBeGreaterThan(0);
  });
});
