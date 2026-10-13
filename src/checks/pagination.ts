/**
 * Paginated series: rel next/prev, canonical and noindex handling, crawl paths.
 */
import type { SiteContext } from '../core/types.js';
import {
  REF,
  declaredCanonical,
  doc,
  findPage,
  htmlPages,
  isHtml200,
  isNoindex,
  pageCheck,
  pageNumber,
  rawHead,
  safeUrl,
  sameUrl,
  siteCheck,
  truncate,
} from './_util.js';

export const OUT_OF_RANGE_PAGE = 9999;

const T = 'technical' as const;

function firstPageUrl(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return null;
  for (const k of ['page', 'p', 'pg', 'paged']) u.searchParams.delete(k);
  u.pathname = u.pathname.replace(/\/(page|seite|pagina|p)\/\d+\/?$/i, '/');
  return u.toString().replace(/\?$/, '');
}

export const checks = [
  pageCheck(
    {
      id: 'pagination.canonical-to-first',
      category: 'pagination',
      pillar: T,
      title: 'Page 2+ canonicalises to page 1',
      why: 'Each page in a series lists different items. Canonicalising them all to page 1 tells search engines to ignore those items, so products or posts further down are discovered less.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Give each paginated page a self-referencing canonical (or canonicalise to a view-all page if one exists).',
      refs: [REF.pagination],
    },
    (page) => {
      const n = pageNumber(page.url);
      const c = declaredCanonical(page);
      if (!isHtml200(page) || !n || n < 2 || !c) return null;
      const first = firstPageUrl(page.url);
      if (!first || !sameUrl(c, first)) return null;
      return {
        checkId: 'pagination.canonical-to-first',
        message: `Page ${n} canonicalises to the first page`,
        evidence: c,
      };
    },
  ),
  pageCheck(
    {
      id: 'pagination.noindex',
      category: 'pagination',
      pillar: T,
      title: 'Paginated pages are noindex',
      why: 'Noindex on page 2+ is allowed, but over time Google may stop following links on noindex pages, so items listed only there can become hard to reach.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Let paginated pages be indexed with self-canonicals, or make sure every item is also linked from somewhere indexable.',
      refs: [REF.pagination],
    },
    (page) => {
      const n = pageNumber(page.url);
      return isHtml200(page) && n && n >= 2 && isNoindex(page)
        ? { checkId: 'pagination.noindex', message: `Page ${n} of a series is noindex` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'pagination.next-broken',
      category: 'pagination',
      pillar: T,
      title: 'rel="next" or rel="prev" points to an error',
      why: 'Broken pagination links stop crawlers walking the series, and Bing still uses these hints.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Point rel next/prev at live pages, and omit rel="next" on the last page.',
      refs: [REF.pagination],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      for (const [rel, url] of [
        ['next', page.pagination.next],
        ['prev', page.pagination.prev],
      ] as const) {
        if (!url) continue;
        const t = findPage(site, url);
        if (t && (t.status >= 400 || (t.status === 0 && !t.blockedByRobots)))
          return {
            checkId: 'pagination.next-broken',
            message: `rel="${rel}" target returns ${t.status || 'no response'}`,
            evidence: url,
          };
      }
      return null;
    },
  ),
  pageCheck(
    {
      id: 'pagination.sequence-mismatch',
      category: 'pagination',
      pillar: T,
      title: 'rel="next" target does not point back with rel="prev"',
      why: 'When page 2 does not name page 1 as prev, the series is inconsistent and crawlers may not treat it as one sequence.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Make each next page declare the current page as its rel="prev".',
      refs: [REF.pagination],
    },
    (page, site) => {
      if (!isHtml200(page) || !page.pagination.next) return null;
      const t = findPage(site, page.pagination.next);
      if (!t || !isHtml200(t) || !t.pagination.prev) return null;
      if (sameUrl(t.pagination.prev, page.url) || sameUrl(t.pagination.prev, page.finalUrl))
        return null;
      return {
        checkId: 'pagination.sequence-mismatch',
        message: `Next page’s rel="prev" is ${t.pagination.prev}`,
        evidence: page.pagination.next,
      };
    },
  ),
  pageCheck(
    {
      id: 'pagination.multiple-rel',
      category: 'pagination',
      pillar: T,
      title: 'Several rel="next" or rel="prev" tags',
      why: 'A page can only have one next and one previous page. Duplicates make the sequence ambiguous.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Keep one rel="next" and one rel="prev" per page.',
    },
    (page) => {
      if (!isHtml200(page) || !page.html) return null;
      const head = rawHead(page.html);
      const next = (head.match(/<link[^>]+rel=["']?next["']?/gi) || []).length;
      const prev = (head.match(/<link[^>]+rel=["']?prev(ious)?["']?/gi) || []).length;
      return next > 1 || prev > 1
        ? {
            checkId: 'pagination.multiple-rel',
            message: `${next} rel="next" and ${prev} rel="prev" tags`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'pagination.page-one-duplicate',
      category: 'pagination',
      pillar: T,
      title: 'Links to "page 1" create a duplicate URL',
      why: 'Linking to ?page=1 or /page/1/ creates a second URL for the first page of a series.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Link to the clean URL for page 1, and redirect ?page=1 and /page/1/ to it.',
      refs: [REF.pagination],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const hit = page.links.find((l) => l.internal && pageNumber(l.href) === 1);
      return hit
        ? {
            checkId: 'pagination.page-one-duplicate',
            message: 'Links to an explicit page 1 URL',
            evidence: hit.href,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'pagination.load-more-only',
      category: 'pagination',
      pillar: T,
      title: '"Load more" or infinite scroll without page links',
      why: 'Crawlers do not click buttons or scroll. Items loaded only by "load more" or infinite scroll are invisible unless there are plain paginated links too.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Back the button with real <a href="?page=2"> links (the button can enhance them with JavaScript).',
      refs: [REF.pagination],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const d = doc(page);
      const btn = Array.from(d.querySelectorAll('button, [role="button"]')).find((b) =>
        /\b(load|show|view) more\b/i.test(b.textContent || ''),
      );
      if (!btn) return null;
      if (
        page.pagination.next ||
        page.links.some((l) => l.internal && (pageNumber(l.href) ?? 0) >= 2)
      )
        return null;
      return {
        checkId: 'pagination.load-more-only',
        message: 'A "load more" button with no crawlable page links',
        evidence: truncate(btn.outerHTML, 150),
      };
    },
  ),
  pageCheck(
    {
      id: 'pagination.fragment',
      category: 'pagination',
      pillar: T,
      title: 'Pagination uses # fragments',
      why: 'Search engines ignore everything after #, so "#page=2" pages are never crawled as separate pages.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Use query parameters (?page=2) or paths (/page/2/) for paginated pages.',
      refs: [REF.pagination],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const a = doc(page).querySelector('a[href*="#page"], a[href*="#p="], a[href*="#!page"]');
      return a
        ? {
            checkId: 'pagination.fragment',
            message: 'Pagination links rely on # fragments',
            evidence: a.getAttribute('href') || '',
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'pagination.out-of-range-200',
      category: 'pagination',
      pillar: T,
      title: 'Out-of-range page numbers return 200',
      why: 'If ?page=9999 returns an empty page with status 200, crawlers can generate endless empty pages that look like soft 404s.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Return 404 for page numbers beyond the last page.',
      refs: [REF.pagination, REF.soft404],
    },
    async (site: SiteContext) => {
      const sample = htmlPages(site).find((p) => (pageNumber(p.url) ?? 0) >= 2);
      if (!sample) return null;
      const u = new URL(sample.url);
      if ([...u.searchParams.keys()].some((k) => ['page', 'p', 'pg', 'paged'].includes(k))) {
        for (const k of ['page', 'p', 'pg', 'paged'])
          if (u.searchParams.has(k)) u.searchParams.set(k, String(OUT_OF_RANGE_PAGE));
      } else u.pathname = u.pathname.replace(/\/(\d+)(\/?)$/, `/${OUT_OF_RANGE_PAGE}$2`);
      try {
        const r = await site.fetcher.fetch(u.toString(), { timeoutMs: 10_000, maxBytes: 200_000 });
        if (r.status !== 200 || !sameUrl(r.finalUrl, u.toString())) return null;
        return {
          checkId: 'pagination.out-of-range-200',
          url: sample.url,
          message: `Page ${OUT_OF_RANGE_PAGE} returns 200`,
          evidence: u.toString(),
        };
      } catch {
        return null;
      }
    },
  ),
];
