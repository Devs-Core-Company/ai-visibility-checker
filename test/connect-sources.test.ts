import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AvcConfig, SiteConfig } from '../src/core/config.js';
import type { PageData, ProgressEvent, SiteContext } from '../src/core/types.js';
import {
  checkIndexNowKey,
  checkWordPress,
  collectBing,
  collectExternal,
  collectPsi,
  connectionStatus,
  parseBingDate,
  parsePsi,
  psiKey,
  runPsi,
  samplePsiUrls,
  submitIndexNow,
  type ExternalDataPlus,
  type FetchFn,
} from '../src/connect/index.js';

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

const PSI_BODY = {
  loadingExperience: {
    id: 'https://example.com/',
    overall_category: 'AVERAGE',
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2900, category: 'AVERAGE' },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: 'FAST' },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: 'FAST' },
    },
  },
  lighthouseResult: {
    categories: { performance: { score: 0.71 }, accessibility: { score: 0.93 }, seo: { score: 1 } },
    audits: {
      'largest-contentful-paint': { numericValue: 3412.5 },
      'cumulative-layout-shift': { numericValue: 0.041 },
      'total-blocking-time': { numericValue: 230 },
      'first-contentful-paint': { numericValue: 1500 },
      'server-response-time': { numericValue: 420 },
      'render-blocking-resources': {
        title: 'Eliminate render-blocking resources',
        score: 0.3,
        details: { type: 'opportunity', overallSavingsMs: 750 },
      },
      'unused-javascript': {
        title: 'Reduce unused JavaScript',
        score: 0.5,
        details: { type: 'opportunity', overallSavingsMs: 1200 },
      },
      'uses-text-compression': {
        title: 'Enable text compression',
        score: 1,
        details: { type: 'opportunity', overallSavingsMs: 0 },
      },
      'lcp-discovery-insight': {
        title: 'LCP request discovery',
        score: 0,
        metricSavings: { LCP: 300 },
      },
    },
  },
};

describe('PageSpeed Insights', () => {
  it('parses lab, field and opportunities', () => {
    const r = parsePsi('https://example.com/', 'mobile', PSI_BODY);
    expect(r).toMatchObject({
      performanceScore: 71,
      accessibilityScore: 93,
      seoScore: 100,
      lcpMs: 3412.5,
      cls: 0.041,
      ttfbMs: 420,
      inpMs: 180,
      field: { lcpMs: 2900, cls: 0.05, inpMs: 180, category: 'AVERAGE' },
    });
    expect(r.opportunities.map((o) => o.id)).toEqual([
      'unused-javascript',
      'render-blocking-resources',
      'lcp-discovery-insight',
    ]);
  });

  it('ignores origin-fallback field data', () => {
    const r = parsePsi('https://example.com/x', 'mobile', {
      ...PSI_BODY,
      loadingExperience: { ...PSI_BODY.loadingExperience, origin_fallback: true },
    });
    expect(r.field).toBeUndefined();
  });

  it('retries 429 then succeeds; reports quota clearly when it keeps failing', async () => {
    let n = 0;
    const flaky: FetchFn = async (u) => {
      expect(String(u)).toContain('category=seo');
      return ++n < 3 ? json({ error: { code: 429, message: 'Quota' } }, 429) : json(PSI_BODY);
    };
    const r = await runPsi('https://example.com/', 'mobile', {
      fetch: flaky,
      sleepFn: async () => {},
    });
    expect(r.performanceScore).toBe(71);
    expect(n).toBe(3);
    const always: FetchFn = async () =>
      json({ error: { code: 429, message: 'Quota exceeded' } }, 429);
    const r2 = await runPsi('https://example.com/', 'desktop', {
      fetch: always,
      sleepFn: async () => {},
    });
    expect(r2.error).toMatch(/PSI_API_KEY/);
  });

  it('runs mobile + desktop with at most 2 in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const f: FetchFn = async (u) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      expect(new URL(String(u)).searchParams.get('key')).toBe('k');
      return json(PSI_BODY);
    };
    const out = await collectPsi(['https://example.com/', 'https://example.com/a'], {
      fetch: f,
      key: 'k',
    });
    expect(Object.keys(out).sort()).toEqual([
      'desktop:https://example.com/',
      'desktop:https://example.com/a',
      'https://example.com/',
      'https://example.com/a',
    ]);
    expect(out[psiKey('https://example.com/a', 'desktop')].strategy).toBe('desktop');
    expect(peak).toBe(2);
  });
});

describe('Bing', () => {
  it('parses WCF dates', () => {
    expect(parseBingDate('/Date(1791720000000-0700)/')).toBe('2026-10-11T12:00:00.000Z');
  });

  it('collects site stats and tolerates partial failures', async () => {
    const f: FetchFn = async (u) => {
      const url = new URL(String(u));
      expect(url.searchParams.get('apikey')).toBe('bk');
      const m = url.pathname.split('/').pop();
      if (m === 'GetUserSites')
        return json({ d: [{ Url: 'https://www.example.com/', IsVerified: true }] });
      if (m === 'GetRankAndTrafficStats')
        return json({
          d: [
            { Date: '/Date(1791100000000)/', Clicks: 10, Impressions: 300 },
            { Date: '/Date(1791700000000)/', Clicks: 5, Impressions: 200 },
          ],
        });
      if (m === 'GetCrawlStats')
        return json({
          d: [
            {
              Date: '/Date(1791700000000)/',
              CrawledPages: 50,
              CrawlErrors: 2,
              InIndex: 40,
              InLinks: 12,
              Code4xx: 2,
            },
          ],
        });
      if (m === 'GetCrawlIssues') return json({ Message: 'boom' }, 500);
      if (m === 'GetUrlSubmissionQuota')
        return json({ d: { DailyQuota: 100, MonthlyQuota: 2800 } });
      return json({}, 404);
    };
    const d = await collectBing('https://example.com/', 'bk', {
      fetch: f,
      baseUrl: 'http://bing.test/api',
    });
    expect(d.verified).toBe(true);
    expect(d.traffic).toMatchObject({ clicks: 15, impressions: 500, points: 2 });
    expect(d.crawl).toMatchObject({ crawledPages: 50, inIndex: 40, status4xx: 2 });
    expect(d.quota).toEqual({ daily: 100, monthly: 2800 });
    expect(d.errors[0]).toMatch(/GetCrawlIssues/);
  });

  it('explains a bad API key', async () => {
    const f: FetchFn = async () => json({ ErrorCode: 3, Message: 'InvalidApiKey' }, 400);
    await expect(collectBing('https://example.com/', 'bad', { fetch: f })).rejects.toThrow(
      /API access/,
    );
  });

  it('checks and submits IndexNow', async () => {
    const key = 'a1b2c3d4e5f60718';
    const f: FetchFn = async (u, init) => {
      if (String(u).endsWith(`${key}.txt`)) return new Response(`${key}\n`);
      const b = JSON.parse(String(init?.body));
      expect(b).toMatchObject({ host: 'example.com', key });
      return new Response('', { status: 202 });
    };
    expect((await checkIndexNowKey('example.com', key, { fetch: f })).ok).toBe(true);
    const bad: FetchFn = async () => new Response('<html>not here</html>');
    expect((await checkIndexNowKey('example.com', key, { fetch: bad })).ok).toBe(false);
    const r = await submitIndexNow(
      ['https://example.com/a', 'https://example.com/b'],
      key,
      'example.com',
      { fetch: f },
    );
    expect(r).toMatchObject({ ok: true, submitted: 2 });
    await expect(
      submitIndexNow(['https://other.com/'], key, 'example.com', { fetch: f }),
    ).rejects.toThrow(/not on example\.com/);
  });
});

function wpFetch(opts: { authOk: boolean }): FetchFn {
  return async (u, init) => {
    const url = String(u);
    if (url === 'https://wp.example.com/wp-json/')
      return json({ name: 'Example', namespaces: ['oembed/1.0', 'yoast/v1', 'wp/v2'] });
    if (url === 'https://wp.example.com/')
      return new Response(
        '<html><head><meta name="generator" content="WordPress 6.8.3" /></head></html>',
      );
    if (url.includes('/wp/v2/users/me')) {
      const auth = (init?.headers as Record<string, string>).authorization;
      expect(auth).toBe(`Basic ${Buffer.from('editor:abcdabcdabcdabcd').toString('base64')}`);
      if (!opts.authOk) return json({ code: 'incorrect_password', message: 'x' }, 401);
      return json({
        id: 2,
        name: 'Ed',
        slug: 'editor',
        roles: ['editor'],
        capabilities: { edit_posts: true, edit_pages: true, upload_files: true },
      });
    }
    return new Response('', { status: 404 });
  };
}

describe('WordPress', () => {
  it('detects version, SEO plugin and capabilities', async () => {
    const r = await checkWordPress(
      { url: 'https://wp.example.com/', user: 'editor', appPassword: 'abcd abcd abcd abcd' },
      { fetch: wpFetch({ authOk: true }) },
    );
    expect(r).toMatchObject({
      ok: true,
      version: '6.8.3',
      seoPlugin: 'yoast',
      user: { name: 'Ed' },
    });
    expect(r.can).toEqual({
      editPosts: true,
      editPages: true,
      manageOptions: false,
      uploadFiles: true,
    });
  });

  it('explains a rejected Application Password', async () => {
    const r = await checkWordPress(
      { url: 'https://wp.example.com', user: 'editor', appPassword: 'abcdabcdabcdabcd' },
      { fetch: wpFetch({ authOk: false }) },
    );
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/Application Password/);
  });
});

function page(url: string, extra: Partial<PageData> = {}): PageData {
  return { url, finalUrl: url, isHtml: true, status: 200, depth: 1, ...extra } as PageData;
}

function makeSite(): SiteContext {
  const pages = new Map<string, PageData>();
  for (const u of [
    'https://example.com/',
    'https://example.com/pricing',
    'https://example.com/contact',
  ])
    pages.set(u, page(u));
  return {
    startUrl: 'https://example.com/',
    origin: 'https://example.com',
    host: 'example.com',
    pages,
    inlinks: new Map([['https://example.com/pricing', new Set(['a', 'b'])]]),
    stack: { id: 'wordpress', confidence: 1, signals: [] },
    external: {},
  } as unknown as SiteContext;
}

describe('collectExternal / connectionStatus', () => {
  it('samples PSI URLs by inlinks', () => {
    expect(samplePsiUrls(makeSite(), 2)).toEqual([
      'https://example.com/',
      'https://example.com/pricing',
    ]);
  });

  it('fills what is configured and keeps going when a source fails', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'avc-ext-'));
    const logFile = join(dataDir, 'access.log');
    writeFileSync(
      logFile,
      '192.0.2.80 - - [10/Oct/2026:12:00:00 +0000] "GET /pricing HTTP/1.1" 200 9800 "-" "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)"\n',
    );
    const config: AvcConfig = {
      dataDir,
      sites: [],
      ai: { maxRunUsd: 3, maxMonthUsd: 30 },
      google: { serviceAccountFile: join(dataDir, 'missing.json'), psiKey: 'k' },
      bing: { apiKey: 'bk' },
      server: { port: 4317, host: '127.0.0.1' },
    };
    const siteConfig: SiteConfig = {
      id: 'example.com',
      url: 'https://example.com/',
      connections: {
        logs: [logFile],
        wordpress: {
          url: 'https://wp.example.com',
          user: 'editor',
          appPassword: 'abcdabcdabcdabcd',
        },
        repoPath: dataDir,
      },
    };
    const f: FetchFn = async (u, init) => {
      const url = String(u);
      if (url.startsWith('http://psi.test')) return json(PSI_BODY);
      if (url.startsWith('http://bing.test'))
        return json({ ErrorCode: 3, Message: 'InvalidApiKey' }, 400);
      if (url.includes('wp.example.com')) return wpFetch({ authOk: true })(u, init);
      return new Response('', { status: 404 });
    };
    const events: ProgressEvent[] = [];
    const site = makeSite();
    await collectExternal(site, siteConfig, config, (e) => events.push(e), {
      fetch: f,
      baseUrls: { psi: 'http://psi.test', bing: 'http://bing.test' },
      psi: 2,
      psiStrategies: ['mobile'],
    });
    const ext = site.external as ExternalDataPlus;
    expect(Object.keys(ext.psi ?? {})).toHaveLength(2);
    expect(ext.logs?.bots[0]).toMatchObject({ token: 'PerplexityBot', hits: 1 });
    expect(ext.logs?.neverFetched).toEqual(['https://example.com/', 'https://example.com/contact']);
    expect(ext.wordpress).toEqual({
      url: 'https://wp.example.com',
      user: 'editor',
      version: '6.8.3',
      seoPlugin: 'yoast',
    });
    expect(ext.repo).toMatchObject({ path: dataDir, stack: 'wordpress' });
    expect(ext.gsc).toBeUndefined();
    expect(ext.bing).toBeUndefined();
    const warnings = events
      .filter((e) => e.type === 'log' && e.level === 'warn')
      .map((e) => (e as { message: string }).message);
    expect(warnings.some((w) => /^Google: .*service-account key file/.test(w))).toBe(true);
    expect(warnings.some((w) => /^Bing Webmaster Tools: .*API access/.test(w))).toBe(true);

    const status = await connectionStatus(siteConfig, config, {
      test: true,
      fetch: f,
      baseUrls: { bing: 'http://bing.test' },
    });
    const by = Object.fromEntries(status.map((s) => [s.id, s]));
    expect(by.google).toMatchObject({ configured: true, ok: false });
    expect(by.logs).toMatchObject({ configured: true, ok: true });
    expect(by.wordpress).toMatchObject({ ok: true });
    expect(by.bing).toMatchObject({ ok: false });
    expect(by.ga4.ok).toBeNull();
  });
});
