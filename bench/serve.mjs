#!/usr/bin/env node
// Zero-dependency static server for the benchmark ground-truth site (bench/site).
//
//   node bench/serve.mjs [--port 8800] [--host 127.0.0.1] [--site bench/site] [--log]
//
// Programmatic use:
//   import { startBenchServer } from './bench/serve.mjs';
//   const { url, close } = await startBenchServer({ port: 0 });
//
// Besides serving files it implements the HTTP-level behaviour that some planted defects need
// (redirects, error statuses, per-path headers, a slow path, a user-agent firewall rule, content
// negotiation on one page, gzip on/off). Every rule below is listed in bench/ground-truth.json.
// The literal {{ORIGIN}} in text files is replaced with the origin of each request
// (http://<Host header>), so absolute URLs always point back at this server.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SITE = path.join(HERE, 'site');

// --- rules -----------------------------------------------------------------------------------
const REDIRECTS = {
  '/book-now': [301, '/booking'], // chain: /book-now -> /booking -> /book
  '/booking': [301, '/book'],
  '/special-offer': [301, '/special-offer-2024'], // loop
  '/special-offer-2024': [301, '/special-offer'],
  '/team/dr-hart': [302, '/team/dr-amelia-hart'], // temporary redirect for a permanent move
  '/locations/bristol-clinic': [301, '/locations/bristol'], // internally linked redirect
  '/old-prices': [301, '/prices-2023'], // redirect to a 404
  '/blog/nervous-patients-guide': [301, '/blog/nervous-patients'], // canonical target that redirects
  '/blog/tooth-brushing-guide': [301, '/blog/how-to-brush-your-teeth'], // redirect listed in sitemap
};
const STATUS = {
  '/blog/open-day-2019': [410, '410.html'],
  '/offers': [500, null],
};
const EXTRA_HEADERS = {
  '/blog/fluoride-facts': { 'X-Robots-Tag': 'noindex' },
  '/legal/cookies': { Server: 'Apache/2.4.29 (Ubuntu)', 'X-Powered-By': 'PHP/7.2.24' },
  '/': { Link: '</.well-known/api-catalog>; rel="api-catalog"' },
};
const NO_SECURITY_HEADERS = new Set(['/pricing']);
const NO_CHARSET = new Set(['/blog/page/3']);
const NO_GZIP = new Set(['/blog/category/oral-health']);
const DELAY_MS = { '/team': 2500 };
const MARKDOWN_NEGOTIATION = { '/faq': 'faq.md' };
// "Firewall" rule: AI crawler user agents get a 403 challenge page on every treatment page.
const WAF_PREFIX = '/services/';
const AI_BOT_UA = /(ClaudeBot|Claude-SearchBot|Claude-User|anthropic-ai|OAI-SearchBot|GPTBot|ChatGPT-User|PerplexityBot|Perplexity-User|Google-Extended|CCBot|Applebot-Extended|Bytespider|meta-externalagent|cohere-ai|Amazonbot)/i;

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};
const WELL_KNOWN_TYPES = {
  '/.well-known/api-catalog': 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
  '/.well-known/oauth-authorization-server': 'application/json',
  '/.well-known/oauth-protected-resource': 'application/json',
};
const TEXTUAL = /^(text\/|application\/(json|xml|linkset\+json|javascript))|image\/svg/;

function resolveFile(site, pathname) {
  if (pathname === '/') return path.join(site, 'index.html');
  const rel = pathname.replace(/^\/+/, '');
  if (rel.split('/').some((seg) => seg === '..' || seg === '')) return null;
  const direct = path.join(site, rel);
  // HTML pages are served without the .html extension (except the map embed under /maps/).
  if (path.extname(rel) === '.html' && !rel.startsWith('maps/')) return null;
  if (path.extname(rel) || rel.startsWith('.well-known/')) return isFile(direct) ? direct : null;
  const html = direct + '.html';
  return isFile(html) ? html : null;
}
function isFile(f) {
  try { return fs.statSync(f).isFile(); } catch { return false; }
}

function handler(site, log) {
  return (req, res) => {
    const started = Date.now();
    const origin = `http://${req.headers.host || 'localhost'}`;
    let url;
    try { url = new URL(req.url, origin); } catch { res.writeHead(400).end(); return; }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
    const ua = req.headers['user-agent'] || '';
    const accept = req.headers.accept || '';
    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const finish = (status, headers, body) => {
      const h = { ...headers };
      const type = h['Content-Type'] || '';
      if (!NO_SECURITY_HEADERS.has(pathname)) {
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== 'Content-Security-Policy' || type.startsWith('text/html')) h[k] = v;
      }
      if (body && body.length && TEXTUAL.test(type)) {
        h.Vary = h.Vary ? `${h.Vary}, Accept-Encoding` : 'Accept-Encoding';
        if (acceptsGzip && !NO_GZIP.has(pathname) && body.length > 256) {
          body = zlib.gzipSync(body);
          h['Content-Encoding'] = 'gzip';
        }
      }
      h['Content-Length'] = body ? body.length : 0;
      const delay = DELAY_MS[pathname] || 0;
      setTimeout(() => {
        res.writeHead(status, h);
        res.end(req.method === 'HEAD' ? undefined : body);
        if (log) console.log(`${req.method} ${pathname} ${status} ${Date.now() - started}ms ${ua.slice(0, 60)}`);
      }, delay);
    };
    const readText = (file) => Buffer.from(fs.readFileSync(file, 'utf8').split('{{ORIGIN}}').join(origin));
    const page = (status, file, extra = {}) => finish(status, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache', ...extra }, readText(path.join(site, file)));

    if (req.method === 'POST' && (pathname === '/contact' || pathname === '/book')) {
      req.resume();
      return finish(303, { Location: `${origin}/thank-you`, 'Content-Type': 'text/plain; charset=utf-8' }, Buffer.from('See Other'));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return finish(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, Buffer.from('Method Not Allowed'));

    // trailing slash -> canonical form without slash
    if (pathname.length > 1 && pathname.endsWith('/') && !pathname.startsWith('/.well-known/')) {
      return finish(301, { Location: origin + pathname.replace(/\/+$/, '') + url.search, 'Content-Type': 'text/plain; charset=utf-8' }, Buffer.from('Moved Permanently'));
    }
    if (pathname.startsWith(WAF_PREFIX) && AI_BOT_UA.test(ua)) {
      return finish(403, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store', 'X-Firewall': 'bot-challenge' }, Buffer.from(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Request blocked</title><meta name="robots" content="noindex"></head><body><h1>Request blocked</h1><p>Our firewall has blocked this request because it looks automated. If you are a person, please enable JavaScript and cookies and try again.</p></body></html>'));
    }
    if (REDIRECTS[pathname]) {
      const [status, to] = REDIRECTS[pathname];
      return finish(status, { Location: origin + to, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }, Buffer.from(status === 302 ? 'Found' : 'Moved Permanently'));
    }
    if (STATUS[pathname]) {
      const [status, file] = STATUS[pathname];
      if (file) return page(status, file);
      return finish(status, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' }, Buffer.from('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Internal Server Error</title></head><body><h1>Internal Server Error</h1></body></html>'));
    }
    if (MARKDOWN_NEGOTIATION[pathname] && /text\/markdown/.test(accept)) {
      return finish(200, { 'Content-Type': TYPES['.md'], Vary: 'Accept', 'Cache-Control': 'public, max-age=300' }, readText(path.join(site, MARKDOWN_NEGOTIATION[pathname])));
    }

    const file = resolveFile(site, pathname);
    if (!file) return page(404, '404.html');
    const ext = path.extname(file);
    let type = WELL_KNOWN_TYPES[pathname] || TYPES[ext] || 'application/octet-stream';
    if (NO_CHARSET.has(pathname)) type = 'text/html';
    const headers = { 'Content-Type': type, ...(EXTRA_HEADERS[pathname] || {}) };
    if (MARKDOWN_NEGOTIATION[pathname]) headers.Vary = 'Accept';
    headers['Cache-Control'] = /^\/(assets|images)\//.test(pathname) || /^\/favicon\./.test(pathname) ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
    const body = TEXTUAL.test(type) ? readText(file) : fs.readFileSync(file);
    return finish(200, headers, body);
  };
}

export function startBenchServer({ port = 8800, host = '127.0.0.1', site = DEFAULT_SITE, log = false } = {}) {
  const root = path.resolve(site);
  if (!fs.existsSync(path.join(root, 'index.html'))) throw new Error(`No index.html in ${root}`);
  const server = http.createServer(handler(root, log));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      resolve({
        url: `http://${h.includes(':') ? `[${h}]` : h}:${addr.port}`,
        server,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  const { url } = await startBenchServer({
    port: Number(opt('port', 8800)), host: opt('host', '127.0.0.1'), site: opt('site', DEFAULT_SITE), log: args.includes('--log'),
  });
  console.log(url);
}
