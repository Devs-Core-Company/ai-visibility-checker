import { resolve } from 'node:path';
import type { SiteConfig } from '../../core/config.js';
import {
  analyseLogs,
  connectionStatus,
  getGoogleAccessToken,
  googleLogin,
  googlePrincipal,
  listGa4Properties,
  listGscProperties,
  type ConnectionStatus,
} from '../../connect/index.js';
import type { LogInsights } from '../../core/types.js';
import { ask, askSecret, interactive } from '../ask.js';
import { c, ok, table, warn } from '../output.js';
import { ExitError } from '../errors.js';
import {
  allSites,
  getConfig,
  patchSiteConnections,
  patchUserConfig,
  resolveSite,
} from '../services.js';

interface ConnectOpts {
  property?: string;
  key?: string;
  clientId?: string;
  clientSecret?: string;
  serviceAccount?: string;
  wpUrl?: string;
  wpUser?: string;
  url?: string;
  user?: string;
  wpAppPassword?: string;
  path?: string[];
  test?: boolean;
}

function pickSite(ref: string | undefined): SiteConfig {
  const config = getConfig();
  if (ref) return resolveSite(ref, config);
  const sites = allSites(config).filter((s) => s.configured);
  if (sites.length === 1) return sites[0];
  if (!sites.length)
    throw new ExitError(1, 'No site configured. Run `avc init` first, or pass the site.');
  throw new ExitError(
    1,
    `Several sites are configured (${sites.map((s) => s.id).join(', ')}). Pass one.`,
  );
}

/** Make sure the site exists in the user config so connection settings can be saved on it. */
function ensureSaved(site: SiteConfig): void {
  patchSiteConnections(site.id, {});
}

export async function cmdConnect(
  source: string,
  siteRef: string | undefined,
  opts: ConnectOpts,
): Promise<void> {
  const config = getConfig();
  const siteless =
    source === 'google' || source === 'psi' || source === 'bing' || source === 'status';
  let site: SiteConfig | undefined;
  try {
    site = siteRef || !siteless ? pickSite(siteRef) : undefined;
  } catch (e) {
    if (!siteless) throw e;
  }
  if (site && !siteless) {
    try {
      ensureSaved(site);
    } catch {
      const { upsertUserSite } = await import('../services.js');
      upsertUserSite(site);
    }
  }

  switch (source) {
    case 'status':
      await printStatus(site, true);
      return;

    case 'google': {
      if (opts.serviceAccount) {
        patchUserConfig('google', { serviceAccountFile: resolve(opts.serviceAccount) });
        ok(`Using service account key ${resolve(opts.serviceAccount)}.`);
      } else {
        const clientId =
          opts.clientId ??
          config.google?.clientId ??
          (interactive() ? await ask('Google OAuth client id (Desktop app)') : '');
        if (!clientId)
          throw new ExitError(
            1,
            'Pass --client-id and --client-secret, or --service-account <file>. See docs/CONNECTIONS.md.',
          );
        const clientSecret =
          opts.clientSecret ??
          config.google?.clientSecret ??
          (interactive() ? await askSecret('Client secret') : '');
        patchUserConfig('google', { clientId, clientSecret });
        await googleLogin(getConfig(true));
        ok(`Signed in as ${googlePrincipal(getConfig(true))}.`);
      }
      break;
    }

    case 'gsc':
    case 'ga4': {
      if (!site) throw new ExitError(1, 'Pass the site.');
      let property = opts.property;
      if (!property) {
        const token = await getGoogleAccessToken(config).catch(() => {
          throw new ExitError(1, 'Google is not connected. Run `avc connect google` first.');
        });
        const ctx = { accessToken: token, principal: googlePrincipal(config) };
        const props =
          source === 'gsc'
            ? (await listGscProperties(ctx)).map((p) => ({
                id: p.siteUrl,
                label: `${p.siteUrl} (${p.permissionLevel})`,
              }))
            : (await listGa4Properties(ctx)).map((p) => ({
                id: p.property,
                label: `${p.property} ${p.displayName ?? ''}`,
              }));
        if (!props.length)
          throw new ExitError(
            1,
            `${googlePrincipal(config)} cannot see any ${source.toUpperCase()} properties.`,
          );
        props.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p.label}`));
        const n = Number(await ask('Pick a number', '1'));
        property = props[n - 1]?.id;
        if (!property) throw new ExitError(1, 'No property picked.');
      }
      patchSiteConnections(
        site.id,
        source === 'gsc' ? { gscProperty: property } : { ga4Property: property },
      );
      ok(`${source.toUpperCase()} property for ${site.id}: ${property}`);
      break;
    }

    case 'psi': {
      const key = opts.key ?? (interactive() ? await askSecret('PageSpeed Insights API key') : '');
      if (!key)
        throw new ExitError(
          1,
          'Pass --key. Get one at https://developers.google.com/speed/docs/insights/v5/get-started',
        );
      patchUserConfig('google', { psiKey: key });
      ok('Saved the PageSpeed Insights key.');
      break;
    }

    case 'bing': {
      const key = opts.key ?? (interactive() ? await askSecret('Bing Webmaster API key') : '');
      if (!key) throw new ExitError(1, 'Pass --key. Bing Webmaster Tools → Settings → API access.');
      patchUserConfig('bing', { apiKey: key });
      ok('Saved the Bing Webmaster key.');
      break;
    }

    case 'wordpress': {
      if (!site) throw new ExitError(1, 'Pass the site.');
      const url =
        opts.wpUrl ??
        opts.url ??
        site.connections?.wordpress?.url ??
        (interactive() ? await ask('WordPress URL', site.url) : site.url);
      const user =
        opts.wpUser ??
        opts.user ??
        site.connections?.wordpress?.user ??
        (interactive() ? await ask('WordPress user name') : '');
      if (!user) throw new ExitError(1, 'Pass --wp-user.');
      const appPassword =
        opts.wpAppPassword ??
        (process.env.AVC_WP_APP_PASSWORD
          ? undefined
          : interactive()
            ? await askSecret('Application password (Users → Profile → Application Passwords)')
            : undefined);
      // The app password is a secret: it goes in the user file (mode 600), never the project file.
      patchSiteConnections(site.id, {
        wordpress: { url, user, ...(appPassword ? { appPassword } : {}) },
      });
      ok(`Saved WordPress connection for ${site.id}.`);
      break;
    }

    case 'logs': {
      if (!site) throw new ExitError(1, 'Pass the site.');
      const paths = opts.path?.length
        ? opts.path
        : (await ask('Log file paths or globs, comma-separated'))
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      if (!paths.length) throw new ExitError(1, 'Pass --path /var/log/nginx/access.log*');
      patchSiteConnections(site.id, { logs: paths });
      ok(`Saved ${paths.length} log path(s) for ${site.id}.`);
      break;
    }

    case 'repo': {
      if (!site) throw new ExitError(1, 'Pass the site.');
      const p = opts.path?.[0] ?? (await ask('Path to the site source code', process.cwd()));
      patchSiteConnections(site.id, { repoPath: resolve(p) });
      ok(`Repo for ${site.id}: ${resolve(p)}`);
      break;
    }
  }

  if (opts.test !== false)
    await printStatus(site ? resolveSite(site.id, getConfig(true)) : undefined, true, source);
}

export async function printStatus(
  site: SiteConfig | undefined,
  test: boolean,
  only?: string,
): Promise<ConnectionStatus[]> {
  const rows = await connectionStatus(site, getConfig(true), { test });
  const shown =
    only && only !== 'status'
      ? rows.filter((r) => r.id === only || (only === 'google' && r.id === 'google'))
      : rows;
  console.log(
    '\n' +
      table(
        shown.map((r) => [
          r.ok === true
            ? c.green('✓')
            : r.ok === false
              ? c.red('✗')
              : r.configured
                ? c.yellow('•')
                : c.dim('-'),
          r.label,
          r.detail,
          r.help ? c.dim(r.help) : '',
        ]),
        { maxWidth: [1, 24, 60, 70] },
      ),
  );
  return rows;
}

export async function cmdLogs(
  files: string[],
  opts: { site?: string; verify?: boolean; json?: boolean },
): Promise<void> {
  const config = getConfig();
  let siteUrls: string[] | undefined;
  if (opts.site) {
    const { findAudit } = await import('../services.js');
    const a = findAudit(opts.site, config);
    siteUrls = a?.pages.filter((p) => p.indexable).map((p) => p.url);
    if (!a) warn('No audit for that site yet, so "never fetched" pages cannot be listed.');
  }
  const r: LogInsights = await analyseLogs(files, {
    siteUrls,
    verify: opts.verify !== false,
    dataDir: config.dataDir,
    onProgress: (p) =>
      process.stderr.isTTY &&
      process.stderr.write(`\r\x1b[2K${c.dim(`${p.file}: ${p.lines} lines`)}`),
  });
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
  if (opts.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }
  console.log(
    `${c.bold('AI crawler visits')} ${r.lines} lines in ${r.files.length} file(s)${r.range ? c.dim(` ${r.range.start} → ${r.range.end}`) : ''}\n`,
  );
  if (!r.bots.length) console.log(c.dim('No AI crawler hits found.'));
  else
    console.log(
      table(
        r.bots
          .sort((a, b) => b.hits - a.hits)
          .map((b) => [
            b.token,
            b.operator,
            b.purpose,
            String(b.hits),
            b.verified ? c.green(`${b.verified} verified`) : c.dim('0 verified'),
            b.spoofed ? c.red(`${b.spoofed} spoofed`) : '',
            b.lastSeen ? c.dim(b.lastSeen) : '',
          ]),
        { header: ['bot', 'operator', 'purpose', 'hits', '', '', 'last seen'] },
      ),
    );
  if (r.errorsServedToBots.length) {
    console.log('\n' + c.bold('Errors served to AI bots'));
    for (const e of r.errorsServedToBots.slice(0, 15))
      console.log(`  ${c.red(String(e.status))} ${e.path} ${c.dim(`${e.bot} ×${e.hits}`)}`);
  }
  if (r.neverFetched.length) {
    console.log('\n' + c.bold(`Pages no AI bot fetched (${r.neverFetched.length})`));
    for (const u of r.neverFetched.slice(0, 15)) console.log('  ' + u);
  }
}
