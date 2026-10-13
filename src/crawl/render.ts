/**
 * Headless rendering with the user's own Chrome/Chromium/Edge, driven by
 * playwright-core (which ships no browser). Fills `page.rendered`.
 *
 * Browser lookup order: opts.chromePath, AVC_CHROME_PATH, CHROME_PATH, then
 * the usual install locations on macOS, Windows and Linux, then any
 * Playwright-managed Chromium (PLAYWRIGHT_BROWSERS_PATH, ~/.cache/ms-playwright).
 * When none is found, rendering is skipped with a clear message; it never
 * throws.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import type { MobileRender, PageData, RenderedLayout } from '../core/types.js';
import { headingsOf, pageText, structuredDataOf } from './extract.js';
import { countWords, oneLine } from './text.js';

export interface RenderOptions {
  chromePath?: string;
  /** Max pages to render. */
  limit: number;
  /** Per page. Default 20 s. */
  timeoutMs?: number;
  /** Pages rendered at the same time. Default 2. */
  concurrency?: number;
  userAgent?: string;
  headers?: Record<string, string>;
  auth?: { user: string; pass: string } | { cookie: string };
  /** Also load images and fonts (slower, closer to a real visit). Default false. */
  loadImages?: boolean;
  /** Render a sample of the pages again as a phone (overflow, tap targets, parity). Default false. */
  mobile?: boolean;
  /** Pages rendered as a phone too. Default 10. */
  mobileLimit?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface RenderSummary {
  rendered: number;
  failed: number;
  skipped: boolean;
  reason?: string;
  chromePath?: string;
}

/** Find a Chrome-family browser on this machine. Null when none is installed. */
export function findChrome(explicit?: string): string | null {
  const env = process.env;
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (env.AVC_CHROME_PATH) candidates.push(env.AVC_CHROME_PATH);
  if (env.CHROME_PATH) candidates.push(env.CHROME_PATH);
  if (process.platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    for (const a of apps)
      candidates.push(join('/Applications', a), join(homedir(), 'Applications', a));
  } else if (process.platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(
      Boolean,
    ) as string[];
    for (const r of roots) {
      candidates.push(
        join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(r, 'Chromium', 'Application', 'chrome.exe'),
        join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      );
    }
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/brave-browser',
      '/opt/google/chrome/chrome',
    );
  }
  // Playwright-managed browsers.
  const pwRoots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    '/opt/pw-browsers',
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'ms-playwright') : undefined,
  ].filter(Boolean) as string[];
  for (const root of pwRoots) {
    try {
      const dirs = readdirSync(root)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort()
        .reverse();
      for (const d of dirs) {
        candidates.push(
          join(root, d, 'chrome-linux', 'chrome'),
          join(root, d, 'chrome-linux64', 'chrome'),
          join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
          join(root, d, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
          join(root, d, 'chrome-win', 'chrome.exe'),
          join(root, d, 'chrome-win64', 'chrome.exe'),
        );
      }
    } catch {
      /* not there */
    }
  }
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Collects LCP, CLS and long tasks inside the page before any script runs. */
const PERF_INIT = `(() => {
  const s = (window.__avcPerf = { lcp: 0, cls: 0, tbt: 0 });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) s.lcp = Math.max(s.lcp, e.renderTime || e.loadTime || e.startTime); })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) s.cls += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) s.tbt += Math.max(0, e.duration - 50); })
      .observe({ type: 'longtask', buffered: true });
  } catch {}
  // WebMCP: record tools the page registers with navigator.modelContext (wrapping a real one if present).
  try {
    const tools = (window.__avcWebmcp = []);
    const note = (t) => { if (t && typeof t === 'object' && tools.length < 50) tools.push({ name: String(t.name || ''), description: t.description ? String(t.description) : undefined, hasSchema: !!t.inputSchema }); };
    const real = navigator.modelContext;
    const mc = {
      registerTool(t) { note(t); return real && real.registerTool ? real.registerTool.apply(real, arguments) : undefined; },
      provideContext(c) { ((c && c.tools) || []).forEach(note); return real && real.provideContext ? real.provideContext.apply(real, arguments) : undefined; },
      unregisterTool() { return real && real.unregisterTool ? real.unregisterTool.apply(real, arguments) : undefined; },
      clearContext() { return real && real.clearContext ? real.clearContext.apply(real, arguments) : undefined; },
    };
    Object.defineProperty(navigator, 'modelContext', { value: mc, configurable: true });
  } catch {}
})();`;

/** A phone: viewport, touch and a mobile Chrome user agent. */
export const MOBILE_DEVICE = {
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
};

/**
 * Runs in the page: rendered image boxes and text whose colour contrast is below WCAG AA.
 * Kept as a string so it is evaluated as-is in the browser.
 */
export const LAYOUT_SCRIPT = `(() => {
  const parse = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const bgOf = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.9) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const images = [];
  for (const img of Array.from(document.images).slice(0, 100)) {
    const r = img.getBoundingClientRect();
    images.push({ src: img.currentSrc || img.src, width: Math.round(r.width), height: Math.round(r.height) });
  }
  const low = [];
  const seen = new Set();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let n = 0;
  while (walker.nextNode() && n < 4000 && low.length < 20) {
    const t = walker.currentNode;
    const text = (t.textContent || '').trim();
    const el = t.parentElement;
    if (!text || text.length < 3 || !el || seen.has(el)) continue;
    seen.add(el); n++;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const fg = parse(cs.color); const bg = bgOf(el);
    if (!fg || !bg || fg.a < 0.9) continue;
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize) || 16; const bold = Number(cs.fontWeight) >= 700;
    const large = px >= 24 || (bold && px >= 18.66);
    if (ratio < (large ? 3 : 4.5)) low.push({ text: text.slice(0, 80), ratio: Math.round(ratio * 100) / 100, fg: cs.color, bg: 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')', large });
  }
  return { viewportWidth: window.innerWidth, images, lowContrast: low };
})()`;

/** Runs in the phone render: overflow, small tap targets, interstitials, smallest text. */
export const MOBILE_SCRIPT = `(() => {
  // A phone zooms out to fit wide content, so the layout viewport grows: compare with the screen.
  const vw = window.innerWidth, vh = window.innerHeight, sw = (screen && screen.width) || vw;
  const doc = document.documentElement;
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.1) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const small = [];
  const targets = document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [onclick]');
  for (const el of Array.from(targets).slice(0, 2000)) {
    if (small.length >= 20) break;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= 24 && r.height >= 24) continue;
    // Links inside a sentence are exempt (WCAG 2.5.8 inline exception).
    if (el.tagName === 'A') {
      const p = el.parentElement;
      const pt = (p && p.textContent || '').trim().length;
      const lt = (el.textContent || '').trim().length;
      if (p && /^(P|LI|TD|SPAN|DD|BLOCKQUOTE|LABEL)$/.test(p.tagName) && pt > lt + 20) continue;
    }
    small.push({ text: ((el.textContent || el.getAttribute('aria-label') || el.getAttribute('name') || el.tagName).trim()).slice(0, 60), width: Math.round(r.width), height: Math.round(r.height) });
  }
  let interstitial = null;
  for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 5000)) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const cover = (w * h) / (vw * vh);
    if (cover >= 0.3 && !/^(HEADER|NAV)$/.test(el.tagName) && el.getAttribute('role') !== 'navigation') {
      const id = el.id ? '#' + el.id : '';
      const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      if (!interstitial || cover > interstitial.coverage) interstitial = { selector: el.tagName.toLowerCase() + id + cls, coverage: Math.round(cover * 100) / 100 };
    }
  }
  let minFont = 0;
  for (const el of Array.from(document.querySelectorAll('p, li, td, span, a')).slice(0, 1500)) {
    if (!(el.textContent || '').trim() || !visible(el)) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    if (px && (!minFont || px < minFont)) minFont = px;
  }
  return { viewportWidth: Math.min(sw, vw), scrollWidth: Math.max(doc.scrollWidth, document.body ? document.body.scrollWidth : 0), smallTargets: small, interstitial, minFontPx: minFont || undefined };
})()`;

/** A 1×1 transparent GIF: images are not downloaded, but keep their CSS layout. */
const BLANK_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Skip image, font and media downloads (faster renders); images get a blank stand-in. */
async function skipHeavy(route: import('playwright-core').Route): Promise<void> {
  const t = route.request().resourceType();
  if (t === 'image')
    return route.fulfill({ status: 200, contentType: 'image/gif', body: BLANK_GIF });
  if (t === 'font' || t === 'media') return route.abort('blockedbyclient');
  return route.continue();
}

export async function renderPages(pages: PageData[], opts: RenderOptions): Promise<RenderSummary> {
  const log = opts.log ?? ((level, m) => (level === 'error' ? console.error(m) : console.warn(m)));
  const todo = pages
    .filter((p) => p.isHtml && p.status >= 200 && p.status < 400)
    .slice(0, Math.max(0, opts.limit));
  if (!todo.length) return { rendered: 0, failed: 0, skipped: true, reason: 'No pages to render.' };

  const chromePath = findChrome(opts.chromePath);
  if (!chromePath) {
    const reason =
      'JavaScript rendering skipped: no Chrome, Chromium or Edge was found. Install Google Chrome, or set AVC_CHROME_PATH to the browser executable.';
    log('warn', reason);
    return { rendered: 0, failed: 0, skipped: true, reason };
  }

  let browser: import('playwright-core').Browser | null = null;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--mute-audio',
      ],
    });
  } catch (e) {
    const reason = `JavaScript rendering skipped: the browser at ${chromePath} could not start (${oneLine((e as Error).message).slice(0, 200)}).`;
    log('warn', reason);
    return { rendered: 0, failed: 0, skipped: true, reason, chromePath };
  }

  let rendered = 0;
  let failed = 0;
  try {
    const extraHeaders: Record<string, string> = { ...opts.headers };
    let httpCredentials: { username: string; password: string } | undefined;
    if (opts.auth && 'cookie' in opts.auth) extraHeaders.cookie = opts.auth.cookie;
    else if (opts.auth) httpCredentials = { username: opts.auth.user, password: opts.auth.pass };
    const context = await browser.newContext({
      ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: extraHeaders,
      ...(httpCredentials ? { httpCredentials } : {}),
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    await context.addInitScript(PERF_INIT);
    if (!opts.loadImages) await context.route('**/*', skipHeavy);

    let next = 0;
    const workers = Array.from(
      { length: Math.min(opts.concurrency ?? 2, todo.length) },
      async () => {
        while (next < todo.length) {
          const page = todo[next++]!;
          try {
            await renderOne(context, page, opts.timeoutMs ?? 20_000, Boolean(opts.loadImages));
            rendered++;
          } catch (e) {
            failed++;
            log(
              'warn',
              `Could not render ${page.url}: ${oneLine((e as Error).message).slice(0, 200)}`,
            );
          }
        }
      },
    );
    await Promise.all(workers);
    await context.close().catch(() => {});

    if (opts.mobile) {
      const sample = todo.filter((p) => p.rendered).slice(0, opts.mobileLimit ?? 10);
      if (sample.length) {
        const phone = await browser.newContext({
          ...MOBILE_DEVICE,
          extraHTTPHeaders: extraHeaders,
          ...(httpCredentials ? { httpCredentials } : {}),
          serviceWorkers: 'block',
          acceptDownloads: false,
        });
        if (!opts.loadImages) await phone.route('**/*', skipHeavy);
        for (const page of sample) {
          try {
            await renderMobile(phone, page, opts.timeoutMs ?? 20_000, Boolean(opts.loadImages));
          } catch (e) {
            log(
              'info',
              `Phone render of ${page.url} failed: ${oneLine((e as Error).message).slice(0, 160)}`,
            );
          }
        }
        await phone.close().catch(() => {});
      }
    }
  } catch (e) {
    log('error', `Rendering stopped: ${oneLine((e as Error).message).slice(0, 200)}`);
  } finally {
    await browser.close().catch(() => {});
  }
  return { rendered, failed, skipped: false, chromePath };
}

async function renderOne(
  context: import('playwright-core').BrowserContext,
  page: PageData,
  timeoutMs: number,
  loadImages: boolean,
): Promise<void> {
  const tab = await context.newPage();
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  tab.on('console', (msg) => {
    if (msg.type() === 'error' && consoleErrors.length < 50)
      consoleErrors.push(oneLine(msg.text()).slice(0, 500));
  });
  tab.on('pageerror', (err) => {
    if (consoleErrors.length < 50)
      consoleErrors.push(oneLine(`Uncaught: ${err.message}`).slice(0, 500));
  });
  tab.on('requestfailed', (req) => {
    const why = req.failure()?.errorText ?? 'failed';
    // Requests we blocked on purpose are not failures of the site.
    if (!loadImages && /BLOCKED_BY_CLIENT/i.test(why)) return;
    if (failedRequests.length < 100) failedRequests.push(`${req.url()} (${why})`);
  });
  tab.on('response', (res) => {
    if (res.status() >= 400 && failedRequests.length < 100)
      failedRequests.push(`${res.url()} (HTTP ${res.status()})`);
  });

  try {
    const started = Date.now();
    await tab.goto(page.finalUrl || page.url, { waitUntil: 'load', timeout: timeoutMs });
    const left = Math.max(1_000, timeoutMs - (Date.now() - started));
    await tab.waitForLoadState('networkidle', { timeout: Math.min(5_000, left) }).catch(() => {});
    const html = await tab.content();
    const metrics = (await tab
      .evaluate(() => {
        const w = window as unknown as { __avcPerf?: { lcp: number; cls: number; tbt: number } };
        const nav = performance.getEntriesByType('navigation')[0] as
          PerformanceNavigationTiming | undefined;
        return {
          domContentLoaded: nav ? nav.domContentLoadedEventEnd : undefined,
          load: nav ? nav.loadEventEnd : undefined,
          lcp: w.__avcPerf?.lcp || undefined,
          cls: w.__avcPerf?.cls,
          tbt: w.__avcPerf?.tbt,
        };
      })
      .catch(() => ({}))) as NonNullable<PageData['rendered']>['timings'];

    const webmcpTools = (await tab
      .evaluate('window.__avcWebmcp || []')
      .catch(() => [])) as NonNullable<PageData['rendered']>['webmcpTools'];
    const layout = (await tab.evaluate(LAYOUT_SCRIPT).catch(() => undefined)) as
      RenderedLayout | undefined;
    const { document } = parseHTML(html) as unknown as { document: Document };
    // Text inside open shadow roots and same-origin iframes is not in page.content():
    // add it, so word counts match what visitors (and rendering crawlers) see.
    const hidden = await flattenedExtraText(tab);
    const text = hidden ? `${pageText(document)}\n${hidden}`.trim() : pageText(document);
    const titleEl = [...document.querySelectorAll('title')].find((t) => !t.closest('svg'));
    page.rendered = {
      html: html.length > 2 * 1024 * 1024 ? html.slice(0, 2 * 1024 * 1024) : html,
      text,
      wordCount: countWords(text),
      title: titleEl ? oneLine(titleEl.textContent) : null,
      links: document.querySelectorAll('a[href]').length,
      headings: headingsOf(document),
      structuredData: structuredDataOf(document),
      consoleErrors,
      failedRequests,
      timings: clean(metrics ?? {}),
      ...(layout && Array.isArray(layout.images) ? { layout } : {}),
      ...(Array.isArray(webmcpTools) && webmcpTools.length ? { webmcpTools } : {}),
    };
  } finally {
    await tab.close().catch(() => {});
  }
}

/** Visible text in open shadow roots, plus same-origin iframe bodies (first 50 KB). */
export const SHADOW_TEXT_SCRIPT = `(() => {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const t = (el.shadowRoot.textContent || '').replace(/\\s+/g, ' ').trim();
        if (t) out.push(t);
        walk(el.shadowRoot);
      }
    }
  };
  try { walk(document); } catch (e) {}
  return out.join('\\n').slice(0, 50000);
})()`;

async function flattenedExtraText(tab: import('playwright-core').Page): Promise<string> {
  const parts: string[] = [];
  const shadow = (await tab.evaluate(SHADOW_TEXT_SCRIPT).catch(() => '')) as string;
  if (shadow) parts.push(shadow);
  const origin = new URL(tab.url()).origin;
  for (const f of tab.frames().slice(1, 10)) {
    try {
      if (new URL(f.url()).origin !== origin) continue;
      const t = (await f.evaluate('document.body ? document.body.innerText : ""')) as string;
      if (t?.trim()) parts.push(t.replace(/\s+/g, ' ').trim().slice(0, 50_000));
    } catch {
      /* detached or cross-origin */
    }
  }
  return parts.join('\n');
}

async function renderMobile(
  context: import('playwright-core').BrowserContext,
  page: PageData,
  timeoutMs: number,
  loadImages: boolean,
): Promise<void> {
  const tab = await context.newPage();
  const failed: string[] = [];
  tab.on('requestfailed', (req) => {
    const why = req.failure()?.errorText ?? 'failed';
    if (!loadImages && /BLOCKED_BY_CLIENT/i.test(why)) return;
    if (failed.length < 100) failed.push(`${req.url()} (${why})`);
  });
  tab.on('response', (res) => {
    if (res.status() >= 400 && failed.length < 100)
      failed.push(`${res.url()} (HTTP ${res.status()})`);
  });
  try {
    await tab.goto(page.finalUrl || page.url, { waitUntil: 'load', timeout: timeoutMs });
    await tab.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    // Pop-ups often appear a moment after load.
    await tab.waitForTimeout(1_000).catch(() => {});
    const html = await tab.content();
    const m = (await tab.evaluate(MOBILE_SCRIPT)) as Omit<
      MobileRender,
      'wordCount' | 'links' | 'failedRequests'
    >;
    const { document } = parseHTML(html) as unknown as { document: Document };
    const desktopFailed = new Set(
      (page.rendered?.failedRequests ?? []).map((f) => f.replace(/ \(.*\)$/, '')),
    );
    if (page.rendered)
      page.rendered.mobile = {
        ...m,
        wordCount: countWords(pageText(document)),
        links: document.querySelectorAll('a[href]').length,
        failedRequests: failed.filter((f) => !desktopFailed.has(f.replace(/ \(.*\)$/, ''))),
      };
  } finally {
    await tab.close().catch(() => {});
  }
}

/** Screenshot of one URL as a desktop or a phone. PNG bytes, or an error message. */
export async function captureScreenshot(
  url: string,
  opts: {
    device?: 'desktop' | 'mobile';
    fullPage?: boolean;
    chromePath?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ ok: true; png: Buffer } | { ok: false; error: string }> {
  const chromePath = findChrome(opts.chromePath);
  if (!chromePath)
    return { ok: false, error: 'Screenshots need Chrome, Chromium or Edge (AVC_CHROME_PATH).' };
  let browser: import('playwright-core').Browser | null = null;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext(
      opts.device === 'mobile' ? MOBILE_DEVICE : { viewport: { width: 1366, height: 900 } },
    );
    const tab = await context.newPage();
    await tab.goto(url, { waitUntil: 'load', timeout: opts.timeoutMs ?? 30_000 });
    await tab.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    const png = await tab.screenshot({ fullPage: Boolean(opts.fullPage), type: 'png' });
    return { ok: true, png };
  } catch (e) {
    return { ok: false, error: oneLine((e as Error).message).slice(0, 300) };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Print HTML to PDF with the local browser (A4, backgrounds on). */
export async function htmlToPdf(
  html: string,
  opts: { chromePath?: string } = {},
): Promise<{ ok: true; pdf: Buffer } | { ok: false; error: string }> {
  const chromePath = findChrome(opts.chromePath);
  if (!chromePath)
    return { ok: false, error: 'PDF export needs Chrome, Chromium or Edge (AVC_CHROME_PATH).' };
  let browser: import('playwright-core').Browser | null = null;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const tab = await browser.newPage();
    await tab.setContent(html, { waitUntil: 'load', timeout: 60_000 });
    const pdf = await tab.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '14mm', left: '10mm', right: '10mm' },
    });
    return { ok: true, pdf };
  } catch (e) {
    return { ok: false, error: oneLine((e as Error).message).slice(0, 300) };
  } finally {
    await browser?.close().catch(() => {});
  }
}

function clean<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o))
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 1000) / 1000;
  return out as T;
}
