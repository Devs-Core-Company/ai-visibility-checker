/**
 * Backlink metrics from the backlink provider you already pay for. There is no
 * free backlink index worth shipping, so AVC only connects to yours:
 * Moz (AVC_MOZ_TOKEN), Ahrefs API v3 (AVC_AHREFS_TOKEN) or Majestic
 * (AVC_MAJESTIC_KEY). Keys stay in env vars or ~/.avc/config.json.
 */
import type { AvcConfig } from '../core/config.js';
import type { BacklinkData } from '../core/types.js';
import type { FetchFn } from './google-api.js';

export type BacklinkProvider = BacklinkData['provider'];

export function backlinkProvider(config: AvcConfig): BacklinkProvider | null {
  const b = config.backlinks;
  if (!b) return null;
  const p = b.provider;
  if (p === 'moz' && b.mozToken) return 'moz';
  if (p === 'ahrefs' && b.ahrefsToken) return 'ahrefs';
  if (p === 'majestic' && b.majesticKey) return 'majestic';
  if (b.mozToken) return 'moz';
  if (b.ahrefsToken) return 'ahrefs';
  if (b.majesticKey) return 'majestic';
  return null;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function pick(obj: Record<string, unknown>, keys: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [from, to] of Object.entries(keys)) {
    const v = num(obj[from]);
    if (v !== undefined) out[to] = v;
  }
  return out;
}

/** Domain-level link metrics for `target` (a host such as example.com). */
export async function fetchBacklinks(
  config: AvcConfig,
  target: string,
  opts: { fetch?: FetchFn; now?: Date } = {},
): Promise<BacklinkData | null> {
  const provider = backlinkProvider(config);
  if (!provider) return null;
  const f = opts.fetch ?? fetch;
  const b = config.backlinks!;
  const host = target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  try {
    if (provider === 'moz') {
      const res = await f('https://lsapi.seomoz.com/v2/url_metrics', {
        method: 'POST',
        headers: { 'x-moz-token': b.mozToken!, 'content-type': 'application/json' },
        body: JSON.stringify({ targets: [host] }),
      });
      if (!res.ok) throw new Error(`Moz returned HTTP ${res.status}`);
      const json = (await res.json()) as { results?: Record<string, unknown>[] };
      const r = json.results?.[0] ?? {};
      return {
        provider,
        target: host,
        metrics: pick(r, {
          domain_authority: 'domainAuthority',
          page_authority: 'pageAuthority',
          root_domains_to_root_domain: 'referringDomains',
          external_pages_to_root_domain: 'backlinks',
          spam_score: 'spamScore',
        }),
      };
    }
    if (provider === 'ahrefs') {
      const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
      const q = new URLSearchParams({ target: host, date, mode: 'subdomains' });
      const headers = { authorization: `Bearer ${b.ahrefsToken}`, accept: 'application/json' };
      const [dr, bl] = await Promise.all([
        f(`https://api.ahrefs.com/v3/site-explorer/domain-rating?${q}`, { headers }),
        f(`https://api.ahrefs.com/v3/site-explorer/backlinks-stats?${q}`, { headers }),
      ]);
      if (!dr.ok) throw new Error(`Ahrefs returned HTTP ${dr.status}`);
      const d =
        ((await dr.json()) as { domain_rating?: Record<string, unknown> }).domain_rating ?? {};
      const s = bl.ok
        ? (((await bl.json()) as { metrics?: Record<string, unknown> }).metrics ?? {})
        : {};
      return {
        provider,
        target: host,
        metrics: {
          ...pick(d, { domain_rating: 'domainRating', ahrefs_rank: 'ahrefsRank' }),
          ...pick(s, { live: 'backlinks', live_refdomains: 'referringDomains' }),
        },
      };
    }
    const q = new URLSearchParams({
      app_api_key: b.majesticKey!,
      cmd: 'GetIndexItemInfo',
      items: '1',
      item0: host,
      datasource: 'fresh',
    });
    const res = await f(`https://api.majestic.com/api/json?${q}`);
    if (!res.ok) throw new Error(`Majestic returned HTTP ${res.status}`);
    const json = (await res.json()) as {
      Code?: string;
      ErrorMessage?: string;
      DataTables?: { Results?: { Data?: Record<string, unknown>[] } };
    };
    if (json.Code && json.Code !== 'OK')
      throw new Error(`Majestic: ${json.ErrorMessage || json.Code}`);
    const r = json.DataTables?.Results?.Data?.[0] ?? {};
    return {
      provider,
      target: host,
      metrics: pick(r, {
        TrustFlow: 'trustFlow',
        CitationFlow: 'citationFlow',
        ExtBackLinks: 'backlinks',
        RefDomains: 'referringDomains',
      }),
    };
  } catch (e) {
    return { provider, target: host, metrics: {}, error: (e as Error).message };
  }
}
