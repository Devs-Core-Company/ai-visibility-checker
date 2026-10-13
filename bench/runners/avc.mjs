// AI Visibility Checker (this repo): `avc audit <url> --format json --render`,
// with PageSpeed Insights off and AI calls mocked (no network beyond localhost).
import { mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_DIR, CHROME_PATH, runMeasured, keepSmall, readJson, tail } from './_lib.mjs';

export const tool = 'avc';

export async function run({ url, outDir, maxPages }) {
  mkdirSync(outDir, { recursive: true });
  const dataDir = join(outDir, '.avc-data');
  const reportDir = join(outDir, 'native');
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(reportDir, { recursive: true, force: true });
  const bin = join(REPO_DIR, 'bin', 'avc.mjs');
  const args = [bin, 'audit', url, '--format', 'json', '--out', reportDir, '--render'];
  // Whole site: AVC stops at 500 pages by default; 0 = no limit (documented option).
  args.push('--max-pages', String(maxPages ?? 0));
  const env = {
    AVC_PSI: 'off',
    AVC_LLM_MOCK: '1',
    AVC_DATA_DIR: dataDir,
    AVC_CHROME_PATH: CHROME_PATH,
  };
  const version = (await runMeasured('node', [bin, '--version'])).stdout.trim();
  const res = await runMeasured('node', args, { env, timeoutMs: 3_600_000 });
  writeFileSync(join(outDir, 'avc.log'), tail(res.stdout + res.stderr, 20_000));
  rmSync(dataDir, { recursive: true, force: true });

  const errors = [];
  if (res.code !== 0) errors.push(`avc exited ${res.code}${res.timedOut ? ' (timeout)' : ''}: ${tail(res.stderr || res.stdout)}`);

  let report = null;
  try {
    const file = readdirSync(reportDir).find((f) => f.endsWith('.json'));
    if (file) {
      report = readJson(join(reportDir, file));
      // The full report is kept (gzipped when large). Only if even that is too big
      // to commit is a compact copy (issues, stats, page list) kept instead.
      const kept = keepSmall(join(reportDir, file));
      if (kept?.endsWith('.omitted.txt')) {
        const compact = { ...report, pages: (report.pages ?? []).map((p) => ({ url: p.url, status: p.status })) };
        writeFileSync(join(outDir, 'avc-report.compact.json'), JSON.stringify(compact));
        keepSmall(join(outDir, 'avc-report.compact.json'));
      }
    }
  } catch (e) {
    errors.push(`could not read report: ${e.message}`);
  }
  if (!report) errors.push('no JSON report produced');

  const findings = (report?.issues ?? []).map((i) => ({
    tool,
    type: i.checkId,
    url: i.url ?? null,
    message: [i.message, i.evidence].filter(Boolean).join(' | '),
    severity: i.severity,
  }));

  return {
    findings,
    meta: {
      version: `avc ${version || report?.version || '?'}`,
      settings: {
        command: `avc audit <url> --format json --out <dir> --render --max-pages ${maxPages ?? 0}`,
        env: { AVC_PSI: 'off', AVC_LLM_MOCK: '1', AVC_DATA_DIR: '<tmp>', AVC_CHROME_PATH: CHROME_PATH },
        note: 'Defaults otherwise (depth 10). --max-pages 0 lifts the default 500-page cap so the whole site is audited. AVC_DATA_DIR is a throwaway folder deleted after the run.',
      },
      durationMs: res.durationMs,
      peakRssMb: res.peakRssMb,
      pagesAudited: report?.stats?.pagesCrawled ?? report?.pages?.length ?? 0,
      errors,
    },
  };
}
