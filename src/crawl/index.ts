/**
 * The site crawler: robots.txt → sitemaps → breadth-first crawl → optional
 * rendering → stack detection. Produces the SiteContext every check reads.
 *
 * Conventions other modules can rely on:
 * - `site.pages` is keyed by normaliseUrl(url) and holds every URL we requested
 *   (HTML pages, linked PDFs/images and other files, redirects, errors), plus
 *   robots-blocked stubs (blockedByRobots: true, status 0, never fetched).
 * - A URL that redirects is stored with status = the first hop's 3xx code,
 *   `redirects` = every hop, `finalUrl` = where it ended, and empty HTML fields.
 *   The destination is stored as its own page (when it is on the same site).
 * - `depth` is clicks from the start URL. Pages reachable only from the
 *   sitemap (orphans), and pages found only through them, have depth -1.
 * - `inlinks` counts <a href> links between crawled pages only (not canonical,
 *   hreflang or pagination references, which are still followed).
 * - External link and image statuses are not on PageData; read them with
 *   `externalLinkStatus(site)` and `imageStatus(site)`.
 */
import type {
  CrawlOptions,
  CrawlStats,
  FetchResult,
  Fetcher,
  PageData,
  ProgressFn,
  SiteContext,
  StackInfo,
} from '../core/types.js';
import { DEFAULT_USER_AGENT } from '../core/version.js';
import { createFetcher, rawBody } from '../core/http.js';
import { isHttpUrl, looksLikeHtmlUrl, normaliseUrl, sameSite } from '../core/url.js';
import { basePage, extractPage } from './extract.js';
import { formLogin } from './form-login.js';
import {
  applyContentArea,
  checkExtractors,
  DANGEROUS_LINK,
  limitReason,
  onSubdomain,
  rewriteUrl,
  runExtractors,
  startFolder,
} from './options.js';
import { extractPdfInfo, isPdf } from './pdf.js';
import { presetForStack, resolvePreset } from './presets.js';
import { readTls } from './tls.js';
import { loadRobots, uaToken } from './robots.js';
import { loadSitemaps } from './sitemaps.js';
import { renderPages } from './render.js';
import { detectStack } from './stack.js';

export { createFetcher } from '../core/http.js';
export { normaliseUrl } from '../core/url.js';
export { extractPage } from './extract.js';
export { loadRobots } from './robots.js';
export { loadSitemaps } from './sitemaps.js';
export { renderPages, findChrome } from './render.js';
export { detectStack } from './stack.js';
export { hammingDistance, simhash } from './text.js';
export { listPresets, resolvePreset, presetForStack } from './presets.js';
export { parseExtractorFlag, checkExtractors } from './options.js';

const MAX_DISCOVERED_FROM = 20;
const MAX_EXTERNAL_CHECKS = 2000;
const MAX_IMAGE_CHECKS = 1500;
/** Pages rendered in 'auto' mode besides the home page and thin pages. */
const AUTO_RENDER_SAMPLE = 4;
const THIN_RAW_WORDS = 100;

export function defaultCrawlOptions(startUrl: string): CrawlOptions {
  return {
    startUrl: coerceStartUrl(startUrl),
    maxPages: 500,
    maxDepth: 10,
    concurrency: 4,
    delayMs: 250,
    userAgent: DEFAULT_USER_AGENT,
    respectRobots: true,
    render: 'auto',
    renderLimit: 50,
    useSitemaps: true,
    checkExternalLinks: false,
    checkImages: true,
    timeoutMs: 20_000,
    maxBytes: 5 * 1024 * 1024,
  };
}

/** "example.com" → "https://example.com/". */
export function coerceStartUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  return normaliseUrl(s);
}

const externalStatuses = new WeakMap<SiteContext, Map<string, number>>();
const imageStatuses = new WeakMap<SiteContext, Map<string, number>>();

/**
 * HTTP status per external link URL (only when checkExternalLinks was on).
 * 0 = network error / timeout. Keys are the hrefs exactly as on LinkRef.
 */
export function externalLinkStatus(site: SiteContext): Map<string, number> {
  return externalStatuses.get(site) ?? new Map();
}

/** HTTP status per image src (only when checkImages was on). 0 = network error. */
export function imageStatus(site: SiteContext): Map<string, number> {
  return imageStatuses.get(site) ?? new Map();
}

interface QueueItem {
  url: string; // normalised
  depth: number;
  from?: string;
  /** Linked with <a> to a file that looks non-HTML: HEAD it rather than GET. */
  probe?: boolean;
}

export async function crawlSite(
  input: Partial<CrawlOptions> & { startUrl: string },
  onProgress?: ProgressFn,
): Promise<SiteContext> {
  const started = Date.now();
  const defaults = defaultCrawlOptions(input.startUrl);
  const options: CrawlOptions = { ...defaults };
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) (options as unknown as Record<string, unknown>)[k] = v;
  }
  options.startUrl = coerceStartUrl(options.startUrl);
  const emit: ProgressFn = (e) => {
    try {
      onProgress?.(e);
    } catch {
      /* a progress handler must never break the crawl */
    }
  };
  const log = (level: 'info' | 'warn' | 'error', message: string) =>
    emit({ type: 'log', level, message });

  const startHost = new URL(options.startUrl).hostname;

  // ---- Optional form sign-in: the session cookie becomes the crawl's auth.
  const exclusions = [...(options.exclude ?? [])];
  if (options.formLogin?.url) {
    emit({ type: 'log', level: 'info', message: `Signing in at ${options.formLogin.url}` });
    const r = await formLogin({ ...options.formLogin, chromePath: options.chromePath });
    if (r.ok && r.cookie) {
      options.auth = { cookie: r.cookie };
      log(
        'info',
        `Signed in (${r.cookies} cookies). Log-out, delete and admin links will not be followed.`,
      );
    } else log('warn', `Form sign-in failed: ${r.error}. Crawling without signing in.`);
  }
  const signedIn = Boolean(options.formLogin?.url && options.auth && 'cookie' in options.auth);

  const fetcher = createFetcher({
    userAgent: options.userAgent,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    headers: options.headers,
    auth: options.auth,
    authHost: startHost,
  });
  const token = uaToken(options.robotsUserAgent || options.userAgent);
  const include = compile(options.include, log);
  const extractors = checkExtractors(options.extract);
  for (const e of extractors.errors) log('warn', e);
  for (const r of options.rewrite ?? [])
    try {
      new RegExp(r.pattern);
    } catch {
      log('warn', `Ignored invalid rewrite pattern: ${r.pattern}`);
    }
  const folder = options.stayInFolder ? startFolder(options.startUrl) : null;

  // ---- Start URL first: it tells us the canonical origin (http→https, apex→www).
  emit({ type: 'phase', phase: 'robots', message: 'Reading robots.txt' });
  const startFetch = await fetcher.fetch(options.startUrl);
  let origin = new URL(options.startUrl).origin;
  if (
    startFetch.status > 0 &&
    startFetch.finalUrl &&
    sameSite(startFetch.finalUrl, options.startUrl)
  )
    origin = new URL(startFetch.finalUrl).origin;
  if (startFetch.status === 0)
    log('error', `Could not reach ${options.startUrl}: ${startFetch.error ?? 'network error'}`);

  // ---- Platform preset: exclusions that keep the crawl on real pages.
  if (options.preset) {
    let name = options.preset;
    if (name === 'auto') {
      const probe = extractPage(startFetch, { origin, depth: 0 });
      const detected = probe.isHtml ? detectStack([probe], startFetch.headers) : null;
      name = detected ? (presetForStack(detected.id)?.id ?? '') : '';
      if (name) log('info', `Detected ${detected!.id}; applying the ${name} crawl preset.`);
    }
    const preset = name ? resolvePreset(name) : null;
    if (preset) {
      exclusions.push(...(preset.exclude ?? []));
      if (input.render === undefined && preset.render !== undefined) options.render = preset.render;
    } else if (options.preset !== 'auto') log('warn', `Unknown crawl preset: ${options.preset}`);
  }
  const exclude = compile(exclusions, log);

  const robots = await loadRobots(origin, fetcher);
  const robotsUnreachable =
    robots.status === null || robots.status === 0 || (robots.status ?? 0) >= 500;
  if (robotsUnreachable)
    log(
      'warn',
      `robots.txt returned ${robots.status ?? 'no response'}; search engines treat the whole site as blocked. Crawling anyway.`,
    );

  emit({ type: 'phase', phase: 'sitemaps', message: 'Reading sitemaps' });
  const sitemaps = await loadSitemaps(origin, robots, fetcher);
  const sitemapUrls = new Map<string, string>(); // normalised → sitemap file
  for (const s of sitemaps)
    for (const u of s.urls)
      if (!sitemapUrls.has(normaliseUrl(u.loc))) sitemapUrls.set(normaliseUrl(u.loc), s.url);

  const pages = new Map<string, PageData>();
  const inlinks = new Map<string, Set<string>>();
  const seen = new Set<string>(); // queued or done
  const perDepth = new Map<number, number>(); // URLs queued per click depth (maxPerDepth)
  const knownDepth = new Map<string, number>(); // discovered beyond maxDepth
  const queue: QueueItem[] = [];
  let qHead = 0;
  let fetched = 0;
  let errors = 0;

  const isBlocked = (url: string) =>
    !robots.isAllowed(url, token) || !robots.isAllowed(url, 'Googlebot');
  const mayFetch = (url: string) =>
    !options.respectRobots || robotsUnreachable || robots.isAllowed(url, token);
  const inSite = (url: string) =>
    sameSite(url, origin) || Boolean(options.subdomains && onSubdomain(url, startHost));
  const inScope = (url: string, isStart = false) => {
    if (isStart) return true;
    if (signedIn && DANGEROUS_LINK.test(url)) return false;
    if (folder) {
      try {
        const u = new URL(url);
        if (sameSite(url, origin) && !u.pathname.startsWith(folder)) return false;
      } catch {
        return false;
      }
    }
    if (limitReason(url, options)) return false;
    if (exclude.some((r) => r.test(url))) return false;
    if (include.length && !include.some((r) => r.test(url))) return false;
    return true;
  };

  const addFrom = (page: PageData, from?: string) => {
    if (
      from &&
      page.discoveredFrom.length < MAX_DISCOVERED_FROM &&
      !page.discoveredFrom.includes(from)
    )
      page.discoveredFrom.push(from);
  };

  const enqueue = (rawUrl: string, depth: number, from?: string, probe = false) => {
    if (!isHttpUrl(rawUrl)) return;
    const url = normaliseUrl(rewriteUrl(rawUrl, options));
    if (!inSite(url)) return;
    const existing = pages.get(url);
    if (existing) {
      addFrom(existing, from);
      return;
    }
    if (seen.has(url)) {
      pendingFrom(url, from);
      return;
    }
    if (!inScope(url)) return;
    if (options.maxPerDepth && options.maxPerDepth > 0) {
      const n = perDepth.get(depth) ?? 0;
      if (n >= options.maxPerDepth) return;
      perDepth.set(depth, n + 1);
    }
    if (depth > options.maxDepth && depth >= 0) {
      if (!knownDepth.has(url)) knownDepth.set(url, depth);
      return;
    }
    seen.add(url);
    queue.push({ url, depth, from, probe });
    pendingFrom(url, from);
  };

  // Referrers collected before a page is fetched.
  const pendingRefs = new Map<string, string[]>();
  function pendingFrom(url: string, from?: string) {
    if (!from) return;
    const list = pendingRefs.get(url) ?? [];
    if (list.length < MAX_DISCOVERED_FROM && !list.includes(from)) list.push(from);
    pendingRefs.set(url, list);
  }

  const store = (page: PageData) => {
    page.inSitemap = sitemapUrls.has(page.url);
    page.blockedByRobots = isBlocked(page.finalUrl || page.url) || isBlocked(page.url);
    for (const ref of pendingRefs.get(page.url) ?? []) addFrom(page, ref);
    pendingRefs.delete(page.url);
    pages.set(page.url, page);
  };

  const follow = !options.urls?.length && !options.sitemapOnly;
  const recordLinks = (page: PageData) => {
    const childDepth = page.depth < 0 ? -1 : page.depth + 1;
    const src = page.url;
    for (const link of page.links) {
      if (!link.internal) {
        if (follow && options.subdomains && onSubdomain(link.href, startHost))
          enqueue(link.href, childDepth, src, !looksLikeHtmlUrl(link.href));
        continue;
      }
      const target = normaliseUrl(link.href);
      if (target !== src) {
        let set = inlinks.get(target);
        if (!set) inlinks.set(target, (set = new Set()));
        set.add(src);
      }
      if (!follow) continue;
      if (options.followNofollow === false && link.rel.includes('nofollow')) continue;
      enqueue(link.href, childDepth, src, !looksLikeHtmlUrl(link.href));
    }
    if (!follow) return;
    // Followed but not counted as inlinks.
    const refs = [
      page.canonical,
      page.canonicalHeader,
      page.pagination.next,
      page.pagination.prev,
      ...page.hreflang.map((h) => h.href),
    ];
    for (const r of refs) if (r) enqueue(r, childDepth, src);
  };

  /** Custom extraction, content area and PDF properties for a freshly extracted page. */
  const enrich = (page: PageData, res: FetchResult) => {
    if (page.isHtml && page.html) {
      if (extractors.ok.length) page.extracted = runExtractors(page.html, extractors.ok);
      applyContentArea(page, options);
    } else if (
      options.pdfProperties !== false &&
      page.status >= 200 &&
      page.status < 300 &&
      isPdf(res.contentType, res.finalUrl)
    ) {
      const raw = rawBody(res);
      if (raw?.length) page.pdf = extractPdfInfo(raw);
    }
  };

  const handleResult = (item: QueueItem, res: FetchResult) => {
    if (res.status === 0 || res.status >= 400) errors++;
    if (res.redirects.length) {
      // The discovered URL: a redirect record only.
      const stub = basePage(res, { origin, depth: item.depth, url: item.url });
      stub.status = res.redirects[0]!.status;
      stub.isHtml = false;
      stub.contentType = '';
      stub.bytes = 0;
      addFrom(stub, item.from);
      store(stub);
      const finalKey = normaliseUrl(res.finalUrl);
      if (
        res.status > 0 &&
        sameSite(res.finalUrl, origin) &&
        !pages.has(finalKey) &&
        inScope(finalKey)
      ) {
        seen.add(finalKey);
        const target = extractPage(
          { ...res, url: res.finalUrl, redirects: [] },
          { origin, depth: item.depth, url: finalKey },
        );
        enrich(target, res);
        addFrom(target, item.url);
        store(target);
        if (target.isHtml) recordLinks(target);
      }
      return stub;
    }
    const page = extractPage(res, { origin, depth: item.depth, url: item.url });
    enrich(page, res);
    addFrom(page, item.from);
    store(page);
    if (page.isHtml && page.status >= 200 && page.status < 300) recordLinks(page);
    return page;
  };

  /** Fetch, retrying 429 and 503 answers with back-off (Retry-After honoured up to 10 s). */
  const fetchRetry: typeof fetcher.fetch = async (url, o) => {
    let res = await fetcher.fetch(url, o);
    const max = options.retries ?? 2;
    for (let i = 0; i < max && (res.status === 429 || res.status === 503); i++) {
      const ra = Number(res.headers['retry-after']);
      await sleep(Math.min(10_000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** i));
      res = await fetcher.fetch(url, o);
    }
    return res;
  };

  const processItem = async (item: QueueItem): Promise<void> => {
    if (!mayFetch(item.url)) {
      const stub = basePage(
        {
          url: item.url,
          finalUrl: item.url,
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
          error: `Not crawled: robots.txt disallows ${token}`,
        },
        { origin, depth: item.depth, url: item.url },
      );
      addFrom(stub, item.from);
      store(stub);
      return;
    }
    fetched++;
    let res: FetchResult;
    if (item.probe) {
      res = await fetchRetry(item.url, { method: 'HEAD' });
      if (res.status === 0 || res.status === 405 || res.status === 501 || res.status === 403)
        res = await fetchRetry(item.url, { maxBytes: 64 * 1024 });
      else if (res.ok && /text\/html|xhtml/i.test(res.contentType))
        res = await fetchRetry(item.url);
      else if (
        res.ok &&
        options.pdfProperties !== false &&
        !res.redirects.length &&
        isPdf(res.contentType, res.finalUrl)
      )
        res = await fetcher.fetch(item.url, {
          maxBytes: Math.min(options.maxBytes, 8 * 1024 * 1024),
        });
    } else res = await fetchRetry(item.url);
    const page = handleResult(item, res);
    emit({
      type: 'page',
      url: item.url,
      status: page.status,
      crawled: pages.size,
      queued: queue.length - qHead,
    });
  };

  // ---- Crawl ----
  emit({ type: 'phase', phase: 'crawl', message: `Crawling ${origin}` });
  const startKey = normaliseUrl(options.startUrl);
  seen.add(startKey);
  if (options.respectRobots && !robotsUnreachable && !robots.isAllowed(options.startUrl, token)) {
    log(
      'warn',
      `robots.txt disallows ${token} from ${options.startUrl}. Turn off "respect robots.txt" to audit it anyway.`,
    );
    await processItem({ url: startKey, depth: 0 });
  } else {
    fetched++;
    const page = handleResult({ url: startKey, depth: 0 }, startFetch);
    emit({ type: 'page', url: startKey, status: page.status, crawled: pages.size, queued: 0 });
  }

  const budgetLeft = () => options.maxPages <= 0 || fetched < options.maxPages;

  // List mode and sitemap-only mode: a fixed set of URLs, no link discovery.
  if (options.urls?.length) {
    for (const u of options.urls) if (isHttpUrl(u)) enqueue(u, 1, undefined, !looksLikeHtmlUrl(u));
  } else if (options.sitemapOnly) {
    for (const [u, file] of sitemapUrls) {
      enqueue(u, 1, undefined, !looksLikeHtmlUrl(u));
      pendingFrom(normaliseUrl(u), file);
    }
  }

  const runWorkers = async () => {
    let active = 0;
    let waiters: (() => void)[] = [];
    const wake = () => {
      const w = waiters;
      waiters = [];
      for (const fn of w) fn();
    };
    const worker = async () => {
      for (;;) {
        if (!budgetLeft()) return;
        if (qHead >= queue.length) {
          if (active === 0) return;
          await new Promise<void>((r) => waiters.push(r));
          continue;
        }
        const item = queue[qHead++]!;
        active++;
        try {
          await processItem(item);
        } catch (e) {
          errors++;
          log('error', `Failed on ${item.url}: ${(e as Error).message}`);
        } finally {
          active--;
          wake();
        }
        if (options.delayMs > 0) await sleep(options.delayMs);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
    wake();
  };

  await runWorkers();

  // Seed from sitemaps: URLs the link graph did not reach (orphans, or beyond maxDepth).
  if (options.useSitemaps && follow && budgetLeft()) {
    let added = 0;
    for (const [url, file] of sitemapUrls) {
      if (seen.has(url) || pages.has(url) || !inSite(url)) continue;
      const depth = knownDepth.get(url) ?? -1;
      seen.add(url);
      if (!inScope(url)) continue;
      queue.push({ url, depth, probe: !looksLikeHtmlUrl(url) });
      pendingFrom(url, file);
      added++;
    }
    if (added) {
      log(
        'info',
        `${added} URLs from the sitemap were not linked from crawled pages; crawling them too.`,
      );
      await runWorkers();
    }
  }

  const notCrawled = queue.length - qHead + knownDepth.size;
  if (!budgetLeft() && queue.length - qHead > 0)
    log(
      'info',
      `Stopped at the ${options.maxPages}-page limit; ${queue.length - qHead} URLs were left in the queue.`,
    );

  // ---- Assets ----
  const site: SiteContext = {
    startUrl: options.startUrl,
    origin,
    host: new URL(origin).host,
    pages,
    inlinks,
    robots,
    sitemaps,
    stack: { id: 'unknown', confidence: 0, signals: [] } as StackInfo,
    probes: new Map(),
    botFetches: [],
    browserFetch: null,
    external: {},
    fetcher,
    options,
    stats: {} as CrawlStats,
  };

  if (options.checkTls !== false && origin.startsWith('https:')) {
    try {
      const u = new URL(origin);
      site.tls = await readTls(u.hostname, Number(u.port) || 443);
    } catch {
      /* never fatal */
    }
  }

  if (options.checkImages) await headImages(site, fetcher, options.concurrency, log);
  if (options.checkExternalLinks) await checkExternal(site, fetcher, options.concurrency, log);

  // ---- Render ----
  let renderedCount = 0;
  if (options.render) {
    const targets = chooseRenderTargets([...pages.values()], options, startKey);
    if (targets.length) {
      emit({
        type: 'phase',
        phase: 'render',
        message: `Rendering ${targets.length} pages with Chrome`,
      });
      const summary = await renderPages(targets, {
        chromePath: options.chromePath,
        limit: options.renderLimit,
        timeoutMs: Math.max(10_000, options.timeoutMs),
        headers: options.headers,
        auth: options.auth,
        mobile: options.mobileRender !== false,
        log,
      }).catch((e: Error) => {
        log('warn', `Rendering skipped: ${e.message}`);
        return null;
      });
      renderedCount = summary?.rendered ?? 0;
    }
  }

  // ---- Stack ----
  const home = pages.get(startKey);
  const homeFinal = home?.redirects.length ? pages.get(normaliseUrl(home.finalUrl)) : home;
  const stackPages = [
    homeFinal,
    ...[...pages.values()].filter((p) => p.isHtml && p !== homeFinal).slice(0, 4),
  ].filter(Boolean) as PageData[];
  try {
    site.stack = detectStack(stackPages, homeFinal?.headers ?? startFetch.headers);
  } catch (e) {
    log('warn', `Stack detection failed: ${(e as Error).message}`);
  }

  const finished = Date.now();
  site.stats = {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    pagesCrawled: fetched,
    pagesQueuedNotCrawled: notCrawled,
    maxPages: options.maxPages,
    maxDepth: options.maxDepth,
    rendered: renderedCount,
    errors,
    durationMs: finished - started,
  };
  return site;
}

/** Which pages to render: all HTML up to the limit (true) or home + thin pages + a small sample ('auto'). */
export function chooseRenderTargets(
  pages: PageData[],
  options: CrawlOptions,
  startKey: string,
): PageData[] {
  const html = pages.filter(
    (p) => p.isHtml && p.status >= 200 && p.status < 300 && !p.redirects.length,
  );
  const limit = Math.max(0, options.renderLimit);
  if (!limit || !html.length) return [];
  const byDepth = [...html].sort((a, b) => depthKey(a) - depthKey(b));
  if (options.render === true) return byDepth.slice(0, limit);
  const picked = new Set<PageData>();
  const home = html.find((p) => p.url === startKey) ?? byDepth[0];
  if (home) picked.add(home);
  // Thinnest first: an empty raw page is the likeliest to be built by JavaScript.
  const thin = byDepth
    .filter((p) => p.wordCount < THIN_RAW_WORDS)
    .sort((a, b) => a.wordCount - b.wordCount);
  for (const p of thin) picked.add(p);
  // One page per top-level section, shallowest first: covers distinct templates.
  const sections = new Set<string>();
  let sample = 0;
  for (const p of byDepth) {
    if (sample >= AUTO_RENDER_SAMPLE) break;
    const section = new URL(p.url).pathname.split('/')[1] ?? '';
    if (sections.has(section) || picked.has(p)) continue;
    sections.add(section);
    picked.add(p);
    sample++;
  }
  return [...picked].slice(0, limit);
}

function depthKey(p: PageData): number {
  return p.depth < 0 ? 1e6 : p.depth;
}

async function headImages(
  site: SiteContext,
  fetcher: Fetcher,
  concurrency: number,
  log: (l: 'info' | 'warn' | 'error', m: string) => void,
): Promise<void> {
  const srcs = new Set<string>();
  for (const p of site.pages.values())
    for (const img of p.images) if (srcs.size < MAX_IMAGE_CHECKS) srcs.add(img.src);
  if (!srcs.size) return;
  const info = new Map<string, { status: number; bytes?: number; type?: string }>();
  await mapLimit([...srcs], Math.max(2, concurrency * 2), async (src) => {
    let res = await fetcher.fetch(src, {
      method: 'HEAD',
      timeoutMs: 10_000,
      headers: { accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
    });
    if (res.status === 405 || res.status === 501 || res.status === 403 || res.status === 0)
      res = await fetcher.fetch(src, {
        timeoutMs: 15_000,
        headers: { accept: 'image/*,*/*;q=0.8' },
      });
    const len = Number(res.headers['content-length']);
    info.set(src, {
      status: res.status,
      bytes: Number.isFinite(len) && len > 0 ? len : res.bytes || undefined,
      type: res.contentType || undefined,
    });
  });
  const statuses = new Map<string, number>();
  for (const [src, i] of info) statuses.set(src, i.status);
  imageStatuses.set(site, statuses);
  for (const p of site.pages.values())
    for (const img of p.images) {
      const i = info.get(img.src);
      if (!i) continue;
      if (i.bytes !== undefined) img.bytes = i.bytes;
      if (i.type) img.contentType = i.type;
    }
  if (srcs.size >= MAX_IMAGE_CHECKS)
    log('info', `Checked the first ${MAX_IMAGE_CHECKS} images only.`);
}

async function checkExternal(
  site: SiteContext,
  fetcher: Fetcher,
  concurrency: number,
  log: (l: 'info' | 'warn' | 'error', m: string) => void,
): Promise<void> {
  const hrefs = new Set<string>();
  for (const p of site.pages.values())
    for (const l of p.links) if (!l.internal && hrefs.size < MAX_EXTERNAL_CHECKS) hrefs.add(l.href);
  const statuses = new Map<string, number>();
  await mapLimit([...hrefs], Math.max(2, concurrency * 2), async (href) => {
    let res = await fetcher.fetch(href, { method: 'HEAD', timeoutMs: 10_000 });
    // Many servers refuse HEAD or bots; confirm with a small GET before calling it broken.
    if (res.status === 0 || res.status >= 400)
      res = await fetcher.fetch(href, { timeoutMs: 15_000, maxBytes: 32 * 1024 });
    statuses.set(href, res.status);
  });
  externalStatuses.set(site, statuses);
  if (hrefs.size >= MAX_EXTERNAL_CHECKS)
    log('info', `Checked the first ${MAX_EXTERNAL_CHECKS} external links only.`);
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        try {
          await fn(item);
        } catch {
          /* one failure never stops the rest */
        }
      }
    }),
  );
}

function compile(patterns: string[] | undefined, log: (l: 'warn', m: string) => void): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns ?? []) {
    try {
      out.push(new RegExp(p));
    } catch {
      log('warn', `Ignored invalid pattern: ${p}`);
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
