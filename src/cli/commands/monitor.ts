import { installSystemSchedule, runScheduledOnce, startScheduler } from '../../monitor/scheduler.js';
import type { ScheduledRunResult } from '../../monitor/scheduler.js';
import { c, fmtScore, ok, progressPrinter, warn } from '../output.js';
import { ExitError } from '../errors.js';
import { getConfig, getStore, resolveSite, upsertUserSite } from '../services.js';

export function describeRun(r: ScheduledRunResult): string {
  const when = new Date(r.finishedAt).toLocaleString();
  if (r.status === 'skipped') return `${c.dim(when)} ${r.siteId} ${r.kind}: skipped. ${r.reason ?? ''}`;
  if (r.status === 'error') return `${c.dim(when)} ${r.siteId} ${r.kind}: ${c.red('failed')}. ${r.reason ?? ''}`;
  const parts = [`${c.dim(when)} ${r.siteId} ${r.kind}: ${c.green('done')}`];
  if (r.audit) parts.push(`score ${fmtScore(r.audit.score.overall)}`);
  if (r.diff) parts.push(`${r.diff.scoreDelta >= 0 ? '+' : ''}${r.diff.scoreDelta} since last, ${r.diff.newIssues.length} new issues`);
  if (r.visibility) parts.push(`named in ${Math.round(r.visibility.summary.mentionRate * 100)}% of AI answers`);
  if (r.alerts.length) parts.push(c.yellow(`${r.alerts.length} alert(s)`));
  return parts.join(' · ');
}

export async function cmdMonitor(opts: { once?: string }): Promise<void> {
  if (opts.once) return cmdMonitorRun(opts.once, {});
  const config = getConfig();
  const store = getStore(config);
  const handle = startScheduler(config, {
    store,
    onRun: (r) => console.log(describeRun(r)),
  });
  if (!handle.jobs.length) {
    handle.stop();
    warn('No schedules set. Add one with `avc schedule <site> --cron "0 6 * * 1"` or in avc.config.json (sites[].schedule).');
    throw new ExitError(1);
  }
  console.log(c.bold('Monitoring') + c.dim(' (Ctrl+C to stop)'));
  for (const j of handle.jobs)
    console.log(`  ${j.siteId.padEnd(28)} ${j.kind.padEnd(10)} ${c.cyan(j.cron.padEnd(14))} next ${j.nextRun ? j.nextRun.toLocaleString() : '-'}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      handle.stop();
      console.log(c.dim('\nStopped.'));
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

export async function cmdMonitorRun(site: string, opts: { visibility?: boolean; dryRunAlerts?: boolean }): Promise<void> {
  const config = getConfig();
  const s = resolveSite(site, config);
  const progress = progressPrinter();
  try {
    const r = await runScheduledOnce(s.id, {
      config,
      kind: opts.visibility ? 'visibility' : 'audit',
      dryRunAlerts: opts.dryRunAlerts,
      store: getStore(config),
      onProgress: progress.onProgress,
    });
    progress.end();
    console.log(describeRun(r));
    if (r.status === 'error') throw new ExitError(1);
  } finally {
    progress.end();
  }
}

export async function cmdSchedule(
  site: string,
  opts: { cron?: string; visibilityCron?: string; install?: boolean },
): Promise<void> {
  const config = getConfig();
  const s = resolveSite(site, config);
  if (!opts.cron && !opts.visibilityCron) {
    const sched = getStore(config).getSchedule(s.id);
    const audit = s.schedule?.audit ?? sched?.auditCron;
    const vis = s.schedule?.visibility ?? sched?.visibilityCron;
    console.log(`${c.bold(s.id)}  audit ${audit ? c.cyan(audit) : c.dim('none')} · visibility ${vis ? c.cyan(vis) : c.dim('none')}`);
    console.log(c.dim('Set one with --cron "0 6 * * 1" (minute hour day month weekday).'));
    return;
  }
  const schedule = { ...s.schedule };
  if (opts.cron) schedule.audit = opts.cron;
  if (opts.visibilityCron) schedule.visibility = opts.visibilityCron;
  upsertUserSite({ ...s, schedule });
  getStore(config).setSchedule(s.id, { audit: schedule.audit ?? null, visibility: schedule.visibility ?? null });
  ok(`Saved schedule for ${s.id}.`);

  console.log(
    '\n' +
      c.bold('Run it') +
      '\n  Keep ' +
      c.cyan('avc monitor') +
      ' (or ' +
      c.cyan('avc ui --monitor') +
      ') running, or let your system scheduler start each run:',
  );
  for (const [kind, cron] of [
    ['audit', schedule.audit],
    ['visibility', schedule.visibility],
  ] as const) {
    if (!cron) continue;
    const ins = installSystemSchedule(s.id, cron, { kind });
    console.log('\n' + c.bold(`${kind} (${cron})`));
    if (ins.warning) warn(ins.warning);
    console.log(ins.instructions);
    if (!ins.instructions.includes(ins.content)) console.log('\n' + ins.content);
  }
  if (opts.install) {
    warn('Installing into the system scheduler is left to you, so nothing changes on your machine without you seeing it. Copy the line above.');
  }
}
