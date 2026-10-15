import type { Hono } from 'hono';
import { secretStore } from '../../core/secrets.js';
import type { AvcConfig } from '../../core/config.js';
import { userConfigPath } from '../../core/config.js';
import type { Alert } from '../../monitor/alerts.js';
import {
  applyFixesFor,
  diff,
  errMsg,
  getConfig,
  getStore,
  listChecks,
  monthSpend,
  patchSiteConnections,
  patchUserConfig,
  planFixes,
  rollbackSnapshot,
  snapshots,
  upsertUserSite,
  type ApplyReport,
  type FixTarget,
} from '../../cli/services.js';
import { back, form, str, type Deps, type ServerEnv } from '../app.js';
import {
  Badge,
  CopyButton,
  Empty,
  fmtDate,
  Layout,
  PILLAR_LABEL,
  SevBadge,
  siteHref,
} from '../ui.js';
import { auditFor, findSite, NoAudit } from './site.js';

function ApplyResult({ report, preview }: { report: ApplyReport; preview: boolean }) {
  const changes = report.changes ?? [];
  const snap = report.snapshotFile ?? report.snapshot;
  return (
    <div class="card">
      <h3>
        {preview ? `Preview: ${changes.length} change(s)` : `Applied ${changes.length} change(s)`}
      </h3>
      {changes.length === 0 ? <p class="muted">Nothing to change for this target.</p> : null}
      {changes.map((ch) => (
        <div style="margin-bottom:12px">
          <strong>{ch.title ?? ch.description ?? ch.checkId}</strong>{' '}
          <small>{ch.file ?? ch.url ?? ''}</small>
          {ch.error ? (
            <span class="c-bad"> failed: {ch.error}</span>
          ) : ch.status ? (
            <small> {ch.status}</small>
          ) : null}
          {ch.diff ? (
            <pre>
              {ch.diff.split('\n').map((l) => (
                <span class={l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : ''}>
                  {l}
                  {'\n'}
                </span>
              ))}
            </pre>
          ) : ch.before !== undefined || ch.after !== undefined ? (
            <pre>
              <span class="diff-del">- {JSON.stringify(ch.before)}</span>
              {'\n'}
              <span class="diff-add">+ {JSON.stringify(ch.after)}</span>
            </pre>
          ) : null}
        </div>
      ))}
      {(report.skipped ?? []).length ? (
        <details>
          <summary>{report.skipped!.length} skipped</summary>
          <ul>
            {report.skipped!.map((s) => (
              <li>
                <code>{s.checkId}</code> {s.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {(report.errors ?? []).map((e) => (
        <p class="notice error">{e}</p>
      ))}
      {!preview && snap ? (
        <p class="notice ok">
          Rollback snapshot saved: <code>{snap}</code>
        </p>
      ) : null}
    </div>
  );
}

function maskSet(v: string | undefined): string {
  return v ? 'set' : 'not set';
}

export function registerOpsPages(app: Hono<ServerEnv>, deps: Deps) {
  void deps;
  // ---------------------------------------------------------------- fixes
  app.get('/s/:id/fixes', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    if (!result)
      return c.html(
        <Layout title="Fixes" siteId={site.id} siteUrl={site.url} active="fixes">
          <NoAudit site={site} />
        </Layout>,
      );
    let fixes: ReturnType<typeof planFixes> = [];
    let error = '';
    try {
      fixes = planFixes(result);
    } catch (e) {
      error = errMsg(e);
    }
    const rank = new Map(result.priorities.map((p, i) => [p.checkId, i]));
    fixes.sort((a, b) => (rank.get(a.checkId) ?? 999) - (rank.get(b.checkId) ?? 999));
    const auto = fixes.filter((f) => f.autoApplicable);
    const wp = site.connections?.wordpress;
    const repo = site.connections?.repoPath;
    return c.html(
      <Layout
        title="Fixes"
        siteId={site.id}
        siteUrl={site.url}
        active="fixes"
        flash={c.get('flash')}
      >
        {error ? <p class="notice error">{error}</p> : null}
        <p class="muted">
          {fixes.length} fixes for this {result.stack.id} site. {auto.length} can be applied
          automatically. Every change is previewed first; WordPress changes save a rollback
          snapshot.
        </p>
        <div class="grid grid-2">
          {(['wordpress', 'repo'] as FixTarget[]).map((t) => {
            const ready = t === 'wordpress' ? Boolean(wp) : Boolean(repo);
            return (
              <form method="post" action={siteHref(site.id, 'fixes/preview')} class="card">
                <h3>{t === 'wordpress' ? 'Apply to WordPress' : 'Patch a local repo'}</h3>
                <p class="muted">
                  {t === 'wordpress'
                    ? wp
                      ? `${wp.url} as ${wp.user}`
                      : 'Not connected.'
                    : repo
                      ? repo
                      : 'No repo path set.'}
                </p>
                <input type="hidden" name="target" value={t} />
                {ready ? (
                  <button class="btn primary" type="submit">
                    Preview changes (dry run)
                  </button>
                ) : (
                  <a class="btn" href={siteHref(site.id, 'connections')}>
                    Connect {t === 'wordpress' ? 'WordPress' : 'a repo'}
                  </a>
                )}
              </form>
            );
          })}
        </div>
        <div class="card" style="margin-top:16px">
          <h3>Roll back an applied change</h3>
          <form
            method="post"
            action="/rollback"
            class="filters"
            data-confirm="Restore the values saved in this snapshot?"
          >
            <input type="hidden" name="site" value={site.id} />
            <div class="field" style="flex:1 1 360px">
              <label for="snap">Snapshot file</label>
              <input
                id="snap"
                name="file"
                type="text"
                list="snap-list"
                placeholder="Pick or paste a snapshot path"
              />
              <datalist id="snap-list">
                {snapshots(getConfig(), site.id).map((f) => (
                  <option value={f} />
                ))}
              </datalist>
            </div>
            <button class="btn danger" type="submit">
              Roll back
            </button>
          </form>
        </div>
        <h2>The plan</h2>
        {fixes.map((f, i) => {
          const def = result.checks[f.checkId];
          return (
            <details class="issue">
              <summary>
                <SevBadge sev={def?.severity ?? 'info'} />
                <span class="issue-title">{f.title}</span>
                <Badge>{f.tier}</Badge>
                {f.autoApplicable ? <Badge cls="v-ok">auto</Badge> : null}
                <small>
                  {f.effort} · {f.impact} impact
                </small>
              </summary>
              <div class="body">
                <ol class="steps" style="margin-top:12px">
                  {f.steps.map((s) => (
                    <li>{s}</li>
                  ))}
                </ol>
                {f.files.length ? (
                  <p>
                    Files:{' '}
                    {f.files.map((x) => (
                      <code style="margin-right:6px">{x}</code>
                    ))}
                  </p>
                ) : null}
                {f.snippet ? (
                  <>
                    <CopyButton target={`#fx-${i}`} label="Copy snippet" />
                    <pre id={`fx-${i}`}>{f.snippet.code}</pre>
                  </>
                ) : null}
                <CopyButton text={f.agentPrompt} label="Copy prompt for Claude Code / Cursor" />
              </div>
            </details>
          );
        })}
        {!fixes.length && !error ? <Empty>Nothing to fix. Nice.</Empty> : null}
      </Layout>,
    );
  });

  app.post('/s/:id/fixes/preview', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const result = auditFor(c, site.id);
    if (!result) return c.notFound();
    const f = await form(c);
    const target = str(f.target) as FixTarget;
    let report: ApplyReport;
    try {
      report = await applyFixesFor({ result, site, target, dryRun: true });
    } catch (e) {
      return back(c, siteHref(site.id, 'fixes'), `Preview failed: ${errMsg(e)}`, 'error');
    }
    return c.html(
      <Layout title="Preview fixes" siteId={site.id} siteUrl={site.url} active="fixes">
        <ApplyResult report={report} preview />
        {(report.changes ?? []).length ? (
          <form
            method="post"
            action={siteHref(site.id, 'fixes/apply')}
            class="card"
            data-confirm={`Apply these changes to ${target === 'wordpress' ? 'your live WordPress site' : 'the repo'}?`}
          >
            <input type="hidden" name="target" value={target} />
            <input type="hidden" name="audit" value={result.id} />
            <label class="check">
              <input type="checkbox" name="confirm" required /> Apply these {report.changes!.length}{' '}
              changes
            </label>
            <div>
              <button class="btn primary" type="submit">
                Apply
              </button>{' '}
              <a class="btn ghost" href={siteHref(site.id, 'fixes')}>
                Cancel
              </a>
            </div>
          </form>
        ) : null}
      </Layout>,
    );
  });

  app.post('/s/:id/fixes/apply', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const f = await form(c);
    if (str(f.confirm) !== 'on')
      return back(
        c,
        siteHref(site.id, 'fixes'),
        'Not applied: the confirm box was not ticked.',
        'warn',
      );
    const result =
      (str(f.audit) && getStore().getAudit(str(f.audit))) || getStore().latestAudit(site.id);
    if (!result) return c.notFound();
    let report: ApplyReport;
    try {
      report = await applyFixesFor({
        result,
        site,
        target: str(f.target) as FixTarget,
        dryRun: false,
      });
    } catch (e) {
      return back(c, siteHref(site.id, 'fixes'), `Apply failed: ${errMsg(e)}`, 'error');
    }
    return c.html(
      <Layout title="Fixes applied" siteId={site.id} siteUrl={site.url} active="fixes">
        <ApplyResult report={report} preview={false} />
        <a class="btn primary" href={siteHref(site.id, 'run')}>
          Re-audit to confirm
        </a>
      </Layout>,
    );
  });

  app.post('/rollback', async (c) => {
    const f = await form(c);
    const siteId = str(f.site);
    const path = siteId ? siteHref(siteId, 'fixes') : '/';
    try {
      await rollbackSnapshot(str(f.file));
      return back(c, path, 'Rolled back.');
    } catch (e) {
      return back(c, path, `Rollback failed: ${errMsg(e)}`, 'error');
    }
  });

  // ---------------------------------------------------------------- connections
  app.get('/s/:id/connections', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const test = c.req.query('test') === '1';
    const config = getConfig();
    let rows: {
      id: string;
      label: string;
      configured: boolean;
      ok: boolean | null;
      detail: string;
      help?: string;
    }[] = [];
    try {
      const { connectionStatus } = await import('../../connect/index.js');
      rows = await connectionStatus(site, config, { test });
    } catch (e) {
      rows = [
        { id: 'error', label: 'Connections', configured: false, ok: false, detail: errMsg(e) },
      ];
    }
    const conn = site.connections ?? {};
    return c.html(
      <Layout
        title="Connections"
        siteId={site.id}
        siteUrl={site.url}
        active="connections"
        flash={c.get('flash')}
        actions={
          <a class="btn" href={`${siteHref(site.id, 'connections')}?test=1`}>
            Test all
          </a>
        }
      >
        <p class="muted">
          Each connection is optional and adds data the audit can use. Secrets are saved in{' '}
          {userConfigPath()} (mode 600). Setup steps: docs/CONNECTIONS.md.
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>
                  <td>{r.label}</td>
                  <td>
                    {r.ok === true ? (
                      <Badge cls="v-ok">works</Badge>
                    ) : r.ok === false ? (
                      <Badge cls="v-error">failing</Badge>
                    ) : r.configured ? (
                      <Badge cls="v-differs">set, not tested</Badge>
                    ) : (
                      <Badge>not set</Badge>
                    )}
                  </td>
                  <td>
                    {r.detail}
                    {r.help ? (
                      <div>
                        <small>{r.help}</small>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div class="grid grid-2" style="margin-top:16px">
          <form method="post" action="/connect/google" class="card">
            <h3>Google (Search Console, GA4)</h3>
            <p class="muted">
              Use an OAuth client of type "Desktop app", or a service-account key file added as a
              user on your properties.
            </p>
            <input type="hidden" name="site" value={site.id} />
            <div class="field">
              <label for="g-id">OAuth client id</label>
              <input id="g-id" name="clientId" type="text" value={config.google?.clientId ?? ''} />
            </div>
            <div class="field">
              <label for="g-secret">
                OAuth client secret ({maskSet(config.google?.clientSecret)})
              </label>
              <input id="g-secret" name="clientSecret" type="password" autocomplete="off" />
            </div>
            <div class="field">
              <label for="g-sa">Or service-account key file path</label>
              <input
                id="g-sa"
                name="serviceAccountFile"
                type="text"
                value={config.google?.serviceAccountFile ?? ''}
              />
            </div>
            <button class="btn primary" type="submit">
              Save and sign in with Google
            </button>
            <p class="muted" style="margin-top:8px">
              Sign-in opens in your browser and returns to a one-time local address.
            </p>
          </form>

          <form method="post" action={siteHref(site.id, 'connections')} class="card">
            <h3>Properties</h3>
            <div class="field">
              <label for="gsc">Search Console property</label>
              <input
                id="gsc"
                name="gscProperty"
                type="text"
                value={conn.gscProperty ?? ''}
                placeholder="sc-domain:example.com (empty = pick automatically)"
              />
            </div>
            <div class="field">
              <label for="ga4">GA4 property</label>
              <input
                id="ga4"
                name="ga4Property"
                type="text"
                value={conn.ga4Property ?? ''}
                placeholder="properties/123456789"
              />
            </div>
            <div class="field">
              <label for="psi">PageSpeed Insights API key ({maskSet(config.google?.psiKey)})</label>
              <input id="psi" name="psiKey" type="password" autocomplete="off" />
            </div>
            <div class="field">
              <label for="bing">Bing Webmaster API key ({maskSet(config.bing?.apiKey)})</label>
              <input id="bing" name="bingKey" type="password" autocomplete="off" />
            </div>
            <div class="field">
              <label for="logs">Access log paths or globs (one per line)</label>
              <textarea id="logs" name="logs" style="min-height:60px">
                {(conn.logs ?? []).join('\n')}
              </textarea>
            </div>
            <div class="field">
              <label for="repo">Local repo path (for patches)</label>
              <input id="repo" name="repoPath" type="text" value={conn.repoPath ?? ''} />
            </div>
            <fieldset>
              <legend>WordPress (application password, for auto-fixes)</legend>
              <div class="field">
                <label for="wp-url">URL</label>
                <input id="wp-url" name="wpUrl" type="url" value={conn.wordpress?.url ?? ''} />
              </div>
              <div class="field">
                <label for="wp-user">User</label>
                <input id="wp-user" name="wpUser" type="text" value={conn.wordpress?.user ?? ''} />
              </div>
              <div class="field">
                <label for="wp-pass">
                  Application password ({maskSet(conn.wordpress?.appPassword)})
                </label>
                <input id="wp-pass" name="wpAppPassword" type="password" autocomplete="off" />
                <div class="hint">
                  WordPress → Users → Profile → Application Passwords. Or set AVC_WP_APP_PASSWORD.
                </div>
              </div>
            </fieldset>
            <button class="btn primary" type="submit">
              Save and test
            </button>
          </form>
        </div>
      </Layout>,
    );
  });

  app.post('/s/:id/connections', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const f = await form(c);
    if (!site.configured) upsertUserSite({ id: site.id, url: site.url });
    const wpUrl = str(f.wpUrl);
    const wpUser = str(f.wpUser);
    const pass = str(f.wpAppPassword) || site.connections?.wordpress?.appPassword;
    patchSiteConnections(site.id, {
      gscProperty: str(f.gscProperty),
      ga4Property: str(f.ga4Property),
      logs: str(f.logs)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      repoPath: str(f.repoPath),
      wordpress:
        wpUrl && wpUser
          ? { url: wpUrl, user: wpUser, ...(pass ? { appPassword: pass } : {}) }
          : undefined,
    });
    if (str(f.psiKey)) patchUserConfig('google', { psiKey: str(f.psiKey) });
    if (str(f.bingKey)) patchUserConfig('bing', { apiKey: str(f.bingKey) });
    return c.redirect(
      `${siteHref(site.id, 'connections')}?test=1&msg=${encodeURIComponent('Saved. Tested below.')}&kind=ok`,
      303,
    );
  });

  app.post('/connect/google', async (c) => {
    const f = await form(c);
    const siteId = str(f.site);
    const path = siteId ? siteHref(siteId, 'connections') : '/settings';
    const patch: Partial<NonNullable<AvcConfig['google']>> = {};
    if (str(f.clientId)) patch.clientId = str(f.clientId);
    if (str(f.clientSecret)) patch.clientSecret = str(f.clientSecret);
    patch.serviceAccountFile = str(f.serviceAccountFile);
    patchUserConfig('google', patch);
    const config = getConfig(true);
    if (config.google?.serviceAccountFile)
      return c.redirect(
        `${path}?test=1&msg=${encodeURIComponent('Saved the service-account key path.')}&kind=ok`,
        303,
      );
    if (!config.google?.clientId)
      return back(c, path, 'Add an OAuth client id first (see docs/CONNECTIONS.md).', 'warn');
    const { googleLogin } = await import('../../connect/index.js');
    // Runs in the background: it opens the consent page and waits for Google's redirect.
    googleLogin(config).then(
      () => console.log('Google sign-in complete.'),
      (e: unknown) => console.error(`Google sign-in failed: ${errMsg(e)}`),
    );
    return back(
      c,
      path,
      'A Google sign-in page is opening in your browser. When it says you are signed in, click "Test all".',
      'info',
    );
  });

  // ---------------------------------------------------------------- history & diff
  app.get('/s/:id/history', (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const store = getStore();
    const audits = store.listAudits(site.id, 100);
    const a = c.req.query('a');
    const b = c.req.query('b');
    let diffView = null;
    if (a && b) {
      const older = store.getAudit(a);
      const newer = store.getAudit(b);
      if (older && newer) {
        const [x, y] = older.at <= newer.at ? [older, newer] : [newer, older];
        const d = diff(x, y);
        diffView = (
          <div class="card">
            <h3>
              {fmtDate(x.at)} → {fmtDate(y.at)}
            </h3>
            <p>
              Score {x.score.overall} → {y.score.overall}{' '}
              <strong class={d.scoreDelta > 0 ? 'c-good' : d.scoreDelta < 0 ? 'c-bad' : ''}>
                ({d.scoreDelta > 0 ? '+' : ''}
                {d.scoreDelta})
              </strong>
            </p>
            <p>
              {d.pillarDeltas
                .filter((p) => p.delta)
                .map((p) => (
                  <Badge cls={p.delta > 0 ? 's-good' : 's-bad'}>
                    {PILLAR_LABEL[p.pillar]} {p.delta > 0 ? '+' : ''}
                    {p.delta}
                  </Badge>
                ))}
            </p>
            <div class="grid grid-2">
              <div>
                <h4>New issues ({d.newIssues.length})</h4>
                <ul class="urls">
                  {d.newIssues.slice(0, 200).map((i) => (
                    <li>
                      {y.checks[i.checkId]?.title ?? i.checkId} <small>{i.url ?? ''}</small>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h4>Fixed ({d.fixedIssues.length})</h4>
                <ul class="urls">
                  {d.fixedIssues.slice(0, 200).map((i) => (
                    <li>
                      {x.checks[i.checkId]?.title ?? i.checkId} <small>{i.url ?? ''}</small>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p>
              {d.newPages.length} new pages · {d.removedPages.length} removed ·{' '}
              {d.changedPages.length} changed
            </p>
            {d.visibility ? (
              <p>
                AI mention rate {d.visibility.mentionRateDelta >= 0 ? '+' : ''}
                {Math.round(d.visibility.mentionRateDelta * 100)} pts · won{' '}
                {d.visibility.wonPrompts.length} prompts · lost {d.visibility.lostPrompts.length}
              </p>
            ) : null}
          </div>
        );
      }
    }
    const sched = store.getSchedule(site.id);
    return c.html(
      <Layout
        title="History & diff"
        siteId={site.id}
        siteUrl={site.url}
        active="history"
        flash={c.get('flash')}
      >
        {diffView}
        {audits.length ? (
          <form method="get" class="card" style="margin-top:16px">
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>From</th>
                    <th>To</th>
                    <th>When</th>
                    <th class="num">Score</th>
                    <th class="num">Pages</th>
                    <th class="num">Issues</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {audits.map((r, i) => (
                    <tr>
                      <td>
                        <input
                          type="radio"
                          name="a"
                          value={r.id}
                          aria-label={`Compare from ${r.id}`}
                          checked={a ? a === r.id : i === 1}
                        />
                      </td>
                      <td>
                        <input
                          type="radio"
                          name="b"
                          value={r.id}
                          aria-label={`Compare to ${r.id}`}
                          checked={b ? b === r.id : i === 0}
                        />
                      </td>
                      <td>
                        <a href={`${siteHref(site.id)}?audit=${r.id}`}>{fmtDate(r.at)}</a>
                      </td>
                      <td class="num">
                        {r.score} {r.grade}
                      </td>
                      <td class="num">{r.pages}</td>
                      <td class="num">{r.issues}</td>
                      <td>{r.readinessOnly ? <small>readiness</small> : <Badge>with AI</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              class="btn primary"
              type="submit"
              style="margin-top:12px"
              disabled={audits.length < 2}
            >
              Compare
            </button>
          </form>
        ) : (
          <NoAudit site={site} />
        )}
        <form
          method="post"
          action={siteHref(site.id, 'schedule')}
          class="card"
          style="margin-top:16px"
        >
          <h3>Schedule</h3>
          <p class="muted">
            Cron expressions (minute hour day month weekday). Runs while `avc monitor` or `avc ui
            --monitor` is running, or from your system scheduler (`avc schedule {site.id}` prints
            the line).
          </p>
          <div class="grid grid-2">
            <div class="field">
              <label for="cron-a">Audit</label>
              <input
                id="cron-a"
                name="audit"
                type="text"
                value={site.schedule?.audit ?? sched?.auditCron ?? ''}
                placeholder="0 6 * * 1  (Mondays 06:00)"
              />
            </div>
            <div class="field">
              <label for="cron-v">AI visibility</label>
              <input
                id="cron-v"
                name="visibility"
                type="text"
                value={site.schedule?.visibility ?? sched?.visibilityCron ?? ''}
                placeholder="0 7 1 * *  (1st of the month)"
              />
            </div>
          </div>
          <button class="btn" type="submit">
            Save schedule
          </button>
        </form>
      </Layout>,
    );
  });

  app.post('/s/:id/schedule', async (c) => {
    const site = findSite(c.req.param('id'));
    if (!site) return c.notFound();
    const f = await form(c);
    const audit = str(f.audit);
    const vis = str(f.visibility);
    for (const cron of [audit, vis])
      if (cron && cron.split(/\s+/).length !== 5)
        return back(
          c,
          siteHref(site.id, 'history'),
          `"${cron}" is not a 5-field cron expression.`,
          'error',
        );
    const schedule = { ...(audit ? { audit } : {}), ...(vis ? { visibility: vis } : {}) };
    upsertUserSite({ ...site, schedule });
    getStore().setSchedule(site.id, { audit: audit || null, visibility: vis || null });
    return back(c, siteHref(site.id, 'history'), 'Schedule saved.');
  });

  // ---------------------------------------------------------------- settings
  app.get('/settings', async (c) => {
    const config = getConfig();
    const { engineStatus } = await import('../../ai/engines.js');
    const status = engineStatus(config);
    return c.html(
      <Layout title="Settings" active="settings" flash={c.get('flash')}>
        <form method="post" action="/settings" class="stack">
          <div class="card">
            <h2>AI engines</h2>
            <p class="muted">
              Add, test or remove API keys on the <a href="/keys">API keys</a> page. They are saved
              in {secretStore().where}, on this computer only.
            </p>
            <label class="check">
              <input type="checkbox" name="mock" checked={Boolean(config.ai.mock)} /> Mock mode:
              sample answers, no spend
            </label>
            <h3 style="margin-top:16px">Engines</h3>
            <ul>
              {status.map((s) => (
                <li>
                  {s.available ? <Badge cls="v-ok">{s.via}</Badge> : <Badge>off</Badge>} {s.label}{' '}
                  <small>{s.available ? s.model : s.note}</small>
                </li>
              ))}
            </ul>
          </div>
          <div class="card">
            <h2>Spend caps</h2>
            <div class="grid grid-2">
              <div class="field">
                <label for="maxRunUsd">Per run (USD)</label>
                <input
                  id="maxRunUsd"
                  name="maxRunUsd"
                  type="number"
                  min="0"
                  step="0.5"
                  value={String(config.ai.maxRunUsd)}
                />
              </div>
              <div class="field">
                <label for="maxMonthUsd">Per calendar month (USD)</label>
                <input
                  id="maxMonthUsd"
                  name="maxMonthUsd"
                  type="number"
                  min="0"
                  step="1"
                  value={String(config.ai.maxMonthUsd)}
                />
              </div>
            </div>
            <p class="muted">
              Spent this month (estimate): ${monthSpend(config).toFixed(2)}. Your provider's
              dashboard is the actual bill.
            </p>
          </div>
          <div class="card">
            <h2>Alerts</h2>
            <div class="field">
              <label for="webhook">Webhook URL (Slack, Discord, Teams or any JSON endpoint)</label>
              <input
                id="webhook"
                name="webhookUrl"
                type="url"
                value={config.alerts?.webhookUrl ?? ''}
              />
            </div>
            <div class="grid grid-3">
              <div class="field">
                <label for="email-to">Email to</label>
                <input
                  id="email-to"
                  name="emailTo"
                  type="email"
                  value={config.alerts?.email?.to ?? ''}
                />
              </div>
              <div class="field">
                <label for="email-from">Email from</label>
                <input
                  id="email-from"
                  name="emailFrom"
                  type="text"
                  value={config.alerts?.email?.from ?? ''}
                />
              </div>
              <div class="field">
                <label for="smtp">SMTP URL ({maskSet(config.alerts?.email?.smtpUrl)})</label>
                <input
                  id="smtp"
                  name="smtpUrl"
                  type="password"
                  autocomplete="off"
                  placeholder="smtps://user:pass@smtp.example.com:465"
                />
              </div>
            </div>
          </div>
          <div class="row">
            <button class="btn primary" type="submit">
              Save settings
            </button>
            <button class="btn" type="submit" formaction="/settings/test-alert">
              Send a test alert
            </button>
          </div>
        </form>
        <p class="muted" style="margin-top:16px">
          Data folder: {config.dataDir}
        </p>
      </Layout>,
    );
  });

  app.post('/settings', async (c) => {
    const f = await form(c);
    const config = getConfig();
    // Keys are managed on the API keys page (/keys).
    const ai: Record<string, unknown> = {};
    ai.mock = str(f.mock) === 'on' ? true : '';
    const run = Number(str(f.maxRunUsd));
    const month = Number(str(f.maxMonthUsd));
    if (Number.isFinite(run) && run >= 0) ai.maxRunUsd = run;
    if (Number.isFinite(month) && month >= 0) ai.maxMonthUsd = month;
    patchUserConfig('ai', ai as Partial<AvcConfig['ai']>);
    const to = str(f.emailTo);
    patchUserConfig('alerts', {
      webhookUrl: str(f.webhookUrl),
      email: to
        ? {
            to,
            from: str(f.emailFrom) || undefined,
            smtpUrl: str(f.smtpUrl) || config.alerts?.email?.smtpUrl,
          }
        : undefined,
    } as Partial<NonNullable<AvcConfig['alerts']>>);
    return back(c, '/settings', 'Settings saved.');
  });

  app.post('/settings/test-alert', async (c) => {
    const config = getConfig();
    if (!config.alerts?.webhookUrl && !config.alerts?.email?.to)
      return back(c, '/settings', 'Save a webhook URL or email first.', 'warn');
    const { sendAlerts } = await import('../../monitor/alerts.js');
    const alert: Alert = {
      key: `test:${Date.now()}`,
      rule: 'score-drop',
      site: 'test',
      level: 'info',
      title: 'Test alert from AI Visibility Checker',
      detail: 'If you can read this, alerts reach you. No action needed.',
    };
    try {
      const r = await sendAlerts([alert], config, { dedupeHours: 0 });
      const failed = r.deliveries.filter((d) => !d.ok);
      if (failed.length)
        return back(
          c,
          '/settings',
          `Failed: ${failed.map((d) => `${d.channel}: ${d.error}`).join('; ')}`,
          'error',
        );
      return back(c, '/settings', `Sent via ${r.deliveries.map((d) => d.channel).join(' and ')}.`);
    } catch (e) {
      return back(c, '/settings', `Failed: ${errMsg(e)}`, 'error');
    }
  });

  // ---------------------------------------------------------------- checks catalogue
  app.get('/checks', (c) => {
    const defs = listChecks({ pillar: c.req.query('pillar') || undefined });
    return c.html(
      <Layout title={`All checks (${defs.length})`} active="checks">
        <div class="filters">
          <div class="field" style="flex:1 1 260px">
            <label for="ck-q">Find</label>
            <input
              id="ck-q"
              type="search"
              data-filter="#checks"
              placeholder="id, title, category"
            />
          </div>
        </div>
        <div class="table-wrap">
          <table id="checks" data-sortable>
            <thead>
              <tr>
                {['Id', 'Title', 'Pillar', 'Severity', 'Fix', 'Needs'].map((h) => (
                  <th>
                    <button class="sort" type="button">
                      {h}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {defs.map((d) => (
                <tr data-row>
                  <td>
                    <code>{d.id}</code>
                  </td>
                  <td>
                    {d.title}
                    <div>
                      <small>{d.why}</small>
                    </div>
                  </td>
                  <td>{PILLAR_LABEL[d.pillar] ?? d.pillar}</td>
                  <td>
                    <SevBadge sev={d.severity} />
                  </td>
                  <td>{d.fixTier}</td>
                  <td>
                    <small>{(d.requires ?? []).join(', ')}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Layout>,
    );
  });
}
