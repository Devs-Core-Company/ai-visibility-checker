#!/usr/bin/env node
// Benchmark driver.
//
//   node bench/run.mjs [--tools avc,scrawly,lighthouse,unlighthouse,pyseoanalyzer]
//                      [--url http://127.0.0.1:PORT/]   audit an already-running site instead
//                      [--no-score]
//   node bench/run.mjs --perf [--tools ...] [--pages 1000] [--sample 50]
//
// Detection suite: starts the ground-truth server (bench/serve.mjs), runs each
// tool one after another (never in parallel, so timings and memory are not
// disturbed), writes normalised findings to bench/results/findings/<tool>.json,
// raw outputs to bench/results/raw/<tool>/, then scores (bench/score.mjs).
//
// Performance suite: generates a 1,000-page site with bench/gen-large-site.mjs,
// serves it locally, and records wall time and peak RSS per tool. Lighthouse
// and Unlighthouse audit a 50-page sample (stated in the results).
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const BENCH = dirname(fileURLToPath(import.meta.url));
const ALL_TOOLS = ['avc', 'scrawly', 'lighthouse', 'unlighthouse', 'pyseoanalyzer'];
const LIGHTHOUSE_BASED = new Set(['lighthouse', 'unlighthouse']);

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const tools = (opt('--tools') ?? ALL_TOOLS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
for (const t of tools) if (!ALL_TOOLS.includes(t)) throw new Error(`unknown tool "${t}" (known: ${ALL_TOOLS.join(', ')})`);

async function runTool(tool, url, outDir, extra = {}) {
  const mod = await import(pathToFileURL(join(BENCH, 'runners', `${tool}.mjs`)).href);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  console.log(`[bench] ${tool}: auditing ${url} …`);
  let result;
  try {
    result = await mod.run({ url, outDir, ...extra });
  } catch (e) {
    result = { findings: [], meta: { version: '?', settings: {}, durationMs: 0, peakRssMb: 0, pagesAudited: 0, errors: [`runner crashed: ${e.stack ?? e}`] } };
  }
  const m = result.meta;
  console.log(
    `[bench] ${tool}: ${result.findings.length} findings, ${m.pagesAudited} pages, ${(m.durationMs / 1000).toFixed(1)} s, ${m.peakRssMb} MB peak` +
      (m.errors.length ? `, ${m.errors.length} error(s): ${String(m.errors[0]).slice(0, 200)}` : ''),
  );
  return result;
}

// ---------------------------------------------------------------------------
// Servers

async function startGroundTruthServer() {
  const file = join(BENCH, 'serve.mjs');
  if (!existsSync(file)) throw new Error('bench/serve.mjs not found (the ground-truth site server)');
  const { startBenchServer } = await import(pathToFileURL(file).href);
  return startBenchServer({ port: Number(opt('--port', 0)) });
}

/**
 * Generate the large site with the CLI `node bench/gen-large-site.mjs <dir> --pages N`
 * into a temp folder and serve it with bench/serve.mjs (which fills in {{ORIGIN}}).
 */
async function startLargeSite(pages) {
  const gen = join(BENCH, 'gen-large-site.mjs');
  if (!existsSync(gen)) throw new Error('bench/gen-large-site.mjs not found');
  const dir = join(tmpdir(), `bench-large-site-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  execFileSync(process.execPath, [gen, dir, '--pages', String(pages)], { stdio: 'inherit' });
  const { startBenchServer } = await import(pathToFileURL(join(BENCH, 'serve.mjs')).href);
  const srv = await startBenchServer({ port: 0, site: dir });
  return {
    url: srv.url,
    close: async () => {
      await srv.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------

async function detection() {
  let srv = null;
  let url = opt('--url');
  if (!url) {
    srv = await startGroundTruthServer();
    url = srv.url;
  }
  if (!url.endsWith('/')) url += '/';
  const findingsDir = join(BENCH, 'results', 'findings');
  mkdirSync(findingsDir, { recursive: true });
  try {
    for (const tool of tools) {
      const result = await runTool(tool, url, join(BENCH, 'results', 'raw', tool));
      // Store URLs relative to the origin: the server port changes every run.
      const origin = new URL(url).origin;
      const rel = (u) => (u && u.startsWith(origin) ? u.slice(origin.length) || '/' : u);
      result.findings = result.findings.map((f) => ({ ...f, url: rel(f.url) ?? null, message: String(f.message ?? '').split(origin).join('') }));
      writeFileSync(join(findingsDir, `${tool}.json`), JSON.stringify({ tool, site: 'bench/site', ...result }, null, 1));
    }
  } finally {
    await srv?.close?.();
  }
  if (!has('--no-score')) {
    if (!existsSync(join(BENCH, 'ground-truth.json'))) {
      console.log('[bench] bench/ground-truth.json not found; skipping scoring');
      return;
    }
    const { scoreAll } = await import(pathToFileURL(join(BENCH, 'score.mjs')).href);
    const r = await scoreAll({});
    for (const t of r.tools) {
      const o = t.score.areas.overall;
      console.log(`[bench] ${t.tool}: recall ${(o.recall * 100).toFixed(0)}%, precision ${o.precision === null ? '–' : (o.precision * 100).toFixed(0) + '%'}`);
    }
  }
}

async function perf() {
  const pages = Number(opt('--pages', 1000));
  const sample = Number(opt('--sample', 50));
  const srv = await startLargeSite(pages);
  const runs = [];
  try {
    for (const tool of tools) {
      const lhBased = LIGHTHOUSE_BASED.has(tool);
      const result = await runTool(tool, srv.url, join(BENCH, 'results', 'raw', 'perf', tool), lhBased ? { maxPages: sample } : {});
      runs.push({
        tool,
        note: lhBased ? `sample capped at ${sample} pages (Lighthouse-based)` : `full site (${pages} pages generated)`,
        meta: result.meta,
        findings: result.findings.length,
      });
    }
  } finally {
    await srv.close?.();
  }
  const outDir = join(BENCH, 'results');
  mkdirSync(outDir, { recursive: true });
  const perfFile = join(outDir, 'perf.json');
  // Merge with earlier perf runs of other tools.
  let prior = [];
  if (existsSync(perfFile)) prior = JSON.parse(readFileSync(perfFile, 'utf8')).runs.filter((r) => !tools.includes(r.tool));
  writeFileSync(perfFile, JSON.stringify({ generatedAt: new Date().toISOString(), pages, sample, runs: [...prior, ...runs] }, null, 1));
  const { scoreAll, renderMarkdown } = await import(pathToFileURL(join(BENCH, 'score.mjs')).href);
  if (existsSync(join(BENCH, 'ground-truth.json')) && existsSync(join(outDir, 'findings'))) await scoreAll({});
  else writeFileSync(join(outDir, 'RESULTS.md'), renderMarkdown({ generatedAt: new Date().toISOString(), tools: [], areas: [], perf: [...prior, ...runs] }));
  console.log('[bench] wrote bench/results/perf.json');
}

if (has('--perf')) await perf();
else await detection();
