/**
 * `applyFixes`: plan (and optionally apply) automatic fixes for one site, against its
 * WordPress install or a local repository. Always returns the plan, the per-change results
 * and a printable summary, so the CLI, dashboard and MCP server can show the same thing.
 */
import type { AvcConfig, SiteConfig } from '../../core/config.js';
import type { AuditResult } from '../../core/types.js';
import type { RobotsPolicy } from '../generate.js';
import type { BrandFacts } from '../types.js';
import {
  applyRepoPlan,
  planRepoFixes,
  renderRepoPlan,
  type RepoOutcome,
  type RepoPlan,
} from './repo.js';
import {
  applyWordPressPlan,
  planWordPressFixes,
  planWordPressRedirect,
  renderWpPlan,
  WpClient,
  type WpApplyOutcome,
  type WpPlan,
} from './wordpress.js';

export interface ApplyFixesOptions {
  result: AuditResult;
  config: AvcConfig;
  /** Site config, or its id / URL. Defaults to the config entry matching result.site. */
  site?: SiteConfig | string;
  target: 'wordpress' | 'repo';
  dryRun: boolean;
  /** Check ids or recipe ids (globs allowed: `onpage.title-*`, `llms-txt`). */
  only?: string[];
  robotsPolicy?: RobotsPolicy;
  brand?: BrandFacts;
  /** Overrides for tests / callers that already know them. */
  repoPath?: string;
  appPassword?: string;
  fetch?: typeof fetch;
}

interface Counts {
  planned: number;
  applied: number;
  skipped: number;
  failed: number;
}

export type ApplyFixesOutcome =
  | ({
      target: 'wordpress';
      dryRun: boolean;
      plan: WpPlan;
      outcome: WpApplyOutcome;
      snapshotFile?: string;
      summary: string;
    } & Counts)
  | ({
      target: 'repo';
      dryRun: boolean;
      plan: RepoPlan;
      outcome: RepoOutcome;
      snapshotFile?: string;
      diff: string;
      summary: string;
    } & Counts);

function hostKey(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
}

export function resolveSite(
  config: AvcConfig,
  result: AuditResult,
  site?: SiteConfig | string,
): SiteConfig | undefined {
  if (site && typeof site === 'object') return site;
  const key = site ?? result.site;
  return (
    config.sites.find((s) => s.id === key || s.url === key) ??
    config.sites.find((s) => hostKey(s.url) === hostKey(key)) ??
    config.sites.find((s) => hostKey(s.url) === hostKey(result.site))
  );
}

export async function applyFixes(opts: ApplyFixesOptions): Promise<ApplyFixesOutcome> {
  const site = resolveSite(opts.config, opts.result, opts.site);
  if (opts.target === 'wordpress') {
    const wp = site?.connections?.wordpress;
    const appPassword = opts.appPassword ?? wp?.appPassword ?? process.env.AVC_WP_APP_PASSWORD;
    if (!wp?.url || !wp.user)
      throw new Error(
        'No WordPress connection for this site. Run `avc connect wordpress --url <site> --user <name>` first.',
      );
    if (!appPassword)
      throw new Error(
        'No Application Password. Create one in WordPress (Users → Profile → Application Passwords) and set AVC_WP_APP_PASSWORD.',
      );
    const client = new WpClient({ url: wp.url, user: wp.user, appPassword }, { fetch: opts.fetch });
    const plan = await planWordPressFixes(opts.result, client, {
      only: opts.only,
      config: opts.config,
      brand: opts.brand?.name ?? site?.brand?.name,
      robotsPolicy: opts.robotsPolicy,
    });
    const outcome = await applyWordPressPlan(plan, client, {
      dryRun: opts.dryRun,
      dataDir: opts.config.dataDir,
    });
    const counts = count(outcome.results.map((r) => r.status));
    return {
      target: 'wordpress',
      dryRun: opts.dryRun,
      plan,
      outcome,
      snapshotFile: outcome.snapshotFile,
      ...counts,
      summary: [
        renderWpPlan(plan, opts.dryRun ? undefined : outcome.results),
        '',
        opts.dryRun
          ? 'Dry run: nothing was changed. Re-run with --apply to write these values.'
          : `Rollback file: ${outcome.snapshotFile}\nUndo with: avc fix --rollback "${outcome.snapshotFile}"`,
      ].join('\n'),
    };
  }
  const repoPath = opts.repoPath ?? site?.connections?.repoPath;
  if (!repoPath)
    throw new Error(
      'No repository path for this site. Set connections.repoPath or pass --repo <path>.',
    );
  const plan = await planRepoFixes(opts.result, repoPath, {
    only: opts.only,
    robotsPolicy: opts.robotsPolicy,
    brand: {
      ...(site?.brand?.name ? { name: site.brand.name } : {}),
      ...(site?.brand?.description ? { description: site.brand.description } : {}),
      ...opts.brand,
    },
  });
  const outcome = applyRepoPlan(plan, { dryRun: opts.dryRun, dataDir: opts.config.dataDir });
  const counts = count(outcome.results.map((r) => (r.status === 'written' ? 'applied' : r.status)));
  return {
    target: 'repo',
    dryRun: opts.dryRun,
    plan,
    outcome,
    snapshotFile: outcome.snapshotFile,
    diff: plan.diff,
    ...counts,
    summary: [
      renderRepoPlan(plan, opts.dryRun ? undefined : outcome),
      opts.dryRun
        ? 'Dry run: no files were written. Re-run with --apply to write them.'
        : `Backup: ${outcome.snapshotFile}\nUndo with: avc fix --rollback "${outcome.snapshotFile}"`,
    ].join('\n'),
  };
}

/** Add a redirect on a connected WordPress site through the AVC helper (dry run unless told). */
export async function addWordPressRedirect(opts: {
  config: AvcConfig;
  site: SiteConfig;
  from: string;
  to: string;
  code?: 301 | 302 | 307 | 308;
  dryRun: boolean;
  appPassword?: string;
  fetch?: typeof fetch;
}): Promise<{ plan: WpPlan; outcome: WpApplyOutcome; summary: string }> {
  const wp = opts.site.connections?.wordpress;
  const appPassword = opts.appPassword ?? wp?.appPassword ?? process.env.AVC_WP_APP_PASSWORD;
  if (!wp?.url || !wp.user || !appPassword)
    throw new Error(
      'No WordPress connection with an Application Password for this site. Run `avc connect wordpress` first.',
    );
  const client = new WpClient({ url: wp.url, user: wp.user, appPassword }, { fetch: opts.fetch });
  const plan = await planWordPressRedirect(client, opts.site.url, {
    from: opts.from,
    to: opts.to,
    code: opts.code,
  });
  const outcome = await applyWordPressPlan(plan, client, {
    dryRun: opts.dryRun,
    dataDir: opts.config.dataDir,
  });
  return {
    plan,
    outcome,
    summary: [
      renderWpPlan(plan, opts.dryRun ? undefined : outcome.results),
      '',
      opts.dryRun
        ? 'Dry run: nothing was changed. Re-run with --apply to add the redirect.'
        : `Rollback file: ${outcome.snapshotFile}\nUndo with: avc rollback "${outcome.snapshotFile}"`,
    ].join('\n'),
  };
}

function count(statuses: string[]): Counts {
  return {
    planned: statuses.filter((s) => s === 'planned').length,
    applied: statuses.filter((s) => s === 'applied').length,
    skipped: statuses.filter((s) => s === 'skipped').length,
    failed: statuses.filter((s) => s === 'failed').length,
  };
}

export {
  planRepoFixes,
  applyRepoPlan,
  rollbackRepo,
  detectRepoStack,
  renderRepoPlan,
} from './repo.js';
export {
  planWordPressFixes,
  planWordPressRedirect,
  applyWordPressPlan,
  rollbackWordPress,
  renderWpPlan,
  WpClient,
} from './wordpress.js';
export { WP_HELPER_PHP, WP_HELPER_FILENAME, WP_HELPER_INSTALL } from './wp-helper.js';
export { rollback, listSnapshots } from './rollback.js';
