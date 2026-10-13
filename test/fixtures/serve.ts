/**
 * A local HTTP server for the fixture website in test/fixtures/site.
 *
 * Clean URLs map to .html files (/about → about.html, /services/ →
 * services/index.html). {{ORIGIN}} in .xml/.txt files becomes the server's
 * origin. Special routes:
 *
 *   /old-pricing      301 → /pricing-2023 → 301 → /pricing (a redirect chain)
 *   /pricing          200 (inline HTML)
 *   /loop-a ↔ /loop-b redirect loop
 *   /server-error     500
 *   /x-robots         200 with X-Robots-Tag: noindex
 *   /about            200 with a Link header (hreflang alternate)
 *   /sitemap-blog.xml.gz   gzip of sitemap-blog.xml
 *   /slow             answers after 3 s
 *   anything missing  404 with 404.html
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'site');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

const PRICING = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Pricing | Northwind Joinery</title>
<meta name="description" content="Typical prices for handmade kitchens and wardrobes."></head>
<body><main><h1>Pricing</h1><p>Kitchens usually start from the price on our quote; every job is measured and priced individually.</p></main></body></html>`;

export interface FixtureServer {
  url: string;
  close(): Promise<void>;
  /** Paths requested so far, in order (method + path). */
  requests: string[];
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  let origin = '';

  const send = (
    res: ServerResponse,
    status: number,
    body: string | Buffer,
    type: string,
    extra: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      'content-type': type,
      'content-length': Buffer.byteLength(body),
      server: 'fixture',
      ...extra,
    });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  };
  const redirect = (res: ServerResponse, status: number, to: string) => {
    res.writeHead(status, { location: to, 'content-length': 0 });
    res.end();
  };

  async function readSite(rel: string): Promise<Buffer | null> {
    const file = normalize(join(FIXTURE_ROOT, rel));
    if (!file.startsWith(FIXTURE_ROOT)) return null;
    try {
      const s = await stat(file);
      if (!s.isFile()) return null;
      return await readFile(file);
    } catch {
      return null;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', origin);
    const path = decodeURIComponent(u.pathname);
    requests.push(`${req.method} ${u.pathname}${u.search}`);

    switch (path) {
      case '/old-pricing':
        return redirect(res, 301, '/pricing-2023');
      case '/pricing-2023':
        return redirect(res, 301, `${origin}/pricing`);
      case '/pricing':
        return send(res, 200, PRICING, TYPES['.html']!);
      case '/loop-a':
        return redirect(res, 302, '/loop-b');
      case '/loop-b':
        return redirect(res, 302, '/loop-a');
      case '/server-error':
        return send(
          res,
          500,
          '<!doctype html><title>Error</title><h1>Internal error</h1>',
          TYPES['.html']!,
        );
      case '/slow':
        await new Promise((r) => setTimeout(r, 3000));
        return send(
          res,
          200,
          '<!doctype html><title>Slow</title><p>Slow page</p>',
          TYPES['.html']!,
        );
      case '/sitemap-blog.xml.gz': {
        const xml = await readSite('sitemap-blog.xml');
        const body = gzipSync(Buffer.from(xml!.toString('utf8').replaceAll('{{ORIGIN}}', origin)));
        return send(res, 200, body, 'application/gzip');
      }
    }

    const candidates = path.endsWith('/')
      ? [`${path}index.html`]
      : extname(path)
        ? [path]
        : path.startsWith('/.well-known/')
          ? [path] // extensionless discovery documents (oauth-*, api-catalog…)
          : [`${path}.html`, `${path}/index.html`];
    for (const c of candidates) {
      const buf = await readSite(c);
      if (!buf) continue;
      const ext = extname(c);
      let body: string | Buffer = buf;
      const wellKnown = c.startsWith('/.well-known/');
      if (ext === '.xml' || ext === '.txt' || ext === '.json' || wellKnown)
        body = buf.toString('utf8').replaceAll('{{ORIGIN}}', origin);
      const extra: Record<string, string> = {};
      if (path === '/x-robots') extra['x-robots-tag'] = 'noindex, nofollow';
      if (path === '/about') extra.link = `<${origin}/about>; rel="alternate"; hreflang="en-gb"`;
      if (path === '/') extra['x-powered-by'] = 'Hugo';
      const type =
        TYPES[ext] ??
        (wellKnown
          ? c.endsWith('api-catalog')
            ? 'application/linkset+json'
            : 'application/json'
          : 'application/octet-stream');
      return send(res, 200, body, type, extra);
    }
    const notFound = (await readSite('404.html'))!;
    return send(res, 404, notFound, TYPES['.html']!);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return {
    url: origin,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
