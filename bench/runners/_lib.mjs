// Shared helpers for the benchmark runners: process measurement (wall time and
// peak RSS of the whole process tree, polled from /proc), output size control,
// and sitemap discovery for the tools that need a URL list.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = resolve(BENCH_DIR, '..');
export const TOOLS_DIR = join(BENCH_DIR, '.tools');
export const CHROME_PATH =
  process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
/** Raw files above this size are gzipped; above it again after gzip, dropped. */
export const MAX_RAW_BYTES = 1_500_000;

// ---------------------------------------------------------------------------
// Process tree memory

function childrenOf() {
  /** @type {Map<number, number[]>} */
  const kids = new Map();
  let entries = [];
  try {
    entries = readdirSync('/proc');
  } catch {
    return kids;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = readFileSync(`/proc/${e}/stat`, 'utf8');
      // ppid is the 2nd field after the ")" that closes the command name.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(rest[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(e));
    } catch {
      /* process went away */
    }
  }
  return kids;
}

function rssKb(pid) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** Sum of RSS (MB) of `pid` and all its descendants. */
export function treeRssMb(pid) {
  const kids = childrenOf();
  let total = 0;
  const stack = [pid];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    total += rssKb(p);
    for (const c of kids.get(p) ?? []) stack.push(c);
  }
  return total / 1024;
}

/** Poll a process tree's RSS until stopped. */
export function rssSampler(pid, everyMs = 250) {
  let peak = 0;
  const tick = () => {
    const v = treeRssMb(pid);
    if (v > peak) peak = v;
  };
  tick();
  const t = setInterval(tick, everyMs);
  return {
    stop() {
      clearInterval(t);
      return Math.round(peak);
    },
    get peak() {
      return Math.round(peak);
    },
  };
}

/** Kill a process and every descendant. */
export function killTree(pid, signal = 'SIGTERM') {
  const kids = childrenOf();
  const all = [];
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    all.push(p);
    for (const c of kids.get(p) ?? []) stack.push(c);
  }
  for (const p of all.reverse()) {
    try {
      process.kill(p, signal);
    } catch {
      /* gone */
    }
  }
}

/**
 * Run a command to completion, measuring wall time and peak RSS of its
 * process tree. Never throws on a non-zero exit; the caller decides.
 */
export function runMeasured(cmd, args, { env = {}, cwd, timeoutMs = 3_600_000, stdoutFile } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const sampler = rssSampler(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, 'SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      stderr += String(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const peakRssMb = sampler.stop();
      if (stdoutFile) writeFileSync(stdoutFile, stdout);
      resolvePromise({
        code,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        peakRssMb,
      });
    });
  });
}

/** Last `n` characters of a log, for error messages. */
export const tail = (s, n = 600) => (s.length > n ? '…' + s.slice(-n) : s);

// ---------------------------------------------------------------------------
// Output size

/**
 * Keep a raw output file small enough to commit: files over MAX_RAW_BYTES are
 * replaced by a .gz; if that is still too large the file is removed and a
 * note is left beside it. Returns the path that remains (or the note).
 */
export function keepSmall(file, max = MAX_RAW_BYTES) {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  if (size <= max) return file;
  const gz = gzipSync(readFileSync(file));
  unlinkSync(file);
  if (gz.length <= max) {
    writeFileSync(file + '.gz', gz);
    return file + '.gz';
  }
  const note = file + '.omitted.txt';
  writeFileSync(
    note,
    `Raw output ${file.split('/').pop()} was ${size} bytes (${gz.length} gzipped), over the ` +
      `${max}-byte commit limit, so it was not kept. Re-run the benchmark to regenerate it.\n`,
  );
  return note;
}

// ---------------------------------------------------------------------------
// URL discovery for per-page tools (Lighthouse): robots.txt Sitemap lines,
// falling back to /sitemap.xml; sitemap indexes are followed. The start URL
// is always first.

async function fetchText(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function discoverUrls(startUrl, cap = Infinity) {
  const origin = new URL(startUrl).origin;
  const robots = (await fetchText(origin + '/robots.txt')) ?? '';
  let maps = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (!maps.length) maps = [origin + '/sitemap.xml'];
  const seenMaps = new Set();
  const urls = [startUrl];
  const queue = [...maps];
  while (queue.length && seenMaps.size < 50) {
    const sm = queue.shift();
    if (seenMaps.has(sm)) continue;
    seenMaps.add(sm);
    const xml = await fetchText(sm);
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
      m[1].replace(/&amp;/g, '&'),
    );
    if (/<sitemapindex/i.test(xml)) queue.push(...locs);
    else urls.push(...locs);
  }
  const out = [];
  const seen = new Set();
  for (const u of urls) {
    let norm;
    try {
      norm = new URL(u);
    } catch {
      continue;
    }
    if (norm.origin !== origin) continue;
    norm.hash = '';
    const key = norm.href;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.slice(0, cap);
}

/** Absolute URL or null. */
export function absUrl(u, base) {
  if (!u) return null;
  try {
    return new URL(u, base).href;
  } catch {
    return null;
  }
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
