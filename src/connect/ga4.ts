/**
 * Google Analytics 4: sessions referred by AI assistants (Data API runReport),
 * and property discovery (Admin API) so users do not have to look up ids.
 */
import type { Ga4Data } from '../core/types.js';
import {
  ConnectError,
  daysAgo,
  googleJson,
  isoDate,
  type GoogleApiContext,
} from './google-api.js';

export const GA4_DATA_BASE_URL = 'https://analyticsdata.googleapis.com';
export const GA4_ADMIN_BASE_URL = 'https://analyticsadmin.googleapis.com';
const API = 'Google Analytics Data API';
const GA4_WHERE =
  'In Google Analytics → Admin → Property access management, add it with the Viewer role, then try again.';

/**
 * AI assistants as they appear in GA4's sessionSource (referrer host, or the
 * utm_source some assistants add, e.g. ChatGPT adds utm_source=chatgpt.com).
 */
export const AI_ASSISTANT_SOURCES: { name: string; hosts: string[]; tokens?: string[] }[] = [
  { name: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com'], tokens: ['chatgpt'] },
  { name: 'Perplexity', hosts: ['perplexity.ai'], tokens: ['perplexity'] },
  { name: 'Gemini', hosts: ['gemini.google.com', 'bard.google.com'], tokens: ['gemini', 'bard'] },
  { name: 'Claude', hosts: ['claude.ai'], tokens: ['claude'] },
  {
    name: 'Microsoft Copilot',
    hosts: ['copilot.microsoft.com', 'copilot.cloud.microsoft', 'edgeservices.bing.com'],
    tokens: ['copilot'],
  },
  { name: 'You.com', hosts: ['you.com'] },
  { name: 'Phind', hosts: ['phind.com'], tokens: ['phind'] },
  { name: 'Meta AI', hosts: ['meta.ai'], tokens: ['meta.ai', 'metaai'] },
  { name: 'DeepSeek', hosts: ['chat.deepseek.com'], tokens: ['deepseek'] },
  { name: 'Grok', hosts: ['grok.com', 'grok.x.ai'], tokens: ['grok'] },
  { name: 'Mistral Le Chat', hosts: ['chat.mistral.ai'], tokens: ['mistral'] },
  { name: 'Poe', hosts: ['poe.com'] },
  { name: 'Qwen', hosts: ['chat.qwen.ai', 'tongyi.aliyun.com'] },
  { name: 'Doubao', hosts: ['doubao.com'] },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The AI-referrer pattern as an RE2-compatible string (GA4 uses RE2): a host or
 * any subdomain of it, or one of the bare utm_source tokens.
 */
export const AI_REFERRER_PATTERN = (() => {
  const hosts = AI_ASSISTANT_SOURCES.flatMap((s) => s.hosts).map(escapeRe);
  const tokens = AI_ASSISTANT_SOURCES.flatMap((s) => s.tokens ?? []).map(escapeRe);
  return `^(([a-z0-9-]+\\.)*(${hosts.join('|')})(/.*)?|${tokens.join('|')})$`;
})();

/** Case-insensitive JS RegExp of AI_REFERRER_PATTERN, for referrer strings and GA4 sources. */
export const AI_REFERRER_REGEX = new RegExp(AI_REFERRER_PATTERN, 'i');

/** Name of the AI assistant a GA4 source / referrer host belongs to, or null. */
export function aiAssistantFromSource(source: string): string | null {
  let s = source.trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).hostname;
  } catch {
    /* keep as is */
  }
  if (!AI_REFERRER_REGEX.test(s)) return null;
  for (const a of AI_ASSISTANT_SOURCES) {
    if (a.hosts.some((h) => s === h || s.endsWith(`.${h}`) || s.startsWith(`${h}/`))) return a.name;
    if (a.tokens?.includes(s)) return a.name;
  }
  return null;
}

interface RunReportResponse {
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
  rowCount?: number;
}

export async function runGa4Report(
  ctx: GoogleApiContext,
  property: string,
  body: Record<string, unknown>,
): Promise<RunReportResponse> {
  const p = normaliseGa4Property(property);
  return googleJson<RunReportResponse>(
    ctx,
    API,
    `${(ctx.baseUrl ?? GA4_DATA_BASE_URL).replace(/\/$/, '')}/v1beta/${p}:runReport`,
    { body, resource: `GA4 ${p}`, where: GA4_WHERE },
  );
}

/** Accepts '123456', 'properties/123456' or a GA4 URL fragment like 'p123456'. */
export function normaliseGa4Property(property: string): string {
  const m = /(\d{5,})/.exec(property);
  if (!m) {
    throw new ConnectError(
      `"${property}" is not a GA4 property id.`,
      'Use the numeric id from GA4 → Admin → Property details, e.g. properties/123456789.',
    );
  }
  return `properties/${m[1]}`;
}

export interface CollectGa4Options {
  days?: number;
  now?: Date;
  limit?: number;
}

const aiFilter = {
  filter: {
    fieldName: 'sessionSource',
    stringFilter: { matchType: 'FULL_REGEXP', value: AI_REFERRER_PATTERN, caseSensitive: false },
  },
};

/** AI-assistant referrals and their landing pages for a GA4 property. */
export async function collectGa4(
  ctx: GoogleApiContext,
  property: string,
  opts: CollectGa4Options = {},
): Promise<Ga4Data> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 28;
  const start = isoDate(daysAgo(now, days));
  const end = isoDate(daysAgo(now, 1));
  const dateRanges = [{ startDate: start, endDate: end }];
  const p = normaliseGa4Property(property);

  const [bySource, byLanding] = await Promise.all([
    runGa4Report(ctx, p, {
      dateRanges,
      dimensions: [{ name: 'sessionSource' }],
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }],
      dimensionFilter: aiFilter,
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 100,
    }),
    runGa4Report(ctx, p, {
      dateRanges,
      dimensions: [{ name: 'sessionSource' }, { name: 'landingPage' }],
      metrics: [{ name: 'sessions' }],
      dimensionFilter: aiFilter,
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: opts.limit ?? 250,
    }),
  ]);

  const num = (v?: { value: string }) => Number(v?.value ?? 0) || 0;
  return {
    property: p,
    range: { start, end },
    aiReferrals: (bySource.rows ?? []).map((r) => ({
      source: r.dimensionValues?.[0]?.value ?? '',
      sessions: num(r.metricValues?.[0]),
      engagedSessions: num(r.metricValues?.[1]),
      conversions: num(r.metricValues?.[2]),
    })),
    landingPages: (byLanding.rows ?? []).map((r) => ({
      source: r.dimensionValues?.[0]?.value ?? '',
      path: r.dimensionValues?.[1]?.value ?? '',
      sessions: num(r.metricValues?.[0]),
    })),
  };
}

// ---------------------------------------------------------------------------
// Property discovery (Admin API)
// ---------------------------------------------------------------------------

export interface Ga4PropertySummary {
  property: string; // properties/123
  displayName: string;
  account: string;
  accountName: string;
}

export async function listGa4Properties(ctx: GoogleApiContext): Promise<Ga4PropertySummary[]> {
  const baseUrl = (ctx.baseUrl ?? GA4_ADMIN_BASE_URL).replace(/\/$/, '');
  const out: Ga4PropertySummary[] = [];
  let pageToken: string | undefined;
  do {
    const r = await googleJson<{
      accountSummaries?: {
        account: string;
        displayName: string;
        propertySummaries?: { property: string; displayName: string }[];
      }[];
      nextPageToken?: string;
    }>(
      ctx,
      'Google Analytics Admin API',
      `${baseUrl}/v1beta/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      { resource: 'the list of GA4 properties', where: GA4_WHERE },
    );
    for (const a of r.accountSummaries ?? []) {
      for (const p of a.propertySummaries ?? []) {
        out.push({
          property: p.property,
          displayName: p.displayName,
          account: a.account,
          accountName: a.displayName,
        });
      }
    }
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

/** Find the GA4 property whose web data stream points at the site's host. */
export async function findGa4Property(ctx: GoogleApiContext, siteUrl: string): Promise<string | null> {
  const host = new URL(siteUrl).hostname.replace(/^www\./i, '').toLowerCase();
  const baseUrl = (ctx.baseUrl ?? GA4_ADMIN_BASE_URL).replace(/\/$/, '');
  for (const p of await listGa4Properties(ctx)) {
    const r = await googleJson<{
      dataStreams?: { type?: string; webStreamData?: { defaultUri?: string } }[];
    }>(ctx, 'Google Analytics Admin API', `${baseUrl}/v1beta/${p.property}/dataStreams`, {
      resource: p.property,
      where: GA4_WHERE,
    }).catch(() => ({ dataStreams: [] }));
    for (const s of r.dataStreams ?? []) {
      const uri = s.webStreamData?.defaultUri;
      if (!uri) continue;
      try {
        const h = new URL(/^https?:/.test(uri) ? uri : `https://${uri}`).hostname
          .replace(/^www\./i, '')
          .toLowerCase();
        if (h === host) return p.property;
      } catch {
        /* skip */
      }
    }
  }
  return null;
}
