/**
 * Canonical tags and headers.
 */
import type { Issue, PageData, SiteContext } from '../core/types.js';
import {
  REF,
  TRACKING_PARAMS,
  declaredCanonical,
  findPage,
  htmlPages,
  isCanonicalisedAway,
  isHomepage,
  isHtml200,
  isIndexable,
  isNoindex,
  list,
  pageCheck,
  pageNumber,
  pathOf,
  rawBody,
  rawHead,
  safeUrl,
  sameSiteHost,
  sameUrl,
  siteCheck,
  truncate,
  wasRedirected,
} from './_util.js';

export const CANONICAL_TO_HOME_MIN = 5;

const T = 'technical' as const;

const CANONICAL_TAG = /<link\b[^>]*\brel=["']?canonical["']?[^>]*>/gi;

function rawCanonicalHrefs(html: string): string[] {
  return [...rawHead(html).matchAll(CANONICAL_TAG)].map(
    (m) => /\bhref\s*=\s*["']?([^"'\s>]*)/i.exec(m[0])?.[1] ?? '',
  );
}

/** The canonical target as crawled, when it was. */
function target(page: PageData, site: SiteContext): PageData | undefined {
  const c = declaredCanonical(page);
  if (!c || !isCanonicalisedAway(page)) return undefined;
  return findPage(site, c);
}

export const checks = [
  pageCheck(
    {
      id: 'canonical.missing',
      category: 'canonical',
      pillar: T,
      title: 'No canonical URL declared',
      why: 'A self-referencing canonical tells search engines which URL to index when the page is reachable with parameters, tracking codes or other variants.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add <link rel="canonical" href="…"> with the absolute, preferred URL of the page.',
      refs: [REF.canonical],
    },
    (page) =>
      isHtml200(page) &&
      !isNoindex(page) &&
      !page.blockedByRobots &&
      !declaredCanonical(page) &&
      page.canonicalCount === 0
        ? { checkId: 'canonical.missing', message: 'No canonical tag or Link header' }
        : null,
  ),
  pageCheck(
    {
      id: 'canonical.multiple',
      category: 'canonical',
      pillar: T,
      title: 'Several canonical tags',
      why: 'When a page declares more than one canonical, Google may ignore all of them.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Keep exactly one canonical tag. Often a theme and an SEO plugin both add one; turn one off.',
      refs: [REF.canonical],
    },
    (page) => {
      if (!isHtml200(page) || page.canonicalCount < 2) return null;
      const hrefs = [...new Set(rawCanonicalHrefs(page.html || ''))];
      return {
        checkId: 'canonical.multiple',
        severity: hrefs.length > 1 ? 'high' : 'low',
        message:
          hrefs.length > 1
            ? `${page.canonicalCount} canonical tags pointing to different URLs`
            : `${page.canonicalCount} identical canonical tags`,
        evidence: truncate(hrefs.join(' | ')),
      };
    },
  ),
  pageCheck(
    {
      id: 'canonical.empty',
      category: 'canonical',
      pillar: T,
      title: 'Canonical tag has an empty or invalid href',
      why: 'An empty or unparseable canonical is ignored, so the page has no canonical even though one was intended.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Fill in the full preferred URL in the canonical href.',
      refs: [REF.canonical],
    },
    (page) => {
      if (!isHtml200(page) || page.canonicalCount === 0) return null;
      const hrefs = rawCanonicalHrefs(page.html || '');
      const bad = hrefs.filter(
        (h) => !h.trim() || /^(#|javascript:|undefined|null)/i.test(h.trim()),
      );
      if (!bad.length && page.canonical) return null;
      if (!bad.length && hrefs.length === 0) return null;
      return {
        checkId: 'canonical.empty',
        message: 'Canonical href is empty or not a URL',
        evidence: truncate(hrefs.join(' | ') || '(empty)'),
      };
    },
  ),
  pageCheck(
    {
      id: 'canonical.relative',
      category: 'canonical',
      pillar: T,
      title: 'Canonical uses a relative URL',
      why: 'Relative canonicals work but break easily: on staging, alternate hosts or http copies they point at the wrong place. Google recommends absolute URLs.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use the full URL, including https:// and the host, in the canonical tag.',
      refs: [REF.canonical],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const rel = rawCanonicalHrefs(page.html || '').filter(
        (h) => h.trim() && !/^https?:\/\//i.test(h.trim()),
      );
      return rel.length
        ? {
            checkId: 'canonical.relative',
            message: 'Canonical href is not absolute',
            evidence: truncate(rel[0]),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'canonical.has-fragment',
      category: 'canonical',
      pillar: T,
      title: 'Canonical contains a # fragment',
      why: 'Search engines ignore the part after #, so a canonical with a fragment is a sign of a templating mistake.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Remove the # fragment from the canonical URL.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const f = rawCanonicalHrefs(page.html || '').find((h) => h.includes('#'));
      return f
        ? {
            checkId: 'canonical.has-fragment',
            message: 'Canonical URL includes a fragment',
            evidence: truncate(f),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'canonical.outside-head',
      category: 'canonical',
      pillar: T,
      title: 'Canonical tag placed in <body>',
      why: 'Google ignores rel=canonical in the body, so the canonical has no effect.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Move the canonical <link> into <head>.',
      refs: [REF.canonical],
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const m = /<link\b[^>]*\brel=["']?canonical["']?[^>]*>/i.exec(rawBody(page.html));
      return m
        ? {
            checkId: 'canonical.outside-head',
            message: 'A canonical tag sits outside <head>',
            evidence: truncate(m[0]),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'canonical.header-mismatch',
      category: 'canonical',
      pillar: T,
      title: 'Canonical tag and Link header disagree',
      why: 'When the HTML canonical and the HTTP Link canonical point to different URLs, Google may ignore both.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Remove one of them, or make both point to the same URL.',
      refs: [REF.canonical],
    },
    (page) => {
      if (!isHtml200(page) || !page.canonical || !page.canonicalHeader) return null;
      if (sameUrl(page.canonical, page.canonicalHeader)) return null;
      return {
        checkId: 'canonical.header-mismatch',
        message: 'HTML and HTTP header canonicals differ',
        evidence: `html: ${page.canonical} | header: ${page.canonicalHeader}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'canonical.points-elsewhere',
      category: 'canonical',
      pillar: T,
      title: 'Page canonicalises to another URL',
      why: 'This page asks search engines to index a different URL instead. That is right for duplicates, but a mistake on unique pages, which then never appear in results.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Check the target. If this page is unique, make the canonical self-referencing.',
      refs: [REF.canonical],
    },
    (page) =>
      isHtml200(page) && isCanonicalisedAway(page)
        ? {
            checkId: 'canonical.points-elsewhere',
            message: `Canonical points to ${declaredCanonical(page)}`,
          }
        : null,
  ),
  pageCheck(
    {
      id: 'canonical.to-error',
      category: 'canonical',
      pillar: T,
      title: 'Canonical points to an error page',
      why: 'A canonical to a 4xx or 5xx URL asks search engines to index something that does not exist. They usually ignore it and pick their own canonical.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Point the canonical at a live 200 URL, normally the page itself.',
      refs: [REF.canonical],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const t = target(page, site);
      if (!t || (t.status < 400 && t.status !== 0)) return null;
      return {
        checkId: 'canonical.to-error',
        message: `Canonical target returns ${t.status || 'no response'}`,
        evidence: t.url,
      };
    },
  ),
  pageCheck(
    {
      id: 'canonical.to-redirect',
      category: 'canonical',
      pillar: T,
      title: 'Canonical points to a redirect',
      why: 'A canonical should name the final URL. Pointing it at a redirect sends mixed signals and is often ignored.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Update the canonical to the URL the redirect ends at.',
      refs: [REF.canonical],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const t = target(page, site);
      if (!t || !wasRedirected(t)) return null;
      return {
        checkId: 'canonical.to-redirect',
        message: `Canonical target redirects to ${t.finalUrl}`,
        evidence: t.url,
      };
    },
  ),
  pageCheck(
    {
      id: 'canonical.to-noindex',
      category: 'canonical',
      pillar: T,
      title: 'Canonical points to a noindex page',
      why: 'Saying "index that URL instead" while that URL says "do not index me" can leave neither page in search.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Point the canonical at an indexable page, or remove noindex from the target.',
      refs: [REF.canonical],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const t = target(page, site);
      if (!t || !isHtml200(t) || !isNoindex(t)) return null;
      return {
        checkId: 'canonical.to-noindex',
        message: 'Canonical target is noindex',
        evidence: t.url,
      };
    },
  ),
  pageCheck(
    {
      id: 'canonical.to-blocked',
      category: 'canonical',
      pillar: T,
      title: 'Canonical points to a URL blocked by robots.txt',
      why: 'Search engines cannot crawl the canonical target to confirm it, so the canonical is unlikely to be honoured.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Allow the target in robots.txt or choose a crawlable canonical.',
      refs: [REF.canonical, REF.robotsTxt],
    },
    (page, site) => {
      if (!isHtml200(page) || !isCanonicalisedAway(page)) return null;
      const c = declaredCanonical(page)!;
      const t = findPage(site, c);
      const blocked = t
        ? t.blockedByRobots
        : site.robots.found &&
          sameSiteHost(c, site.origin) &&
          !site.robots.isAllowed(c, 'Googlebot');
      return blocked
        ? {
            checkId: 'canonical.to-blocked',
            message: 'Canonical target is disallowed in robots.txt',
            evidence: c,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'canonical.chain',
      category: 'canonical',
      pillar: T,
      title: 'Canonical chain or loop',
      why: 'If page A canonicalises to B and B canonicalises to C (or back to A), search engines may give up and choose a canonical themselves.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Point every page in the chain directly at the final preferred URL, which should canonicalise to itself.',
      refs: [REF.canonical],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const t = target(page, site);
      if (!t || !isHtml200(t) || !isCanonicalisedAway(t)) return null;
      const next = declaredCanonical(t)!;
      const loop = sameUrl(next, page.url) || sameUrl(next, page.finalUrl);
      return {
        checkId: 'canonical.chain',
        message: loop
          ? 'Canonicals point at each other in a loop'
          : 'Canonical target canonicalises to yet another URL',
        evidence: `${page.url} → ${t.url} → ${next}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'canonical.cross-domain',
      category: 'canonical',
      pillar: T,
      title: 'Canonical points to another domain',
      why: 'A cross-domain canonical hands this page’s ranking to another site. Correct for syndicated copies, harmful when it is a leftover from a migration or a copied template.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Confirm the other domain should rank instead of this page. If not, make the canonical self-referencing.',
      refs: [REF.canonical],
    },
    (page, site) => {
      const c = declaredCanonical(page);
      if (!isHtml200(page) || !c || sameSiteHost(c, site.origin)) return null;
      return {
        checkId: 'canonical.cross-domain',
        message: `Canonical points to ${safeUrl(c)?.hostname ?? c}`,
        evidence: c,
      };
    },
  ),
  pageCheck(
    {
      id: 'canonical.host-or-protocol-variant',
      category: 'canonical',
      pillar: T,
      title: 'Canonical uses the wrong host or protocol',
      why: 'A canonical to http:// on an https site, or to www when the site runs on the bare domain, points search engines at a URL that only redirects.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Use the same protocol and host as the live site in every canonical.',
      refs: [REF.canonical, REF.https],
    },
    (page, site) => {
      const c = declaredCanonical(page);
      if (!isHtml200(page) || !c) return null;
      const cu = safeUrl(c);
      const pu = safeUrl(page.finalUrl || page.url);
      if (!cu || !pu || !sameSiteHost(c, site.origin)) return null;
      const diffs: string[] = [];
      if (cu.protocol !== pu.protocol)
        diffs.push(`${cu.protocol.replace(':', '')} instead of ${pu.protocol.replace(':', '')}`);
      if (cu.hostname !== pu.hostname) diffs.push(`${cu.hostname} instead of ${pu.hostname}`);
      return diffs.length
        ? {
            checkId: 'canonical.host-or-protocol-variant',
            message: `Canonical uses ${diffs.join(' and ')}`,
            evidence: c,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'canonical.keeps-parameters',
      category: 'canonical',
      pillar: T,
      title: 'Canonical keeps tracking or session parameters',
      why: 'A canonical that includes utm_, gclid or session parameters makes every tracked visit look like its own page.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Strip tracking and session parameters from the canonical URL.',
      refs: [REF.canonical],
    },
    (page) => {
      const c = declaredCanonical(page);
      const u = safeUrl(c);
      if (!isHtml200(page) || !u) return null;
      const bad = [...u.searchParams.keys()].filter(
        (k) =>
          TRACKING_PARAMS.has(k.toLowerCase()) ||
          /^utm_|^(sid|sessionid|phpsessid|jsessionid)$/i.test(k),
      );
      return bad.length
        ? {
            checkId: 'canonical.keeps-parameters',
            message: `Canonical includes ${list(bad)}`,
            evidence: c!,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'canonical.parameter-self',
      category: 'canonical',
      pillar: T,
      title: 'Parameter URL canonicalises to itself',
      why: 'Sorted, filtered or tracked URLs that declare themselves canonical compete with the clean URL in the index.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Point the canonical of parameter variants at the clean URL, unless the parameter genuinely changes the main content (pagination, language).',
      refs: [REF.canonical],
    },
    (page, site) => {
      const u = safeUrl(page.url);
      if (!isIndexable(page) || !u?.search || pageNumber(page.url) != null) return null;
      if (!declaredCanonical(page)) return null; // covered by canonical.missing
      const clean = `${u.origin}${u.pathname}`;
      const cleanPage = findPage(site, clean);
      if (!cleanPage || !isHtml200(cleanPage)) return null;
      return {
        checkId: 'canonical.parameter-self',
        message: `Self-canonical while the clean URL ${clean} also exists`,
      };
    },
  ),
  siteCheck(
    {
      id: 'canonical.all-to-homepage',
      category: 'canonical',
      pillar: T,
      title: 'Many pages canonicalise to the home page',
      why: 'A template that sets every canonical to the home page tells search engines to drop all those pages. It is a common and costly bug.',
      severity: 'critical',
      fixTier: 'guided',
      fix: 'Make the canonical on each page point to that page’s own URL. Check the template or SEO plugin setting that outputs it.',
      refs: [REF.canonical],
    },
    (site) => {
      const hits = htmlPages(site).filter((p) => {
        const c = declaredCanonical(p);
        return (
          c &&
          !isHomepage(p, site) &&
          sameSiteHost(c, site.origin) &&
          pathOf(c) === '/' &&
          !safeUrl(c)?.search &&
          pathOf(p.url) !== '/'
        );
      });
      if (hits.length < CANONICAL_TO_HOME_MIN) return null;
      return {
        checkId: 'canonical.all-to-homepage',
        message: `${hits.length} pages canonicalise to the home page`,
        evidence: list(hits.map((p) => pathOf(p.url))),
      } as Issue;
    },
  ),
];
