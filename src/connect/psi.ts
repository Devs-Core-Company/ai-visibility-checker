/**
 * PageSpeed Insights v5: Lighthouse lab data + Chrome UX Report field data for
 * a small sample of URLs, mobile and desktop. Works without a key at low volume;
 * a key (config.google.psiKey / PSI_API_KEY) raises the quota.
 */
import type { PsiResult, SiteContext } from '../core/types.js';
import { mapLimit, retryDelay, sleep, type FetchFn } from './google-api.js';

export const PSI_BASE_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

export type PsiStrategy = 'mobile' | 'desktop';

/**
 * Key used in `site.external.psi`: the plain URL for mobile (Google indexes
 * mobile-first), `desktop:<url>` for desktop. Every value carries `.strategy`.
 */
export function psiKey(url: string, strategy: PsiStrategy): string {
  return strategy === 'mobile' ? url : `desktop:${url}`;
}

export interface PsiOptions {
  key?: string;
  fetch?: FetchFn;
  baseUrl?: string;
  retries?: number;
  timeoutMs?: number;
  /** Override the wait between retries (tests). */
  sleepFn?: (ms: number) => Promise<void>;
}

interface LhAudit {
  id?: string;
  title?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  numericValue?: number;
  details?: { type?: string; overallSavingsMs?: number };
  metricSavings?: Record<string, number>;
}

interface PsiResponse {
  loadingExperience?: PsiField;
  originLoadingExperience?: PsiField;
  lighthouseResult?: {
    categories?: Record<string, { score?: number | null }>;
    audits?: Record<string, LhAudit>;
    runtimeError?: { code?: string; message?: string };
  };
  error?: { code?: number; message?: string };
}

interface PsiField {
  id?: string;
  origin_fallback?: boolean;
  overall_category?: string;
  metrics?: Record<string, { percentile?: number; category?: string }>;
}

const pct = (s: number | null | undefined) =>
  s === null || s === undefined ? null : Math.round(s * 100);

/** Parse a PSI v5 JSON response. Exported for tests and for imported PSI JSON. */
export function parsePsi(url: string, strategy: PsiStrategy, body: PsiResponse): PsiResult {
  const lh = body.lighthouseResult;
  const audits = lh?.audits ?? {};
  const num = (id: string) => {
    const v = audits[id]?.numericValue;
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : undefined;
  };
  const result: PsiResult = {
    url,
    strategy,
    performanceScore: pct(lh?.categories?.performance?.score),
    lcpMs: num('largest-contentful-paint'),
    cls: num('cumulative-layout-shift'),
    tbtMs: num('total-blocking-time'),
    fcpMs: num('first-contentful-paint'),
    ttfbMs: num('server-response-time'),
    opportunities: [],
    accessibilityScore: pct(lh?.categories?.accessibility?.score),
    seoScore: pct(lh?.categories?.seo?.score),
  };
  if (lh?.runtimeError?.code) {
    result.error = `Lighthouse: ${lh.runtimeError.code} ${lh.runtimeError.message ?? ''}`.trim();
  }

  // Field data: only page-level CrUX (origin fallback would describe other pages).
  const le = body.loadingExperience;
  if (le?.metrics && !le.origin_fallback) {
    const m = le.metrics;
    const field: NonNullable<PsiResult['field']> = {};
    if (m.LARGEST_CONTENTFUL_PAINT_MS?.percentile !== undefined)
      field.lcpMs = m.LARGEST_CONTENTFUL_PAINT_MS.percentile;
    if (m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile !== undefined)
      field.cls = m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100;
    if (m.INTERACTION_TO_NEXT_PAINT?.percentile !== undefined)
      field.inpMs = m.INTERACTION_TO_NEXT_PAINT.percentile;
    const cat = le.overall_category;
    if (cat === 'FAST' || cat === 'AVERAGE' || cat === 'SLOW') field.category = cat;
    if (Object.keys(field).length) result.field = field;
    if (field.inpMs !== undefined) result.inpMs = field.inpMs;
  }

  const opps: PsiResult['opportunities'] = [];
  for (const [id, a] of Object.entries(audits)) {
    if (a.score === null || a.score === undefined || a.score >= 0.9) continue;
    const savings =
      a.details?.overallSavingsMs ??
      Math.max(0, ...Object.values(a.metricSavings ?? {}).filter((v) => typeof v === 'number'));
    const isOpp = a.details?.type === 'opportunity' || (a.metricSavings && savings > 0);
    if (!isOpp || !(savings > 0)) continue;
    opps.push({ id, title: a.title ?? id, savingsMs: Math.round(savings) });
  }
  opps.sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0));
  result.opportunities = opps.slice(0, 10);
  return result;
}

/** One PSI run. Never throws: errors are returned on `.error`. */
export async function runPsi(
  url: string,
  strategy: PsiStrategy,
  opts: PsiOptions = {},
): Promise<PsiResult> {
  const f = opts.fetch ?? fetch;
  const wait = opts.sleepFn ?? sleep;
  const q = new URLSearchParams({ url, strategy });
  for (const c of ['performance', 'accessibility', 'seo']) q.append('category', c);
  if (opts.key) q.set('key', opts.key);
  const endpoint = `${opts.baseUrl ?? PSI_BASE_URL}?${q.toString()}`;
  const retries = opts.retries ?? 3;
  const empty = (error: string): PsiResult => ({
    url,
    strategy,
    performanceScore: null,
    opportunities: [],
    error,
  });

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(endpoint, { signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
    } catch (e) {
      if (attempt < retries) {
        await wait(2000 * 2 ** attempt);
        continue;
      }
      return empty(`Could not reach PageSpeed Insights: ${(e as Error).message}`);
    }
    if (res.ok) {
      try {
        return parsePsi(url, strategy, (await res.json()) as PsiResponse);
      } catch (e) {
        return empty(`Unreadable PageSpeed Insights response: ${(e as Error).message}`);
      }
    }
    const text = await res.text().catch(() => '');
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await wait(retryDelay(res, attempt + 1));
      continue;
    }
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as PsiResponse).error?.message ?? msg;
    } catch {
      /* not JSON */
    }
    if (res.status === 429) {
      return empty(
        `PageSpeed Insights quota reached (${msg}). Add a free API key (PSI_API_KEY) to raise the limit.`,
      );
    }
    if (res.status === 403 && /API has not been used|is disabled|SERVICE_DISABLED/i.test(text)) {
      return empty(
        'PageSpeed Insights API is not enabled for this key’s Google Cloud project. Enable "PageSpeed Insights API" in the API library, then try again.',
      );
    }
    return empty(`PageSpeed Insights returned HTTP ${res.status}: ${msg}`);
  }
}

/** Home page first, then the HTML pages with the most internal links pointing at them. */
export function samplePsiUrls(site: Pick<SiteContext, 'startUrl' | 'pages' | 'inlinks'>, n: number): string[] {
  const out = [site.startUrl];
  const candidates = [...site.pages.values()]
    .filter((p) => p.isHtml && p.status === 200 && p.url !== site.startUrl && p.finalUrl === p.url)
    .map((p) => ({ url: p.url, inlinks: site.inlinks.get(p.url)?.size ?? 0 }))
    .sort((a, b) => b.inlinks - a.inlinks || a.url.length - b.url.length);
  for (const c of candidates) {
    if (out.length >= n) break;
    out.push(c.url);
  }
  return out.slice(0, Math.max(1, n));
}

export interface CollectPsiOptions extends PsiOptions {
  strategies?: PsiStrategy[];
  concurrency?: number;
  onResult?: (r: PsiResult) => void;
}

/** PSI for each URL × strategy, two at a time. Keys from `psiKey()`. */
export async function collectPsi(
  urls: string[],
  opts: CollectPsiOptions = {},
): Promise<Record<string, PsiResult>> {
  const strategies = opts.strategies ?? ['mobile', 'desktop'];
  const jobs = urls.flatMap((url) => strategies.map((strategy) => ({ url, strategy })));
  const results = await mapLimit(jobs, opts.concurrency ?? 2, async (j) => {
    const r = await runPsi(j.url, j.strategy, opts);
    opts.onResult?.(r);
    return r;
  });
  const out: Record<string, PsiResult> = {};
  for (const r of results) out[psiKey(r.url, r.strategy)] = r;
  return out;
}
