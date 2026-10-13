/**
 * URL hygiene.
 */
import {
  REF,
  TRACKING_PARAMS,
  groupBy,
  indexablePages,
  isIndexable,
  list,
  pageCheck,
  pageNumber,
  plural,
  safeUrl,
  siteCheck,
} from './_util.js';

export const URL_MAX_LENGTH = 115;
export const PATH_MAX_DEPTH = 5;
export const PARAMS_MAX = 3;
export const TRAILING_MIX_MIN_SHARE = 0.2;

const T = 'technical' as const;

const SESSION_PARAMS =
  /^(sid|sessionid|session_id|phpsessid|jsessionid|aspsessionid|cfid|cftoken|s_id|zenid|oscsid)$/i;

function path(url: string): string {
  return safeUrl(url)?.pathname ?? '';
}

export const checks = [
  pageCheck(
    {
      id: 'urls.uppercase',
      category: 'urls',
      pillar: T,
      title: 'URL contains upper-case letters',
      why: 'URLs are case-sensitive. Mixed case invites people and other sites to link to the wrong variant, creating duplicates or 404s.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use lower-case URLs and 301-redirect upper-case variants to them.',
      refs: [REF.urlStructure],
    },
    (page) =>
      isIndexable(page) && /[A-Z]/.test(path(page.url))
        ? {
            checkId: 'urls.uppercase',
            message: 'Path contains capital letters',
            evidence: path(page.url),
          }
        : null,
  ),
  pageCheck(
    {
      id: 'urls.underscores',
      category: 'urls',
      pillar: T,
      title: 'Underscores used to separate words',
      why: 'Google recommends hyphens between words in URLs. Underscores can be read as joining words together.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use hyphens in new URLs. Change existing ones only with 301 redirects, and only when it is worth the effort.',
      refs: [REF.urlStructure],
    },
    (page) =>
      isIndexable(page) && /[a-z0-9]_[a-z0-9]/i.test(path(page.url).replace(/\.[a-z0-9]+$/i, ''))
        ? {
            checkId: 'urls.underscores',
            message: 'Path uses underscores',
            evidence: path(page.url),
          }
        : null,
  ),
  pageCheck(
    {
      id: 'urls.too-long',
      category: 'urls',
      pillar: T,
      title: 'Very long URL',
      why: 'Long URLs are hard to share, are truncated in results and often contain repeated or stuffed words.',
      severity: 'low',
      fixTier: 'manual',
      fix: `Keep URLs short and readable (under about ${URL_MAX_LENGTH} characters) for new pages.`,
      refs: [REF.urlStructure],
    },
    (page) =>
      isIndexable(page) && page.url.length > URL_MAX_LENGTH
        ? { checkId: 'urls.too-long', message: `URL is ${page.url.length} characters` }
        : null,
  ),
  pageCheck(
    {
      id: 'urls.unsafe-characters',
      category: 'urls',
      pillar: T,
      title: 'Spaces or unsafe characters in the URL',
      why: 'Spaces (%20) and characters like commas, quotes or brackets break when URLs are copied, shared or parsed by other tools.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use only lower-case letters, numbers and hyphens in paths.',
      refs: [REF.urlStructure],
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const p = path(page.url);
      return /%20|%22|%3C|%3E|[,;!'()*\s]|%7B|%7D|%7C|%5C|%5E|%60/i.test(p)
        ? {
            checkId: 'urls.unsafe-characters',
            message: 'Path contains spaces or unsafe characters',
            evidence: p,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'urls.double-slash',
      category: 'urls',
      pillar: T,
      title: 'Double slash in the path',
      why: '"//" in a path is usually a templating mistake and creates a duplicate of the single-slash URL.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Fix the link template and redirect // URLs to the single-slash version.',
    },
    (page) =>
      page.isHtml && /\/\//.test(path(page.url))
        ? { checkId: 'urls.double-slash', message: 'Path contains //', evidence: path(page.url) }
        : null,
  ),
  pageCheck(
    {
      id: 'urls.repeated-segment',
      category: 'urls',
      pillar: T,
      title: 'Repeated folder in the URL',
      why: 'Paths like /blog/blog/ usually come from relative links resolving wrongly and can create endless crawl loops.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Use root-relative (/blog/post) or absolute links in templates and fix the link that produced this URL.',
    },
    (page) => {
      if (!page.isHtml) return null;
      const segs = path(page.url).split('/').filter(Boolean);
      const rep = segs.find((s, i) => i > 0 && s === segs[i - 1] && !/^\d+$/.test(s));
      const loops = segs.length >= 6 && new Set(segs).size <= segs.length / 2;
      return rep || loops
        ? {
            checkId: 'urls.repeated-segment',
            message: rep ? `"/${rep}/${rep}/" repeated` : 'Path repeats the same folders',
            evidence: path(page.url),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'urls.session-id',
      category: 'urls',
      pillar: T,
      title: 'Session ID in the URL',
      why: 'Session IDs give every visit a new URL, so crawlers see endless duplicates and links shared by users can leak sessions.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Keep sessions in cookies, not URLs, and strip session parameters from links.',
      refs: [REF.urlStructure],
    },
    (page) => {
      const u = safeUrl(page.url);
      if (!u || !page.isHtml) return null;
      const bad = [...u.searchParams.keys()].filter((k) => SESSION_PARAMS.test(k));
      const pathSid = /;jsessionid=/i.test(u.pathname);
      return bad.length || pathSid
        ? {
            checkId: 'urls.session-id',
            message: `Session parameter ${bad[0] ?? 'jsessionid'} in URL`,
            evidence: page.url,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'urls.tracking-parameters',
      category: 'urls',
      pillar: T,
      title: 'Indexable URL with tracking parameters',
      why: 'URLs with utm_, gclid or fbclid parameters that are indexable and self-canonical become duplicates of the clean page.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Make parameter URLs canonicalise to the clean URL, and stop linking to tracked URLs internally.',
      refs: [REF.canonical],
    },
    (page) => {
      const u = safeUrl(page.url);
      if (!u || !isIndexable(page)) return null;
      const bad = [...u.searchParams.keys()].filter(
        (k) => TRACKING_PARAMS.has(k.toLowerCase()) || k.toLowerCase().startsWith('utm_'),
      );
      return bad.length
        ? {
            checkId: 'urls.tracking-parameters',
            message: `Indexable with ${list(bad)}`,
            evidence: page.url,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'urls.many-parameters',
      category: 'urls',
      pillar: T,
      title: 'Indexable URL with many parameters',
      why: `URLs with more than ${PARAMS_MAX} parameters are usually filter combinations. They multiply into huge numbers of near-duplicate pages.`,
      severity: 'low',
      fixTier: 'guided',
      fix: 'Canonicalise filter combinations to the main category page, or noindex them, and avoid plain links to deep filter states.',
      refs: [
        'https://developers.google.com/search/docs/crawling-indexing/crawling-managing-faceted-navigation',
      ],
    },
    (page) => {
      const u = safeUrl(page.url);
      if (!u || !isIndexable(page)) return null;
      const n = [...new Set(u.searchParams.keys())].length;
      return n > PARAMS_MAX
        ? { checkId: 'urls.many-parameters', message: `${n} query parameters`, evidence: u.search }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'urls.deep-path',
      category: 'urls',
      pillar: T,
      title: 'Deeply nested URL path',
      why: 'Many folder levels make URLs long and often mirror an over-complicated site structure.',
      severity: 'low',
      fixTier: 'manual',
      fix: `Keep new URLs within about ${PATH_MAX_DEPTH} folder levels.`,
    },
    (page) => {
      if (!isIndexable(page)) return null;
      const d = path(page.url).split('/').filter(Boolean).length;
      return d > PATH_MAX_DEPTH
        ? { checkId: 'urls.deep-path', message: `${d} folder levels`, evidence: path(page.url) }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'urls.non-descriptive',
      category: 'urls',
      pillar: T,
      title: 'URL has no readable words',
      why: 'IDs like ?p=123 or /node/456 tell people and AI engines nothing about the page; readable slugs are clearer when shared and cited.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Enable readable permalinks (for example /services/seo-audit/) and redirect the ID URLs to them.',
      refs: [REF.urlStructure],
    },
    (page) => {
      if (!isIndexable(page) || pageNumber(page.url) != null) return null;
      const u = safeUrl(page.url)!;
      const idParam = [...u.searchParams.keys()].some(
        (k) =>
          /^(p|page_id|id|pid|article|cat|post)$/i.test(k) &&
          /^\d+$/.test(u.searchParams.get(k) || ''),
      );
      const idPath =
        /^\/(node|item|product|article|post|p)\/\d+\/?$/i.test(u.pathname) ||
        /^\/\d+\/?$/.test(u.pathname);
      return idParam || idPath
        ? {
            checkId: 'urls.non-descriptive',
            message: 'URL identifies the page by number only',
            evidence: `${u.pathname}${u.search}`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'urls.internal-search-indexable',
      category: 'urls',
      pillar: T,
      title: 'Internal search results are indexable',
      why: 'Search result pages are endless, thin and duplicate. Google advises keeping them out of the index; they waste crawl budget and can be abused for spam.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add noindex to search result pages and stop linking to them; optionally disallow the search path in robots.txt.',
      refs: [REF.spam],
    },
    (page) => {
      const u = safeUrl(page.url);
      if (!u || !isIndexable(page)) return null;
      const isSearch =
        u.searchParams.has('s') ||
        /\/search\/?$/i.test(u.pathname) ||
        (/\/search\b/i.test(u.pathname) &&
          ['q', 'query', 'keyword', 'term'].some((k) => u.searchParams.has(k)));
      return isSearch
        ? {
            checkId: 'urls.internal-search-indexable',
            message: 'Search results page is indexable',
            evidence: `${u.pathname}${u.search}`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'urls.index-file',
      category: 'urls',
      pillar: T,
      title: 'URL ends in index.html or index.php',
      why: '/folder/index.html and /folder/ are two URLs for one page. Linking to the index file splits signals.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Link to the folder URL and redirect the index file URL to it.',
    },
    (page) =>
      isIndexable(page) && /\/index\.(html?|php|aspx?)$/i.test(path(page.url))
        ? {
            checkId: 'urls.index-file',
            message: 'URL includes the index file name',
            evidence: path(page.url),
          }
        : null,
  ),
  siteCheck(
    {
      id: 'urls.case-duplicates',
      category: 'urls',
      pillar: T,
      title: 'URLs that differ only by letter case',
      why: 'Two crawled URLs that differ only in capitals are duplicates of each other.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Redirect the mixed-case URL to the lower-case one and correct the links.',
    },
    (site) => {
      const g = groupBy(indexablePages(site), (p) => p.url.toLowerCase());
      return [...g.values()]
        .filter((x) => x.length > 1)
        .slice(0, 100)
        .map((x) => ({
          checkId: 'urls.case-duplicates',
          url: x[0].url,
          message: `${x.length} URLs differ only by case`,
          evidence: list(
            x.map((p) => p.url),
            3,
          ),
        }));
    },
  ),
  siteCheck(
    {
      id: 'urls.trailing-slash-mixed',
      category: 'urls',
      pillar: T,
      title: 'Mixed trailing-slash style',
      why: 'Using both /page and /folder/ styles across the site makes it easy to link to the wrong form and create redirects or duplicates.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Pick one convention for page URLs and enforce it with redirects and consistent links.',
      refs: [REF.urlStructure],
    },
    (site) => {
      const paths = indexablePages(site)
        .map((p) => path(p.url))
        .filter((p) => p.length > 1 && !/\.[a-z0-9]{2,5}$/i.test(p));
      if (paths.length < 10) return null;
      const withSlash = paths.filter((p) => p.endsWith('/')).length;
      const minority = Math.min(withSlash, paths.length - withSlash);
      if (minority / paths.length < TRAILING_MIX_MIN_SHARE) return null;
      return {
        checkId: 'urls.trailing-slash-mixed',
        message: `${withSlash} pages end with a slash and ${paths.length - withSlash} do not`,
      };
    },
  ),
];

export const _internal = { plural };
