import { describe, expect, it } from 'vitest';
import { runAudit, skippedSummary, summariseForCli, type AuditDeps } from '../src/audit/index.js';
import { runChecks } from '../src/audit/run-checks.js';
import {
  checkPassRate,
  gradeFor,
  rankPriorities,
  scoreAudit,
  visibilityScore,
} from '../src/audit/score.js';
import type { AuditResult, Check, Fix } from '../src/core/types.js';
import { config, def, page, pageCheck, site, siteCheck, visibilityRun } from './audit-fixtures.js';

const pages = [
  page('https://example.com/'),
  page('https://example.com/a'),
  page('https://example.com/b'),
  page('https://example.com/c'),
];

describe('runChecks', () => {
  it('runs page checks per page, stamps url and checkId, counts affected', async () => {
    const c = pageCheck(def('onpage.title-long'), (p) =>
      p.url.endsWith('/a') ? { checkId: '', message: 'Too long' } : null,
    );
    const { issues, status } = await runChecks(site(pages), [c]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ checkId: 'onpage.title-long', url: 'https://example.com/a' });
    expect(status['onpage.title-long']).toMatchObject({ status: 'ran', affected: 1 });
  });

  it('normalises arrays and nulls from site checks', async () => {
    const c = siteCheck(def('robots.x', { category: 'robots' }), () => [
      { checkId: 'robots.x', message: 'a' },
      { checkId: 'robots.x', message: 'b', url: 'https://example.com/a' },
    ]);
    const empty = siteCheck(def('robots.y', { category: 'robots' }), async () => undefined);
    const { issues, status } = await runChecks(site(pages), [c, empty]);
    expect(issues).toHaveLength(2);
    expect(status['robots.x'].affected).toBe(2);
    expect(status['robots.y']).toMatchObject({ status: 'ran', affected: 0 });
  });

  it('skips checks with unmet requirements, with a reason', async () => {
    const c = pageCheck(def('js-rendering.gap', { requires: ['render'] }), () => null);
    const g = siteCheck(def('analytics.gsc', { requires: ['gsc'] }), () => null);
    const l = siteCheck(def('ai-visibility.x', { requires: ['llm'] }), () => null);
    const { status } = await runChecks(site(pages), [c, g, l]);
    expect(status['js-rendering.gap'].status).toBe('skipped');
    expect(status['js-rendering.gap'].skippedReason).toMatch(/render/i);
    expect(status['analytics.gsc'].skippedReason).toMatch(/Search Console/);
    expect(status['ai-visibility.x'].status).toBe('skipped');
    const withVis = await runChecks(site(pages), [l], { hasVisibility: true });
    expect(withVis.status['ai-visibility.x'].status).toBe('ran');
  });

  it('render requirement is met when any page has rendered output', async () => {
    const ps = [
      page('https://example.com/', {
        rendered: {
          html: '',
          text: '',
          wordCount: 5,
          title: null,
          links: 0,
          headings: [],
          structuredData: [],
          consoleErrors: [],
          failedRequests: [],
        },
      }),
    ];
    const c = pageCheck(def('js-rendering.gap', { requires: ['render'] }), () => null);
    const { status } = await runChecks(site(ps), [c]);
    expect(status['js-rendering.gap'].status).toBe('ran');
  });

  it('catches throwing checks and marks them skipped', async () => {
    const logs: string[] = [];
    const boom = pageCheck(def('onpage.boom'), () => {
      throw new Error('bad');
    });
    const siteBoom = siteCheck(def('robots.boom'), () => {
      throw new Error('worse');
    });
    const { status } = await runChecks(site(pages), [boom, siteBoom], {
      onProgress: (e) => e.type === 'log' && logs.push(e.message),
    });
    expect(status['onpage.boom'].status).toBe('skipped');
    expect(status['robots.boom'].skippedReason).toMatch(/worse/);
    expect(logs.length).toBeGreaterThanOrEqual(2);
  });

  it('times out slow site checks', async () => {
    const slow = siteCheck(def('robots.slow'), () => new Promise(() => {}));
    const { status } = await runChecks(site(pages), [slow], { siteCheckTimeoutMs: 20 });
    expect(status['robots.slow'].status).toBe('skipped');
    expect(status['robots.slow'].skippedReason).toMatch(/timed out/);
  });

  it('filters with only / skip / categories / pillars', async () => {
    const a = pageCheck(def('onpage.a'), () => null);
    const b = pageCheck(
      def('links-internal.b', { category: 'links-internal', pillar: 'technical' }),
      () => null,
    );
    expect(
      Object.keys((await runChecks(site(pages), [a, b], { only: ['onpage.'] })).status),
    ).toEqual(['onpage.a']);
    expect(
      Object.keys((await runChecks(site(pages), [a, b], { skip: ['onpage.a'] })).status),
    ).toEqual(['links-internal.b']);
    expect(
      Object.keys(
        (await runChecks(site(pages), [a, b], { categories: ['links-internal'] })).status,
      ),
    ).toEqual(['links-internal.b']);
    expect(
      Object.keys((await runChecks(site(pages), [a, b], { only: ['technical'] })).status),
    ).toEqual(['links-internal.b']);
  });
});

describe('scoring', () => {
  it('grades by band', () => {
    expect([95, 90, 89, 75, 60, 59, 40, 39].map(gradeFor)).toEqual([
      'A',
      'A',
      'B',
      'B',
      'C',
      'D',
      'D',
      'F',
    ]);
  });

  it('page checks lose a presence penalty plus reach', () => {
    expect(checkPassRate('page', 0, 10)).toBe(1);
    expect(checkPassRate('page', 10, 10)).toBe(0);
    expect(checkPassRate('page', 5, 10)).toBeCloseTo(1 - (0.25 + 0.75 * 0.5));
    expect(checkPassRate('site', 1, 10)).toBe(0);
  });

  it('redistributes visibility weight and flags readiness only', async () => {
    const checks: Check[] = [
      pageCheck(def('onpage.a', { severity: 'high' }), () => null),
      siteCheck(
        def('robots.b', { category: 'robots', pillar: 'technical', severity: 'critical' }),
        () => ({ checkId: 'robots.b', message: 'x' }),
      ),
    ];
    const { issues, status } = await runChecks(site(pages), checks);
    const s = scoreAudit(status, issues, 4);
    expect(s.readinessOnly).toBe(true);
    const content = s.pillars.find((p) => p.pillar === 'content')!;
    const tech = s.pillars.find((p) => p.pillar === 'technical')!;
    expect(content.score).toBe(100);
    expect(tech.score).toBe(0);
    // Only content (15) and technical (20) measured → weights 42.9 / 57.1, overall = 100 * 15/35
    expect(content.weight).toBeCloseTo(42.9, 1);
    expect(s.pillars.find((p) => p.pillar === 'ai-visibility')!.weight).toBe(0);
    expect(s.overall).toBe(Math.round((100 * 15) / 35));
    expect(s.grade).toBe('D');
  });

  it('weights by severity and ignores info checks', async () => {
    const checks: Check[] = [
      siteCheck(def('onpage.crit', { severity: 'critical' }), () => null),
      siteCheck(def('onpage.low', { severity: 'low' }), () => ({
        checkId: 'onpage.low',
        message: 'x',
      })),
      siteCheck(def('onpage.info', { severity: 'info' }), () => ({
        checkId: 'onpage.info',
        message: 'x',
      })),
    ];
    const { issues, status } = await runChecks(site(pages), checks);
    const s = scoreAudit(status, issues, 4);
    expect(s.pillars.find((p) => p.pillar === 'content')!.score).toBe(Math.round((100 * 10) / 11));
  });

  it('includes the visibility pillar when a run is present', () => {
    const v = visibilityScore(visibilityRun());
    expect(v).not.toBeNull();
    expect(v!.score).toBeGreaterThan(0);
    expect(v!.score).toBeLessThanOrEqual(100);
    const s = scoreAudit({}, [], 1, visibilityRun());
    expect(s.readinessOnly).toBe(false);
    expect(s.pillars.find((p) => p.pillar === 'ai-visibility')!.weight).toBe(100);
    expect(s.overall).toBe(Math.round(v!.score));
  });

  it('a run with no usable answers counts as absent', () => {
    const run = visibilityRun();
    run.answers = run.answers.map((a) => ({ ...a, error: 'x' }));
    run.summary.byEngine = {};
    expect(visibilityScore(run)).toBeNull();
  });

  it('ranks priorities by impact and divides by fix effort', async () => {
    const checks: Check[] = [
      siteCheck(def('robots.crit', { pillar: 'technical', severity: 'critical' }), () => ({
        checkId: 'robots.crit',
        message: 'x',
      })),
      pageCheck(def('onpage.low', { severity: 'low' }), () => ({
        checkId: 'onpage.low',
        message: 'x',
      })),
      siteCheck(def('onpage.ok', { severity: 'high' }), () => null),
    ];
    const { issues, status } = await runChecks(site(pages), checks);
    const pr = rankPriorities(status, issues, 4);
    expect(pr.map((p) => p.checkId)).toEqual(['robots.crit', 'onpage.low']);
    const fix = { checkId: 'robots.crit', effort: 'days' } as Fix;
    const withFix = rankPriorities(status, issues, 4, { fixes: [fix] });
    expect(withFix[0].fix).toBe(fix);
    expect(withFix.find((p) => p.checkId === 'robots.crit')!.impact).toBeLessThan(pr[0].impact);
  });
});

describe('runAudit', () => {
  const stubDeps = (over: Partial<AuditDeps> = {}): Partial<AuditDeps> => ({
    crawlSite: async () => site(pages),
    runAgenticProbes: async (s) => {
      s.probes.set('llms-txt', {
        id: 'llms-txt',
        url: 'https://example.com/llms.txt',
        status: 404,
        found: false,
      });
    },
    fetchAsBots: async () => {
      throw new Error('offline');
    },
    collectExternal: async () => {},
    loadChecks: async () => [
      pageCheck(def('onpage.title', { severity: 'high' }), (p) =>
        p.url.endsWith('/b') ? { checkId: 'onpage.title', message: 'Missing' } : null,
      ),
      siteCheck(
        def('ai-visibility.named', {
          requires: ['llm'],
          pillar: 'ai-visibility',
          category: 'ai-visibility',
        }),
        () => null,
      ),
    ],
    inferBrand: (s) => ({
      name: 'Example',
      domain: s.host,
      aliases: [],
      services: [],
      competitors: [],
    }),
    suggestPrompts: async () => visibilityRun().prompts,
    runVisibility: async () => visibilityRun(),
    buildFixes: (r: AuditResult) =>
      Object.values(r.checks)
        .filter((c) => c.affected > 0)
        .map((c) => ({
          checkId: c.id,
          stack: 'nextjs',
          tier: 'guided',
          title: c.title,
          steps: ['Do it'],
          files: ['app/layout.tsx'],
          agentPrompt: 'Fix it',
          autoApplicable: false,
          effort: 'minutes',
          impact: 'high',
        })),
    ...over,
  });

  it('orchestrates the pipeline and builds a full result', async () => {
    const phases: string[] = [];
    const r = await runAudit(
      {
        url: 'https://example.com/',
        config,
        onProgress: (e) => e.type === 'phase' && phases.push(e.phase),
      },
      stubDeps(),
    );
    expect(r.site).toBe('https://example.com');
    expect(r.pages).toHaveLength(4);
    expect(r.pages.find((p) => p.url.endsWith('/b'))!.issues).toBe(1);
    expect(r.pages[0]).toMatchObject({
      h1: 'Heading',
      indexable: true,
      schemaTypes: ['Organization'],
    });
    expect(r.issues).toHaveLength(1);
    expect(r.checks['ai-visibility.named'].status).toBe('skipped');
    expect(r.probes).toHaveLength(1);
    expect(r.priorities[0].fix?.files).toEqual(['app/layout.tsx']);
    expect(r.visibility).toBeUndefined();
    expect((r.score as { readinessOnly?: boolean }).readinessOnly).toBe(true);
    expect(phases).toEqual(
      expect.arrayContaining(['crawl', 'probes', 'external', 'checks', 'score', 'done']),
    );
    expect(summariseForCli(r)).toMatch(/Readiness only/);
  });

  it('runs visibility when asked and merges the configured brand', async () => {
    let brandSeen = '';
    const r = await runAudit(
      {
        url: 'https://example.com/',
        config,
        visibility: { engines: ['chatgpt'] },
        siteConfig: {
          id: 'example.com',
          url: 'https://example.com/',
          brand: { name: 'Example Ltd' },
        },
      },
      stubDeps({
        runVisibility: async (a) => {
          brandSeen = a.brand.name;
          expect(a.engines).toEqual(['chatgpt']);
          return visibilityRun();
        },
      }),
    );
    expect(brandSeen).toBe('Example Ltd');
    expect(r.visibility).toBeDefined();
    expect(r.checks['ai-visibility.named'].status).toBe('ran');
    expect(r.score.pillars.find((p) => p.pillar === 'ai-visibility')!.weight).toBeGreaterThan(0);
    expect(summariseForCli(r)).toMatch(/AI visibility: named in 50%/);
  });

  it('skips the AI visibility run without a key and says why (no silent mock)', async () => {
    let asked = false;
    const noKeys = { ...config, ai: { maxRunUsd: 3, maxMonthUsd: 30 } };
    const r = await runAudit(
      { url: 'https://example.com/', config: noKeys, visibility: true },
      stubDeps({
        runVisibility: async () => {
          asked = true;
          return visibilityRun();
        },
      }),
    );
    expect(asked).toBe(false);
    expect(r.visibility).toBeUndefined();
    expect(r.notRun).toEqual([
      { step: 'ai-visibility', reason: expect.stringMatching(/no AI API key.*avc keys setup/) },
    ]);
    expect(r.checks['ai-visibility.named']).toMatchObject({
      status: 'skipped',
      skippedReason: expect.stringMatching(/no AI API key/),
    });
    const skipped = skippedSummary(r);
    expect(skipped.steps).toHaveLength(1);
    expect(skipped.checks.some((g) => g.checks.includes('ai-visibility.named'))).toBe(true);
    expect(summariseForCli(r)).toMatch(/Skipped[\s\S]*AI visibility run[\s\S]*no AI API key/);
  });

  it('says the AI run was not requested when the audit is readiness only', async () => {
    const r = await runAudit({ url: 'https://example.com/', config }, stubDeps());
    expect(r.notRun?.[0]).toMatchObject({
      step: 'ai-visibility',
      reason: expect.stringMatching(/Not requested.*--visibility/),
    });
    expect(r.checks['ai-visibility.named'].skippedReason).toMatch(/Not requested/);
  });

  it('marks noindex and canonicalised pages as not indexable', async () => {
    const r = await runAudit(
      { url: 'https://example.com/', config },
      stubDeps({
        crawlSite: async () =>
          site([
            page('https://example.com/x', { metaRobots: 'noindex, follow' }),
            page('https://example.com/y', { canonical: 'https://example.com/' }),
            page('https://example.com/z', { status: 404 }),
          ]),
      }),
    );
    expect(r.pages.map((p) => p.indexable)).toEqual([false, false, false]);
  });

  it('honours an abort signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runAudit({ url: 'https://example.com/', config, signal: ac.signal }, stubDeps()),
    ).rejects.toThrow();
  });
});
