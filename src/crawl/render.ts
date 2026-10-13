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
import type { PageData } from '../core/types.js';
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
})();`;

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
    if (!opts.loadImages) {
      await context.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'font' || t === 'media') return route.abort('blockedbyclient');
        return route.continue();
      });
    }

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

    const { document } = parseHTML(html) as unknown as { document: Document };
    const text = pageText(document);
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
    };
  } finally {
    await tab.close().catch(() => {});
  }
}

function clean<T extends object>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o))
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 1000) / 1000;
  return out as T;
}
