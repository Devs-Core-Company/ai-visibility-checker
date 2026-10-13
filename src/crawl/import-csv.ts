/**
 * Import a Screaming Frog "Internal: All" export (CSV) and audit it with AVC's
 * checks, without crawling again. Each row becomes a page with the fields the
 * export has (status, title, description, headings, canonical, robots, word
 * count, depth, response time, size). Checks that need the full HTML or live
 * requests have less to work with; the report says how the data was imported.
 */
import { readFileSync } from 'node:fs';
import type { CrawlStats, FetchResult, Fetcher, PageData, SiteContext } from '../core/types.js';
import { normaliseUrl } from '../core/url.js';
import { basePage, extractPage } from './extract.js';
import { buildRobots } from './robots.js';

/** RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF/LF, BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

/** Rows as objects keyed by header name. */
export function csvObjects(text: string): Record<string, string>[] {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

const OFFLINE: Fetcher = {
  async fetch(url): Promise<FetchResult> {
    return {
      url,
      finalUrl: url,
      status: 0,
      ok: false,
      headers: {},
      redirects: [],
      body: '',
      bytes: 0,
      truncated: false,
      contentType: '',
      ttfbMs: 0,
      totalMs: 0,
      error: 'Imported crawl: no live requests',
    };
  },
};

/** One Screaming Frog row → PageData (HTML rebuilt from the exported fields). */
export function rowToPage(row: Record<string, string>, origin: string): PageData | null {
  const address = row['Address']?.trim();
  if (!address || !/^https?:\/\//i.test(address)) return null;
  const status = Number(row['Status Code']) || 0;
  const ct = row['Content Type'] || (status ? 'text/html; charset=utf-8' : '');
  const isHtml = /html/i.test(ct);
  const field = (k: string) => (row[k] ?? '').trim();
  const headings = [
    ...['H1-1', 'H1-2'].map((k) => (field(k) ? `<h1>${esc(field(k))}</h1>` : '')),
    ...['H2-1', 'H2-2'].map((k) => (field(k) ? `<h2>${esc(field(k))}</h2>` : '')),
  ].join('');
  const html = isHtml
    ? `<!doctype html><html><head>${field('Title 1') ? `<title>${esc(field('Title 1'))}</title>` : ''}${field('Meta Description 1') ? `<meta name="description" content="${esc(field('Meta Description 1'))}">` : ''}${field('Meta Robots 1') ? `<meta name="robots" content="${esc(field('Meta Robots 1'))}">` : ''}${field('Canonical Link Element 1') ? `<link rel="canonical" href="${esc(field('Canonical Link Element 1'))}">` : ''}${field('rel="next" 1') ? `<link rel="next" href="${esc(field('rel="next" 1'))}">` : ''}${field('rel="prev" 1') ? `<link rel="prev" href="${esc(field('rel="prev" 1'))}">` : ''}<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${headings}</body></html>`
    : '';
  const redirect = field('Redirect URL');
  const res: FetchResult = {
    url: address,
    finalUrl: redirect || address,
    status,
    ok: status >= 200 && status < 400,
    headers: {
      ...(ct ? { 'content-type': ct } : {}),
      ...(field('X-Robots-Tag 1') ? { 'x-robots-tag': field('X-Robots-Tag 1') } : {}),
    },
    redirects: redirect ? [{ url: address, status }] : [],
    body: html,
    bytes: Number(field('Size (bytes)')) || 0,
    truncated: false,
    contentType: ct,
    ttfbMs: Math.round((Number(field('Response Time')) || 0) * 1000),
    totalMs: Math.round((Number(field('Response Time')) || 0) * 1000),
  };
  const depth = Number(field('Crawl Depth'));
  const page =
    isHtml && !redirect
      ? extractPage(res, { origin, depth: Number.isFinite(depth) ? depth : 1 })
      : basePage(res, { origin, depth: Number.isFinite(depth) ? depth : 1 });
  page.isHtml = isHtml && !redirect;
  const words = Number(field('Word Count'));
  if (Number.isFinite(words)) page.wordCount = words;
  page.text = '';
  page.mainText = null;
  page.lead = '';
  page.contentHash = field('Hash') || '';
  if (
    /non-indexable/i.test(field('Indexability')) &&
    /blocked by robots/i.test(field('Indexability Status'))
  )
    page.blockedByRobots = true;
  return page;
}

/** Build a SiteContext from a Screaming Frog CSV export. */
export function siteFromScreamingFrog(path: string, opts: { startUrl?: string } = {}): SiteContext {
  const rows = csvObjects(readFileSync(path, 'utf8'));
  const first = rows.find((r) => /^https?:\/\//i.test(r['Address'] ?? ''));
  if (!first)
    throw new Error(
      `${path} has no "Address" column with URLs. Export "Internal: All" from Screaming Frog as CSV.`,
    );
  const startUrl = normaliseUrl(opts.startUrl ?? new URL(first['Address']!).origin + '/');
  const origin = new URL(startUrl).origin;
  const pages = new Map<string, PageData>();
  for (const r of rows) {
    const p = rowToPage(r, origin);
    if (p) pages.set(p.url, p);
  }
  const now = new Date().toISOString();
  const stats: CrawlStats = {
    startedAt: now,
    finishedAt: now,
    pagesCrawled: pages.size,
    pagesQueuedNotCrawled: 0,
    maxPages: pages.size,
    maxDepth: 0,
    rendered: 0,
    errors: [...pages.values()].filter((p) => p.status === 0 || p.status >= 400).length,
    durationMs: 0,
  };
  return {
    startUrl,
    origin,
    host: new URL(origin).host,
    pages,
    inlinks: new Map(),
    robots: buildRobots(`${origin}/robots.txt`, '', { status: null, found: false }),
    sitemaps: [],
    stack: { id: 'unknown', confidence: 0, signals: ['imported from Screaming Frog'] },
    probes: new Map(),
    botFetches: [],
    browserFetch: null,
    external: {},
    fetcher: OFFLINE,
    options: {
      startUrl,
      maxPages: pages.size,
      maxDepth: 0,
      concurrency: 1,
      delayMs: 0,
      userAgent: 'import',
      respectRobots: true,
      render: false,
      renderLimit: 0,
      useSitemaps: false,
      checkExternalLinks: false,
      checkImages: false,
      timeoutMs: 0,
      maxBytes: 0,
    },
    stats,
  };
}
