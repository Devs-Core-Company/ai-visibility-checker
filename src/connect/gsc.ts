/**
 * Google Search Console: properties, Search Analytics, URL Inspection, sitemaps.
 * Plain REST against searchconsole.googleapis.com (webmasters/v3 + v1 urlInspection).
 */
import type { GscData } from '../core/types.js';
import {
  ConnectError,
  daysAgo,
  googleJson,
  isoDate,
  sleep,
  type GoogleApiContext,
} from './google-api.js';

export const GSC_BASE_URL = 'https://searchconsole.googleapis.com';
const API = 'Google Search Console API';
const GSC_WHERE =
  'In Search Console → Settings → Users and permissions → Add user, add it with "Restricted" (read) permission, then try again.';

export interface GscProperty {
  siteUrl: string;
  permissionLevel: string; // siteOwner | siteFullUser | siteRestrictedUser | siteUnverifiedUser
}

export interface GscRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscQueryRequest {
  startDate: string;
  endDate: string;
  dimensions?: ('page' | 'query' | 'country' | 'device' | 'date' | 'searchAppearance')[];
  rowLimit?: number;
  startRow?: number;
  type?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
  dataState?: 'final' | 'all';
  dimensionFilterGroups?: unknown[];
}

export interface GscSitemap {
  path: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  warnings: number;
  errors: number;
  contents: { type: string; submitted: number; indexed?: number }[];
}

export type GscInspection = NonNullable<GscData['inspections']>[number] & {
  robotsTxtState?: string;
  indexingState?: string;
  pageFetchState?: string;
  userCanonical?: string;
  error?: string;
};

const base = (ctx: GoogleApiContext) => (ctx.baseUrl ?? GSC_BASE_URL).replace(/\/$/, '');
const enc = (property: string) => encodeURIComponent(property);

export async function listGscProperties(ctx: GoogleApiContext): Promise<GscProperty[]> {
  const r = await googleJson<{ siteEntry?: GscProperty[] }>(
    ctx,
    API,
    `${base(ctx)}/webmasters/v3/sites`,
    { resource: 'the list of properties', where: GSC_WHERE },
  );
  return r.siteEntry ?? [];
}

function registrable(host: string): string {
  return host.replace(/^www\./i, '').toLowerCase();
}

/**
 * Pick the best property for a site URL. Order: a URL-prefix property for the
 * exact origin, then a Domain property (sc-domain:) covering the host, then the
 * longest URL-prefix that contains the URL. Unverified entries are ignored.
 */
export function pickGscProperty(siteUrl: string, props: GscProperty[]): string | null {
  const u = new URL(siteUrl);
  const host = u.hostname.toLowerCase();
  const usable = props.filter((p) => p.permissionLevel !== 'siteUnverifiedUser');
  const origin = `${u.protocol}//${u.host}/`.toLowerCase();
  const exact = usable.find((p) => p.siteUrl.toLowerCase() === origin);
  if (exact) return exact.siteUrl;
  const domains = usable
    .filter((p) => p.siteUrl.startsWith('sc-domain:'))
    .map((p) => ({ p, d: p.siteUrl.slice('sc-domain:'.length).toLowerCase() }))
    .filter(({ d }) => host === d || host.endsWith(`.${d}`) || registrable(host) === d)
    .sort((a, b) => b.d.length - a.d.length);
  if (domains.length) return domains[0].p.siteUrl;
  const href = u.href.toLowerCase();
  const prefixes = usable
    .filter((p) => !p.siteUrl.startsWith('sc-domain:') && href.startsWith(p.siteUrl.toLowerCase()))
    .sort((a, b) => b.siteUrl.length - a.siteUrl.length);
  return prefixes[0]?.siteUrl ?? null;
}

export async function querySearchAnalytics(
  ctx: GoogleApiContext,
  property: string,
  req: GscQueryRequest,
): Promise<GscRow[]> {
  const r = await googleJson<{ rows?: GscRow[] }>(
    ctx,
    API,
    `${base(ctx)}/webmasters/v3/sites/${enc(property)}/searchAnalytics/query`,
    { body: { dataState: 'all', ...req }, resource: property, where: GSC_WHERE },
  );
  return r.rows ?? [];
}

export async function listGscSitemaps(ctx: GoogleApiContext, property: string): Promise<GscSitemap[]> {
  const r = await googleJson<{
    sitemap?: (Omit<GscSitemap, 'warnings' | 'errors' | 'contents'> & {
      warnings?: string | number;
      errors?: string | number;
      contents?: { type: string; submitted?: string | number; indexed?: string | number }[];
    })[];
  }>(ctx, API, `${base(ctx)}/webmasters/v3/sites/${enc(property)}/sitemaps`, {
    resource: property,
    where: GSC_WHERE,
  });
  return (r.sitemap ?? []).map((s) => ({
    ...s,
    warnings: Number(s.warnings ?? 0),
    errors: Number(s.errors ?? 0),
    contents: (s.contents ?? []).map((c) => ({
      type: c.type,
      submitted: Number(c.submitted ?? 0),
      indexed: c.indexed === undefined ? undefined : Number(c.indexed),
    })),
  }));
}

interface InspectResponse {
  inspectionResult?: {
    indexStatusResult?: {
      verdict?: string;
      coverageState?: string;
      robotsTxtState?: string;
      indexingState?: string;
      lastCrawlTime?: string;
      pageFetchState?: string;
      googleCanonical?: string;
      userCanonical?: string;
    };
  };
}

/**
 * URL Inspection for a sample of URLs, one at a time with a pause between calls
 * (the API allows about 600 a minute and 2,000 a day per property).
 * Individual failures are recorded on the row, not thrown, except auth errors.
 */
export async function inspectUrls(
  ctx: GoogleApiContext,
  property: string,
  urls: string[],
  opts: { max?: number; delayMs?: number } = {},
): Promise<GscInspection[]> {
  const max = opts.max ?? 20;
  const delay = opts.delayMs ?? 150;
  const out: GscInspection[] = [];
  for (const url of urls.slice(0, max)) {
    try {
      const r = await googleJson<InspectResponse>(
        ctx,
        API,
        `${base(ctx)}/v1/urlInspection/index:inspect`,
        { body: { inspectionUrl: url, siteUrl: property }, resource: property, where: GSC_WHERE },
      );
      const s = r.inspectionResult?.indexStatusResult ?? {};
      out.push({
        url,
        verdict: s.verdict ?? 'VERDICT_UNSPECIFIED',
        coverageState: s.coverageState ?? '',
        googleCanonical: s.googleCanonical,
        lastCrawl: s.lastCrawlTime,
        robotsTxtState: s.robotsTxtState,
        indexingState: s.indexingState,
        pageFetchState: s.pageFetchState,
        userCanonical: s.userCanonical,
      });
    } catch (e) {
      const status = (e as ConnectError).status;
      if (status === 401 || status === 403) throw e;
      if (status === 429) break; // daily quota used up: keep what we have
      out.push({ url, verdict: 'ERROR', coverageState: '', error: (e as Error).message });
    }
    if (delay) await sleep(delay);
  }
  return out;
}

export interface CollectGscOptions {
  /** Use this property instead of auto-picking. */
  property?: string;
  /** Window in days: 28 (default) or 90 or any other value. */
  days?: number;
  /** URLs to inspect (sample). */
  inspect?: string[];
  maxInspections?: number;
  inspectDelayMs?: number;
  rowLimit?: number;
  now?: Date;
}

export type GscCollected = GscData & { sitemaps?: GscSitemap[] };

/** Everything the checks need from Search Console, as GscData (+ sitemaps). */
export async function collectGsc(
  ctx: GoogleApiContext,
  siteUrl: string,
  opts: CollectGscOptions = {},
): Promise<GscCollected> {
  let property = opts.property;
  if (!property) {
    const props = await listGscProperties(ctx);
    property = pickGscProperty(siteUrl, props) ?? undefined;
    if (!property) {
      throw new ConnectError(
        `None of the ${props.length} Search Console properties ${ctx.principal ?? 'this account'} can see covers ${siteUrl}.`,
        props.length
          ? `Visible properties: ${props.map((p) => p.siteUrl).join(', ')}. Set connections.gscProperty, or ${GSC_WHERE.charAt(0).toLowerCase()}${GSC_WHERE.slice(1)}`
          : GSC_WHERE,
      );
    }
  }
  const now = opts.now ?? new Date();
  const days = opts.days ?? 28;
  const end = isoDate(daysAgo(now, 1));
  const start = isoDate(daysAgo(now, days));
  const rowLimit = opts.rowLimit ?? 1000;
  const range = { startDate: start, endDate: end };

  const [totalsRows, pageRows, queryRows, sitemaps] = await Promise.all([
    querySearchAnalytics(ctx, property, { ...range }),
    querySearchAnalytics(ctx, property, { ...range, dimensions: ['page'], rowLimit }),
    querySearchAnalytics(ctx, property, { ...range, dimensions: ['query'], rowLimit }),
    listGscSitemaps(ctx, property).catch(() => undefined),
  ]);
  const t = totalsRows[0];
  const data: GscCollected = {
    property,
    range: { start, end },
    totals: t
      ? { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position }
      : { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    pages: pageRows.map((r) => ({
      url: r.keys?.[0] ?? '',
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    })),
    queries: queryRows.map((r) => ({
      query: r.keys?.[0] ?? '',
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    })),
  };
  if (sitemaps) data.sitemaps = sitemaps;
  if (opts.inspect?.length) {
    data.inspections = await inspectUrls(ctx, property, opts.inspect, {
      max: opts.maxInspections,
      delayMs: opts.inspectDelayMs,
    });
  }
  return data;
}
