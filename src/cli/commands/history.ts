import { relative } from 'node:path';
import { renderDiffMarkdown } from '../../report/index.js';
import { c, fmtScore, ok, table } from '../output.js';
import { ExitError } from '../errors.js';
import { openPath } from '../open.js';
import {
  allSites,
  diff,
  findAudit,
  getConfig,
  getStore,
  parseFormats,
  previousAudit,
  removeUserSite,
  resolveSite,
  toUrl,
  upsertUserSite,
  writeReports,
} from '../services.js';
import { siteIdFromUrl } from '../../core/config.js';

export async function cmdHistory(
  site: string | undefined,
  opts: { limit: number; json?: boolean },
): Promise<void> {
  const config = getConfig();
  const store = getStore(config);
  const sites = site ? [resolveSite(site, config)] : allSites(config);
  const out: Record<string, unknown> = {};
  for (const s of sites) {
    const audits = store.listAudits(s.id, opts.limit);
    const runs = store.listVisibility(s.id, opts.limit);
    out[s.id] = { audits, visibility: runs };
    if (opts.json) continue;
    console.log('\n' + c.bold(s.id) + c.dim(`  ${s.url}`));
    if (!audits.length) console.log(c.dim('  No audits yet. Run `avc audit ' + s.id + '`.'));
    else
      console.log(
        table(
          audits.map((a, i) => {
            const prev = audits[i + 1];
            const delta = prev ? a.score - prev.score : 0;
            return [
              c.cyan(a.id),
              new Date(a.at).toLocaleString('en-GB'),
              fmtScore(a.score) + ' ' + a.grade,
              prev
                ? delta > 0
                  ? c.green(`+${delta}`)
                  : delta < 0
                    ? c.red(String(delta))
                    : c.dim('±0')
                : '',
              `${a.pages} pages`,
              `${a.issues} issues`,
              a.readinessOnly ? c.dim('readiness') : 'with AI',
            ];
          }),
          { header: ['audit', 'when', 'score', 'Δ', 'pages', 'issues', ''] },
        ),
      );
    if (runs.length) {
      console.log(c.dim('  AI visibility runs'));
      console.log(
        table(
          runs.map((r) => [
            c.cyan(r.id),
            new Date(r.at).toLocaleString('en-GB'),
            `${Math.round(r.mentionRate * 100)}% named`,
            `${Math.round(r.shareOfVoice * 100)}% share of voice`,
            `${r.answers} answers`,
            `$${r.costUsd.toFixed(2)}`,
          ]),
        ),
      );
    }
  }
  if (opts.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  else if (!sites.length) console.log(c.dim('No sites yet. Run `avc init` or `avc audit <url>`.'));
}

export async function cmdDiff(
  a: string | undefined,
  b: string | undefined,
  opts: { json?: boolean; md?: boolean },
): Promise<void> {
  const config = getConfig();
  const store = getStore(config);
  let older = a ? store.getAudit(a) : null;
  let newer = b ? findAudit(b, config) : null;
  if (!older) {
    // `a` is a site (or nothing): compare its last two audits.
    const latest = findAudit(a, config);
    if (!latest) throw new ExitError(1, a ? `No audits found for "${a}".` : 'No audits yet.');
    newer = newer ?? latest;
    older = previousAudit(newer, config);
    if (!older)
      throw new ExitError(
        1,
        `Only one audit for ${siteIdFromUrl(newer.site)}. Run another to compare.`,
      );
  } else if (!newer) {
    newer = store.latestAudit(siteIdFromUrl(older.startUrl || older.site));
    if (!newer || newer.id === older.id) throw new ExitError(1, 'Pass the newer audit id too.');
  }
  const d = diff(older, newer);
  if (opts.json) {
    process.stdout.write(JSON.stringify(d, null, 2) + '\n');
    return;
  }
  if (opts.md) {
    process.stdout.write(renderDiffMarkdown(d, { prev: older, next: newer }) + '\n');
    return;
  }
  const sign =
    d.scoreDelta > 0
      ? c.green(`+${d.scoreDelta}`)
      : d.scoreDelta < 0
        ? c.red(String(d.scoreDelta))
        : c.dim('±0');
  console.log(
    `${c.bold('Score')} ${older.score.overall} → ${fmtScore(newer.score.overall)} (${sign})  ${c.dim(`${d.from} → ${d.to}`)}`,
  );
  for (const p of d.pillarDeltas.filter((x) => x.delta !== 0))
    console.log(
      `  ${p.pillar.padEnd(14)} ${p.delta > 0 ? c.green(`+${p.delta}`) : c.red(String(p.delta))}`,
    );
  const list = (
    title: string,
    items: { checkId: string; url?: string; message: string }[],
    colour: (s: string) => string,
  ) => {
    if (!items.length) return;
    console.log('\n' + c.bold(`${title} (${items.length})`));
    for (const i of items.slice(0, 25))
      console.log(
        `  ${colour('•')} ${newer!.checks[i.checkId]?.title ?? i.checkId}${i.url ? c.dim(' ' + i.url) : ''}`,
      );
    if (items.length > 25) console.log(c.dim(`  …and ${items.length - 25} more (use --json)`));
  };
  list('New issues', d.newIssues, c.red);
  list('Fixed', d.fixedIssues, c.green);
  if (d.newPages.length) console.log(`\n${c.bold('New pages')} ${d.newPages.length}`);
  if (d.removedPages.length) console.log(`${c.bold('Removed pages')} ${d.removedPages.length}`);
  if (d.changedPages.length) console.log(`${c.bold('Changed pages')} ${d.changedPages.length}`);
  if (d.visibility) {
    const v = d.visibility;
    console.log(
      `\n${c.bold('AI visibility')} mention rate ${v.mentionRateDelta >= 0 ? '+' : ''}${Math.round(v.mentionRateDelta * 100)} pts, share of voice ${v.shareOfVoiceDelta >= 0 ? '+' : ''}${Math.round(v.shareOfVoiceDelta * 100)} pts`,
    );
    if (v.wonPrompts.length) console.log(`  ${c.green('won')} ${v.wonPrompts.join(' · ')}`);
    if (v.lostPrompts.length) console.log(`  ${c.red('lost')} ${v.lostPrompts.join(' · ')}`);
    if (v.newCompetitors.length)
      console.log(`  new competitors named: ${v.newCompetitors.join(', ')}`);
  }
}

export async function cmdReport(
  ref: string,
  opts: { format: string; out: string; open?: boolean },
): Promise<void> {
  const config = getConfig();
  const result = findAudit(ref, config);
  if (!result) throw new ExitError(1, `No audit found for "${ref}". See \`avc history\`.`);
  const prev = previousAudit(result, config);
  const files = await writeReports(
    result,
    parseFormats(opts.format, ['html']),
    opts.out,
    { diff: prev ? diff(prev, result) : undefined },
    (m) => console.error(m),
  );
  for (const f of files) ok(relative(process.cwd(), f) || f);
  const html = files.find((f) => f.endsWith('.html'));
  if (opts.open && html) openPath(html);
}

export async function cmdSites(opts: { json?: boolean }): Promise<void> {
  const sites = allSites(getConfig());
  if (opts.json) {
    process.stdout.write(JSON.stringify(sites, null, 2) + '\n');
    return;
  }
  if (!sites.length) {
    console.log(c.dim('No sites yet. Run `avc init` or `avc sites add <url>`.'));
    return;
  }
  console.log(
    table(
      sites.map((s) => [
        c.cyan(s.id),
        s.url,
        s.configured ? 'configured' : c.dim('history only'),
        s.lastAuditAt ? new Date(s.lastAuditAt).toLocaleString('en-GB') : c.dim('never audited'),
        s.schedule?.audit ? `audit ${s.schedule.audit}` : '',
      ]),
      { header: ['site', 'url', '', 'last audit', 'schedule'] },
    ),
  );
}

export async function cmdSitesAdd(url: string, opts: { name?: string }): Promise<void> {
  const u = toUrl(url);
  const id = siteIdFromUrl(u);
  upsertUserSite({ id, url: u, ...(opts.name ? { brand: { name: opts.name } } : {}) });
  ok(`Added ${id}. Run \`avc audit ${id}\`.`);
}

export async function cmdSitesRemove(id: string, opts: { purge?: boolean }): Promise<void> {
  removeUserSite(id);
  if (opts.purge) getStore().deleteSite(id);
  ok(`Removed ${id}${opts.purge ? ' and its history' : ''}.`);
}
