/**
 * Outbound links checked against Google Safe Browsing (Lookup API v4).
 * Needs your own API key (AVC_SAFE_BROWSING_KEY). Only the link URLs are sent,
 * in batches of 500; nothing is sent without a key.
 */
import type { SiteContext } from '../core/types.js';
import type { FetchFn } from './google-api.js';

const ENDPOINT = 'https://safebrowsing.googleapis.com/v4/threatMatches:find';
const BATCH = 500;
const MAX_URLS = 5_000;

/** Every external link and the pages it appears on. */
export function outboundLinks(site: SiteContext): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of site.pages.values()) {
    if (!p.isHtml) continue;
    for (const l of p.links) {
      if (l.internal || !/^https?:/i.test(l.href)) continue;
      const pages = out.get(l.href) ?? [];
      if (pages.length < 20 && !pages.includes(p.url)) pages.push(p.url);
      out.set(l.href, pages);
      if (out.size >= MAX_URLS) return out;
    }
  }
  return out;
}

export async function collectSafeBrowsing(
  site: SiteContext,
  key: string,
  opts: { fetch?: FetchFn; endpoint?: string } = {},
): Promise<NonNullable<SiteContext['external']['safeBrowsing']>> {
  const f = opts.fetch ?? fetch;
  const links = outboundLinks(site);
  const urls = [...links.keys()];
  const matches: { url: string; threat: string; pages: string[] }[] = [];
  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    const res = await f(`${opts.endpoint ?? ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client: { clientId: 'ai-visibility-checker', clientVersion: '1' },
        threatInfo: {
          threatTypes: [
            'MALWARE',
            'SOCIAL_ENGINEERING',
            'UNWANTED_SOFTWARE',
            'POTENTIALLY_HARMFUL_APPLICATION',
          ],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: batch.map((url) => ({ url })),
        },
      }),
    });
    if (!res.ok) throw new Error(`Safe Browsing returned HTTP ${res.status}`);
    const json = (await res.json()) as {
      matches?: { threatType?: string; threat?: { url?: string } }[];
    };
    for (const m of json.matches ?? []) {
      const url = m.threat?.url ?? '';
      if (!url || matches.some((x) => x.url === url)) continue;
      matches.push({ url, threat: m.threatType ?? 'THREAT', pages: links.get(url) ?? [] });
    }
  }
  return { checked: urls.length, matches };
}
