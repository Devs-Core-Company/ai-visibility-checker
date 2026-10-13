/**
 * WordPress connection test over the REST API with an Application Password.
 * Read-only: finds the REST root, the WordPress version, what the user may do
 * and which SEO plugin is active. Applying fixes lives in src/fixes.
 */
import { ConnectError, type FetchFn } from './google-api.js';

export interface WordPressCredentials {
  url: string;
  user: string;
  appPassword?: string;
}

export interface WordPressCheck {
  ok: boolean;
  url: string;
  restUrl: string | null;
  siteName?: string;
  version?: string;
  user?: { id: number; name: string; slug?: string; roles: string[] };
  can: { editPosts: boolean; editPages: boolean; manageOptions: boolean; uploadFiles: boolean };
  seoPlugin?: 'yoast' | 'rank-math' | 'aioseo' | 'seopress' | 'the-seo-framework' | 'slim-seo';
  namespaces: string[];
  problems: string[];
}

const SEO_NAMESPACES: [string, NonNullable<WordPressCheck['seoPlugin']>][] = [
  ['yoast/v1', 'yoast'],
  ['rankmath/v1', 'rank-math'],
  ['aioseo/v1', 'aioseo'],
  ['seopress/v1', 'seopress'],
  ['tsf/v1', 'the-seo-framework'],
  ['slim-seo', 'slim-seo'],
];

export function detectSeoPlugin(namespaces: string[]): WordPressCheck['seoPlugin'] {
  for (const [ns, id] of SEO_NAMESPACES) if (namespaces.some((n) => n.startsWith(ns))) return id;
  return undefined;
}

async function getJson(
  f: FetchFn,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: unknown; text: string; headers: Headers }> {
  const res = await f(url, {
    headers: { accept: 'application/json', ...headers },
    redirect: 'follow',
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

function restRoute(restUrl: string, route: string): string {
  // restUrl is either https://site/wp-json/ or https://site/?rest_route=/
  if (restUrl.includes('rest_route='))
    return `${restUrl.replace(/\/$/, '')}${route.replace('?', '&')}`;
  return `${restUrl.replace(/\/$/, '')}${route}`;
}

/** Test a WordPress connection. Never throws for site problems; they go to `problems`. */
export async function checkWordPress(
  creds: WordPressCredentials,
  opts: { fetch?: FetchFn } = {},
): Promise<WordPressCheck> {
  const f = opts.fetch ?? fetch;
  const site = creds.url.replace(/\/+$/, '');
  const out: WordPressCheck = {
    ok: false,
    url: site,
    restUrl: null,
    namespaces: [],
    can: { editPosts: false, editPages: false, manageOptions: false, uploadFiles: false },
    problems: [],
  };
  const password = creds.appPassword ?? process.env.AVC_WP_APP_PASSWORD;
  const auth: Record<string, string> = password
    ? {
        authorization: `Basic ${Buffer.from(`${creds.user}:${password.replace(/\s+/g, '')}`).toString('base64')}`,
      }
    : {};

  // 1. REST root (pretty permalinks first, then the ?rest_route= fallback).
  type RestIndex = { name?: string; namespaces?: string[] };
  let index: RestIndex | null = null;
  for (const candidate of [`${site}/wp-json/`, `${site}/?rest_route=/`]) {
    try {
      const r = await getJson(f, candidate, {});
      if (r.status === 200 && r.json && typeof r.json === 'object' && 'namespaces' in r.json) {
        index = r.json as RestIndex;
        out.restUrl = candidate;
        break;
      }
    } catch (e) {
      out.problems.push(`Could not reach ${candidate}: ${(e as Error).message}`);
    }
  }
  if (!index || !out.restUrl) {
    out.problems.push(
      'The WordPress REST API was not found. Check the URL is the WordPress site, and that no security plugin or firewall blocks /wp-json/.',
    );
    return out;
  }
  out.siteName = index.name;
  out.namespaces = index.namespaces ?? [];
  out.seoPlugin = detectSeoPlugin(out.namespaces);

  // 2. Version: meta generator on the home page, then the RSS feed.
  out.version = await detectVersion(f, site);

  // 3. Who am I, and what may I do.
  if (!password) {
    out.problems.push(
      'No Application Password set. In WordPress → Users → Profile → Application Passwords, create one and set it as connections.wordpress.appPassword or AVC_WP_APP_PASSWORD.',
    );
    return out;
  }
  try {
    const me = await getJson(f, restRoute(out.restUrl, '/wp/v2/users/me?context=edit'), auth);
    if (me.status === 401 || me.status === 403) {
      const code = (me.json as { code?: string } | null)?.code ?? '';
      if (code === 'rest_not_logged_in' || code === '') {
        out.problems.push(
          'WordPress did not receive the login. Some hosts strip the Authorization header; add "SetEnvIf Authorization \\"(.*)\\" HTTP_AUTHORIZATION=$1" to .htaccess, or ask your host to pass it through.',
        );
      } else {
        out.problems.push(
          `WordPress refused the Application Password (${code}). Check the username (not the email) and create a new Application Password.`,
        );
      }
      return out;
    }
    if (me.status !== 200 || !me.json) {
      out.problems.push(`WordPress /users/me returned HTTP ${me.status}.`);
      return out;
    }
    const u = me.json as {
      id: number;
      name: string;
      slug?: string;
      roles?: string[];
      capabilities?: Record<string, boolean>;
    };
    out.user = { id: u.id, name: u.name, slug: u.slug, roles: u.roles ?? [] };
    const caps = u.capabilities ?? {};
    out.can = {
      editPosts: !!caps.edit_posts,
      editPages: !!caps.edit_pages,
      manageOptions: !!caps.manage_options,
      uploadFiles: !!caps.upload_files,
    };
    if (!out.can.editPosts) {
      out.problems.push(
        'This user cannot edit posts, so fixes cannot be applied. Use an Editor or Administrator account.',
      );
    }
    out.ok = true;
  } catch (e) {
    out.problems.push(`Could not check the WordPress user: ${(e as Error).message}`);
  }
  return out;
}

async function detectVersion(f: FetchFn, site: string): Promise<string | undefined> {
  const grab = async (url: string, re: RegExp) => {
    try {
      const res = await f(url, { redirect: 'follow' });
      if (!res.ok) return undefined;
      return re.exec(await res.text())?.[1];
    } catch {
      return undefined;
    }
  };
  return (
    (await grab(
      `${site}/`,
      /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s+([\d.]+)/i,
    )) ??
    (await grab(
      `${site}/feed/`,
      /<generator>https?:\/\/wordpress\.org\/\?v=([\d.]+)<\/generator>/i,
    ))
  );
}

/** Throwing variant for CLI flows: returns the check when it is usable. */
export async function requireWordPress(
  creds: WordPressCredentials,
  opts: { fetch?: FetchFn } = {},
): Promise<WordPressCheck> {
  const r = await checkWordPress(creds, opts);
  if (!r.ok)
    throw new ConnectError(`WordPress connection failed for ${creds.url}.`, r.problems.join(' '));
  return r;
}
