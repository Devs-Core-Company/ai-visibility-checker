/** Shared fixtures for audit, monitor and report tests. */
import type { AvcConfig } from '../src/core/config.js';
import type {
  AuditResult,
  Check,
  CheckDef,
  PageData,
  SiteContext,
  VisibilityRun,
} from '../src/core/types.js';

export function page(url: string, over: Partial<PageData> = {}): PageData {
  return {
    url,
    finalUrl: url,
    depth: 0,
    status: 200,
    redirects: [],
    headers: {},
    contentType: 'text/html',
    isHtml: true,
    bytes: 1000,
    ttfbMs: 100,
    totalMs: 200,
    discoveredFrom: [],
    inSitemap: true,
    blockedByRobots: false,
    html: '<html></html>',
    lang: 'en',
    title: `Title ${url}`,
    titleCount: 1,
    metaDescription: 'A description',
    metaDescriptionCount: 1,
    metaRobots: null,
    botMeta: {},
    xRobotsTag: null,
    canonical: url,
    canonicalCount: 1,
    canonicalHeader: null,
    viewport: 'width=device-width',
    charset: 'utf-8',
    og: {},
    twitter: {},
    headings: [{ level: 1, text: 'Heading' }],
    links: [],
    images: [],
    scripts: [],
    stylesheets: [],
    structuredData: [{ format: 'json-ld', types: ['Organization'], raw: {} }],
    hreflang: [],
    pagination: { next: null, prev: null },
    favicon: null,
    text: 'hello world',
    wordCount: 300,
    mainText: null,
    lead: '',
    contentHash: 'x',
    simhash: '0',
    forms: [],
    iframes: [],
    mixedContent: [],
    inlineStyleBytes: 0,
    inlineScriptBytes: 0,
    generator: null,
    ...over,
  };
}

export function site(pages: PageData[], over: Partial<SiteContext> = {}): SiteContext {
  return {
    startUrl: 'https://example.com/',
    origin: 'https://example.com',
    host: 'example.com',
    pages: new Map(pages.map((p) => [p.url, p])),
    inlinks: new Map(),
    robots: {
      url: 'https://example.com/robots.txt',
      status: 200,
      found: true,
      body: 'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /private\n',
      sitemaps: [],
      isAllowed: () => true,
      decidingLine: () => null,
    },
    sitemaps: [],
    stack: { id: 'nextjs', confidence: 0.9, signals: [] },
    probes: new Map(),
    botFetches: [],
    browserFetch: null,
    external: {},
    fetcher: {
      fetch: async () => {
        throw new Error('no network in tests');
      },
    },
    options: {} as SiteContext['options'],
    stats: {
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:01:00Z',
      pagesCrawled: pages.length,
      pagesQueuedNotCrawled: 0,
      maxPages: 500,
      maxDepth: 10,
      rendered: 0,
      errors: 0,
      durationMs: 60000,
    },
    ...over,
  };
}

export function def(id: string, over: Partial<CheckDef> = {}): CheckDef {
  return {
    id,
    category: 'onpage',
    pillar: 'content',
    title: `Check ${id}`,
    why: 'Because it matters.',
    severity: 'medium',
    scope: 'page',
    fixTier: 'guided',
    fix: 'Fix it.',
    ...over,
  };
}

export function pageCheck(
  d: CheckDef,
  run: (p: PageData) => ReturnType<Extract<Check, { kind: 'page' }>['run']>,
): Check {
  return { kind: 'page', def: d, run };
}

export function siteCheck(
  d: CheckDef,
  run: () => ReturnType<Extract<Check, { kind: 'site' }>['run']>,
): Check {
  return { kind: 'site', def: { ...d, scope: 'site' }, run };
}

export const config: AvcConfig = {
  dataDir: '/tmp/avc-test-unused',
  sites: [],
  ai: { maxRunUsd: 3, maxMonthUsd: 30, mock: true },
  server: { port: 4317, host: '127.0.0.1' },
};

export function visibilityRun(
  over: Partial<VisibilityRun['summary']> = {},
  id = 'v1',
): VisibilityRun {
  return {
    id,
    at: '2026-01-01T00:00:00Z',
    brand: {
      name: 'Example',
      domain: 'example.com',
      aliases: [],
      services: [],
      competitors: [{ name: 'Rival' }],
    },
    prompts: [
      { id: 'p1', text: 'best example agency', kind: 'category', search: true },
      { id: 'p2', text: 'example vs rival', kind: 'comparison', search: true },
    ],
    answers: [
      {
        engine: 'chatgpt',
        model: 'm',
        promptId: 'p1',
        prompt: 'best example agency',
        answer: 'Example is good.',
        citations: [{ url: 'https://example.com/a', domain: 'example.com', ownSite: true }],
        searchQueries: [],
        mentioned: true,
        position: 1,
        brandsNamed: ['Example', 'Rival'],
        sentiment: 'positive',
        factIssues: [],
        costUsd: 0.01,
        ms: 100,
      },
      {
        engine: 'claude',
        model: 'm',
        promptId: 'p2',
        prompt: 'example vs rival',
        answer: 'Rival is good.',
        citations: [
          { url: 'https://rival.com/', domain: 'rival.com', ownSite: false, competitor: 'Rival' },
        ],
        searchQueries: [],
        mentioned: false,
        position: null,
        brandsNamed: ['Rival'],
        sentiment: null,
        factIssues: [],
        costUsd: 0.01,
        ms: 100,
      },
    ],
    summary: {
      mentionRate: 0.5,
      byEngine: {
        chatgpt: { mentionRate: 1, avgPosition: 1, answers: 1, citedOwnSite: 1 },
        claude: { mentionRate: 0, avgPosition: null, answers: 1, citedOwnSite: 0 },
      },
      shareOfVoice: [
        { name: 'Example', share: 0.4, mentions: 1, isBrand: true },
        { name: 'Rival', share: 0.6, mentions: 2, isBrand: false },
      ],
      topCitedDomains: [
        { domain: 'rival.com', count: 1 },
        { domain: 'example.com', count: 1 },
      ],
      ownPagesCited: [{ url: 'https://example.com/a', count: 1 }],
      competitorWins: [
        {
          promptId: 'p2',
          prompt: 'example vs rival',
          winner: 'Rival',
          engines: ['claude'],
          sources: ['https://rival.com/'],
        },
      ],
      sentiment: { positive: 1, neutral: 0, negative: 0 },
      factIssues: 0,
      costUsd: 0.02,
      ...over,
    },
  };
}

/** A minimal but valid audit result. */
export function minimalResult(over: Partial<AuditResult> = {}): AuditResult {
  return {
    id: 'a1',
    version: '1.0.0',
    site: 'https://example.com',
    startUrl: 'https://example.com/',
    at: '2026-01-01T00:00:00.000Z',
    stack: { id: 'unknown', confidence: 0, signals: [] },
    stats: site([]).stats,
    pages: [],
    issues: [],
    checks: {},
    score: { overall: 0, grade: 'F', pillars: [] },
    priorities: [],
    probes: [],
    botFetches: [],
    robots: { found: false, status: null, body: '' },
    sitemaps: [],
    external: {},
    ...over,
  };
}
