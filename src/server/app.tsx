/**
 * The local dashboard (Hono, server-rendered JSX). `createApp()` builds the app so tests can
 * call `app.request()`; `src/server/index.ts` binds it to 127.0.0.1.
 *
 * Security model: the server listens on loopback only. Every request must carry an allowed
 * Host header (blocks DNS rebinding) and the session cookie, which is set from the one-time
 * token in the URL printed at start. State-changing requests must come from the dashboard's
 * own origin (Origin / Sec-Fetch-Site), and the cookie is SameSite=Strict.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { JobManager } from './jobs.js';
import { Layout } from './ui.js';
import { registerSitePages } from './pages/site.js';
import { registerAiPages } from './pages/ai.js';
import { registerOpsPages } from './pages/ops.js';
import { registerKeysPages } from './pages/keys.js';
import { registerExplorePages } from './pages/explore.js';

export const COOKIE = 'avc_session';

export interface AppOptions {
  token: string;
  /** host:port values accepted in the Host header (loopback names are added for the port). */
  port: number;
  extraHosts?: string[];
  jobs?: JobManager;
}

export interface ServerEnv {
  Variables: { flash: { kind: 'ok' | 'warn' | 'error' | 'info'; text: string } | null };
}

export type AppContext = Context<ServerEnv>;

export interface Deps {
  jobs: JobManager;
  token: string;
}

/** Find public/ (next to src/ or dist/, or the package root). */
export function publicDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const p = join(dir, 'public');
    if (existsSync(join(p, 'app.css'))) return p;
    dir = dirname(dir);
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function allowedHosts(port: number, extra: string[] = []): Set<string> {
  const set = new Set<string>();
  for (const h of ['127.0.0.1', 'localhost', '[::1]', ...extra]) {
    set.add(`${h}:${port}`.toLowerCase());
    if (port === 80) set.add(h.toLowerCase());
  }
  return set;
}

export function createApp(opts: AppOptions) {
  const app = new Hono<ServerEnv>();
  const hosts = allowedHosts(opts.port, opts.extraHosts);
  const deps: Deps = { jobs: opts.jobs ?? new JobManager(), token: opts.token };
  const assets = publicDir();

  // 1. Host header (DNS rebinding) and security headers.
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!hosts.has(host)) return c.text('Forbidden: unexpected Host header.', 403);
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    // same-origin, not no-referrer: no-referrer makes browsers send `Origin: null` on posts.
    c.header('Referrer-Policy', 'same-origin');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (!c.res.headers.get('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  // 2. Static assets (no session needed: they hold nothing private).
  app.get('/assets/:file', (c) => {
    const file = c.req.param('file');
    if (!assets || !/^[a-z0-9-]+\.(css|js|png)$/i.test(file)) return c.notFound();
    const p = join(assets, file);
    if (!existsSync(p)) return c.notFound();
    const type = file.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : file.endsWith('.png')
        ? 'image/png'
        : 'text/javascript; charset=utf-8';
    return c.body(readFileSync(p), 200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  });

  // 3. Session: one-time token in the URL → cookie; every other request needs the cookie.
  app.use('*', async (c, next) => {
    const qToken = c.req.query('token');
    if (qToken !== undefined) {
      if (!safeEqual(qToken, opts.token)) return c.html(denied(), 401);
      setCookie(c, COOKIE, opts.token, { httpOnly: true, sameSite: 'Strict', path: '/' });
      const url = new URL(c.req.url);
      url.searchParams.delete('token');
      return c.redirect(url.pathname + (url.search || ''), 302);
    }
    const cookie = getCookie(c, COOKIE);
    if (!cookie || !safeEqual(cookie, opts.token)) return c.html(denied(), 401);

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      // Browsers send `Origin: null` on form posts from a page whose referrer policy hides
      // the origin; then only the browser-set Sec-Fetch-Site header can vouch for the request.
      if (origin === 'null') {
        if (site !== 'same-origin') return c.text('Forbidden: cross-origin request.', 403);
      } else if (origin) {
        let originHost = '';
        try {
          originHost = new URL(origin).host.toLowerCase();
        } catch {
          /* invalid */
        }
        if (!hosts.has(originHost)) return c.text('Forbidden: cross-origin request.', 403);
      } else if (site && site !== 'same-origin' && site !== 'none') {
        return c.text('Forbidden: cross-site request.', 403);
      }
    }
    const msg = c.req.query('msg');
    const kind = c.req.query('kind') as 'ok' | 'warn' | 'error' | 'info' | undefined;
    c.set(
      'flash',
      msg
        ? {
            kind: kind && ['ok', 'warn', 'error', 'info'].includes(kind) ? kind : 'info',
            text: msg.slice(0, 500),
          }
        : null,
    );
    await next();
  });

  registerSitePages(app, deps);
  registerExplorePages(app, deps);
  registerAiPages(app, deps);
  registerOpsPages(app, deps);
  registerKeysPages(app, deps);

  app.notFound((c) =>
    c.html(
      <Layout title="Not found">
        <p>That page does not exist.</p>
        <a class="btn" href="/">
          Back to sites
        </a>
      </Layout>,
      404,
    ),
  );
  app.onError((err, c) => {
    console.error(err);
    return c.html(
      <Layout title="Something went wrong" flash={{ kind: 'error', text: err.message }}>
        <p>The dashboard hit an error. The terminal that runs `avc ui` has the details.</p>
        <a class="btn" href="/">
          Back to sites
        </a>
      </Layout>,
      500,
    );
  });
  return app;
}

function denied() {
  return (
    '<!doctype html><meta charset="utf-8"><title>Sign in needed</title>' +
    '<body style="background:#0a0a0b;color:#e8e8e8;font:16px system-ui;padding:40px;max-width:640px">' +
    '<h1 style="font-weight:600">Open the link from your terminal</h1>' +
    '<p style="color:#9aa4ae">This dashboard only accepts the browser that opened the link printed by <code>avc ui</code>. ' +
    'It carries a one-time session token, so other pages and programs on your machine cannot use it.</p></body>'
  );
}

/** Redirect with a flash message. */
export function back(
  c: AppContext,
  path: string,
  text: string,
  kind: 'ok' | 'warn' | 'error' | 'info' = 'ok',
) {
  const sep = path.includes('?') ? '&' : '?';
  return c.redirect(`${path}${sep}msg=${encodeURIComponent(text)}&kind=${kind}`, 303);
}

/** Read a form body as a plain object (multi-value fields as arrays). */
export async function form(c: AppContext): Promise<Record<string, string | string[]>> {
  const body = await c.req.parseBody({ all: true });
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) out[k] = v.map(String);
    else out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

export function str(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : (v ?? '')).trim();
}

export function arr(v: string | string[] | undefined): string[] {
  return (Array.isArray(v) ? v : v ? [v] : []).map((s) => s.trim()).filter(Boolean);
}
