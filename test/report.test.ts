import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAudit } from '../src/audit/index.js';
import type { AuditResult, Fix } from '../src/core/types.js';
import { diffAudits } from '../src/monitor/diff.js';
import { openStore } from '../src/monitor/store.js';
import {
  csvField,
  renderDiffMarkdown,
  renderHtmlReport,
  renderMarkdownReport,
  toCsv,
  toJson,
  toSarif,
} from '../src/report/index.js';
import { robotsRuleFor } from '../src/report/util.js';
import {
  config,
  def,
  minimalResult,
  page,
  pageCheck,
  site,
  siteCheck,
  visibilityRun,
} from './audit-fixtures.js';

async function rich(
  id = 'r1',
  at = '2026-02-01T00:00:00.000Z',
  extraIssue = false,
): Promise<AuditResult> {
  const r = await runAudit(
    { url: 'https://example.com/', config, visibility: true },
    {
      now: () => new Date(at),
      crawlSite: async () =>
        site([
          page('https://example.com/', { title: '<script>alert(1)</script>' }),
          page('https://example.com/a'),
          page('https://example.com/b', { status: 404 }),
        ]),
      runAgenticProbes: async (s) => {
        s.probes.set('llms-txt', {
          id: 'llms-txt',
          url: 'https://example.com/llms.txt',
          status: 200,
          found: true,
        });
        s.probes.set('mcp-server-card', {
          id: 'mcp-server-card',
          url: 'https://example.com/.well-known/mcp.json',
          status: 404,
          found: false,
        });
      },
      fetchAsBots: async (s) => {
        s.botFetches = [
          {
            token: 'GPTBot',
            operator: 'OpenAI',
            purpose: 'training',
            status: 200,
            bytes: 100,
            words: 300,
            challenge: null,
            verdict: 'ok',
            ms: 10,
          },
          {
            token: 'PerplexityBot',
            operator: 'Perplexity',
            purpose: 'search',
            status: 403,
            bytes: 10,
            words: 0,
            challenge: 'cloudflare',
            verdict: 'blocked',
            ms: 10,
          },
        ];
      },
      collectExternal: async () => {},
      loadChecks: async () => [
        pageCheck(
          def('onpage.title-html', {
            severity: 'high',
            refs: ['https://developers.google.com/search'],
          }),
          (p) =>
            p.url.endsWith('/')
              ? {
                  checkId: 'onpage.title-html',
                  message: 'Title has markup',
                  evidence: '<script>"x",y</script>',
                }
              : null,
        ),
        pageCheck(
          def('response.not-found', {
            category: 'response',
            pillar: 'technical',
            severity: 'critical',
          }),
          (p) => (p.status === 404 ? { checkId: 'response.not-found', message: '404' } : null),
        ),
        siteCheck(
          def('llms-txt.missing-sections', {
            category: 'llms-txt',
            pillar: 'ai-access',
            severity: 'low',
          }),
          () =>
            extraIssue ? { checkId: 'llms-txt.missing-sections', message: '=cmd|calc' } : null,
        ),
        siteCheck(
          def('security.hsts', {
            category: 'security',
            pillar: 'technical',
            severity: 'medium',
            requires: ['psi'],
          }),
          () => null,
        ),
      ],
      inferBrand: () => ({
        name: 'Example',
        domain: 'example.com',
        aliases: [],
        services: [],
        competitors: [],
      }),
      suggestPrompts: async () => visibilityRun().prompts,
      runVisibility: async () => ({ ...visibilityRun(), id: `v-${id}` }),
      buildFixes: (res) =>
        res.priorities.map((p): Fix => ({
          checkId: p.checkId,
          stack: 'nextjs',
          tier: 'guided',
          title: 'Fix',
          steps: ['Open the file', 'Change <title>'],
          files: ['app/layout.tsx'],
          snippet: {
            language: 'tsx',
            code: 'export const metadata = { title: "</pre><b>x</b>" };',
          },
          agentPrompt: 'In app/layout.tsx, set a plain-text title.',
          autoApplicable: false,
          effort: 'minutes',
          impact: 'high',
        })),
    },
  );
  return { ...r, id };
}

describe('HTML report', () => {
  it('renders a minimal result without throwing', () => {
    const html = renderHtmlReport(minimalResult());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('Readiness only');
    expect(html).toContain('https://devs-core.com/ai-visibility-checker');
    expect(html).toContain('No failing checks');
  });

  it('renders a rich result: priorities, fixes, crawler matrix, probes, visibility, issues, pages', async () => {
    const r = await rich();
    const prev = await rich('r0', '2026-01-25T00:00:00.000Z', true);
    const dir = mkdtempSync(join(tmpdir(), 'avc-report-'));
    const store = openStore(dir);
    store.saveAudit(prev);
    store.saveAudit(r);
    const trends = store.trends('example.com');
    store.close();
    rmSync(dir, { recursive: true, force: true });

    const html = renderHtmlReport(r, { diff: diffAudits(prev, r), trends });
    // Offline: no external scripts, stylesheets or fonts.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    expect(html).not.toMatch(/fonts\.googleapis/);
    // Escaped user content
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('</pre><b>x</b>');
    // Sections
    for (const s of [
      'Fix these first',
      'AI crawler access',
      'Agentic web readiness',
      'AI visibility',
      'Every issue',
      'Pages',
      'Since the last audit',
      'Trends',
    ])
      expect(html).toContain(s);
    expect(html).toContain('Copy prompt for your AI coding assistant');
    expect(html).toContain('PerplexityBot');
    expect(html).toContain('L2: Allow: /');
    expect(html).toContain('L5: Disallow: /private');
    expect(html).toContain('mcp-server-card');
    expect(html).toContain('Share of voice');
    expect(html).toContain('Skipped checks');
    expect(html).toContain('<details');
    expect(html).not.toContain('Readiness only.');
  });
});

describe('Markdown', () => {
  it('renders the report and the diff', async () => {
    const r = await rich();
    const md = renderMarkdownReport(r);
    expect(md).toMatch(/^# AI Visibility Report/);
    expect(md).toContain('## Fix these first');
    expect(md).toContain('```tsx');
    expect(md).toContain('| Pillar | Score |');
    expect(renderMarkdownReport(minimalResult())).toContain('Readiness only');

    const prev = await rich('r0', '2026-01-25T00:00:00.000Z', true);
    const d = diffAudits(prev, r);
    const dm = renderDiffMarkdown(d, { prev, next: r });
    expect(dm).toContain('## AI Visibility Checker: changes');
    expect(dm).toContain('Fixed issues (1)');
    expect(dm).toContain('Check llms-txt.missing-sections');
    expect(renderDiffMarkdown(diffAudits(r, r))).toContain('0 new issues');
  });
});

describe('CSV, JSON, SARIF', () => {
  it('escapes CSV and neutralises formulas', async () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvField(-5)).toBe('-5');
    expect(csvField(null)).toBe('');
    const r = await rich('r', '2026-02-01T00:00:00.000Z', true);
    const issues = toCsv(r, 'issues').trim().split('\r\n');
    expect(issues[0]).toBe(
      'check_id,title,category,pillar,severity,scope,url,message,evidence,fix',
    );
    expect(issues).toHaveLength(r.issues.length + 1);
    expect(toCsv(r, 'issues')).toContain("'=cmd|calc");
    const pages = toCsv(r, 'pages').trim().split('\r\n');
    expect(pages).toHaveLength(4);
    expect(JSON.parse(toJson(r)).id).toBe('r');
  });

  it('produces valid-looking SARIF 2.1.0', async () => {
    const r = await rich();
    const s = JSON.parse(toSarif(r));
    expect(s.version).toBe('2.1.0');
    const run = s.runs[0];
    expect(run.tool.driver.name).toBe('AI Visibility Checker');
    expect(run.results).toHaveLength(r.issues.length);
    const ids = run.tool.driver.rules.map((x: { id: string }) => x.id);
    for (const res of run.results) {
      expect(ids[res.ruleIndex]).toBe(res.ruleId);
      expect(res.locations[0].physicalLocation.artifactLocation.uri).toMatch(/^https:\/\//);
      expect(res.partialFingerprints['avcIssue/v1']).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(
      run.results.find((x: { ruleId: string }) => x.ruleId === 'response.not-found').level,
    ).toBe('error');
    expect(JSON.parse(toSarif(minimalResult())).runs[0].results).toEqual([]);
  });
});

describe('robotsRuleFor', () => {
  it('picks the specific group, then the wildcard', () => {
    const body =
      'User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n';
    expect(robotsRuleFor(body, 'GPTBot')).toEqual([{ line: 6, text: 'Disallow: /' }]);
    expect(robotsRuleFor(body, 'ClaudeBot')).toEqual([{ line: 6, text: 'Disallow: /' }]);
    expect(robotsRuleFor(body, 'Bingbot')).toEqual([{ line: 2, text: 'Allow: /' }]);
    expect(robotsRuleFor('', 'x')).toEqual([]);
  });
});
