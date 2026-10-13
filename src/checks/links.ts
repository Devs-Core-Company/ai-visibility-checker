/**
 * Internal link architecture and outbound links.
 */
import type { Issue, LinkRef, PageData, SiteContext } from '../core/types.js';
import {
  REF,
  TRACKING_PARAMS,
  doc,
  findPage,
  getExternalStatuses,
  homePage,
  htmlPages,
  indexablePages,
  inlinkCount,
  isCanonicalisedAway,
  isHomepage,
  isHtml200,
  isIndexable,
  isHttpsSite,
  linkScore,
  linkScores,
  list,
  pageCheck,
  pathOf,
  plural,
  safeUrl,
  siteCheck,
  truncate,
  urlKey,
  wasRedirected,
} from './_util.js';
import * as cu from './_util.js';

export const MAX_LINKS_PER_PAGE = 250;
export const MAX_EXTERNAL_LINKS = 100;
/** Lighthouse's link-text audit fails on a single generic link. */
export const GENERIC_ANCHOR_MIN = 1;
export const LOW_LINK_SCORE_PERCENTILE = 0.1;
export const CONCENTRATION_TOP_SHARE = 0.1;
export const CONCENTRATION_MAX = 0.8;
export const LONG_ANCHOR_CHARS = 120;

const T = 'technical' as const;
const C = 'content' as const;

const GENERIC_ANCHORS = new Set([
  'click here',
  'here',
  'read more',
  'more',
  'learn more',
  'find out more',
  'this',
  'link',
  'this link',
  'continue',
  'continue reading',
  'go',
  'details',
  'more info',
  'more information',
  'view more',
  'see more',
  'click',
  'page',
  'website',
]);

const DEV_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$|\.(local|localhost|test|internal|lan)$/i;

const AFFILIATE =
  /[?&](aff|affid|affiliate|aff_id|ref_id|tag|clickref|irgwc|partner|partnerid)=|\/(go|out|recommends|refer)\/[^/]+|amzn\.to|shareasale\.com|awin1\.com|impact\.com|partnerize|clickbank\.net|rakuten(advertising|marketing)|jdoqocy|anrdoezrs|dpbolvw|tkqlhce|kqzyfj/i;

function internalLinks(page: PageData): LinkRef[] {
  return page.links.filter((l) => l.internal);
}

function isBrokenTarget(t: PageData | undefined): boolean {
  if (!t) return false;
  if (t.blockedByRobots && t.status === 0) return false;
  return t.status >= 400 || t.status === 0;
}

export const checks = [
  // -------------------------------------------------------------------------
  // Internal links (page)
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'links-internal.broken',
      category: 'links-internal',
      pillar: T,
      title: 'Links to broken internal pages',
      why: 'Broken internal links send visitors, crawlers and AI agents to dead ends and waste the link value they carry.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Update each link to a working URL or remove it. If the target moved, add a 301 redirect too.',
      refs: [REF.links],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const bad = new Map<string, number>();
      for (const l of internalLinks(page)) {
        const t = findPage(site, l.href);
        if (isBrokenTarget(t)) bad.set(l.href, t!.status);
      }
      if (!bad.size) return null;
      return {
        checkId: 'links-internal.broken',
        message: `${plural(bad.size, 'broken internal link')}`,
        evidence: list(
          [...bad].map(([u, s]) => `${pathOf(u) || u} (${s || 'no response'})`),
          5,
        ),
        data: { count: bad.size },
      };
    },
  ),
  pageCheck(
    {
      id: 'links-internal.to-redirect',
      category: 'links-internal',
      pillar: T,
      title: 'Links to internal redirects',
      why: 'Each link to a redirect adds a hop for users and crawlers and is a weaker signal than linking to the final URL.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Change these links to point directly at the final URL.',
      refs: [REF.redirects],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const hits = new Map<string, string>();
      for (const l of internalLinks(page)) {
        const t = findPage(site, l.href);
        if (t && wasRedirected(t)) hits.set(l.href, t.finalUrl);
      }
      if (!hits.size) return null;
      return {
        checkId: 'links-internal.to-redirect',
        message: `${plural(hits.size, 'internal link')} to redirecting URLs`,
        evidence: list(
          [...hits].map(([a, b]) => `${pathOf(a)} → ${pathOf(b) || b}`),
          4,
        ),
      };
    },
  ),
  pageCheck(
    {
      id: 'links-internal.to-canonicalised',
      category: 'links-internal',
      pillar: T,
      title: 'Links to non-canonical URLs',
      why: 'Linking to a URL that canonicalises elsewhere contradicts the canonical. Consistent internal links help search engines respect your preferred URL.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Link to the canonical version of each page.',
      refs: [REF.canonical],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const hits = new Set<string>();
      for (const l of internalLinks(page)) {
        const t = findPage(site, l.href);
        if (t && isHtml200(t) && isCanonicalisedAway(t)) hits.add(l.href);
      }
      if (!hits.size) return null;
      return {
        checkId: 'links-internal.to-canonicalised',
        message: `${plural(hits.size, 'link')} to URLs that canonicalise elsewhere`,
        evidence: list([...hits].map(pathOf), 4),
      };
    },
  ),
  pageCheck(
    {
      id: 'links-internal.nofollow',
      category: 'links-internal',
      pillar: T,
      title: 'Internal links marked nofollow',
      why: 'rel="nofollow" on your own links stops crawlers following them and does not save link value for other pages. It usually hides pages you want found.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Remove rel="nofollow" from internal links. Use noindex on the target if it should stay out of search.',
      refs: [REF.qualifyLinks],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const nf = internalLinks(page).filter((l) => l.rel.includes('nofollow'));
      if (!nf.length) return null;
      return {
        checkId: 'links-internal.nofollow',
        message: `${plural(nf.length, 'internal link')} marked nofollow`,
        evidence: list([...new Set(nf.map((l) => pathOf(l.href)))], 4),
      };
    },
  ),
  pageCheck(
    {
      id: 'links-internal.to-blocked',
      category: 'links-internal',
      pillar: T,
      title: 'Links to URLs blocked by robots.txt',
      why: 'Links to disallowed URLs lead crawlers to pages they may not fetch, and the URLs can still be indexed without content.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Remove links to blocked URLs where users do not need them, or allow crawling and use noindex instead.',
      refs: [REF.robotsTxt],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const hits = new Set<string>();
      for (const l of internalLinks(page))
        if (findPage(site, l.href)?.blockedByRobots) hits.add(l.href);
      return hits.size
        ? {
            checkId: 'links-internal.to-blocked',
            message: `${plural(hits.size, 'link')} to robots-blocked URLs`,
            evidence: list([...hits].map(pathOf), 4),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-internal.insecure',
      category: 'links-internal',
      pillar: T,
      title: 'Internal links use http://',
      why: 'Linking to the http version of your own HTTPS site forces a redirect on every click and mixes protocol signals.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Change internal links to https:// or to root-relative paths (/page).',
      refs: [REF.https],
    },
    (page, site) => {
      if (!isHtml200(page) || !isHttpsSite(site)) return null;
      const http = internalLinks(page).filter((l) => l.href.startsWith('http:'));
      return http.length
        ? {
            checkId: 'links-internal.insecure',
            message: `${plural(http.length, 'internal link')} use http://`,
            evidence: list([...new Set(http.map((l) => l.href))], 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-internal.tracking-parameters',
      category: 'links-internal',
      pillar: T,
      title: 'Internal links carry tracking parameters',
      why: 'utm_ and similar parameters on internal links create duplicate URLs for crawlers and overwrite the real traffic source in analytics.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Remove tracking parameters from internal links. Use event tracking for internal campaigns instead.',
      refs: ['https://support.google.com/analytics/answer/10917952'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const hits = internalLinks(page).filter((l) => {
        const u = safeUrl(l.href);
        return (
          u &&
          [...u.searchParams.keys()].some(
            (k) => TRACKING_PARAMS.has(k.toLowerCase()) || k.toLowerCase().startsWith('utm_'),
          )
        );
      });
      return hits.length
        ? {
            checkId: 'links-internal.tracking-parameters',
            message: `${plural(hits.length, 'internal link')} with tracking parameters`,
            evidence: list([...new Set(hits.map((l) => l.href))], 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-internal.missing-protocol',
      category: 'links-internal',
      pillar: T,
      title: 'Link missing http(s):// is treated as a relative path',
      why: 'An href like "www.example.com" without https:// resolves as a path on your own site, creating a broken link.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add https:// to the start of the link.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const hits = internalLinks(page).filter((l) =>
        /^\/(?:[^/]+\/)*(www\.[a-z0-9-]+\.[a-z.]{2,}|[a-z0-9-]+\.(com|org|net|io|co\.uk|co|ai|dev|app))(\/|$)/i.test(
          pathOf(l.href),
        ),
      );
      return hits.length
        ? {
            checkId: 'links-internal.missing-protocol',
            message: `${plural(hits.length, 'link')} look like external URLs without a protocol`,
            evidence: list(
              hits.map((l) => pathOf(l.href)),
              3,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-internal.uncrawlable',
      category: 'links-internal',
      pillar: T,
      title: 'Links that crawlers cannot follow',
      why: 'Google, Bing and AI crawlers only follow <a> elements with a real href. javascript: links, empty hrefs and onclick-only navigation are invisible to them.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use <a href="/real-url"> for navigation. Use <button> for actions that are not navigation.',
      refs: [REF.links],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const bad = Array.from(doc(page).querySelectorAll('a')).filter((a) => {
        const href = a.getAttribute('href');
        if (href == null)
          return (
            a.hasAttribute('onclick') || a.hasAttribute('ng-click') || a.hasAttribute('@click')
          );
        const h = href.trim();
        return (
          /^javascript:/i.test(h) ||
          ((h === '' || h === '#') &&
            (a.hasAttribute('onclick') || a.hasAttribute('@click') || a.hasAttribute('v-on:click')))
        );
      });
      if (!bad.length) return null;
      return {
        checkId: 'links-internal.uncrawlable',
        message: `${plural(bad.length, 'link')} without a crawlable href`,
        evidence: truncate(
          bad
            .slice(0, 3)
            .map((a) => a.outerHTML.slice(0, 100))
            .join(' | '),
        ),
      };
    },
  ),
  pageCheck(
    {
      id: 'links-internal.generic-anchors',
      category: 'links-internal',
      pillar: C,
      title: 'Generic anchor text',
      why: 'Anchors such as "click here" or "read more" tell search engines, AI crawlers and screen-reader users nothing about the target page.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Rewrite the links so the anchor says what the target is, for example "pricing for small teams" rather than "click here".',
      refs: [REF.links],
      tags: ['wcag-2.4.4'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const g = internalLinks(page).filter((l) =>
        GENERIC_ANCHORS.has(
          l.text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, '')
            .replace(/\s+/g, ' ')
            .trim(),
        ),
      );
      if (g.length < GENERIC_ANCHOR_MIN) return null;
      return {
        checkId: 'links-internal.generic-anchors',
        message: `${g.length} internal links use generic anchor text`,
        evidence: list([...new Set(g.map((l) => `"${l.text}"`))], 4),
      };
    },
  ),
  pageCheck(
    {
      id: 'links-internal.long-anchor',
      category: 'links-internal',
      pillar: C,
      title: 'Very long anchor text',
      why: 'Anchors that wrap whole paragraphs or cards dilute what the link is about and are tiring for screen-reader users.',
      severity: 'info',
      fixTier: 'manual',
      fix: `Keep anchor text short and specific (under about ${LONG_ANCHOR_CHARS} characters).`,
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const long = internalLinks(page).filter((l) => l.text.length > LONG_ANCHOR_CHARS);
      return long.length >= 3
        ? {
            checkId: 'links-internal.long-anchor',
            message: `${long.length} links with anchors over ${LONG_ANCHOR_CHARS} characters`,
            evidence: truncate(long[0].text, 150),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-internal.too-many',
      category: 'links-internal',
      pillar: T,
      title: 'Very many links on one page',
      why: 'Hundreds of links on one page divide its link value thinly and make it hard for crawlers and people to tell which links matter.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Trim mega-menus and footers, group links on hub pages and keep the most important links in the main content.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const n = new Set(page.links.map((l) => l.href)).size;
      return n > MAX_LINKS_PER_PAGE
        ? { checkId: 'links-internal.too-many', message: `${n} unique links on the page` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-internal.dead-end',
      category: 'links-internal',
      pillar: T,
      title: 'Page has no internal links',
      why: 'A page with no links to the rest of the site is a dead end: crawlers and visitors cannot continue, and it passes no value on.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Add navigation and contextual links to related pages.',
      refs: [REF.links],
    },
    (page) =>
      isIndexable(page) && internalLinks(page).length === 0
        ? { checkId: 'links-internal.dead-end', message: 'No internal links in the HTML' }
        : null,
  ),
  pageCheck(
    {
      id: 'links-internal.single-inlink',
      category: 'links-internal',
      pillar: T,
      title: 'Page has only one internal link pointing to it',
      why: 'A page reachable through a single link is fragile and looks unimportant to crawlers.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Link to the page from other relevant pages, hubs or the navigation.',
    },
    (page, site) => {
      if (!isIndexable(page) || isHomepage(page, site) || page.depth < 0) return null;
      return inlinkCount(site, page.url) === 1
        ? { checkId: 'links-internal.single-inlink', message: 'Only one internal page links here' }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-internal.low-link-score',
      category: 'links-internal',
      pillar: T,
      title: 'Weak internal link score',
      why: 'Internal links pass authority. Pages in the bottom tenth of the site’s internal link graph get little of it, so they rank and get crawled less.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Add contextual links to this page from strong pages (home, hubs, popular articles).',
    },
    (page, site) => {
      if (!isIndexable(page) || !page.inSitemap || htmlPages(site).length < 20) return null;
      const s = linkScore(site, page.url);
      if (!s || s.percentile > LOW_LINK_SCORE_PERCENTILE) return null;
      return {
        checkId: 'links-internal.low-link-score',
        message: `Internal link score ${s.score}/10 (bottom ${Math.round(LOW_LINK_SCORE_PERCENTILE * 100)}% of the site)`,
        data: { score: s.score },
      };
    },
  ),

  // -------------------------------------------------------------------------
  // Internal links (site)
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'links-internal.orphan',
      category: 'links-internal',
      pillar: T,
      title: 'Orphan pages (in the sitemap, not linked)',
      why: 'Pages that only appear in the sitemap get no internal link value and look unimportant. Crawlers following links never reach them.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Link to each orphan from a relevant page or hub, or remove it from the sitemap if it is obsolete.',
      refs: [REF.links],
    },
    (site) => {
      const out: Issue[] = [];
      for (const p of site.pages.values()) {
        if (!p.inSitemap || !isIndexable(p) || isHomepage(p, site)) continue;
        if (inlinkCount(site, p.url) > 0 || inlinkCount(site, p.finalUrl) > 0) continue;
        out.push({
          checkId: 'links-internal.orphan',
          url: p.url,
          message: 'In the sitemap but no crawled page links to it',
        });
      }
      return out;
    },
  ),
  siteCheck(
    {
      id: 'links-internal.navigation-only',
      category: 'links-internal',
      pillar: C,
      title: 'Pages linked only from menus and footers',
      why: 'Links inside the main content carry more context than site-wide menus. Pages with no contextual links are harder for search and AI engines to place in a topic.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Link to these pages from relevant paragraphs on related pages, with descriptive anchor text.',
    },
    (site) => {
      const contextual = new Set<string>();
      const any = new Set<string>();
      for (const p of htmlPages(site))
        for (const l of internalLinks(p)) {
          const k = urlKey(l.href);
          any.add(k);
          if (!l.region || l.region === 'main' || l.region === 'other') contextual.add(k);
        }
      if (!contextual.size) return null;
      const hits = indexablePages(site).filter(
        (p) => !isHomepage(p, site) && any.has(urlKey(p.url)) && !contextual.has(urlKey(p.url)),
      );
      if (hits.length === indexablePages(site).length - 1) return null; // region data probably missing
      return hits.slice(0, 200).map((p) => ({
        checkId: 'links-internal.navigation-only',
        url: p.url,
        message: 'Linked only from navigation, header or footer',
      }));
    },
  ),
  siteCheck(
    {
      id: 'links-internal.concentration',
      category: 'links-internal',
      pillar: T,
      title: 'Internal links concentrated on a few pages',
      why: 'When a small set of pages collects nearly all internal link value, the rest of the site is under-supported in crawling and ranking.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Add contextual links between related deep pages, and from hubs to the pages they summarise.',
    },
    (site) => {
      const scores = [...linkScores(site).values()].map((s) => s.rank).sort((a, b) => b - a);
      if (scores.length < 30) return null;
      const top = Math.max(1, Math.round(scores.length * CONCENTRATION_TOP_SHARE));
      const share =
        scores.slice(0, top).reduce((a, b) => a + b, 0) / scores.reduce((a, b) => a + b, 0);
      if (share < CONCENTRATION_MAX) return null;
      return {
        checkId: 'links-internal.concentration',
        message: `The top ${top} pages hold ${Math.round(share * 100)}% of internal link value`,
      };
    },
  ),
  siteCheck(
    {
      id: 'links-internal.hashbang',
      category: 'links-internal',
      pillar: T,
      title: 'Navigation uses #! or # routes',
      why: 'Crawlers ignore everything after #, so "#!/page" or "#/page" routes all look like one URL. Each view needs its own real path.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Switch the router to history mode (real paths such as /page) and render each route on the server.',
      refs: [REF.js],
    },
    (site) => {
      const home = homePage(site);
      if (!home || !isHtml200(home)) return null;
      const hits = Array.from(
        doc(home).querySelectorAll('a[href^="#!"], a[href^="#/"], a[href*="/#!/"], a[href*="/#/"]'),
      ).map((a) => a.getAttribute('href') || '');
      if (hits.length < 3) return null;
      return {
        checkId: 'links-internal.hashbang',
        url: home.url,
        message: `${hits.length} links use fragment routes`,
        evidence: list(hits, 4),
      };
    },
  ),

  // -------------------------------------------------------------------------
  // External links
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'links-external.broken',
      category: 'links-external',
      pillar: C,
      title: 'Broken outbound links',
      why: 'Links to dead pages frustrate readers and suggest the content is not maintained, which weakens it as a source for search and AI engines.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Update each link to a working source, link to an archived copy, or remove it.',
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const st = getExternalStatuses(site);
      if (!st.size) return null;
      const bad = [...new Set(page.links.filter((l) => !l.internal).map((l) => l.href))].filter(
        (h) => {
          const s = st.get(h);
          return s !== undefined && (s === 404 || s === 410 || s >= 500 || s === 0);
        },
      );
      return bad.length
        ? {
            checkId: 'links-external.broken',
            message: `${plural(bad.length, 'broken outbound link')}`,
            evidence: list(
              bad.map((h) => `${h} (${st.get(h) || 'no response'})`),
              3,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-external.redirecting',
      category: 'links-external',
      pillar: C,
      title: 'Outbound links that redirect',
      why: 'Outbound links that redirect are often moved or retired pages; some end at a different page than the one you meant to cite.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Update the links to the current URLs.',
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const st = getExternalStatuses(site);
      const hits = [...new Set(page.links.filter((l) => !l.internal).map((l) => l.href))].filter(
        (h) => {
          const s = st.get(h);
          return s !== undefined && s >= 300 && s < 400;
        },
      );
      return hits.length
        ? {
            checkId: 'links-external.redirecting',
            message: `${plural(hits.length, 'outbound link')} redirect`,
            evidence: list(hits, 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-external.insecure',
      category: 'links-external',
      pillar: C,
      title: 'Outbound links use http://',
      why: 'Linking to http:// pages sends readers to unencrypted sites and browsers may warn them. Many such sites now support https.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Switch links to https:// where the destination supports it.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const http = [
        ...new Set(
          page.links
            .filter(
              (l) =>
                !l.internal &&
                l.href.startsWith('http:') &&
                !DEV_HOST.test(safeUrl(l.href)?.hostname ?? ''),
            )
            .map((l) => l.href),
        ),
      ];
      return http.length
        ? {
            checkId: 'links-external.insecure',
            message: `${plural(http.length, 'outbound link')} use http://`,
            evidence: list(http, 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-external.dev-host',
      category: 'links-external',
      pillar: T,
      title: 'Links to localhost or private network addresses',
      why: 'Links to localhost, private IPs or .local hosts are leftovers from development. They are broken for everyone else.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Replace these links with the live URLs (often a find-and-replace in the database or content files).',
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      // Auditing a local or staging copy: its own host is expected, not a leftover.
      const ownHost = safeUrl(site.origin)?.hostname ?? '';
      const hits = [
        ...new Set(
          page.links
            .filter((l) => {
              const h = safeUrl(l.href)?.hostname ?? '';
              return h !== ownHost && DEV_HOST.test(h);
            })
            .map((l) => l.href),
        ),
      ];
      return hits.length
        ? {
            checkId: 'links-external.dev-host',
            message: `${plural(hits.length, 'link')} to development hosts`,
            evidence: list(hits, 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-external.sponsored-unqualified',
      category: 'links-external',
      pillar: C,
      title: 'Affiliate links without rel="sponsored"',
      why: 'Google asks for paid and affiliate links to be marked rel="sponsored" (or nofollow). Unmarked ones can be treated as link schemes.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add rel="sponsored" to affiliate and paid links.',
      refs: [REF.qualifyLinks, REF.spam],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const hits = page.links.filter(
        (l) =>
          !l.internal &&
          AFFILIATE.test(l.href) &&
          !l.rel.some((r) => r === 'sponsored' || r === 'nofollow'),
      );
      return hits.length
        ? {
            checkId: 'links-external.sponsored-unqualified',
            message: `${plural(hits.length, 'affiliate-style link')} without rel="sponsored"`,
            evidence: list([...new Set(hits.map((l) => l.href))], 3),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-external.noopener',
      category: 'links-external',
      pillar: T,
      title: 'target="_blank" links without rel="noopener"',
      why: 'Older browsers let a page opened with target="_blank" control the original tab (tabnabbing). Modern browsers default to noopener, but explicit rel protects every visitor.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add rel="noopener" (or "noopener noreferrer") to external links that open in a new tab.',
      refs: ['https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/noopener'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const hits = page.links.filter(
        (l) =>
          !l.internal &&
          l.target === '_blank' &&
          !l.rel.includes('noopener') &&
          !l.rel.includes('noreferrer'),
      );
      return hits.length
        ? {
            checkId: 'links-external.noopener',
            message: `${plural(hits.length, 'link')} open a new tab without noopener`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'links-external.too-many',
      category: 'links-external',
      pillar: C,
      title: 'Very many outbound links',
      why: 'A page with hundreds of outbound links looks like a link directory and gives each link little weight.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Keep outbound links to sources that support the content.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const n = new Set(page.links.filter((l) => !l.internal).map((l) => l.href)).size;
      return n > MAX_EXTERNAL_LINKS
        ? { checkId: 'links-external.too-many', message: `${n} unique outbound links` }
        : null;
    },
  ),
];

// ---------------------------------------------------------------------------
// Added for feature parity: outbound links Google Safe Browsing flags
// ---------------------------------------------------------------------------

checks.push(
  cu.siteCheck(
    {
      id: 'links-external.unsafe',
      category: 'links-external',
      pillar: 'technical',
      title: 'Links to sites flagged for malware or phishing',
      why: 'Linking to a site Google Safe Browsing lists for malware, phishing or unwanted software puts visitors at risk and can make browsers warn about your pages. It is often a sign of a hacked page, an expired domain someone bought, or spam in comments.',
      severity: 'high',
      fixTier: 'manual',
      fix: 'Remove or replace each flagged link. If you did not add it, check the page for injected content and change your CMS passwords.',
      requires: ['safe-browsing'],
      refs: [
        'https://developers.google.com/safe-browsing/v4',
        'https://developers.google.com/search/docs/monitor-debug/security/malware',
      ],
    },
    (site) => {
      const sb = site.external.safeBrowsing;
      if (!sb) return null;
      return sb.matches.map((m) => ({
        checkId: 'links-external.unsafe',
        url: m.pages[0],
        message: `Links to ${m.url}, flagged as ${m.threat.toLowerCase().replace(/_/g, ' ')}`,
        evidence: cu.list(m.pages, 5),
        data: { target: m.url, threat: m.threat, pages: m.pages.length },
      }));
    },
  ),
);
