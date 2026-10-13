#!/usr/bin/env node
// Scores normalised tool findings against bench/ground-truth.json using the
// published mapping tables in bench/mappings/<tool>.json (rules: bench/SPEC.md).
//
//   node bench/score.mjs [--tools avc,scrawly,...] [--findings bench/results/findings]
//
// Writes bench/results/results.json and bench/results/RESULTS.md.
//
// Definitions (SPEC "Suites" 1):
// - A finding MATCHES a defect when mappings[tool][finding.type] contains the
//   defect's type AND the finding names the defect's URL, or the defect is
//   site-wide (scope: site). The defect's types are its `type` plus `alt_types`.
//   "Names the URL": the finding's url is the defect's `url` or `found_on`, or
//   the finding has no url and its message contains one of those paths.
// - Recall (area)    = defects matched by >=1 finding / defects in the area.
// - Precision (area) = mapped findings that match a defect / all mapped findings,
//   where a mapped finding is one whose type maps to >=1 ground-truth type of the
//   area. Findings are de-duplicated on (type, url) first so tools that repeat a
//   finding once per element are not inflated or penalised; a finding type that
//   only matches site-wide defects counts once, however many pages repeat it.
// - FP on controls   = mapped findings on clean control pages (always wrong).
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Ground truth (tolerant of a few shapes)

export function normPath(u) {
  if (u === null || u === undefined || u === '') return null;
  let p;
  try {
    const x = new URL(u, 'http://bench.invalid');
    p = decodeURI(x.pathname) + x.search;
  } catch {
    p = String(u);
  }
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

export function loadGroundTruth(file = join(BENCH, 'ground-truth.json')) {
  const gt = JSON.parse(readFileSync(file, 'utf8'));
  const rawDefects = Array.isArray(gt) ? gt : (gt.defects ?? []);
  const defects = rawDefects.map((d, i) => {
    const urls = [d.url, d.page, d.path, d.found_on, ...(d.urls ?? [])].filter((x) => x !== undefined && x !== null && x !== '');
    const siteWide = Boolean(d.siteWide ?? d.site_wide ?? d.scope === 'site') || urls.length === 0;
    return {
      id: d.id ?? `d${i + 1}`,
      type: d.type,
      // The defect's own type plus its alt_types (other reasonable names for the same problem).
      types: [d.type, ...(d.alt_types ?? [])],
      area: d.area ?? 'other',
      siteWide,
      paths: siteWide ? [] : urls.map(normPath),
      raw: d,
    };
  });
  let controls = gt.controls ?? gt.controlPages ?? gt.control_pages ?? [];
  if (!controls.length && Array.isArray(gt.pages)) controls = gt.pages.filter((p) => p.control).map((p) => p.url ?? p.path);
  controls = controls.map((c) => normPath(typeof c === 'string' ? c : (c.url ?? c.path)));
  const areas = gt.areas ? (Array.isArray(gt.areas) ? gt.areas.map((a) => (typeof a === 'string' ? a : a.id)) : Object.keys(gt.areas)) : [...new Set(defects.map((d) => d.area))];
  return { defects, controls: new Set(controls), areas, raw: gt };
}

export function loadMapping(tool) {
  const file = join(BENCH, 'mappings', `${tool}.json`);
  if (!existsSync(file)) return {};
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const map = j.map ?? j;
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith('$') || k === 'tool' || k === 'notes') continue;
    const list = Array.isArray(v) ? v : typeof v === 'string' ? [v] : (v?.types ?? []);
    if (list.length) out[k] = list;
  }
  return out;
}

// ---------------------------------------------------------------------------

function namesPath(f, path) {
  const fp = normPath(f.url);
  if (fp !== null) return fp === path;
  if (path === '/' || !f.message) return false;
  // Site-level finding: does its text name the page? Match the path as a token.
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s"'(,:=]|https?://[^/\\s]+)${esc}/?($|[\\s"'),?#|])`).test(f.message);
}

export function scoreTool(tool, findings, gt, mapping) {
  // Ground-truth vocabulary: every primary and alt type, with the area(s) it belongs to.
  const typeArea = new Map();
  for (const d of gt.defects) for (const t of d.types) {
    if (!typeArea.has(t)) typeArea.set(t, new Set());
    typeArea.get(t).add(d.area);
  }
  // De-duplicate on (type, url).
  const seen = new Set();
  const unique = [];
  for (const f of findings) {
    const key = `${f.type}\u0000${normPath(f.url) ?? '(site)'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(f);
  }
  const mapped = unique.filter((f) => (mapping[f.type] ?? []).some((t) => typeArea.has(t)));
  const matchedDefects = new Map(); // defect id -> [finding keys]
  // A site-wide defect reported on every page (e.g. once per audited URL) counts
  // as one matching finding, not one per page.
  const siteWideSeen = new Set();
  const perFinding = [];
  for (const f of mapped) {
    const gtTypes = mapping[f.type];
    const hits = gt.defects.filter(
      (d) => d.types.some((t) => gtTypes.includes(t)) && (d.siteWide || d.paths.some((p) => namesPath(f, p))),
    );
    if (hits.length && hits.every((d) => d.siteWide)) {
      if (siteWideSeen.has(f.type)) continue;
      siteWideSeen.add(f.type);
    }
    for (const d of hits) {
      if (!matchedDefects.has(d.id)) matchedDefects.set(d.id, []);
      matchedDefects.get(d.id).push(`${f.type} @ ${f.url ?? 'site'}`);
    }
    const areas = [...new Set(gtTypes.flatMap((t) => [...(typeArea.get(t) ?? [])]))];
    const onControl = f.url !== null && f.url !== undefined && gt.controls.has(normPath(f.url));
    perFinding.push({ f, hit: hits.length > 0, areas, onControl });
  }

  const areaStats = {};
  for (const a of [...gt.areas, 'overall']) {
    const defs = a === 'overall' ? gt.defects : gt.defects.filter((d) => d.area === a);
    const fs = a === 'overall' ? perFinding : perFinding.filter((x) => x.areas.includes(a));
    const detected = defs.filter((d) => matchedDefects.has(d.id)).length;
    const tp = fs.filter((x) => x.hit).length;
    areaStats[a] = {
      defects: defs.length,
      detected,
      recall: defs.length ? detected / defs.length : null,
      mappedFindings: fs.length,
      matchingFindings: tp,
      precision: fs.length ? tp / fs.length : null,
      controlFalsePositives: fs.filter((x) => x.onControl && !x.hit).length,
    };
  }
  return {
    tool,
    totals: {
      findings: findings.length,
      uniqueFindings: unique.length,
      mappedFindings: mapped.length,
      unmappedFindings: unique.length - mapped.length,
    },
    areas: areaStats,
    detected: Object.fromEntries([...matchedDefects.entries()].map(([k, v]) => [k, v.slice(0, 5)])),
    missed: gt.defects.filter((d) => !matchedDefects.has(d.id)).map((d) => d.id),
    controlFalsePositives: perFinding
      .filter((x) => x.onControl && !x.hit)
      .map((x) => ({ type: x.f.type, url: x.f.url, message: String(x.f.message ?? '').slice(0, 160) })),
    falsePositiveSample: perFinding
      .filter((x) => !x.hit)
      .slice(0, 40)
      .map((x) => ({ type: x.f.type, url: x.f.url, maps: mapping[x.f.type] })),
  };
}

// ---------------------------------------------------------------------------
// Report

const pct = (v) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(0)}%`);
const fmtMs = (ms) => (ms === undefined ? '–' : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);

export function renderMarkdown(results) {
  const { tools, areas, perf } = results;
  const L = [];
  L.push('# Benchmark results', '');
  L.push(`Generated ${results.generatedAt}. Rules: [SPEC.md](../SPEC.md). Mappings: [mappings/](../mappings/). Raw outputs: [raw/](raw/).`, '');
  if (tools.length) {
    L.push(`Ground truth: ${results.groundTruth.defects} planted defects in ${areas.length} areas, ${results.groundTruth.controls} clean control pages.`, '');
    L.push('## Detection: overall', '');
    L.push('| Tool | Version | Recall | Precision | Defects found | Mapped findings | FP on controls | Unmapped findings | Pages | Time | Peak RSS |');
    L.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const t of tools) {
      const o = t.score.areas.overall;
      L.push(
        `| ${t.tool} | ${t.meta.version} | ${pct(o.recall)} | ${pct(o.precision)} | ${o.detected}/${o.defects} | ${o.mappedFindings} | ${o.controlFalsePositives} | ${t.score.totals.unmappedFindings} | ${t.meta.pagesAudited} | ${fmtMs(t.meta.durationMs)} | ${t.meta.peakRssMb} MB |`,
      );
    }
    L.push('');
    for (const [label, key] of [
      ['Recall by area', 'recall'],
      ['Precision by area', 'precision'],
    ]) {
      L.push(`## ${label}`, '');
      L.push(`| Area | ${tools.map((t) => t.tool).join(' | ')} |`);
      L.push(`| --- | ${tools.map(() => '---:').join(' | ')} |`);
      for (const a of areas) {
        const cells = tools.map((t) => {
          const s = t.score.areas[a];
          if (!s) return '–';
          return key === 'recall' ? `${pct(s.recall)} (${s.detected}/${s.defects})` : `${pct(s.precision)} (${s.matchingFindings}/${s.mappedFindings})`;
        });
        L.push(`| ${a} | ${cells.join(' | ')} |`);
      }
      L.push('');
    }
    L.push('## Run notes', '');
    for (const t of tools) {
      L.push(`- **${t.tool}** (${t.meta.version}): settings \`${JSON.stringify(t.meta.settings)}\``);
      for (const e of t.meta.errors ?? []) L.push(`  - error: ${String(e).replace(/\n/g, ' ').slice(0, 400)}`);
    }
    L.push('');
  }
  if (perf?.length) {
    L.push('## Performance (generated large site)', '');
    L.push('| Tool | Pages audited | Wall time | Peak RSS | Note | Errors |');
    L.push('| --- | ---: | ---: | ---: | --- | --- |');
    for (const p of perf) {
      L.push(`| ${p.tool} | ${p.meta.pagesAudited} | ${fmtMs(p.meta.durationMs)} | ${p.meta.peakRssMb} MB | ${p.note ?? ''} | ${(p.meta.errors ?? []).length} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

export function scoreAll({ tools, findingsDir = join(BENCH, 'results', 'findings'), outDir = join(BENCH, 'results') } = {}) {
  const gt = loadGroundTruth();
  const available = existsSync(findingsDir)
    ? readdirSync(findingsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
    : [];
  const list = (tools?.length ? tools : available).filter((t) => available.includes(t));
  const out = [];
  for (const tool of list) {
    const run = JSON.parse(readFileSync(join(findingsDir, `${tool}.json`), 'utf8'));
    const score = scoreTool(tool, run.findings, gt, loadMapping(tool));
    out.push({ tool, meta: run.meta, score });
  }
  let perf = null;
  const perfFile = join(outDir, 'perf.json');
  if (existsSync(perfFile)) perf = JSON.parse(readFileSync(perfFile, 'utf8')).runs;
  const results = {
    generatedAt: new Date().toISOString(),
    groundTruth: { defects: gt.defects.length, controls: gt.controls.size, areas: gt.areas },
    areas: gt.areas,
    tools: out,
    perf,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 1));
  writeFileSync(join(outDir, 'RESULTS.md'), renderMarkdown(results));
  return results;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tools = opt('--tools')?.split(',').filter(Boolean);
  const findingsDir = opt('--findings') ? resolve(opt('--findings')) : undefined;
  const r = scoreAll({ tools, findingsDir });
  for (const t of r.tools) {
    const o = t.score.areas.overall;
    console.log(`${t.tool.padEnd(14)} recall ${pct(o.recall).padStart(4)}  precision ${pct(o.precision).padStart(4)}  (${o.detected}/${o.defects} defects, ${o.mappedFindings} mapped findings, ${o.controlFalsePositives} FP on controls)`);
  }
  console.log('Wrote bench/results/results.json and bench/results/RESULTS.md');
}
