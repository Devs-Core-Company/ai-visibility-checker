/**
 * Crawlability and indexability: robots meta and headers, robots.txt health,
 * crawl depth, crawl waste, and Search Console–backed index checks.
 */
import type { Issue, PageData, SiteContext } from '../core/types.js';
import {
  CURRENT_YEAR,
  REF,
  declaredCanonical,
  findPage,
  homePage,
  htmlPages,
  indexablePages,
  inlinkCount,
  isCanonicalisedAway,
  isHomepage,
  isHtml200,
  isIndexable,
  isNoindex,
  list,
  pageCheck,
  pathOf,
  plural,
  rawBody,
  rawHead,
  robotsDirectives,
  safeUrl,
  sameUrl,
  siteCheck,
  truncate,
  urlKey,
  xRobotsDirectives,
} from './_util.js';

export const DEEP_PAGE_DEPTH = 4;
export const VERY_DEEP_PAGE_DEPTH = 7;
export const ROBOTS_MAX_BYTES = 500 * 1024; // Google reads the first 500 KiB
export const CRAWL_DELAY_HIGH = 10; // seconds
export const PARAM_WASTE_SHARE = 0.3;
export const PARAM_WASTE_MIN = 20;
export const LOW_INDEXABLE_SHARE = 0.5;
export const NOINDEX_LINKED_MIN_INLINKS = 10;
export const GSC_LOW_CTR_MIN_IMPRESSIONS = 500;
export const GSC_STRIKING_MIN_IMPRESSIONS = 200;
export const GSC_STALE_CRAWL_DAYS = 90;
/** Rough organic CTR floor by average position; well below these is worth a look. */
export const CTR_FLOOR_BY_POSITION: [maxPos: number, minCtr: number][] = [
  [1.5, 0.12],
  [3, 0.06],
  [5, 0.03],
  [10, 0.012],
];

const T = 'technical' as const;

/** Elements that are not allowed in <head>; the parser closes <head> when it meets one. */
const INVALID_HEAD_TAG =
  /<(?:img|div|span|p|iframe|a|section|header|footer|nav|h[1-6]|ul|ol|table|form|input|button|br|hr|video|audio|picture|svg)\b/i;

function directiveValue(dirs: Set<string>, name: string): string | null {
  for (const d of dirs) if (d.startsWith(name + ':')) return d.slice(name.length + 1).trim();
  return null;
}

function gscPage(site: SiteContext, url: string) {
  return site.external.gsc?.pages.find((p) => sameUrl(p.url, url));
}

function expectedCtr(position: number): number {
  for (const [max, ctr] of CTR_FLOOR_BY_POSITION) if (position <= max) return ctr;
  return 0;
}

export const checks = [
  // -------------------------------------------------------------------------
  // Robots meta / headers (page)
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'crawlability.noindex',
      category: 'crawlability',
      pillar: T,
      title: 'Page is set to noindex',
      why: 'A noindex directive removes the page from Google and Bing results, and AI search engines that rely on those indexes will not cite it. Fine on purpose, costly by accident.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Confirm the page should stay out of search. If it should be found, remove "noindex" from the robots meta tag (or the X-Robots-Tag header).',
      refs: [REF.robotsMeta],
      tags: ['indexing'],
    },
    (page, site) => {
      if (!isHtml200(page) || !isNoindex(page) || isHomepage(page, site)) return null;
      const linked = inlinkCount(site, page.url);
      const important = page.inSitemap || linked >= NOINDEX_LINKED_MIN_INLINKS;
      return {
        checkId: 'crawlability.noindex',
        severity: important ? 'high' : 'low',
        message: important
          ? `Page is noindex but ${page.inSitemap ? 'is listed in the sitemap' : `has ${linked} internal links`}, so it looks important`
          : 'Page is set to noindex',
        evidence: truncate(
          [
            page.metaRobots && `meta robots: ${page.metaRobots}`,
            page.xRobotsTag && `X-Robots-Tag: ${page.xRobotsTag}`,
          ]
            .filter(Boolean)
            .join(' | '),
        ),
      };
    },
  ),
  pageCheck(
    {
      id: 'crawlability.noindex-header',
      category: 'crawlability',
      pillar: T,
      title: 'Noindex sent in the X-Robots-Tag header',
      why: 'A noindex in an HTTP header is invisible in the page source, so it often survives from staging or a CDN rule without anyone noticing.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Find the server, CDN or framework rule that adds "X-Robots-Tag: noindex" and limit it to the URLs that really should be hidden.',
      refs: [REF.robotsMeta],
      tags: ['indexing'],
    },
    (page) => {
      if (!isHtml200(page) || !page.xRobotsTag) return null;
      const d = xRobotsDirectives(page.xRobotsTag).map((x) => x.toLowerCase());
      if (!d.some((x) => x === 'noindex' || x === 'none')) return null;
      return {
        checkId: 'crawlability.noindex-header',
        message: 'The X-Robots-Tag response header tells search engines not to index this page',
        evidence: `X-Robots-Tag: ${truncate(page.xRobotsTag)}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'crawlability.robots-conflict',
      category: 'crawlability',
      pillar: T,
      title: 'Conflicting robots directives',
      why: 'When the meta tag, the googlebot tag and the header disagree, Google applies the most restrictive rule, which is rarely what the person who added "index" intended.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Set one clear directive per page. Remove the contradicting value from the meta robots tag, the googlebot meta tag or the X-Robots-Tag header.',
      refs: [REF.robotsMeta],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const sources: [string, string | null | undefined][] = [
        ['meta robots', page.metaRobots],
        ['meta googlebot', page.botMeta?.googlebot],
        ['X-Robots-Tag', xRobotsDirectives(page.xRobotsTag).join(', ') || null],
      ];
      const says = sources
        .filter(([, v]) => v)
        .map(([name, v]) => {
          const parts = String(v)
            .toLowerCase()
            .split(',')
            .map((s) => s.trim());
          const noindex = parts.includes('noindex') || parts.includes('none');
          const index = parts.includes('index') || parts.includes('all');
          return { name, v: String(v), noindex, index };
        });
      const selfConflict = says.find((s) => s.noindex && s.index);
      const crossConflict = says.some((s) => s.noindex) && says.some((s) => s.index && !s.noindex);
      if (!selfConflict && !crossConflict) return null;
      return {
        checkId: 'crawlability.robots-conflict',
        message: selfConflict
          ? `The ${selfConflict.name} value contains both index and noindex`
          : 'One source says index and another says noindex',
        evidence: truncate(says.map((s) => `${s.name}: ${s.v}`).join(' | ')),
      };
    },
  ),
  pageCheck(
    {
      id: 'crawlability.noindex-canonical',
      category: 'crawlability',
      pillar: T,
      title: 'Noindex combined with a canonical to another URL',
      why: 'A canonical says "index that other URL instead" while noindex says "drop this". Google warns that mixing them sends conflicting signals and the noindex can be passed to the target.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Pick one: keep the canonical and remove noindex when the page is a duplicate, or keep noindex and make the canonical self-referencing (or remove it).',
      refs: [REF.canonical],
    },
    (page) => {
      if (!isHtml200(page) || !isNoindex(page) || !isCanonicalisedAway(page)) return null;
      return {
        checkId: 'crawlability.noindex-canonical',
        message: 'Page is noindex and also canonicalises to a different URL',
        evidence: `canonical: ${declaredCanonical(page)}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'crawlability.nofollow-page',
      category: 'crawlability',
      pillar: T,
      title: 'Indexable page tells crawlers not to follow its links',
      why: 'A page-level nofollow stops crawlers discovering and passing value through every link on the page, which starves the pages it links to.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove "nofollow" from the robots meta tag. If only some links should not be followed, use rel="nofollow" on those links instead.',
      refs: [REF.robotsMeta, REF.qualifyLinks],
    },
    (page) => {
      if (!isHtml200(page) || isNoindex(page)) return null;
      if (!robotsDirectives(page).has('nofollow')) return null;
      return {
        checkId: 'crawlability.nofollow-page',
        message: 'Page is indexable but nofollow, so none of its links are followed',
        evidence: truncate(page.metaRobots || page.xRobotsTag || ''),
      };
    },
  ),
  pageCheck(
    {
      id: 'crawlability.snippet-restricted',
      category: 'crawlability',
      pillar: T,
      title: 'Snippets restricted by nosnippet or max-snippet',
      why: 'nosnippet and a small max-snippet limit what Google can show in results and stop the text being used in AI Overviews and AI Mode, which cuts the chance of being quoted.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove nosnippet, or raise max-snippet (use -1 for no limit) unless there is a legal reason to restrict snippets. Use data-nosnippet on specific passages instead.',
      refs: [REF.robotsMeta, REF.snippets],
      tags: ['aeo'],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const d = robotsDirectives(page);
      const ms = directiveValue(d, 'max-snippet');
      const msNum = ms == null ? null : Number(ms);
      if (d.has('nosnippet'))
        return {
          checkId: 'crawlability.snippet-restricted',
          message: 'Page sets nosnippet: no text snippet and no AI Overview use',
          evidence: 'nosnippet',
        };
      if (msNum != null && msNum >= 0 && msNum < 50)
        return {
          checkId: 'crawlability.snippet-restricted',
          message: `max-snippet is ${msNum} characters, which leaves almost nothing to quote`,
          evidence: `max-snippet:${ms}`,
        };
      return null;
    },
  ),
  pageCheck(
    {
      id: 'crawlability.image-preview-restricted',
      category: 'crawlability',
      pillar: T,
      title: 'Large image previews not allowed',
      why: 'Without max-image-preview:large, Google may show only a small thumbnail, which reduces visibility in Discover and image-rich results.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add "max-image-preview:large" to the robots meta tag on pages you want shown with a large image.',
      refs: [REF.robotsMeta],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const v = directiveValue(robotsDirectives(page), 'max-image-preview');
      if (v !== 'none' && v !== 'standard') return null;
      return {
        checkId: 'crawlability.image-preview-restricted',
        message: `max-image-preview is "${v}"`,
        evidence: `max-image-preview:${v}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'crawlability.unavailable-after-past',
      category: 'crawlability',
      pillar: T,
      title: 'unavailable_after date has passed',
      why: 'After the unavailable_after date Google drops the page from results, which is easy to forget once the date is set.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Remove the unavailable_after directive, or update the date if the page is meant to expire later.',
      refs: [REF.robotsMeta],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const v = directiveValue(robotsDirectives(page), 'unavailable_after');
      if (!v) return null;
      const t = Date.parse(v);
      if (Number.isNaN(t) || t > Date.now()) return null;
      return {
        checkId: 'crawlability.unavailable-after-past',
        message: `unavailable_after was ${v}; search engines may already have removed the page`,
        evidence: `unavailable_after: ${v}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'crawlability.head-broken',
      category: 'crawlability',
      pillar: T,
      title: 'Invalid element in <head> hides later SEO tags',
      why: 'When a body element such as <img>, <div> or <iframe> appears in <head>, parsers end the head there. Any canonical, robots or hreflang tags after it are then ignored by Google.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Move the stray element into <body> (often an injected tracking pixel or noscript fallback), or move the SEO tags above it.',
      refs: ['https://developers.google.com/search/docs/crawling-indexing/valid-page-metadata'],
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const head = rawHead(page.html).replace(
        /<noscript[\s\S]*?<\/noscript>/gi,
        (m) =>
          // An <img> inside <noscript> in <head> is just as harmful for parsers that do not run JS.
          m,
      );
      const m = INVALID_HEAD_TAG.exec(
        head.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ''),
      );
      if (!m) return null;
      const stripped = head.replace(
        /<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi,
        '',
      );
      const after = stripped.slice(m.index);
      const important =
        /<link[^>]+rel=["']?(canonical|alternate)|<meta[^>]+name=["']?(robots|googlebot|description)|<title/i.exec(
          after,
        );
      if (!important) return null;
      return {
        checkId: 'crawlability.head-broken',
        message: `A <${m[0].slice(1)}> element in <head> appears before "${important[0].slice(0, 40)}…", so that tag may be ignored`,
        evidence: truncate(after.slice(0, 200)),
      };
    },
  ),
  pageCheck(
    {
      id: 'crawlability.robots-meta-in-body',
      category: 'crawlability',
      pillar: T,
      title: 'Robots meta tag placed in <body>',
      why: 'Robots meta tags belong in <head>. Some crawlers ignore them in the body, so the directive may not be applied consistently.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Move the <meta name="robots"> tag into the <head> of the page template.',
      refs: [REF.robotsMeta],
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const body = rawBody(page.html);
      const m = /<meta[^>]+name=["']?(robots|googlebot)["']?[^>]*>/i.exec(body);
      if (!m) return null;
      return {
        checkId: 'crawlability.robots-meta-in-body',
        message: 'A robots meta tag sits outside <head>',
        evidence: truncate(m[0]),
      };
    },
  ),
  pageCheck(
    {
      id: 'crawlability.blocked-but-linked',
      category: 'crawlability',
      pillar: T,
      title: 'Internally linked URL is blocked by robots.txt',
      why: 'Blocked URLs cannot be crawled, yet internal links keep sending crawlers and link value to them. Google may still index the bare URL without its content.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Either allow the URL in robots.txt (and use noindex if it should stay out of results) or stop linking to it internally.',
      refs: [REF.robotsTxt],
    },
    (page, site) => {
      if (!page.blockedByRobots) return null;
      const n = inlinkCount(site, page.url);
      if (n === 0) return null;
      return {
        checkId: 'crawlability.blocked-but-linked',
        message: `Blocked by robots.txt but linked from ${plural(n, 'internal page')}`,
        evidence: site.robots.decidingLine(page.url, 'Googlebot')?.rule,
      };
    },
  ),
  pageCheck(
    {
      id: 'crawlability.deep-page',
      category: 'crawlability',
      pillar: T,
      title: 'Page is many clicks from the home page',
      why: 'Pages buried deep in the click path are crawled less often and look less important to search engines and AI crawlers.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Link to the page from a hub, category or the main navigation so it is within three or four clicks of the home page.',
      refs: [REF.links],
    },
    (page) => {
      if (!isIndexable(page) || page.depth <= DEEP_PAGE_DEPTH) return null;
      return {
        checkId: 'crawlability.deep-page',
        severity: page.depth > VERY_DEEP_PAGE_DEPTH ? 'medium' : 'low',
        message: `Page is ${page.depth} clicks from the start page (aim for ${DEEP_PAGE_DEPTH} or fewer)`,
        data: { depth: page.depth },
      };
    },
  ),

  // -------------------------------------------------------------------------
  // Site-level indexability
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'crawlability.homepage-noindex',
      category: 'crawlability',
      pillar: T,
      title: 'Home page is set to noindex',
      why: 'A noindex home page usually means a staging setting reached production. The whole brand loses its main entry point in search and AI answers.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'Remove noindex from the home page (meta robots and X-Robots-Tag). Check the CMS "discourage search engines" setting.',
      refs: [REF.robotsMeta],
    },
    (site) => {
      const home = homePage(site);
      if (!home || !isHtml200(home) || !isNoindex(home)) return null;
      return {
        checkId: 'crawlability.homepage-noindex',
        url: home.url,
        message: 'The home page tells search engines not to index it',
        evidence: truncate(home.metaRobots || home.xRobotsTag || ''),
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.noindex-linked',
      category: 'crawlability',
      pillar: T,
      title: 'Noindex pages receive many internal links',
      why: 'Linking heavily to pages you keep out of search spends crawl effort and link value on them instead of on pages that can rank.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Point navigation and in-content links at indexable pages. Keep links to noindex pages (login, cart, filters) to where users need them.',
      refs: [REF.links],
    },
    (site) => {
      const out: Issue[] = [];
      for (const p of site.pages.values()) {
        if (!isHtml200(p) || !isNoindex(p) || isHomepage(p, site)) continue;
        const n = inlinkCount(site, p.url);
        if (n >= NOINDEX_LINKED_MIN_INLINKS)
          out.push({
            checkId: 'crawlability.noindex-linked',
            url: p.url,
            message: `Noindex page has ${n} internal inlinks`,
            data: { inlinks: n },
          });
      }
      return out;
    },
  ),
  siteCheck(
    {
      id: 'crawlability.crawl-incomplete',
      category: 'crawlability',
      pillar: T,
      title: 'Crawl stopped at the page limit',
      why: 'The audit only covers the pages it reached. Site-wide findings such as orphans, duplicates and sitemap gaps may be incomplete.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Raise the page limit (--max-pages) or crawl sections separately with include patterns.',
    },
    (site) => {
      const s = site.stats;
      if (!s || s.pagesQueuedNotCrawled <= 0) return null;
      return {
        checkId: 'crawlability.crawl-incomplete',
        message: `${s.pagesQueuedNotCrawled} discovered URLs were not crawled (limit ${s.maxPages} pages)`,
        data: { notCrawled: s.pagesQueuedNotCrawled, maxPages: s.maxPages },
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.single-page-found',
      category: 'crawlability',
      pillar: T,
      title: 'Crawler could not find links beyond the start page',
      why: 'If a crawler following plain HTML links reaches only one page, search and AI crawlers that do not run JavaScript cannot discover the rest of the site either.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Render navigation as real <a href="…"> links in the server HTML. Avoid links that only exist after JavaScript runs or use onclick handlers.',
      refs: [REF.links, REF.js],
    },
    (site) => {
      const html = htmlPages(site);
      const home = homePage(site);
      if (html.length !== 1 || !home || !isHtml200(home)) return null;
      const internal = home.links.filter((l) => l.internal && !sameUrl(l.href, home.url)).length;
      if (internal > 0 && site.pages.size > 1) return null;
      return {
        checkId: 'crawlability.single-page-found',
        url: home.url,
        message: `Only the start page was crawlable; it has ${plural(internal, 'internal link')} in its HTML`,
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.parameter-waste',
      category: 'crawlability',
      pillar: T,
      title: 'Many indexable URLs with query parameters',
      why: 'Filters, sorts and session parameters can multiply one page into hundreds of crawlable URLs. Crawlers waste their visits on them and the duplicates dilute signals.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Canonicalise parameter URLs to the clean URL, stop linking to sort/filter variants with plain links, and block pure-filter parameters in robots.txt where appropriate.',
      refs: [
        'https://developers.google.com/search/docs/crawling-indexing/crawling-managing-faceted-navigation',
      ],
    },
    (site) => {
      const idx = indexablePages(site);
      const withParams = idx.filter((p) => !!safeUrl(p.url)?.search);
      if (withParams.length < PARAM_WASTE_MIN || withParams.length / idx.length < PARAM_WASTE_SHARE)
        return null;
      const keys = new Map<string, number>();
      for (const p of withParams)
        for (const k of safeUrl(p.url)!.searchParams.keys()) keys.set(k, (keys.get(k) ?? 0) + 1);
      const top = [...keys.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`);
      return {
        checkId: 'crawlability.parameter-waste',
        message: `${withParams.length} of ${idx.length} indexable pages have query parameters`,
        evidence: `Most common parameters: ${list(top)}`,
        data: { count: withParams.length },
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.low-indexable-share',
      category: 'crawlability',
      pillar: T,
      title: 'Most crawled pages are not indexable',
      why: 'When most internal links lead to redirects, errors, noindex or canonicalised pages, crawlers spend their time on URLs that can never rank.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Review the non-indexable URLs in the report and update internal links so they point straight at indexable, canonical pages.',
    },
    (site) => {
      const all = [...site.pages.values()].filter((p) => p.isHtml || p.redirects.length > 0);
      if (all.length < 20) return null;
      const idx = all.filter(isIndexable).length;
      if (idx / all.length >= LOW_INDEXABLE_SHARE) return null;
      return {
        checkId: 'crawlability.low-indexable-share',
        message: `Only ${idx} of ${all.length} crawled HTML URLs (${Math.round((100 * idx) / all.length)}%) are indexable`,
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.staging-indexable',
      category: 'crawlability',
      pillar: T,
      title: 'Staging or development host is indexable',
      why: 'An indexable staging copy competes with the live site as a duplicate and can leak unfinished pages into search and AI answers.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Protect staging with a password (best) or send "X-Robots-Tag: noindex" on every staging response.',
      refs: ['https://developers.google.com/search/docs/crawling-indexing/control-what-you-share'],
    },
    (site) => {
      const h = site.host.toLowerCase();
      if (
        !/(^|\.)(staging|stage|dev|test|qa|uat|preview|beta)[.-]/.test(h) &&
        !/\.(vercel\.app|netlify\.app|pages\.dev|herokuapp\.com|wpengine\.com|wpenginepowered\.com|kinsta\.cloud)$/.test(
          h,
        )
      )
        return null;
      const home = homePage(site);
      if (!home || !isIndexable(home)) return null;
      return {
        checkId: 'crawlability.staging-indexable',
        url: home.url,
        message: `${site.host} looks like a staging or preview host and is indexable`,
      };
    },
  ),

  // -------------------------------------------------------------------------
  // robots.txt (site)
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'crawlability.robots-txt-missing',
      category: 'crawlability',
      pillar: T,
      title: 'No robots.txt file',
      why: 'Without robots.txt everything may be crawled, which is fine, but you lose the place to declare sitemaps and to steer crawlers away from low-value URLs.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add /robots.txt with at least "User-agent: *", an empty "Disallow:" (or the paths you want kept out) and a "Sitemap:" line.',
      refs: [REF.robotsTxt],
    },
    (site) => {
      const r = site.robots;
      if (r.found || r.status == null || r.status === 0 || r.status >= 500) return null;
      if (r.status >= 400 && r.status < 500)
        return {
          checkId: 'crawlability.robots-txt-missing',
          message: `robots.txt returns ${r.status}`,
          evidence: r.url,
        };
      return null;
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-txt-server-error',
      category: 'crawlability',
      pillar: T,
      title: 'robots.txt returns a server error',
      why: 'Google treats a 5xx robots.txt as "do not crawl anything" for a while and may then reduce crawling of the whole site.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'Make /robots.txt return 200 (or 404 if you do not need one). Check the server, CDN and firewall rules for that path.',
      refs: [
        REF.robotsTxt,
        'https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt#http-status-codes',
      ],
    },
    (site) => {
      const r = site.robots;
      if (r.status == null || r.status < 500) return null;
      return {
        checkId: 'crawlability.robots-txt-server-error',
        message: `robots.txt returns HTTP ${r.status}`,
        evidence: r.url,
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-txt-unreachable',
      category: 'crawlability',
      pillar: T,
      title: 'robots.txt could not be fetched',
      why: 'A timeout or connection error on robots.txt is treated like a server error: crawlers may pause crawling the site.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Check DNS, TLS and firewall rules for /robots.txt and make sure it responds quickly to all user agents.',
      refs: [REF.robotsTxt],
    },
    (site) => {
      const r = site.robots;
      if (r.found || (r.status !== 0 && !r.error) || (r.status ?? 0) >= 400) return null;
      return {
        checkId: 'crawlability.robots-txt-unreachable',
        message: `robots.txt request failed${r.error ? `: ${r.error}` : ''}`,
        evidence: r.url,
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-blocks-all',
      category: 'crawlability',
      pillar: T,
      title: 'robots.txt blocks the whole site',
      why: '"Disallow: /" for all crawlers or for Googlebot stops the site being crawled. Pages drop out of search and AI engines over time.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'Remove "Disallow: /" from the group that applies to "*" or Googlebot, unless the site is meant to be private.',
      refs: [REF.robotsTxt],
    },
    (site) => {
      const r = site.robots;
      if (!r.found) return null;
      const probe = site.origin + '/';
      const blocked = ['Googlebot', 'Bingbot', '*'].filter((ua) => !r.isAllowed(probe, ua));
      if (!blocked.length) return null;
      const line = r.decidingLine(probe, blocked[0]);
      if (!line || !/^disallow\s*:\s*\/\s*$/i.test(line.rule.trim())) return null;
      return {
        checkId: 'crawlability.robots-blocks-all',
        message: `robots.txt disallows the entire site for ${list(blocked)}`,
        evidence: `line ${line.line}: ${line.rule}`,
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-blocks-home',
      category: 'crawlability',
      pillar: T,
      title: 'Home page blocked by robots.txt',
      why: 'If Googlebot cannot fetch the home page, the most linked page on the site cannot be crawled and its content cannot be shown or cited.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'Adjust the robots.txt rule shown so it no longer matches "/". Use the "$" anchor for exact-path rules.',
      refs: [REF.robotsTxt],
    },
    (site) => {
      const r = site.robots;
      const home = homePage(site);
      if (!r.found || !home) return null;
      if (r.isAllowed(home.url, 'Googlebot')) return null;
      const line = r.decidingLine(home.url, 'Googlebot');
      if (line && /^disallow\s*:\s*\/\s*$/i.test(line.rule.trim())) return null; // reported as blocks-all
      return {
        checkId: 'crawlability.robots-blocks-home',
        url: home.url,
        message: 'Googlebot is not allowed to fetch the home page',
        evidence: line ? `line ${line.line}: ${line.rule}` : undefined,
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-blocks-resources',
      category: 'crawlability',
      pillar: T,
      title: 'robots.txt blocks CSS or JavaScript',
      why: 'Google renders pages like a browser. If it cannot load the CSS and scripts, it may misjudge layout, mobile-friendliness and content added by JavaScript.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Allow the blocked asset paths (for example "Allow: /*.css$" and "Allow: /*.js$", or remove the Disallow for the asset folder).',
      refs: [REF.robotsTxt, REF.js],
    },
    (site) => {
      const r = site.robots;
      if (!r.found) return null;
      const assets = new Set<string>();
      for (const p of htmlPages(site).slice(0, 50)) {
        for (const s of p.scripts) if (s.src) assets.add(s.src);
        for (const s of p.stylesheets) assets.add(s.href);
      }
      const blocked = [...assets].filter((a) => {
        const u = safeUrl(a);
        return u && u.origin === site.origin && !r.isAllowed(a, 'Googlebot');
      });
      if (!blocked.length) return null;
      return {
        checkId: 'crawlability.robots-blocks-resources',
        message: `${plural(blocked.length, 'CSS/JS file')} on this site ${blocked.length === 1 ? 'is' : 'are'} blocked for Googlebot`,
        evidence: list(
          blocked.map((b) => pathOf(b)),
          4,
        ),
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-blocks-linked-pages',
      category: 'crawlability',
      pillar: T,
      title: 'robots.txt blocks pages linked from the home page',
      why: 'Pages linked from the home page are usually the ones you most want found. A broad Disallow rule often catches them by accident.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Narrow the Disallow rules so they do not match these URLs, or remove the links if the pages are meant to be private.',
      refs: [REF.robotsTxt],
    },
    (site) => {
      const r = site.robots;
      const home = homePage(site);
      if (!r.found || !home) return null;
      const targets = [...new Set(home.links.filter((l) => l.internal).map((l) => l.href))];
      const blocked = targets.filter((u) => !r.isAllowed(u, 'Googlebot'));
      if (!blocked.length || blocked.length === targets.length) return null; // all blocked = blocks-all/home
      return {
        checkId: 'crawlability.robots-blocks-linked-pages',
        message: `${plural(blocked.length, 'URL')} linked from the home page ${blocked.length === 1 ? 'is' : 'are'} disallowed`,
        evidence: list(blocked.map((b) => pathOf(b) + (safeUrl(b)?.search ?? ''))),
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-no-sitemap',
      category: 'crawlability',
      pillar: T,
      title: 'robots.txt does not list a sitemap',
      why: 'The Sitemap line in robots.txt is how Bing, Google and many AI crawlers find your sitemap without a webmaster account.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add a line such as "Sitemap: https://example.com/sitemap.xml" (absolute URL) to robots.txt.',
      refs: [REF.sitemaps],
    },
    (site) => {
      if (!site.robots.found || site.robots.sitemaps.length) return null;
      return {
        checkId: 'crawlability.robots-no-sitemap',
        message: 'No "Sitemap:" line in robots.txt',
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-sitemap-invalid',
      category: 'crawlability',
      pillar: T,
      title: 'Sitemap line in robots.txt is not an absolute URL',
      why: 'The Sitemap directive must be a full URL. Relative paths are ignored by Google and Bing.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Write the full URL, including https:// and the host, after "Sitemap:".',
      refs: [REF.sitemaps],
    },
    (site) => {
      if (!site.robots.found) return null;
      const bad = site.robots.body
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*$/, '').trim())
        .filter((l) => /^sitemap\s*:/i.test(l))
        .map((l) => l.replace(/^sitemap\s*:\s*/i, ''))
        .filter((v) => !/^https?:\/\//i.test(v));
      if (!bad.length) return null;
      return {
        checkId: 'crawlability.robots-sitemap-invalid',
        message: `${plural(bad.length, 'Sitemap line')} without an absolute URL`,
        evidence: list(bad),
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-crawl-delay',
      category: 'crawlability',
      pillar: T,
      title: 'High Crawl-delay in robots.txt',
      why: 'Google ignores Crawl-delay, but Bing and several AI crawlers honour it. A long delay means new and updated pages are picked up slowly.',
      severity: 'low',
      fixTier: 'guided',
      fix: `Lower or remove Crawl-delay. If the server struggles, fix capacity or caching rather than throttling crawlers (keep it under ${CRAWL_DELAY_HIGH} seconds if you must keep it).`,
      refs: [
        'https://blogs.bing.com/webmaster/2012/05/03/to-crawl-or-not-to-crawl-that-is-bingbots-question',
      ],
    },
    (site) => {
      if (!site.robots.found) return null;
      const delays = [...site.robots.body.matchAll(/^\s*crawl-delay\s*:\s*([\d.]+)/gim)].map((m) =>
        Number(m[1]),
      );
      const max = Math.max(0, ...delays);
      if (max < CRAWL_DELAY_HIGH) return null;
      return {
        checkId: 'crawlability.robots-crawl-delay',
        message: `Crawl-delay of ${max} seconds`,
        evidence: `Crawl-delay: ${max}`,
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-unsupported-rules',
      category: 'crawlability',
      pillar: T,
      title: 'robots.txt uses rules Google does not support',
      why: 'Noindex, Nofollow and Host lines in robots.txt are ignored by Google (noindex support ended in 2019), so pages you think are hidden may still be indexed.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove these lines and use a robots meta tag or X-Robots-Tag header for noindex, and redirects or canonicals instead of Host.',
      refs: [
        'https://developers.google.com/search/blog/2019/07/a-note-on-unsupported-rules-in-robotstxt',
      ],
    },
    (site) => {
      if (!site.robots.found) return null;
      const bad = site.robots.body
        .split(/\r?\n/)
        .map((l, i) => ({ l: l.replace(/#.*$/, '').trim(), i: i + 1 }))
        .filter(({ l }) => /^(noindex|nofollow|host)\s*:/i.test(l));
      if (!bad.length) return null;
      return {
        checkId: 'crawlability.robots-unsupported-rules',
        message: `${plural(bad.length, 'unsupported rule')} in robots.txt`,
        evidence: bad
          .slice(0, 5)
          .map(({ l, i }) => `line ${i}: ${l}`)
          .join(' | '),
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-syntax',
      category: 'crawlability',
      pillar: T,
      title: 'robots.txt has lines crawlers cannot parse',
      why: 'Typos such as "Dissallow" or a rule without a colon are skipped silently, so the rule you meant to apply does nothing.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Correct the lines shown. Each rule must be "Field: value" using User-agent, Allow, Disallow, Sitemap or Crawl-delay.',
      refs: [REF.robotsTxt],
    },
    (site) => {
      if (!site.robots.found) return null;
      const known =
        /^(user-agent|allow|disallow|sitemap|crawl-delay|noindex|nofollow|host|clean-param|request-rate|visit-time|content-signal|content-usage)$/i;
      const bad: string[] = [];
      site.robots.body.split(/\r?\n/).forEach((raw, i) => {
        const l = raw.replace(/#.*$/, '').trim();
        if (!l) return;
        const m = /^([A-Za-z-]+)\s*:/.exec(l);
        if (!m || !known.test(m[1])) bad.push(`line ${i + 1}: ${truncate(l, 60)}`);
        else if (/^(allow|disallow)$/i.test(m[1])) {
          const v = l.slice(l.indexOf(':') + 1).trim();
          if (v && !v.startsWith('/') && !v.startsWith('*'))
            bad.push(`line ${i + 1}: path should start with / (${truncate(l, 60)})`);
        }
      });
      if (!bad.length) return null;
      return {
        checkId: 'crawlability.robots-syntax',
        message: `${plural(bad.length, 'line')} in robots.txt may be ignored`,
        evidence: bad.slice(0, 5).join(' | '),
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-too-large',
      category: 'crawlability',
      pillar: T,
      title: 'robots.txt is larger than 500 KiB',
      why: 'Google stops reading robots.txt after 500 KiB. Rules after that point are ignored.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Consolidate rules with wildcards and remove unused ones to bring the file well under 500 KiB.',
      refs: [REF.robotsTxt],
    },
    (site) => {
      const bytes = Buffer.byteLength(site.robots.body || '');
      if (!site.robots.found || bytes <= ROBOTS_MAX_BYTES) return null;
      return {
        checkId: 'crawlability.robots-too-large',
        message: `robots.txt is ${Math.round(bytes / 1024)} KiB`,
      };
    },
  ),
  siteCheck(
    {
      id: 'crawlability.robots-is-html',
      category: 'crawlability',
      pillar: T,
      title: 'robots.txt returns an HTML page',
      why: 'When /robots.txt serves an HTML page (often a 404 template with status 200), crawlers cannot read any rules or sitemap lines from it.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Serve a plain-text robots.txt file, or return a real 404 status when there is none.',
      refs: [REF.robotsTxt],
    },
    (site) => {
      const b = site.robots.body || '';
      if (!site.robots.found || !/<(!doctype html|html|head|body)[\s>]/i.test(b.slice(0, 2000)))
        return null;
      return {
        checkId: 'crawlability.robots-is-html',
        message: 'robots.txt body is HTML, not plain text',
        evidence: truncate(b.slice(0, 120)),
      };
    },
  ),

  // -------------------------------------------------------------------------
  // Google Search Console–backed checks
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'crawlability.gsc-impressions-not-crawled',
      category: 'crawlability',
      pillar: T,
      title: 'Pages earning impressions were not found by the crawl',
      why: 'Google shows these URLs in search, yet a crawl following your links did not reach them. They are probably orphaned, so they receive no internal link value and are easy to lose.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Link to these pages from relevant hubs or navigation, or redirect them if they are outdated.',
      requires: ['gsc'],
      refs: [REF.links],
    },
    (site) => {
      const gsc = site.external.gsc;
      if (!gsc) return null;
      if (site.stats?.pagesQueuedNotCrawled > 0) return null; // incomplete crawl: would be noise
      const out: Issue[] = [];
      for (const row of gsc.pages) {
        if (row.impressions < 10) continue;
        const u = safeUrl(row.url);
        if (!u || u.search || u.hash) continue;
        if (findPage(site, row.url)) continue;
        out.push({
          checkId: 'crawlability.gsc-impressions-not-crawled',
          url: row.url,
          message: `${row.impressions} impressions in Search Console, but not reachable through internal links`,
          data: { impressions: row.impressions, clicks: row.clicks },
        });
      }
      return out.slice(0, 200);
    },
  ),
  siteCheck(
    {
      id: 'crawlability.gsc-not-indexed',
      category: 'crawlability',
      pillar: T,
      title: 'Google reports the page is not indexed',
      why: 'URL Inspection says Google has not indexed this page, so it cannot appear in Search, AI Overviews or AI Mode.',
      severity: 'high',
      fixTier: 'manual',
      fix: 'Open the page in Search Console URL Inspection to see the reason. Fix blocking issues, improve the content, link to it internally and request indexing.',
      requires: ['gsc'],
      refs: [REF.gscInspect, REF.gscIndexing],
    },
    (site) => {
      const ins = site.external.gsc?.inspections ?? [];
      const out: Issue[] = [];
      for (const i of ins) {
        const state = (i.coverageState || '').toLowerCase();
        if (/currently not indexed/.test(state)) continue; // dedicated checks
        if (i.verdict === 'PASS' || (/indexed/.test(state) && !/not indexed|excluded/.test(state)))
          continue;
        const p = findPage(site, i.url);
        if (p && !isIndexable(p)) continue; // intentionally out of the index
        out.push({
          checkId: 'crawlability.gsc-not-indexed',
          url: i.url,
          message: `Google: ${i.coverageState || i.verdict}`,
          evidence: `verdict ${i.verdict}`,
        });
      }
      return out;
    },
  ),
  siteCheck(
    {
      id: 'crawlability.gsc-crawled-not-indexed',
      category: 'crawlability',
      pillar: 'content',
      title: 'Crawled but not indexed by Google',
      why: 'Google fetched the page and chose not to index it. This is usually a quality or duplication judgement, not a technical block.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Make the page clearly useful and distinct: add original detail, merge it with a similar page, or link to it from stronger pages. Then request indexing.',
      requires: ['gsc'],
      refs: [REF.gscIndexing, REF.helpfulContent],
    },
    (site) =>
      (site.external.gsc?.inspections ?? [])
        .filter((i) => /crawled\s*-\s*currently not indexed/i.test(i.coverageState || ''))
        .map((i) => ({
          checkId: 'crawlability.gsc-crawled-not-indexed',
          url: i.url,
          message: 'Search Console: "Crawled - currently not indexed"',
          evidence: i.lastCrawl ? `last crawl ${i.lastCrawl}` : undefined,
        })),
  ),
  siteCheck(
    {
      id: 'crawlability.gsc-discovered-not-indexed',
      category: 'crawlability',
      pillar: T,
      title: 'Discovered but not yet crawled by Google',
      why: 'Google knows the URL but has not fetched it, often because the site has many low-value URLs or the page has weak internal links.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Add internal links to the page from well-linked pages, keep it in the sitemap with an accurate lastmod and reduce crawl waste elsewhere.',
      requires: ['gsc'],
      refs: [REF.gscIndexing],
    },
    (site) =>
      (site.external.gsc?.inspections ?? [])
        .filter((i) => /discovered\s*-\s*currently not indexed/i.test(i.coverageState || ''))
        .map((i) => ({
          checkId: 'crawlability.gsc-discovered-not-indexed',
          url: i.url,
          message: 'Search Console: "Discovered - currently not indexed"',
        })),
  ),
  siteCheck(
    {
      id: 'crawlability.gsc-canonical-mismatch',
      category: 'crawlability',
      pillar: T,
      title: 'Google chose a different canonical',
      why: 'Google ignored the canonical you declared and indexes another URL instead, so the version you want may never be shown or cited.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Make the signals agree: internal links, sitemap entries, redirects and the canonical tag should all point at the same URL. Remove near-duplicates.',
      requires: ['gsc'],
      refs: [REF.canonical],
    },
    (site) => {
      const out: Issue[] = [];
      for (const i of site.external.gsc?.inspections ?? []) {
        if (!i.googleCanonical) continue;
        const p = findPage(site, i.url);
        const declared = (p && declaredCanonical(p)) || i.url;
        if (sameUrl(i.googleCanonical, declared)) continue;
        out.push({
          checkId: 'crawlability.gsc-canonical-mismatch',
          url: i.url,
          message: `Google picked ${i.googleCanonical} instead of ${declared}`,
        });
      }
      return out;
    },
  ),
  siteCheck(
    {
      id: 'crawlability.gsc-noindex-with-impressions',
      category: 'crawlability',
      pillar: T,
      title: 'Noindex page still earning search impressions',
      why: 'The page is getting traffic from Google today but carries noindex, so it will drop out once Google recrawls it. Usually a recent accidental change.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Check whether noindex was intended. If not, remove it before the page drops out of results.',
      requires: ['gsc'],
      refs: [REF.robotsMeta],
    },
    (site) => {
      const out: Issue[] = [];
      for (const row of site.external.gsc?.pages ?? []) {
        if (row.impressions < 20) continue;
        const p = findPage(site, row.url);
        if (!p || !isHtml200(p) || !isNoindex(p)) continue;
        out.push({
          checkId: 'crawlability.gsc-noindex-with-impressions',
          url: p.url,
          message: `${row.impressions} impressions and ${row.clicks} clicks, but the page is now noindex`,
        });
      }
      return out;
    },
  ),
  siteCheck(
    {
      id: 'crawlability.gsc-low-ctr',
      category: 'crawlability',
      pillar: 'content',
      title: 'High impressions, low click-through rate',
      why: 'The page ranks well enough to be seen but few people click. The title or description probably does not match what searchers want.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Rewrite the title and meta description around the main queries for this page, state the answer or benefit plainly, and check for rich-result eligibility.',
      requires: ['gsc'],
      refs: [REF.titles, REF.snippets],
    },
    (site) => {
      const out: Issue[] = [];
      for (const row of site.external.gsc?.pages ?? []) {
        if (row.impressions < GSC_LOW_CTR_MIN_IMPRESSIONS) continue;
        const floor = expectedCtr(row.position);
        if (!floor || row.ctr >= floor / 2) continue;
        out.push({
          checkId: 'crawlability.gsc-low-ctr',
          url: row.url,
          message: `CTR ${(row.ctr * 100).toFixed(1)}% at average position ${row.position.toFixed(1)} from ${row.impressions} impressions`,
          data: { ctr: row.ctr, position: row.position, impressions: row.impressions },
        });
      }
      return out
        .sort((a, b) => Number(b.data?.impressions) - Number(a.data?.impressions))
        .slice(0, 100);
    },
  ),
  siteCheck(
    {
      id: 'crawlability.gsc-striking-distance',
      category: 'crawlability',
      pillar: 'content',
      title: 'Pages ranking just off page one',
      why: 'Pages averaging positions 8 to 20 with real demand are the quickest wins: small improvements can move them onto page one, where most clicks and AI citations come from.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Strengthen these pages: answer the main query in the first paragraph, add missing subtopics, improve internal links from related pages and refresh dates.',
      requires: ['gsc'],
    },
    (site) => {
      const rows = (site.external.gsc?.pages ?? []).filter(
        (r) => r.position >= 8 && r.position <= 20 && r.impressions >= GSC_STRIKING_MIN_IMPRESSIONS,
      );
      return rows
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 50)
        .map((r) => ({
          checkId: 'crawlability.gsc-striking-distance',
          url: r.url,
          message: `Average position ${r.position.toFixed(1)} with ${r.impressions} impressions`,
        }));
    },
  ),
  siteCheck(
    {
      id: 'crawlability.gsc-stale-crawl',
      category: 'crawlability',
      pillar: T,
      title: 'Google has not crawled the page recently',
      why: `A last crawl more than ${GSC_STALE_CRAWL_DAYS} days ago means updates to the page are not reflected in search or in AI answers built on the index.`,
      severity: 'low',
      fixTier: 'manual',
      fix: 'Link to the page from frequently updated pages, keep its sitemap lastmod accurate and make sure it returns 200 quickly.',
      requires: ['gsc'],
    },
    (site) => {
      const cutoff = Date.now() - GSC_STALE_CRAWL_DAYS * 86_400_000;
      return (site.external.gsc?.inspections ?? [])
        .filter((i) => i.lastCrawl && Date.parse(i.lastCrawl) < cutoff)
        .map((i) => ({
          checkId: 'crawlability.gsc-stale-crawl',
          url: i.url,
          message: `Last crawled by Google on ${i.lastCrawl!.slice(0, 10)}`,
        }));
    },
  ),
  siteCheck(
    {
      id: 'crawlability.gsc-no-impressions',
      category: 'crawlability',
      pillar: 'content',
      title: 'Indexable pages with no search impressions',
      why: 'Indexable pages that never appear in Search Console data are either not indexed or not relevant to any query. They add crawl load without return.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Review these pages: improve, merge or retire them. Check URL Inspection for the ones that should be indexed.',
      requires: ['gsc'],
    },
    (site) => {
      const gsc = site.external.gsc;
      if (!gsc || gsc.pages.length === 0 || gsc.pages.length >= 25_000) return null;
      const seen = new Set(gsc.pages.map((r) => urlKey(r.url)));
      const zero = indexablePages(site).filter(
        (p) => !seen.has(urlKey(p.url)) && !seen.has(urlKey(p.finalUrl)) && pathOf(p.url) !== '/',
      );
      if (!zero.length) return null;
      return zero.slice(0, 200).map((p) => ({
        checkId: 'crawlability.gsc-no-impressions',
        url: p.url,
        message: `No impressions between ${gsc.range.start} and ${gsc.range.end}`,
      }));
    },
  ),
];

// Exported for tests.
export const _internal = { expectedCtr, gscPage, CURRENT_YEAR };
export type { PageData };
