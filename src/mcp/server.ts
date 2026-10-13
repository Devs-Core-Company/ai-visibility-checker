/**
 * `avc mcp`: an MCP server on stdio so Claude Code, Claude Desktop, Cursor and VS Code can run
 * audits, read issues and fixes, check AI visibility and apply fixes (dry run by default).
 * Nothing is written to stdout except protocol messages; logs go to stderr.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildRobots } from '../crawl/robots.js';
import { AI_BOTS } from '../agentic/bots.js';
import { parseLlmsTxt } from '../agentic/llms.js';
import { explainGaps } from '../ai/gaps.js';
import { APP_NAME, APP_VERSION } from '../core/version.js';
import type { AuditResult, ProgressEvent } from '../core/types.js';
import {
  allSites,
  applyFixesFor,
  audit,
  diff,
  engines,
  estimateVisibilityCost,
  filterIssues,
  findAudit,
  generate,
  getConfig,
  getStore,
  listChecks,
  monthSpend,
  pickEngines,
  planFixes,
  previousAudit,
  renderReport,
  resolveSite,
  visibility,
  errMsg,
} from '../cli/services.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const json = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

function guard<A>(fn: (args: A) => Promise<ToolResult> | ToolResult) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(errMsg(e));
    }
  };
}

function needAudit(site: string | undefined, auditId?: string): AuditResult {
  const a = findAudit(auditId ?? site, getConfig());
  if (!a)
    throw new Error(`No audit found${site ? ` for ${site}` : ''}. Run the audit_site tool first.`);
  return a;
}

/** Compact audit summary for tool output (the full result is large). */
export function summarise(result: AuditResult, top = 10) {
  return {
    auditId: result.id,
    site: result.site,
    at: result.at,
    score: result.score.overall,
    grade: result.score.grade,
    readinessOnly: !result.visibility,
    pillars: Object.fromEntries(
      result.score.pillars.map((p) => [p.pillar, p.weight ? p.score : null]),
    ),
    pages: result.stats.pagesCrawled,
    issues: result.issues.length,
    stack: result.stack.id,
    priorities: result.priorities.slice(0, top).map((p) => ({
      checkId: p.checkId,
      title: result.checks[p.checkId]?.title,
      severity: result.checks[p.checkId]?.severity,
      affected: p.affected,
      fix: p.fix?.steps?.[0] ?? result.checks[p.checkId]?.fix,
    })),
    visibility: result.visibility
      ? {
          mentionRate: result.visibility.summary.mentionRate,
          costUsd: result.visibility.summary.costUsd,
        }
      : undefined,
  };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'avc', version: APP_VERSION, title: APP_NAME });
  const log = (e: ProgressEvent) => {
    if (e.type === 'phase')
      process.stderr.write(`[avc] ${e.phase}${e.message ? `: ${e.message}` : ''}\n`);
    else if (e.type === 'log' && e.level !== 'info')
      process.stderr.write(`[avc] ${e.level}: ${e.message}\n`);
  };

  server.registerTool(
    'audit_site',
    {
      title: 'Audit a site',
      description:
        'Crawl a website and run every technical SEO, content, AI crawler, AEO/GEO and agentic-web check. Saves the audit and returns the score, pillar scores and top priorities. Takes from seconds to minutes depending on max_pages.',
      inputSchema: {
        url: z.string().describe('Site URL or configured site id'),
        max_pages: z
          .number()
          .int()
          .min(1)
          .max(100000)
          .optional()
          .describe('Default 500 (or the site config)'),
        render: z
          .boolean()
          .optional()
          .describe('Render pages in Chrome to compare raw vs JavaScript output'),
        only: z
          .array(z.string())
          .optional()
          .describe('Check ids, id prefixes, categories or pillars'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(async (a: { url: string; max_pages?: number; render?: boolean; only?: string[] }) => {
      const site = resolveSite(a.url);
      const r = await audit({
        url: site.url,
        site,
        maxPages: a.max_pages,
        render: a.render,
        only: a.only,
        onProgress: log,
      });
      return json(summarise(r));
    }),
  );

  server.registerTool(
    'get_issues',
    {
      title: 'Get issues',
      description:
        'Issues from the latest (or a given) audit, filtered by pillar, category, severity, check id, URL or text.',
      inputSchema: {
        site: z.string().optional().describe('Site URL or id (default: latest audit of any site)'),
        audit_id: z.string().optional(),
        pillar: z
          .enum(['technical', 'content', 'ai-access', 'geo', 'agentic', 'ai-visibility'])
          .optional(),
        category: z.string().optional(),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
        check_id: z.string().optional(),
        url: z.string().optional(),
        q: z.string().optional().describe('Free-text search'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 100'),
      },
      annotations: { readOnlyHint: true },
    },
    guard(
      (a: {
        site?: string;
        audit_id?: string;
        pillar?: string;
        category?: string;
        severity?: string;
        check_id?: string;
        url?: string;
        q?: string;
        limit?: number;
      }) => {
        const r = needAudit(a.site, a.audit_id);
        const issues = filterIssues(r, {
          pillar: a.pillar,
          category: a.category,
          severity: a.severity,
          checkId: a.check_id,
          url: a.url,
          q: a.q,
        });
        const limit = a.limit ?? 100;
        return json({
          auditId: r.id,
          total: issues.length,
          shown: Math.min(limit, issues.length),
          issues: issues.slice(0, limit).map((i) => ({
            ...i,
            title: r.checks[i.checkId]?.title,
            severity: i.severity ?? r.checks[i.checkId]?.severity,
            pillar: r.checks[i.checkId]?.pillar,
          })),
        });
      },
    ),
  );

  server.registerTool(
    'get_page',
    {
      title: 'Get a page',
      description:
        'Everything recorded about one crawled page: status, title, meta, canonical, word counts (raw and rendered), schema types and its issues.',
      inputSchema: {
        url: z.string(),
        site: z.string().optional(),
        audit_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard((a: { url: string; site?: string; audit_id?: string }) => {
      const r = needAudit(a.site ?? a.url, a.audit_id);
      const page = r.pages.find(
        (p) => p.url === a.url || p.finalUrl === a.url || p.url === a.url.replace(/\/$/, ''),
      );
      if (!page) return fail(`${a.url} was not crawled in audit ${r.id}.`);
      return json({
        page,
        issues: r.issues.filter((i) => i.url === page.url || i.url === page.finalUrl),
      });
    }),
  );

  server.registerTool(
    'get_fix',
    {
      title: 'Get the fix for a check',
      description:
        "Stack-aware fix for a check (steps, files, snippet) plus a ready prompt for a coding agent, and the affected URLs. Use the agent prompt to make the change in the site's codebase.",
      inputSchema: {
        check_id: z.string(),
        site: z.string().optional(),
        audit_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard((a: { check_id: string; site?: string; audit_id?: string }) => {
      const r = needAudit(a.site, a.audit_id);
      const def = r.checks[a.check_id];
      if (!def) return fail(`Unknown check ${a.check_id}. Use list_checks.`);
      const fix =
        r.priorities.find((p) => p.checkId === a.check_id)?.fix ?? planFixes(r, [a.check_id])[0];
      const urls = r.issues
        .filter((i) => i.checkId === a.check_id)
        .map((i) => i.url)
        .filter(Boolean);
      return json({
        check: def,
        stack: r.stack.id,
        fix: fix ?? { steps: [def.fix] },
        affected: urls.length,
        urls: urls.slice(0, 200),
      });
    }),
  );

  server.registerTool(
    'list_checks',
    {
      title: 'List checks',
      description:
        'Every check AVC runs, with pillar, category, severity, fix tier and what optional data it needs.',
      inputSchema: {
        pillar: z.string().optional(),
        category: z.string().optional(),
        search: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard((a: { pillar?: string; category?: string; search?: string }) => {
      const defs = listChecks(a);
      return json({
        total: defs.length,
        checks: defs.map((d) => ({
          id: d.id,
          title: d.title,
          pillar: d.pillar,
          category: d.category,
          severity: d.severity,
          fixTier: d.fixTier,
          requires: d.requires,
        })),
      });
    }),
  );

  server.registerTool(
    'ai_visibility',
    {
      title: 'AI visibility',
      description:
        "Whether ChatGPT, Claude, Gemini and Perplexity name and cite the brand. By default returns the latest stored run (free). With run=true it asks the engines using the user's API keys: this COSTS MONEY. Call first with run=true and confirm_spend=false to get the estimate, show it to the user, then call again with confirm_spend=true. Respects the per-run and monthly caps.",
      inputSchema: {
        site: z.string(),
        run: z.boolean().optional(),
        confirm_spend: z.boolean().optional(),
        engines: z.array(z.string()).optional(),
        repeats: z.number().int().min(1).max(10).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard(
      async (a: {
        site: string;
        run?: boolean;
        confirm_spend?: boolean;
        engines?: string[];
        repeats?: number;
      }) => {
        const config = getConfig();
        const site = resolveSite(a.site, config);
        if (!a.run) {
          const last = getStore(config).latestVisibility(site.id);
          if (!last)
            return text(
              `No AI visibility run stored for ${site.id}. Call again with run=true to get a cost estimate.`,
            );
          return json({
            ...last,
            answers: last.answers.map((x) => ({ ...x, answer: x.answer.slice(0, 600) })),
            gaps: explainGaps(last).slice(0, 15),
          });
        }
        const ids = pickEngines(a.engines, config);
        const prompts = site.prompts?.length
          ? site.prompts
          : Array.from({ length: 12 }, () => ({ search: true }));
        const est = estimateVisibilityCost(ids, prompts, a.repeats ?? 1, config);
        const spent = monthSpend(config);
        if (!est.mock && !a.confirm_spend)
          return json({
            needsConfirmation: true,
            engines: ids,
            answers: est.answers,
            estimatedMaxUsd: Number(est.total.toFixed(2)),
            caps: {
              perRunUsd: config.ai.maxRunUsd,
              perMonthUsd: config.ai.maxMonthUsd,
              spentThisMonthUsd: Number(spent.toFixed(2)),
            },
            next: 'Ask the user, then call again with confirm_spend=true.',
          });
        const r = await visibility(
          { site, engines: ids, repeats: a.repeats, onProgress: log },
          config,
        );
        return json({ id: r.id, summary: r.summary, gaps: explainGaps(r).slice(0, 15) });
      },
    ),
  );

  server.registerTool(
    'diff_audits',
    {
      title: 'Compare audits',
      description:
        'What changed between two audits: score, new and fixed issues, pages, AI visibility. With only a site, compares its last two audits.',
      inputSchema: {
        site: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard((a: { site?: string; from?: string; to?: string }) => {
      const store = getStore();
      const next = a.to ? store.getAudit(a.to) : needAudit(a.site);
      if (!next) return fail('Audit not found.');
      const prev = a.from ? store.getAudit(a.from) : previousAudit(next);
      if (!prev) return fail('There is no earlier audit to compare with.');
      return json(diff(prev, next));
    }),
  );

  const gen = (kind: 'llms-txt' | 'robots' | 'schema' | 'agent-card') =>
    guard(
      (a: {
        site: string;
        policy?: 'allow-all' | 'allow-search' | 'block-training' | 'block-all';
      }) => {
        const r = needAudit(a.site);
        const g = generate(kind, r, resolveSite(r.startUrl || r.site), { policy: a.policy });
        return text(`${g.body}\n\n---\n${g.where}`);
      },
    );

  server.registerTool(
    'generate_llms_txt',
    {
      title: 'Generate llms.txt',
      description: 'An llms.txt built from the latest audit of the site.',
      inputSchema: { site: z.string() },
      annotations: { readOnlyHint: true },
    },
    gen('llms-txt'),
  );
  server.registerTool(
    'generate_robots_txt',
    {
      title: 'Generate robots.txt',
      description:
        "The site's robots.txt with an AVC-managed block of AI crawler rules for the chosen policy.",
      inputSchema: {
        site: z.string(),
        policy: z.enum(['allow-all', 'allow-search', 'block-training', 'block-all']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    gen('robots'),
  );
  server.registerTool(
    'generate_schema',
    {
      title: 'Generate Organization JSON-LD',
      description: 'Organization + WebSite JSON-LD for the home page.',
      inputSchema: { site: z.string() },
      annotations: { readOnlyHint: true },
    },
    gen('schema'),
  );

  server.registerTool(
    'plan_fixes',
    {
      title: 'Plan fixes',
      description:
        'All fixes for the latest audit, ranked, with stack-specific steps and agent prompts. Optionally a dry-run preview of what would change on WordPress or in a local repo (writes nothing).',
      inputSchema: {
        site: z.string(),
        target: z.enum(['wordpress', 'repo']).optional(),
        only: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { site: string; target?: 'wordpress' | 'repo'; only?: string[] }) => {
      const r = needAudit(a.site);
      const fixes = planFixes(r, a.only);
      if (!a.target) return json({ auditId: r.id, stack: r.stack.id, fixes: fixes.slice(0, 60) });
      const preview = await applyFixesFor({
        result: r,
        site: resolveSite(r.startUrl || r.site),
        target: a.target,
        dryRun: true,
        only: a.only,
      });
      return json({ auditId: r.id, dryRun: true, preview });
    }),
  );

  server.registerTool(
    'apply_fixes',
    {
      title: 'Apply fixes',
      description:
        'Apply automatic fixes to WordPress (saves a rollback snapshot) or as patches to a local repo. Dry run unless confirm=true. Always show the user the dry-run result and get their explicit go-ahead before confirm=true.',
      inputSchema: {
        site: z.string(),
        target: z.enum(['wordpress', 'repo']),
        only: z.array(z.string()).optional(),
        confirm: z.boolean().optional().describe('Must be true to change anything'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    guard(
      async (a: {
        site: string;
        target: 'wordpress' | 'repo';
        only?: string[];
        confirm?: boolean;
      }) => {
        const r = needAudit(a.site);
        const out = await applyFixesFor({
          result: r,
          site: resolveSite(r.startUrl || r.site),
          target: a.target,
          dryRun: a.confirm !== true,
          only: a.only,
        });
        return json({
          dryRun: a.confirm !== true,
          ...out,
          ...(a.confirm !== true
            ? { next: 'Nothing changed. Call again with confirm=true after the user approves.' }
            : {}),
        });
      },
    ),
  );

  server.registerTool(
    'crawler_access',
    {
      title: 'AI crawler access',
      description:
        'For every known AI crawler: allowed or blocked by robots.txt (with the deciding line), and the live fetch verdict (blocked by a firewall or challenge, different content, ok).',
      inputSchema: { site: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard((a: { site: string }) => {
      const r = needAudit(a.site);
      const robots = buildRobots(`${r.site}/robots.txt`, r.robots.body ?? '', {
        status: r.robots.status,
        found: r.robots.found,
      });
      const home = r.startUrl || `${r.site}/`;
      const fetches = new Map(r.botFetches.map((b) => [b.token.toLowerCase(), b]));
      return json(
        AI_BOTS.map((b) => {
          const f = fetches.get(b.token.toLowerCase());
          return {
            token: b.token,
            operator: b.operator,
            purpose: b.purpose,
            robots:
              b.robotsToken === false
                ? 'n/a'
                : robots.isAllowed(home, b.token)
                  ? 'allowed'
                  : 'blocked',
            decidingLine: b.robotsToken === false ? null : robots.decidingLine(home, b.token),
            liveFetch: f
              ? { verdict: f.verdict, status: f.status, words: f.words, challenge: f.challenge }
              : null,
          };
        }),
      );
    }),
  );

  server.registerTool(
    'agentic_readiness',
    {
      title: 'Agentic-web readiness',
      description:
        'Origin probes (llms.txt, MCP server card, A2A agent card, OAuth discovery, markdown negotiation, Web Bot Auth, commerce rails…), the llms.txt structure and every agentic check result.',
      inputSchema: { site: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard((a: { site: string }) => {
      const r = needAudit(a.site);
      const llms = r.probes.find((p) => p.id === 'llms-txt' || /\/llms\.txt$/i.test(p.url));
      return json({
        probes: r.probes.map(({ body: _b, parsed: _p, headers: _h, ...p }) => p),
        llmsTxt: llms?.found && llms.body ? parseLlmsTxt(llms.body, llms.url) : null,
        checks: Object.values(r.checks)
          .filter((d) => d.pillar === 'agentic' || d.category === 'llms-txt')
          .map((d) => ({
            id: d.id,
            title: d.title,
            status: d.status,
            failing: d.affected > 0,
            skippedReason: d.skippedReason,
          })),
      });
    }),
  );

  server.registerTool(
    'list_sites',
    {
      title: 'List sites',
      description: 'Configured sites and sites with stored audits, plus available AI engines.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(() =>
      json({
        sites: allSites(),
        engines: engines().map((e) => ({
          engine: e.engine,
          available: e.available,
          via: e.via,
          note: e.note,
        })),
      }),
    ),
  );

  // Resources: the latest report per site.
  server.registerResource(
    'latest-report',
    new ResourceTemplate('avc://report/{site}', {
      list: () => ({
        resources: allSites()
          .filter((s) => s.lastAuditAt)
          .map((s) => ({
            uri: `avc://report/${s.id}`,
            name: `Latest AVC report: ${s.id}`,
            mimeType: 'text/markdown',
          })),
      }),
    }),
    {
      title: 'Latest audit report',
      description: 'The latest audit for a site as Markdown.',
      mimeType: 'text/markdown',
    },
    async (uri, vars) => {
      const site = String(vars.site);
      const r = findAudit(site);
      const body = r ? renderReport(r, 'md')[0].body : `No audit for ${site} yet.`;
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: body }] };
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[avc] MCP server ${APP_VERSION} ready on stdio\n`);
}
