/**
 * `rollback(snapshotFile)`: restore what a previous apply changed, for either target.
 * Only values AVC wrote (and that have not changed since) are restored unless `force`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type AvcConfig } from '../../core/config.js';
import { readJson } from './snapshot.js';
import { rollbackRepo, type RepoFileResult } from './repo.js';
import { rollbackWordPress, WpClient, type WpChangeResult } from './wordpress.js';

export interface RollbackOptions {
  config?: AvcConfig;
  /** WordPress Application Password; defaults to the site config or AVC_WP_APP_PASSWORD. */
  appPassword?: string;
  fetch?: typeof fetch;
  force?: boolean;
  dryRun?: boolean;
}

export type RollbackOutcome =
  | { target: 'wordpress'; snapshotFile: string; results: WpChangeResult[] }
  | { target: 'repo'; snapshotFile: string; results: RepoFileResult[] };

export async function rollback(
  snapshotFile: string,
  opts: RollbackOptions = {},
): Promise<RollbackOutcome> {
  const snap = readJson<{ kind: string; site: string; user?: string }>(snapshotFile);
  if (snap.kind === 'repo')
    return { target: 'repo', snapshotFile, results: rollbackRepo(snapshotFile, opts) };
  if (snap.kind !== 'wordpress') throw new Error(`Unknown snapshot kind in ${snapshotFile}`);
  const config = opts.config ?? loadConfig();
  const host = new URL(snap.site).host.replace(/^www\./, '');
  const site = config.sites.find((s) => {
    try {
      return new URL(s.connections?.wordpress?.url ?? s.url).host.replace(/^www\./, '') === host;
    } catch {
      return false;
    }
  });
  const wp = site?.connections?.wordpress;
  const appPassword = opts.appPassword ?? wp?.appPassword ?? process.env.AVC_WP_APP_PASSWORD;
  if (!wp || !appPassword)
    throw new Error(
      `No WordPress connection for ${snap.site}. Run \`avc connect wordpress\` first, or set AVC_WP_APP_PASSWORD.`,
    );
  const client = new WpClient({ url: wp.url, user: wp.user, appPassword }, { fetch: opts.fetch });
  return {
    target: 'wordpress',
    snapshotFile,
    results: await rollbackWordPress(snapshotFile, client, opts),
  };
}

/** Snapshot files for a site, newest first. */
export function listSnapshots(dataDir: string, siteSlug?: string): string[] {
  const base = join(dataDir, 'rollback');
  if (!existsSync(base)) return [];
  const dirs = siteSlug ? [siteSlug] : readdirSync(base);
  const out: string[] = [];
  for (const d of dirs) {
    const dir = join(base, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.json')) out.push(join(dir, f));
  }
  return out.sort().reverse();
}
