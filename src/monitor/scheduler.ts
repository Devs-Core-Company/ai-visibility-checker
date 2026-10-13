/**
 * Scheduled audits and visibility runs.
 *
 * `startScheduler` runs inside a long-lived process (`avc monitor start`, the
 * dashboard). Each site's `schedule.audit` / `schedule.visibility` cron gets a
 * croner job. Runs never overlap per site, and visibility runs stop once the
 * month's AI spend reaches `config.ai.maxMonthUsd`.
 *
 * `runScheduledOnce` does one run and exits — for system cron, CI and the
 * GitHub Action. `installSystemSchedule` prints how to schedule that with the
 * operating system; it never installs anything itself.
 */
import { Cron } from 'croner';
import type { AvcConfig, SiteConfig } from '../core/config.js';
import { siteIdFromUrl } from '../core/config.js';
import type {
  AuditDiff,
  AuditResult,
  BrandProfile,
  ProgressFn,
  VisibilityRun,
} from '../core/types.js';
import type { RunAuditOptions } from '../audit/index.js';
import { diffAudits } from './diff.js';
import {
  evaluateAlerts,
  evaluateVisibilityAlerts,
  sendAlerts,
  type Alert,
  type AlertRules,
  type SendAlertsResult,
} from './alerts.js';
import { openStore, type Store } from './store.js';

export type RunKind = 'audit' | 'visibility';

export interface ScheduledRunResult {
  siteId: string;
  kind: RunKind;
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
  audit?: AuditResult;
  visibility?: VisibilityRun;
  diff?: AuditDiff;
  alerts: Alert[];
  delivery?: SendAlertsResult;
  startedAt: string;
  finishedAt: string;
}

export interface SchedulerDeps {
  runAudit(opts: RunAuditOptions): Promise<AuditResult>;
  runVisibility(args: {
    brand: BrandProfile;
    prompts: NonNullable<SiteConfig['prompts']>;
    config: AvcConfig;
    monthSpendUsd?: number;
    onProgress?: ProgressFn;
  }): Promise<VisibilityRun>;
  openStore(dataDir: string): Store;
}

export const defaultSchedulerDeps: SchedulerDeps = {
  runAudit: async (opts) => (await import('../audit/index.js')).runAudit(opts),
  runVisibility: async (args) => (await import('../ai/index.js')).runVisibility(args),
  openStore,
};

export interface RunOnceOptions {
  config: AvcConfig;
  kind?: RunKind;
  rules?: Partial<AlertRules>;
  dryRunAlerts?: boolean;
  store?: Store;
  deps?: Partial<SchedulerDeps>;
  onProgress?: ProgressFn;
}

function findSite(config: AvcConfig, siteId: string): SiteConfig | undefined {
  return config.sites.find(
    (s) => s.id === siteId || siteIdFromUrl(s.url) === siteId || s.url === siteId,
  );
}

function spendLeft(config: AvcConfig, store: Store): { ok: boolean; spent: number } {
  const spent = store.monthSpend();
  if (config.ai.mock) return { ok: true, spent };
  return { ok: spent < config.ai.maxMonthUsd, spent };
}

/** Run one scheduled job for a site: audit (with visibility when due and affordable) or visibility only. */
export async function runScheduledOnce(
  siteId: string,
  opts: RunOnceOptions,
): Promise<ScheduledRunResult> {
  const d: SchedulerDeps = { ...defaultSchedulerDeps, ...opts.deps };
  const kind = opts.kind ?? 'audit';
  const startedAt = new Date().toISOString();
  const base = { kind, alerts: [] as Alert[], startedAt };
  const site = findSite(opts.config, siteId);
  if (!site)
    return {
      ...base,
      siteId,
      status: 'error',
      reason: `No site "${siteId}" in the config. Add it with \`avc site add <url>\`.`,
      finishedAt: new Date().toISOString(),
    };
  const id = site.id || siteIdFromUrl(site.url);
  const ownStore = !opts.store;
  const store = opts.store ?? d.openStore(opts.config.dataDir);
  const log = (message: string, level: 'info' | 'warn' = 'info') =>
    opts.onProgress?.({ type: 'log', level, message });

  try {
    if (kind === 'audit') {
      const prev = store.latestAudit(id);
      // Include visibility in a scheduled audit only when the site has no separate
      // visibility schedule and spend allows it.
      const wantVisibility = !site.schedule?.visibility && !!site.schedule?.audit;
      const budget = spendLeft(opts.config, store);
      if (wantVisibility && !budget.ok)
        log(
          `Skipping AI visibility: $${budget.spent.toFixed(2)} spent this month (cap $${opts.config.ai.maxMonthUsd}).`,
          'warn',
        );
      const audit = await d.runAudit({
        url: site.url,
        siteConfig: site,
        config: opts.config,
        visibility: wantVisibility && budget.ok,
        monthSpendUsd: budget.spent,
        onProgress: opts.onProgress,
      });
      store.saveAudit(audit, id);
      store.markScheduledRun(id, 'audit');
      const diff = prev ? diffAudits(prev, audit) : undefined;
      const alerts = evaluateAlerts(prev, audit, opts.rules);
      const delivery = alerts.length
        ? await sendAlerts(alerts, opts.config, { store, dryRun: opts.dryRunAlerts })
        : undefined;
      return {
        ...base,
        siteId: id,
        status: 'ok',
        audit,
        ...(audit.visibility ? { visibility: audit.visibility } : {}),
        ...(diff ? { diff } : {}),
        alerts,
        ...(delivery ? { delivery } : {}),
        finishedAt: new Date().toISOString(),
      };
    }

    // Visibility only
    const budget = spendLeft(opts.config, store);
    if (!budget.ok)
      return {
        ...base,
        siteId: id,
        status: 'skipped',
        reason: `Monthly AI spend cap reached ($${budget.spent.toFixed(2)} of $${opts.config.ai.maxMonthUsd}).`,
        finishedAt: new Date().toISOString(),
      };
    const prevRun = store.latestVisibility(id);
    const brand = resolveBrand(site, prevRun);
    const prompts = site.prompts?.length ? site.prompts : (prevRun?.prompts ?? []);
    if (!brand || !prompts.length)
      return {
        ...base,
        siteId: id,
        status: 'skipped',
        reason:
          'No brand or prompts to track yet. Run `avc audit <url> --visibility` once, or set brand and prompts in the site config.',
        finishedAt: new Date().toISOString(),
      };
    const run = await d.runVisibility({
      brand,
      prompts,
      config: opts.config,
      monthSpendUsd: budget.spent,
      onProgress: opts.onProgress,
    });
    store.saveVisibility(run, id);
    store.markScheduledRun(id, 'visibility');
    const alerts = prevRun ? evaluateVisibilityAlerts(prevRun, run, opts.rules, id) : [];
    const delivery = alerts.length
      ? await sendAlerts(alerts, opts.config, { store, dryRun: opts.dryRunAlerts })
      : undefined;
    return {
      ...base,
      siteId: id,
      status: 'ok',
      visibility: run,
      alerts,
      ...(delivery ? { delivery } : {}),
      finishedAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      ...base,
      siteId: id,
      status: 'error',
      reason: e instanceof Error ? e.message : String(e),
      finishedAt: new Date().toISOString(),
    };
  } finally {
    if (ownStore) store.close();
  }
}

function resolveBrand(site: SiteConfig, prev: VisibilityRun | null): BrandProfile | null {
  const b = { ...(prev?.brand ?? {}), ...(site.brand ?? {}) } as Partial<BrandProfile>;
  const domain = b.domain ?? siteIdFromUrl(site.url);
  if (!b.name) return null;
  return {
    name: b.name,
    domain,
    aliases: b.aliases ?? [],
    services: b.services ?? [],
    competitors: b.competitors ?? [],
    ...(b.description ? { description: b.description } : {}),
    ...(b.location ? { location: b.location } : {}),
    ...(b.industry ? { industry: b.industry } : {}),
  };
}

export interface SchedulerHandle {
  jobs: { siteId: string; kind: RunKind; cron: string; nextRun: Date | null }[];
  /** Run a job now (respects the no-overlap rule). */
  runNow(siteId: string, kind: RunKind): Promise<ScheduledRunResult>;
  stop(): void;
}

export interface StartSchedulerOptions {
  onRun?: (r: ScheduledRunResult) => void | Promise<void>;
  onProgress?: ProgressFn;
  rules?: Partial<AlertRules>;
  deps?: Partial<SchedulerDeps>;
  /** Share one open store across runs (the dashboard passes its own). */
  store?: Store;
  timezone?: string;
}

export function startScheduler(
  config: AvcConfig,
  opts: StartSchedulerOptions = {},
): SchedulerHandle {
  const running = new Set<string>();
  const crons: Cron[] = [];
  const jobs: SchedulerHandle['jobs'] = [];

  const runNow = async (siteId: string, kind: RunKind): Promise<ScheduledRunResult> => {
    const now = new Date().toISOString();
    if (running.has(siteId)) {
      const r: ScheduledRunResult = {
        siteId,
        kind,
        status: 'skipped',
        reason: 'Another run for this site is still in progress.',
        alerts: [],
        startedAt: now,
        finishedAt: now,
      };
      await opts.onRun?.(r);
      return r;
    }
    running.add(siteId);
    try {
      const r = await runScheduledOnce(siteId, {
        config,
        kind,
        rules: opts.rules,
        deps: opts.deps,
        store: opts.store,
        onProgress: opts.onProgress,
      });
      await opts.onRun?.(r);
      return r;
    } finally {
      running.delete(siteId);
    }
  };

  for (const site of config.sites) {
    const siteId = site.id || siteIdFromUrl(site.url);
    for (const kind of ['audit', 'visibility'] as const) {
      const pattern = site.schedule?.[kind];
      if (!pattern) continue;
      try {
        const job = new Cron(
          pattern,
          { name: `avc:${siteId}:${kind}`, protect: true, timezone: opts.timezone, catch: true },
          () => {
            void runNow(siteId, kind);
          },
        );
        crons.push(job);
        jobs.push({ siteId, kind, cron: pattern, nextRun: job.nextRun() });
      } catch (e) {
        opts.onProgress?.({
          type: 'log',
          level: 'error',
          message: `Invalid ${kind} schedule "${pattern}" for ${siteId}: ${(e as Error).message}`,
        });
      }
    }
  }

  return {
    jobs,
    runNow,
    stop() {
      for (const c of crons) c.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// System schedulers (printed, never installed silently)
// ---------------------------------------------------------------------------

export type SystemPlatform = 'linux' | 'darwin' | 'win32';

export interface SystemScheduleInstructions {
  platform: SystemPlatform;
  /** The file content or command line to install. */
  content: string;
  /** Plain steps to install it. */
  instructions: string;
  /** Set when the cron expression could not be expressed exactly on this platform. */
  warning?: string;
}

interface CronParts {
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
}

function parseCron(cron: string): CronParts {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5)
    throw new Error(
      `Use a 5-field cron expression (minute hour day month weekday), got "${cron}".`,
    );
  const [minute, hour, dom, month, dow] = parts;
  return { minute, hour, dom, month, dow };
}

const listOf = (f: string): number[] | null =>
  /^\d+(,\d+)*$/.test(f) ? f.split(',').map(Number) : null;

const DOW_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function xmlEscape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function installSystemSchedule(
  siteId: string,
  cron: string,
  opts: { platform?: SystemPlatform; command?: string; logDir?: string; kind?: RunKind } = {},
): SystemScheduleInstructions {
  const platform = opts.platform ?? (process.platform as SystemPlatform);
  const kind = opts.kind ?? 'audit';
  const command =
    opts.command ?? `avc monitor run ${siteId}${kind === 'visibility' ? ' --visibility' : ''}`;
  const c = parseCron(cron);
  const label = `com.devs-core.avc.${siteId.replace(/[^a-z0-9.-]/gi, '-')}.${kind}`;

  if (platform === 'darwin') {
    const minutes = c.minute === '*' ? [null] : listOf(c.minute);
    const hours = c.hour === '*' ? [null] : listOf(c.hour);
    const doms = c.dom === '*' ? [null] : listOf(c.dom);
    const months = c.month === '*' ? [null] : listOf(c.month);
    const dows = c.dow === '*' ? [null] : listOf(c.dow.replace(/\b7\b/g, '0'));
    let warning: string | undefined;
    const dicts: string[] = [];
    if (!minutes || !hours || !doms || !months || !dows) {
      warning = `launchd cannot express "${cron}" exactly (ranges and steps are not supported). This plist runs daily at 09:00 instead; edit it, or keep \`avc monitor start\` running.`;
      dicts.push(
        '<dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>',
      );
    } else {
      for (const mi of minutes)
        for (const h of hours)
          for (const dm of doms)
            for (const mo of months)
              for (const dw of dows) {
                const kv: string[] = [];
                if (mi !== null) kv.push(`<key>Minute</key><integer>${mi}</integer>`);
                if (h !== null) kv.push(`<key>Hour</key><integer>${h}</integer>`);
                if (dm !== null) kv.push(`<key>Day</key><integer>${dm}</integer>`);
                if (mo !== null) kv.push(`<key>Month</key><integer>${mo}</integer>`);
                if (dw !== null) kv.push(`<key>Weekday</key><integer>${dw}</integer>`);
                dicts.push(`<dict>${kv.join('')}</dict>`);
              }
    }
    const logDir = opts.logDir ?? '~/.avc/logs';
    const args = ['/bin/sh', '-lc', command]
      .map((a) => `    <string>${xmlEscape(a)}</string>`)
      .join('\n');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartCalendarInterval</key>
  <array>
    ${dicts.join('\n    ')}
  </array>
  <key>StandardOutPath</key><string>${xmlEscape(logDir.replace(/^~/, '/Users/YOU'))}/${siteId}.log</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logDir.replace(/^~/, '/Users/YOU'))}/${siteId}.log</string>
</dict>
</plist>
`;
    return {
      platform,
      content,
      warning,
      instructions: [
        `Save this as ~/Library/LaunchAgents/${label}.plist (replace /Users/YOU with your home folder), then run:`,
        `  mkdir -p ~/.avc/logs && launchctl load ~/Library/LaunchAgents/${label}.plist`,
        `To remove it: launchctl unload ~/Library/LaunchAgents/${label}.plist`,
      ].join('\n'),
    };
  }

  if (platform === 'win32') {
    const mi = listOf(c.minute);
    const h = listOf(c.hour);
    const time =
      mi?.length === 1 && h?.length === 1
        ? `${String(h[0]).padStart(2, '0')}:${String(mi[0]).padStart(2, '0')}`
        : null;
    const tn = `AVC ${siteId} ${kind}`;
    const tr = `cmd /c ${command}`;
    let sched: string | null = null;
    if (c.hour === '*' && mi?.length === 1 && c.dom === '*' && c.month === '*' && c.dow === '*')
      sched = `/SC HOURLY /ST 00:${String(mi[0]).padStart(2, '0')}`;
    else if (time && c.dom === '*' && c.month === '*' && c.dow === '*')
      sched = `/SC DAILY /ST ${time}`;
    else if (time && c.dom === '*' && c.month === '*' && listOf(c.dow.replace(/\b7\b/g, '0')))
      sched = `/SC WEEKLY /D ${listOf(c.dow.replace(/\b7\b/g, '0'))!
        .map((n) => DOW_NAMES[n])
        .join(',')} /ST ${time}`;
    else if (time && listOf(c.dom) && c.month === '*' && c.dow === '*')
      sched = `/SC MONTHLY /D ${listOf(c.dom)!.join(',')} /ST ${time}`;
    const warning = sched
      ? undefined
      : `Task Scheduler cannot express "${cron}" exactly. This command runs daily at 09:00 instead; adjust it, or keep \`avc monitor start\` running.`;
    const content = `schtasks /Create /F /TN "${tn}" /TR "${tr}" ${sched ?? '/SC DAILY /ST 09:00'}`;
    return {
      platform,
      content,
      warning,
      instructions: [
        'Run this in a Command Prompt (it creates a task for your user account):',
        `  ${content}`,
        `To remove it: schtasks /Delete /TN "${tn}" /F`,
      ].join('\n'),
    };
  }

  const logDir = opts.logDir ?? '$HOME/.avc/logs';
  const content = `${cron} mkdir -p ${logDir} && ${command} >> ${logDir}/${siteId}.log 2>&1`;
  return {
    platform: 'linux',
    content,
    instructions: [
      'Add this line to your crontab (run `crontab -e`). Cron uses a minimal PATH, so use the full path to `avc` (see `which avc`) if it is not found:',
      `  ${content}`,
    ].join('\n'),
  };
}
