import { mkdtempSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyseLogs,
  expandLogPaths,
  extractCidrs,
  ipInRanges,
  loadIpRanges,
  normaliseIp,
  parseCidr,
  parseLogLine,
  verifyByRdns,
  type LogResolver,
} from '../src/connect/logs.js';
import type { FetchFn } from '../src/connect/google-api.js';

const FIX = join(import.meta.dirname, 'fixtures', 'logs');
const fixture = (n: string) => readFileSync(join(FIX, n), 'utf8');

const RANGE_FILES: Record<string, string> = {
  'https://openai.com/gptbot.json': 'gptbot-ranges.json',
  'https://openai.com/searchbot.json': 'searchbot-ranges.json',
  'https://openai.com/chatgpt-user.json': 'chatgpt-user-ranges.json',
};

function rangesFetch(calls: string[] = []): FetchFn {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    const file = RANGE_FILES[url] && join('ranges', RANGE_FILES[url]);
    return file ? new Response(fixture(file)) : new Response('not found', { status: 404 });
  };
}

const resolver: LogResolver = {
  async reverse(ip) {
    if (ip === '66.249.66.1') return ['crawl-66-249-66-1.googlebot.com'];
    const e = new Error('not found') as NodeJS.ErrnoException;
    e.code = 'ENOTFOUND';
    throw e;
  },
  async lookup(host) {
    if (host === 'crawl-66-249-66-1.googlebot.com') return ['66.249.66.1'];
    return [];
  },
};

const SITE = ['/', '/services/web-development', '/pricing', '/about', '/contact', '/faq'].map(
  (p) => `https://example.com${p}`,
);

describe('parseLogLine', () => {
  it('parses nginx combined', () => {
    const r = parseLogLine(fixture('nginx-access.log').split('\n')[1])!;
    expect(r).toMatchObject({ ip: '192.0.2.15', method: 'GET', path: '/robots.txt', status: 200 });
    expect(r.ua).toContain('GPTBot/1.3');
    expect(new Date(r.ts!).toISOString()).toBe('2026-10-10T06:25:04.000Z');
  });
  it('parses apache vhost_combined and time zones', () => {
    const r = parseLogLine(fixture('apache-vhost.log').split('\n')[0])!;
    expect(r.ip).toBe('192.0.2.15');
    expect(new Date(r.ts!).toISOString()).toBe('2026-10-11T00:00:00.000Z');
  });
  it('parses Caddy, Cloudflare, Vercel and Netlify JSON', () => {
    const caddy = parseLogLine(fixture('caddy.json').split('\n')[0])!;
    expect(caddy).toMatchObject({ ip: '192.0.2.15', path: '/blog/ai-visibility', status: 200 });
    expect(caddy.ua).toContain('GPTBot');
    const cf = fixture('cloudflare.ndjson').split('\n');
    expect(parseLogLine(cf[0])).toMatchObject({ ip: '192.0.2.40', path: '/pricing', status: 200 });
    expect(new Date(parseLogLine(cf[0])!.ts!).toISOString()).toBe('2026-10-11T12:00:00.000Z');
    expect(parseLogLine(cf[1])!.status).toBe(403);
    const v = parseLogLine(fixture('vercel.ndjson').split('\n')[0])!;
    expect(v).toMatchObject({ ip: '198.51.100.9', path: '/about', status: 200 });
    expect(v.ua).toContain('Claude-User');
    const n = fixture('netlify.ndjson').split('\n');
    expect(parseLogLine(n[0])).toMatchObject({ ip: '192.0.2.80', path: '/faq', status: 200 });
    expect(parseLogLine(n[1])).toMatchObject({ ip: '203.0.113.10', path: '/' });
  });
  it('rejects garbage', () => {
    expect(parseLogLine('this line is garbage')).toBeNull();
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('{not json')).toBeNull();
  });
});

describe('IP helpers', () => {
  it('matches v4 and v6 CIDRs', () => {
    const r = [parseCidr('192.0.2.0/27')!, parseCidr('2001:db8::/48')!];
    expect(ipInRanges('192.0.2.31', r)).toBe(true);
    expect(ipInRanges('192.0.2.32', r)).toBe(false);
    expect(ipInRanges('2001:db8:0:ffff::1', r)).toBe(true);
    expect(ipInRanges('2001:db8:1::1', r)).toBe(false);
  });
  it('normalises IPs', () => {
    expect(normaliseIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normaliseIp('[2001:DB8::1]:443')).toBe('2001:db8::1');
    expect(normaliseIp('192.0.2.1:8080')).toBe('192.0.2.1');
    expect(normaliseIp('-')).toBe('');
  });
  it('extracts CIDRs from JSON and text', () => {
    expect(extractCidrs(fixture('ranges/gptbot-ranges.json'))).toEqual([
      '192.0.2.0/27',
      '2001:db8::/48',
    ]);
    expect(extractCidrs('192.0.2.0/24\n198.51.100.0/24\n')).toHaveLength(2);
  });
  it('verifies by reverse + forward DNS', async () => {
    expect(await verifyByRdns('66.249.66.1', ['googlebot.com'], resolver)).toBe(true);
    expect(await verifyByRdns('203.0.113.66', ['googlebot.com'], resolver)).toBe(false);
  });
});

describe('loadIpRanges', () => {
  it('caches for 7 days and falls back to a stale cache', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'avc-ranges-'));
    const calls: string[] = [];
    let now = 1_000_000;
    const url = 'https://openai.com/gptbot.json';
    const a = await loadIpRanges(url, { dataDir, fetch: rangesFetch(calls), now: () => now });
    expect(a).toEqual(['192.0.2.0/27', '2001:db8::/48']);
    now += 6 * 86_400_000;
    await loadIpRanges(url, { dataDir, fetch: rangesFetch(calls), now: () => now });
    expect(calls).toHaveLength(1);
    now += 2 * 86_400_000;
    const failing: FetchFn = async () => new Response('', { status: 500 });
    expect(await loadIpRanges(url, { dataDir, fetch: failing, now: () => now })).toEqual(a);
  });
});

describe('analyseLogs', () => {
  it('counts, verifies and flags spoofed hits in nginx logs', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'avc-logs-'));
    const r = await analyseLogs([join(FIX, 'nginx-access.log')], {
      siteUrls: SITE,
      dataDir,
      fetch: rangesFetch(),
      resolver,
    });
    expect(r.lines).toBe(15);
    expect(r.range).toEqual({ start: '2026-10-10T06:25:01.000Z', end: '2026-10-10T12:00:00.000Z' });
    const by = Object.fromEntries(r.bots.map((b) => [b.token, b]));
    expect(by.GPTBot).toMatchObject({ hits: 5, verified: 3, spoofed: 2, operator: 'OpenAI' });
    expect(by.GPTBot.statuses).toEqual({ '200': 2, '404': 1 });
    expect(by['OAI-SearchBot']).toMatchObject({ hits: 1, verified: 1, spoofed: 0 });
    expect(by['OAI-SearchBot'].topPaths).toEqual([{ path: '/services/web-development', hits: 1 }]);
    expect(by['ChatGPT-User']).toMatchObject({ hits: 1, verified: 1 });
    expect(by.Googlebot).toMatchObject({ hits: 2, verified: 1, spoofed: 1 });
    expect(by.ClaudeBot).toMatchObject({ hits: 2, verified: 0, spoofed: 0 });
    expect(by.PerplexityBot.lastSeen).toBe('2026-10-10T12:00:00.000Z');
    expect(r.errorsServedToBots).toEqual([
      { path: '/services/web-development', status: 503, bot: 'ClaudeBot', hits: 2 },
      { path: '/blog/old-post', status: 404, bot: 'GPTBot', hits: 1 },
    ]);
    expect(r.neverFetched).toEqual([
      'https://example.com/',
      'https://example.com/contact',
      'https://example.com/faq',
    ]);
  });

  it('reads gzip files, globs and mixed JSON formats; respects since', async () => {
    const r = await analyseLogs([join(FIX, '*.{gz,json,ndjson}'), join(FIX, 'apache-vhost.log')], {
      verify: false,
      since: new Date('2026-10-10T08:00:00Z'),
    });
    expect(r.files.map((f) => f.split(/[\\/]/).pop()).sort()).toEqual([
      'apache-vhost.log',
      'caddy.json',
      'cloudflare.ndjson',
      'netlify.ndjson',
      'nginx-access.log.1.gz',
      'vercel.ndjson',
    ]);
    const by = Object.fromEntries(r.bots.map((b) => [b.token, b]));
    // GPTBot: 0 from gz after 08:00, 1 caddy, 1 apache
    expect(by.GPTBot.hits).toBe(2);
    expect(by['OAI-SearchBot'].hits).toBe(3); // gz 1 + cloudflare 2
    expect(by['Claude-User'].hits).toBe(1);
    expect(by.PerplexityBot.hits).toBe(2);
    expect(by.GPTBot.verified).toBe(0);
    expect(r.errorsServedToBots).toContainEqual({
      path: '/pricing',
      status: 403,
      bot: 'OAI-SearchBot',
      hits: 1,
    });
  });

  it('accepts an injected bot list', async () => {
    const r = await analyseLogs([join(FIX, 'nginx-access.log')], {
      verify: false,
      bots: [{ token: 'curl', operator: 'Test', purpose: 'user', role: 'x' }],
    });
    expect(r.bots).toEqual([]);
    const r2 = await analyseLogs([join(FIX, 'apache-vhost.log')], {
      verify: false,
      bots: [{ token: 'curl', operator: 'Test', purpose: 'user', role: 'x' }],
    });
    expect(r2.bots[0]).toMatchObject({ token: 'curl', hits: 1 });
  });

  it('expands directories and skips missing files', async () => {
    const files = await expandLogPaths([FIX, join(FIX, 'nope.log')]);
    expect(files).toHaveLength(7); // files directly in the folder, not ranges/
  });

  it('streams a large file quickly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avc-big-'));
    const path = join(dir, 'big.log');
    const sample = fixture('nginx-access.log').trim().split('\n');
    const ws = createWriteStream(path);
    const N = 200_000;
    for (let i = 0; i < N; i += sample.length) {
      if (!ws.write(sample.join('\n') + '\n')) await new Promise((r) => ws.once('drain', r));
    }
    await new Promise<void>((r) => ws.end(r));
    const t0 = Date.now();
    const r = await analyseLogs([path], { verify: false });
    expect(r.lines).toBeGreaterThanOrEqual(N);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30_000);

  it('handles an empty log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'avc-empty-'));
    writeFileSync(join(dir, 'a.log'), '');
    const r = await analyseLogs([join(dir, 'a.log')], { verify: false });
    expect(r).toMatchObject({ lines: 0, range: null, bots: [], neverFetched: [] });
  });
});
