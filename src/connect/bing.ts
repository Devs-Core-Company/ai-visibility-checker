/**
 * Bing Webmaster Tools API (API key) and IndexNow.
 * Bing's index feeds ChatGPT search and Microsoft Copilot, so being crawled
 * and indexed by Bing matters for AI visibility, not just Bing search.
 */
import { randomBytes } from 'node:crypto';
import { ConnectError, type FetchFn } from './google-api.js';

export const BING_BASE_URL = 'https://ssl.bing.com/webmaster/api.svc/json';
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** Local type: not part of ExternalData in the shared contract. */
export interface BingData {
  siteUrl: string;
  verified: boolean | null;
  /** Totals over the days Bing returns (usually the last ~6 months, weekly points). */
  traffic: { clicks: number; impressions: number; from?: string; to?: string; points: number } | null;
  /** Latest crawl stats point. */
  crawl: {
    date?: string;
    crawledPages: number;
    crawlErrors: number;
    inIndex: number;
    inLinks: number;
    blockedByRobots: number;
    status4xx: number;
    status5xx: number;
  } | null;
  crawlIssues: { url: string; httpCode?: number; issues: string }[];
  quota: { daily: number; monthly: number } | null;
  errors: string[];
}

export interface BingOptions {
  fetch?: FetchFn;
  baseUrl?: string;
}

/** Bing returns WCF dates: "/Date(1700000000000-0700)/". */
export function parseBingDate(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /\/Date\((-?\d+)/.exec(v);
  if (m) return new Date(Number(m[1])).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

async function bingGet<T>(
  method: string,
  apiKey: string,
  params: Record<string, string>,
  opts: BingOptions,
): Promise<T> {
  const f = opts.fetch ?? fetch;
  const q = new URLSearchParams({ ...params, apikey: apiKey });
  const url = `${(opts.baseUrl ?? BING_BASE_URL).replace(/\/$/, '')}/${method}?${q.toString()}`;
  let res: Response;
  try {
    res = await f(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    throw new ConnectError(`Could not reach Bing Webmaster Tools: ${(e as Error).message}.`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { Message?: string; ErrorCode?: number };
      msg = j.Message ?? msg;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 || /InvalidApiKey|NotAuthorized/i.test(msg)) {
      throw new ConnectError(
        `Bing Webmaster Tools rejected the API key (${msg}).`,
        'In Bing Webmaster Tools → Settings (gear) → API access, generate an API key and set BING_WEBMASTER_API_KEY.',
        res.status,
      );
    }
    throw new ConnectError(`Bing Webmaster Tools ${method} returned HTTP ${res.status}: ${msg}`, undefined, res.status);
  }
  const body = JSON.parse(text) as { d?: T };
  return (body.d ?? (body as unknown)) as T;
}

interface BingSite {
  Url: string;
  IsVerified?: boolean;
}

export async function listBingSites(apiKey: string, opts: BingOptions = {}): Promise<BingSite[]> {
  return (await bingGet<BingSite[]>('GetUserSites', apiKey, {}, opts)) ?? [];
}

function sameSite(a: string, b: string): boolean {
  const n = (s: string) => {
    try {
      const u = new URL(s);
      return u.hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return s.toLowerCase();
    }
  };
  return n(a) === n(b);
}

/** Site stats, crawl stats, crawl issues and URL submission quota. Partial failures go to `.errors`. */
export async function collectBing(
  siteUrl: string,
  apiKey: string,
  opts: BingOptions = {},
): Promise<BingData> {
  const data: BingData = {
    siteUrl,
    verified: null,
    traffic: null,
    crawl: null,
    crawlIssues: [],
    quota: null,
    errors: [],
  };
  const sites = await listBingSites(apiKey, opts); // throws on a bad key: that is the connection test
  const match = sites.find((s) => sameSite(s.Url, siteUrl));
  if (!match) {
    data.errors.push(
      `${siteUrl} is not in this Bing Webmaster Tools account. Add it (you can import it from Google Search Console) and verify it.`,
    );
    return data;
  }
  data.siteUrl = match.Url;
  data.verified = match.IsVerified ?? null;
  const p = { siteUrl: match.Url };

  const tasks: Promise<void>[] = [
    bingGet<{ Date: string; Clicks: number; Impressions: number }[]>('GetRankAndTrafficStats', apiKey, p, opts).then(
      (rows) => {
        if (!rows?.length) return;
        const dates = rows.map((r) => parseBingDate(r.Date)).filter(Boolean).sort() as string[];
        data.traffic = {
          clicks: rows.reduce((s, r) => s + (r.Clicks || 0), 0),
          impressions: rows.reduce((s, r) => s + (r.Impressions || 0), 0),
          from: dates[0],
          to: dates[dates.length - 1],
          points: rows.length,
        };
      },
    ),
    bingGet<
      {
        Date: string;
        CrawledPages?: number;
        CrawlErrors?: number;
        InIndex?: number;
        InLinks?: number;
        BlockedByRobotsTxt?: number;
        Code4xx?: number;
        Code5xx?: number;
      }[]
    >('GetCrawlStats', apiKey, p, opts).then((rows) => {
      if (!rows?.length) return;
      const latest = [...rows].sort((a, b) =>
        (parseBingDate(a.Date) ?? '').localeCompare(parseBingDate(b.Date) ?? ''),
      )[rows.length - 1];
      data.crawl = {
        date: parseBingDate(latest.Date),
        crawledPages: latest.CrawledPages ?? 0,
        crawlErrors: latest.CrawlErrors ?? 0,
        inIndex: latest.InIndex ?? 0,
        inLinks: latest.InLinks ?? 0,
        blockedByRobots: latest.BlockedByRobotsTxt ?? 0,
        status4xx: latest.Code4xx ?? 0,
        status5xx: latest.Code5xx ?? 0,
      };
    }),
    bingGet<{ Url: string; HttpCode?: number; Issues?: number | string }[]>(
      'GetCrawlIssues',
      apiKey,
      p,
      opts,
    ).then((rows) => {
      data.crawlIssues = (rows ?? []).slice(0, 500).map((r) => ({
        url: r.Url,
        httpCode: r.HttpCode,
        issues: String(r.Issues ?? ''),
      }));
    }),
    bingGet<{ DailyQuota: number; MonthlyQuota: number }>('GetUrlSubmissionQuota', apiKey, p, opts).then(
      (q) => {
        if (q) data.quota = { daily: q.DailyQuota ?? 0, monthly: q.MonthlyQuota ?? 0 };
      },
    ),
  ];
  const settled = await Promise.allSettled(tasks);
  for (const s of settled) if (s.status === 'rejected') data.errors.push((s.reason as Error).message);
  return data;
}

// ---------------------------------------------------------------------------
// IndexNow (Bing, Yandex, Seznam, Naver, Yep share submissions)
// ---------------------------------------------------------------------------

/** A new IndexNow key: 32 hex characters (allowed: a-z, A-Z, 0-9, '-', 8–128 chars). */
export function generateIndexNowKey(): string {
  return randomBytes(16).toString('hex');
}

export function isValidIndexNowKey(key: string): boolean {
  return /^[a-zA-Z0-9-]{8,128}$/.test(key);
}

/** Check https://<host>/<key>.txt (or keyLocation) serves exactly the key. */
export async function checkIndexNowKey(
  host: string,
  key: string,
  opts: { fetch?: FetchFn; keyLocation?: string; scheme?: 'https' | 'http' } = {},
): Promise<{ ok: boolean; url: string; status: number; message: string }> {
  const url = opts.keyLocation ?? `${opts.scheme ?? 'https'}://${host}/${key}.txt`;
  if (!isValidIndexNowKey(key)) {
    return { ok: false, url, status: 0, message: 'The key must be 8–128 characters: letters, digits and dashes.' };
  }
  try {
    const res = await (opts.fetch ?? fetch)(url, { redirect: 'follow' });
    const body = (await res.text()).trim();
    if (!res.ok) {
      return { ok: false, url, status: res.status, message: `The key file returned HTTP ${res.status}. Upload a file named ${key}.txt containing the key to the site root.` };
    }
    if (body !== key) {
      return { ok: false, url, status: res.status, message: 'The key file exists but does not contain exactly the key (no other text or HTML).' };
    }
    return { ok: true, url, status: res.status, message: 'IndexNow key file found and correct.' };
  } catch (e) {
    return { ok: false, url, status: 0, message: `Could not fetch the key file: ${(e as Error).message}` };
  }
}

export interface IndexNowResult {
  ok: boolean;
  submitted: number;
  batches: { status: number; count: number; message: string }[];
}

const INDEXNOW_STATUS: Record<number, string> = {
  200: 'Accepted.',
  202: 'Received; the key will be validated later.',
  400: 'Bad request: invalid format.',
  403: 'Key not valid: the key file was not found or does not match.',
  422: 'Some URLs do not belong to the host, or the key does not match.',
  429: 'Too many requests: slow down.',
};

/**
 * Submit URLs to IndexNow (up to 10,000 per request; batched). All URLs must be on `host`.
 */
export async function submitIndexNow(
  urls: string[],
  key: string,
  host: string,
  opts: { fetch?: FetchFn; endpoint?: string; keyLocation?: string } = {},
): Promise<IndexNowResult> {
  const own = urls.filter((u) => {
    try {
      return new URL(u).host === host;
    } catch {
      return false;
    }
  });
  if (own.length !== urls.length) {
    throw new ConnectError(
      `${urls.length - own.length} URL(s) are not on ${host}.`,
      'IndexNow only accepts URLs from the host the key belongs to.',
    );
  }
  const f = opts.fetch ?? fetch;
  const out: IndexNowResult = { ok: true, submitted: 0, batches: [] };
  for (let i = 0; i < own.length; i += 10_000) {
    const batch = own.slice(i, i + 10_000);
    const body: Record<string, unknown> = { host, key, urlList: batch };
    if (opts.keyLocation) body.keyLocation = opts.keyLocation;
    let status = 0;
    let message: string;
    try {
      const res = await f(opts.endpoint ?? INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
      });
      status = res.status;
      message = INDEXNOW_STATUS[status] ?? `HTTP ${status}`;
      await res.text().catch(() => '');
    } catch (e) {
      message = `Could not reach IndexNow: ${(e as Error).message}`;
    }
    const ok = status === 200 || status === 202;
    if (ok) out.submitted += batch.length;
    else out.ok = false;
    out.batches.push({ status, count: batch.length, message });
  }
  return out;
}
