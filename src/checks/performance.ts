/**
 * Performance: from raw crawl data (weight, TTFB, compression, caching,
 * render-blocking), from PageSpeed Insights (Core Web Vitals), and from
 * rendered timings.
 */
import type { Issue, PageData, PsiResult, SiteContext } from '../core/types.js';
import {
  REF,
  findPage,
  header,
  htmlPages,
  isHtml200,
  list,
  pageCheck,
  pathOf,
  plural,
  rawHead,
  safeUrl,
  siteCheck,
  truncate,
} from './_util.js';
import * as cu from './_util.js';

export const HTML_HEAVY_BYTES = 500 * 1024;
export const HTML_VERY_HEAVY_BYTES = 2 * 1024 * 1024;
export const TTFB_SLOW_MS = 800;
export const TTFB_VERY_SLOW_MS = 1800;
export const DOWNLOAD_SLOW_MS = 3000;
export const COMPRESS_MIN_BYTES = 10 * 1024;
export const HEAD_STYLESHEETS_MAX = 5;
export const SCRIPTS_MAX = 30;
export const REQUESTS_MAX = 100;
export const THIRD_PARTY_HOSTS_MAX = 10;
export const PAGE_IMAGE_BYTES_MAX = 2 * 1024 * 1024;
export const PAGE_SCRIPT_BYTES_MAX = 1024 * 1024;
export const PAGE_TOTAL_BYTES_MAX = 3 * 1024 * 1024;
export const INLINE_SCRIPT_MAX = 100 * 1024;
export const INLINE_STYLE_MAX = 50 * 1024;
export const UNMINIFIED_MIN_BYTES = 10 * 1024;
export const DOM_ELEMENTS_MAX = 1500;
export const ASSET_CACHE_MIN_SECONDS = 7 * 86_400;
export const LCP_GOOD = 2500;
export const LCP_POOR = 4000;
export const CLS_GOOD = 0.1;
export const CLS_POOR = 0.25;
export const INP_GOOD = 200;
export const INP_POOR = 500;
export const TBT_HIGH = 600;
export const FCP_SLOW = 1800;
export const FCP_VERY_SLOW = 3000;
export const PSI_SCORE_POOR = 50;
export const PSI_SCORE_OK = 90;
export const PSI_OPPORTUNITY_MIN_MS = 500;
export const RENDER_LOAD_SLOW_MS = 5000;

const T = 'technical' as const;

function psiResults(site: SiteContext): PsiResult[] {
  return Object.values(site.external.psi ?? {}).filter((r) => r && !r.error);
}

function psiIssues(
  site: SiteContext,
  checkId: string,
  pick: (r: PsiResult) => { value: number; source: 'field' | 'lab' } | null,
  judge: (v: number) => 'high' | 'medium' | null,
  fmt: (v: number) => string,
): Issue[] {
  const out: Issue[] = [];
  for (const r of psiResults(site)) {
    const v = pick(r);
    if (!v) continue;
    const sev = judge(v.value);
    if (!sev) continue;
    out.push({
      checkId,
      url: r.url,
      severity: sev,
      message: `${fmt(v.value)} on ${r.strategy} (${v.source === 'field' ? 'real-user data' : 'lab test'})`,
      data: { value: v.value, strategy: r.strategy, source: v.source },
    });
  }
  return out;
}

function fieldOrLab(field: number | undefined, lab: number | undefined) {
  if (typeof field === 'number') return { value: field, source: 'field' as const };
  if (typeof lab === 'number') return { value: lab, source: 'lab' as const };
  return null;
}

function headScripts(page: PageData): string[] {
  const head = rawHead(page.html || '');
  return [...head.matchAll(/<script\b([^>]*)>/gi)]
    .map((m) => m[1])
    .filter(
      (attrs) =>
        /\bsrc=/i.test(attrs) &&
        !/\b(async|defer)\b/i.test(attrs) &&
        !/type=["']?(module|application\/ld\+json|text\/template|text\/x-template)/i.test(attrs),
    )
    .map((attrs) => /\bsrc=["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? '');
}

/** Hosts listed in the crawl option `cdns` serve the site's own files. */
export function isOwnCdn(host: string, site: SiteContext): boolean {
  const h = host.toLowerCase();
  return (site.options?.cdns ?? []).some((c) => {
    const x = c
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    return h === x || h.endsWith(`.${x}`);
  });
}

function thirdPartyHosts(page: PageData, site: SiteContext): Set<string> {
  const own = (safeUrl(site.origin)?.hostname ?? '').replace(/^www\./, '');
  const hosts = new Set<string>();
  for (const s of page.scripts) {
    const h = s.src ? safeUrl(s.src)?.hostname : null;
    if (h && !h.replace(/^www\./, '').endsWith(own) && !isOwnCdn(h, site)) hosts.add(h);
  }
  return hosts;
}

function rendered(page: PageData) {
  return page.rendered?.timings;
}

export const checks = [
  // -------------------------------------------------------------------------
  // From raw crawl data
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'performance.html-heavy',
      category: 'performance',
      pillar: T,
      title: 'HTML document is very large',
      why: 'A heavy HTML file is slow on mobile, and crawlers have size limits: Googlebot stops reading HTML after a fixed number of megabytes and many AI crawlers cut off far sooner.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Move inline data, SVG sprites and scripts into cached files, paginate long lists and remove unused markup.',
      refs: [
        'https://developers.google.com/search/docs/crawling-indexing/googlebot#how-googlebot-accesses-your-site',
      ],
    },
    (page) => {
      if (!isHtml200(page) || page.bytes < HTML_HEAVY_BYTES) return null;
      return {
        checkId: 'performance.html-heavy',
        severity: page.bytes >= HTML_VERY_HEAVY_BYTES ? 'high' : 'medium',
        message: `HTML is ${Math.round(page.bytes / 1024)} KB`,
      };
    },
  ),
  pageCheck(
    {
      id: 'performance.ttfb-slow',
      category: 'performance',
      pillar: T,
      title: 'Slow server response (TTFB)',
      why: 'Time to first byte delays everything else on the page. Slow responses also reduce how many pages crawlers fetch per visit, and AI fetchers time out.',
      severity: 'medium',
      fixTier: 'guided',
      fix: `Cache pages at the CDN or server, speed up database queries and keep TTFB under ${TTFB_SLOW_MS} ms.`,
      refs: [REF.ttfb],
    },
    (page) => {
      if (!isHtml200(page) || page.ttfbMs < TTFB_SLOW_MS) return null;
      return {
        checkId: 'performance.ttfb-slow',
        severity: page.ttfbMs >= TTFB_VERY_SLOW_MS ? 'high' : 'medium',
        message: `Time to first byte was ${page.ttfbMs} ms`,
        data: { ttfbMs: page.ttfbMs },
      };
    },
  ),
  pageCheck(
    {
      id: 'performance.slow-download',
      category: 'performance',
      pillar: T,
      title: 'HTML takes a long time to download',
      why: 'A slow complete response delays rendering and wastes crawler time, especially on heavy pages.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Reduce HTML size, enable compression and stream or cache the response.',
    },
    (page) =>
      isHtml200(page) && page.totalMs >= DOWNLOAD_SLOW_MS && page.ttfbMs < TTFB_SLOW_MS
        ? { checkId: 'performance.slow-download', message: `Full response took ${page.totalMs} ms` }
        : null,
  ),
  pageCheck(
    {
      id: 'performance.no-compression',
      category: 'performance',
      pillar: T,
      title: 'HTML is not compressed',
      why: 'Gzip or Brotli shrinks HTML by around 70–80%, so uncompressed pages are much slower to download for people and crawlers.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Enable Brotli or gzip on the server or CDN for text/html, CSS, JavaScript, JSON and XML.',
      refs: ['https://web.dev/articles/reduce-network-payloads-using-text-compression'],
    },
    (page) => {
      if (!isHtml200(page) || page.bytes < COMPRESS_MIN_BYTES) return null;
      const enc = (header(page, 'content-encoding') || '').toLowerCase();
      if (/br|gzip|deflate|zstd/.test(enc)) return null;
      return {
        checkId: 'performance.no-compression',
        message: `${Math.round(page.bytes / 1024)} KB of HTML sent without compression`,
      };
    },
  ),
  pageCheck(
    {
      id: 'performance.render-blocking-scripts',
      category: 'performance',
      pillar: T,
      title: 'Render-blocking scripts in <head>',
      why: 'Synchronous scripts in <head> stop the browser drawing anything until they download and run, which delays First and Largest Contentful Paint.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add defer (or async for independent scripts) to scripts in <head>, or move them to the end of <body>.',
      refs: [REF.renderBlocking],
      tags: ['core-web-vitals'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const s = headScripts(page);
      return s.length
        ? {
            checkId: 'performance.render-blocking-scripts',
            message: `${plural(s.length, 'blocking script')} in <head>`,
            evidence: list(
              s.map((x) => pathOf(x) || x),
              4,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.render-blocking-css',
      category: 'performance',
      pillar: T,
      title: 'Many stylesheets block rendering',
      why: `Every stylesheet in <head> must load before the page paints. More than ${HEAD_STYLESHEETS_MAX} separate files adds round trips.`,
      severity: 'low',
      fixTier: 'guided',
      fix: 'Combine stylesheets, inline the critical CSS and load the rest without blocking (media="print" swap or preload).',
      refs: [REF.renderBlocking],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const blocking = page.stylesheets.filter(
        (s) => !s.media || /^(all|screen)$/i.test(s.media.trim()),
      );
      return blocking.length > HEAD_STYLESHEETS_MAX
        ? {
            checkId: 'performance.render-blocking-css',
            message: `${blocking.length} render-blocking stylesheets`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.too-many-scripts',
      category: 'performance',
      pillar: T,
      title: 'Many external scripts',
      why: 'Each script costs a request plus parse and run time on the main thread, which hurts responsiveness (INP).',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Remove unused scripts and tags, bundle your own scripts and load third-party ones only where needed.',
      refs: [REF.inp],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const n = page.scripts.filter((s) => s.src).length;
      return n > SCRIPTS_MAX
        ? { checkId: 'performance.too-many-scripts', message: `${n} external scripts` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.too-many-requests',
      category: 'performance',
      pillar: T,
      title: 'Page makes many requests',
      why: 'Lots of separate files (scripts, styles, images) slow loading on mobile networks.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Bundle assets, lazy-load images below the fold and drop unused third-party resources.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const n =
        page.scripts.filter((s) => s.src).length +
        page.stylesheets.length +
        new Set(page.images.map((i) => i.src)).size +
        page.iframes.length;
      return n > REQUESTS_MAX
        ? {
            checkId: 'performance.too-many-requests',
            message: `About ${n} resources referenced in the HTML`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.third-party-heavy',
      category: 'performance',
      pillar: T,
      title: 'Scripts from many third-party hosts',
      why: 'Each third-party host needs its own connection and runs code you do not control. Chat widgets, tag managers and ad scripts are the usual cause of poor INP.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Audit third-party tags, remove ones nobody uses and load the rest after the page is interactive.',
      refs: [
        'https://web.dev/articles/optimizing-content-efficiency-loading-third-party-javascript',
      ],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const hosts = thirdPartyHosts(page, site);
      return hosts.size > THIRD_PARTY_HOSTS_MAX
        ? {
            checkId: 'performance.third-party-heavy',
            message: `Scripts from ${hosts.size} third-party hosts`,
            evidence: list([...hosts], 6),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.duplicate-scripts',
      category: 'performance',
      pillar: T,
      title: 'Same script loaded twice',
      why: 'Loading a script twice doubles its cost and can make it run twice (double tracking, double event handlers).',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Remove the duplicate include. It often comes from a theme and a plugin both adding the same library.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const seen = new Map<string, number>();
      for (const s of page.scripts) if (s.src) seen.set(s.src, (seen.get(s.src) ?? 0) + 1);
      const dups = [...seen].filter(([, n]) => n > 1).map(([s]) => s);
      const jq = page.scripts.filter(
        (s) => s.src && /jquery(\.min)?(-[\d.]+)?\.js/i.test(s.src) && !/migrate|ui/i.test(s.src),
      );
      if (jq.length > 1 && new Set(jq.map((s) => s.src)).size > 1)
        dups.push('jQuery loaded in several versions');
      return dups.length
        ? {
            checkId: 'performance.duplicate-scripts',
            message: `${plural(dups.length, 'duplicated script')}`,
            evidence: list(
              dups.map((d) => pathOf(d) || d),
              3,
            ),
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.image-weight',
      category: 'performance',
      pillar: T,
      title: 'Images on the page are very heavy in total',
      why: 'Total image weight drives how long a page takes on mobile data, and the biggest image is often the LCP element.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Compress and resize images, serve WebP/AVIF and lazy-load below-the-fold images.',
      refs: [REF.lcp],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const seen = new Map<string, number>();
      for (const i of page.images) if (i.bytes) seen.set(i.src, i.bytes);
      const total = [...seen.values()].reduce((a, b) => a + b, 0);
      return total > PAGE_IMAGE_BYTES_MAX
        ? {
            checkId: 'performance.image-weight',
            message: `${(total / 1048576).toFixed(1)} MB of images`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.script-weight',
      category: 'performance',
      pillar: T,
      title: 'Large amount of JavaScript',
      why: 'JavaScript is the most expensive byte on the web: it must download, parse and run, which blocks interaction on mid-range phones.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Split bundles by route, remove unused libraries and defer non-essential scripts.',
      refs: ['https://web.dev/articles/reduce-javascript-payloads-with-code-splitting'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const total = page.scripts.reduce((n, s) => n + (s.bytes || 0), 0);
      return total > PAGE_SCRIPT_BYTES_MAX
        ? {
            checkId: 'performance.script-weight',
            message: `${(total / 1048576).toFixed(1)} MB of JavaScript`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.page-weight',
      category: 'performance',
      pillar: T,
      title: 'Total page weight is high',
      why: 'Pages over a few megabytes load slowly on mobile and cost visitors data.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Reduce the biggest contributors first: images, then JavaScript, then fonts and HTML.',
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const imgs = new Map<string, number>();
      for (const i of page.images) if (i.bytes) imgs.set(i.src, i.bytes);
      const total =
        page.bytes +
        [...imgs.values()].reduce((a, b) => a + b, 0) +
        page.scripts.reduce((n, s) => n + (s.bytes || 0), 0);
      return total > PAGE_TOTAL_BYTES_MAX
        ? {
            checkId: 'performance.page-weight',
            message: `About ${(total / 1048576).toFixed(1)} MB in HTML, images and scripts`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.inline-script-heavy',
      category: 'performance',
      pillar: T,
      title: 'Large inline scripts',
      why: 'Inline scripts are re-downloaded with every page and cannot be cached. Large hydration payloads also bloat the HTML that crawlers fetch.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Move large inline scripts into external cached files and trim serialised page data.',
    },
    (page) =>
      isHtml200(page) && page.inlineScriptBytes > INLINE_SCRIPT_MAX
        ? {
            checkId: 'performance.inline-script-heavy',
            message: `${Math.round(page.inlineScriptBytes / 1024)} KB of inline script`,
          }
        : null,
  ),
  pageCheck(
    {
      id: 'performance.inline-style-heavy',
      category: 'performance',
      pillar: T,
      title: 'Large inline styles',
      why: 'Inlining a little critical CSS helps; inlining the whole stylesheet makes every page heavier and uncacheable.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Inline only above-the-fold CSS and load the rest from a cached stylesheet.',
    },
    (page) =>
      isHtml200(page) && page.inlineStyleBytes > INLINE_STYLE_MAX
        ? {
            checkId: 'performance.inline-style-heavy',
            message: `${Math.round(page.inlineStyleBytes / 1024)} KB of inline CSS`,
          }
        : null,
  ),
  pageCheck(
    {
      id: 'performance.unminified-inline',
      category: 'performance',
      pillar: T,
      title: 'Inline code is not minified',
      why: 'Comments, indentation and long names in inline code add weight to every page view.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Minify inline scripts and styles in the build step or with your CMS’s optimisation plugin.',
      refs: ['https://developer.chrome.com/docs/lighthouse/performance/unminified-javascript'],
    },
    (page) => {
      if (!isHtml200(page) || page.inlineScriptBytes + page.inlineStyleBytes < UNMINIFIED_MIN_BYTES)
        return null;
      const blocks = [
        ...(page.html || '').matchAll(
          /<(script|style)\b(?![^>]*\bsrc=)(?![^>]*application\/(ld\+)?json)[^>]*>([\s\S]*?)<\/\1>/gi,
        ),
      ]
        .map((m) => m[3])
        .filter((b) => b.length > 2000);
      const code = blocks.join('\n');
      if (code.length < UNMINIFIED_MIN_BYTES) return null;
      const ws =
        (code.match(/\n[ \t]{2,}/g) || []).join('').length +
        (code.match(/\/\*[\s\S]*?\*\//g) || []).join('').length;
      return ws / code.length > 0.15
        ? {
            checkId: 'performance.unminified-inline',
            message: `About ${Math.round((ws / code.length) * 100)}% of ${Math.round(code.length / 1024)} KB inline code is whitespace or comments`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.dom-size',
      category: 'performance',
      pillar: T,
      title: 'Very large DOM',
      why: `More than about ${DOM_ELEMENTS_MAX} elements slows style calculation and interaction, and gives AI agents reading the page a much larger tree to work through.`,
      severity: 'low',
      fixTier: 'manual',
      fix: 'Simplify nested wrappers, paginate long lists and render hidden menus or tabs only when opened.',
      refs: ['https://developer.chrome.com/docs/lighthouse/performance/dom-size'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const n = (page.html || '').match(/<[a-z][a-z0-9-]*[\s>/]/gi)?.length ?? 0;
      return n > DOM_ELEMENTS_MAX
        ? { checkId: 'performance.dom-size', message: `About ${n} elements in the HTML` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.no-preconnect',
      category: 'performance',
      pillar: T,
      title: 'Critical third-party origins without preconnect',
      why: 'Fonts and CSS from another origin need a new connection. preconnect starts it early and can save hundreds of milliseconds.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin> (and for other render-critical origins).',
      refs: ['https://web.dev/articles/uses-rel-preconnect'],
    },
    (page, site) => {
      if (!isHtml200(page)) return null;
      const head = rawHead(page.html || '');
      const own = safeUrl(site.origin)?.host;
      const critical = new Set<string>();
      for (const s of page.stylesheets) {
        const u = safeUrl(s.href);
        if (u && u.host !== own) critical.add(u.origin);
      }
      if (/fonts\.googleapis\.com/.test(head)) critical.add('https://fonts.gstatic.com');
      const missing = [...critical].filter(
        (o) =>
          !new RegExp(
            `rel=["']?(preconnect|dns-prefetch)["']?[^>]*${o.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}|${o.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}[^>]*rel=["']?(preconnect|dns-prefetch)`,
            'i',
          ).test(head),
      );
      return missing.length
        ? { checkId: 'performance.no-preconnect', message: `No preconnect for ${list(missing, 3)}` }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.font-display',
      category: 'performance',
      pillar: T,
      title: 'Web fonts may hide text while loading',
      why: 'Without font-display: swap (or display=swap for Google Fonts), text stays invisible until the font arrives, which delays when people can read the page.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add font-display: swap to @font-face rules, or &display=swap to the Google Fonts URL.',
      refs: ['https://web.dev/articles/font-display'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      const gf = page.stylesheets.filter(
        (s) => /fonts\.googleapis\.com/.test(s.href) && !/display=/.test(s.href),
      );
      const faces = [...(page.html || '').matchAll(/@font-face\s*\{([^}]*)\}/gi)].filter(
        (m) => !/font-display/i.test(m[1]),
      );
      if (!gf.length && !faces.length) return null;
      return {
        checkId: 'performance.font-display',
        message: `${gf.length ? 'Google Fonts URL without display=swap' : ''}${gf.length && faces.length ? '; ' : ''}${faces.length ? `${plural(faces.length, '@font-face rule')} without font-display` : ''}`,
      };
    },
  ),
  pageCheck(
    {
      id: 'performance.html-no-validators',
      category: 'performance',
      pillar: T,
      title: 'HTML has no caching or revalidation headers',
      why: 'Without Cache-Control, ETag or Last-Modified, every crawl and repeat visit downloads the full page again, and crawlers cannot ask "has this changed?".',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Send ETag or Last-Modified on HTML, and a Cache-Control policy that suits how often pages change.',
      refs: ['https://developers.google.com/search/docs/crawling-indexing/http-caching'],
    },
    (page) => {
      if (!isHtml200(page)) return null;
      if (header(page, 'cache-control') || header(page, 'etag') || header(page, 'last-modified'))
        return null;
      return {
        checkId: 'performance.html-no-validators',
        message: 'No Cache-Control, ETag or Last-Modified header',
      };
    },
  ),
  siteCheck(
    {
      id: 'performance.asset-cache-short',
      category: 'performance',
      pillar: T,
      title: 'Static assets have short or no cache lifetime',
      why: 'CSS, JavaScript, fonts and images that are re-downloaded on every visit slow repeat views.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Serve fingerprinted assets with Cache-Control: public, max-age=31536000, immutable.',
      refs: ['https://web.dev/articles/uses-long-cache-ttl'],
    },
    (site) => {
      const bad: string[] = [];
      for (const p of site.pages.values()) {
        if (
          p.isHtml ||
          p.status !== 200 ||
          !/\.(css|js|mjs|woff2?|png|jpe?g|webp|avif|svg|gif)(\?|$)/i.test(p.url)
        )
          continue;
        const cc = (header(p, 'cache-control') || '').toLowerCase();
        const age = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? /s-maxage=(\d+)/.exec(cc)?.[1] ?? 0);
        if (/no-store|no-cache/.test(cc) || age < ASSET_CACHE_MIN_SECONDS) bad.push(pathOf(p.url));
      }
      return bad.length
        ? {
            checkId: 'performance.asset-cache-short',
            message: `${plural(bad.length, 'static file')} cached for less than 7 days`,
            evidence: list(bad, 4),
          }
        : null;
    },
  ),
  siteCheck(
    {
      id: 'performance.slow-pages-share',
      category: 'performance',
      pillar: T,
      title: 'Server is slow across much of the site',
      why: 'When a large share of pages respond slowly, the cause is usually server capacity or missing caching, and crawlers reduce how much of the site they fetch.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Add full-page caching or a CDN, and profile the slowest templates.',
      refs: [REF.ttfb],
    },
    (site) => {
      const pages = htmlPages(site);
      if (pages.length < 10) return null;
      const slow = pages.filter((p) => p.ttfbMs >= TTFB_SLOW_MS);
      if (slow.length / pages.length < 0.5) return null;
      const median = [...pages.map((p) => p.ttfbMs)].sort((a, b) => a - b)[
        Math.floor(pages.length / 2)
      ];
      return {
        checkId: 'performance.slow-pages-share',
        message: `${slow.length} of ${pages.length} pages took over ${TTFB_SLOW_MS} ms to respond (median ${median} ms)`,
      };
    },
  ),

  // -------------------------------------------------------------------------
  // PageSpeed Insights (CrUX field data first, then Lighthouse lab)
  // -------------------------------------------------------------------------
  siteCheck(
    {
      id: 'performance.lcp',
      category: 'performance',
      pillar: T,
      title: 'Largest Contentful Paint is slow',
      why: `LCP measures when the main content appears. Google’s Core Web Vitals threshold is ${LCP_GOOD / 1000} s; over ${LCP_POOR / 1000} s is poor.`,
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Speed up the server response, preload and prioritise the hero image, remove render-blocking resources and serve smaller images.',
      requires: ['psi'],
      refs: [REF.lcp, REF.cwv],
      tags: ['core-web-vitals'],
    },
    (site) =>
      psiIssues(
        site,
        'performance.lcp',
        (r) => fieldOrLab(r.field?.lcpMs, r.lcpMs),
        (v) => (v > LCP_POOR ? 'high' : v > LCP_GOOD ? 'medium' : null),
        (v) => `LCP ${(v / 1000).toFixed(1)} s`,
      ),
  ),
  siteCheck(
    {
      id: 'performance.cls',
      category: 'performance',
      pillar: T,
      title: 'Layout shifts while loading (CLS)',
      why: `CLS measures how much content jumps around. Over ${CLS_GOOD} fails Core Web Vitals and causes mis-taps.`,
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Set width and height on images and embeds, reserve space for ads and banners, and avoid inserting content above what is already shown.',
      requires: ['psi'],
      refs: [REF.cls, REF.cwv],
      tags: ['core-web-vitals'],
    },
    (site) =>
      psiIssues(
        site,
        'performance.cls',
        (r) => fieldOrLab(r.field?.cls, r.cls),
        (v) => (v > CLS_POOR ? 'high' : v > CLS_GOOD ? 'medium' : null),
        (v) => `CLS ${v.toFixed(2)}`,
      ),
  ),
  siteCheck(
    {
      id: 'performance.inp',
      category: 'performance',
      pillar: T,
      title: 'Slow response to interactions (INP)',
      why: `INP measures how quickly the page reacts to taps and clicks. Over ${INP_GOOD} ms fails Core Web Vitals.`,
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Break up long JavaScript tasks, defer third-party scripts and reduce work in event handlers.',
      requires: ['psi'],
      refs: [REF.inp, REF.cwv],
      tags: ['core-web-vitals'],
    },
    (site) =>
      psiIssues(
        site,
        'performance.inp',
        (r) =>
          typeof (r.field?.inpMs ?? r.inpMs) === 'number'
            ? {
                value: (r.field?.inpMs ?? r.inpMs)!,
                source: r.field?.inpMs != null ? 'field' : 'lab',
              }
            : null,
        (v) => (v > INP_POOR ? 'high' : v > INP_GOOD ? 'medium' : null),
        (v) => `INP ${Math.round(v)} ms`,
      ),
  ),
  siteCheck(
    {
      id: 'performance.tbt',
      category: 'performance',
      pillar: T,
      title: 'Main thread blocked for long periods (TBT)',
      why: 'Total Blocking Time in the lab test is the best predictor of poor INP: the page cannot respond while long scripts run.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Reduce and split JavaScript, remove unused tags and delay non-essential scripts until after load.',
      requires: ['psi'],
      refs: ['https://web.dev/articles/tbt'],
    },
    (site) =>
      psiIssues(
        site,
        'performance.tbt',
        (r) => (typeof r.tbtMs === 'number' ? { value: r.tbtMs, source: 'lab' } : null),
        (v) => (v > TBT_HIGH * 2 ? 'high' : v > TBT_HIGH ? 'medium' : null),
        (v) => `TBT ${Math.round(v)} ms`,
      ),
  ),
  siteCheck(
    {
      id: 'performance.fcp',
      category: 'performance',
      pillar: T,
      title: 'First Contentful Paint is slow',
      why: 'FCP is when anything first appears. A slow FCP makes the page feel broken and usually points to a slow server or blocking resources.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Improve TTFB, inline critical CSS and defer blocking scripts.',
      requires: ['psi'],
      refs: ['https://web.dev/articles/fcp'],
    },
    (site) =>
      psiIssues(
        site,
        'performance.fcp',
        (r) => (typeof r.fcpMs === 'number' ? { value: r.fcpMs, source: 'lab' } : null),
        (v) => (v > FCP_VERY_SLOW ? 'medium' : v > FCP_SLOW ? 'medium' : null),
        (v) => `FCP ${(v / 1000).toFixed(1)} s`,
      ).map((i) => ({
        ...i,
        severity: Number(i.data?.value) > FCP_VERY_SLOW ? ('medium' as const) : ('low' as const),
      })),
  ),
  siteCheck(
    {
      id: 'performance.psi-score',
      category: 'performance',
      pillar: T,
      title: 'Low Lighthouse performance score',
      why: 'The Lighthouse score summarises lab performance. Under 50 means several serious problems; it is a useful trend line rather than a ranking factor.',
      severity: 'medium',
      fixTier: 'manual',
      fix: 'Work through the PageSpeed Insights opportunities for this URL, starting with the biggest savings.',
      requires: ['psi'],
      refs: ['https://developer.chrome.com/docs/lighthouse/performance/performance-scoring'],
    },
    (site) =>
      psiResults(site)
        .filter((r) => r.performanceScore != null && r.performanceScore < PSI_SCORE_OK)
        .map((r) => ({
          checkId: 'performance.psi-score',
          url: r.url,
          severity: r.performanceScore! < PSI_SCORE_POOR ? ('medium' as const) : ('low' as const),
          message: `Performance score ${r.performanceScore} on ${r.strategy}`,
        })),
  ),
  siteCheck(
    {
      id: 'performance.psi-opportunities',
      category: 'performance',
      pillar: T,
      title: 'Large savings available according to PageSpeed Insights',
      why: 'Lighthouse estimates how much time each fix would save. These are the most valuable changes for this page.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Start with the opportunities listed with the largest savings.',
      requires: ['psi'],
    },
    (site) =>
      psiResults(site)
        .map((r) => ({
          r,
          ops: r.opportunities
            .filter((o) => (o.savingsMs ?? 0) >= PSI_OPPORTUNITY_MIN_MS)
            .sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0)),
        }))
        .filter((x) => x.ops.length)
        .map(({ r, ops }) => ({
          checkId: 'performance.psi-opportunities',
          url: r.url,
          message: `${plural(ops.length, 'opportunity', 'opportunities')} saving ${PSI_OPPORTUNITY_MIN_MS} ms or more on ${r.strategy}`,
          evidence: list(
            ops.map((o) => `${o.title} (~${((o.savingsMs ?? 0) / 1000).toFixed(1)} s)`),
            4,
          ),
        })),
  ),

  // -------------------------------------------------------------------------
  // Rendered timings (local Chrome)
  // -------------------------------------------------------------------------
  pageCheck(
    {
      id: 'performance.rendered-lcp',
      category: 'performance',
      pillar: T,
      title: 'Slow LCP in a local browser test',
      why: `In a real browser run, the main content took longer than ${LCP_GOOD / 1000} s to appear. This is a lab measurement from your machine, so treat it as a pointer rather than field data.`,
      severity: 'low',
      fixTier: 'guided',
      fix: 'Check the page in PageSpeed Insights, then optimise the largest element (usually the hero image or heading font).',
      requires: ['render'],
      refs: [REF.lcp],
    },
    (page) => {
      const lcp = rendered(page)?.lcp;
      return lcp && lcp > LCP_GOOD
        ? {
            checkId: 'performance.rendered-lcp',
            severity: lcp > LCP_POOR ? 'medium' : 'low',
            message: `LCP ${(lcp / 1000).toFixed(1)} s in the local render`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.rendered-cls',
      category: 'performance',
      pillar: T,
      title: 'Layout shift in a local browser test',
      why: 'Content moved after it first appeared during the render. Shifts after load also confuse AI agents that click on elements.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Reserve space for images, embeds, banners and late-loading fonts.',
      requires: ['render'],
      refs: [REF.cls],
    },
    (page) => {
      const cls = rendered(page)?.cls;
      return cls != null && cls > CLS_GOOD
        ? {
            checkId: 'performance.rendered-cls',
            severity: cls > CLS_POOR ? 'medium' : 'low',
            message: `CLS ${cls.toFixed(2)} in the local render`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.rendered-tbt',
      category: 'performance',
      pillar: T,
      title: 'Long main-thread blocking in a local browser test',
      why: 'Long tasks during load mean taps and clicks are ignored for a while.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Reduce JavaScript run on load; split and defer bundles.',
      requires: ['render'],
    },
    (page) => {
      const tbt = rendered(page)?.tbt;
      return tbt != null && tbt > TBT_HIGH
        ? {
            checkId: 'performance.rendered-tbt',
            message: `About ${Math.round(tbt)} ms of blocking time in the local render`,
          }
        : null;
    },
  ),
  pageCheck(
    {
      id: 'performance.rendered-load-slow',
      category: 'performance',
      pillar: T,
      title: 'Page takes a long time to finish loading',
      why: 'A slow load event means the page keeps fetching resources for a long time, which keeps spinners going and delays analytics and agent interaction.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Lazy-load below-the-fold media and delay third-party embeds until they are needed.',
      requires: ['render'],
    },
    (page) => {
      const load = rendered(page)?.load;
      return load && load > RENDER_LOAD_SLOW_MS
        ? {
            checkId: 'performance.rendered-load-slow',
            message: `Load event after ${(load / 1000).toFixed(1)} s`,
          }
        : null;
    },
  ),
];

export const _internal = { headScripts, findPage, truncate };

// ---------------------------------------------------------------------------
// Added for feature parity: unminified CSS and JavaScript files
// ---------------------------------------------------------------------------

/** Files fetched by performance.unminified-assets (most-used first). */
export const UNMINIFIED_SAMPLE = 8;

/** Share of a CSS/JS file that is indentation, blank lines or comments (0–1). */
export function wasteShare(code: string): number {
  if (!code) return 0;
  const indent = (code.match(/\n[ \t]{2,}/g) || []).join('').length;
  const blank = (code.match(/\n\s*\n/g) || []).length;
  const comments =
    (code.match(/\/\*[\s\S]*?\*\//g) || []).join('').length +
    (code.match(/(^|[^:"'\\])\/\/[^\n]*/g) || []).join('').length;
  return Math.min(1, (indent + blank + comments) / code.length);
}

checks.push(
  cu.siteCheck(
    {
      id: 'performance.unminified-assets',
      category: 'performance',
      pillar: T,
      title: 'CSS or JavaScript files are not minified',
      why: 'Indentation, comments and long names in CSS and JavaScript files add bytes every visitor downloads before the page can render. Minified files are typically 20–40% smaller before compression.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Minify CSS and JavaScript in your build (most bundlers do this in production mode) or turn on minification in your CMS, cache plugin or CDN.',
      refs: [
        'https://developer.chrome.com/docs/lighthouse/performance/unminified-css',
        'https://developer.chrome.com/docs/lighthouse/performance/unminified-javascript',
      ],
    },
    async (site) => {
      const counts = new Map<string, { n: number; kind: 'js' | 'css' }>();
      for (const p of cu.htmlPages(site)) {
        if (!cu.isHtml200(p)) continue;
        for (const s of p.scripts)
          if (s.src && cu.sameSiteHost(s.src, site.origin) && !/\.min\.js(\?|$)/i.test(s.src))
            counts.set(s.src, { n: (counts.get(s.src)?.n ?? 0) + 1, kind: 'js' });
        for (const l of p.stylesheets)
          if (l.href && cu.sameSiteHost(l.href, site.origin) && !/\.min\.css(\?|$)/i.test(l.href))
            counts.set(l.href, { n: (counts.get(l.href)?.n ?? 0) + 1, kind: 'css' });
      }
      const sample = [...counts.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, UNMINIFIED_SAMPLE);
      const hits: string[] = [];
      let wasted = 0;
      for (const [url, info] of sample) {
        const res = await site.fetcher.fetch(url, { timeoutMs: 10_000, maxBytes: 1024 * 1024 });
        if (res.status !== 200 || res.body.length < UNMINIFIED_MIN_BYTES) continue;
        if (/text\/html/i.test(res.contentType)) continue;
        const share = wasteShare(res.body);
        if (share < 0.15) continue;
        wasted += Math.round(res.body.length * share);
        hits.push(
          `${cu.pathOf(url)} (${info.kind}, ${Math.round(res.body.length / 1024)} KB, ~${Math.round(share * 100)}% whitespace/comments, on ${cu.plural(info.n, 'page')})`,
        );
      }
      if (!hits.length) return null;
      return {
        checkId: 'performance.unminified-assets',
        message: `${cu.plural(hits.length, 'file')} not minified; about ${Math.round(wasted / 1024)} KB could be saved`,
        evidence: hits.slice(0, 5).join(' | '),
        data: { files: hits.length, wastedBytes: wasted },
      };
    },
  ),
);
