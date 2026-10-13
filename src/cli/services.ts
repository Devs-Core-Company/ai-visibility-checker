/**
 * One adapter between the user surfaces (CLI, dashboard, MCP server) and the
 * engine modules (audit, monitor, report, ai, fixes, connect). Every surface goes
 * through here so the three behave the same and a signature change lands in one file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AvcConfig, SiteConfig } from '../core/config.js';
import { loadConfig, saveUserConfig, siteIdFromUrl, userConfigPath } from '../core/config.js';
import type {
  AuditDiff,
  AuditResult,
  BrandProfile,
  Check,
  CheckDef,
  EngineId,
  Issue,
  ProgressFn,
  SiteContext,
  TrackedPrompt,
  VisibilityRun,
} from '../core/types.js';
import { ALL_CHECKS } from '../checks/index.js';
import { runAudit } from '../audit/index.js';
import { openStore } from '../monitor/store.js';
import { diffAudits } from '../monitor/diff.js';
import {
  renderHtmlReport,
  renderMarkdownReport,
  toCsv,
  toJson,
  toSarif,
} from '../report/index.js';
import { runVisibility, suggestPrompts, inferBrand } from '../ai/index.js';
import { mergeBrand } from '../ai/brand.js';
import { engineStatus, defaultEngines } from '../ai/engines.js';
import { expectedCallCost } from '../ai/pricing.js';

export type Store = ReturnType<typeof openStore>;

// ---------------------------------------------------------------------------
// Config and sites
// ---------------------------------------------------------------------------

export function getConfig(reload = false): AvcConfig {
  return loadConfig({ reload });
}

/** Normalise user input ("example.com", "https://example.com/x") to an absolute URL. */
export function toUrl(input: string): string {
  const s = input.trim();
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const u = new URL(withScheme);
  return u.toString();
}

export function isUrlish(input: string): boolean {
  return /^https?:\/\//i.test(input) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(input);
}

/** Find a configured site by id, URL or host; otherwise an ad-hoc site for the URL. */
export function resolveSite(input: string, config = getConfig()): SiteConfig {
  const byId = config.sites.find((s) => s.id === input);
  if (byId) return byId;
  if (!isUrlish(input)) throw new Error(`No site called "${input}". Run \`avc init\` or pass a URL.`);
  const url = toUrl(input);
  const id = siteIdFromUrl(url);
  const known = config.sites.find((s) => s.id === id);
  if (known) return { ...known, url: new URL(url).pathname === '/' ? known.url : url };
  return { id, url };
}

/** Add or update a site in the user config (~/.avc/config.json). */
export function upsertUserSite(site: SiteConfig): AvcConfig {
  const current = readUserConfig();
  const sites = (current.sites ?? []).filter((s) => s.id !== site.id);
  sites.push(site);
  return saveUserConfig({ sites });
}

export function removeUserSite(id: string): AvcConfig {
  const current = readUserConfig();
  return saveUserConfig({ sites: (current.sites ?? []).filter((s) => s.id !== id) });
}

export function readUserConfig(): Partial<AvcConfig> {
  try {
    const p = userConfigPath();
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Partial<AvcConfig>) : {};
  } catch {
    return {};
  }
}

/** Deep-merge a patch into one section of the user config, then save (mode 600). */
export function patchUserConfig<K extends keyof AvcConfig>(
  section: K,
  patch: Partial<AvcConfig[K]>,
): AvcConfig {
  const current = readUserConfig();
  const prev = (current[section] ?? {}) as object;
  const next = { ...prev, ...patch } as AvcConfig[K];
  // Empty strings clear a value.
  for (const [k, v] of Object.entries(next as object)) if (v === '' || v === null) delete (next as Record<string, unknown>)[k];
  return saveUserConfig({ [section]: next } as Partial<AvcConfig>);
}

export function patchSiteConnections(
  siteId: string,
  patch: Partial<NonNullable<SiteConfig['connections']>>,
): AvcConfig {
  const config = getConfig();
  const site = config.sites.find((s) => s.id === siteId) ?? readUserConfig().sites?.find((s) => s.id === siteId);
  if (!site) throw new Error(`No site called "${siteId}".`);
  const connections = { ...site.connections, ...patch };
  for (const [k, v] of Object.entries(connections)) if (v === '' || v == null) delete (connections as Record<string, unknown>)[k];
  return upsertUserSite({ ...site, connections });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let storeCache: { dir: string; store: Store } | null = null;
export function getStore(config = getConfig()): Store {
  if (storeCache?.dir === config.dataDir) return storeCache.store;
  mkdirSync(config.dataDir, { recursive: true });
  const store = openStore(config.dataDir);
  storeCache = { dir: config.dataDir, store };
  return store;
}

export function resetStoreCache(): void {
  storeCache = null;
}

/** Resolve "latest", an audit id, a site id or a URL to a stored audit. */
export function findAudit(ref: string | undefined, config = getConfig()): AuditResult | null {
  const store = getStore(config);
  if (!ref || ref === 'latest') {
    const latest = store
      .listSites()
      .filter((s) => s.lastAuditAt)
      .sort((a, b) => (b.lastAuditAt ?? '').localeCompare(a.lastAuditAt ?? ''))[0];
    return latest ? store.latestAudit(latest.id) : null;
  }
  const direct = store.getAudit(ref);
  if (direct) return direct;
  try {
    const site = resolveSite(ref, config);
    return store.latestAudit(site.id);
  } catch {
    return null;
  }
}

/** Every site we know about: configured ones first, then ones that only exist in history. */
export function allSites(config = getConfig()): (SiteConfig & { lastAuditAt?: string | null; configured: boolean })[] {
  const out = new Map<string, SiteConfig & { lastAuditAt?: string | null; configured: boolean }>();
  for (const s of config.sites) out.set(s.id, { ...s, configured: true });
  try {
    for (const r of getStore(config).listSites()) {
      const prev = out.get(r.id);
      if (prev) prev.lastAuditAt = r.lastAuditAt;
      else out.set(r.id, { id: r.id, url: r.url, lastAuditAt: r.lastAuditAt, configured: false });
    }
  } catch {
    /* no database yet */
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Expand a list of selectors (check ids, id prefixes, categories, pillars) into check ids.
 * Returns undefined when nothing was selected (= run all).
 */
export function selectChecks(only?: string[], skip?: string[]): string[] | undefined {
  const norm = (xs?: string[]) =>
    (xs ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
  const inc = norm(only);
  const exc = norm(skip);
  if (!inc.length && !exc.length) return undefined;
  const matches = (c: Check, sel: string) =>
    c.def.id === sel ||
    c.def.id.startsWith(sel.endsWith('.') ? sel : sel + '.') ||
    c.def.category === sel ||
    c.def.pillar === sel ||
    (c.def.tags ?? []).includes(sel);
  let list = inc.length ? ALL_CHECKS.filter((c) => inc.some((s) => matches(c, s))) : ALL_CHECKS;
  if (exc.length) list = list.filter((c) => !exc.some((s) => matches(c, s)));
  return list.map((c) => c.def.id);
}

export function listChecks(filter: { category?: string; pillar?: string; search?: string } = {}): CheckDef[] {
  const q = filter.search?.toLowerCase();
  return ALL_CHECKS.map((c) => c.def).filter(
    (d) =>
      (!filter.category || d.category === filter.category) &&
      (!filter.pillar || d.pillar === filter.pillar) &&
      (!q || `${d.id} ${d.title} ${d.why} ${(d.tags ?? []).join(' ')}`.toLowerCase().includes(q)),
  );
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditRequest {
  url: string;
  site?: SiteConfig;
  maxPages?: number;
  maxDepth?: number;
  render?: boolean | 'auto';
  include?: string[];
  exclude?: string[];
  only?: string[];
  skip?: string[];
  visibility?: boolean | { engines?: EngineId[]; repeats?: number };
  onProgress?: ProgressFn;
  signal?: AbortSignal;
  save?: boolean;
}

export async function audit(req: AuditRequest, config = getConfig()): Promise<AuditResult> {
  const url = toUrl(req.url);
  const site = req.site ?? resolveSite(url, config);
  const crawl: Record<string, unknown> = { startUrl: url };
  const sc = site.crawl ?? {};
  const pick = <T>(a: T | undefined, b: T | undefined) => (a !== undefined ? a : b);
  const maxPages = pick(req.maxPages, sc.maxPages);
  const maxDepth = pick(req.maxDepth, sc.maxDepth);
  const render = pick(req.render, sc.render);
  if (maxPages !== undefined) crawl.maxPages = maxPages;
  if (maxDepth !== undefined) crawl.maxDepth = maxDepth;
  if (render !== undefined) crawl.render = render;
  const include = req.include?.length ? req.include : sc.include;
  const exclude = req.exclude?.length ? req.exclude : sc.exclude;
  if (include?.length) crawl.include = include;
  if (exclude?.length) crawl.exclude = exclude;
  const chrome = process.env.AVC_CHROME_PATH || process.env.CHROME_PATH;
  if (chrome) crawl.chromePath = chrome;

  const result = await runAudit({
    url,
    crawl,
    siteConfig: site,
    config,
    visibility: req.visibility,
    only: selectChecks(req.only, req.skip),
    monthSpendUsd: req.visibility ? monthSpend(config) : undefined,
    onProgress: req.onProgress,
    signal: req.signal,
  });
  if (req.save !== false) {
    try {
      const store = getStore(config);
      if (!store.getAudit(result.id)) store.saveAudit(result, site.id);
    } catch (err) {
      req.onProgress?.({ type: 'log', level: 'warn', message: `Could not save the audit: ${errMsg(err)}` });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const FORMATS = ['html', 'json', 'md', 'csv', 'sarif'] as const;
export type Format = (typeof FORMATS)[number];

export function parseFormats(input: string | undefined, fallback: Format[] = ['html', 'json']): Format[] {
  if (!input) return fallback;
  const out = input
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .map((s) => (s === 'markdown' ? 'md' : s))
    .filter(Boolean);
  for (const f of out) if (!(FORMATS as readonly string[]).includes(f)) throw new Error(`Unknown format "${f}". Use ${FORMATS.join(', ')}.`);
  return [...new Set(out)] as Format[];
}

export interface RenderedReport {
  filename: string;
  contentType: string;
  body: string;
}

export function reportBase(result: AuditResult): string {
  const host = siteIdFromUrl(result.startUrl || result.site);
  const day = (result.at || new Date().toISOString()).slice(0, 10);
  return `avc-${host}-${day}`;
}

export function renderReport(
  result: AuditResult,
  format: Format,
  extras: { diff?: AuditDiff; previous?: AuditResult | null; csv?: 'issues' | 'pages' } = {},
): RenderedReport[] {
  const base = reportBase(result);
  switch (format) {
    case 'html':
      return [
        {
          filename: `${base}.html`,
          contentType: 'text/html; charset=utf-8',
          body: renderHtmlReport(result, { diff: extras.diff }),
        },
      ];
    case 'md':
      return [{ filename: `${base}.md`, contentType: 'text/markdown; charset=utf-8', body: renderMarkdownReport(result) }];
    case 'json':
      return [{ filename: `${base}.json`, contentType: 'application/json', body: toJson(result) }];
    case 'sarif':
      return [{ filename: `${base}.sarif`, contentType: 'application/sarif+json', body: toSarif(result) }];
    case 'csv': {
      const kinds: ('issues' | 'pages')[] = extras.csv ? [extras.csv] : ['issues', 'pages'];
      return kinds.map((k) => ({
        filename: `${base}-${k}.csv`,
        contentType: 'text/csv; charset=utf-8',
        body: toCsv(result, k),
      }));
    }
  }
}

export function writeReports(
  result: AuditResult,
  formats: Format[],
  outDir: string,
  extras: { diff?: AuditDiff } = {},
): string[] {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const f of formats) {
    for (const r of renderReport(result, f, extras)) {
      const p = join(dir, r.filename);
      writeFileSync(p, r.body);
      files.push(p);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

/** The audit before `result` for the same site, if any. */
export function previousAudit(result: AuditResult, config = getConfig()): AuditResult | null {
  const store = getStore(config);
  return store.previousAudit(result.id) ?? store.latestAudit(siteIdFromUrl(result.startUrl || result.site), { before: result.at });
}

export function diff(a: AuditResult, b: AuditResult): AuditDiff {
  return diffAudits(a, b);
}

// ---------------------------------------------------------------------------
// AI visibility
// ---------------------------------------------------------------------------

export function engines(config = getConfig()) {
  return engineStatus(config);
}

export function pickEngines(input: string[] | string | undefined, config = getConfig()): EngineId[] {
  const list = (Array.isArray(input) ? input : input ? [input] : [])
    .flatMap((x) => x.split(','))
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return defaultEngines(config);
  const status = engineStatus(config);
  const out: EngineId[] = [];
  for (const id of list) {
    const s = status.find((e) => e.engine === id);
    if (!s) throw new Error(`Unknown engine "${id}". Use ${status.map((e) => e.engine).join(', ')}.`);
    if (!s.available) throw new Error(`${s.label} is not available: ${s.note ?? 'no key set.'}`);
    out.push(s.engine);
  }
  return out;
}

/** Upper-bound cost estimate for a run, per engine and total (USD). */
export function estimateVisibilityCost(
  engineIds: EngineId[],
  prompts: { search: boolean }[],
  repeats = 1,
  config = getConfig(),
): { perEngine: Record<string, number>; perAnswer: Record<string, number>; total: number; answers: number; mock: boolean } {
  const status = engineStatus(config);
  const perEngine: Record<string, number> = {};
  const perAnswer: Record<string, number> = {};
  let total = 0;
  let mock = true;
  for (const id of engineIds) {
    const s = status.find((e) => e.engine === id);
    if (!s) continue;
    if (s.via !== 'mock') mock = false;
    const unit = s.via === 'mock' ? 0 : expectedCallCost(s.model, 'answer', true, id) + expectedCallCost(s.model, 'judge', false);
    perAnswer[id] = unit;
    const cost = prompts.reduce(
      (sum, p) =>
        sum +
        (s.via === 'mock' ? 0 : expectedCallCost(s.model, 'answer', p.search, id) + expectedCallCost(s.model, 'judge', false)),
      0,
    ) * repeats;
    perEngine[id] = cost;
    total += cost;
  }
  return { perEngine, perAnswer, total, answers: engineIds.length * prompts.length * repeats, mock };
}

export function monthSpend(config = getConfig()): number {
  try {
    return getStore(config).monthSpend();
  } catch {
    return 0;
  }
}

/** Parse a prompts file: JSON (array of strings or TrackedPrompt) or one prompt per line. */
export function readPromptsFile(path: string): TrackedPrompt[] {
  const raw = readFileSync(path, 'utf8');
  return parsePrompts(raw);
}

export function parsePrompts(raw: string): TrackedPrompt[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed) as (string | Partial<TrackedPrompt>)[];
    return arr.map((p, i) =>
      typeof p === 'string'
        ? { id: `p${i + 1}`, text: p, kind: 'custom', search: true }
        : { id: p.id ?? `p${i + 1}`, text: String(p.text ?? ''), kind: p.kind ?? 'custom', search: p.search ?? true },
    );
  }
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((text, i) => ({ id: `p${i + 1}`, text, kind: 'custom' as const, search: true }));
}

export interface VisibilityRequest {
  site: SiteConfig;
  prompts?: TrackedPrompt[];
  engines?: EngineId[];
  repeats?: number;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
  /** A crawled site (for brand, own-site citations and fact-checks). Crawled quickly when absent. */
  context?: SiteContext | null;
}

/** A quick, shallow crawl so the AI module can learn the brand and check facts against the site. */
export async function quickContext(
  site: SiteConfig,
  onProgress?: ProgressFn,
  maxPages = 15,
): Promise<SiteContext | null> {
  try {
    const { crawlSite } = await import('../crawl/index.js');
    return await crawlSite({ startUrl: toUrl(site.url), maxPages, maxDepth: 2, render: false }, onProgress);
  } catch (err) {
    onProgress?.({ type: 'log', level: 'warn', message: `Could not read the site first: ${errMsg(err)}` });
    return null;
  }
}

export function brandFor(site: SiteConfig, context?: SiteContext | null): BrandProfile {
  const host = new URL(toUrl(site.url)).host.replace(/^www\./, '');
  const base: BrandProfile = context
    ? inferBrand(context)
    : { name: host.split('.')[0] ?? host, domain: host, aliases: [], services: [], competitors: [] };
  return mergeBrand(base, site.brand);
}

export async function promptSuggestions(
  site: SiteConfig,
  config = getConfig(),
  context?: SiteContext | null,
  count?: number,
): Promise<TrackedPrompt[]> {
  const ctx = context === undefined ? await quickContext(site) : context;
  const brand = brandFor(site, ctx);
  return suggestPrompts(brand, ctx ?? undefined, { config, custom: site.prompts, count });
}

export async function visibility(req: VisibilityRequest, config = getConfig()): Promise<VisibilityRun> {
  const context = req.context === undefined ? await quickContext(req.site, req.onProgress) : req.context;
  const brand = brandFor(req.site, context);
  const prompts = req.prompts?.length
    ? req.prompts
    : req.site.prompts?.length
      ? req.site.prompts
      : await suggestPrompts(brand, context ?? undefined, { config });
  const run = await runVisibility({
    brand,
    prompts,
    site: context ?? undefined,
    config,
    engines: req.engines,
    repeats: req.repeats,
    monthSpendUsd: monthSpend(config),
    onProgress: req.onProgress,
    signal: req.signal,
  });
  try {
    getStore(config).saveVisibility(run, req.site.id);
  } catch (err) {
    req.onProgress?.({ type: 'log', level: 'warn', message: `Could not save the run: ${errMsg(err)}` });
  }
  return run;
}

// ---------------------------------------------------------------------------
// Issue helpers shared by dashboard and MCP
// ---------------------------------------------------------------------------

export interface IssueFilter {
  pillar?: string;
  category?: string;
  severity?: string;
  checkId?: string;
  url?: string;
  q?: string;
}

export function filterIssues(result: AuditResult, f: IssueFilter): Issue[] {
  const q = f.q?.toLowerCase();
  return result.issues.filter((i) => {
    const def = result.checks[i.checkId];
    if (f.pillar && def?.pillar !== f.pillar) return false;
    if (f.category && def?.category !== f.category) return false;
    if (f.severity && (i.severity ?? def?.severity) !== f.severity) return false;
    if (f.checkId && i.checkId !== f.checkId) return false;
    if (f.url && i.url !== f.url) return false;
    if (q && !`${i.checkId} ${def?.title ?? ''} ${i.message} ${i.url ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
