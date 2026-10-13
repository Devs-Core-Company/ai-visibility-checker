import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SiteConfig } from '../../core/config.js';
import { siteIdFromUrl } from '../../core/config.js';
import type { AuditResult, Fix, Issue, PageSummary, Severity } from '../../core/types.js';
import {
  allSites,
  audit,
  errMsg,
  FORMATS,
  getConfig,
  getStore,
  pickEngines,
  planFixes,
  previousAudit,
  diff,
  removeUserSite,
  renderReport,
  reportPdf,
  toUrl,
  upsertUserSite,
  type Format,
} from '../../cli/services.js';
import { back, form, str, arr, type Deps, type ServerEnv, type AppContext } from '../app.js';
import {
  Bar,
  Badge,
  CopyButton,
  Empty,
  fmtDate,
  Gauge,
  Layout,
  PILLAR_LABEL,
  SevBadge,
  siteHref,
  Sparkline,
  pct,
} from '../ui.js';

const SEVS: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export type SiteRow = ReturnType<typeof allSites>[number];

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function findSite(id: string): SiteRow | undefined {
  return allSites(getConfig()).find((s) => s.id === id);
}

/** The audit to show: ?audit=<id> or the latest for the site. */
export function auditFor(c: AppContext, siteId: string): AuditResult | null {
  const store = getStore();
  const id = c.req.query('audit');
  if (id) {
    const a = store.getAudit(id);
    if (a) return a;
  }
  return store.latestAudit(siteId);
}

/** Fields the page filter builder can use. */
export const RULE_FIELDS: Record<string, string> = {
  url: 'URL',
  title: 'Title',
  metaDescription: 'Description',
  h1: 'H1',
  canonical: 'Canonical',
  schemaTypes: 'Schema types',
  status: 'Status',
  depth: 'Depth',
  wordCount: 'Words',
  inlinks: 'Inlinks',
  outlinks: 'Outlinks',
  bytes: 'Bytes',
  ttfbMs: 'TTFB ms',
  issues: 'Issues',
};

export const RULE_OPS: [string, string][] = [
  ['contains', 'contains'],
  ['not-contains', 'does not contain'],
  ['equals', 'equals'],
  ['starts', 'starts with'],
  ['gt', 'greater than'],
  ['lt', 'less than'],
  ['empty', 'is empty'],
];

/** One filter-builder rule against a page row. Text comparisons ignore case. */
export function matchRule(
  p: PageSummary,
  r: { field: string; op: string; value: string },
): boolean {
  const raw = (p as unknown as Record<string, unknown>)[r.field];
  const text = Array.isArray(raw) ? raw.join(' ') : raw == null ? '' : String(raw);
  const t = text.toLowerCase();
  const v = r.value.toLowerCase();
  switch (r.op) {
    case 'contains':
      return t.includes(v);
    case 'not-contains':
      return !t.includes(v);
    case 'equals':
      return t === v;
    case 'starts':
      return t.startsWith(v);
    case 'gt':
      return Number(text) > Number(r.value);
    case 'lt':
      return Number(text) < Number(r.value);
    case 'empty':
      return t.trim() === '';
    default:
      return true;
  }
}

export function NoAudit({ site }: { site: SiteConfig }) {
  return (
    <Empty>
      <p>No audit for this site yet.</p>
      <a class="btn primary" href={siteHref(site.id, 'run')}>
        Run the first audit
      </a>
    </Empty>
  );
}

export function fixMap(result: AuditResult): Map<string, Fix> {
  const m = new Map<string, Fix>();
  for (const p of result.priorities) if (p.fix) m.set(p.checkId, p.fix);
  try {
    for (const f of planFixes(result)) if (!m.has(f.checkId)) m.set(f.checkId, f);
  } catch {
    /* fixes module unavailable: show the check's own fix text */
  }
  return m;
}

export function registerSitePages(app: Hono<ServerEnv>, deps: Deps) {
  // ---------------------------------------------------------------- sites
  app.get('/', (c) => {
    const sites = allSites(getConfig());
    const store = getStore();
    const running = deps.jobs.list().filter((j) => j.status === 'running');
    return c.html(
      <Layout title="Sites" active="sites" flash={c.get('flash')}>
        {running.length ? (
          <div class="notice">
            Running now:{' '}
            {running.map((j) => (
              <a href={`/jobs/${j.id}`}>{j.label} </a>
            ))}
          </div>
        ) : null}
        {sites.length ? (
          <div class="grid grid-3">
            {sites.map((s) => {
              const rows = store.listAudits(s.id, 12);
              const last = rows[0];
              return (
                <a class="card" href={siteHref(s.id)} style="color:inherit;text-decoration:none">
                  <div class="row spread">
                    <div>
                      <h3 style="margin:0">{s.id}</h3>
                      <small>{s.url}</small>
                    </div>
                    {last ? (
                      <Gauge score={last.score} grade={last.grade} size={70} />
                    ) : (
                      <Badge>not audited</Badge>
                    )}
                  </div>
                  <div class="row spread" style="margin-top:10px">
                    <small>{last ? `Last audit ${fmtDate(last.at)}` : 'No audits yet'}</small>
                    <Sparkline values={rows.map((r) => r.score).reverse()} label="Score trend" />
                  </div>
                </a>
              );
            })}
          </div>
        ) : (
          <Empty>
            <p>No sites yet. Add the site you want to work on.</p>
          </Empty>
        )}
        <div class="card" style="margin-top:20px">
          <h2>Add a site</h2>
          <form method="post" action="/sites" class="filters">
            <div class="field" style="flex:2 1 280px">
              <label for="url">Site URL</label>
              <input id="url" name="url" type="url" required placeholder="https://example.com" />
            </div>
            <div class="field" style="flex:1 1 200px">
              <label for="name">Brand name (optional)</label>
              <input id="name" name="name" type="text" placeholder="Example Co" />
            </div>
            <div class="field" style="flex:2 1 280px">
              <label for="competitors">Competitors, comma-separated (optional)</label>
              <input
                id="competitors"
                name="competitors"
                type="text"
                placeholder="Rival Ltd, rival.example"
              />
            </div>
            <button class="btn primary" type="submit">
              Add site
            </button>
          </form>
          <p class="muted" style="margin:0">
            Saved to ~/.avc/config.json. Sites in a project avc.config.json show up here too.
          </p>
        </div>
      </Layout>,
    );
  });

  app.post('/sites', async (c) => {
    const f = await form(c);
    let url: string;
    try {
      url = toUrl(str(f.url));
    } catch {
      return back(c, '/', 'That URL does not look right.', 'error');
    }
    const id = siteIdFromUrl(url);
    const name = str(f.name);
    const competitors = str(f.competitors)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((n) => (/\./.test(n) ? { name: n.split('.')[0], domain: n } : { name: n }));
    const existing = findSite(id);
    upsertUserSite({
      ...(existing?.configured ? existing : {}),
      id,
      url,
      ...(name || competitors.length
        ? {
            brand: {
              ...existing?.brand,
              ...(name ? { name } : {}),
              ...(competitors.length ? { competitors } : {}),
            },
          }
        : {}),
    });
    return back(c, siteHref(id), `Added ${id}. Run an audit to see where it stands.`);
  });

  app.post('/sites/:id/delete', async (c) => {
    const id = c.req.param('id');
    const f = await form(c);
    removeUserSite(id);
    if (str(f.purge) === 'on') getStore().deleteSite(id);
    return back(c, '/', `Removed ${id}.`);
  });

  // ---------------------------------------------------------------- overview
  app.get('/s/:id', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const store = getStore();
    const result = auditFor(c, site.id);
    const trends = store.trends(site.id, 30);
    const sched = store.getSchedule(site.id);
    const running = deps.jobs.running(site.id);
    let conns: { label: string; configured: boolean; ok: boolean | null; detail: string }[] = [];
    try {
      const { connectionStatus } = await import('../../connect/index.js');
      conns = await connectionStatus(site, getConfig(), { test: false });
    } catch {
      /* connect module unavailable */
    }
    let nextRun: string | null = null;
    const cron = site.schedule?.audit ?? sched?.auditCron;
    if (cron) {
      try {
        const { Cron } = await import('croner');
        nextRun = new Cron(cron, { paused: true }).nextRun()?.toISOString() ?? null;
      } catch {
        nextRun = null;
      }
    }
    const audits = [...trends.audits].reverse();
    const vis = [...trends.visibility].reverse();
    return c.html(
      <Layout
        title="Overview"
        siteId={site.id}
        siteUrl={site.url}
        active="overview"
        flash={c.get('flash')}
        actions={
          <>
            {running ? (
              <a class="btn" href={`/jobs/${running.id}`}>
                Audit running…
              </a>
            ) : (
              <a class="btn primary" href={siteHref(site.id, 'run')}>
                Run audit
              </a>
            )}
          </>
        }
      >
        {!result ? (
          <NoAudit site={site} />
        ) : (
          <>
            <div class="grid grid-2">
              <div class="card row" style="gap:24px;align-items:center">
                <Gauge
                  score={result.score.overall}
                  grade={result.score.grade}
                  label="AI Visibility Score"
                />
                <div>
                  <div class="eyebrow">AI Visibility Score</div>
                  <p style="margin:6px 0">
                    {result.stats.pagesCrawled} pages · {result.issues.length} issues ·{' '}
                    {result.stack.id}
                    {result.stack.host ? ` on ${result.stack.host}` : ''}
                  </p>
                  <small>Audited {fmtDate(result.at)}</small>
                  {!result.visibility ? (
                    <p class="muted" style="margin-top:8px">
                      Readiness only: no AI visibility run in this audit, so that pillar is left
                      out.
                    </p>
                  ) : null}
                  <div class="row" style="margin-top:10px">
                    <Sparkline values={audits.map((a) => a.score)} label="Score trend" />
                    <small>score over {audits.length} audits</small>
                  </div>
                </div>
              </div>
              <div class="card">
                <h3>Pillars</h3>
                {result.score.pillars.map((p) => (
                  <div class="pillar">
                    <span>{PILLAR_LABEL[p.pillar] ?? p.pillar}</span>
                    {p.weight ? <Bar value={p.score} /> : <small>not measured</small>}
                    <span class="num">{p.weight ? p.score : '-'}</span>
                  </div>
                ))}
              </div>
            </div>

            <div class="grid grid-4" style="margin-top:16px">
              {SEVS.slice(0, 4).map((s) => {
                const n = result.issues.filter(
                  (i) => (i.severity ?? result.checks[i.checkId]?.severity) === s,
                ).length;
                return (
                  <a
                    class="card"
                    href={`${siteHref(site.id, 'issues')}?severity=${s}`}
                    style="color:inherit;text-decoration:none"
                  >
                    <div class="eyebrow">{s}</div>
                    <div
                      class={`stat ${s === 'critical' || s === 'high' ? (n ? 'c-bad' : 'c-good') : ''}`}
                    >
                      {n}
                    </div>
                  </a>
                );
              })}
              <div class="card">
                <div class="eyebrow">AI mention rate</div>
                <div class="stat">{vis.length ? pct(vis[vis.length - 1].mentionRate) : '-'}</div>
                <Sparkline
                  values={vis.map((v) => v.mentionRate * 100)}
                  label="Mention rate trend"
                />
              </div>
            </div>

            <div class="grid grid-2" style="margin-top:16px">
              <div class="card">
                <h3>Fix first</h3>
                <ol style="padding-left:20px;margin:0">
                  {result.priorities.slice(0, 8).map((p) => {
                    const def = result.checks[p.checkId];
                    return (
                      <li style="margin-bottom:6px">
                        <a
                          href={`${siteHref(site.id, 'issues')}?check=${encodeURIComponent(p.checkId)}`}
                        >
                          {def?.title ?? p.checkId}
                        </a>{' '}
                        <SevBadge sev={def?.severity ?? 'info'} />{' '}
                        <small>
                          {def?.scope === 'page' ? plural(p.affected, 'page') : 'site-wide'}
                        </small>
                      </li>
                    );
                  })}
                </ol>
              </div>
              <div class="card">
                <h3>Monitoring and connections</h3>
                <dl class="kv">
                  <dt>Scheduled audit</dt>
                  <dd>
                    {cron ? (
                      `${cron} · next ${fmtDate(nextRun)}`
                    ) : (
                      <a href={siteHref(site.id, 'history')}>not scheduled</a>
                    )}
                  </dd>
                  <dt>Last scheduled run</dt>
                  <dd>{fmtDate(sched?.lastAuditRun)}</dd>
                  {conns.map((r) => (
                    <>
                      <dt>{r.label}</dt>
                      <dd>
                        {r.configured ? (
                          <Badge cls="s-good">connected</Badge>
                        ) : (
                          <Badge>not connected</Badge>
                        )}{' '}
                        <small>{r.detail}</small>
                      </dd>
                    </>
                  ))}
                </dl>
                <p style="margin:10px 0 0">
                  <a href={siteHref(site.id, 'connections')}>Manage connections</a>
                </p>
              </div>
            </div>

            <ExportLinks result={result} />
          </>
        )}
        <hr />
        <form
          method="post"
          action={`/sites/${encodeURIComponent(site.id)}/delete`}
          data-confirm={`Remove ${site.id} from your sites?`}
          class="row"
        >
          <label class="check">
            <input type="checkbox" name="purge" /> also delete its stored audits
          </label>
          <button class="btn danger small" type="submit">
            Remove site
          </button>
        </form>
      </Layout>,
    );
  });

  // ---------------------------------------------------------------- run audit
  app.get('/s/:id/run', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const running = deps.jobs.running(site.id);
    const cfg = getConfig();
    return c.html(
      <Layout
        title="Run audit"
        siteId={site.id}
        siteUrl={site.url}
        active="run"
        flash={c.get('flash')}
      >
        {running ? (
          <div class="notice warn">
            An audit is already running. <a href={`/jobs/${running.id}`}>Watch it</a>.
          </div>
        ) : null}
        <form method="post" action={siteHref(site.id, 'run')} class="card">
          <div class="grid grid-3">
            <div class="field">
              <label for="url">Start URL</label>
              <input id="url" name="url" type="url" value={site.url} required />
            </div>
            <div class="field">
              <label for="maxPages">Max pages (0 = no limit)</label>
              <input
                id="maxPages"
                name="maxPages"
                type="number"
                min="0"
                value={String(site.crawl?.maxPages ?? 500)}
              />
            </div>
            <div class="field">
              <label for="maxDepth">Max depth</label>
              <input
                id="maxDepth"
                name="maxDepth"
                type="number"
                min="0"
                value={String(site.crawl?.maxDepth ?? 10)}
              />
            </div>
          </div>
          <fieldset>
            <legend>JavaScript rendering (needs Chrome or Chromium)</legend>
            {(['auto', 'on', 'off'] as const).map((v) => (
              <label class="check">
                <input
                  type="radio"
                  name="render"
                  value={v}
                  checked={
                    v ===
                    (site.crawl?.render === true
                      ? 'on'
                      : site.crawl?.render === false
                        ? 'off'
                        : 'auto')
                  }
                />{' '}
                {v === 'auto'
                  ? 'Auto: a sample plus pages with little raw text'
                  : v === 'on'
                    ? 'Render every page'
                    : 'Never render'}
              </label>
            ))}
          </fieldset>
          <div class="grid grid-2">
            <div class="field">
              <label for="include">Only crawl URLs matching (regex, one per line)</label>
              <textarea id="include" name="include" style="min-height:60px">
                {(site.crawl?.include ?? []).join('\n')}
              </textarea>
            </div>
            <div class="field">
              <label for="exclude">Skip URLs matching (regex, one per line)</label>
              <textarea id="exclude" name="exclude" style="min-height:60px">
                {(site.crawl?.exclude ?? []).join('\n')}
              </textarea>
            </div>
          </div>
          <div class="field">
            <label for="only">
              Only these checks (ids, categories or pillars, comma-separated; empty = all)
            </label>
            <input
              id="only"
              name="only"
              type="text"
              placeholder="e.g. ai-crawlers, llms-txt, geo"
            />
          </div>
          <fieldset>
            <legend>
              AI visibility (uses your AI keys; caps: ${cfg.ai.maxRunUsd} a run, $
              {cfg.ai.maxMonthUsd} a month)
            </legend>
            <label class="check">
              <input type="checkbox" name="visibility" /> Also ask AI engines about the brand
            </label>
            <p class="muted" style="margin:6px 0 0">
              Pick engines and see the cost estimate on the{' '}
              <a href={siteHref(site.id, 'visibility')}>AI visibility</a> page.
            </p>
          </fieldset>
          <button class="btn primary" type="submit" disabled={Boolean(running)}>
            Start audit
          </button>
        </form>
      </Layout>,
    );
  });

  app.post('/s/:id/run', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    if (deps.jobs.running(site.id))
      return back(
        c,
        siteHref(site.id, 'run'),
        'An audit is already running for this site.',
        'warn',
      );
    const f = await form(c);
    const lines = (v: string) =>
      v
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    const render = str(f.render);
    const num = (v: string) => (v === '' ? undefined : Math.max(0, Math.floor(Number(v))));
    let url: string;
    try {
      url = toUrl(str(f.url) || site.url);
    } catch {
      return back(c, siteHref(site.id, 'run'), 'That start URL does not look right.', 'error');
    }
    const wantVis = str(f.visibility) === 'on';
    const engines = arr(f.engines);
    const job = deps.jobs.start(
      'audit',
      site.id,
      `Audit of ${site.id}`,
      async (onProgress, signal) => {
        const result = await audit({
          url,
          site,
          maxPages: num(str(f.maxPages)),
          maxDepth: num(str(f.maxDepth)),
          render: render === 'on' ? true : render === 'off' ? false : 'auto',
          include: lines(str(f.include)),
          exclude: lines(str(f.exclude)),
          only: str(f.only) ? [str(f.only)] : undefined,
          visibility: wantVis
            ? { engines: engines.length ? pickEngines(engines) : undefined }
            : false,
          onProgress,
          signal,
        });
        return `${siteHref(site.id)}?audit=${result.id}&msg=${encodeURIComponent(`Audit done: score ${result.score.overall}.`)}&kind=ok`;
      },
    );
    return c.redirect(`/jobs/${job.id}`, 303);
  });

  // ---------------------------------------------------------------- jobs
  app.get('/jobs/:id', (c) => {
    const job = deps.jobs.get(c.req.param('id'));
    if (!job) return c.notFound();
    const site = findSite(job.siteId);
    return c.html(
      <Layout
        title={job.label}
        siteId={site?.id}
        siteUrl={site?.url}
        active={job.kind === 'audit' ? 'run' : 'visibility'}
      >
        <div class="card" data-job={job.id} data-events={`/jobs/${job.id}/events`}>
          <p data-status aria-live="polite">
            {job.status === 'running' ? 'Starting…' : job.status === 'done' ? 'Done.' : job.error}
          </p>
          <div
            class={`progress ${job.status === 'running' ? 'indeterminate' : ''}`}
            role="progressbar"
            aria-label="Progress"
          >
            <span></span>
          </div>
          <div class="log" style="margin-top:14px" aria-label="Log"></div>
          {job.status === 'running' ? (
            <form
              method="post"
              action={`/jobs/${job.id}/cancel`}
              style="margin-top:12px"
              data-cancel
            >
              <button class="btn danger" type="submit">
                Cancel
              </button>
            </form>
          ) : job.redirect ? (
            <a class="btn primary" href={job.redirect} style="margin-top:12px">
              See results
            </a>
          ) : null}
          <noscript>
            <p>Reload this page to see progress.</p>
          </noscript>
        </div>
      </Layout>,
    );
  });

  app.get('/jobs/:id/events', (c) => {
    const job = deps.jobs.get(c.req.param('id'));
    if (!job) return c.notFound();
    return streamSSE(c, async (stream) => {
      for (const e of job.events)
        await stream.writeSSE({ event: 'progress', data: JSON.stringify(e) });
      if (job.status !== 'running') {
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ redirect: job.redirect, error: job.error }),
        });
        return;
      }
      await new Promise<void>((resolve) => {
        // Writes are chained so the final "done" event is flushed before the stream closes.
        let chain: Promise<unknown> = Promise.resolve();
        const send = (event: string, data: unknown) =>
          (chain = chain
            .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
            .catch(() => {}));
        const listener = (m: { event: string; data: unknown }) => {
          send(m.event, m.data);
          if (m.event === 'done') void chain.then(finish);
        };
        const finish = () => {
          job.listeners.delete(listener);
          clearInterval(ping);
          resolve();
        };
        const ping = setInterval(() => send('ping', {}), 15_000);
        job.listeners.add(listener);
        stream.onAbort(finish);
      });
    });
  });

  app.post('/jobs/:id/cancel', (c) => {
    const job = deps.jobs.get(c.req.param('id'));
    if (!job) return c.notFound();
    deps.jobs.cancel(job.id);
    return back(c, `/jobs/${job.id}`, 'Cancelling…', 'warn');
  });

  // ---------------------------------------------------------------- issues
  app.get('/s/:id/issues', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    const q = {
      pillar: c.req.query('pillar') ?? '',
      category: c.req.query('category') ?? '',
      severity: c.req.query('severity') ?? '',
      check: c.req.query('check') ?? '',
      q: (c.req.query('q') ?? '').toLowerCase(),
    };
    if (!result)
      return c.html(
        <Layout title="Issues" siteId={site.id} siteUrl={site.url} active="issues">
          <NoAudit site={site} />
        </Layout>,
      );
    const fixes = fixMap(result);
    const groups = new Map<string, Issue[]>();
    for (const i of result.issues) {
      const def = result.checks[i.checkId];
      const sev = i.severity ?? def?.severity;
      if (q.pillar && def?.pillar !== q.pillar) continue;
      if (q.category && def?.category !== q.category) continue;
      if (q.severity && sev !== q.severity) continue;
      if (q.check && i.checkId !== q.check) continue;
      if (
        q.q &&
        !`${i.checkId} ${def?.title} ${i.message} ${i.url ?? ''}`.toLowerCase().includes(q.q)
      )
        continue;
      groups.set(i.checkId, [...(groups.get(i.checkId) ?? []), i]);
    }
    const rank = new Map(result.priorities.map((p, i) => [p.checkId, i]));
    const ordered = [...groups.entries()].sort(
      (a, b) =>
        SEVS.indexOf(result.checks[a[0]]?.severity ?? 'info') -
          SEVS.indexOf(result.checks[b[0]]?.severity ?? 'info') ||
        (rank.get(a[0]) ?? 999) - (rank.get(b[0]) ?? 999),
    );
    const cats = [...new Set(Object.values(result.checks).map((d) => d.category))].sort();
    const pillars = [...new Set(Object.values(result.checks).map((d) => d.pillar))];
    const total = ordered.reduce((n, [, l]) => n + l.length, 0);
    return c.html(
      <Layout
        title="Issues"
        siteId={site.id}
        siteUrl={site.url}
        active="issues"
        flash={c.get('flash')}
      >
        <form method="get" class="filters" role="search">
          {c.req.query('audit') ? (
            <input type="hidden" name="audit" value={c.req.query('audit')} />
          ) : null}
          <div class="field">
            <label for="f-pillar">Pillar</label>
            <select id="f-pillar" name="pillar">
              <option value="">All</option>
              {pillars.map((p) => (
                <option value={p} selected={q.pillar === p}>
                  {PILLAR_LABEL[p] ?? p}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="f-cat">Category</label>
            <select id="f-cat" name="category">
              <option value="">All</option>
              {cats.map((x) => (
                <option value={x} selected={q.category === x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="f-sev">Severity</label>
            <select id="f-sev" name="severity">
              <option value="">All</option>
              {SEVS.map((s) => (
                <option value={s} selected={q.severity === s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div class="field" style="flex:1 1 220px">
            <label for="f-q">Search</label>
            <input
              id="f-q"
              type="search"
              name="q"
              value={c.req.query('q') ?? ''}
              placeholder="title, URL, check id"
            />
          </div>
          <button class="btn" type="submit">
            Filter
          </button>
          <a class="btn ghost" href={siteHref(site.id, 'issues')}>
            Clear
          </a>
        </form>
        <p class="muted">
          {total} issues in {ordered.length} checks · audit {result.id} · {fmtDate(result.at)}
        </p>
        {ordered.length === 0 ? <Empty>No issues match these filters.</Empty> : null}
        {ordered.map(([checkId, list], idx) => {
          const def = result.checks[checkId];
          const fix = fixes.get(checkId);
          const urls = list.map((i) => i.url).filter(Boolean) as string[];
          const pid = `fix-${idx}`;
          return (
            <details class="issue" open={Boolean(q.check) || undefined} id={checkId}>
              <summary>
                <SevBadge sev={list[0].severity ?? def?.severity ?? 'info'} />
                <span class="issue-title">{def?.title ?? checkId}</span>
                <Badge>{PILLAR_LABEL[def?.pillar ?? ''] ?? def?.pillar}</Badge>
                <small>{def?.scope === 'page' ? plural(urls.length, 'page') : 'site-wide'}</small>
              </summary>
              <div class="body">
                <p class="muted" style="margin-top:12px">
                  <code>{checkId}</code> · {def?.category} · fix: {fix?.tier ?? def?.fixTier}
                  {fix?.autoApplicable ? ' · can be applied automatically' : ''}
                </p>
                {def?.why ? <p>{def.why}</p> : null}
                {list.length && !urls.length ? (
                  <ul>
                    {list.slice(0, 10).map((i) => (
                      <li>
                        {i.message}
                        {i.evidence ? (
                          <>
                            {' '}
                            <code>{i.evidence.slice(0, 200)}</code>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {urls.length ? (
                  <>
                    <h4>Affected pages</h4>
                    <ul class="urls">
                      {list.slice(0, 300).map((i) => (
                        <li>
                          <a
                            href={`${siteHref(site.id, 'page')}?url=${encodeURIComponent(i.url ?? '')}&audit=${result.id}`}
                          >
                            {i.url}
                          </a>{' '}
                          <small>{i.message}</small>
                        </li>
                      ))}
                    </ul>
                    {list.length > 300 ? (
                      <small>…and {list.length - 300} more (export CSV for all).</small>
                    ) : null}
                  </>
                ) : null}
                <h4>How to fix{fix ? ` (${fix.stack})` : ''}</h4>
                {fix ? (
                  <>
                    <ol class="steps">
                      {fix.steps.map((s) => (
                        <li>{s}</li>
                      ))}
                    </ol>
                    {fix.files.length ? (
                      <p>
                        <small>Files: </small>
                        {fix.files.map((f) => (
                          <code style="margin-right:6px">{f}</code>
                        ))}
                      </p>
                    ) : null}
                    {fix.snippet ? (
                      <>
                        <div class="row spread">
                          <small class="eyebrow">{fix.snippet.language}</small>
                          <CopyButton target={`#${pid}-snip`} label="Copy snippet" />
                        </div>
                        <pre id={`${pid}-snip`}>{fix.snippet.code}</pre>
                      </>
                    ) : null}
                    <div class="row" style="margin-top:10px">
                      <CopyButton
                        text={fix.agentPrompt}
                        label="Copy prompt for Claude Code / Cursor"
                      />
                      <small>
                        Effort: {fix.effort} · impact: {fix.impact}
                      </small>
                    </div>
                  </>
                ) : (
                  <p>{def?.fix}</p>
                )}
                {def?.refs?.length ? (
                  <p>
                    <small>
                      References:{' '}
                      {def.refs.map((r) => (
                        <a href={r} rel="noopener noreferrer" style="margin-right:8px">
                          {r.replace(/^https?:\/\//, '').slice(0, 60)}
                        </a>
                      ))}
                    </small>
                  </p>
                ) : null}
              </div>
            </details>
          );
        })}
        <ExportLinks result={result} />
      </Layout>,
    );
  });

  // ---------------------------------------------------------------- pages
  app.get('/s/:id/pages', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    if (!result)
      return c.html(
        <Layout title="Pages" siteId={site.id} siteUrl={site.url} active="pages">
          <NoAudit site={site} />
        </Layout>,
      );
    const status = c.req.query('status') ?? '';
    const indexable = c.req.query('indexable') ?? '';
    const num = (k: string) => {
      const v = c.req.query(k);
      return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
    };
    const minDepth = num('minDepth');
    const maxWords = num('maxWords');
    const maxInlinks = num('maxInlinks');
    const minIssues = num('minIssues');
    const schema = (c.req.query('schema') ?? '').trim().toLowerCase();
    // Custom rules: field + operator + value (up to three), like a filter builder.
    const rules = [1, 2, 3]
      .map((i) => ({
        field: c.req.query(`f${i}`) ?? '',
        op: c.req.query(`o${i}`) ?? 'contains',
        value: c.req.query(`v${i}`) ?? '',
      }))
      .filter((r) => r.field in RULE_FIELDS && (r.value !== '' || r.op === 'empty'));
    const rows = result.pages.filter((p) => {
      if (status && String(p.status).charAt(0) !== status.charAt(0)) return false;
      if (indexable === 'yes' && !p.indexable) return false;
      if (indexable === 'no' && p.indexable) return false;
      if (minDepth !== null && p.depth < minDepth) return false;
      if (maxWords !== null && p.wordCount > maxWords) return false;
      if (maxInlinks !== null && p.inlinks > maxInlinks) return false;
      if (minIssues !== null && p.issues < minIssues) return false;
      if (schema && !p.schemaTypes.some((t) => t.toLowerCase().includes(schema))) return false;
      return rules.every((r) => matchRule(p, r));
    });
    const auditQ = c.req.query('audit') ? `&audit=${c.req.query('audit')}` : '';
    return c.html(
      <Layout title="Pages" siteId={site.id} siteUrl={site.url} active="pages">
        <form method="get" class="filters">
          {c.req.query('audit') ? (
            <input type="hidden" name="audit" value={c.req.query('audit')} />
          ) : null}
          <div class="field">
            <label for="p-status">Status</label>
            <select id="p-status" name="status">
              <option value="">All</option>
              {['2xx', '3xx', '4xx', '5xx'].map((s) => (
                <option value={s} selected={status === s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="p-idx">Indexable</label>
            <select id="p-idx" name="indexable">
              <option value="">All</option>
              <option value="yes" selected={indexable === 'yes'}>
                Indexable
              </option>
              <option value="no" selected={indexable === 'no'}>
                Not indexable
              </option>
            </select>
          </div>
          <div class="field">
            <label for="p-depth">Depth at least</label>
            <input
              id="p-depth"
              name="minDepth"
              type="number"
              min="0"
              style="width:6em"
              value={minDepth ?? ''}
            />
          </div>
          <div class="field">
            <label for="p-words">Words at most</label>
            <input
              id="p-words"
              name="maxWords"
              type="number"
              min="0"
              style="width:7em"
              value={maxWords ?? ''}
            />
          </div>
          <div class="field">
            <label for="p-inl">Inlinks at most</label>
            <input
              id="p-inl"
              name="maxInlinks"
              type="number"
              min="0"
              style="width:6em"
              value={maxInlinks ?? ''}
            />
          </div>
          <div class="field">
            <label for="p-iss">Issues at least</label>
            <input
              id="p-iss"
              name="minIssues"
              type="number"
              min="0"
              style="width:6em"
              value={minIssues ?? ''}
            />
          </div>
          <div class="field">
            <label for="p-schema">Schema type</label>
            <input
              id="p-schema"
              name="schema"
              style="width:9em"
              value={schema}
              placeholder="Product"
            />
          </div>
          {[1, 2, 3].map((i) => {
            const r = rules[i - 1];
            return (
              <div class="field">
                <label for={`p-f${i}`}>{`Rule ${i}`}</label>
                <div class="row" style="gap:4px">
                  <select id={`p-f${i}`} name={`f${i}`} aria-label={`Rule ${i} field`}>
                    <option value="">—</option>
                    {Object.entries(RULE_FIELDS).map(([k, label]) => (
                      <option value={k} selected={r?.field === k}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select name={`o${i}`} aria-label={`Rule ${i} operator`}>
                    {RULE_OPS.map(([k, label]) => (
                      <option value={k} selected={r?.op === k}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <input
                    name={`v${i}`}
                    aria-label={`Rule ${i} value`}
                    style="width:8em"
                    value={r?.value ?? ''}
                  />
                </div>
              </div>
            );
          })}
          <button class="btn" type="submit">
            Filter
          </button>
          <div class="field" style="flex:1 1 220px">
            <label for="p-q">Find in table</label>
            <input id="p-q" type="search" data-filter="#pages-table" placeholder="URL or title" />
          </div>
        </form>
        <p class="muted">{rows.length} pages</p>
        <div class="table-wrap">
          <table data-sortable id="pages-table">
            <thead>
              <tr>
                {[
                  ['URL', ''],
                  ['Status', 'num'],
                  ['Title', ''],
                  ['Words', 'num'],
                  ['Rendered', 'num'],
                  ['Depth', 'num'],
                  ['Inlinks', 'num'],
                  ['Issues', 'num'],
                  ['Index', ''],
                ].map(([h, cls]) => (
                  <th class={cls} scope="col">
                    <button class="sort" type="button">
                      {h}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 5000).map((p) => (
                <tr data-row>
                  <td class="url">
                    <a
                      href={`${siteHref(site.id, 'page')}?url=${encodeURIComponent(p.url)}${auditQ}`}
                    >
                      {p.url}
                    </a>
                  </td>
                  <td class="num">
                    <span
                      class={
                        p.status >= 400 || p.status === 0 ? 'c-bad' : p.status >= 300 ? 'c-mid' : ''
                      }
                    >
                      {p.status}
                    </span>
                  </td>
                  <td>{p.title ?? <span class="muted">none</span>}</td>
                  <td class="num">{p.wordCount}</td>
                  <td class="num" data-v={String(p.renderedWordCount ?? -1)}>
                    {p.renderedWordCount ?? '-'}
                  </td>
                  <td class="num">{p.depth}</td>
                  <td class="num">{p.inlinks}</td>
                  <td class="num">{p.issues}</td>
                  <td>
                    {p.indexable ? <Badge cls="s-good">yes</Badge> : <Badge cls="s-bad">no</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Layout>,
    );
  });

  app.get('/s/:id/page', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    const url = c.req.query('url') ?? '';
    const page = result?.pages.find((p) => p.url === url || p.finalUrl === url);
    if (!result || !page) return c.notFound();
    const issues = result.issues.filter((i) => i.url === page.url || i.url === page.finalUrl);
    const fixes = fixMap(result);
    return c.html(
      <Layout title="Page detail" siteId={site.id} siteUrl={site.url} active="pages">
        <p>
          <a href={page.url} rel="noopener noreferrer">
            {page.url}
          </a>{' '}
          <span class="muted small">
            Screenshot:{' '}
            <a
              href={`/s/${encodeURIComponent(site.id)}/screenshot?url=${encodeURIComponent(page.url)}`}
              target="_blank"
              rel="noopener"
            >
              desktop
            </a>{' '}
            ·{' '}
            <a
              href={`/s/${encodeURIComponent(site.id)}/screenshot?device=mobile&url=${encodeURIComponent(page.url)}`}
              target="_blank"
              rel="noopener"
            >
              phone
            </a>
          </span>
        </p>
        {page.extracted ? (
          <div class="card">
            <h3>Custom extraction</h3>
            <dl class="kv">
              {Object.entries(page.extracted).map(([k, v]) => (
                <>
                  <dt>{k}</dt>
                  <dd>{Array.isArray(v) ? v.join(' | ') || '—' : String(v)}</dd>
                </>
              ))}
            </dl>
          </div>
        ) : null}
        <div class="grid grid-2">
          <div class="card">
            <h3>Page</h3>
            <dl class="kv">
              <dt>Status</dt>
              <dd>{page.status}</dd>
              <dt>Final URL</dt>
              <dd>{page.finalUrl}</dd>
              <dt>Title</dt>
              <dd>{page.title ?? 'none'}</dd>
              <dt>Meta description</dt>
              <dd>{page.metaDescription ?? 'none'}</dd>
              <dt>H1</dt>
              <dd>{page.h1 ?? 'none'}</dd>
              <dt>Canonical</dt>
              <dd>{page.canonical ?? 'none'}</dd>
              <dt>Indexable</dt>
              <dd>{page.indexable ? 'yes' : 'no'}</dd>
              <dt>In sitemap</dt>
              <dd>{page.inSitemap ? 'yes' : 'no'}</dd>
              <dt>Depth</dt>
              <dd>{page.depth}</dd>
              <dt>Links</dt>
              <dd>
                {page.inlinks} in · {page.outlinks} out
              </dd>
            </dl>
          </div>
          <div class="card">
            <h3>Raw vs rendered</h3>
            <dl class="kv">
              <dt>Words in raw HTML</dt>
              <dd>{page.wordCount}</dd>
              <dt>Words after JavaScript</dt>
              <dd>{page.renderedWordCount ?? 'not rendered'}</dd>
              <dt>Visible to AI crawlers</dt>
              <dd>
                {page.renderedWordCount && page.renderedWordCount > 0
                  ? pct(Math.min(1, page.wordCount / page.renderedWordCount))
                  : '-'}
                <small>
                  {' '}
                  of the rendered text is in the raw HTML (most AI crawlers do not run JavaScript)
                </small>
              </dd>
              <dt>Size</dt>
              <dd>{Math.round(page.bytes / 1024)} KB</dd>
              <dt>Time to first byte</dt>
              <dd>{page.ttfbMs} ms</dd>
              <dt>Structured data</dt>
              <dd>
                {page.schemaTypes.length ? page.schemaTypes.map((t) => <Badge>{t}</Badge>) : 'none'}
              </dd>
            </dl>
          </div>
        </div>
        <h2>Issues on this page ({issues.length})</h2>
        {issues.length ? (
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Issue</th>
                  <th>Detail</th>
                  <th>Fix</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((i) => {
                  const def = result.checks[i.checkId];
                  const fix = fixes.get(i.checkId);
                  return (
                    <tr>
                      <td>
                        <SevBadge sev={i.severity ?? def?.severity ?? 'info'} />
                      </td>
                      <td>
                        <a
                          href={`${siteHref(site.id, 'issues')}?check=${encodeURIComponent(i.checkId)}`}
                        >
                          {def?.title ?? i.checkId}
                        </a>
                      </td>
                      <td>
                        {i.message}
                        {i.evidence ? (
                          <div>
                            <code>{i.evidence.slice(0, 300)}</code>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {fix ? (
                          <CopyButton text={fix.agentPrompt} label="Copy agent prompt" />
                        ) : (
                          <small>{def?.fix}</small>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No issues on this page.</Empty>
        )}
      </Layout>,
    );
  });

  // ---------------------------------------------------------------- exports
  app.get('/a/:auditId/export/:format', async (c) => {
    const store = getStore();
    const result = store.getAudit(c.req.param('auditId'));
    if (!result) return c.notFound();
    const fmt = c.req.param('format') as Format | 'csv-pages' | 'csv-issues' | 'csv-extract';
    const base = fmt.startsWith('csv') ? 'csv' : fmt;
    if (!(FORMATS as readonly string[]).includes(base)) return c.notFound();
    let prev: AuditResult | null = null;
    try {
      prev = previousAudit(result);
    } catch {
      prev = null;
    }
    const [r] = renderReport(result, base as Format, {
      diff: prev ? diff(prev, result) : undefined,
      csv: fmt === 'csv-pages' ? 'pages' : fmt === 'csv-extract' ? 'extract' : 'issues',
    });
    if (base === 'pdf') {
      const pdf = await reportPdf(String(r.body));
      if (!pdf.ok) return c.text(`PDF export failed: ${pdf.error}`, 500);
      return c.body(new Uint8Array(pdf.pdf), 200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${r.filename.replace(/\.html$/, '.pdf')}"`,
      });
    }
    const inline = c.req.query('view') === '1' && base === 'html';
    const body = typeof r.body === 'string' ? r.body : new Uint8Array(r.body);
    return c.body(body, 200, {
      'Content-Type': r.contentType,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${r.filename}"`,
    });
  });
}

export function ExportLinks({ result }: { result: AuditResult }) {
  const href = (f: string) => `/a/${encodeURIComponent(result.id)}/export/${f}`;
  return (
    <div class="card" style="margin-top:16px">
      <h3>Export this audit</h3>
      <div class="row">
        <a class="btn small" href={`${href('html')}?view=1`} target="_blank" rel="noopener">
          View HTML report
        </a>
        <a class="btn small" href={href('html')}>
          HTML
        </a>
        <a class="btn small" href={href('md')}>
          Markdown
        </a>
        <a class="btn small" href={href('csv-issues')}>
          CSV issues
        </a>
        <a class="btn small" href={href('csv-pages')}>
          CSV pages
        </a>
        <a class="btn small" href={href('json')}>
          JSON
        </a>
        <a class="btn small" href={href('sarif')}>
          SARIF
        </a>
        <a class="btn small" href={href('xlsx')}>
          Excel
        </a>
        <a class="btn small" href={href('pdf')}>
          PDF
        </a>
        {result.pages.some((p) => p.extracted) ? (
          <a class="btn small" href={href('csv-extract')}>
            CSV extraction
          </a>
        ) : null}
      </div>
    </div>
  );
}

export { errMsg };
