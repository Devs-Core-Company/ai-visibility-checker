/**
 * runAudit — the one pipeline the CLI, dashboard, MCP server and scheduler call.
 *
 *   crawl → agentic probes + bot fetches → external data → (visibility) →
 *   checks → score → page rows → fixes → priorities
 *
 * Every dependency is injectable (`runAudit(opts, deps)`) so tests and other
 * surfaces can swap the crawler, checks or AI engine. The defaults load their
 * modules lazily, so importing this file stays cheap.
 */
import { randomBytes } from 'node:crypto';
import pc from 'picocolors';
import type { AvcConfig, SiteConfig } from '../core/config.js';
import type {
  AuditResult,
  BrandProfile,
  Check,
  CrawlOptions,
  EngineId,
  Fix,
  Issue,
  PageData,
  PageSummary,
  ProgressFn,
  ResourceSummary,
  SiteContext,
  TrackedPrompt,
  VisibilityRun,
} from '../core/types.js';
import { APP_VERSION } from '../core/version.js';
import { aiUnavailableReason } from '../ai/availability.js';
import { runChecks, type SiteWithVisibility } from './run-checks.js';
import { PILLAR_LABELS, rankPriorities, scoreAudit, type ScoreBreakdown } from './score.js';

export { runChecks, unmetRequirement, normaliseIssues } from './run-checks.js';
export {
  scoreAudit,
  rankPriorities,
  gradeFor,
  visibilityScore,
  PILLAR_WEIGHTS,
  PILLAR_LABELS,
  PILLAR_ORDER,
  SEVERITY_WEIGHT,
} from './score.js';
export type { ScoreBreakdown } from './score.js';

export interface RunAuditOptions {
  url: string;
  crawl?: Partial<CrawlOptions>;
  siteConfig?: SiteConfig;
  config: AvcConfig;
  /** Run an AI visibility check too (spends money unless config.ai.mock). */
  visibility?: boolean | { engines?: EngineId[]; repeats?: number };
  only?: string[];
  skip?: string[];
  /** Month-to-date AI spend, so the visibility run respects config.ai.maxMonthUsd. */
  monthSpendUsd?: number;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
}

type VisibilityArgs = {
  brand: BrandProfile;
  prompts: TrackedPrompt[];
  site?: SiteContext;
  config: AvcConfig;
  engines?: EngineId[];
  repeats?: number;
  monthSpendUsd?: number;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
};

export interface AuditDeps {
  crawlSite(
    opts: Partial<CrawlOptions> & { startUrl: string },
    onProgress?: ProgressFn,
  ): Promise<SiteContext>;
  runAgenticProbes(site: SiteContext): Promise<void>;
  fetchAsBots(site: SiteContext): Promise<void>;
  collectExternal(
    site: SiteContext,
    siteConfig: SiteConfig | undefined,
    config: AvcConfig,
    onProgress?: ProgressFn,
  ): Promise<void>;
  loadChecks(): Promise<Check[]>;
  inferBrand(site: SiteContext): BrandProfile;
  suggestPrompts(brand: BrandProfile, site: SiteContext): Promise<TrackedPrompt[]>;
  runVisibility(args: VisibilityArgs): Promise<VisibilityRun>;
  buildFixes(
    result: AuditResult,
    opts?: { overrides?: Record<string, { steps?: string[]; note?: string; replace?: boolean }> },
  ): Fix[];
  now?: () => Date;
}

export const defaultDeps: AuditDeps = {
  crawlSite: async (opts, onProgress) =>
    (await import('../crawl/index.js')).crawlSite(opts, onProgress),
  runAgenticProbes: async (site) => (await import('../agentic/index.js')).runAgenticProbes(site),
  fetchAsBots: async (site) => (await import('../agentic/index.js')).fetchAsBots(site),
  collectExternal: async (site, siteConfig, config, onProgress) =>
    (await import('../connect/index.js')).collectExternal(site, siteConfig, config, onProgress),
  loadChecks: async () => (await import('../checks/index.js')).ALL_CHECKS,
  inferBrand: (site) => {
    throw new Error(`inferBrand not loaded for ${site.host}`);
  },
  suggestPrompts: async (brand, site) =>
    (await import('../ai/index.js')).suggestPrompts(brand, site),
  runVisibility: async (args) => (await import('../ai/index.js')).runVisibility(args),
  buildFixes: () => [],
};

/** Load the synchronous AI/fix helpers once, so defaultDeps can call them sync. */
async function resolveDeps(deps: Partial<AuditDeps>): Promise<AuditDeps> {
  const out: AuditDeps = { ...defaultDeps, ...deps };
  if (!deps.inferBrand) {
    try {
      const ai = await import('../ai/index.js');
      out.inferBrand = ai.inferBrand;
    } catch {
      out.inferBrand = fallbackBrand;
    }
  }
  if (!deps.buildFixes) {
    try {
      const fx = await import('../fixes/index.js');
      out.buildFixes = fx.buildFixes;
    } catch {
      out.buildFixes = () => [];
    }
  }
  return out;
}

function fallbackBrand(site: SiteContext): BrandProfile {
  const host = site.host.replace(/^www\./, '');
  const name = host.split('.')[0] ?? host;
  return {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    domain: host,
    aliases: [],
    services: [],
    competitors: [],
  };
}

export function newAuditId(at = new Date()): string {
  const stamp = at
    .toISOString()
    .replace(/[-:TZ]/g, '')
    .slice(0, 14);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

function mergeBrand(base: BrandProfile, patch?: Partial<BrandProfile>): BrandProfile {
  if (!patch) return base;
  return {
    ...base,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    aliases: patch.aliases ?? base.aliases,
    services: patch.services ?? base.services,
    competitors: patch.competitors ?? base.competitors,
  } as BrandProfile;
}

const NOINDEX = /(^|[\s,])(noindex|none)([\s,]|$)/i;

export function isIndexable(p: PageData): boolean {
  if (p.status < 200 || p.status >= 300 || !p.isHtml) return false;
  if (p.blockedByRobots) return false;
  if (p.metaRobots && NOINDEX.test(p.metaRobots)) return false;
  if (p.botMeta?.googlebot && NOINDEX.test(p.botMeta.googlebot)) return false;
  if (p.xRobotsTag && NOINDEX.test(p.xRobotsTag)) return false;
  const canonical = p.canonical ?? p.canonicalHeader;
  if (canonical) {
    const strip = (u: string) => u.replace(/#.*$/, '').replace(/\/$/, '');
    if (strip(canonical) !== strip(p.url) && strip(canonical) !== strip(p.finalUrl)) return false;
  }
  return true;
}

export function summarisePage(p: PageData, site: SiteContext, issueCount: number): PageSummary {
  const h1 = p.headings?.find((h) => h.level === 1)?.text ?? null;
  const types = new Set<string>();
  for (const sd of p.structuredData ?? []) for (const t of sd.types ?? []) types.add(t);
  const row: PageSummary = {
    url: p.url,
    finalUrl: p.finalUrl,
    status: p.status,
    depth: p.depth,
    title: p.title,
    metaDescription: p.metaDescription,
    h1,
    wordCount: p.wordCount ?? 0,
    canonical: p.canonical ?? p.canonicalHeader ?? null,
    indexable: isIndexable(p),
    inlinks: site.inlinks?.get(p.url)?.size ?? 0,
    outlinks: p.links?.length ?? 0,
    bytes: p.bytes ?? 0,
    ttfbMs: p.ttfbMs ?? 0,
    schemaTypes: [...types],
    issues: issueCount,
    inSitemap: !!p.inSitemap,
  };
  if (p.rendered) row.renderedWordCount = p.rendered.wordCount;
  if (p.extracted && Object.keys(p.extracted).length) row.extracted = p.extracted;
  return row;
}

export async function runAudit(
  opts: RunAuditOptions,
  deps: Partial<AuditDeps> = {},
): Promise<AuditResult> {
  const d = await resolveDeps(deps);
  const now = d.now ?? (() => new Date());
  const progress = opts.onProgress;
  const log = (level: 'info' | 'warn' | 'error', message: string) =>
    progress?.({ type: 'log', level, message });
  const signal = opts.signal;
  const startedAt = now();

  // 1. Crawl
  const { profile: profileName, ...sc } = opts.siteConfig?.crawl ?? {};
  const defined = (o: object) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const { description: _d, ...profile } =
    (profileName && opts.config.profiles?.[profileName]) || {};
  if (profileName && !opts.config.profiles?.[profileName])
    log('warn', `Crawl profile "${profileName}" is not defined; using the defaults.`);
  const crawlOpts: Partial<CrawlOptions> & { startUrl: string } = {
    ...defined(profile),
    ...defined(sc),
    ...opts.crawl,
    startUrl: opts.crawl?.startUrl ?? opts.url,
  };
  progress?.({ type: 'phase', phase: 'crawl', message: `Crawling ${crawlOpts.startUrl}` });
  const site = (await d.crawlSite(crawlOpts, progress)) as SiteWithVisibility;
  signal?.throwIfAborted();

  // 2. Agentic probes and live AI-bot fetches (independent; failures are logged, not fatal)
  progress?.({ type: 'phase', phase: 'probes', message: 'Probing AI and agent endpoints' });
  await Promise.all([
    d.runAgenticProbes(site).catch((e) => log('warn', `Agentic probes failed: ${errText(e)}`)),
    d.fetchAsBots(site).catch((e) => log('warn', `AI bot fetches failed: ${errText(e)}`)),
  ]);
  signal?.throwIfAborted();

  // 3. Connected data
  progress?.({ type: 'phase', phase: 'external', message: 'Collecting connected data' });
  try {
    await d.collectExternal(site, opts.siteConfig, opts.config, progress);
  } catch (e) {
    log('warn', `Connected data was not collected: ${errText(e)}`);
  }
  signal?.throwIfAborted();

  // 4. AI visibility (before checks, so llm checks can read it)
  let visibility: VisibilityRun | undefined;
  const notRun: NonNullable<AuditResult['notRun']> = [];
  const noKeys = aiUnavailableReason(opts.config);
  if (opts.visibility && noKeys) {
    notRun.push({ step: 'ai-visibility', reason: noKeys });
    log('warn', `AI visibility: ${noKeys}`);
  } else if (opts.visibility) {
    progress?.({ type: 'phase', phase: 'visibility', message: 'Asking AI engines' });
    try {
      const brand = mergeBrand(d.inferBrand(site), opts.siteConfig?.brand);
      const prompts = opts.siteConfig?.prompts?.length
        ? opts.siteConfig.prompts
        : await d.suggestPrompts(brand, site);
      const v = typeof opts.visibility === 'object' ? opts.visibility : {};
      visibility = await d.runVisibility({
        brand,
        prompts,
        site,
        config: opts.config,
        engines: v.engines,
        repeats: v.repeats,
        monthSpendUsd: opts.monthSpendUsd,
        onProgress: progress,
        signal,
      });
      site.visibility = visibility;
    } catch (e) {
      if (signal?.aborted) throw e;
      log('warn', `AI visibility run failed: ${errText(e)}`);
      notRun.push({ step: 'ai-visibility', reason: `Failed: ${errText(e)}` });
    }
  } else {
    notRun.push({
      step: 'ai-visibility',
      reason:
        noKeys ??
        'Not requested. Run the audit with --visibility to ask the AI engines (it uses your AI keys and costs a little).',
    });
  }
  signal?.throwIfAborted();

  // 5. Checks
  const checks = await d.loadChecks();
  const { issues, status } = await runChecks(site, checks, {
    only: opts.only,
    skip: opts.skip,
    hasVisibility: !!visibility,
    reasons: notRun.length ? { llm: notRun[0]!.reason } : undefined,
    onProgress: progress,
    signal,
  });

  // 6. Page rows
  const perUrl = new Map<string, number>();
  for (const i of issues) if (i.url) perUrl.set(i.url, (perUrl.get(i.url) ?? 0) + 1);
  const pages: PageSummary[] = [...site.pages.values()].map((p) =>
    summarisePage(p, site, perUrl.get(p.url) ?? 0),
  );

  // 7. Score
  progress?.({ type: 'phase', phase: 'score', message: 'Scoring' });
  const score = scoreAudit(status, issues, pages, visibility);

  const { repo, ...externalRest } = site.external ?? {};
  const result: AuditResult = {
    id: newAuditId(startedAt),
    version: APP_VERSION,
    site: site.origin,
    startUrl: site.startUrl,
    at: startedAt.toISOString(),
    stack: site.stack,
    stats: site.stats,
    pages,
    issues,
    ...(site.tls ? { tls: site.tls } : {}),
    linkGraph: linkGraphOf(pages, site),
    resources: await resourcesOf(site),
    checks: status,
    score,
    priorities: [],
    probes: [...(site.probes?.values() ?? [])],
    botFetches: site.botFetches ?? [],
    robots: {
      found: !!site.robots?.found,
      status: site.robots?.status ?? null,
      body: (site.robots?.body ?? '').slice(0, 50_000),
    },
    sitemaps: (site.sitemaps ?? []).map((s) => ({
      url: s.url,
      found: s.found,
      urls: s.urls?.length ?? 0,
      errors: s.errors ?? [],
    })),
    external: { ...externalRest, ...(repo ? { repo } : {}) },
    ...(visibility ? { visibility } : {}),
    ...(notRun.length ? { notRun } : {}),
  };

  // 8. Fixes and priorities
  result.priorities = rankPriorities(status, issues, pages, { readinessOnly: score.readinessOnly });
  let fixes: Fix[] = [];
  try {
    fixes = d.buildFixes(result, { overrides: opts.config.fixes?.overrides });
  } catch (e) {
    log('warn', `Fixes could not be built: ${errText(e)}`);
  }
  result.priorities = rankPriorities(status, issues, pages, {
    fixes,
    readinessOnly: score.readinessOnly,
  });

  progress?.({
    type: 'phase',
    phase: 'done',
    message: `Score ${score.overall} (${score.grade}), ${issues.length} issues`,
  });
  return result;
}

/** Max resources kept in the stored inventory. */
export const RESOURCES_MAX = 2_000;

/** Inventory of scripts, stylesheets and images with how many pages use each. */
export async function resourcesOf(site: SiteContext): Promise<ResourceSummary[]> {
  let statuses = new Map<string, number>();
  try {
    statuses = (await import('../crawl/index.js')).imageStatus(site);
  } catch {
    /* no crawler state (tests) */
  }
  const map = new Map<string, ResourceSummary>();
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  const own = host(site.origin);
  const add = (url: string | null | undefined, type: ResourceSummary['type'], bytes?: number) => {
    if (!url || url.startsWith('data:')) return;
    const h = host(url);
    const cdn = (site.options?.cdns ?? []).some((c) => {
      const x = c
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '');
      return h === x || h.endsWith(`.${x}`);
    });
    const r = map.get(url) ?? { url, type, pages: 0, thirdParty: h !== own && !cdn };
    r.pages++;
    if (bytes !== undefined) r.bytes = bytes;
    if (type === 'image' && statuses.has(url)) r.status = statuses.get(url);
    map.set(url, r);
  };
  for (const p of site.pages.values()) {
    if (!p.isHtml) continue;
    for (const sc of new Set(p.scripts.map((x) => x.src))) add(sc, 'script');
    for (const st of new Set(p.stylesheets.map((x) => x.href))) add(st, 'stylesheet');
    const seen = new Set<string>();
    for (const img of p.images)
      if (!seen.has(img.src)) {
        seen.add(img.src);
        add(img.src, 'image', img.bytes);
      }
  }
  return [...map.values()].sort((a, b) => b.pages - a.pages).slice(0, RESOURCES_MAX);
}

/** Max edges kept in the stored link graph (enough for the dashboard's site graph). */
export const LINK_GRAPH_MAX_EDGES = 20_000;

export function linkGraphOf(
  pages: PageSummary[],
  site: SiteContext,
): NonNullable<AuditResult['linkGraph']> {
  const index = new Map(pages.map((p, i) => [p.url, i]));
  const edges: [number, number][] = [];
  let truncated = false;
  for (const [target, sources] of site.inlinks ?? []) {
    const t = index.get(target);
    if (t === undefined) continue;
    for (const src of sources) {
      const s = index.get(src);
      if (s === undefined || s === t) continue;
      if (edges.length >= LINK_GRAPH_MAX_EDGES) {
        truncated = true;
        break;
      }
      edges.push([s, t]);
    }
  }
  return { edges, truncated };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function countBySeverity(result: AuditResult): Record<Issue['severity'] & string, number> {
  const out = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const i of result.issues) {
    const sev = i.severity ?? result.checks[i.checkId]?.severity ?? 'info';
    out[sev]++;
  }
  return out;
}

export interface SkippedGroup {
  reason: string;
  /** Check ids skipped for this reason. */
  checks: string[];
}

/**
 * Everything that did not run, grouped by reason, so every surface can show the user what
 * was skipped and why: whole steps (the AI visibility run) first, then checks.
 */
export function skippedSummary(result: AuditResult): {
  steps: NonNullable<AuditResult['notRun']>;
  checks: SkippedGroup[];
  total: number;
} {
  const byReason = new Map<string, string[]>();
  for (const [id, c] of Object.entries(result.checks)) {
    if (c.status !== 'skipped') continue;
    const reason = c.skippedReason ?? 'Skipped.';
    byReason.set(reason, [...(byReason.get(reason) ?? []), id]);
  }
  const checks = [...byReason]
    .map(([reason, ids]) => ({ reason, checks: ids.sort() }))
    .sort((a, b) => b.checks.length - a.checks.length);
  return {
    steps: result.notRun ?? [],
    checks,
    total: checks.reduce((n, g) => n + g.checks.length, 0),
  };
}

export function isReadinessOnly(result: AuditResult): boolean {
  const flag = (result.score as Partial<ScoreBreakdown>).readinessOnly;
  return typeof flag === 'boolean' ? flag : !result.visibility;
}

/** A short plain-text summary for the terminal (colours drop out when not a TTY). */
export function summariseForCli(result: AuditResult, opts: { top?: number } = {}): string {
  const top = opts.top ?? 5;
  const s = result.score;
  const gradeColour =
    s.grade === 'A' || s.grade === 'B' ? pc.green : s.grade === 'C' ? pc.yellow : pc.red;
  const lines: string[] = [];
  lines.push(
    `${pc.bold('AI Visibility Score')} ${gradeColour(pc.bold(`${s.overall}/100 (${s.grade})`))}  ${pc.dim(result.site)}`,
  );
  if (isReadinessOnly(result))
    lines.push(
      pc.dim('Readiness only: no AI visibility run, so that pillar is left out of the score.'),
    );
  lines.push('');
  for (const p of s.pillars) {
    const label = PILLAR_LABELS[p.pillar].padEnd(20);
    if (!p.weight) {
      lines.push(`  ${label} ${pc.dim('not measured')}`);
      continue;
    }
    const colour = p.score >= 75 ? pc.green : p.score >= 50 ? pc.yellow : pc.red;
    const bar = '█'.repeat(Math.round(p.score / 10)).padEnd(10, '·');
    lines.push(
      `  ${label} ${colour(bar)} ${String(p.score).padStart(3)}  ${pc.dim(`${p.failed} failing, ${p.passed} passing`)}`,
    );
  }
  const sev = countBySeverity(result);
  lines.push('');
  lines.push(
    `${result.stats?.pagesCrawled ?? result.pages.length} pages crawled. Issues: ` +
      `${pc.red(`${sev.critical} critical`)}, ${pc.red(`${sev.high} high`)}, ` +
      `${pc.yellow(`${sev.medium} medium`)}, ${sev.low} low.`,
  );
  if (result.visibility) {
    const v = result.visibility.summary;
    lines.push(
      `AI visibility: named in ${Math.round(v.mentionRate * 100)}% of answers across ${Object.keys(v.byEngine).length} engine(s); cost $${v.costUsd.toFixed(2)}.`,
    );
  }
  const skipped = skippedSummary(result);
  if (skipped.steps.length || skipped.total) {
    lines.push('');
    lines.push(pc.bold(`Skipped${skipped.total ? ` (${skipped.total} checks)` : ''}:`));
    for (const st of skipped.steps)
      lines.push(`  ${pc.yellow('•')} AI visibility run: ${pc.dim(st.reason)}`);
    for (const g of skipped.checks)
      lines.push(
        `  ${pc.yellow('•')} ${g.checks.length} check${g.checks.length === 1 ? '' : 's'}: ${pc.dim(g.reason)}`,
      );
  }
  if (result.priorities.length) {
    lines.push('');
    lines.push(pc.bold('Fix first:'));
    result.priorities.slice(0, top).forEach((p, i) => {
      const def = result.checks[p.checkId];
      const where = def?.scope === 'page' ? `${p.affected} page(s)` : 'site-wide';
      lines.push(
        `  ${i + 1}. ${def?.title ?? p.checkId} ${pc.dim(`(${where}, ${def?.severity})`)}`,
      );
    });
  }
  return lines.join('\n');
}
