/**
 * Runs check modules over a crawled site.
 *
 * Page checks run once per crawled page (every page is passed; each check decides
 * whether a non-HTML or non-200 page is relevant). Site checks run once, each with
 * its own timeout. A check that throws is logged and reported as skipped, never as
 * failed, and a check whose optional data is missing is skipped with a plain reason.
 */
import type {
  AuditResult,
  CategoryId,
  Check,
  CheckDef,
  Issue,
  PageData,
  ProgressFn,
  Requirement,
  SiteContext,
  VisibilityRun,
} from '../core/types.js';

export type CheckStatusMap = AuditResult['checks'];

export interface RunChecksOptions {
  /** Run only these checks: ids, id prefixes (`onpage.` / `onpage*`), categories or pillars. */
  only?: string[];
  /** Never run these check ids (same matching as `only`). */
  skip?: string[];
  /** Run only checks in these categories. */
  categories?: CategoryId[];
  /** Per site-check timeout. Default 30 s. */
  siteCheckTimeoutMs?: number;
  /** Whether an AI visibility run is available (satisfies `requires: ['llm']`). */
  hasVisibility?: boolean;
  onProgress?: ProgressFn;
  signal?: AbortSignal;
}

export interface RunChecksResult {
  issues: Issue[];
  status: CheckStatusMap;
}

/** A SiteContext that may also carry the visibility run (set by runAudit for llm checks). */
export type SiteWithVisibility = SiteContext & { visibility?: VisibilityRun };

const REQUIREMENT_REASON: Record<Requirement, string> = {
  render: 'Needs rendered pages. Run with --render (local Chrome or Chromium required).',
  psi: 'Needs PageSpeed Insights data. Add a PSI API key with `avc connect psi`.',
  gsc: 'Needs Google Search Console. Connect it with `avc connect google`.',
  ga4: 'Needs Google Analytics 4. Connect it with `avc connect google`.',
  logs: 'Needs server access logs. Point the site config at your log files.',
  llm: 'Needs an AI visibility run. Add an AI key (or use --mock) and run with --visibility.',
  repo: "Needs the site's source code. Set connections.repoPath in the site config.",
};

/** Returns the first unmet requirement of a check, or null when it can run. */
export function unmetRequirement(
  def: CheckDef,
  site: SiteContext,
  hasVisibility = false,
): Requirement | null {
  for (const req of def.requires ?? []) {
    if (!requirementMet(req, site, hasVisibility)) return req;
  }
  return null;
}

function requirementMet(req: Requirement, site: SiteContext, hasVisibility: boolean): boolean {
  const ext = site.external ?? {};
  switch (req) {
    case 'render':
      for (const p of site.pages.values()) if (p.rendered) return true;
      return false;
    case 'psi':
      return !!ext.psi && Object.keys(ext.psi).length > 0;
    case 'gsc':
      return !!ext.gsc;
    case 'ga4':
      return !!ext.ga4;
    case 'logs':
      return !!ext.logs;
    case 'llm':
      return hasVisibility || !!(site as SiteWithVisibility).visibility;
    case 'repo':
      return !!ext.repo;
    default:
      return true;
  }
}

function matches(def: CheckDef, patterns: string[]): boolean {
  const id = def.id;
  return patterns.some((p) => {
    if (p === id || p === def.pillar || p === def.category) return true;
    if (p.endsWith('*')) return id.startsWith(p.slice(0, -1));
    if (p.endsWith('.')) return id.startsWith(p);
    // A bare category name selects every check in it.
    return id.startsWith(p + '.');
  });
}

/** Normalise a check's return value into an array of issues stamped with its id. */
export function normaliseIssues(
  out: Issue[] | Issue | null | void | undefined,
  def: CheckDef,
  pageUrl?: string,
): Issue[] {
  if (!out) return [];
  const list = Array.isArray(out) ? out : [out];
  const res: Issue[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const issue: Issue = { ...raw, checkId: raw.checkId || def.id };
    if (!issue.message) issue.message = def.title;
    if (pageUrl && !issue.url && def.scope === 'page') issue.url = pageUrl;
    if (issue.evidence && issue.evidence.length > 500)
      issue.evidence = issue.evidence.slice(0, 497) + '...';
    res.push(issue);
  }
  return res;
}

/** Distinct places affected: page URLs, or 1 for a site-level issue without a URL. */
export function countAffected(issues: Issue[]): number {
  const keys = new Set<string>();
  for (const i of issues) keys.add(i.url ?? '__site__');
  return keys.size;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)} s`)), ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

export async function runChecks(
  site: SiteContext,
  checks: Check[],
  opts: RunChecksOptions = {},
): Promise<RunChecksResult> {
  const log = (level: 'info' | 'warn' | 'error', message: string) =>
    opts.onProgress?.({ type: 'log', level, message });
  const timeoutMs = opts.siteCheckTimeoutMs ?? 30_000;
  const hasVisibility = opts.hasVisibility ?? !!(site as SiteWithVisibility).visibility;
  const pages: PageData[] = [...site.pages.values()];

  const issues: Issue[] = [];
  const status: CheckStatusMap = {};
  const seen = new Set<string>();

  const selected = checks.filter((c) => {
    const id = c.def.id;
    if (seen.has(id)) return false; // never run a duplicate id twice
    seen.add(id);
    if (opts.only?.length && !matches(c.def, opts.only)) return false;
    if (opts.skip?.length && matches(c.def, opts.skip)) return false;
    if (opts.categories?.length && !opts.categories.includes(c.def.category)) return false;
    return true;
  });

  opts.onProgress?.({
    type: 'phase',
    phase: 'checks',
    message: `Running ${selected.length} checks over ${pages.length} pages`,
  });

  const skipped = (def: CheckDef, reason: string) => {
    status[def.id] = { ...def, status: 'skipped', skippedReason: reason, affected: 0 };
  };

  // Page checks: loop page-major so each page's data stays hot, and yield now and then.
  const pageChecks = selected.filter((c) => c.kind === 'page');
  const siteChecks = selected.filter((c) => c.kind === 'site');
  const runnablePage: Extract<Check, { kind: 'page' }>[] = [];
  for (const c of pageChecks) {
    const unmet = unmetRequirement(c.def, site, hasVisibility);
    if (unmet) skipped(c.def, REQUIREMENT_REASON[unmet]);
    else runnablePage.push(c as Extract<Check, { kind: 'page' }>);
  }

  const pageIssues = new Map<string, Issue[]>();
  const pageErrors = new Map<string, { count: number; first: string }>();
  let n = 0;
  for (const page of pages) {
    opts.signal?.throwIfAborted();
    for (const c of runnablePage) {
      try {
        const found = normaliseIssues(c.run(page, site), c.def, page.url);
        if (found.length) {
          const arr = pageIssues.get(c.def.id) ?? [];
          for (const f of found) arr.push(f);
          pageIssues.set(c.def.id, arr);
        }
      } catch (e) {
        const prev = pageErrors.get(c.def.id);
        if (prev) prev.count++;
        else pageErrors.set(c.def.id, { count: 1, first: `${page.url}: ${errMessage(e)}` });
      }
    }
    if (++n % 100 === 0) await yieldToLoop();
  }

  for (const c of runnablePage) {
    const id = c.def.id;
    const err = pageErrors.get(id);
    const found = pageIssues.get(id) ?? [];
    if (err && pages.length > 0 && err.count >= pages.length) {
      log('warn', `Check ${id} failed on every page and was skipped (${err.first})`);
      skipped(c.def, `The check hit an error: ${err.first}`);
      continue;
    }
    if (err) log('warn', `Check ${id} hit an error on ${err.count} page(s); first: ${err.first}`);
    for (const f of found) issues.push(f);
    status[id] = { ...c.def, status: 'ran', affected: countAffected(found) };
  }

  // Site checks: run a few at a time; each has its own timeout.
  const runnableSite: Extract<Check, { kind: 'site' }>[] = [];
  for (const c of siteChecks) {
    const unmet = unmetRequirement(c.def, site, hasVisibility);
    if (unmet) skipped(c.def, REQUIREMENT_REASON[unmet]);
    else runnableSite.push(c as Extract<Check, { kind: 'site' }>);
  }

  const results = new Map<string, { issues: Issue[] } | { error: string }>();
  const queue = [...runnableSite];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      if (opts.signal?.aborted) return;
      try {
        const out = await withTimeout(
          Promise.resolve().then(() => c.run(site)),
          timeoutMs,
          opts.signal,
        );
        results.set(c.def.id, { issues: normaliseIssues(out, c.def) });
      } catch (e) {
        results.set(c.def.id, { error: errMessage(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  opts.signal?.throwIfAborted();

  // Keep registry order for stable output.
  for (const c of runnableSite) {
    const r = results.get(c.def.id);
    if (!r || 'error' in r) {
      const reason = r ? r.error : 'did not run';
      log('warn', `Check ${c.def.id} was skipped: ${reason}`);
      skipped(c.def, `The check hit an error: ${reason}`);
      continue;
    }
    for (const f of r.issues) issues.push(f);
    status[c.def.id] = { ...c.def, status: 'ran', affected: countAffected(r.issues) };
  }

  // Order the status map like the registry, not like completion order.
  const ordered: CheckStatusMap = {};
  for (const c of selected) if (status[c.def.id]) ordered[c.def.id] = status[c.def.id];
  return { issues, status: ordered };
}
