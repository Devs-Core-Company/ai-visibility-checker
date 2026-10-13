// Google Lighthouse 13 (npm `lighthouse`), run once per page with the default
// config: every category, including Agentic Browsing, mobile form factor,
// simulated throttling. Lighthouse has no crawler, so the page list is the
// start URL plus the URLs in the site's sitemap(s) (from robots.txt, else
// /sitemap.xml), capped at 60 pages (50 in the performance suite).
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS_DIR, CHROME_PATH, runMeasured, discoverUrls, keepSmall, tail } from './_lib.mjs';

export const tool = 'lighthouse';
export const PAGE_CAP = 60;

const LH = join(TOOLS_DIR, 'npm', 'node_modules', '.bin', 'lighthouse');
const CHROME_FLAGS = '--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage';

/** Lighthouse's own pass threshold for scored audits is 0.9. */
export function failingAudits(lhr) {
  const out = [];
  for (const [id, a] of Object.entries(lhr.audits ?? {})) {
    if (a.score === null || a.score === undefined) continue;
    if (['informative', 'manual', 'notApplicable', 'error'].includes(a.scoreDisplayMode)) continue;
    if (a.score >= 0.9) continue;
    out.push(a);
  }
  return out;
}

/** Short text naming the failing items (selectors, URLs) so a reader can see what was flagged. */
export function auditItems(a, max = 5) {
  const items = Array.isArray(a.details?.items) ? a.details.items : [];
  const parts = [];
  for (const it of items.slice(0, max)) {
    const s = it.node?.selector || it.url || it.source?.url || it.href || it.text || '';
    if (s) parts.push(String(s).slice(0, 120));
  }
  return parts.join(', ');
}

export function lhrFindings(lhr, pageUrl, toolName) {
  return failingAudits(lhr).map((a) => {
    const items = auditItems(a);
    return {
      tool: toolName,
      type: a.id,
      url: pageUrl,
      message: `${a.title}${a.displayValue ? ' (' + a.displayValue + ')' : ''}${items ? ' | ' + items : ''}`,
      severity: a.score === 0 ? 'fail' : 'warn',
    };
  });
}

export function compactLhr(lhr) {
  return {
    requestedUrl: lhr.requestedUrl,
    finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl,
    runtimeError: lhr.runtimeError ?? null,
    categories: Object.fromEntries(Object.entries(lhr.categories ?? {}).map(([k, v]) => [k, v.score])),
    failing: failingAudits(lhr).map((a) => ({ id: a.id, score: a.score, displayValue: a.displayValue ?? null, items: auditItems(a) })),
  };
}

export async function run({ url, outDir, maxPages }) {
  mkdirSync(outDir, { recursive: true });
  const cap = maxPages ?? PAGE_CAP;
  const urls = await discoverUrls(url, cap);
  const errors = [];
  const findings = [];
  const pages = [];
  let durationMs = 0;
  let peakRssMb = 0;
  const tmp = join(outDir, '.lhr.json');
  const ver = (await runMeasured(LH, ['--version'])).stdout.trim();
  for (const pageUrl of urls) {
    rmSync(tmp, { force: true });
    const res = await runMeasured(
      LH,
      [pageUrl, '--output', 'json', '--output-path', tmp, `--chrome-flags=${CHROME_FLAGS}`, '--quiet'],
      { env: { CHROME_PATH }, timeoutMs: 300_000 },
    );
    durationMs += res.durationMs;
    peakRssMb = Math.max(peakRssMb, res.peakRssMb);
    if (!existsSync(tmp)) {
      errors.push(`${pageUrl}: no report (exit ${res.code}) ${tail(res.stderr, 300)}`);
      continue;
    }
    const lhr = JSON.parse(readFileSync(tmp, 'utf8'));
    if (lhr.runtimeError) errors.push(`${pageUrl}: ${lhr.runtimeError.code} ${lhr.runtimeError.message ?? ''}`);
    pages.push(compactLhr(lhr));
    findings.push(...lhrFindings(lhr, pageUrl, tool));
  }
  rmSync(tmp, { force: true });
  const native = join(outDir, 'lighthouse-pages.json');
  writeFileSync(native, JSON.stringify({ lighthouseVersion: ver, cap, urls, pages }, null, 1));
  keepSmall(native);

  return {
    findings,
    meta: {
      version: `lighthouse ${ver}`,
      settings: {
        config: 'default (all categories incl. agentic-browsing; mobile; simulated throttling)',
        chromeFlags: CHROME_FLAGS,
        pageList: `start URL + sitemap URLs (robots.txt Sitemap lines, else /sitemap.xml), first ${cap}`,
        pageCap: cap,
        failure: 'an audit is a finding when its score is below 0.9 (Lighthouse pass threshold); informative/manual/n.a. audits ignored',
        runs: 'one page at a time, sequentially; durationMs and peakRssMb are the sum and the max over pages',
      },
      durationMs,
      peakRssMb,
      pagesAudited: pages.length,
      errors,
    },
  };
}
