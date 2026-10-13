/**
 * XML sitemaps: discovery, validity, size, and whether they list the right URLs.
 */
import type { Issue, SiteContext, SitemapInfo } from '../core/types.js';
import {
  ISO_DATE,
  REF,
  findPage,
  indexablePages,
  isCanonicalisedAway,
  isHtml200,
  isNoindex,
  list,
  plural,
  safeUrl,
  siteCheck,
  wasRedirected,
} from './_util.js';

export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
export const STALE_SITEMAP_DAYS = 365;
export const MISSING_FROM_SITEMAP_MIN_SHARE = 0.1;
export const REPORT_LIMIT = 200;

const T = 'technical' as const;

function locs(site: SiteContext): { loc: string; lastmod?: string; sitemap: string }[] {
  const out: { loc: string; lastmod?: string; sitemap: string }[] = [];
  for (const s of site.sitemaps)
    for (const u of s.urls) out.push({ loc: u.loc, lastmod: u.lastmod, sitemap: s.url });
  return out;
}

function found(site: SiteContext): SitemapInfo[] {
  return site.sitemaps.filter((s) => s.found);
}

function perUrl(site: SiteContext, checkId: string, test: (loc: string) => string | null): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  for (const { loc, sitemap } of locs(site)) {
    if (seen.has(loc)) continue;
    seen.add(loc);
    const reason = test(loc);
    if (!reason) continue;
    out.push({ checkId, url: loc, message: reason, evidence: `in ${sitemap}` });
    if (out.length >= REPORT_LIMIT) break;
  }
  return out;
}

export const checks = [
  siteCheck(
    {
      id: 'sitemaps.missing',
      category: 'sitemaps',
      pillar: T,
      title: 'No XML sitemap found',
      why: 'A sitemap lists every page you want indexed with its last change date. It is how search engines and AI crawlers find new and deep pages quickly.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Generate an XML sitemap of indexable, canonical URLs (most CMSs and frameworks can), publish it at /sitemap.xml and list it in robots.txt.',
      refs: [REF.sitemaps],
    },
    (site) =>
      found(site).length
        ? null
        : { checkId: 'sitemaps.missing', message: 'No sitemap at /sitemap.xml or in robots.txt' },
  ),
  siteCheck(
    {
      id: 'sitemaps.not-in-robots',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap not declared in robots.txt',
      why: 'Crawlers that do not use webmaster tools (Bing without an account, AI crawlers) find sitemaps through the robots.txt Sitemap line.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add "Sitemap: <full sitemap URL>" to robots.txt.',
      refs: [REF.sitemaps],
    },
    (site) => {
      const f = found(site).filter((s) => s.source !== 'child');
      if (!f.length || site.robots.sitemaps.length) return null;
      return {
        checkId: 'sitemaps.not-in-robots',
        message: `Found ${list(f.map((s) => s.url))} but robots.txt does not list it`,
      };
    },
  ),
  siteCheck(
    {
      id: 'sitemaps.unreachable',
      category: 'sitemaps',
      pillar: T,
      title: 'Declared sitemap cannot be fetched',
      why: 'A sitemap listed in robots.txt (or a sitemap index) that returns an error gives crawlers nothing, and Search Console reports it as failed.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Fix the sitemap URL or the server error, or remove the stale reference.',
      refs: [REF.sitemaps],
    },
    (site) =>
      site.sitemaps
        .filter(
          (s) => (s.source === 'robots' || s.source === 'child' || s.source === 'user') && !s.found,
        )
        .map((s) => ({
          checkId: 'sitemaps.unreachable',
          message: `${s.url} returned ${s.status ?? 'no response'}`,
          evidence: s.url,
        })),
  ),
  siteCheck(
    {
      id: 'sitemaps.parse-errors',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap has XML or format errors',
      why: 'Malformed XML, wrong namespaces or invalid entries can make search engines reject part or all of the sitemap.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Fix the errors shown. Escape &, <, > in URLs, use the sitemaps.org namespace and UTF-8 encoding.',
      refs: [REF.sitemapsProtocol],
    },
    (site) =>
      site.sitemaps
        .filter((s) => s.errors.length)
        .map((s) => ({
          checkId: 'sitemaps.parse-errors',
          message: `${plural(s.errors.length, 'error')} in ${s.url}`,
          evidence: list(s.errors, 3),
        })),
  ),
  siteCheck(
    {
      id: 'sitemaps.empty',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap lists no URLs',
      why: 'An empty sitemap usually means a generator failed or is filtering out every page.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Check the sitemap generator settings and make sure published pages are included.',
      refs: [REF.sitemaps],
    },
    (site) =>
      found(site)
        .filter((s) => !s.isIndex && s.urls.length === 0 && !s.errors.length)
        .map((s) => ({ checkId: 'sitemaps.empty', message: `${s.url} contains no <url> entries` })),
  ),
  siteCheck(
    {
      id: 'sitemaps.too-large',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap exceeds the size limits',
      why: `A single sitemap may hold at most ${SITEMAP_MAX_URLS.toLocaleString('en-GB')} URLs and 50 MB uncompressed. Larger files are rejected.`,
      severity: 'high',
      fixTier: 'guided',
      fix: 'Split it into several sitemaps and list them in a sitemap index.',
      refs: [REF.sitemaps],
    },
    (site) =>
      found(site)
        .filter((s) => s.urls.length > SITEMAP_MAX_URLS || s.bytes > SITEMAP_MAX_BYTES)
        .map((s) => ({
          checkId: 'sitemaps.too-large',
          message: `${s.url}: ${s.urls.length.toLocaleString('en-GB')} URLs, ${(s.bytes / 1048576).toFixed(1)} MB`,
        })),
  ),
  siteCheck(
    {
      id: 'sitemaps.error-urls',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap lists URLs that return errors',
      why: 'Sitemaps should only list live pages. Error URLs waste crawl visits and make search engines trust the sitemap less.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Remove 4xx/5xx URLs from the sitemap (most generators do this automatically once the page is deleted or unpublished).',
      refs: [REF.sitemaps],
    },
    (site) =>
      perUrl(site, 'sitemaps.error-urls', (loc) => {
        const p = findPage(site, loc);
        if (!p || (p.status === 0 && p.blockedByRobots)) return null;
        return p.status >= 400 || p.status === 0
          ? `Listed in the sitemap but returns ${p.status || 'no response'}`
          : null;
      }),
  ),
  siteCheck(
    {
      id: 'sitemaps.redirect-urls',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap lists redirecting URLs',
      why: 'Sitemaps should list final URLs. Redirects in the sitemap send mixed signals about which URL is canonical.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Replace each redirecting URL with its destination.',
      refs: [REF.sitemaps],
    },
    (site) =>
      perUrl(site, 'sitemaps.redirect-urls', (loc) => {
        const p = findPage(site, loc);
        return p && wasRedirected(p) ? `Redirects to ${p.finalUrl}` : null;
      }),
  ),
  siteCheck(
    {
      id: 'sitemaps.noindex-urls',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap lists noindex pages',
      why: 'Listing a page in the sitemap says "index this", while noindex says the opposite. Search Console flags these as errors.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove noindex pages from the sitemap, or remove noindex if they should be indexed.',
      refs: [REF.sitemaps],
    },
    (site) =>
      perUrl(site, 'sitemaps.noindex-urls', (loc) => {
        const p = findPage(site, loc);
        return p && isHtml200(p) && isNoindex(p) ? 'Listed in the sitemap but noindex' : null;
      }),
  ),
  siteCheck(
    {
      id: 'sitemaps.canonicalised-urls',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap lists non-canonical URLs',
      why: 'Sitemaps act as a canonical hint. Listing URLs that canonicalise elsewhere contradicts your own canonical tags.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'List only the canonical version of each page.',
      refs: [REF.sitemaps, REF.canonical],
    },
    (site) =>
      perUrl(site, 'sitemaps.canonicalised-urls', (loc) => {
        const p = findPage(site, loc);
        return p && isHtml200(p) && isCanonicalisedAway(p)
          ? `Canonicalises to ${p.canonical || p.canonicalHeader}`
          : null;
      }),
  ),
  siteCheck(
    {
      id: 'sitemaps.blocked-urls',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap lists URLs blocked by robots.txt',
      why: 'Search engines cannot crawl these URLs, so listing them only produces "submitted URL blocked" errors.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove blocked URLs from the sitemap, or allow them in robots.txt.',
      refs: [REF.sitemaps, REF.robotsTxt],
    },
    (site) =>
      perUrl(site, 'sitemaps.blocked-urls', (loc) => {
        const p = findPage(site, loc);
        if (p)
          return p.blockedByRobots ? 'Listed in the sitemap but disallowed in robots.txt' : null;
        return site.robots.found && !site.robots.isAllowed(loc, 'Googlebot')
          ? 'Listed in the sitemap but disallowed in robots.txt'
          : null;
      }),
  ),
  siteCheck(
    {
      id: 'sitemaps.foreign-urls',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap lists URLs on another host or protocol',
      why: 'A sitemap may only list URLs on its own host and protocol (unless cross-submission is verified). Others are ignored.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Use the live protocol and host (for example https://www.) for every URL in the sitemap.',
      refs: [REF.sitemapsProtocol],
    },
    (site) => {
      const base = safeUrl(site.origin);
      if (!base) return null;
      const bad = new Set<string>();
      for (const { loc } of locs(site)) {
        const u = safeUrl(loc);
        if (!u || u.protocol !== base.protocol || u.hostname !== base.hostname) bad.add(loc);
      }
      return bad.size
        ? {
            checkId: 'sitemaps.foreign-urls',
            message: `${plural(bad.size, 'URL')} on a different host or protocol`,
            evidence: list([...bad], 3),
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'sitemaps.duplicate-urls',
      category: 'sitemaps',
      pillar: T,
      title: 'Same URL listed more than once',
      why: 'Duplicate entries add noise and often come from two generators writing the same sitemap.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'De-duplicate the sitemap entries.',
    },
    (site) => {
      const counts = new Map<string, number>();
      for (const { loc } of locs(site)) counts.set(loc, (counts.get(loc) ?? 0) + 1);
      const dups = [...counts].filter(([, n]) => n > 1).map(([u]) => u);
      return dups.length
        ? {
            checkId: 'sitemaps.duplicate-urls',
            message: `${plural(dups.length, 'URL')} listed more than once`,
            evidence: list(dups, 3),
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'sitemaps.indexable-missing',
      category: 'sitemaps',
      pillar: T,
      title: 'Indexable pages missing from the sitemap',
      why: 'Pages left out of the sitemap rely only on links to be found and do not get lastmod hints, so updates are picked up more slowly.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Include every indexable, canonical page in the sitemap. Check the generator’s post-type and taxonomy settings.',
      refs: [REF.sitemaps],
    },
    (site) => {
      if (!found(site).length) return null;
      const idx = indexablePages(site);
      const missing = idx.filter((p) => !p.inSitemap);
      if (!missing.length || missing.length / idx.length < MISSING_FROM_SITEMAP_MIN_SHARE)
        return null;
      return missing.slice(0, REPORT_LIMIT).map((p) => ({
        checkId: 'sitemaps.indexable-missing',
        url: p.url,
        message: 'Indexable page not in any sitemap',
      }));
    },
  ),
  siteCheck(
    {
      id: 'sitemaps.lastmod-invalid',
      category: 'sitemaps',
      pillar: T,
      title: 'Invalid lastmod dates',
      why: 'lastmod must be in W3C datetime format (2025-05-01 or 2025-05-01T09:00:00+00:00). Invalid values are ignored.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Output lastmod in W3C datetime format.',
      refs: [REF.sitemapsProtocol],
    },
    (site) => {
      const bad = locs(site).filter((u) => u.lastmod && !ISO_DATE.test(u.lastmod.trim()));
      return bad.length
        ? {
            checkId: 'sitemaps.lastmod-invalid',
            message: `${plural(bad.length, 'lastmod value')} not in W3C format`,
            evidence: list([...new Set(bad.map((b) => b.lastmod!))], 3),
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'sitemaps.lastmod-future',
      category: 'sitemaps',
      pillar: T,
      title: 'lastmod dates in the future',
      why: 'Future dates are clearly wrong, and Google says it ignores lastmod from sitemaps where the values are not consistently accurate.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Set lastmod to when the page content last changed meaningfully, with the correct timezone.',
      refs: ['https://developers.google.com/search/blog/2023/06/sitemaps-lastmod-ping'],
    },
    (site) => {
      const limit = Date.now() + 2 * 86_400_000;
      const bad = locs(site).filter((u) => u.lastmod && Date.parse(u.lastmod) > limit);
      return bad.length
        ? {
            checkId: 'sitemaps.lastmod-future',
            message: `${plural(bad.length, 'URL')} with lastmod in the future`,
            evidence: list(
              bad.map((b) => `${b.loc} (${b.lastmod})`),
              3,
            ),
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'sitemaps.lastmod-uniform',
      category: 'sitemaps',
      pillar: T,
      title: 'Every URL has the same lastmod',
      why: 'When all entries share one timestamp, the generator is stamping the build time rather than real changes. Search engines learn to ignore it.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use each page’s real last-modified date (from the CMS or file history) for lastmod.',
      refs: ['https://developers.google.com/search/blog/2023/06/sitemaps-lastmod-ping'],
    },
    (site) => {
      const lm = locs(site)
        .filter((u) => u.lastmod)
        .map((u) => u.lastmod!.slice(0, 16));
      if (lm.length < 20 || new Set(lm).size > 1) return null;
      return {
        checkId: 'sitemaps.lastmod-uniform',
        message: `All ${lm.length} URLs share lastmod ${lm[0]}`,
      };
    },
  ),
  siteCheck(
    {
      id: 'sitemaps.lastmod-missing',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap has no lastmod dates',
      why: 'Google and Bing use accurate lastmod values to decide what to recrawl. Without them, updated pages wait longer to be refreshed.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add a lastmod to each URL with the date its content last changed.',
      refs: [REF.sitemaps],
    },
    (site) => {
      const all = locs(site);
      if (all.length < 5 || all.some((u) => u.lastmod)) return null;
      return {
        checkId: 'sitemaps.lastmod-missing',
        message: `None of ${all.length} sitemap URLs have lastmod`,
      };
    },
  ),
  siteCheck(
    {
      id: 'sitemaps.stale',
      category: 'sitemaps',
      pillar: T,
      title: 'Sitemap has not changed in over a year',
      why: 'If the newest lastmod is more than a year old while the site has been updated, the sitemap is probably not being regenerated.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Regenerate the sitemap automatically on publish, or on a schedule.',
    },
    (site) => {
      const dates = locs(site)
        .map((u) => Date.parse(u.lastmod || ''))
        .filter((d) => !Number.isNaN(d));
      if (dates.length < 5) return null;
      const newest = Math.max(...dates);
      if (Date.now() - newest < STALE_SITEMAP_DAYS * 86_400_000) return null;
      return {
        checkId: 'sitemaps.stale',
        message: `Newest lastmod is ${new Date(newest).toISOString().slice(0, 10)}`,
      };
    },
  ),
];
