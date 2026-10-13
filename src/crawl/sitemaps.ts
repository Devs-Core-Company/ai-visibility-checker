/**
 * XML sitemap discovery and parsing.
 *
 * Sources, in order: sitemaps declared in robots.txt, any the user passed,
 * then the conventional /sitemap.xml and /sitemap_index.xml. Indexes are
 * followed recursively (at most MAX_FILES files and MAX_URLS URLs in all).
 * Gzipped sitemaps (.xml.gz) are decompressed. Plain-text sitemaps (one URL
 * per line) are accepted too.
 *
 * Conventional paths that return 404 are only reported when no sitemap was
 * found anywhere, so a check can say "we looked at /sitemap.xml: 404"
 * without flagging a missing fallback on a site that declares its sitemap
 * in robots.txt.
 */
import { gunzipSync } from 'node:zlib';
import type { Fetcher, HreflangRef, RobotsInfo, SitemapInfo } from '../core/types.js';
import { rawBody } from '../core/http.js';
import { isHttpUrl, normaliseUrl, sameSite } from '../core/url.js';

export const SITEMAP_LIMITS = {
  maxFiles: 50,
  maxUrls: 50_000,
  /** Protocol limit per file (uncompressed). */
  maxFileBytes: 50 * 1024 * 1024,
  maxUrlsPerFile: 50_000,
} as const;

export async function loadSitemaps(
  origin: string,
  robots: RobotsInfo,
  fetcher: Fetcher,
  extra: string[] = [],
): Promise<SitemapInfo[]> {
  const queue: { url: string; source: SitemapInfo['source'] }[] = [];
  const seen = new Set<string>();
  const push = (url: string, source: SitemapInfo['source']) => {
    if (!isHttpUrl(url)) return;
    const key = normaliseUrl(url);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ url, source });
  };
  for (const u of robots.sitemaps) push(u, 'robots');
  for (const u of extra) push(new URL(u, origin).toString(), 'user');
  const defaults = ['/sitemap.xml', '/sitemap_index.xml'].map((p) => new URL(p, origin).toString());
  for (const u of defaults) push(u, 'default');

  const out: SitemapInfo[] = [];
  let totalUrls = 0;
  let files = 0;

  while (queue.length && files < SITEMAP_LIMITS.maxFiles) {
    const item = queue.shift()!;
    files++;
    const info = await fetchOne(
      item.url,
      item.source,
      fetcher,
      origin,
      SITEMAP_LIMITS.maxUrls - totalUrls,
    );
    totalUrls += info.urls.length;
    out.push(info);
    for (const child of info.children) push(child, 'child');
    if (totalUrls >= SITEMAP_LIMITS.maxUrls) {
      info.errors.push(
        `Stopped reading sitemaps after ${SITEMAP_LIMITS.maxUrls.toLocaleString('en-GB')} URLs.`,
      );
      break;
    }
  }
  if (queue.length && files >= SITEMAP_LIMITS.maxFiles) {
    const last = out[out.length - 1];
    last?.errors.push(
      `Stopped after ${SITEMAP_LIMITS.maxFiles} sitemap files; ${queue.length} more were not read.`,
    );
  }

  const anyFound = out.some((s) => s.found);
  return out.filter((s) => s.found || s.source !== 'default' || !anyFound);
}

async function fetchOne(
  url: string,
  source: SitemapInfo['source'],
  fetcher: Fetcher,
  origin: string,
  urlBudget: number,
): Promise<SitemapInfo> {
  const info: SitemapInfo = {
    url,
    status: null,
    found: false,
    isIndex: false,
    urls: [],
    children: [],
    errors: [],
    bytes: 0,
    gzip: false,
    source,
  };
  const res = await fetcher.fetch(url, {
    headers: { accept: 'application/xml,text/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5' },
    maxBytes: SITEMAP_LIMITS.maxFileBytes,
    timeoutMs: 30_000,
  });
  info.status = res.status || null;
  info.bytes = res.bytes;
  if (res.status === 0) {
    info.errors.push(`Could not fetch: ${res.error ?? 'network error'}`);
    return info;
  }
  if (res.status < 200 || res.status >= 300) {
    if (!(source === 'default' && res.status === 404))
      info.errors.push(`Returned HTTP ${res.status}`);
    return info;
  }
  if (res.redirects.length)
    info.errors.push(`Redirects to ${res.finalUrl}; list the final URL instead.`);

  let text = res.body;
  const raw = rawBody(res);
  if (raw && raw[0] === 0x1f && raw[1] === 0x8b) {
    info.gzip = true;
    try {
      const unzipped = gunzipSync(raw, { maxOutputLength: SITEMAP_LIMITS.maxFileBytes });
      text = unzipped.toString('utf8');
      info.bytes = unzipped.length;
    } catch (e) {
      info.errors.push(`Gzip file could not be decompressed: ${(e as Error).message}`);
      return info;
    }
  } else if (/\.gz$/i.test(new URL(url).pathname)) {
    info.gzip = true; // served with Content-Encoding and already decoded
  }
  if (res.truncated) info.errors.push('File is larger than 50 MB and was cut off.');

  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (/^<(!doctype html|html)/i.test(trimmed)) {
    info.errors.push('Returned an HTML page, not a sitemap.');
    return info;
  }
  info.found = true;

  if (!trimmed.startsWith('<')) {
    // Plain-text sitemap.
    const lines = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (info.urls.length >= Math.min(urlBudget, SITEMAP_LIMITS.maxUrlsPerFile)) break;
      if (isHttpUrl(line)) info.urls.push({ loc: line });
      else {
        info.errors.push(`Not a URL in text sitemap: ${line.slice(0, 120)}`);
        if (info.errors.length > 20) break;
      }
    }
    checkHosts(info, origin);
    return info;
  }

  if (/<sitemapindex[\s>]/i.test(trimmed)) {
    info.isIndex = true;
    for (const block of blocks(trimmed, 'sitemap')) {
      const loc = tagText(block, 'loc');
      if (loc && isHttpUrl(loc)) info.children.push(loc);
      else if (loc) info.errors.push(`Invalid child sitemap URL: ${loc.slice(0, 200)}`);
    }
    if (!info.children.length) info.errors.push('Sitemap index lists no sitemaps.');
    return info;
  }

  if (!/<urlset[\s>]/i.test(trimmed)) {
    info.errors.push('Not a valid sitemap: no <urlset> or <sitemapindex> root element.');
    return info;
  }
  if (!/<\/urlset>/i.test(trimmed) && !res.truncated)
    info.errors.push('XML looks malformed: missing closing </urlset>.');

  let count = 0;
  let badLastmod = 0;
  let badLoc = 0;
  for (const block of blocks(trimmed, 'url')) {
    count++;
    if (info.urls.length >= urlBudget) continue;
    const loc = tagText(block, 'loc');
    if (!loc || !isHttpUrl(loc)) {
      badLoc++;
      continue;
    }
    const entry: SitemapInfo['urls'][number] = { loc };
    const lastmod = tagText(block, 'lastmod');
    if (lastmod) {
      entry.lastmod = lastmod;
      if (
        !/^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/.test(
          lastmod,
        )
      )
        badLastmod++;
    }
    const images = (block.match(/<(?:image:)?image[\s>]/gi) ?? []).length;
    if (images) entry.images = images;
    const alternates: HreflangRef[] = [];
    for (const m of block.matchAll(/<(?:xhtml:)?link\b([^>]*)\/?>/gi)) {
      const attrs = m[1] ?? '';
      if (!/rel\s*=\s*["']alternate["']/i.test(attrs)) continue;
      const lang = /hreflang\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      if (lang && href) alternates.push({ lang, href: decodeXml(href), source: 'sitemap' });
    }
    if (alternates.length) entry.hreflang = alternates;
    info.urls.push(entry);
  }
  if (count > SITEMAP_LIMITS.maxUrlsPerFile)
    info.errors.push(`Lists ${count} URLs; the limit per sitemap file is 50,000.`);
  if (badLoc) info.errors.push(`${badLoc} <url> entries have a missing or invalid <loc>.`);
  if (badLastmod) info.errors.push(`${badLastmod} <lastmod> values are not in W3C date format.`);
  if (!count) info.errors.push('Sitemap lists no URLs.');
  checkHosts(info, origin);
  return info;
}

function checkHosts(info: SitemapInfo, origin: string): void {
  const foreign = info.urls.filter((u) => !sameSite(u.loc, origin));
  if (foreign.length)
    info.errors.push(
      `${foreign.length} URLs are on another host (first: ${foreign[0]!.loc.slice(0, 200)}).`,
    );
}

function* blocks(xml: string, tag: string): Generator<string> {
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[\\s>][\\s\\S]*?<\\/(?:[\\w-]+:)?${tag}>`, 'gi');
  for (const m of xml.matchAll(re)) yield m[0];
}

function tagText(block: string, tag: string): string | null {
  // Unprefixed first, so <loc> wins over <image:loc>.
  const m =
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block) ??
    new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${tag}>`, 'i').exec(
      block,
    );
  if (!m) return null;
  let v = m[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(v);
  if (cdata) v = cdata[1]!.trim();
  return decodeXml(v);
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}
