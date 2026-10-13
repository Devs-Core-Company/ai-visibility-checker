// python-seo-analyzer (PyPI `pyseoanalyzer`): `python-seo-analyzer <url>
// --sitemap <sitemap> --output-format json`. Following internal links is its
// default. The sitemap passed is the one robots.txt names (else /sitemap.xml),
// which is what a user would type. Its warnings are free text; they are
// normalised to stable ids by the patterns below (one per warning the tool can
// emit — see pyseoanalyzer/page.py), plus its site-level `duplicate_pages`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS_DIR, runMeasured, keepSmall, tail } from './_lib.mjs';

export const tool = 'pyseoanalyzer';

const VENV = join(TOOLS_DIR, 'venv-pysa');
const BIN = join(VENV, 'bin', 'python-seo-analyzer');

/** [native id, pattern] — every warning string in pyseoanalyzer 2025.4.3. */
export const WARNING_TYPES = [
  ['missing-title', /^Missing title tag/],
  ['title-too-short', /^Title tag is too short/],
  ['title-too-long', /^Title tag is too long/],
  ['missing-description', /^Missing description/],
  ['description-too-short', /^Description is too short/],
  ['description-too-long', /^Description is too long/],
  ['missing-og-title', /^Missing og:title/],
  ['missing-og-description', /^Missing og:description/],
  ['missing-og-image', /^Missing og:image/],
  ['image-missing-alt', /^Image missing alt tag/],
  ['missing-h1', /^Each page should have at least one h1 tag/],
  ['anchor-missing-title', /^Anchor missing title tag/],
  ['anchor-generic-text', /^Anchor text contains generic text/],
  ['meta-keywords', /^Keywords should be avoided/],
  ['http-error', /^Returned /],
  ['unreadable-encoding', /^Can not read /],
  ['invalid-protocol', /does not appear to have a valid protocol/],
  ['off-domain', /is not part of /],
];

export function warningType(w) {
  for (const [id, re] of WARNING_TYPES) if (re.test(w)) return id;
  return 'other';
}

async function sitemapFor(url) {
  const origin = new URL(url).origin;
  try {
    const robots = await (await fetch(origin + '/robots.txt')).text();
    const m = robots.match(/^\s*sitemap:\s*(\S+)/im);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  try {
    const r = await fetch(origin + '/sitemap.xml', { method: 'HEAD' });
    if (r.ok) return origin + '/sitemap.xml';
  } catch {
    /* none */
  }
  return null;
}

export async function run({ url, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const sitemap = await sitemapFor(url);
  const args = [url, '--output-format', 'json'];
  if (sitemap) args.push('--sitemap', sitemap);
  const ver = (await runMeasured(join(VENV, 'bin', 'python'), ['-c', 'import importlib.metadata as m; print(m.version("pyseoanalyzer"))'])).stdout.trim();
  const res = await runMeasured(BIN, args, { timeoutMs: 3_600_000 });
  writeFileSync(join(outDir, 'pyseoanalyzer.stderr.log'), tail(res.stderr, 20_000));

  const errors = [];
  if (res.code !== 0) errors.push(`exited ${res.code}${res.timedOut ? ' (timeout)' : ''}: ${tail(res.stderr)}`);
  // The tool prints crawl errors to stdout before the JSON document.
  const m = /^\{/m.exec(res.stdout);
  const start = m ? m.index : -1;
  const preamble = start > 0 ? res.stdout.slice(0, start).trim() : '';
  if (preamble) errors.push(`tool output: ${tail(preamble, 400)}`);
  let report = null;
  try {
    if (start < 0) throw new Error('no JSON document in stdout');
    report = JSON.parse(res.stdout.slice(start));
  } catch (e) {
    errors.push(`could not parse JSON output: ${e.message}`);
  }
  const native = join(outDir, 'pyseoanalyzer.json');
  if (report) {
    // keywords/bigrams/trigrams are word counts, not findings; they are trimmed to keep the file small.
    const slim = {
      ...report,
      keywords: (report.keywords ?? []).slice(0, 50),
      pages: (report.pages ?? []).map(({ bigrams, trigrams, keywords, content, ...p }) => p),
    };
    writeFileSync(native, JSON.stringify(slim, null, 1));
    keepSmall(native);
  } else writeFileSync(native + '.stdout.txt', tail(res.stdout, 200_000));

  const findings = [];
  for (const p of report?.pages ?? []) {
    for (const w of p.warnings ?? []) {
      findings.push({ tool, type: warningType(w), url: p.url, message: w.slice(0, 300) });
    }
  }
  for (const group of report?.duplicate_pages ?? []) {
    for (const u of group) {
      findings.push({ tool, type: 'duplicate-pages', url: u, message: `Duplicate content: ${group.join(', ')}` });
    }
  }

  return {
    findings,
    meta: {
      version: `pyseoanalyzer ${ver}`,
      settings: {
        command: `python-seo-analyzer <url> --output-format json${sitemap ? ' --sitemap <robots.txt sitemap>' : ''}`,
        sitemap,
        note: 'follow links is the default; --analyze-headings/--analyze-extra-tags only add data, not warnings, so they were left off',
      },
      durationMs: res.durationMs,
      peakRssMb: res.peakRssMb,
      pagesAudited: report?.pages?.length ?? 0,
      errors,
    },
  };
}
