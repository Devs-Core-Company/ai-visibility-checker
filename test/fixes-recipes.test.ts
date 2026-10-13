import { describe, expect, it } from 'vitest';
import { ALL_CHECKS } from '../src/checks/index.js';
import type { Issue, StackId, StackInfo } from '../src/core/types.js';
import { buildFix } from '../src/fixes/index.js';
import { cleanRobots } from '../src/fixes/recipes/crawl-extra.js';
import { FALLBACK, findRecipe, RECIPES } from '../src/fixes/recipes/index.js';
import type { RecipeInput } from '../src/fixes/types.js';
import { nextRouterFromSignals } from '../src/fixes/stacks.js';

const ORIGIN = 'https://acme.test';

function stack(id: StackId, over: Partial<StackInfo> = {}): StackInfo {
  return { id, confidence: 0.9, signals: id === 'nextjs' ? ['app router'] : [], ...over };
}

const STACKS: StackInfo[] = [
  stack('nextjs', { host: 'vercel' }),
  stack('nextjs', { signals: ['pages router'] }),
  stack('wordpress', { seoPlugin: 'yoast', host: 'nginx' }),
  stack('wordpress', { seoPlugin: 'rank-math', host: 'apache' }),
  stack('shopify'),
  stack('webflow'),
  stack('static', { host: 'netlify' }),
  stack('react-spa', { cdn: 'cloudflare' }),
  stack('astro'),
  stack('unknown'),
];

function input(checkId: string, s: StackInfo): RecipeInput {
  const def = ALL_CHECKS.find((c) => c.def.id === checkId)!.def;
  const issues: Issue[] = [
    {
      checkId,
      url: `${ORIGIN}/blog/post`,
      message: 'example',
      evidence: 'line 3: Dissallow /private | GTM-ABC123',
    },
  ];
  return {
    def,
    issues,
    stack: s,
    origin: ORIGIN,
    host: 'acme.test',
    urls: [`${ORIGIN}/blog/post`],
    router: nextRouterFromSignals(s),
  };
}

describe('recipe coverage', () => {
  it('every check resolves to a real recipe, not the fallback', () => {
    const missing = ALL_CHECKS.map((c) => c.def.id).filter((id) => findRecipe(id) === FALLBACK);
    expect(missing).toEqual([]);
  });

  it('recipe ids are unique', () => {
    const ids = RECIPES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('unknown ids still fall back', () => {
    expect(findRecipe('something.unheard-of')).toBe(FALLBACK);
  });

  it('every recipe builds steps for every stack without throwing', () => {
    for (const c of ALL_CHECKS) {
      const recipe = findRecipe(c.def.id);
      for (const s of STACKS) {
        const out = recipe.build(input(c.def.id, s));
        expect(out.steps.length, `${c.def.id} on ${s.id}`).toBeGreaterThan(0);
        expect(
          out.steps.every((x) => typeof x === 'string' && x.trim().length > 0),
          `${c.def.id} on ${s.id}: empty step`,
        ).toBe(true);
        expect(Array.isArray(out.files), `${c.def.id} on ${s.id}`).toBe(true);
        if (out.snippet) expect(out.snippet.code.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('new recipes', () => {
  it('routes ids to the intended recipe', () => {
    expect(findRecipe('crawlability.robots-syntax').id).toBe('robots-content');
    expect(findRecipe('ai-crawlers.backwards-policy').id).toBe('robots-content');
    expect(findRecipe('crawlability.robots-txt-server-error').id).toBe('robots-file-health');
    expect(findRecipe('crawlability.gsc-crawled-not-indexed').id).toBe('search-console');
    expect(findRecipe('accessibility.button-name-missing').id).toBe('accessibility');
    expect(findRecipe('security.exposed-files').id).toBe('exposed-files');
    expect(findRecipe('response.missing-page-returns-200').id).toBe('not-found-status');
    expect(findRecipe('cms.wp-xmlrpc-enabled').id).toBe('wp-hardening');
    expect(findRecipe('analytics.gtm-noscript-misplaced').id).toBe('head-placement');
    // earlier recipes keep their ids
    expect(findRecipe('crawlability.noindex').id).toBe('noindex');
    expect(findRecipe('security.hsts-missing').id).toBe('security-headers');
  });

  it('Search Console findings are manual', () => {
    const def = ALL_CHECKS.find((c) => c.def.id === 'crawlability.gsc-not-indexed')!.def;
    const fix = buildFix(def, [{ checkId: def.id, message: 'x', url: `${ORIGIN}/a` }], {
      stack: stack('wordpress'),
    });
    expect(fix.tier).toBe('manual');
    expect(fix.steps.join('\n')).toMatch(/URL Inspection/);
    expect(fix.steps.join('\n')).toMatch(/Request indexing/);
  });

  it('server-level fixes pick the detected host', () => {
    const id = 'security.directory-listing';
    const nginx = findRecipe(id).build(input(id, stack('static', { host: 'nginx' })));
    expect(nginx.snippet?.code).toMatch(/autoindex off/);
    const apache = findRecipe(id).build(input(id, stack('wordpress', { host: 'apache' })));
    expect(apache.snippet?.code).toMatch(/Options -Indexes/);
    const files = findRecipe('security.exposed-files').build(
      input('security.exposed-files', stack('unknown', { host: 'nginx' })),
    );
    expect(files.snippet?.code).toMatch(/well-known/);
    expect(files.steps.join('\n')).toMatch(/Rotate every secret/);
  });

  it('a11y fixes are stack-specific', () => {
    const id = 'accessibility.form-label-missing';
    const next = findRecipe(id).build(input(id, stack('nextjs')));
    expect(next.snippet?.code).toMatch(/htmlFor/);
    const html = findRecipe(id).build(input(id, stack('static')));
    expect(html.snippet?.code).toMatch(/<label for="email">/);
  });

  it('404 handling uses notFound() on Next.js and a server rule elsewhere', () => {
    const id = 'response.missing-page-returns-200';
    expect(findRecipe(id).build(input(id, stack('nextjs'))).snippet?.code).toMatch(/notFound\(\)/);
    expect(
      findRecipe(id).build(input(id, stack('static', { host: 'nginx' }))).snippet?.code,
    ).toMatch(/=404/);
  });
});

describe('cleanRobots', () => {
  it('fixes typos, drops unsupported lines and corrects bot tokens', () => {
    const out = cleanRobots(
      'User-agent: *\nDissallow: /private\nNoindex: /secret\nUser-agent: gpt-bot\nDisallow: /',
      'crawlability.robots-syntax',
    );
    expect(out).toMatch(/^Disallow: \/private$/m);
    expect(out).toMatch(/^# Noindex: \/secret/m);
    expect(out).toMatch(/^User-agent: GPTBot$/m);
  });

  it('removes Crawl-delay only for crawl-delay checks', () => {
    const body = 'User-agent: *\nCrawl-delay: 30\nAllow: /';
    expect(cleanRobots(body, 'crawlability.robots-crawl-delay')).toMatch(/^# Crawl-delay/m);
    expect(cleanRobots(body, 'crawlability.robots-syntax')).toMatch(/^Crawl-delay: 30$/m);
  });

  it('merges duplicate single-bot groups', () => {
    const out = cleanRobots(
      'User-agent: GPTBot\nDisallow: /a\n\nUser-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /b\n',
      'ai-crawlers.duplicate-groups',
    );
    expect(out.match(/User-agent: GPTBot/g)).toHaveLength(1);
    expect(out).toMatch(/Disallow: \/a[\s\S]*Disallow: \/b/);
  });
});
