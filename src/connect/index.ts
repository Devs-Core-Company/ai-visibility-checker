/**
 * Connected data: fills site.external from whatever the user has configured.
 * Each source is independent and failure-tolerant: a broken connection logs a
 * warning and the audit carries on without that data.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AvcConfig, SiteConfig } from '../core/config.js';
import type { ExternalData, ProgressFn, SiteContext } from '../core/types.js';
import { collectBing, type BingData } from './bing.js';
import { collectGa4, findGa4Property } from './ga4.js';
import {
  DEFAULT_GOOGLE_SCOPES,
  getGoogleAccessToken,
  googleAuthMethod,
  googlePrincipal,
} from './google-auth.js';
import type { FetchFn, GoogleApiContext } from './google-api.js';
import { collectGsc, listGscProperties, pickGscProperty } from './gsc.js';
import { analyseLogs, expandLogPaths, type LogResolver } from './logs.js';
import { collectPsi, samplePsiUrls, type PsiStrategy } from './psi.js';
import { checkWordPress } from './wordpress.js';

export * from './bing.js';
export * from './ga4.js';
export * from './google-api.js';
export * from './google-auth.js';
export * from './gsc.js';
export * from './logs.js';
export * from './psi.js';
export * from './wordpress.js';

/** ExternalData plus sources the shared contract has no slot for yet. */
export type ExternalDataPlus = ExternalData & { bing?: BingData };

export interface CollectExternalOptions {
  /** PageSpeed: false to skip, or how many URLs to sample. Default 5 with a key, 1 without. */
  psi?: boolean | number;
  psiStrategies?: PsiStrategy[];
  /** Search Console window in days. Default 28. */
  gscDays?: number;
  /** URL Inspection sample size. Default 10 (0 to skip). */
  gscInspections?: number;
  ga4Days?: number;
  /** Logs: only lines after this date. */
  logsSince?: Date;
  /** Logs: verify bot IPs (ranges + rDNS). Default true. */
  verifyLogs?: boolean;
  /** Injection for tests. */
  fetch?: FetchFn;
  baseUrls?: {
    gsc?: string;
    ga4Data?: string;
    ga4Admin?: string;
    psi?: string;
    bing?: string;
    googleToken?: string;
  };
  resolver?: LogResolver;
  now?: Date;
}

const warn = (onProgress: ProgressFn | undefined, message: string) =>
  onProgress?.({ type: 'log', level: 'warn', message });
const info = (onProgress: ProgressFn | undefined, message: string) =>
  onProgress?.({ type: 'log', level: 'info', message });

/** HTML 200 pages, most-linked first: the "key pages" for neverFetched and inspections. */
function keyPages(site: SiteContext, limit: number): string[] {
  return [...site.pages.values()]
    .filter((p) => p.isHtml && p.status === 200 && p.finalUrl === p.url)
    .map((p) => ({ url: p.url, n: site.inlinks.get(p.url)?.size ?? 0, d: p.depth }))
    .sort((a, b) => b.n - a.n || a.d - b.d)
    .slice(0, limit)
    .map((p) => p.url);
}

async function countFiles(dir: string, cap = 50_000): Promise<number> {
  let n = 0;
  const skip = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', 'vendor']);
  const walk = async (d: string): Promise<void> => {
    if (n >= cap) return;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile()) n++;
      else if (e.isDirectory() && !skip.has(e.name)) await walk(join(d, e.name));
      if (n >= cap) return;
    }
  };
  await walk(dir);
  return n;
}

/**
 * Fill site.external from every configured source. Never throws.
 * Bing data, which has no slot in ExternalData, goes on `site.external.bing`.
 */
export async function collectExternal(
  site: SiteContext,
  siteConfig: SiteConfig | undefined,
  config: AvcConfig,
  onProgress?: ProgressFn,
  opts: CollectExternalOptions = {},
): Promise<void> {
  onProgress?.({ type: 'phase', phase: 'external' });
  const ext = (site.external ??= {}) as ExternalDataPlus;
  const conn = siteConfig?.connections ?? {};
  const f = opts.fetch;
  const tasks: Promise<void>[] = [];
  const run = (name: string, fn: () => Promise<void>) =>
    tasks.push(fn().catch((e: Error) => warn(onProgress, `${name}: ${e.message}`)));

  // ---- Google (Search Console + GA4) ----
  const method = googleAuthMethod(config);
  if (method === 'service-account' || method === 'oauth') {
    run('Google', async () => {
      const accessToken = await getGoogleAccessToken(config, DEFAULT_GOOGLE_SCOPES, {
        fetch: f,
        tokenUrl: opts.baseUrls?.googleToken,
      });
      const base: Omit<GoogleApiContext, 'baseUrl'> = {
        accessToken,
        fetch: f,
        principal: googlePrincipal(config),
      };
      const sub: Promise<void>[] = [];
      sub.push(
        (async () => {
          const inspections = opts.gscInspections ?? 10;
          ext.gsc = await collectGsc({ ...base, baseUrl: opts.baseUrls?.gsc }, site.startUrl, {
            property: conn.gscProperty,
            days: opts.gscDays,
            inspect: inspections > 0 ? keyPages(site, inspections) : undefined,
            maxInspections: inspections,
            now: opts.now,
          });
          info(
            onProgress,
            `Search Console: ${ext.gsc.property}, ${ext.gsc.pages.length} pages with impressions.`,
          );
        })().catch((e: Error) => warn(onProgress, `Search Console: ${e.message}`)),
      );
      sub.push(
        (async () => {
          let property = conn.ga4Property;
          if (!property) {
            property =
              (await findGa4Property(
                { ...base, baseUrl: opts.baseUrls?.ga4Admin },
                site.startUrl,
              )) ?? undefined;
            if (!property) {
              info(
                onProgress,
                'GA4: no property with a web stream for this site; set connections.ga4Property to use one.',
              );
              return;
            }
          }
          ext.ga4 = await collectGa4({ ...base, baseUrl: opts.baseUrls?.ga4Data }, property, {
            days: opts.ga4Days,
            now: opts.now,
          });
          const total = ext.ga4.aiReferrals.reduce((s, r) => s + r.sessions, 0);
          info(onProgress, `GA4: ${total} sessions from AI assistants.`);
        })().catch((e: Error) => warn(onProgress, `GA4: ${e.message}`)),
      );
      await Promise.all(sub);
    });
  } else if (conn.gscProperty || conn.ga4Property) {
    warn(
      onProgress,
      'Search Console / GA4 are set for this site but Google is not connected. Run `avc connect google`.',
    );
  }

  // ---- PageSpeed Insights ----
  const psiKey = config.google?.psiKey;
  // Explicit opts.psi wins; otherwise AVC_PSI=off skips PSI, a key tests 5 URLs, no key the home page.
  const psiOff = /^(0|off|false)$/i.test(process.env.AVC_PSI ?? '');
  const psiN =
    typeof opts.psi === 'number'
      ? opts.psi
      : opts.psi === false || (opts.psi === undefined && psiOff)
        ? 0
        : psiKey
          ? 5
          : 1;
  if (psiN > 0) {
    run('PageSpeed Insights', async () => {
      const urls = samplePsiUrls(site, psiN);
      const results = await collectPsi(urls, {
        key: psiKey,
        fetch: f,
        baseUrl: opts.baseUrls?.psi,
        strategies: opts.psiStrategies,
      });
      ext.psi = results;
      const failed = Object.values(results).filter((r) => r.error);
      if (failed.length) warn(onProgress, `PageSpeed Insights: ${failed[0].error}`);
    });
  }

  // ---- Bing Webmaster Tools ----
  if (config.bing?.apiKey) {
    run('Bing Webmaster Tools', async () => {
      ext.bing = await collectBing(site.startUrl, config.bing!.apiKey!, {
        fetch: f,
        baseUrl: opts.baseUrls?.bing,
      });
      for (const e of ext.bing.errors) warn(onProgress, `Bing Webmaster Tools: ${e}`);
    });
  }

  // ---- Server logs ----
  if (conn.logs?.length) {
    run('Server logs', async () => {
      ext.logs = await analyseLogs(conn.logs!, {
        siteUrls: keyPages(site, 500),
        verify: opts.verifyLogs,
        since: opts.logsSince,
        dataDir: config.dataDir,
        fetch: f,
        resolver: opts.resolver,
      });
      if (!ext.logs.files.length) {
        warn(onProgress, `Server logs: no readable files matched ${conn.logs!.join(', ')}.`);
      } else {
        const hits = ext.logs.bots.reduce((s, b) => s + b.hits, 0);
        info(onProgress, `Server logs: ${ext.logs.lines} lines, ${hits} AI-bot hits.`);
      }
    });
  }

  // ---- WordPress ----
  if (conn.wordpress?.url) {
    run('WordPress', async () => {
      const r = await checkWordPress(conn.wordpress!, { fetch: f });
      ext.wordpress = {
        url: r.url,
        user: conn.wordpress!.user,
        version: r.version,
        seoPlugin: r.seoPlugin,
      };
      for (const p of r.problems) warn(onProgress, `WordPress: ${p}`);
    });
  }

  // ---- Local repository ----
  if (conn.repoPath) {
    run('Repository', async () => {
      ext.repo = {
        path: conn.repoPath!,
        stack: site.stack.id,
        files: await countFiles(conn.repoPath!),
      };
    });
  }

  await Promise.all(tasks);
}

// ---------------------------------------------------------------------------
// Connections page
// ---------------------------------------------------------------------------

export type ConnectionId =
  'google' | 'gsc' | 'ga4' | 'psi' | 'bing' | 'logs' | 'wordpress' | 'repo';

export interface ConnectionStatus {
  id: ConnectionId;
  label: string;
  configured: boolean;
  /** null when not tested (or not configured). */
  ok: boolean | null;
  detail: string;
  /** What to do next, when something is missing or broken. */
  help?: string;
}

/**
 * Which sources are configured and, with `test: true`, whether they work
 * (makes one cheap request per source). Never throws.
 */
export async function connectionStatus(
  siteConfig: SiteConfig | undefined,
  config: AvcConfig,
  opts: { test?: boolean; fetch?: FetchFn; baseUrls?: CollectExternalOptions['baseUrls'] } = {},
): Promise<ConnectionStatus[]> {
  const conn = siteConfig?.connections ?? {};
  const out: ConnectionStatus[] = [];
  const f = opts.fetch;
  const method = googleAuthMethod(config);

  // Google sign-in
  const google: ConnectionStatus = {
    id: 'google',
    label: 'Google account',
    configured: method === 'service-account' || method === 'oauth',
    ok: null,
    detail:
      method === 'service-account'
        ? `${googlePrincipal(config)} (key file)`
        : method === 'oauth'
          ? `${googlePrincipal(config)} (signed in)`
          : method === 'oauth-not-signed-in'
            ? 'OAuth client set, not signed in yet'
            : 'Not connected',
    help:
      method === 'none'
        ? 'Create a Google Cloud OAuth "Desktop app" client or a service account. See docs/CONNECTIONS.md.'
        : method === 'oauth-not-signed-in'
          ? 'Run `avc connect google`.'
          : undefined,
  };
  out.push(google);
  let token: string | null = null;
  if (opts.test && google.configured) {
    try {
      token = await getGoogleAccessToken(config, DEFAULT_GOOGLE_SCOPES, {
        fetch: f,
        tokenUrl: opts.baseUrls?.googleToken,
      });
      google.ok = true;
    } catch (e) {
      google.ok = false;
      google.detail = (e as Error).message;
    }
  }
  const ctx = (baseUrl?: string): GoogleApiContext => ({
    accessToken: token ?? '',
    fetch: f,
    baseUrl,
    principal: googlePrincipal(config),
  });

  // Search Console
  const gsc: ConnectionStatus = {
    id: 'gsc',
    label: 'Google Search Console',
    configured: google.configured,
    ok: null,
    detail: conn.gscProperty ? `Property ${conn.gscProperty}` : 'Property picked automatically',
    help: google.configured ? undefined : 'Connect Google first.',
  };
  out.push(gsc);
  if (token && siteConfig) {
    try {
      const props = await listGscProperties(ctx(opts.baseUrls?.gsc));
      const picked = conn.gscProperty ?? pickGscProperty(siteConfig.url, props);
      gsc.ok = !!picked && (!conn.gscProperty || props.some((p) => p.siteUrl === conn.gscProperty));
      gsc.detail = gsc.ok
        ? `Property ${picked}`
        : `No usable property for ${siteConfig.url} among ${props.length} visible.`;
      if (!gsc.ok)
        gsc.help =
          'Add the account as a user on the property in Search Console → Settings → Users and permissions.';
    } catch (e) {
      gsc.ok = false;
      gsc.detail = (e as Error).message;
    }
  }

  // GA4
  const ga4: ConnectionStatus = {
    id: 'ga4',
    label: 'Google Analytics 4',
    configured: google.configured,
    ok: null,
    detail: conn.ga4Property
      ? `Property ${conn.ga4Property}`
      : 'Property found from the web stream',
    help: google.configured ? undefined : 'Connect Google first.',
  };
  out.push(ga4);
  if (token && siteConfig) {
    try {
      const prop =
        conn.ga4Property ?? (await findGa4Property(ctx(opts.baseUrls?.ga4Admin), siteConfig.url));
      if (!prop) {
        ga4.ok = false;
        ga4.detail = 'No GA4 property with a web stream for this site.';
        ga4.help =
          'Set connections.ga4Property, or add the account in GA4 → Admin → Property access management.';
      } else {
        await collectGa4(ctx(opts.baseUrls?.ga4Data), prop, { days: 7 });
        ga4.ok = true;
        ga4.detail = `Property ${prop}`;
      }
    } catch (e) {
      ga4.ok = false;
      ga4.detail = (e as Error).message;
    }
  }

  // PSI
  out.push({
    id: 'psi',
    label: 'PageSpeed Insights',
    configured: true,
    ok: null,
    detail: config.google?.psiKey ? 'API key set' : 'No key: home page only, low shared quota',
    help: config.google?.psiKey
      ? undefined
      : 'Add a free API key (PSI_API_KEY) to test more pages.',
  });

  // Bing
  const bing: ConnectionStatus = {
    id: 'bing',
    label: 'Bing Webmaster Tools',
    configured: !!config.bing?.apiKey,
    ok: null,
    detail: config.bing?.apiKey ? 'API key set' : 'Not connected',
    help: config.bing?.apiKey
      ? undefined
      : 'Bing Webmaster Tools → Settings → API access; set BING_WEBMASTER_API_KEY.',
  };
  out.push(bing);
  if (opts.test && config.bing?.apiKey && siteConfig) {
    try {
      const d = await collectBing(siteConfig.url, config.bing.apiKey, {
        fetch: f,
        baseUrl: opts.baseUrls?.bing,
      });
      bing.ok = d.errors.length === 0 || d.verified !== null;
      bing.detail =
        d.verified === null
          ? (d.errors[0] ?? 'Site not found')
          : `Site ${d.siteUrl}${d.verified ? '' : ' (not verified)'}`;
    } catch (e) {
      bing.ok = false;
      bing.detail = (e as Error).message;
    }
  }

  // Logs
  const logs: ConnectionStatus = {
    id: 'logs',
    label: 'Server access logs',
    configured: !!conn.logs?.length,
    ok: null,
    detail: conn.logs?.length ? conn.logs.join(', ') : 'Not set',
    help: conn.logs?.length ? undefined : 'Set connections.logs to your access-log paths or globs.',
  };
  out.push(logs);
  if (conn.logs?.length) {
    const files = await expandLogPaths(conn.logs);
    logs.ok = files.length > 0;
    logs.detail = files.length
      ? `${files.length} file(s) found`
      : `No files match ${conn.logs.join(', ')}`;
  }

  // WordPress
  const wp: ConnectionStatus = {
    id: 'wordpress',
    label: 'WordPress',
    configured: !!conn.wordpress?.url,
    ok: null,
    detail: conn.wordpress?.url ? `${conn.wordpress.url} as ${conn.wordpress.user}` : 'Not set',
  };
  out.push(wp);
  if (opts.test && conn.wordpress?.url) {
    const r = await checkWordPress(conn.wordpress, { fetch: f });
    wp.ok = r.ok;
    wp.detail = r.ok
      ? `WordPress ${r.version ?? ''} as ${r.user?.name}${r.seoPlugin ? `, ${r.seoPlugin}` : ''}`.replace(
          /\s+/g,
          ' ',
        )
      : (r.problems[0] ?? 'Not working');
    if (!r.ok) wp.help = r.problems.slice(1).join(' ') || undefined;
  }

  // Repo
  out.push({
    id: 'repo',
    label: 'Local source code',
    configured: !!conn.repoPath,
    ok: null,
    detail: conn.repoPath ?? 'Not set',
  });

  return out;
}
