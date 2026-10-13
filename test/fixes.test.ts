import { describe, expect, it } from 'vitest';
import type { AuditResult, CheckDef, Issue, PageSummary, StackInfo } from '../src/core/types.js';
import { buildFix, buildFixes, findRecipe } from '../src/fixes/index.js';
import {
  addSitemapLines,
  blockedAiTokens,
  extractFaqs,
  generateAgentCard,
  generateBreadcrumbJsonLd,
  generateFaqJsonLd,
  generateLlmsFullTxt,
  generateLlmsTxt,
  generateMetaSuggestions,
  generateOrganizationJsonLd,
  generateRobotsTxt,
  generateSitemapXml,
  inferBrandName,
  suggestMetaRules,
} from '../src/fixes/generate.js';
import { unifiedDiff } from '../src/fixes/apply/diff.js';

const ORIGIN = 'https://acme.test';

function page(path: string, over: Partial<PageSummary> = {}): PageSummary {
  const url = ORIGIN + path;
  return {
    url,
    finalUrl: url,
    status: 200,
    depth: path === '/' ? 0 : path.split('/').filter(Boolean).length,
    title: null,
    metaDescription: null,
    h1: null,
    wordCount: 400,
    canonical: url,
    indexable: true,
    inlinks: 3,
    outlinks: 10,
    bytes: 20000,
    ttfbMs: 100,
    schemaTypes: [],
    issues: 0,
    inSitemap: true,
    ...over,
  };
}

const PAGES: PageSummary[] = [
  page('/', {
    title: 'Acme Plumbing – Plumbers in Leeds',
    metaDescription: 'Same-day plumbers in Leeds.',
    inlinks: 20,
  }),
  page('/services/boilers', {
    title: 'Boiler repair | Acme Plumbing',
    metaDescription: 'Boiler repair and servicing.',
    h1: 'Boiler repair',
  }),
  page('/services/drains', { title: 'Blocked drains | Acme Plumbing', h1: 'Blocked drains' }),
  page('/blog/fix-a-leak', {
    title: 'How to fix a leak | Acme Plumbing',
    h1: 'How to fix a leak',
    inlinks: 1,
  }),
  page('/blog/boiler-pressure', { title: 'Boiler pressure explained | Acme Plumbing' }),
  page('/contact', { title: 'Contact | Acme Plumbing' }),
  page('/privacy-policy', { title: 'Privacy policy | Acme Plumbing' }),
  page('/tag/boilers', { title: 'Boilers | Acme Plumbing' }),
  page('/old', { status: 404, title: 'Not found' }),
  page('/hidden', { indexable: false, title: 'Hidden | Acme Plumbing' }),
];

function def(id: string, over: Partial<CheckDef> = {}): CheckDef {
  return {
    id,
    category: id.split('.')[0] as CheckDef['category'],
    pillar: 'ai-access',
    title: `Check ${id}`,
    why: 'Because it matters.',
    severity: 'high',
    scope: 'site',
    fixTier: 'guided',
    fix: 'Do the stack-neutral thing.',
    ...over,
  };
}

const stack = (id: StackInfo['id'], over: Partial<StackInfo> = {}): StackInfo => ({
  id,
  confidence: 0.9,
  signals: [],
  ...over,
});

describe('generators', () => {
  it('infers the brand from shared title segments', () => {
    expect(inferBrandName({ site: ORIGIN, pages: PAGES })).toBe('Acme Plumbing');
  });

  it('builds llms.txt from crawl data', () => {
    const txt = generateLlmsTxt({ site: ORIGIN, pages: PAGES });
    expect(txt.startsWith('# Acme Plumbing\n\n> Same-day plumbers in Leeds.')).toBe(true);
    expect(txt).toContain('## Services');
    expect(txt).toContain(
      '- [Boiler repair](https://acme.test/services/boilers): Boiler repair and servicing.',
    );
    expect(txt).toContain('## Blog');
    expect(txt).toContain('## Optional');
    expect(txt).toMatch(/## Optional\n\n- \[Privacy policy\]/);
    expect(txt).not.toContain('/tag/');
    expect(txt).not.toContain('/old');
    expect(txt).not.toContain('/hidden');
  });

  it('builds llms-full.txt with supplied text', () => {
    const full = generateLlmsFullTxt(
      { site: ORIGIN, pages: PAGES },
      { texts: { [`${ORIGIN}/contact`]: 'Call 0113 000 0000.' } },
    );
    expect(full).toContain('Source: https://acme.test/contact\n\nCall 0113 000 0000.');
  });

  it('rewrites robots.txt for AI bots and keeps other rules', () => {
    const current = `User-agent: *\nDisallow: /admin/\nDisallow: /cart\n\nUser-agent: GPTBot\nUser-agent: Googlebot\nDisallow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`;
    const out = generateRobotsTxt(current, 'allow-all-ai');
    expect(out).toContain('User-agent: *\nDisallow: /admin/');
    // Googlebot keeps its original group and rule
    expect(out).toMatch(/User-agent: Googlebot\nDisallow: \//);
    // GPTBot is managed now: in the allow group with the * paths copied
    expect(out).toMatch(/User-agent: GPTBot[\s\S]*?Disallow: \/admin\/\nDisallow: \/cart/);
    expect(blockedAiTokens(out)).toEqual([]);
    expect(out.trimEnd().endsWith(`Sitemap: ${ORIGIN}/sitemap.xml`)).toBe(true);
    // stable on re-run
    expect(generateRobotsTxt(out, 'allow-all-ai')).toBe(out);
  });

  it('can block training while allowing search and user bots', () => {
    const out = generateRobotsTxt('', 'allow-search-block-training', {
      contentSignal: { search: 'yes', 'ai-train': 'no' },
    });
    expect(blockedAiTokens(out)).toEqual(
      expect.arrayContaining(['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot']),
    );
    expect(blockedAiTokens(out)).not.toContain('OAI-SearchBot');
    expect(out).toContain('Content-Signal: search=yes, ai-train=no');
  });

  it('custom policy touches only listed tokens', () => {
    const out = generateRobotsTxt('User-agent: ClaudeBot\nDisallow: /\n', 'custom', {
      custom: { PerplexityBot: 'block' },
    });
    expect(out).toMatch(/User-agent: ClaudeBot\nDisallow: \//);
    expect(blockedAiTokens(out)).toEqual(['ClaudeBot', 'PerplexityBot']);
  });

  it('adds sitemap lines and sitemap xml', () => {
    expect(addSitemapLines('User-agent: *\nAllow: /', [`${ORIGIN}/sitemap.xml`])).toBe(
      `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`,
    );
    const xml = generateSitemapXml({ site: ORIGIN, pages: PAGES });
    expect(xml).toContain('<loc>https://acme.test/services/boilers</loc>');
    expect(xml).not.toContain('/old');
  });

  it('builds JSON-LD from crawl and brand data', () => {
    const org = generateOrganizationJsonLd(
      { site: ORIGIN, pages: PAGES },
      { sameAs: ['https://www.linkedin.com/company/acme', 'not a url'] },
    );
    expect(org).toMatchObject({
      '@type': 'Organization',
      name: 'Acme Plumbing',
      url: 'https://acme.test/',
      sameAs: ['https://www.linkedin.com/company/acme'],
    });
    const bc = generateBreadcrumbJsonLd(`${ORIGIN}/services/boilers`, PAGES) as {
      itemListElement: { name: string; position: number }[];
    };
    expect(bc.itemListElement.map((i) => i.name)).toEqual(['Home', 'Services', 'Boiler repair']);
  });

  it('extracts visible FAQs and returns null without them', () => {
    const html = `<main><h2>FAQ</h2><h3>How fast can you come out?</h3><p>Usually the same day in Leeds, within four hours.</p>
      <h3>Do you charge for quotes?</h3><p>No. Quotes are free and fixed before work starts.</p>
      <details><summary>Are you Gas Safe registered?</summary><p>Yes, every engineer is registered.</p></details></main>`;
    const qa = extractFaqs(html);
    expect(qa.map((q) => q.question)).toEqual([
      'How fast can you come out?',
      'Do you charge for quotes?',
      'Are you Gas Safe registered?',
    ]);
    expect(qa[0].answer).toBe('Usually the same day in Leeds, within four hours.');
    expect(generateFaqJsonLd({ url: ORIGIN, html })).toMatchObject({ '@type': 'FAQPage' });
    expect(generateFaqJsonLd({ url: ORIGIN, html: '<p>No questions here.</p>' })).toBeNull();
  });

  it('builds an agent card', () => {
    const card = generateAgentCard({ name: 'Acme', url: ORIGIN, services: ['Boiler repair'] }) as {
      skills: { id: string }[];
      url: string;
    };
    expect(card.skills[0].id).toBe('boiler-repair');
    expect(card.url).toBe(`${ORIGIN}/a2a`);
  });

  it('suggests titles and descriptions by rule', () => {
    const s = suggestMetaRules(
      {
        url: `${ORIGIN}/services/drains`,
        title: null,
        metaDescription: null,
        h1: 'Blocked drains',
        lead: 'We clear blocked drains and sinks across Leeds. Most jobs take under an hour. No call-out fee.',
      },
      { brand: 'Acme Plumbing' },
    );
    expect(s.title?.suggested).toBe('Blocked drains – Acme Plumbing');
    expect(s.description?.suggested).toBe(
      'We clear blocked drains and sinks across Leeds. Most jobs take under an hour. No call-out fee.',
    );
    const long = suggestMetaRules({
      url: ORIGIN,
      title: 'x'.repeat(10) + ' ' + 'word '.repeat(20),
      metaDescription:
        'Fine description that is long enough to pass the minimum length check easily.',
    });
    expect(long.title!.suggested.length).toBeLessThanOrEqual(60);
    expect(long.description).toBeNull();
  });

  it('uses a model when given one and falls back to rules on bad output', async () => {
    const page = {
      url: `${ORIGIN}/a`,
      title: null,
      metaDescription: null,
      h1: 'Boiler servicing',
      lead: 'Annual boiler servicing in Leeds by Gas Safe engineers, with a written report.',
    };
    const fake = (text: string) => ({
      specificationVersion: 'v3',
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doGenerate: async () => ({
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      }),
    });
    const good = await generateMetaSuggestions(page, {
      model: fake(
        '{"title":"Boiler servicing in Leeds – Acme","description":"Annual boiler servicing in Leeds by Gas Safe engineers, with a written report after every visit."}',
      ),
    });
    expect(good.source).toBe('model');
    expect(good.title?.suggested).toBe('Boiler servicing in Leeds – Acme');
    const bad = await generateMetaSuggestions(page, { model: fake('not json') });
    expect(bad.source).toBe('rules');
    const mock = await generateMetaSuggestions(page, {
      config: { ai: { mock: true, maxRunUsd: 1, maxMonthUsd: 1 } },
    });
    expect(mock.source).toBe('rules');
  });
});

describe('recipes and buildFix', () => {
  it('matches check ids by pattern', () => {
    expect(findRecipe('ai-crawlers.gptbot-blocked').id).toBe('ai-robots');
    expect(findRecipe('ai-crawlers.cloudflare-challenge').id).toBe('ai-firewall');
    expect(findRecipe('ai-crawlers.content-signal-missing').id).toBe('content-signal');
    expect(findRecipe('llms-txt.missing').id).toBe('llms-txt');
    expect(findRecipe('onpage.title-too-long').id).toBe('titles');
    expect(findRecipe('onpage.meta-description-missing').id).toBe('descriptions');
    expect(findRecipe('schema.organization-missing').id).toBe('schema-organization');
    expect(findRecipe('agentic.a2a-card-missing').id).toBe('a2a-agent-card');
    expect(findRecipe('agentic.mcp-server-card-missing').id).toBe('mcp-server-card');
    expect(findRecipe('security.hsts-missing').id).toBe('security-headers');
    expect(findRecipe('crawlability.robots-txt-missing').id).toBe('robots-missing');
    expect(findRecipe('crawlability.noindex').id).toBe('noindex');
    expect(findRecipe('images.alt-missing').id).toBe('images-alt');
    expect(findRecipe('geo-content.answer-not-first').id).toBe('answer-first');
    expect(findRecipe('something.unheard-of').id).toBe('fallback');
  });

  const robotsIssue: Issue[] = [
    {
      checkId: 'ai-crawlers.oai-searchbot-blocked',
      message: 'OAI-SearchBot is blocked',
      evidence: 'User-agent: OAI-SearchBot\nDisallow: /',
    },
  ];

  it('gives stack-specific robots fixes', () => {
    const result = {
      site: ORIGIN,
      pages: PAGES,
      robots: {
        found: true,
        status: 200,
        body: 'User-agent: *\nDisallow: /admin/\n\nUser-agent: OAI-SearchBot\nDisallow: /\n',
      },
      sitemaps: [],
    } as unknown as AuditResult;
    const d = def('ai-crawlers.oai-searchbot-blocked');
    const next = buildFix(d, robotsIssue, {
      stack: stack('nextjs', { signals: ['app router'] }),
      result,
    });
    expect(next.files).toContain('app/robots.ts');
    expect(next.snippet?.code).toContain('MetadataRoute.Robots');
    expect(next.tier).toBe('auto');
    const shop = buildFix(d, robotsIssue, { stack: stack('shopify'), result });
    expect(shop.files).toEqual(['templates/robots.txt.liquid']);
    expect(shop.snippet?.code).toContain('robots.default_groups');
    expect(shop.autoApplicable).toBe(false);
    const wp = buildFix(d, robotsIssue, {
      stack: stack('wordpress', { seoPlugin: 'yoast' }),
      result,
    });
    expect(wp.steps.join('\n')).toContain('Yoast SEO → Tools → File editor');
    expect(wp.autoApplicable).toBe(true);
    const sq = buildFix(d, robotsIssue, { stack: stack('squarespace'), result });
    expect(sq.steps.join('\n')).toContain('Block known artificial intelligence crawlers');
  });

  it('writes a self-contained agent prompt', () => {
    const issues: Issue[] = Array.from({ length: 25 }, (_, i) => ({
      checkId: 'onpage.title-missing',
      url: `${ORIGIN}/p${i}`,
      message: 'No title',
    }));
    const fix = buildFix(
      def('onpage.title-missing', { scope: 'page', pillar: 'content' }),
      issues,
      { stack: stack('astro'), site: ORIGIN, pages: PAGES },
    );
    expect(fix.agentPrompt).toContain('Astro');
    expect(fix.agentPrompt).toContain(`${ORIGIN}/p19`);
    expect(fix.agentPrompt).not.toContain(`${ORIGIN}/p20`);
    expect(fix.agentPrompt).toContain('src/layouts/Layout.astro');
    expect(fix.agentPrompt).toContain('avc audit --only onpage.title-missing');
    expect(fix.agentPrompt).toContain('## Acceptance criteria');
  });

  it('generates llms.txt content inside the fix', () => {
    const fix = buildFix(
      def('llms-txt.missing'),
      [{ checkId: 'llms-txt.missing', message: 'No llms.txt' }],
      { stack: stack('nextjs', { signals: ['app router'] }), site: ORIGIN, pages: PAGES },
    );
    expect(fix.files).toContain('app/llms.txt/route.ts');
    expect(fix.snippet?.code).toContain('# Acme Plumbing');
    expect(fix.snippet?.code).toContain('Boiler repair');
  });

  it('makes content fixes manual with a brief', () => {
    const fix = buildFix(
      def('geo-content.answer-not-first', { fixTier: 'guided', scope: 'page' }),
      [
        {
          checkId: 'geo-content.answer-not-first',
          url: `${ORIGIN}/services/boilers`,
          message: 'x',
        },
      ],
      { stack: stack('wordpress'), site: ORIGIN, pages: PAGES },
    );
    expect(fix.tier).toBe('manual');
    expect(fix.steps.join('\n')).toContain('H1: "Boiler repair"');
  });

  it('gives hosted platforms a Worker for root files', () => {
    const fix = buildFix(def('llms-txt.missing'), [{ checkId: 'llms-txt.missing', message: 'x' }], {
      stack: stack('webflow'),
      site: ORIGIN,
      pages: PAGES,
    });
    expect(fix.snippet?.language).toBe('javascript');
    expect(fix.snippet?.code).toContain("url.pathname === '/llms.txt'");
  });

  it('header fixes follow the host', () => {
    const d = def('security.hsts-missing', { pillar: 'technical' });
    const v = buildFix(d, [{ checkId: d.id, message: 'x' }], {
      stack: stack('nextjs', { host: 'vercel' }),
      site: ORIGIN,
    });
    expect(v.files[0]).toBe('vercel.json');
    expect(v.snippet?.code).toContain('Strict-Transport-Security');
    const n = buildFix(d, [{ checkId: d.id, message: 'x' }], {
      stack: stack('wordpress', { host: 'nginx' }),
      site: ORIGIN,
    });
    expect(n.snippet?.code).toContain('add_header Strict-Transport-Security');
  });

  it('falls back to the check text for unknown ids', () => {
    const fix = buildFix(
      def('weird.thing', { severity: 'low' }),
      [{ checkId: 'weird.thing', message: 'x' }],
      { stack: stack('hugo'), site: ORIGIN },
    );
    expect(fix.steps[0]).toBe('Do the stack-neutral thing.');
    expect(fix.impact).toBe('low');
  });

  it('every recipe builds for every stack without throwing', async () => {
    const { RECIPES } = await import('../src/fixes/recipes/index.js');
    const stacks: StackInfo['id'][] = [
      'nextjs',
      'nuxt',
      'gatsby',
      'astro',
      'sveltekit',
      'remix',
      'angular',
      'react-spa',
      'vue-spa',
      'wordpress',
      'shopify',
      'webflow',
      'wix',
      'squarespace',
      'ghost',
      'drupal',
      'joomla',
      'hubspot',
      'framer',
      'hugo',
      'jekyll',
      'static',
      'unknown',
    ];
    for (const r of RECIPES) {
      for (const s of stacks) {
        for (const signals of [['app router'], ['pages router']]) {
          const input = {
            stack: stack(s, { signals }),
            def: def(`${r.id}.x`),
            issues: [
              {
                checkId: `${r.id}.x`,
                url: `${ORIGIN}/services/boilers`,
                message: 'x',
                data: { finalUrl: `${ORIGIN}/b` },
              },
            ],
            origin: ORIGIN,
            host: 'acme.test',
            urls: [`${ORIGIN}/services/boilers`],
            router: (signals[0] === 'app router' ? 'app' : 'pages') as 'app' | 'pages',
            pages: PAGES,
          };
          const out = r.build(input);
          expect(out.steps.length, `${r.id} on ${s}`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('buildFixes', () => {
  it('returns one fix per failing check, ranked', () => {
    const result = {
      id: 'a1',
      version: '1',
      site: ORIGIN,
      startUrl: ORIGIN,
      at: new Date().toISOString(),
      stack: stack('nextjs'),
      stats: {} as AuditResult['stats'],
      pages: PAGES,
      issues: [
        { checkId: 'ai-crawlers.gptbot-blocked', message: 'blocked' },
        { checkId: 'onpage.title-missing', url: `${ORIGIN}/a`, message: 'x' },
        { checkId: 'onpage.title-missing', url: `${ORIGIN}/b`, message: 'x' },
        { checkId: 'agentic.a2a-card-missing', message: 'x' },
        { checkId: 'images.lazy-missing', url: `${ORIGIN}/a`, message: 'x' },
        { checkId: 'images.lazy-missing', url: `${ORIGIN}/a`, message: 'x', severity: 'info' },
        { checkId: 'skipped.check', message: 'x' },
      ],
      checks: {
        'ai-crawlers.gptbot-blocked': {
          ...def('ai-crawlers.gptbot-blocked', { severity: 'critical' }),
          status: 'ran',
          affected: 1,
        },
        'onpage.title-missing': {
          ...def('onpage.title-missing', { scope: 'page', severity: 'medium' }),
          status: 'ran',
          affected: 2,
        },
        'agentic.a2a-card-missing': {
          ...def('agentic.a2a-card-missing', { severity: 'low' }),
          status: 'ran',
          affected: 1,
        },
        'images.lazy-missing': {
          ...def('images.lazy-missing', { scope: 'page', severity: 'low' }),
          status: 'ran',
          affected: 1,
        },
        'skipped.check': { ...def('skipped.check'), status: 'skipped', affected: 0 },
      },
      score: { overall: 50, grade: 'C', pillars: [] },
      priorities: [],
      probes: [],
      botFetches: [],
      robots: { found: true, status: 200, body: 'User-agent: GPTBot\nDisallow: /\n' },
      sitemaps: [],
      external: {},
    } as AuditResult;
    const fixes = buildFixes(result);
    expect(fixes.map((f) => f.checkId)).toEqual([
      'ai-crawlers.gptbot-blocked',
      'onpage.title-missing',
      'agentic.a2a-card-missing',
      'images.lazy-missing',
    ]);
    // training opt-out preserved: GPTBot stays blocked, search bots allowed
    expect(fixes[0].snippet?.code).toContain('opted out');
  });
});

describe('unifiedDiff', () => {
  it('renders hunks with context', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n') + '\n';
    const after = before.replace('b\n', 'B\n').replace('i\n', 'i\nI2\n');
    const d = unifiedDiff('x.txt', before, after);
    expect(d).toContain('--- a/x.txt\n+++ b/x.txt\n@@ -1,');
    expect(d).toContain('-b\n+B');
    expect(d).toContain('+I2');
    expect(unifiedDiff('new.txt', null, 'hello\n')).toBe(
      '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+hello\n',
    );
    expect(unifiedDiff('x', 'same\n', 'same\n')).toBe('');
  });
});
