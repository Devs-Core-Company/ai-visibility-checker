import { describe, expect, it } from 'vitest';

import type { AvcConfig } from '../src/core/config.js';
import type { PageData, SiteContext, TrackedPrompt, VisibilityRun } from '../src/core/types.js';
import {
  availableEngines,
  Budget,
  compareRuns,
  engineStatus,
  estimateCost,
  explainGaps,
  extractSiteFacts,
  heuristicJudge,
  inferBrand,
  lookupEntity,
  mergeBrand,
  mockAnswer,
  namesBrand,
  runCeiling,
  runVisibility,
  suggestPrompts,
  summarise,
  templatePrompts,
} from '../src/ai/index.js';
import { checkFactByRules } from '../src/ai/judge.js';

function cfg(ai: Partial<AvcConfig['ai']> = {}): AvcConfig {
  return {
    dataDir: '/tmp/avc-test',
    sites: [],
    ai: { maxRunUsd: 3, maxMonthUsd: 30, ...ai },
    server: { port: 4317, host: '127.0.0.1' },
  };
}

function page(url: string, p: Partial<PageData> = {}): PageData {
  return {
    url,
    finalUrl: url,
    depth: 1,
    status: 200,
    redirects: [],
    headers: {},
    contentType: 'text/html',
    isHtml: true,
    bytes: 1000,
    ttfbMs: 50,
    totalMs: 100,
    discoveredFrom: [],
    inSitemap: true,
    blockedByRobots: false,
    html: '',
    lang: 'en',
    title: null,
    titleCount: 1,
    metaDescription: null,
    metaDescriptionCount: 1,
    metaRobots: null,
    botMeta: {},
    xRobotsTag: null,
    canonical: null,
    canonicalCount: 0,
    canonicalHeader: null,
    viewport: null,
    charset: 'utf-8',
    og: {},
    twitter: {},
    headings: [],
    links: [],
    images: [],
    scripts: [],
    stylesheets: [],
    structuredData: [],
    hreflang: [],
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
    generator: null,
    ...p,
  };
}

const ORG = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'ProfessionalService',
      name: 'Acme Ledger',
      alternateName: 'Acme',
      url: 'https://acmeledger.com/',
      description: 'Bookkeeping and payroll for small businesses in Manchester.',
      foundingDate: '2018-03-01',
      address: { '@type': 'PostalAddress', addressLocality: 'Manchester', addressCountry: 'GB' },
      sameAs: ['https://www.linkedin.com/company/acme-ledger'],
    },
    { '@type': 'WebSite', name: 'Acme Ledger', url: 'https://acmeledger.com/' },
  ],
};

function makeSite(): SiteContext {
  const home = page('https://acmeledger.com/', {
    depth: 0,
    title: 'Bookkeeping in Manchester | Acme Ledger',
    metaDescription: 'Bookkeeping and payroll for small businesses in Manchester.',
    og: { 'og:site_name': 'Acme Ledger' },
    headings: [
      { level: 1, text: 'Bookkeeping for small businesses' },
      { level: 2, text: 'What we do' },
    ],
    links: [
      {
        href: 'https://acmeledger.com/services/bookkeeping',
        text: 'Bookkeeping',
        rel: [],
        internal: true,
        region: 'nav',
      },
      {
        href: 'https://acmeledger.com/services/payroll',
        text: 'Payroll',
        rel: [],
        internal: true,
        region: 'nav',
      },
      {
        href: 'https://acmeledger.com/services/',
        text: 'All services',
        rel: [],
        internal: true,
        region: 'nav',
      },
      {
        href: 'https://acmeledger.com/about',
        text: 'About',
        rel: [],
        internal: true,
        region: 'nav',
      },
    ],
    structuredData: [{ format: 'json-ld', types: ['ProfessionalService', 'WebSite'], raw: ORG }],
    text: 'Acme Ledger keeps the books for small businesses in Manchester. Founded in 2018.',
    mainText: 'Acme Ledger keeps the books for small businesses in Manchester. Founded in 2018.',
    wordCount: 250,
    lead: 'Acme Ledger keeps the books for small businesses.',
  });
  const about = page('https://acmeledger.com/about', {
    title: 'About | Acme Ledger',
    text: 'We are based in Manchester and have worked with 40 local firms since 2018.',
    mainText: 'We are based in Manchester and have worked with 40 local firms since 2018.',
    wordCount: 120,
  });
  const bookkeeping = page('https://acmeledger.com/services/bookkeeping', {
    depth: 1,
    title: 'Bookkeeping services | Acme Ledger',
    headings: [{ level: 1, text: 'Bookkeeping services' }],
    text: 'Monthly bookkeeping for small businesses.',
    mainText: 'Monthly bookkeeping for small businesses.',
    wordCount: 180,
    lead: 'Monthly bookkeeping for small businesses.',
  });
  const pages = new Map([home, about, bookkeeping].map((p) => [p.url, p]));
  return {
    startUrl: 'https://acmeledger.com/',
    origin: 'https://acmeledger.com',
    host: 'acmeledger.com',
    pages,
    inlinks: new Map(),
    robots: {} as SiteContext['robots'],
    sitemaps: [],
    stack: { id: 'static', confidence: 1, signals: [] },
    probes: new Map(),
    botFetches: [],
    browserFetch: null,
    external: {},
    fetcher: {
      fetch: async () => {
        throw new Error('no network');
      },
    },
    options: {} as SiteContext['options'],
    stats: {} as SiteContext['stats'],
  };
}

describe('engines', () => {
  it('uses mock when no keys are set', () => {
    const e = availableEngines(cfg());
    expect(e.map((x) => x.engine)).toEqual(
      expect.arrayContaining(['chatgpt', 'claude', 'gemini', 'perplexity']),
    );
    expect(e.every((x) => x.via === 'mock')).toBe(true);
  });

  it('prefers direct keys, falls back to the gateway, marks Copilot unavailable', () => {
    const s = engineStatus(cfg({ openaiKey: 'sk-x', gatewayKey: 'gw', xaiKey: 'xai' }));
    const by = Object.fromEntries(s.map((x) => [x.engine, x]));
    expect(by.chatgpt).toMatchObject({ via: 'direct', model: 'gpt-5.4-mini', available: true });
    expect(by.claude).toMatchObject({ via: 'gateway', model: 'anthropic/claude-haiku-4.5' });
    expect(by.grok).toMatchObject({ via: 'direct', available: true, default: true });
    expect(by.copilot.available).toBe(false);
    expect(by.copilot.note).toMatch(/no public API/);
  });

  it('marks engines without a key unavailable when only some keys exist', () => {
    const by = Object.fromEntries(
      engineStatus(cfg({ anthropicKey: 'a' })).map((x) => [x.engine, x]),
    );
    expect(by.claude.available).toBe(true);
    expect(by.chatgpt.available).toBe(false);
    expect(by.chatgpt.note).toMatch(/OPENAI_API_KEY/);
  });

  it('respects model overrides', () => {
    const by = Object.fromEntries(
      engineStatus(cfg({ gatewayKey: 'g', models: { chatgpt: 'gpt-5.4' } })).map((x) => [
        x.engine,
        x,
      ]),
    );
    expect(by.chatgpt.model).toBe('openai/gpt-5.4');
  });
});

describe('pricing and budget', () => {
  it('estimates cost from tokens and searches', () => {
    expect(estimateCost('openai/gpt-5.4-mini', { inputTokens: 1e6, outputTokens: 0 })).toBeCloseTo(
      0.75,
    );
    expect(estimateCost('sonar', { inputTokens: 0, outputTokens: 0 }, 1, 'perplexity')).toBeCloseTo(
      0.005,
    );
  });

  it('caps by run and remaining month', () => {
    expect(runCeiling(cfg({ maxRunUsd: 3, maxMonthUsd: 30 }), 29)).toBe(1);
    expect(runCeiling(cfg({ maxRunUsd: 3, maxMonthUsd: 30 }), 40)).toBe(0);
    const b = new Budget(1);
    expect(b.tryReserve(0.6)).toBe(true);
    expect(b.tryReserve(0.6)).toBe(false);
    b.settle(0.6, 0.2);
    expect(b.tryReserve(0.6)).toBe(true);
  });

  it('skips every call when the month is already spent', async () => {
    const site = makeSite();
    const brand = inferBrand(site);
    const run = await runVisibility({
      brand,
      prompts: templatePrompts(brand).slice(0, 2),
      config: cfg({ openaiKey: 'sk-test', maxMonthUsd: 5 }),
      engines: ['chatgpt'],
      monthSpendUsd: 5,
      entity: false,
    });
    expect(run.answers.length).toBe(2);
    expect(run.answers.every((a) => a.error?.includes('spend ceiling'))).toBe(true);
    expect(run.summary.costUsd).toBe(0);
  });
});

describe('brand', () => {
  it('infers the brand from schema, nav and pages', () => {
    const b = inferBrand(makeSite());
    expect(b.name).toBe('Acme Ledger');
    expect(b.domain).toBe('acmeledger.com');
    expect(b.aliases).toEqual(expect.arrayContaining(['Acme', 'acmeledger.com']));
    expect(b.location).toBe('Manchester, GB');
    expect(b.services).toEqual(expect.arrayContaining(['Bookkeeping', 'Payroll']));
    expect(b.services).not.toContain('All services');
    expect(b.description).toMatch(/Bookkeeping/);
  });

  it('falls back to the domain when there is no schema', () => {
    const site = makeSite();
    site.pages = new Map([
      [
        'https://acmeledger.com/',
        page('https://acmeledger.com/', { depth: 0, title: 'Home - Acmeledger' }),
      ],
    ]);
    expect(inferBrand(site).name).toBe('Acmeledger');
  });

  it('merges owner overrides', () => {
    const b = mergeBrand(inferBrand(makeSite()), {
      location: 'Salford, UK',
      competitors: [{ name: 'Ledgerly' }],
    });
    expect(b.location).toBe('Salford, UK');
    expect(b.competitors[0]!.name).toBe('Ledgerly');
  });

  it('extracts site facts', () => {
    const f = extractSiteFacts(makeSite(), inferBrand(makeSite()));
    expect(f.foundedYear).toBe(2018);
    expect(f.locations[0]).toMatch(/Manchester/);
  });
});

describe('prompts', () => {
  it('writes templates that never name the brand in category or problem prompts', async () => {
    const site = makeSite();
    const brand = {
      ...inferBrand(site),
      industry: 'restaurants',
      competitors: [{ name: 'Ledgerly' }],
    };
    const ps = await suggestPrompts(brand, site, { config: cfg({ mock: true }), count: 20 });
    expect(ps.some((p) => p.kind === 'brand' && !p.search)).toBe(true);
    expect(ps.some((p) => p.kind === 'comparison' && p.text.includes('Ledgerly'))).toBe(true);
    expect(ps.some((p) => /Best .* in Manchester/.test(p.text))).toBe(true);
    expect(ps.some((p) => /for restaurants/.test(p.text))).toBe(true);
    for (const p of ps.filter((x) => x.kind === 'category' || x.kind === 'problem'))
      expect(namesBrand(p.text, brand)).toBe(false);
    expect(new Set(ps.map((p) => p.id)).size).toBe(ps.length);
  });

  it('keeps custom prompts first', async () => {
    const brand = inferBrand(makeSite());
    const custom: TrackedPrompt[] = [
      { id: 'mine', text: 'Who does payroll for cafés?', kind: 'custom', search: true },
    ];
    const ps = await suggestPrompts(brand, undefined, { custom, count: 5 });
    expect(ps[0]!.id).toBe('mine');
    expect(ps).toHaveLength(5);
  });
});

describe('judge', () => {
  const brand = { ...inferBrand(makeSite()), competitors: [{ name: 'Ledgerly' }] };

  it('finds position, competitors and sentiment in a list answer', () => {
    const j = heuristicJudge(
      'Here are options:\n1. **Northwind Books** — popular.\n2. **Acme Ledger** — reliable and well reviewed, founded in 2015.\n3. Ledgerly: cheap.',
      brand,
    );
    expect(j.mentioned).toBe(true);
    expect(j.position).toBe(2);
    expect(j.brandsNamed).toEqual(['Northwind Books', 'Acme Ledger', 'Ledgerly']);
    expect(j.sentiment).toBe('positive');
    expect(j.facts).toContain('Founded in 2015');
  });

  it('does not count "no information" as a mention', () => {
    const j = heuristicJudge("I don't have reliable information about Acme Ledger.", brand);
    expect(j.mentioned).toBe(false);
  });

  it('checks facts against the site by rules', () => {
    const facts = extractSiteFacts(makeSite(), brand);
    expect(checkFactByRules('Founded in 2015', facts)).toMatchObject({
      verdict: 'wrong',
      siteSays: 'Founded in 2018',
    });
    expect(checkFactByRules('Founded in 2018', facts).verdict).toBe('matches');
    expect(checkFactByRules('Based in Manchester', facts).verdict).toBe('matches');
    expect(checkFactByRules('Based in Leeds', facts).verdict).toBe('wrong');
  });
});

describe('mock', () => {
  it('is deterministic per prompt, engine and repeat', () => {
    const brand = inferBrand(makeSite());
    const prompt = templatePrompts(brand).find((p) => p.kind === 'category')!;
    const a = mockAnswer({ engine: 'gemini', prompt, brand, repeat: 0 });
    const b = mockAnswer({ engine: 'gemini', prompt, brand, repeat: 0 });
    expect(a).toEqual(b);
    expect(a.text).toMatch(/mock mode/);
    expect(a.citations.length).toBeGreaterThan(0);
  });
});

describe('runVisibility (mock)', () => {
  async function demo(repeats = 3): Promise<{ run: VisibilityRun; site: SiteContext }> {
    const site = makeSite();
    const brand = {
      ...inferBrand(site),
      competitors: [{ name: 'Ledgerly', domain: 'ledgerly.example' }],
    };
    const prompts = templatePrompts(brand, site);
    const events: string[] = [];
    const run = await runVisibility({
      brand,
      prompts,
      site,
      config: cfg({ mock: true }),
      repeats,
      onProgress: (e) => events.push(e.type),
    });
    expect(events).toContain('phase');
    return { run, site };
  }

  it('runs every prompt × engine × repeat and summarises per the contract', async () => {
    const { run } = await demo();
    const perplexityNoSearch = run.prompts.filter((p) => !p.search).length * 3;
    expect(run.answers.length).toBe(run.prompts.length * 4 * 3 - perplexityNoSearch);
    const s = run.summary;
    expect(s.mentionRate).toBeGreaterThan(0);
    expect(s.mentionRate).toBeLessThan(1);
    expect(Object.keys(s.byEngine).sort()).toEqual(['chatgpt', 'claude', 'gemini', 'perplexity']);
    expect(s.byEngine.chatgpt!.answers).toBeGreaterThan(0);
    const share = s.shareOfVoice.reduce((t, x) => t + x.share, 0);
    expect(share).toBeCloseTo(1, 2);
    expect(s.shareOfVoice.filter((x) => x.isBrand)).toHaveLength(1);
    expect(s.topCitedDomains.length).toBeGreaterThan(0);
    expect(s.ownPagesCited.every((p) => p.url.includes('acmeledger.com'))).toBe(true);
    expect(s.competitorWins.length).toBeGreaterThan(0);
    expect(s.competitorWins[0]!.sources.length).toBeGreaterThan(0);
    expect(s.costUsd).toBe(0);
    expect(run.entity?.notes.join(' ')).toMatch(/not checked/);
    // The mock sometimes states a wrong founding year; the site says 2018.
    expect(s.factIssues).toBeGreaterThan(0);
    const issue = run.answers.flatMap((a) => a.factIssues).find((f) => f.verdict === 'wrong');
    expect(issue?.siteSays).toBe('Founded in 2018');
    // Competitor citations are attributed.
    expect(run.answers.some((a) => a.citations.some((c) => c.competitor))).toBe(true);
    // The summary can be recomputed from the answers.
    expect(summarise(run.answers, run.brand, run.prompts).mentionRate).toBe(s.mentionRate);
  });

  it('marks requested engines that cannot run with an error', async () => {
    const brand = inferBrand(makeSite());
    const run = await runVisibility({
      brand,
      prompts: templatePrompts(brand).slice(0, 2),
      config: cfg({ mock: true }),
      engines: ['chatgpt', 'copilot'],
    });
    const copilot = run.answers.filter((a) => a.engine === 'copilot');
    expect(copilot).toHaveLength(2);
    expect(copilot.every((a) => a.error)).toBe(true);
    expect(run.summary.byEngine.copilot!.answers).toBe(0);
  });

  it('marks failed answers and keeps going when an engine errors', async () => {
    const brand = inferBrand(makeSite());
    // A direct key that cannot reach the provider (no network in tests): every call fails fast.
    const run = await runVisibility({
      brand,
      prompts: templatePrompts(brand).slice(0, 2),
      config: cfg({ anthropicKey: 'bad', maxRunUsd: 1 }),
      engines: ['claude'],
      entity: false,
      signal: AbortSignal.timeout(20_000),
    });
    expect(run.answers.length).toBeGreaterThan(0);
    expect(run.answers.every((a) => a.error)).toBe(true);
    expect(run.summary.mentionRate).toBe(0);
  }, 60_000);

  it('stops on cancel', async () => {
    const brand = inferBrand(makeSite());
    const ac = new AbortController();
    ac.abort();
    const run = await runVisibility({
      brand,
      prompts: templatePrompts(brand),
      config: cfg({ mock: true }),
      signal: ac.signal,
    });
    expect(run.answers.every((a) => a.error === 'Cancelled')).toBe(true);
  });

  it('explains gaps with pages to build', async () => {
    const { run, site } = await demo(1);
    const gaps = explainGaps(run, site);
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) {
      expect(g.whyNotYou.length).toBeGreaterThan(0);
      expect(g.pagesToCreateOrImprove.length).toBeGreaterThan(0);
    }
    const all = gaps.flatMap((g) => g.pagesToCreateOrImprove.map((p) => p.suggestion)).join(' ');
    expect(all).toMatch(/clutch\.co/);
    expect(
      gaps.some((g) => g.pagesToCreateOrImprove.some((p) => p.url?.includes('acmeledger.com'))),
    ).toBe(true);
    // Works without a site too.
    expect(explainGaps(run).length).toBe(gaps.length);
  });

  it('compares runs', async () => {
    const { run: a } = await demo(1);
    const b: VisibilityRun = structuredClone(a);
    const target = b.prompts.find((p) => p.kind === 'category')!;
    for (const ans of b.answers)
      if (ans.promptId === target.id)
        ans.mentioned = !a.summary.competitorWins.some((w) => w.promptId === target.id)
          ? false
          : true;
    b.summary = summarise(b.answers, b.brand, b.prompts);
    b.summary.shareOfVoice.push({
      name: 'Brand New Rival',
      share: 0.1,
      mentions: 2,
      isBrand: false,
    });
    const d = compareRuns(a, b);
    expect(d.newCompetitors).toContain('Brand New Rival');
    expect([...d.lostPrompts, ...d.wonPrompts]).toContain(target.text);
    expect(typeof d.mentionRateDelta).toBe('number');
    expect(compareRuns(a, a)).toMatchObject({
      mentionRateDelta: 0,
      shareOfVoiceDelta: 0,
      lostPrompts: [],
      wonPrompts: [],
    });
  });
});

describe('entity', () => {
  it('reads Wikidata by domain and name with an injected fetch', async () => {
    const brand = inferBrand(makeSite());
    const fakeFetch = async (url: string) => {
      const body = url.includes('haswbstatement')
        ? { query: { search: [{ title: 'Q123' }] } }
        : { search: [{ id: 'Q123', label: 'Acme Ledger' }] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const e = await lookupEntity(brand, { sameAs: [], fetch: fakeFetch, kgKey: '' });
    expect(e.wikidataId).toBe('Q123');
    expect(e.notes.join(' ')).toMatch(/official website/);
  });
});
