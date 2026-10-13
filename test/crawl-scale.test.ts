import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crawlSite } from '../src/crawl/index.js';

describe('crawl at scale', () => {
  it('crawls 500 pages quickly and survives bad pages', async () => {
    const server = createServer((req, res) => {
      const n = Number((req.url ?? '/').replace(/\D/g, '') || 0);
      if (req.url === '/robots.txt') return res.writeHead(404).end();
      if (n % 97 === 13) {
        // A broken page: headers sent, then the connection drops.
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('<html><body><a href="/p1">');
        return res.destroy();
      }
      const links = [1, 2, 3, 7]
        .map((k) => `<a href="/p${n * 4 + k}">Page ${n * 4 + k}</a>`)
        .join(' ');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html lang="en"><head><title>Page ${n}</title></head><body><nav><a href="/">Home</a></nav><main><h1>Page ${n}</h1><p>${'Some words about page number '.repeat(40)}${n}</p>${links}</main></body></html>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const t0 = Date.now();
    const site = await crawlSite({
      startUrl: url,
      delayMs: 0,
      concurrency: 8,
      render: false,
      maxPages: 500,
      maxDepth: 20,
    });
    const ms = Date.now() - t0;
    server.close();
    expect(site.stats.pagesCrawled).toBe(500);
    expect(site.pages.size).toBe(500);
    expect(ms).toBeLessThan(30_000);
  }, 60_000);
});
