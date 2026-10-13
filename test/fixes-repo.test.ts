import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AvcConfig } from '../src/core/config.js';
import type { AuditResult, PageSummary, StackInfo } from '../src/core/types.js';
import { applyFixes } from '../src/fixes/apply/index.js';
import {
  applyRepoPlan,
  detectRepoStack,
  planRepoFixes,
  rollbackRepo,
} from '../src/fixes/apply/repo.js';
import { rollback } from '../src/fixes/apply/rollback.js';

const ORIGIN = 'https://acme.test';
const FIXTURES = join(import.meta.dirname, 'fixtures', 'repos');

function copy(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `avc-repo-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

function page(path: string, over: Partial<PageSummary> = {}): PageSummary {
  const url = ORIGIN + path;
  return {
    url,
    finalUrl: url,
    status: 200,
    depth: 1,
    title: null,
    metaDescription: null,
    h1: null,
    wordCount: 300,
    canonical: url,
    indexable: true,
    inlinks: 2,
    outlinks: 4,
    bytes: 1000,
    ttfbMs: 50,
    schemaTypes: [],
    issues: 1,
    inSitemap: true,
    ...over,
  };
}

function audit(
  stack: StackInfo['id'],
  checkIds: string[],
  extra: Partial<AuditResult> = {},
): AuditResult {
  return {
    id: 'x',
    version: '1',
    site: ORIGIN,
    startUrl: ORIGIN,
    at: '',
    stack: { id: stack, confidence: 1, signals: [] },
    stats: {} as AuditResult['stats'],
    pages: [
      page('/', {
        title: 'Acme Plumbing – Leeds plumbers',
        metaDescription: 'Plumbers in Leeds, same day.',
      }),
      page('/about/', { title: 'About us – Acme Plumbing', h1: 'About Acme Plumbing' }),
      page('/services/boilers', {
        title: 'Boiler repair | Acme Plumbing',
        metaDescription: 'Boiler repair.',
      }),
    ],
    issues: checkIds.map((checkId) => ({
      checkId,
      message: checkId,
      url: checkId.startsWith('onpage') ? `${ORIGIN}/` : undefined,
    })),
    checks: {},
    score: { overall: 0, grade: 'F', pillars: [] },
    priorities: [],
    probes: [],
    botFetches: [],
    robots: {
      found: true,
      status: 200,
      body: 'User-agent: *\nDisallow: /admin/\n\nUser-agent: GPTBot\nDisallow: /\n',
    },
    sitemaps: [{ url: `${ORIGIN}/sitemap.xml`, found: true, urls: 3, errors: [] }],
    external: {},
    ...extra,
  };
}

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'avc-data-'));
});

describe('detectRepoStack', () => {
  it('detects fixtures', () => {
    expect(detectRepoStack(join(FIXTURES, 'next-app'))).toMatchObject({
      stack: 'nextjs',
      router: 'app',
      appDir: 'app',
      publicDir: 'public',
    });
    expect(detectRepoStack(join(FIXTURES, 'astro-site'))).toMatchObject({
      stack: 'astro',
      host: 'netlify',
      publicDir: 'public',
    });
    expect(detectRepoStack(join(FIXTURES, 'static-site'))).toMatchObject({
      stack: 'static',
      publicDir: '',
    });
  });
});

describe('Next.js repo', () => {
  it('plans robots, llms.txt, JSON-LD, metadata and headers as a diff, writes on apply, rolls back', async () => {
    const repo = copy('next-app');
    mkdirSync(join(repo, '.git'));
    const result = audit('nextjs', [
      'ai-crawlers.oai-searchbot-blocked',
      'llms-txt.missing',
      'schema.organization-missing',
      'onpage.title-missing',
      'security.hsts-missing',
      'geo-content.answer-not-first',
    ]);
    const plan = await planRepoFixes(result, repo);
    const paths = plan.changes.map((c) => `${c.action}:${c.path}`).sort();
    expect(paths).toEqual([
      'create:components/avc-site-json-ld.tsx',
      'create:public/llms.txt',
      'modify:app/layout.tsx',
      'modify:next.config.ts',
      'modify:public/robots.txt',
    ]);
    expect(plan.branchSuggestion).toMatch(/^avc\/ai-visibility-fixes-\d{8}$/);
    expect(plan.notes[0]).toContain('git switch -c');

    const layout = plan.changes.find((c) => c.path === 'app/layout.tsx')!.after;
    expect(layout).toContain("import type { Metadata } from 'next';");
    expect(layout).toContain("import { SiteJsonLd } from '../components/avc-site-json-ld';");
    expect(layout).toMatch(/<body className=\{inter.className\}>\n\s+<SiteJsonLd \/>/);
    expect(layout).toContain('export const metadata: Metadata = {');
    expect(layout).toContain('template: "%s – Acme Plumbing"');

    const robots = plan.changes.find((c) => c.path === 'public/robots.txt')!;
    expect(robots.after).toContain('User-agent: OAI-SearchBot');
    expect(robots.after).toMatch(/User-agent: GPTBot[\s\S]*Disallow: \/\n/); // training opt-out kept
    expect(robots.diff).toContain('--- a/public/robots.txt');

    const cfg = plan.changes.find((c) => c.path === 'next.config.ts')!.after;
    expect(cfg).toContain('async headers()');
    expect(cfg).toContain('Strict-Transport-Security');
    expect(plan.diff).toContain('+++ b/public/llms.txt');
    expect(plan.skipped).toEqual([]);

    // dry run writes nothing
    const dry = applyRepoPlan(plan, { dryRun: true, dataDir });
    expect(dry.results.every((r) => r.status === 'planned')).toBe(true);
    expect(existsSync(join(repo, 'public/llms.txt'))).toBe(false);

    const out = applyRepoPlan(plan, { dryRun: false, dataDir });
    expect(out.results.every((r) => r.status === 'written')).toBe(true);
    expect(readFileSync(join(repo, 'public/llms.txt'), 'utf8')).toContain('# Acme Plumbing');
    expect(
      existsSync(join(out.snapshotFile!.replace(/\.json$/, ''), 'files', 'app/layout.tsx')),
    ).toBe(true);

    const original = readFileSync(join(FIXTURES, 'next-app/app/layout.tsx'), 'utf8');
    const rb = await rollback(out.snapshotFile!);
    expect(rb.target).toBe('repo');
    expect(readFileSync(join(repo, 'app/layout.tsx'), 'utf8')).toBe(original);
    expect(existsSync(join(repo, 'public/llms.txt'))).toBe(false);
    expect(existsSync(join(repo, 'components/avc-site-json-ld.tsx'))).toBe(false);
  });

  it('refuses to overwrite a file that changed after planning', async () => {
    const repo = copy('next-app');
    const plan = await planRepoFixes(audit('nextjs', ['ai-crawlers.gptbot-blocked']), repo);
    writeFileSync(join(repo, 'public/robots.txt'), 'User-agent: *\nAllow: /\n');
    const out = applyRepoPlan(plan, { dryRun: false, dataDir });
    expect(out.results[0]).toMatchObject({ path: 'public/robots.txt', status: 'skipped' });
    expect(readFileSync(join(repo, 'public/robots.txt'), 'utf8')).toBe('User-agent: *\nAllow: /\n');
  });

  it('creates app/robots.ts when there is no robots file', async () => {
    const repo = copy('next-app');
    const fs = await import('node:fs');
    fs.rmSync(join(repo, 'public/robots.txt'));
    const plan = await planRepoFixes(audit('nextjs', ['crawlability.robots-txt-missing']), repo);
    expect(plan.changes.map((c) => c.path)).toEqual(['app/robots.ts']);
    expect(plan.changes[0].after).toContain('MetadataRoute.Robots');
  });

  it('rollback leaves files edited after apply alone', async () => {
    const repo = copy('next-app');
    const plan = await planRepoFixes(audit('nextjs', ['llms-txt.missing']), repo);
    const out = applyRepoPlan(plan, { dryRun: false, dataDir });
    writeFileSync(join(repo, 'public/llms.txt'), '# edited by hand\n');
    const res = rollbackRepo(out.snapshotFile!);
    expect(res[0].status).toBe('skipped');
    expect(readFileSync(join(repo, 'public/llms.txt'), 'utf8')).toBe('# edited by hand\n');
  });
});

describe('Astro repo', () => {
  it('patches the layout and netlify.toml', async () => {
    const repo = copy('astro-site');
    const plan = await planRepoFixes(
      audit('astro', [
        'schema.organization-missing',
        'security.x-content-type-options-missing',
        'llms-txt.missing',
      ]),
      repo,
    );
    const layout = plan.changes.find((c) => c.path === 'src/layouts/Layout.astro')!.after;
    expect(layout).toMatch(
      /<script type="application\/ld\+json" set:html=\{JSON.stringify\(\{[\s\S]*"@graph"[\s\S]*\}\)\} \/>\n  <\/head>/,
    );
    const toml = plan.changes.find((c) => c.path === 'netlify.toml')!.after;
    expect(toml).toContain(
      '[[headers]]\n  for = "/*"\n  [headers.values]\n    X-Content-Type-Options = "nosniff"',
    );
    expect(plan.changes.some((c) => c.path === 'public/llms.txt')).toBe(true);
  });
});

describe('static repo', () => {
  it('sets titles and descriptions in HTML files and skips headers already present', async () => {
    const repo = copy('static-site');
    const result = audit('static', ['security.x-content-type-options-missing'], {});
    result.issues.push(
      { checkId: 'onpage.title-too-short', url: `${ORIGIN}/`, message: 'short' },
      { checkId: 'onpage.meta-description-too-short', url: `${ORIGIN}/about/`, message: 'short' },
    );
    const plan = await planRepoFixes(result, repo);
    const index = plan.changes.find((c) => c.path === 'index.html')!.after;
    expect(index).toContain('<title>Acme Plumbing in Leeds</title>');
    const about = plan.changes.find((c) => c.path === 'about/index.html')!.after;
    expect(about).toContain(
      '<meta name="description" content="Acme Plumbing is a family business founded in Leeds.',
    );
    expect(plan.skipped).toEqual([
      {
        checkId: 'security.x-content-type-options-missing',
        reason: '_headers already sets these headers',
      },
    ]);
  });
});

describe('applyFixes → repo', () => {
  it('uses connections.repoPath and returns a summary', async () => {
    const repo = copy('static-site');
    const config: AvcConfig = {
      dataDir,
      sites: [{ id: 'acme.test', url: ORIGIN, connections: { repoPath: repo } }],
      ai: { maxRunUsd: 1, maxMonthUsd: 1, mock: true },
      server: { port: 0, host: '127.0.0.1' },
    };
    const out = await applyFixes({
      result: audit('static', ['llms-txt.missing', 'schema.organization-missing']),
      config,
      target: 'repo',
      dryRun: true,
    });
    expect(out.target).toBe('repo');
    if (out.target !== 'repo') return;
    expect(out.planned).toBe(2);
    expect(out.diff).toContain('+++ b/llms.txt');
    expect(out.summary).toContain('Dry run');
    await expect(
      applyFixes({
        result: audit('static', []),
        config: { ...config, sites: [] },
        target: 'repo',
        dryRun: true,
      }),
    ).rejects.toThrow(/repoPath/);
  });
});
