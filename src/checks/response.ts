/**
 * Response codes and redirects.
 */
import type { FetchResult, Issue, PageData, SiteContext } from '../core/types.js';
import {
  REF,
  finalStatus,
  findPage,
  header,
  homePage,
  htmlPages,
  inlinkCount,
  isHomepage,
  isHtml200,
  isIndexable,
  list,
  pageCheck,
  pathOf,
  plural,
  rawHead,
  safeUrl,
  sameSiteHost,
  sameUrl,
  siteCheck,
  truncate,
  wasRedirected,
} from './_util.js';
import * as cu from './_util.js';

export const LONG_CHAIN_HOPS = 3;
export const ERROR_RATE_HIGH = 0.1;
export const REDIRECT_TO_HOME_MIN = 5;
export const SOFT_404_MAX_WORDS = 150;
export const PROBE_TIMEOUT_MS = 10_000;

const T = 'technical' as const;

const SOFT_404_TEXT =
  /\b(page (was )?not found|404 error|error 404|page (you('re| are) looking for|you requested) (does not|doesn't|could not|cannot) (exist|be found)|no longer (exists|available)|nothing (was )?found|seite nicht gefunden|página no encontrada|page introuvable)\b/i;

function isSoft404(page: PageData): boolean {
  const signals = [page.title || '', page.headings.find((h) => h.level === 1)?.text || ''].join(
    ' ',
  );
  if (SOFT_404_TEXT.test(signals)) return true;
  return page.wordCount < SOFT_404_MAX_WORDS && SOFT_404_TEXT.test(page.text.slice(0, 600));
}

async function probe(site: SiteContext, url: string, follow = false): Promise<FetchResult | null> {
  try {
    return await site.fetcher.fetch(url, {
      followRedirects: follow,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBytes: 200_000,
    });
  } catch {
    return null;
  }
}

function randomPath(): string {
  return `/avc-check-${Math.random().toString(36).slice(2, 10)}-does-not-exist`;
}

function chainText(page: PageData): string {
  return truncate(
    [...page.redirects.map((h) => `${h.url} (${h.status})`), page.finalUrl].join(' → '),
    480,
  );
}

export const checks = [
  // -------------------------------------------------------------------------
  // Response codes
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'response.client-error',
      category: 'response',
      pillar: T,
      title: 'Internal URL returns a 4xx error',
      why: 'Links to missing pages waste crawl visits, lose the value of the links pointing at them and send visitors and AI agents to a dead end.',
      severity: 'high',
      fixTier: 'manual',
      fix: 'Restore the page, 301-redirect the URL to its closest replacement, or update the links that point to it.',
      refs: [REF.httpStatus],
    },
    (page, site) => {
      if (page.status < 400 || page.status >= 500 || [401, 403, 429].includes(page.status))
        return null;
      const n = inlinkCount(site, page.url);
      return {
        checkId: 'response.client-error',
        severity: n === 0 && !page.inSitemap ? 'medium' : 'high',
        message: `HTTP ${page.status}${n ? `, linked from ${plural(n, 'page')}` : ''}`,
        evidence: page.discoveredFrom.slice(0, 3).join(', ') || undefined,
      };
    },
  ),
  pageCheck(
    {
      id: 'response.server-error',
      category: 'response',
      pillar: T,
      title: 'Internal URL returns a 5xx error',
      why: 'Server errors stop crawling. If they persist Google slows down crawling of the whole site and drops the failing pages.',
      severity: 'critical',
      fixTier: 'manual',
      fix: 'Check the server and application logs for this URL and fix the error. Return 503 with Retry-After only for planned maintenance.',
      refs: [REF.httpStatus],
    },
    (page) =>
      page.status >= 500
        ? { checkId: 'response.server-error', message: `HTTP ${page.status}`, evidence: page.error }
        : null,
  ),
  pageCheck(
    {
      id: 'response.forbidden',
      category: 'response',
      pillar: T,
      title: 'Crawler received 401 or 403',
      why: 'A 401/403 on a public page usually means a firewall, bot protection or login rule blocks crawlers. Search and AI bots get the same answer.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'If the page is public, allow verified search and AI crawlers through the WAF or bot rules. If it is private, stop linking to it from public pages.',
      refs: [REF.httpStatus],
    },
    (page) =>
      page.status === 401 || page.status === 403
        ? { checkId: 'response.forbidden', message: `HTTP ${page.status} returned to the crawler` }
        : null,
  ),
  pageCheck(
    {
      id: 'response.rate-limited',
      category: 'response',
      pillar: T,
      title: 'Crawler was rate limited (429)',
      why: 'A 429 tells crawlers to slow down. Frequent 429s mean Googlebot and AI crawlers fetch fewer pages and pick up changes more slowly.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Raise rate limits for verified crawlers, add caching, or send Retry-After so crawlers back off politely.',
      refs: [REF.httpStatus],
    },
    (page) =>
      page.status === 429
        ? {
            checkId: 'response.rate-limited',
            message: 'HTTP 429 Too Many Requests',
            evidence: header(page, 'retry-after')
              ? `Retry-After: ${header(page, 'retry-after')}`
              : undefined,
          }
        : null,
  ),
  pageCheck(
    {
      id: 'response.network-error',
      category: 'response',
      pillar: T,
      title: 'Request failed or timed out',
      why: 'Timeouts, DNS failures and dropped connections look like an unavailable site to every crawler.',
      severity: 'high',
      fixTier: 'manual',
      fix: 'Check the server for slow or failing routes, TLS problems or a firewall dropping requests, then re-run the audit.',
      refs: [REF.httpStatus],
    },
    (page) =>
      page.status === 0 && !page.blockedByRobots
        ? {
            checkId: 'response.network-error',
            message: page.error
              ? `Request failed: ${truncate(page.error, 120)}`
              : 'No response received',
          }
        : null,
  ),
  pageCheck(
    {
      id: 'response.soft-404',
      category: 'response',
      pillar: T,
      title: 'Error page returned with status 200 (soft 404)',
      why: 'A "not found" page that returns 200 gets crawled and possibly indexed as a real page. Google reports these as soft 404s and wastes crawl on them.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Return a real 404 (or 410) status for missing content, or redirect the URL to a relevant live page.',
      refs: [REF.soft404],
    },
    (page) => {
      if (!isHtml200(page) || !isSoft404(page)) return null;
      return {
        checkId: 'response.soft-404',
        message: 'Page reads like an error page but returns 200',
        evidence: truncate(page.title || page.text.slice(0, 120)),
      };
    },
  ),
  pageCheck(
    {
      id: 'response.empty-body',
      category: 'response',
      pillar: T,
      title: 'HTML page with an empty body',
      why: 'A 200 response with no content gives crawlers nothing to index and is often a sign of a failing template or cache.',
      severity: 'high',
      fixTier: 'manual',
      fix: 'Find why the server returns an empty response for this URL (application error swallowed, cache serving an empty object) and fix it.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      if (page.bytes > 512 || (page.html || '').trim().length > 200) return null;
      return { checkId: 'response.empty-body', message: `Response is ${page.bytes} bytes` };
    },
  ),
  pageCheck(
    {
      id: 'response.content-type-missing',
      category: 'response',
      pillar: T,
      title: 'HTML served without a text/html content type',
      why: 'Crawlers decide how to process a file from its Content-Type. HTML sent as text/plain or with no type may not be parsed as a web page.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Send "Content-Type: text/html; charset=utf-8" for HTML pages.',
      refs: [REF.mdnHeaders + '/Content-Type'],
    },
    (page) => {
      if (page.status !== 200) return null;
      const ct = (page.contentType || '').toLowerCase();
      const looksHtml = /^\s*(<!doctype html|<html)/i.test(page.html || '');
      if (!looksHtml || ct.includes('html')) return null;
      return {
        checkId: 'response.content-type-missing',
        message: `HTML document sent as "${ct || 'no content type'}"`,
      };
    },
  ),
  pageCheck(
    {
      id: 'response.charset-missing',
      category: 'response',
      pillar: T,
      title: 'Character encoding not declared',
      why: 'Without a charset, browsers and crawlers may guess the wrong encoding and show garbled characters, especially for non-English text.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add <meta charset="utf-8"> as the first element in <head>, or send charset=utf-8 in the Content-Type header.',
      refs: ['https://html.spec.whatwg.org/multipage/semantics.html#charset'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      if (page.charset || /charset=/i.test(page.contentType || '')) return null;
      return {
        checkId: 'response.charset-missing',
        message: 'No charset in the Content-Type header or a meta tag',
      };
    },
  ),
  pageCheck(
    {
      id: 'response.charset-late',
      category: 'response',
      pillar: T,
      title: 'Charset declared too late in the document',
      why: 'The meta charset must appear within the first 1024 bytes. Later declarations can make the browser re-parse the page or decode it wrongly.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Move <meta charset="utf-8"> to be the first child of <head>.',
      refs: ['https://html.spec.whatwg.org/multipage/semantics.html#charset'],
    },
    (page) => {
      if (!isHtml200(page) || /charset=/i.test(page.contentType || '')) return null;
      const i = (page.html || '').search(/<meta[^>]+charset/i);
      if (i < 0 || Buffer.byteLength(page.html.slice(0, i)) <= 1024) return null;
      return {
        checkId: 'response.charset-late',
        message: `Meta charset starts at byte ${Buffer.byteLength(page.html.slice(0, i))}`,
      };
    },
  ),

  // -------------------------------------------------------------------------
  // Response codes (site)
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'response.homepage-error',
      category: 'response',
      pillar: T,
      title: 'Start URL does not return 200',
      why: 'If the home page fails, crawlers cannot reach anything else and AI agents treat the site as down.',
      severity: 'critical',
      fixTier: 'manual',
      fix: 'Make the home page return 200 for all user agents. Check firewall rules, redirects and server errors.',
    },
    (site) => {
      const stub = homePage(site);
      const home = stub?.redirects.length ? (findPage(site, stub.finalUrl) ?? stub) : stub;
      if (
        !home ||
        home.status === 200 ||
        (home.redirects.length && finalStatus(site, home) === 200)
      )
        return null;
      return {
        checkId: 'response.homepage-error',
        url: home.url,
        message: `Home page returned ${home.status || 'no response'}${home.error ? ` (${truncate(home.error, 80)})` : ''}`,
      };
    },
  ),
  siteCheck(
    {
      id: 'response.error-rate',
      category: 'response',
      pillar: T,
      title: 'High share of crawled URLs return errors',
      why: 'When many internal URLs fail, crawlers lose trust in the site and reduce how often they visit.',
      severity: 'high',
      fixTier: 'manual',
      fix: 'Work through the 4xx and 5xx URLs in this report: fix, redirect or unlink them.',
    },
    (site) => {
      const all = [...site.pages.values()].filter((p) => !p.blockedByRobots);
      if (all.length < 10) return null;
      const bad = all.filter(
        (p) => p.status >= 400 || (p.status === 0 && !p.blockedByRobots),
      ).length;
      if (bad / all.length < ERROR_RATE_HIGH) return null;
      return {
        checkId: 'response.error-rate',
        message: `${bad} of ${all.length} crawled URLs (${Math.round((100 * bad) / all.length)}%) returned an error`,
      };
    },
  ),
  siteCheck(
    {
      id: 'response.missing-page-returns-200',
      category: 'response',
      pillar: T,
      title: 'Non-existent URLs return 200',
      why: 'If any made-up URL returns 200, every broken link becomes an indexable duplicate (a site-wide soft 404) and crawlers cannot tell real pages from errors.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Configure the server or framework to return a 404 status for unknown routes. Single-page apps need a server-side catch-all that sets the status.',
      refs: [REF.soft404],
    },
    async (site) => {
      const r = await probe(site, site.origin + randomPath(), true);
      if (!r || r.status !== 200) return null;
      return {
        checkId: 'response.missing-page-returns-200',
        message: 'A random non-existent URL returned 200',
        evidence: r.url,
      };
    },
  ),
  siteCheck(
    {
      id: 'response.missing-page-redirects',
      category: 'response',
      pillar: T,
      title: 'Non-existent URLs redirect to another page',
      why: 'Redirecting every unknown URL (often to the home page) is treated as a soft 404 by Google and hides real broken links from you.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Let unknown URLs return 404 with a helpful error page. Redirect only URLs that have a genuine replacement.',
      refs: [REF.soft404],
    },
    async (site) => {
      const r = await probe(site, site.origin + randomPath(), false);
      if (!r || r.status < 300 || r.status >= 400) return null;
      return {
        checkId: 'response.missing-page-redirects',
        message: `A random non-existent URL returned ${r.status} to ${r.headers['location'] || 'another page'}`,
      };
    },
  ),
  siteCheck(
    {
      id: 'response.404-page-unhelpful',
      category: 'response',
      pillar: 'content',
      title: '404 page offers no way forward',
      why: 'A bare 404 page with no links loses the visitor. A helpful one keeps people and agents on the site.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Add a short message, a search box and links to the main sections on the 404 template. Keep the 404 status.',
    },
    async (site) => {
      const r = await probe(site, site.origin + randomPath(), true);
      if (!r || r.status !== 404 || !/html/i.test(r.contentType)) return null;
      const links = (r.body.match(/<a\s[^>]*href=/gi) || []).length;
      if (links >= 3) return null;
      return {
        checkId: 'response.404-page-unhelpful',
        message: `The 404 page has ${plural(links, 'link')}`,
      };
    },
  ),
  siteCheck(
    {
      id: 'response.homepage-duplicates',
      category: 'response',
      pillar: T,
      title: 'Home page reachable at several URLs',
      why: 'When /index.html, /index.php or /home also return 200 without a redirect or canonical, the home page is split across duplicate URLs.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Redirect these variants to the root URL with a 301, or at least add a canonical pointing to it.',
      refs: [REF.canonical],
    },
    async (site) => {
      const home = homePage(site);
      if (!home || home.status !== 200) return null;
      const variants = ['/index.html', '/index.php', '/home'];
      const found: string[] = [];
      for (const v of variants) {
        const r = await probe(site, site.origin + v, false);
        if (!r || r.status !== 200 || !/html/i.test(r.contentType)) continue;
        const canon = /<link[^>]+rel=["']?canonical["']?[^>]*href=["']([^"']+)/i.exec(
          rawHead(r.body),
        )?.[1];
        if (canon && sameUrl(new URL(canon, r.url).toString(), home.finalUrl)) continue;
        if (r.body.length < 500) continue;
        found.push(v);
      }
      if (!found.length) return null;
      return {
        checkId: 'response.homepage-duplicates',
        message: `${list(found)} return 200 without pointing to the home page`,
      };
    },
  ),

  // -------------------------------------------------------------------------
  // Redirects
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'redirects.chain',
      category: 'redirects',
      pillar: T,
      title: 'Redirect chain',
      why: 'Each extra hop slows users and crawlers down. Googlebot follows up to 10 hops but other crawlers give up sooner, and link value can be lost along the way.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Point the first URL straight at the final destination and update internal links to the final URL.',
      refs: [REF.redirects],
    },
    (page) => {
      if (page.redirects.length < 2) return null;
      return {
        checkId: 'redirects.chain',
        severity: page.redirects.length >= LONG_CHAIN_HOPS ? 'high' : 'medium',
        message: `${page.redirects.length} redirects before the final URL`,
        evidence: chainText(page),
      };
    },
  ),
  pageCheck(
    {
      id: 'redirects.loop',
      category: 'redirects',
      pillar: T,
      title: 'Redirect loop',
      why: 'A loop never reaches a page. Browsers show an error and crawlers drop the URL.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Find the conflicting rules (often http/https or trailing-slash rules fighting each other) and make one of them stop redirecting.',
      refs: [REF.redirects],
    },
    (page) => {
      const urls = page.redirects.map((h) => h.url);
      const repeated =
        urls.some((u, i) => urls.indexOf(u) !== i) || page.redirects.some((h) => h.status === 0);
      const errLoop = /redirect\s*loop|too many redirects/i.test(page.error || '');
      if (!repeated && !errLoop) return null;
      return {
        checkId: 'redirects.loop',
        message: 'The redirects for this URL go round in a loop',
        evidence: chainText(page),
      };
    },
  ),
  pageCheck(
    {
      id: 'redirects.temporary',
      category: 'redirects',
      pillar: T,
      title: 'Temporary redirect used',
      why: 'A 302 or 307 says the move is temporary, so search engines may keep the old URL indexed. Permanent moves should use 301 or 308.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'If the move is permanent, change the redirect to 301 (or 308).',
      refs: [REF.redirects],
    },
    (page) => {
      const temp = page.redirects.filter(
        (h) => h.status === 302 || h.status === 307 || h.status === 303,
      );
      if (!temp.length || !wasRedirected(page)) return null;
      return {
        checkId: 'redirects.temporary',
        message: `${temp.map((h) => h.status).join(', ')} redirect to ${page.finalUrl}`,
        evidence: chainText(page),
      };
    },
  ),
  pageCheck(
    {
      id: 'redirects.to-error',
      category: 'redirects',
      pillar: T,
      title: 'Redirect ends at an error',
      why: 'A redirect to a missing or failing page is a broken link with an extra step. Users and crawlers end up nowhere.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Point the redirect at a live, relevant page, or let the old URL return 404/410 if there is no replacement.',
      refs: [REF.redirects],
    },
    (page, site) => {
      if (!page.redirects.length || /redirect\s*loop|too many redirects/i.test(page.error || ''))
        return null;
      const fs = finalStatus(site, page);
      if (fs == null || (fs < 400 && fs !== 0)) return null;
      return {
        checkId: 'redirects.to-error',
        message: fs ? `Redirect leads to HTTP ${fs}` : 'Redirect target did not respond',
        evidence: chainText(page),
      };
    },
  ),
  pageCheck(
    {
      id: 'redirects.meta-refresh',
      category: 'redirects',
      pillar: T,
      title: 'Meta refresh or Refresh header redirect',
      why: 'Refresh redirects are slow, confusing for screen-reader users and only treated as a weak signal by search engines. Many AI crawlers do not follow them.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Replace the meta refresh with a server-side 301 redirect.',
      refs: [REF.redirects, 'https://www.w3.org/WAI/WCAG22/Techniques/failures/F41'],
    },
    (page) => {
      if (!page.isHtml || !page.html) return null;
      const m = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i.exec(page.html);
      const h = header(page, 'refresh');
      if (!m && !h) return null;
      const content = m ? (/content=["']?([^"'>]+)/i.exec(m[0])?.[1] ?? '') : h!;
      if (!/url\s*=/i.test(content)) return null; // plain auto-reload, not a redirect
      return {
        checkId: 'redirects.meta-refresh',
        message: 'Page redirects with a refresh instruction',
        evidence: truncate(m ? m[0] : `Refresh: ${h}`),
      };
    },
  ),
  pageCheck(
    {
      id: 'redirects.javascript',
      category: 'redirects',
      pillar: T,
      title: 'Page appears to redirect with JavaScript',
      why: 'JavaScript redirects only work for crawlers that render pages. Most AI crawlers do not, and Google recommends server-side redirects.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use a server-side 301 redirect instead of changing window.location in a script.',
      refs: [REF.redirects],
    },
    (page) => {
      if (!isHtml200(page) || page.wordCount > 150) return null;
      const m =
        /(?:window\.|document\.|top\.)?location(?:\.href)?\s*=\s*["'][^"']+["']|location\.replace\(\s*["'][^"']+["']\s*\)/i.exec(
          page.html || '',
        );
      if (!m) return null;
      return {
        checkId: 'redirects.javascript',
        message: 'Thin page that sets window.location in a script',
        evidence: truncate(m[0]),
      };
    },
  ),
  pageCheck(
    {
      id: 'redirects.https-to-http',
      category: 'redirects',
      pillar: T,
      title: 'Redirect downgrades from HTTPS to HTTP',
      why: 'A hop through HTTP exposes the request, triggers browser warnings and conflicts with HSTS. It also mixes protocol signals for search engines.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Make every redirect target an https:// URL.',
      refs: [REF.https],
    },
    (page) => {
      const hops = [...page.redirects.map((h) => h.url), page.finalUrl];
      for (let i = 1; i < hops.length; i++) {
        if (hops[i - 1].startsWith('https:') && hops[i].startsWith('http:'))
          return {
            checkId: 'redirects.https-to-http',
            message: `Redirect goes from ${hops[i - 1]} to ${hops[i]}`,
            evidence: chainText(page),
          };
      }
      return null;
    },
  ),
  pageCheck(
    {
      id: 'redirects.off-site',
      category: 'redirects',
      pillar: T,
      title: 'Internal URL redirects to another domain',
      why: 'An internal link that leaves the site is often a forgotten migration or a hijacked redirect. Link value leaves with it.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Check the destination is intended. Link directly to the external URL, or update the link to an internal page.',
    },
    (page, site) => {
      if (!wasRedirected(page) || !sameSiteHost(page.url, site.origin)) return null;
      if (sameSiteHost(page.finalUrl, site.origin)) return null;
      return {
        checkId: 'redirects.off-site',
        message: `Redirects off-site to ${page.finalUrl}`,
        evidence: chainText(page),
      };
    },
  ),
  pageCheck(
    {
      id: 'redirects.linked-internally',
      category: 'redirects',
      pillar: T,
      title: 'Redirecting URL is still linked internally',
      why: 'Internal links to redirects add a hop to every visit and crawl. Linking straight to the final URL is faster and a clearer signal.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Update the internal links to point at the final URL.',
      refs: [REF.redirects],
    },
    (page, site) => {
      if (!wasRedirected(page)) return null;
      const n = inlinkCount(site, page.url);
      if (!n) return null;
      return {
        checkId: 'redirects.linked-internally',
        message: `Linked from ${plural(n, 'internal page')}; redirects to ${page.finalUrl}`,
        evidence: page.discoveredFrom.slice(0, 3).join(', ') || undefined,
      };
    },
  ),

  // -------------------------------------------------------------------------
  // Redirects (site)
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'redirects.many-to-homepage',
      category: 'redirects',
      pillar: T,
      title: 'Many URLs redirect to the home page',
      why: 'Mass redirects to the home page are treated as soft 404s by Google, so the old URLs pass on nothing.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Redirect each old URL to its closest matching page, or let it return 404/410.',
      refs: [REF.redirects],
    },
    (site) => {
      const home = homePage(site);
      if (!home) return null;
      const to = [...site.pages.values()].filter(
        (p) =>
          wasRedirected(p) &&
          !isHomepage(p, site) &&
          pathOf(p.url) !== '/' &&
          sameSiteHost(p.finalUrl, site.origin) &&
          pathOf(p.finalUrl) === '/',
      );
      if (to.length < REDIRECT_TO_HOME_MIN) return null;
      return {
        checkId: 'redirects.many-to-homepage',
        message: `${to.length} URLs redirect to the home page`,
        evidence: list(to.map((p) => pathOf(p.url))),
      };
    },
  ),
  siteCheck(
    {
      id: 'redirects.http-not-redirected',
      category: 'redirects',
      pillar: T,
      title: 'HTTP version of the site does not redirect to HTTPS',
      why: 'If http:// pages return 200, there are two copies of the site, visitors can land on the insecure one and signals are split.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Add a site-wide 301 redirect from http:// to https:// and enable HSTS.',
      refs: [REF.https],
    },
    async (site) => {
      if (!site.origin.startsWith('https:')) return null;
      const r = await probe(site, site.origin.replace(/^https:/, 'http:') + '/', false);
      if (!r || r.status !== 200) return null;
      return {
        checkId: 'redirects.http-not-redirected',
        message: 'http:// home page returns 200 instead of redirecting',
      };
    },
  ),
  siteCheck(
    {
      id: 'redirects.http-temporary',
      category: 'redirects',
      pillar: T,
      title: 'HTTP to HTTPS redirect is temporary',
      why: 'A 302 from http to https tells search engines the http URL may come back, so they may keep it as the canonical.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Use a 301 or 308 for the http to https redirect.',
      refs: [REF.https, REF.redirects],
    },
    async (site) => {
      if (!site.origin.startsWith('https:')) return null;
      const r = await probe(site, site.origin.replace(/^https:/, 'http:') + '/', false);
      if (!r || ![302, 303, 307].includes(r.status)) return null;
      return {
        checkId: 'redirects.http-temporary',
        message: `http:// redirects with ${r.status}`,
        evidence: r.headers['location'],
      };
    },
  ),
  siteCheck(
    {
      id: 'redirects.host-variants',
      category: 'redirects',
      pillar: T,
      title: 'Both www and non-www hosts serve the site',
      why: 'If example.com and www.example.com both return pages, the site exists twice and search engines have to guess which one to use.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Choose one host and 301-redirect the other to it, keeping the path.',
      refs: [REF.canonical],
    },
    async (site) => {
      const u = safeUrl(site.origin);
      if (!u || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname === 'localhost') return null;
      const other = u.hostname.startsWith('www.') ? u.hostname.slice(4) : 'www.' + u.hostname;
      const r = await probe(site, `${u.protocol}//${other}/`, false);
      if (!r || r.status !== 200 || !/html/i.test(r.contentType)) return null;
      const canon = /<link[^>]+rel=["']?canonical["']?[^>]*href=["']([^"']+)/i.exec(
        rawHead(r.body),
      )?.[1];
      if (canon && sameSiteHost(canon, site.origin) && safeUrl(canon)?.hostname === u.hostname)
        return null;
      return {
        checkId: 'redirects.host-variants',
        message: `${other} returns 200 instead of redirecting to ${u.hostname}`,
      };
    },
  ),
  siteCheck(
    {
      id: 'redirects.trailing-slash-duplicates',
      category: 'redirects',
      pillar: T,
      title: 'URLs work with and without a trailing slash',
      why: 'When /page and /page/ both return 200 without one pointing to the other, each page has a duplicate.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Pick one style and 301-redirect the other, or make sure both carry the same canonical.',
      refs: [REF.urlStructure],
    },
    async (site) => {
      const sample = htmlPages(site).find((p) => {
        const path = pathOf(p.url);
        return (
          path.length > 1 &&
          !safeUrl(p.url)?.search &&
          !/\.[a-z0-9]{2,5}$/i.test(path) &&
          isIndexable(p)
        );
      });
      if (!sample) return null;
      const u = new URL(sample.url);
      u.pathname = u.pathname.endsWith('/') ? u.pathname.replace(/\/+$/, '') : u.pathname + '/';
      const r = await probe(site, u.toString(), false);
      if (!r || r.status !== 200 || !/html/i.test(r.contentType)) return null;
      const canon = /<link[^>]+rel=["']?canonical["']?[^>]*href=["']([^"']+)/i.exec(
        rawHead(r.body),
      )?.[1];
      if (canon && sameUrl(new URL(canon, r.url).toString(), sample.url)) return null;
      return {
        checkId: 'redirects.trailing-slash-duplicates',
        url: sample.url,
        message: `${u.toString()} also returns 200 without a canonical to ${sample.url}`,
      };
    },
  ),
  siteCheck(
    {
      id: 'redirects.case-duplicates',
      category: 'redirects',
      pillar: T,
      title: 'Upper-case URL variants return 200',
      why: 'URLs are case-sensitive. If /Page and /page both serve the same content without a redirect or canonical, each page can be duplicated many times.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Redirect mixed-case requests to the lower-case URL, or add a self-referencing canonical on every page.',
      refs: [REF.urlStructure],
    },
    async (site) => {
      const sample = htmlPages(site).find(
        (p) => /[a-z]{3}/.test(pathOf(p.url)) && !safeUrl(p.url)?.search && isIndexable(p),
      );
      if (!sample) return null;
      const u = new URL(sample.url);
      u.pathname = u.pathname.toUpperCase();
      const r = await probe(site, u.toString(), false);
      if (!r || r.status !== 200 || !/html/i.test(r.contentType)) return null;
      const canon = /<link[^>]+rel=["']?canonical["']?[^>]*href=["']([^"']+)/i.exec(
        rawHead(r.body),
      )?.[1];
      if (canon && sameUrl(new URL(canon, r.url).toString(), sample.url)) return null;
      return {
        checkId: 'redirects.case-duplicates',
        url: sample.url,
        message: `${u.pathname} returns 200 as a separate page`,
      };
    },
  ),
];

export const _internal = { isSoft404, findPage };
export type { Issue };

// ---------------------------------------------------------------------------
// Added for feature parity: doctype and consistent redirect codes
// ---------------------------------------------------------------------------

/** True when the document starts with <!DOCTYPE html> (after a BOM, whitespace and comments). */
export function hasHtmlDoctype(html: string): boolean {
  const start = html
    .replace(/^﻿/, '')
    .replace(/^(\s|<!--[\s\S]*?-->|<\?xml[^>]*\?>)*/, '')
    .slice(0, 200);
  return /^<!doctype\s+html/i.test(start);
}

const PERMANENT = new Set([301, 308]);
const TEMPORARY = new Set([302, 303, 307]);

checks.push(
  cu.pageCheck(
    {
      id: 'response.doctype-missing',
      category: 'response',
      pillar: T,
      title: 'Missing or misplaced <!DOCTYPE html>',
      why: 'Without <!DOCTYPE html> as the first thing in the document, browsers fall back to quirks mode: layout, box sizes and font sizes can differ from what you designed, which affects mobile usability and layout shift. Some parsers also misread the head.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Make <!DOCTYPE html> the very first line of every HTML response, before any whitespace-sensitive output, comments from plugins or <html>.',
      refs: ['https://developer.mozilla.org/en-US/docs/Web/HTML/Quirks_Mode_and_Standards_Mode'],
    },
    (page) => {
      if (!cu.isHtml200(page) || !page.html) return null;
      if (hasHtmlDoctype(page.html)) return null;
      const later = /<!doctype\s+html/i.test(page.html.slice(0, 20_000));
      return {
        checkId: 'response.doctype-missing',
        message: later
          ? 'A doctype is present but not first in the document'
          : 'The HTML has no <!DOCTYPE html>',
        evidence: cu.truncate(page.html.slice(0, 120)),
      };
    },
  ),
  cu.siteCheck(
    {
      id: 'redirects.mixed-status',
      category: 'redirects',
      pillar: T,
      title: 'Same section redirects with both permanent and temporary codes',
      why: 'After a migration or URL change, redirects in one section are usually made by one rule. When some old URLs answer 301 and others 302, part of the mapping was set up differently (a plugin, a server rule, an old leftover), and the temporary ones may keep the old URLs in the index.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Find the rule behind the temporary redirects in the listed sections and make every permanent move a 301 or 308, from one place.',
      refs: [cu.REF.redirects],
    },
    (site) => {
      const groups = new Map<string, { perm: string[]; temp: string[] }>();
      for (const p of site.pages.values()) {
        if (!p.redirects.length || !cu.wasRedirected(p)) continue;
        const code = p.redirects[0]!.status;
        if (!PERMANENT.has(code) && !TEMPORARY.has(code)) continue;
        let section = '/';
        try {
          section = '/' + (new URL(p.url).pathname.split('/')[1] ?? '');
        } catch {
          /* keep root */
        }
        const g = groups.get(section) ?? { perm: [], temp: [] };
        (PERMANENT.has(code) ? g.perm : g.temp).push(`${p.url} (${code})`);
        groups.set(section, g);
      }
      const out: Issue[] = [];
      for (const [section, g] of groups) {
        if (g.perm.length < 2 || g.temp.length < 1) continue;
        out.push({
          checkId: 'redirects.mixed-status',
          message: `${section}: ${g.perm.length} permanent and ${g.temp.length} temporary redirects`,
          evidence: cu.list(g.temp, 5),
          data: { section, permanent: g.perm.length, temporary: g.temp.length },
        });
      }
      return out;
    },
  ),
);
