// Scrawly (IliasSami/scrawly-seo-crawler, Python package `sentinelseo`).
//
// Scrawly is a desktop app whose GUI is a web page served by a local FastAPI
// engine (src/sentinelseo/web/api.py). Its documented headless route is that
// engine's HTTP API, as used by its own scripts/scheduled_audit.py:
//   POST /api/clients            add the site (URL-only connection)
//   POST /api/audit/start        start an audit with the default crawl settings
//   GET  /api/audit/status/{id}  poll until phase == complete
//   GET  /api/export/{id}?format=json   the "developer export": one row per (issue, URL)
//   GET  /api/issues/{id}        issues with evidence
//   GET  /api/agentic/{id}       the origin-level Agentic Web report (probes)
// We start the engine with uvicorn exactly as the desktop launcher does, minus
// the GUI window and the self-updater.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { TOOLS_DIR, rssSampler, killTree, keepSmall, tail } from './_lib.mjs';

export const tool = 'scrawly';

const PY = join(TOOLS_DIR, 'venv-scrawly', 'bin', 'python');
const SRC = join(TOOLS_DIR, 'scrawly-src');
const PW_BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

/**
 * Settings a normal user changes to audit a whole site. Everything else is
 * Scrawly's default (CRAWL_CONFIG_DEFAULTS): JS rendering on, robots.txt
 * respected, sitemap discovery on, concurrency 8, ScrawlyBot UA.
 */
const WHOLE_SITE = { max_depth: 10, max_pages: 5000 };

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
    s.on('error', rej);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, path, body, timeoutMs = 120_000) {
  const res = await fetch(base + '/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function version() {
  const { execFileSync } = await import('node:child_process');
  try {
    const v = execFileSync(PY, ['-c', 'import importlib.metadata as m; print(m.version("sentinelseo"))'])
      .toString()
      .trim();
    const sha = execFileSync('git', ['-C', SRC, 'rev-parse', '--short', 'HEAD']).toString().trim();
    return `sentinelseo ${v} (git ${sha})`;
  } catch {
    return 'unknown';
  }
}

export async function run({ url, outDir, maxPages }) {
  mkdirSync(outDir, { recursive: true });
  const dataDir = join(outDir, '.scrawly-data');
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const errors = [];
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const settings = { ...WHOLE_SITE, ...(maxPages ? { max_pages: maxPages } : {}) };

  const started = Date.now();
  const server = spawn(
    PY,
    ['-m', 'uvicorn', 'sentinelseo.web.api:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'],
    {
      cwd: dataDir,
      env: {
        ...process.env,
        SCRAWLY_DATA_DIR: dataDir,
        SCRAWLY_DB_PATH: join(dataDir, 'scrawly.db'),
        SCRAWLY_AUTO_UPDATE: '0',
        PLAYWRIGHT_BROWSERS_PATH: PW_BROWSERS,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const sampler = rssSampler(server.pid);

  let crawlId = null;
  let status = {};
  const native = {};
  try {
    // Engine up?
    for (let i = 0; ; i++) {
      try {
        await api(base, '/crawls', undefined, 2000);
        break;
      } catch (e) {
        if (i > 120 || server.exitCode !== null) throw new Error(`engine did not start: ${tail(log)}`);
        await sleep(500);
      }
    }
    const client = await api(base, '/clients', { name: 'bench', base_url: url });
    crawlId = (await api(base, '/audit/start', { client_id: client.id, ...settings })).crawl_id;
    const deadline = Date.now() + 3_600_000;
    for (;;) {
      await sleep(1000);
      status = await api(base, `/audit/status/${crawlId}`);
      if (status.phase === 'complete' || status.phase === 'failed' || status.progress >= 100) break;
      if (Date.now() > deadline) throw new Error('audit timed out after 60 min');
    }
    if (status.phase === 'failed') errors.push(`audit failed: ${status.status ?? ''} ${status.error ?? ''}`);
    if (status.agentic_error) errors.push(`agentic pass error: ${status.agentic_error}`);
    native.export = await api(base, `/export/${crawlId}?format=json`);
    native.issues = await api(base, `/issues/${crawlId}`);
    native.agentic = await api(base, `/agentic/${crawlId}`);
    native.dashboard = await api(base, `/dashboard/${crawlId}`);
  } catch (e) {
    errors.push(String(e.message ?? e));
  }
  const durationMs = Date.now() - started;
  const peakRssMb = sampler.stop();
  killTree(server.pid, 'SIGTERM');
  await sleep(500);
  killTree(server.pid, 'SIGKILL');

  const { recent, active, ...statusSlim } = status;
  for (const [name, data] of Object.entries({ ...native, status: statusSlim })) {
    const f = join(outDir, `scrawly-${name}.json`);
    writeFileSync(f, JSON.stringify(data ?? null, null, 1));
    keepSmall(f);
  }
  writeFileSync(join(outDir, 'scrawly-engine.log'), tail(log, 20_000));
  rmSync(dataDir, { recursive: true, force: true });

  // Evidence per check (page-level issues carry it per row in /api/issues).
  const evidence = new Map((native.issues ?? []).map((i) => [i.check_id, i.evidence]));
  const findings = [];
  for (const row of native.export ?? []) {
    const ev = evidence.get(row.check_id);
    findings.push({
      tool,
      type: row.check_id,
      url: row.url || null,
      message: `${row.title}${!row.url && ev ? ' | ' + JSON.stringify(ev).slice(0, 400) : ''}`,
      severity: row.severity,
    });
  }
  // Agentic probes are origin-level: a failed probe is a site-wide finding.
  for (const p of native.agentic?.results ?? []) {
    if (p.status !== 'fail') continue;
    findings.push({
      tool,
      type: p.probe_id,
      url: null,
      message: `${p.title}: ${p.conclusion}`,
      severity: 'n/a',
    });
  }

  return {
    findings,
    meta: {
      version: await version(),
      settings: {
        route: 'local engine HTTP API (uvicorn sentinelseo.web.api:app), as scripts/scheduled_audit.py uses it',
        crawl: { ...settings, note: 'all other crawl settings are Scrawly defaults (js_render on, respect_robots on, discover_sitemap on)' },
        env: { SCRAWLY_AUTO_UPDATE: '0', PLAYWRIGHT_BROWSERS_PATH: PW_BROWSERS },
        localhost: 'no private-IP/localhost blocking exists in the crawler; nothing had to be enabled',
      },
      durationMs,
      peakRssMb,
      pagesAudited: status.crawled ?? native.dashboard?.totals?.urls ?? 0,
      errors,
    },
  };
}
