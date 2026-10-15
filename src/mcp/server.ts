/**
 * `avc mcp`: an MCP server on stdio so Claude Code, Claude Desktop, Cursor and VS Code can run
 * audits, read issues and fixes, check AI visibility and apply fixes (dry run by default).
 * Nothing is written to stdout except protocol messages; logs go to stderr.
 */
import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildRobots } from '../crawl/robots.js';
import { AI_BOTS } from '../agentic/bots.js';
import { parseLlmsTxt } from '../agentic/llms.js';
import { explainGaps } from '../ai/gaps.js';
import { aiUnavailableReason } from '../ai/availability.js';
import { skippedSummary } from '../audit/index.js';
import { SECRET_FIELDS, secretSource, secretStore } from '../core/secrets.js';
import { startKeyPage, type KeyPage } from '../server/key-page.js';
import { openPath } from '../cli/open.js';
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
  parseFormats,
  rollbackSnapshot,
  snapshots,
  writeReports,
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
    // Tell the user what did not run and why; nothing is skipped silently.
    skipped: skippedForTools(result),
  };
}

export function skippedForTools(result: AuditResult) {
  const s = skippedSummary(result);
  return {
    steps: s.steps.map((x) => ({ step: x.step, reason: x.reason })),
    checks: s.checks.map((g) => ({
      reason: g.reason,
      count: g.checks.length,
      examples: g.checks.slice(0, 5),
    })),
    totalChecks: s.total,
  };
}

const NEVER_PASTE =
  'Never ask the user to paste an API key into this chat: keys must go through the private local page (setup_keys) or `avc keys setup` in a terminal, so they never reach the AI model.';

/** Which keys are set (never their values), for tool output. */
function keysOverview() {
  return {
    storedIn: secretStore().where,
    aiReady: !aiUnavailableReason(getConfig(true)),
    keys: SECRET_FIELDS.map((f) => ({
      id: f.id,
      label: f.label,
      group: f.group,
      set: secretSource(f) !== 'none',
      source: secretSource(f),
      unlocks: f.unlocks,
    })),
  };
}

type Extra = {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
};

export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'avc', version: APP_VERSION, title: APP_NAME },
    {
      instructions:
        "AI Visibility Checker audits a website for search and AI engines. Audits need no API keys. AI visibility runs need the user's own AI keys, which stay on their computer. When a tool reports missing keys, call setup_keys: it gives the user a private local page to type them. " +
        NEVER_PASTE +
        ' When results list skipped steps or checks, tell the user what was skipped and why.',
    },
  );

  // One key page at a time; reuse it while it is open.
  let keyPage: { page: KeyPage; settled: boolean } | null = null;
  const openKeyPage = async (reason: string): Promise<KeyPage> => {
    if (keyPage && !keyPage.settled) return keyPage.page;
    const page = await startKeyPage({ reason });
    const entry = { page, settled: false };
    keyPage = entry;
    void page.done.then(() => (entry.settled = true));
    return page;
  };

  /**
   * Ask the user for keys without them passing through the chat. With clients that support
   * URL elicitation (MCP 2025-11-25), the client opens the page itself and is told when the
   * user has saved. Otherwise the link comes back for the assistant to show the user.
   */
  const requestKeys = async (
    reason: string,
    opts: { open?: boolean } = {},
  ): Promise<{ status: 'saved' | 'skipped' | 'declined' | 'waiting' | 'link'; url: string }> => {
    const page = await openKeyPage(reason);
    const caps = server.server.getClientCapabilities() as
      { elicitation?: { url?: object } } | undefined;
    if (caps?.elicitation?.url) {
      const elicitationId = randomUUID();
      const notify = server.server.createElicitationCompletionNotifier(elicitationId);
      void page.done.then((o) => (o === 'saved' ? notify().catch(() => {}) : undefined));
      try {
        const r = await server.server.elicitInput({
          mode: 'url',
          message: `${reason} Open this private page on your computer to add your API keys. They are saved in your OS keychain and never pass through this chat.`,
          url: page.url,
          elicitationId,
        });
        if (r.action !== 'accept') return { status: 'declined', url: page.url };
        const outcome = await Promise.race([
          page.done,
          new Promise<'waiting'>((res) => setTimeout(() => res('waiting'), 120_000).unref()),
        ]);
        return {
          status: outcome === 'saved' || outcome === 'skipped' ? outcome : 'waiting',
          url: page.url,
        };
      } catch {
        /* the client refused URL mode after all: fall back to the link */
      }
    }
    if (opts.open) openPath(page.url);
    return { status: 'link', url: page.url };
  };

  const keysNeeded = (
    what: string,
    reason: string,
    got: { status: string; url: string },
  ): ToolResult =>
    json({
      skipped: true,
      step: what,
      reason,
      addKeys:
        got.status === 'declined'
          ? 'The user declined to add keys. Do not ask again unless they bring it up.'
          : got.status === 'skipped'
            ? 'The user chose to skip adding keys.'
            : {
                link: got.url,
                instructions:
                  'Show this link to the user. It opens a private page on their own computer (it only works there and expires in 15 minutes). After they save, call this tool again.',
                terminalAlternative: 'avc keys setup',
              },
      note: NEVER_PASTE,
    });
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
    async (
      a: { url: string; max_pages?: number; render?: boolean; only?: string[] },
      extra: Extra,
    ): Promise<ToolResult> => {
      try {
        const site = resolveSite(a.url);
        // Progress notifications keep clients that reset their timeout on progress waiting
        // through a long crawl instead of giving up.
        const token = extra?._meta?.progressToken;
        let step = 0;
        const onProgress = (e: ProgressEvent) => {
          log(e);
          if (token === undefined || !extra.sendNotification) return;
          if (e.type !== 'phase' && !(e.type === 'log' && e.level === 'info')) return;
          step += 1;
          void extra
            .sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken: token,
                progress: step,
                message:
                  e.type === 'phase' ? `${e.phase}${e.message ? `: ${e.message}` : ''}` : e.message,
              },
            })
            .catch(() => {});
        };
        const r = await audit({
          url: site.url,
          site,
          maxPages: a.max_pages,
          render: a.render,
          only: a.only,
          onProgress,
        });
        const out = summarise(r);
        return json(
          aiUnavailableReason(getConfig())
            ? {
                ...out,
                keys: {
                  aiReady: false,
                  note: 'AI visibility was not measured because no AI key is set. Offer the user setup_keys if they want it.',
                },
              }
            : out,
        );
      } catch (e) {
        return fail(errMsg(e));
      }
    },
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
        let config = getConfig();
        const site = resolveSite(a.site, config);
        if (a.run && aiUnavailableReason(config)) {
          const reason = aiUnavailableReason(config)!;
          const got = await requestKeys('Measuring AI visibility needs an AI API key.');
          config = getConfig(true);
          if (aiUnavailableReason(config)) return keysNeeded('ai-visibility', reason, got);
        }
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
  // ---- Added for feature parity: audits list, PageSpeed, reports, snippets, questions,
  // ---- WordPress redirects and rollback.

  server.registerTool(
    'list_audits',
    {
      title: 'List audits',
      description:
        'Stored audits for a site (or every site), newest first, with score and issue counts.',
      inputSchema: {
        site: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard((a: { site?: string; limit?: number }) => {
      const store = getStore();
      const sites = a.site ? [resolveSite(a.site)] : allSites();
      const out = sites.flatMap((s) =>
        store.listAudits(s.id, a.limit ?? 20).map((x) => ({ ...x, siteId: s.id })),
      );
      return json(
        out.sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, a.limit ?? 20),
      );
    }),
  );

  server.registerTool(
    'pagespeed',
    {
      title: 'PageSpeed Insights',
      description:
        'Lab (Lighthouse) and field (CrUX) Core Web Vitals for one URL from Google PageSpeed Insights. Uses PSI_API_KEY when set (works without one at a low rate).',
      inputSchema: { url: z.string(), strategy: z.enum(['mobile', 'desktop']).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard(async (a: { url: string; strategy?: 'mobile' | 'desktop' }) => {
      const { collectPsi } = await import('../connect/psi.js');
      const r = await collectPsi([a.url], {
        key: getConfig().google?.psiKey,
        strategies: [a.strategy ?? 'mobile'],
      });
      return json(Object.values(r));
    }),
  );

  server.registerTool(
    'generate_report',
    {
      title: 'Write a report',
      description:
        'Write report files for an audit: html, md, csv, json, sarif, xlsx or pdf (pdf needs local Chrome). Returns the file paths.',
      inputSchema: {
        site: z.string().optional(),
        auditId: z.string().optional(),
        formats: z.array(z.enum(['html', 'md', 'csv', 'json', 'sarif', 'xlsx', 'pdf'])).optional(),
        outDir: z.string().optional(),
      },
    },
    guard(async (a: { site?: string; auditId?: string; formats?: string[]; outDir?: string }) => {
      const r = needAudit(a.site, a.auditId);
      const prev = previousAudit(r);
      const warnings: string[] = [];
      const files = await writeReports(
        r,
        parseFormats((a.formats ?? ['html']).join(',')),
        a.outDir ?? 'avc-reports',
        { diff: prev ? diff(prev, r) : undefined },
        (m) => warnings.push(m),
      );
      return json({ files, warnings });
    }),
  );

  server.registerTool(
    'serp_preview',
    {
      title: 'Search snippet preview',
      description:
        'How titles and descriptions render in search results: pixel width, truncation, and descriptions too thin to give AI context. Problems only unless all is true.',
      inputSchema: {
        site: z.string(),
        all: z.boolean().optional(),
        limit: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { site: string; all?: boolean; limit?: number }) => {
      const { serpRow, serpSummary } = await import('../report/serp.js');
      const r = needAudit(a.site);
      const rows = r.pages
        .filter((p) => p.status === 200 && p.indexable)
        .map((p) => serpRow(p.url, p.title, p.metaDescription));
      const shown = a.all
        ? rows
        : rows.filter(
            (x) =>
              !x.title ||
              !x.description ||
              x.titleTruncated ||
              x.descriptionTruncated ||
              x.descriptionThinForAi,
          );
      return json({ summary: serpSummary(rows), rows: shown.slice(0, a.limit ?? 50) });
    }),
  );

  server.registerTool(
    'ask_audit',
    {
      title: 'Ask about an audit',
      description:
        'Answer a question about the latest audit of a site using the configured writer model (or the ranked priorities when no key is set).',
      inputSchema: { site: z.string(), question: z.string() },
      annotations: { readOnlyHint: true },
    },
    guard(async (a: { site: string; question: string }) => {
      const { askAboutAudit } = await import('../ai/ask.js');
      const r = await askAboutAudit(needAudit(a.site), a.question, getConfig());
      return text(r.answer);
    }),
  );

  server.registerTool(
    'create_redirect',
    {
      title: 'Add a WordPress redirect',
      description:
        'Add a 301 (or 302/307/308) redirect on a connected WordPress site through the AVC helper. Dry run unless confirm is true; a rollback snapshot is written before the change.',
      inputSchema: {
        site: z.string(),
        from: z.string(),
        to: z.string(),
        code: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    guard(
      async (a: {
        site: string;
        from: string;
        to: string;
        code?: 301 | 302 | 307 | 308;
        confirm?: boolean;
      }) => {
        const { addWordPressRedirect } = await import('../fixes/apply/index.js');
        const r = await addWordPressRedirect({
          config: getConfig(),
          site: resolveSite(a.site),
          from: a.from,
          to: a.to,
          code: a.code,
          dryRun: a.confirm !== true,
        });
        return text(r.summary);
      },
    ),
  );

  server.registerTool(
    'rollback',
    {
      title: 'Undo applied fixes',
      description:
        'Restore the values saved in a rollback snapshot (WordPress or repository) written by apply_fixes or create_redirect. Requires confirm: true.',
      inputSchema: {
        snapshotFile: z.string().optional(),
        site: z.string().optional(),
        confirm: z.boolean().optional(),
      },
      annotations: { destructiveHint: true },
    },
    guard(async (a: { snapshotFile?: string; site?: string; confirm?: boolean }) => {
      const files = snapshots(getConfig(), a.site ? resolveSite(a.site).id : undefined);
      const file = a.snapshotFile ?? files[0];
      if (!file) return fail('No rollback snapshots found.');
      if (a.confirm !== true)
        return text(
          `Would restore ${file}. Call again with confirm: true to undo it.\nSnapshots:\n${files.slice(0, 10).join('\n')}`,
        );
      return json(await rollbackSnapshot(file));
    }),
  );

  server.registerTool(
    'keys_status',
    {
      title: 'API key status',
      description:
        'Which API keys are set (never their values), where they are stored on this computer, and whether AI visibility can run. ' +
        NEVER_PASTE,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(() => json(keysOverview())),
  );

  server.registerTool(
    'setup_keys',
    {
      title: 'Add API keys (private page)',
      description:
        "Let the user add their AI and data-source API keys. Opens a private page on the user's own computer where they type the keys; the keys are saved in the OS keychain and never pass through this chat or the AI model. Use when the user wants AI visibility (or another key-based check) and keys are missing. " +
        NEVER_PASTE,
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    guard(async () => {
      const got = await requestKeys('Add the keys you want AI Visibility Checker to use.', {
        open: true,
      });
      const overview = keysOverview();
      if (got.status === 'link')
        return json({
          status: 'waiting-for-user',
          link: got.url,
          instructions:
            "A page was opened in the user's browser. If it did not open, show them this link (it only works on their computer and expires in 15 minutes). After they save, call keys_status to confirm.",
          ...overview,
        });
      return json({ status: got.status, ...overview });
    }),
  );

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
      const body = r ? String(renderReport(r, 'md')[0].body) : `No audit for ${site} yet.`;
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
