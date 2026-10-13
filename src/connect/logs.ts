/**
 * Server-log analysis of real AI crawler visits.
 *
 * Streams access logs line by line (no full load), so a few million lines are
 * fine. Formats: Nginx/Apache "combined" (and vhost_combined), Caddy JSON,
 * Cloudflare Logpush, Vercel log drains, Netlify log drains and most other
 * JSON-per-line exports. Gzip files and glob patterns are supported.
 *
 * A User-Agent only says who a request claims to be. Hits are verified against
 * the operator's published IP ranges (cached for 7 days in <dataDir>/cache) and,
 * where the operator documents it, reverse + forward DNS. Hits that fail the
 * check are counted as spoofed and left out of statuses, paths and errors.
 */
import { createHash } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { AI_BOTS, type AiBot } from '../agentic/bots.js';
import type { LogInsights } from '../core/types.js';
import { mapLimit, type FetchFn } from './google-api.js';

export interface LogResolver {
  reverse(ip: string): Promise<string[]>;
  lookup(host: string): Promise<string[]>;
}

export interface AnalyseLogsOptions {
  /** Key pages of the site; those no AI bot fetched end up in `neverFetched`. */
  siteUrls?: string[];
  /** Bot list (default AI_BOTS). */
  bots?: AiBot[];
  /** Verify hits by IP ranges / reverse DNS. Default true. */
  verify?: boolean;
  /** Ignore lines before this time. */
  since?: Date;
  /** Use reverse DNS for bots that document it (Googlebot, Bingbot, Applebot…). Default true when verifying. */
  rdns?: boolean;
  /** Max unique IPs to check by DNS. Default 300. */
  maxRdnsLookups?: number;
  /** Where the IP-range cache lives. Default ~/.avc (or AVC_DATA_DIR). */
  dataDir?: string;
  /** Cache lifetime for IP-range files. Default 7 days. */
  rangesMaxAgeMs?: number;
  fetch?: FetchFn;
  resolver?: LogResolver;
  /** Bots whose visits count for `neverFetched`. Default: every bot except classic search crawlers. */
  neverFetchedBots?: (bot: AiBot) => boolean;
  onProgress?: (p: { file: string; lines: number }) => void;
  now?: () => number;
}

export interface ParsedLogLine {
  ip: string;
  ts: number | null; // epoch ms
  method: string;
  path: string;
  status: number;
  ua: string;
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

const Q = '"((?:[^"\\\\]|\\\\.)*)"';
// %h %l %u %t "%r" %>s %b ["%{Referer}i" "%{User-agent}i"]
const CLF = new RegExp(
  `^(\\S+) \\S+ (?:"[^"]*"|\\S+) \\[([^\\]]+)\\] ${Q} (\\d{3}|-) (\\S+)(?: ${Q} ${Q})?`,
);
const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/** "10/Oct/2026:13:55:36 +0000" → epoch ms. */
export function parseClfDate(s: string): number | null {
  const m = /^(\d{1,2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?:\s+([+-])(\d{2})(\d{2}))?/.exec(
    s,
  );
  if (!m) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const mon = MONTHS[m[2]];
  if (mon === undefined) return null;
  let t = Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], +m[6]);
  if (m[7]) {
    const off = (+m[8] * 60 + +m[9]) * 60_000;
    t += m[7] === '+' ? -off : off;
  }
  return t;
}

function toPath(target: string): string {
  let p = target;
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      p = u.pathname + u.search;
    } catch {
      /* keep */
    }
  }
  return p || '/';
}

function unescapeClf(s: string): string {
  return s.includes('\\')
    ? s
        .replace(/\\(["\\])/g, '$1')
        .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    : s;
}

function parseClf(line: string): ParsedLogLine | null {
  let m = CLF.exec(line);
  if (!m) {
    // vhost_combined: "%v:%p %h %l %u %t ..." — drop the first field and retry.
    const sp = line.indexOf(' ');
    if (sp > 0) m = CLF.exec(line.slice(sp + 1));
    if (!m) return null;
  }
  const req = unescapeClf(m[3]);
  const s1 = req.indexOf(' ');
  const method = s1 > 0 ? req.slice(0, s1) : '';
  const rest = s1 > 0 ? req.slice(s1 + 1) : req;
  const s2 = rest.lastIndexOf(' HTTP/');
  const target = s2 >= 0 ? rest.slice(0, s2) : rest;
  return {
    ip: m[1],
    ts: parseClfDate(m[2]),
    method,
    path: toPath(target),
    status: m[4] === '-' ? 0 : Number(m[4]),
    ua: m[7] !== undefined ? unescapeClf(m[7]) : '',
  };
}

/** Epoch seconds / ms / µs / ns, or an ISO-ish string → epoch ms. */
function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1e17) return Math.round(v / 1e6);
    if (v > 1e14) return Math.round(v / 1e3);
    if (v > 1e11) return Math.round(v);
    return Math.round(v * 1000);
  }
  if (typeof v === 'string' && v) {
    if (/^\d+(\.\d+)?$/.test(v)) return toMs(Number(v));
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
    return parseClfDate(v);
  }
  return null;
}

const str = (v: unknown): string =>
  Array.isArray(v) ? str(v[0]) : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function headerValue(h: unknown, name: string): string {
  if (!h || typeof h !== 'object') return '';
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (k.toLowerCase() === lower) return str(v);
  }
  return '';
}

function parseJsonRecord(o: Record<string, unknown>): ParsedLogLine | null {
  // Caddy: { ts, status, request: { remote_ip, client_ip, method, uri, headers: { "User-Agent": [...] } } }
  const req = o.request as Record<string, unknown> | undefined;
  if (req && typeof req === 'object' && ('uri' in req || 'headers' in req)) {
    return {
      ip: str(req.client_ip ?? req.remote_ip ?? req.remote_addr),
      ts: toMs(o.ts ?? o.timestamp),
      method: str(req.method),
      path: toPath(str(req.uri)),
      status: Number(o.status ?? 0),
      ua: headerValue(req.headers, 'user-agent'),
    };
  }
  // Vercel log drain: { timestamp, path, statusCode, proxy: { clientIp, path, userAgent: [...], statusCode, method } }
  const proxy = o.proxy as Record<string, unknown> | undefined;
  if (proxy && typeof proxy === 'object') {
    return {
      ip: str(proxy.clientIp),
      ts: toMs(proxy.timestamp ?? o.timestamp),
      method: str(proxy.method),
      path: toPath(str(proxy.path ?? o.path)),
      status: Number(proxy.statusCode ?? o.statusCode ?? 0),
      ua: str(proxy.userAgent),
    };
  }
  // Cloudflare Logpush (http_requests)
  if ('ClientRequestURI' in o || 'ClientRequestUserAgent' in o) {
    return {
      ip: str(o.ClientIP),
      ts: toMs(o.EdgeStartTimestamp ?? o.EdgeEndTimestamp ?? o.Datetime),
      method: str(o.ClientRequestMethod),
      path: toPath(str(o.ClientRequestURI ?? o.ClientRequestPath)),
      status: Number(o.EdgeResponseStatus ?? o.OriginResponseStatus ?? 0),
      ua: str(o.ClientRequestUserAgent),
    };
  }
  // Netlify traffic logs and generic JSON access logs (nginx json, ALB-ish exports…)
  const ua = str(
    pick(o, [
      'user_agent',
      'http_user_agent',
      'userAgent',
      'useragent',
      'ua',
      'UserAgent',
      'agent',
    ]) ?? headerValue(o.headers, 'user-agent'),
  );
  const target = str(
    pick(o, [
      'request_uri',
      'uri',
      'path',
      'url',
      'request_path',
      'requestPath',
      'requestUrl',
      'RequestURI',
    ]),
  );
  if (!ua && !target) return null;
  let method = str(pick(o, ['method', 'request_method', 'http_method', 'requestMethod']));
  let path = target;
  const reqLine = str(o.request);
  if (!path && reqLine) {
    const parts = reqLine.split(' ');
    method ||= parts[0];
    path = parts[1] ?? '';
  }
  return {
    ip: str(
      pick(o, [
        'client_ip',
        'remote_addr',
        'remote_ip',
        'clientIp',
        'ip',
        'client',
        'remoteAddr',
        'ClientIP',
        'x_forwarded_for',
      ]),
    )
      .split(',')[0]
      .trim(),
    ts: toMs(
      pick(o, [
        'timestamp',
        'time',
        '@timestamp',
        'ts',
        'time_local',
        'time_iso8601',
        'date',
        'datetime',
      ]),
    ),
    method,
    path: toPath(path),
    status: Number(
      pick(o, ['status', 'status_code', 'statusCode', 'response_status', 'http_status']) ?? 0,
    ),
    ua,
  };
}

/** Parse one access-log line in any supported format, or null. */
export function parseLogLine(raw: string): ParsedLogLine | null {
  let line = raw.trim();
  if (!line) return null;
  if (line[0] === '[' || line[0] === '{') {
    if (line[0] === '[') line = line.slice(1).trim();
    if (line.endsWith(',')) line = line.slice(0, -1);
    if (line.endsWith(']') && !line.endsWith('}]')) line = line.slice(0, -1);
    if (line.endsWith('}]')) line = line.slice(0, -1);
    if (line[0] !== '{') return null;
    try {
      const o = JSON.parse(line) as unknown;
      return o && typeof o === 'object' ? parseJsonRecord(o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return parseClf(line);
}

// ---------------------------------------------------------------------------
// Files and globs
// ---------------------------------------------------------------------------

const GLOB_CHARS = /[*?[{]/;

function globToRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/' || pattern[i + 1] === '\\') {
          i++;
          re += '(?:.*[\\\\/])?';
        } else re += '.*';
      } else re += '[^\\\\/]*';
    } else if (c === '?') re += '[^\\\\/]';
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) re += '\\{';
      else {
        re += `(?:${pattern
          .slice(i + 1, end)
          .split(',')
          .map((s) => s.replace(/[.+^$()|\\]/g, '\\$&'))
          .join('|')})`;
        i = end;
      }
    } else if (c === '[') {
      const end = pattern.indexOf(']', i);
      if (end < 0) re += '\\[';
      else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else if (c === '/' || c === '\\') re += '[\\\\/]';
    else re += c.replace(/[.+^$()|]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile()) out.push(p);
    else if (e.isDirectory() && depth > 0) await walk(p, depth - 1, out);
  }
}

/** Expand paths, directories (their files) and glob patterns (*, ?, **, {a,b}, [abc]). */
export async function expandLogPaths(patterns: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (let p of patterns) {
    if (p.startsWith('~/') || p === '~') p = join(homedir(), p.slice(1));
    p = resolve(p);
    if (!GLOB_CHARS.test(p)) {
      try {
        const s = await stat(p);
        if (s.isFile()) out.add(p);
        else if (s.isDirectory()) {
          const files: string[] = [];
          await walk(p, 0, files);
          files.sort().forEach((f) => out.add(f));
        }
      } catch {
        /* missing: reported by the caller */
      }
      continue;
    }
    const segs = p.split(sep);
    const firstGlob = segs.findIndex((s) => GLOB_CHARS.test(s));
    const baseDir = segs.slice(0, firstGlob).join(sep) || sep;
    const restSegs = segs.slice(firstGlob);
    const depth =
      restSegs.includes('**') || restSegs.some((s) => s.includes('**')) ? 32 : restSegs.length - 1;
    const files: string[] = [];
    await walk(baseDir, depth, files);
    const re = globToRegex(p);
    files
      .filter((f) => re.test(f))
      .sort()
      .forEach((f) => out.add(f));
  }
  return [...out];
}

async function isGzip(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(2);
    const { bytesRead } = await fh.read(buf, 0, 2, 0);
    return bytesRead === 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  } finally {
    await fh.close();
  }
}

async function* readLines(path: string): AsyncGenerator<string> {
  let stream: Readable = createReadStream(path, { highWaterMark: 1 << 20 });
  if (await isGzip(path)) stream = stream.pipe(createGunzip());
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    stream.destroy();
  }
}

// ---------------------------------------------------------------------------
// IP ranges and verification
// ---------------------------------------------------------------------------

type Range = { v6: false; base: number; mask: number } | { v6: true; base: bigint; mask: bigint };

function ipv4ToInt(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return null;
    const v = Number(x);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function ipv6ToBig(ip: string): bigint | null {
  let s = ip.split('%')[0];
  if (s.includes('.')) {
    const last = s.lastIndexOf(':');
    const v4 = ipv4ToInt(s.slice(last + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, last + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Normalise "::ffff:1.2.3.4" and "[::1]:443" forms; returns '' when not an IP. */
export function normaliseIp(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith('[')) ip = ip.slice(1, ip.indexOf(']'));
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  if (ipv4ToInt(ip) !== null) return ip;
  if (ip.includes(':') && ipv6ToBig(ip) !== null) return ip.toLowerCase();
  return '';
}

export function parseCidr(cidr: string): Range | null {
  const [addr, bitsRaw] = cidr.trim().split('/');
  if (addr.includes(':')) {
    const base = ipv6ToBig(addr);
    const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
    if (base === null || !(bits >= 0 && bits <= 128)) return null;
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
    return { v6: true, base: base & mask, mask };
  }
  const base = ipv4ToInt(addr);
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (base === null || !(bits >= 0 && bits <= 32)) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { v6: false, base: (base & mask) >>> 0, mask };
}

export function ipInRanges(ip: string, ranges: Range[]): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    for (const r of ranges) if (!r.v6 && (v4 & r.mask) >>> 0 === r.base) return true;
    return false;
  }
  const v6 = ipv6ToBig(ip);
  if (v6 === null) return false;
  for (const r of ranges) if (r.v6 && (v6 & r.mask) === r.base) return true;
  return false;
}

const CIDR_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:.]*)(?:\/\d{1,3})?$/i;

/** Pull every CIDR string out of a ranges file (Google/OpenAI/Bing "prefixes" JSON, or plain text). */
export function extractCidrs(body: string): string[] {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      if (CIDR_RE.test(v.trim()) && parseCidr(v)) out.add(v.trim());
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  try {
    visit(JSON.parse(body));
  } catch {
    for (const tok of body.split(/[\s,;]+/))
      if (tok && CIDR_RE.test(tok) && parseCidr(tok)) out.add(tok);
  }
  return [...out];
}

/** Load an IP-range file, from the 7-day cache when fresh; falls back to a stale cache on failure. */
export async function loadIpRanges(
  url: string,
  opts: { dataDir: string; fetch?: FetchFn; maxAgeMs?: number; now?: () => number },
): Promise<string[] | null> {
  const dir = join(opts.dataDir, 'cache', 'ip-ranges');
  const file = join(dir, `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.json`);
  const now = (opts.now ?? Date.now)();
  let cached: { url: string; fetchedAt: number; cidrs: string[] } | null = null;
  if (existsSync(file)) {
    try {
      cached = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      cached = null;
    }
  }
  if (cached && now - cached.fetchedAt < (opts.maxAgeMs ?? 7 * 86_400_000)) return cached.cidrs;
  try {
    const res = await (opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cidrs = extractCidrs(await res.text());
    if (!cidrs.length) throw new Error('no ranges in file');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ url, fetchedAt: now, cidrs }));
    return cidrs;
  } catch {
    return cached?.cidrs ?? null;
  }
}

const defaultResolver: LogResolver = {
  reverse: (ip) => dnsPromises.reverse(ip),
  lookup: async (host) => (await dnsPromises.lookup(host, { all: true })).map((a) => a.address),
};

/** Reverse DNS → suffix check → forward DNS must return the same IP. */
export async function verifyByRdns(
  ip: string,
  suffixes: string[],
  resolver: LogResolver = defaultResolver,
): Promise<boolean | null> {
  let names: string[];
  try {
    names = await resolver.reverse(ip);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOTFOUND' || code === 'ENODATA' ? false : null;
  }
  const host = names.find((n) =>
    suffixes.some((s) => n.toLowerCase().replace(/\.$/, '').endsWith(`.${s.toLowerCase()}`)),
  );
  if (!host) return false;
  try {
    const addrs = (await resolver.lookup(host)).map(normaliseIp);
    return addrs.includes(normaliseIp(ip));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface IpAgg {
  hits: number;
  statuses: Map<number, number>;
  paths: Map<string, number>;
  last: number | null;
}

/** Classic search crawlers that also feed AI answers; left out of `neverFetched` by default. */
const CLASSIC_SEARCH = new Set([
  'googlebot',
  'bingbot',
  'applebot',
  'petalbot',
  'yandexadditional',
]);

function makeMatcher(bots: AiBot[]): (ua: string) => AiBot | undefined {
  const needles = bots
    .flatMap((bot) =>
      [bot.token, ...(bot.uaMatch ?? [])].filter(Boolean).map((s) => ({ n: s.toLowerCase(), bot })),
    )
    .sort((a, b) => b.n.length - a.n.length);
  const cache = new Map<string, AiBot | null>();
  return (ua) => {
    if (!ua) return undefined;
    const hit = cache.get(ua);
    if (hit !== undefined) return hit ?? undefined;
    const s = ua.toLowerCase();
    let found: AiBot | null = null;
    for (const { n, bot } of needles) {
      let i = s.indexOf(n);
      while (i !== -1) {
        const before = i === 0 ? '' : s[i - 1];
        const after = s[i + n.length] ?? '';
        if (!(before && /[a-z0-9]/.test(before)) && !(after && /[a-z0-9]/.test(after))) {
          found = bot;
          break;
        }
        i = s.indexOf(n, i + 1);
      }
      if (found) break;
    }
    if (cache.size > 50_000) cache.clear();
    cache.set(ua, found);
    return found ?? undefined;
  };
}

function normPath(p: string): string {
  let path = p.split('#')[0].split('?')[0] || '/';
  try {
    path = decodeURI(path);
  } catch {
    /* keep encoded */
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/**
 * Analyse access logs for AI-bot activity. Never loads a whole file into memory.
 * Missing or unreadable files are skipped (listed in `files` only when read).
 */
export async function analyseLogs(
  paths: string[],
  opts: AnalyseLogsOptions = {},
): Promise<LogInsights> {
  const bots = opts.bots ?? AI_BOTS;
  const match = makeMatcher(bots);
  const since = opts.since?.getTime() ?? null;
  const files = await expandLogPaths(paths);
  const perBot = new Map<AiBot, Map<string, IpAgg>>();
  let lines = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  const readFiles: string[] = [];

  for (const file of files) {
    let n = 0;
    try {
      for await (const raw of readLines(file)) {
        lines++;
        n++;
        if (opts.onProgress && n % 100_000 === 0) opts.onProgress({ file, lines: n });
        const rec = parseLogLine(raw);
        if (!rec) continue;
        if (rec.ts !== null) {
          if (since !== null && rec.ts < since) continue;
          if (rec.ts < minTs) minTs = rec.ts;
          if (rec.ts > maxTs) maxTs = rec.ts;
        }
        const bot = match(rec.ua);
        if (!bot) continue;
        let ips = perBot.get(bot);
        if (!ips) perBot.set(bot, (ips = new Map()));
        const ip = normaliseIp(rec.ip) || rec.ip || '-';
        let a = ips.get(ip);
        if (!a) ips.set(ip, (a = { hits: 0, statuses: new Map(), paths: new Map(), last: null }));
        a.hits++;
        a.statuses.set(rec.status, (a.statuses.get(rec.status) ?? 0) + 1);
        const key = `${rec.status} ${normPath(rec.path)}`;
        a.paths.set(key, (a.paths.get(key) ?? 0) + 1);
        if (rec.ts !== null && (a.last === null || rec.ts > a.last)) a.last = rec.ts;
      }
      readFiles.push(file);
      opts.onProgress?.({ file, lines: n });
    } catch {
      /* unreadable file: skip */
    }
  }

  // ---- verification ----
  const verdicts = new Map<string, boolean | null>(); // `${token}|${ip}` → true verified, false spoofed, null unknown
  if (opts.verify !== false) {
    const dataDir = opts.dataDir ?? process.env.AVC_DATA_DIR ?? join(homedir(), '.avc');
    const rangeCache = new Map<string, Range[] | null>();
    const rdnsJobs: { key: string; ip: string; suffixes: string[]; hits: number }[] = [];
    for (const [bot, ips] of perBot) {
      let ranges: Range[] | null = null;
      if (bot.ipRangesUrl) {
        if (!rangeCache.has(bot.ipRangesUrl)) {
          const cidrs = await loadIpRanges(bot.ipRangesUrl, {
            dataDir,
            fetch: opts.fetch,
            maxAgeMs: opts.rangesMaxAgeMs,
            now: opts.now,
          });
          rangeCache.set(
            bot.ipRangesUrl,
            cidrs ? (cidrs.map(parseCidr).filter(Boolean) as Range[]) : null,
          );
        }
        ranges = rangeCache.get(bot.ipRangesUrl) ?? null;
      }
      const useRdns = opts.rdns !== false && !!bot.rdns?.length;
      for (const [ip, a] of ips) {
        const key = `${bot.token}|${ip}`;
        if (ranges?.length && ipInRanges(ip, ranges)) verdicts.set(key, true);
        else if (useRdns && normaliseIp(ip))
          rdnsJobs.push({ key, ip, suffixes: bot.rdns!, hits: a.hits });
        else if (ranges?.length) verdicts.set(key, normaliseIp(ip) ? false : null);
        else verdicts.set(key, null);
      }
    }
    // Most hits first, so the DNS budget goes to the IPs that matter.
    rdnsJobs.sort((a, b) => b.hits - a.hits);
    const budget = rdnsJobs.slice(0, opts.maxRdnsLookups ?? 300);
    const resolver = opts.resolver ?? defaultResolver;
    const ipVerdict = new Map<string, Promise<boolean | null>>();
    await mapLimit(budget, 16, async (j) => {
      const k = `${j.suffixes.join(',')}|${j.ip}`;
      if (!ipVerdict.has(k)) ipVerdict.set(k, verifyByRdns(j.ip, j.suffixes, resolver));
      verdicts.set(j.key, await ipVerdict.get(k)!);
    });
    for (const j of rdnsJobs.slice(budget.length)) verdicts.set(j.key, null);
  }

  // ---- roll up ----
  const countsFor =
    opts.neverFetchedBots ?? ((b: AiBot) => !CLASSIC_SEARCH.has(b.token.toLowerCase()));
  const fetchedByAi = new Set<string>();
  const errors = new Map<string, { path: string; status: number; bot: string; hits: number }>();
  const outBots: LogInsights['bots'] = [];

  for (const [bot, ips] of perBot) {
    let hits = 0;
    let verified = 0;
    let spoofed = 0;
    let last: number | null = null;
    const statuses: Record<string, number> = {};
    const paths = new Map<string, number>();
    for (const [ip, a] of ips) {
      hits += a.hits;
      const v = verdicts.get(`${bot.token}|${ip}`) ?? null;
      if (v === false) {
        spoofed += a.hits;
        continue;
      }
      if (v === true) verified += a.hits;
      if (a.last !== null && (last === null || a.last > last)) last = a.last;
      for (const [s, c] of a.statuses) statuses[String(s)] = (statuses[String(s)] ?? 0) + c;
      for (const [key, c] of a.paths) {
        const sp = key.indexOf(' ');
        const status = Number(key.slice(0, sp));
        const path = key.slice(sp + 1);
        paths.set(path, (paths.get(path) ?? 0) + c);
        if (countsFor(bot) && status >= 200 && status < 400) fetchedByAi.add(path);
        if (status >= 400) {
          const ek = `${bot.token}|${status}|${path}`;
          const e = errors.get(ek) ?? { path, status, bot: bot.token, hits: 0 };
          e.hits += c;
          errors.set(ek, e);
        }
      }
    }
    outBots.push({
      token: bot.token,
      operator: bot.operator,
      purpose: bot.purpose,
      hits,
      verified,
      spoofed,
      statuses,
      topPaths: [...paths.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([path, h]) => ({ path, hits: h })),
      lastSeen: last !== null ? new Date(last).toISOString() : undefined,
    });
  }
  outBots.sort((a, b) => b.hits - a.hits);

  const neverFetched: string[] = [];
  const seen = new Set<string>();
  for (const u of opts.siteUrls ?? []) {
    let p: string;
    try {
      p = normPath(new URL(u).pathname);
    } catch {
      p = normPath(u);
    }
    if (seen.has(u)) continue;
    seen.add(u);
    if (!fetchedByAi.has(p)) neverFetched.push(u);
  }

  return {
    files: readFiles,
    lines,
    range:
      minTs <= maxTs
        ? { start: new Date(minTs).toISOString(), end: new Date(maxTs).toISOString() }
        : null,
    bots: outBots,
    neverFetched,
    errorsServedToBots: [...errors.values()].sort((a, b) => b.hits - a.hits).slice(0, 200),
  };
}
