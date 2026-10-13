// Unlighthouse (@unlighthouse/cli), site-wide, CI mode: `unlighthouse-ci --site
// <url> --reporter jsonExpanded`. Default scanner settings (crawler on, robots.txt
// and sitemap on, dynamic sampling of 8 per route group, max 200 routes, mobile,
// categories performance/accessibility/best-practices/seo). The jsonExpanded
// reporter only carries scores, so findings come from the per-route Lighthouse
// reports Unlighthouse writes (the same data its UI shows), using Lighthouse's
// pass threshold (score < 0.9).
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS_DIR, CHROME_PATH, runMeasured, keepSmall, tail } from './_lib.mjs';
import { lhrFindings, compactLhr } from './lighthouse.mjs';

export const tool = 'unlighthouse';

const BIN = join(TOOLS_DIR, 'npm', 'node_modules', '.bin', 'unlighthouse-ci');

function findReports(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findReports(p, out);
    else if (e.name === 'lighthouse.json') out.push(p);
  }
  return out;
}

export async function run({ url, outDir, maxPages }) {
  mkdirSync(outDir, { recursive: true });
  const work = join(outDir, '.unlighthouse');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const outPath = join(work, 'out');
  const args = ['--site', url, '--reporter', 'jsonExpanded', '--output-path', outPath, '--root', work, '--no-cache'];
  if (maxPages) {
    // Performance suite only: the 50-page sample for Lighthouse-based tools.
    const cfg = join(work, 'unlighthouse.config.mjs');
    writeFileSync(cfg, `export default { scanner: { maxRoutes: ${maxPages} } }\n`);
    args.push('--config-file', cfg);
  }
  const ver = JSON.parse(
    readFileSync(join(TOOLS_DIR, 'npm', 'node_modules', '@unlighthouse', 'cli', 'package.json'), 'utf8'),
  ).version;
  const lhVer = JSON.parse(
    readFileSync(join(TOOLS_DIR, 'npm', 'node_modules', 'lighthouse', 'package.json'), 'utf8'),
  ).version;
  const res = await runMeasured(BIN, args, { env: { CHROME_PATH }, cwd: work, timeoutMs: 3_600_000 });
  writeFileSync(join(outDir, 'unlighthouse.log'), tail(res.stdout + res.stderr, 20_000));

  const errors = [];
  if (res.code !== 0) errors.push(`unlighthouse-ci exited ${res.code}${res.timedOut ? ' (timeout)' : ''}: ${tail(res.stderr || res.stdout)}`);
  const ci = join(outPath, 'ci-result.json');
  if (existsSync(ci)) {
    copyFileSync(ci, join(outDir, 'ci-result.json'));
    keepSmall(join(outDir, 'ci-result.json'));
  } else errors.push('no ci-result.json');

  const findings = [];
  const pages = [];
  for (const file of findReports(join(outPath, 'reports'))) {
    try {
      const lhr = JSON.parse(readFileSync(file, 'utf8'));
      const pageUrl = lhr.requestedUrl ?? lhr.finalDisplayedUrl;
      pages.push(compactLhr(lhr));
      findings.push(...lhrFindings(lhr, pageUrl, tool));
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
    }
  }
  const native = join(outDir, 'unlighthouse-pages.json');
  writeFileSync(native, JSON.stringify({ version: ver, pages }, null, 1));
  keepSmall(native);
  // Screenshots and full HTML reports are large; they are not kept.
  rmSync(work, { recursive: true, force: true });

  return {
    findings,
    meta: {
      version: `@unlighthouse/cli ${ver} (lighthouse ${lhVer})`,
      settings: {
        command: `unlighthouse-ci --site <url> --reporter jsonExpanded --no-cache${maxPages ? ` (config scanner.maxRoutes=${maxPages})` : ''}`,
        defaults: 'crawler + robots.txt + sitemap, dynamicSampling 8, maxRoutes 200, mobile, 4 categories (no agentic-browsing by default)',
        failure: 'audit score < 0.9 in the per-route Lighthouse report',
      },
      durationMs: res.durationMs,
      peakRssMb: res.peakRssMb,
      pagesAudited: pages.length,
      errors,
    },
  };
}
