/**
 * WordPress auto-apply over the REST API with Application Passwords (Basic auth).
 *
 * Safety model:
 * - A plan lists every change with the live value read from the site ("before").
 * - Dry run prints the plan; nothing is written.
 * - Apply re-reads each value; if it changed since the plan, that change is skipped.
 * - A snapshot of every before-value is written to disk before the first write.
 * - Only the fields in the plan are written; rollback writes the before-values back.
 *
 * SEO fields are written through the AVC helper's `avc_seo` REST field when installed, or
 * through the SEO plugin's post meta when the site exposes it over REST. Image alt text
 * uses the core media endpoint. robots.txt and llms.txt need the helper.
 */
import type { AuditResult, Issue, PageSummary } from '../../core/types.js';
import type { AvcConfig } from '../../core/config.js';
import {
  generateLlmsTxt,
  generateMetaSuggestions,
  generateRobotsTxt,
  inferBrandName,
  type RobotsPolicy,
} from '../generate.js';
import { findRecipe } from '../recipes/index.js';
import { defaultPolicy } from '../recipes/ai-access.js';
import { readJson, snapshotPath, writeJson } from './snapshot.js';
import { WP_HELPER_FILENAME } from './wp-helper.js';

export interface WpCredentials {
  url: string;
  user: string;
  appPassword: string;
}

export type SeoPluginId = 'yoast' | 'rank-math' | 'aioseo' | 'none';

export interface WpSiteInfo {
  url: string;
  name?: string;
  namespaces: string[];
  seoPlugin: SeoPluginId;
  helper: string | null;
  canManageOptions: boolean;
  /** Every active SEO plugin, as reported by the helper (writes are refused when there are two). */
  seoPlugins?: string[];
}

export type WpChangeKind =
  | 'seo-title'
  | 'seo-description'
  | 'noindex'
  | 'canonical'
  | 'image-alt'
  | 'robots-txt'
  | 'llms-txt'
  | 'redirects';

export interface WpChange {
  id: string;
  checkIds: string[];
  kind: WpChangeKind;
  url?: string;
  /** REST route the value is read from and written to, e.g. /wp/v2/pages/12 or /wp/v2/settings */
  route: string;
  /** Dotted path within the resource: avc_seo.title, meta._yoast_wpseo_title, alt_text, avc_robots_txt */
  field: string;
  before: unknown;
  after: unknown;
  via: 'helper' | 'plugin-meta' | 'core';
  note?: string;
}

export interface WpPlan {
  target: 'wordpress';
  site: string;
  createdAt: string;
  info: WpSiteInfo;
  changes: WpChange[];
  skipped: { checkId: string; url?: string; reason: string }[];
}

export interface WpChangeResult {
  change: WpChange;
  status: 'applied' | 'skipped' | 'failed' | 'planned';
  reason?: string;
}

export interface WpSnapshot {
  kind: 'wordpress';
  version: 1;
  site: string;
  user: string;
  createdAt: string;
  results: WpChangeResult[];
}

export interface WpApplyOutcome {
  dryRun: boolean;
  snapshotFile?: string;
  results: WpChangeResult[];
}

type FetchFn = typeof fetch;

export class WpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class WpClient {
  readonly base: string;
  private mode: 'pretty' | 'query' | null = null;
  private fetchFn: FetchFn;
  private auth: string;

  constructor(
    readonly creds: WpCredentials,
    opts: { fetch?: FetchFn; timeoutMs?: number } = {},
  ) {
    this.base = creds.url.replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.auth = 'Basic ' + Buffer.from(`${creds.user}:${creds.appPassword}`).toString('base64');
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }
  private timeoutMs: number;

  private url(route: string, query: Record<string, string | number> = {}): string {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    if (this.mode === 'query') {
      const [path, inner] = route.split('?');
      const params = new URLSearchParams(inner ?? '');
      params.set('rest_route', path);
      for (const [k, v] of qs) params.set(k, v);
      return `${this.base}/?${params}`;
    }
    const s = qs.toString();
    return `${this.base}/wp-json${route}${s ? (route.includes('?') ? '&' : '?') + s : ''}`;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST',
    route: string,
    opts: { query?: Record<string, string | number>; body?: unknown } = {},
  ): Promise<T> {
    if (!this.mode) await this.detectMode();
    const res = await this.fetchFn(this.url(route, opts.query), {
      method,
      headers: {
        authorization: this.auth,
        accept: 'application/json',
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new WpError(
        `Non-JSON response from ${route} (status ${res.status})`,
        res.status,
        text.slice(0, 300),
      );
    }
    if (!res.ok) {
      const msg = (data as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw new WpError(`${method} ${route}: ${msg}`, res.status, data);
    }
    return data as T;
  }

  get<T = unknown>(route: string, query?: Record<string, string | number>): Promise<T> {
    return this.request<T>('GET', route, { query });
  }

  post<T = unknown>(route: string, body: unknown): Promise<T> {
    return this.request<T>('POST', route, { body });
  }

  /** Pretty permalinks (/wp-json/) or the ?rest_route= fallback. */
  private async detectMode(): Promise<void> {
    for (const mode of ['pretty', 'query'] as const) {
      this.mode = mode;
      try {
        const res = await this.fetchFn(this.url('/'), {
          headers: { accept: 'application/json', authorization: this.auth },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const ct = res.headers.get('content-type') ?? '';
        if (res.ok && ct.includes('json')) return;
      } catch {
        /* try next */
      }
    }
    this.mode = 'pretty';
  }

  async discover(): Promise<WpSiteInfo> {
    const root = await this.get<{ name?: string; namespaces?: string[] }>('/');
    const namespaces = root.namespaces ?? [];
    let helper: string | null = null;
    let seoPlugins: string[] | undefined;
    let seoPlugin: SeoPluginId = namespaces.includes('yoast/v1')
      ? 'yoast'
      : namespaces.includes('rankmath/v1')
        ? 'rank-math'
        : namespaces.includes('aioseo/v1')
          ? 'aioseo'
          : 'none';
    if (namespaces.includes('avc/v1')) {
      try {
        const st = await this.get<{
          helper: string;
          seoPlugin: SeoPluginId;
          seoPlugins?: string[];
        }>('/avc/v1/status');
        helper = st.helper;
        if (st.seoPlugin) seoPlugin = st.seoPlugin;
        if (Array.isArray(st.seoPlugins)) seoPlugins = st.seoPlugins;
      } catch {
        /* helper present but not reachable for this user */
      }
    }
    // users/me must work, or the password is wrong
    const me = await this.get<{ capabilities?: Record<string, boolean> }>('/wp/v2/users/me', {
      context: 'edit',
    });
    return {
      url: this.base,
      name: root.name,
      namespaces,
      seoPlugin,
      helper,
      canManageOptions: !!me.capabilities?.manage_options,
      ...(seoPlugins ? { seoPlugins } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Field access
// ---------------------------------------------------------------------------

export function getField(obj: unknown, field: string): unknown {
  let cur: unknown = obj;
  for (const k of field.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Request body that sets only `field`. */
export function bodyFor(field: string, value: unknown): Record<string, unknown> {
  const keys = field.split('.');
  const out: Record<string, unknown> = {};
  let cur = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else {
      cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
  });
  return out;
}

/**
 * Post meta keys used when a site exposes them over REST without the helper. All in One SEO
 * keeps its values in its own table, so it is helper-only.
 */
const PLUGIN_META: Partial<
  Record<SeoPluginId, { title: string; description: string; noindex?: string }>
> = {
  yoast: {
    title: '_yoast_wpseo_title',
    description: '_yoast_wpseo_metadesc',
    noindex: '_yoast_wpseo_meta-robots-noindex',
  },
  'rank-math': { title: 'rank_math_title', description: 'rank_math_description' },
};

function norm(u: string): string {
  try {
    const x = new URL(u);
    return (x.host.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

interface WpObject {
  id: number;
  link?: string;
  meta?: Record<string, unknown>;
  avc_seo?: { title?: string; description?: string; noindex?: boolean; canonical?: string } | null;
}

/** Find the post/page behind a URL. */
export async function resolveUrl(
  client: WpClient,
  url: string,
  info: WpSiteInfo,
): Promise<{ route: string; obj: WpObject } | null> {
  const path = new URL(url).pathname;
  const segs = path.split('/').filter(Boolean);
  if (!segs.length) {
    if (!info.canManageOptions) return null;
    const s = await client.get<{ show_on_front?: string; page_on_front?: number }>(
      '/wp/v2/settings',
    );
    if (s.show_on_front !== 'page' || !s.page_on_front) return null;
    const route = `/wp/v2/pages/${s.page_on_front}`;
    return { route, obj: await client.get<WpObject>(route, { context: 'edit' }) };
  }
  const slug = decodeURIComponent(segs[segs.length - 1]);
  for (const base of ['pages', 'posts']) {
    let list: WpObject[] = [];
    try {
      list = await client.get<WpObject[]>(`/wp/v2/${base}`, {
        slug,
        context: 'edit',
        status: 'publish',
        per_page: 20,
      });
    } catch {
      continue;
    }
    const hit =
      list.find((o) => o.link && norm(o.link) === norm(url)) ??
      (list.length === 1 ? list[0] : undefined);
    if (hit) return { route: `/wp/v2/${base}/${hit.id}`, obj: hit };
  }
  return null;
}

function seoAccess(
  obj: WpObject,
  info: WpSiteInfo,
  what: 'title' | 'description' | 'noindex' | 'canonical',
): { field: string; value: unknown; via: WpChange['via'] } | null {
  if (obj.avc_seo && typeof obj.avc_seo === 'object')
    return {
      field: `avc_seo.${what}`,
      value: obj.avc_seo[what] ?? (what === 'noindex' ? false : ''),
      via: 'helper',
    };
  if (what === 'canonical') return null; // canonical writes need the helper
  const keys = PLUGIN_META[info.seoPlugin];
  if (!keys || !obj.meta) return null;
  const key = keys[what];
  if (!key || !(key in obj.meta)) return null;
  const raw = obj.meta[key];
  return {
    field: `meta.${key}`,
    value: what === 'noindex' ? raw === '1' : (raw ?? ''),
    via: 'plugin-meta',
  };
}

function noindexValue(change: WpChange, noindex: boolean): unknown {
  // Yoast meta: '1' = noindex, '2' = index
  return change.via === 'plugin-meta' ? (noindex ? '1' : '2') : noindex;
}

const IMG_EXT = /\.(jpe?g|png|gif|webp|avif|svg)(\?|$)/i;

/** Image URLs named by an image issue (data.src / data.images / evidence). */
export function imageSrcsFromIssue(issue: Issue): string[] {
  const out: string[] = [];
  const d = issue.data ?? {};
  for (const k of ['src', 'image', 'img', 'url'])
    if (typeof d[k] === 'string') out.push(d[k] as string);
  for (const k of ['images', 'srcs']) {
    const v = d[k];
    if (Array.isArray(v))
      for (const x of v)
        out.push(typeof x === 'string' ? x : String((x as { src?: string })?.src ?? ''));
  }
  if (issue.evidence) {
    for (const m of issue.evidence.matchAll(/src=["']?([^"'\s>]+)/g)) out.push(m[1]);
    for (const m of issue.evidence.matchAll(/https?:\/\/\S+/g))
      out.push(m[0].replace(/[)"'>,]+$/, ''));
  }
  return [...new Set(out.filter((s) => IMG_EXT.test(s)))];
}

/** Alt text from a descriptive file name, or null when the name says nothing (IMG_1234, hashes). */
export function altFromFilename(src: string): string | null {
  const file = decodeURIComponent(
    new URL(src, 'https://x.invalid').pathname.split('/').pop() ?? '',
  );
  let name = file
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/-\d+x\d+$/, '')
    .replace(/-(scaled|rotated|e\d+)$/, '');
  name = name
    .replace(/[-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = name
    .split(' ')
    .filter(
      (w) =>
        /[a-z]{3,}/i.test(w) &&
        !/^(img|dsc|image|photo|screenshot|pxl|whatsapp|copy|final|edited)$/i.test(w),
    );
  if (words.length < 2) return null;
  if (/^[0-9a-f]{12,}$/i.test(name.replace(/\s/g, ''))) return null;
  const text = words.join(' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface WpMedia {
  id: number;
  source_url: string;
  alt_text: string;
  media_details?: { sizes?: Record<string, { source_url: string }> };
}

async function findAttachment(client: WpClient, src: string): Promise<WpMedia | null> {
  const file = new URL(src, 'https://x.invalid').pathname.split('/').pop() ?? '';
  const stem = file
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/-\d+x\d+$/, '')
    .replace(/-scaled$/, '');
  const list = await client.get<WpMedia[]>('/wp/v2/media', {
    search: stem,
    media_type: 'image',
    per_page: 20,
    context: 'edit',
  });
  const target = new URL(src, client.base).pathname
    .replace(/-\d+x\d+(\.[a-z0-9]+)$/i, '$1')
    .replace(/-scaled(\.[a-z0-9]+)$/i, '$1');
  for (const m of list) {
    const urls = [
      m.source_url,
      ...Object.values(m.media_details?.sizes ?? {}).map((s) => s.source_url),
    ];
    if (urls.some((u) => new URL(u, client.base).pathname === new URL(src, client.base).pathname))
      return m;
    if (
      new URL(m.source_url, client.base).pathname.replace(/-scaled(\.[a-z0-9]+)$/i, '$1') === target
    )
      return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface WpPlanOptions {
  only?: string[];
  config?: Pick<AvcConfig, 'ai'>;
  brand?: string;
  robotsPolicy?: RobotsPolicy;
  /** Max pages per check (default 50). */
  maxPages?: number;
}

function wanted(only: string[] | undefined, checkId: string, recipeId: string): boolean {
  if (!only?.length) return true;
  return only.some((o) => {
    const re = new RegExp(
      '^' +
        o
          .split('*')
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    );
    return re.test(checkId) || re.test(recipeId);
  });
}

export async function planWordPressFixes(
  result: AuditResult,
  client: WpClient,
  opts: WpPlanOptions = {},
): Promise<WpPlan> {
  const info = await client.discover();
  const plan: WpPlan = {
    target: 'wordpress',
    site: result.site,
    createdAt: new Date().toISOString(),
    info,
    changes: [],
    skipped: [],
  };
  const brand = opts.brand ?? inferBrandName({ site: result.site, pages: result.pages });
  const maxPages = opts.maxPages ?? 50;
  const byCheck = new Map<string, Issue[]>();
  for (const i of result.issues) byCheck.set(i.checkId, [...(byCheck.get(i.checkId) ?? []), i]);
  const pageOf = (u: string): PageSummary | undefined =>
    result.pages.find((p) => p.url === u || p.finalUrl === u);
  const objects = new Map<string, { route: string; obj: WpObject } | null>();
  const resolve = async (u: string) => {
    if (!objects.has(u)) {
      try {
        objects.set(u, await resolveUrl(client, u, info));
      } catch {
        objects.set(u, null);
      }
    }
    return objects.get(u)!;
  };
  const add = (c: Omit<WpChange, 'id'>) => {
    const existing = plan.changes.find((x) => x.route === c.route && x.field === c.field);
    if (existing) {
      for (const id of c.checkIds) if (!existing.checkIds.includes(id)) existing.checkIds.push(id);
      return;
    }
    plan.changes.push({ ...c, id: `c${plan.changes.length + 1}` });
  };
  const helperHint = `install the AVC helper (wp-content/mu-plugins/${WP_HELPER_FILENAME}; \`avc fix --wp-helper\` prints it)`;

  // Two SEO plugins fighting over the same tags: never write SEO fields (ambiguous result).
  const twoSeoPlugins = (info.seoPlugins?.length ?? 0) > 1;
  if (twoSeoPlugins)
    plan.skipped.push({
      checkId: 'cms.wp-seo-plugin-conflict',
      reason: `${info.seoPlugins!.join(' and ')} are both active; SEO field writes are refused until one is deactivated`,
    });

  for (const [checkId, issues] of byCheck) {
    const recipe = findRecipe(checkId);
    // Canonical clean-ups: set the page's own clean URL as its canonical (helper only).
    if (
      CANONICAL_SELF.has(checkId) &&
      wanted(opts.only, checkId, 'canonical-self') &&
      !twoSeoPlugins
    ) {
      for (const u of [...new Set(issues.map((i) => i.url).filter((x): x is string => !!x))].slice(
        0,
        maxPages,
      )) {
        const target = cleanSelfUrl(pageOf(u)?.finalUrl ?? u);
        const hit = await resolve(u);
        if (!hit) {
          plan.skipped.push({ checkId, url: u, reason: 'no matching post or page found' });
          continue;
        }
        const acc = seoAccess(hit.obj, info, 'canonical');
        if (!acc) {
          plan.skipped.push({
            checkId,
            url: u,
            reason: `canonical is not writable over REST — ${helperHint}`,
          });
          continue;
        }
        if (String(acc.value ?? '') === target) continue;
        add({
          checkIds: [checkId],
          kind: 'canonical',
          url: u,
          route: hit.route,
          field: acc.field,
          before: acc.value ?? '',
          after: target,
          via: acc.via,
        });
      }
      continue;
    }
    if (!recipe.auto?.wordpress || !wanted(opts.only, checkId, recipe.id)) continue;
    if (twoSeoPlugins && recipe.id !== 'images-alt' && !/robots|llms/.test(recipe.id)) continue;
    const urls = [...new Set(issues.map((i) => i.url).filter((u): u is string => !!u))].slice(
      0,
      maxPages,
    );

    if (recipe.id === 'titles' || recipe.id === 'descriptions') {
      const what = recipe.id === 'titles' ? 'title' : 'description';
      for (const u of urls) {
        const hit = await resolve(u);
        if (!hit) {
          plan.skipped.push({
            checkId,
            url: u,
            reason:
              'not a post or page this user can edit (archives and the posts page are set in the SEO plugin)',
          });
          continue;
        }
        const acc = seoAccess(hit.obj, info, what);
        if (!acc) {
          plan.skipped.push({
            checkId,
            url: u,
            reason: `${info.seoPlugin === 'none' ? 'no SEO plugin field' : `${info.seoPlugin} fields are not exposed over REST`} — ${helperHint}`,
          });
          continue;
        }
        const p = pageOf(u);
        const sug = await generateMetaSuggestions(
          {
            url: u,
            title: p?.title ?? null,
            metaDescription: p?.metaDescription ?? null,
            h1: p?.h1,
          },
          // the check already decided the value is a problem, so always propose one
          { brand, config: opts.config, force: true },
        );
        const value = what === 'title' ? sug.title?.suggested : sug.description?.suggested;
        if (!value) {
          plan.skipped.push({
            checkId,
            url: u,
            reason:
              what === 'description'
                ? 'no page text to summarise; write it by hand'
                : 'current value is fine',
          });
          continue;
        }
        if (value === acc.value) continue;
        add({
          checkIds: [checkId],
          kind: what === 'title' ? 'seo-title' : 'seo-description',
          url: u,
          route: hit.route,
          field: acc.field,
          before: acc.value,
          after: value,
          via: acc.via,
          note: sug.source === 'model' ? 'written by model' : 'rule-based draft',
        });
      }
    } else if (recipe.id === 'noindex') {
      if (/header|staging|snippet|preview|nofollow|unavailable/.test(checkId)) {
        plan.skipped.push({ checkId, reason: 'not a per-page SEO field; follow the guided fix' });
        continue;
      }
      for (const u of urls) {
        const hit = await resolve(u);
        const acc = hit ? seoAccess(hit.obj, info, 'noindex') : null;
        if (!hit || !acc) {
          plan.skipped.push({
            checkId,
            url: u,
            reason: hit
              ? `noindex field not writable — ${helperHint}`
              : 'page not found in WordPress',
          });
          continue;
        }
        if (acc.value !== true) {
          plan.skipped.push({
            checkId,
            url: u,
            reason:
              'the page-level setting is already "index"; noindex comes from a template or plugin default',
          });
          continue;
        }
        const change: Omit<WpChange, 'id'> = {
          checkIds: [checkId],
          kind: 'noindex',
          url: u,
          route: hit.route,
          field: acc.field,
          before: null,
          after: null,
          via: acc.via,
          note: 'turns noindex off for this page — check it is meant to be public',
        };
        add({
          ...change,
          before: noindexValue(change as WpChange, true),
          after: noindexValue(change as WpChange, false),
        });
      }
    } else if (recipe.id === 'images-alt') {
      for (const issue of issues.slice(0, maxPages * 2)) {
        for (const src of imageSrcsFromIssue(issue)) {
          let media: WpMedia | null = null;
          try {
            media = await findAttachment(client, src);
          } catch {
            media = null;
          }
          if (!media) {
            plan.skipped.push({
              checkId,
              url: src,
              reason: 'image is not in the Media Library (theme or external image)',
            });
            continue;
          }
          if (media.alt_text?.trim()) continue;
          const alt = altFromFilename(media.source_url) ?? altFromFilename(src);
          if (!alt) {
            plan.skipped.push({
              checkId,
              url: src,
              reason: 'file name does not describe the image; needs a human description',
            });
            continue;
          }
          add({
            checkIds: [checkId],
            kind: 'image-alt',
            url: src,
            route: `/wp/v2/media/${media.id}`,
            field: 'alt_text',
            before: media.alt_text ?? '',
            after: alt,
            via: 'core',
            note: `from the file name; check it fits the image (shown on ${issue.url ?? 'the page'})`,
          });
        }
      }
    } else if (['ai-robots', 'content-signal', 'robots-missing', 'llms-txt'].includes(recipe.id)) {
      if (!info.helper) {
        plan.skipped.push({
          checkId,
          reason: `${recipe.id === 'llms-txt' ? 'llms.txt' : 'robots.txt'} needs the AVC helper — ${helperHint}; or use the guided fix`,
        });
        continue;
      }
      if (!info.canManageOptions) {
        plan.skipped.push({
          checkId,
          reason: 'this user cannot change site settings (needs an administrator)',
        });
        continue;
      }
      const settings = await client.get<Record<string, unknown>>('/wp/v2/settings');
      if (recipe.id === 'llms-txt') {
        const after = generateLlmsTxt({ site: result.site, pages: result.pages }, { name: brand });
        add({
          checkIds: [checkId],
          kind: 'llms-txt',
          route: '/wp/v2/settings',
          field: 'avc_llms_txt',
          before: settings.avc_llms_txt ?? '',
          after,
          via: 'helper',
        });
      } else {
        const stored = String(settings.avc_robots_txt ?? '');
        const current = stored || (result.robots.found ? result.robots.body : '');
        const policy = opts.robotsPolicy ?? defaultPolicy(current);
        const after = generateRobotsTxt(current, policy, {
          sitemaps: result.sitemaps
            .filter((s) => s.found)
            .map((s) => s.url)
            .slice(0, 5),
          ...(recipe.id === 'content-signal'
            ? {
                contentSignal: {
                  search: 'yes',
                  'ai-input': 'yes',
                  'ai-train': policy === 'allow-all-ai' ? 'yes' : 'no',
                } as const,
              }
            : {}),
        });
        const prev = plan.changes.find((c) => c.field === 'avc_robots_txt');
        if (prev) {
          // a second robots recipe builds on the first one's output
          prev.after = generateRobotsTxt(
            String(prev.after),
            policy,
            recipe.id === 'content-signal'
              ? {
                  contentSignal: {
                    search: 'yes',
                    'ai-input': 'yes',
                    'ai-train': policy === 'allow-all-ai' ? 'yes' : 'no',
                  },
                }
              : {},
          );
          prev.checkIds.push(checkId);
        } else
          add({
            checkIds: [checkId],
            kind: 'robots-txt',
            route: '/wp/v2/settings',
            field: 'avc_robots_txt',
            before: stored,
            after,
            via: 'helper',
            note: stored
              ? undefined
              : 'stored by the helper; it replaces the generated robots.txt (a physical robots.txt file still wins)',
          });
      }
    }
  }
  return plan;
}

/** Canonical problems fixed by declaring the page's own clean URL. */
export const CANONICAL_SELF = new Set([
  'canonical.relative',
  'canonical.has-fragment',
  'canonical.empty',
  'canonical.keeps-parameters',
  'canonical.host-or-protocol-variant',
]);

const TRACKING =
  /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|ref|replytocom|sessionid|sid|phpsessid)$/i;

/** The page URL without a fragment or tracking/session parameters. */
export function cleanSelfUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (TRACKING.test(k)) x.searchParams.delete(k);
    return x.toString();
  } catch {
    return u;
  }
}

export interface WpRedirect {
  from: string;
  to: string;
  code?: 301 | 302 | 307 | 308;
}

/** A plan with one change: add (or replace) a redirect in the helper's redirect list. */
export async function planWordPressRedirect(
  client: WpClient,
  site: string,
  redirect: WpRedirect,
): Promise<WpPlan> {
  const info = await client.discover();
  const plan: WpPlan = {
    target: 'wordpress',
    site,
    createdAt: new Date().toISOString(),
    info,
    changes: [],
    skipped: [],
  };
  const from = (() => {
    try {
      return new URL(redirect.from, site).pathname;
    } catch {
      return redirect.from;
    }
  })();
  if (!info.helper || !info.canManageOptions) {
    plan.skipped.push({
      checkId: 'redirect',
      url: from,
      reason: !info.helper
        ? `redirects need the AVC helper (wp-content/mu-plugins/${WP_HELPER_FILENAME}) version 1.1 or later`
        : 'this user cannot manage options (needs an administrator)',
    });
    return plan;
  }
  const settings = await client.get<Record<string, unknown>>('/wp/v2/settings');
  const before = String(settings.avc_redirects ?? '');
  let list: WpRedirect[] = [];
  try {
    list = before ? (JSON.parse(before) as WpRedirect[]) : [];
  } catch {
    list = [];
  }
  const next = [
    ...list.filter((r) => r.from !== from),
    { from, to: redirect.to, code: redirect.code ?? 301 },
  ];
  plan.changes.push({
    id: 'c1',
    checkIds: ['redirect'],
    kind: 'redirects',
    url: from,
    route: '/wp/v2/settings',
    field: 'avc_redirects',
    before,
    after: JSON.stringify(next),
    via: 'helper',
    note: `${redirect.code ?? 301} ${from} → ${redirect.to}`,
  });
  return plan;
}

// ---------------------------------------------------------------------------
// Apply, render, rollback
// ---------------------------------------------------------------------------

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
}

async function readCurrent(client: WpClient, c: WpChange): Promise<unknown> {
  const obj = await client.get(
    c.route,
    c.route === '/wp/v2/settings' ? undefined : { context: 'edit' },
  );
  const v = getField(obj, c.field);
  if (c.kind === 'noindex' && c.via === 'helper') return v ?? false;
  return v ?? '';
}

export async function applyWordPressPlan(
  plan: WpPlan,
  client: WpClient,
  opts: { dryRun: boolean; dataDir: string },
): Promise<WpApplyOutcome> {
  if (opts.dryRun)
    return { dryRun: true, results: plan.changes.map((change) => ({ change, status: 'planned' })) };
  const results: WpChangeResult[] = [];
  const toWrite: WpChange[] = [];
  for (const c of plan.changes) {
    try {
      const now = await readCurrent(client, c);
      if (!same(now, c.before)) {
        results.push({
          change: c,
          status: 'skipped',
          reason: 'value changed since the plan was made; re-run the plan',
        });
        continue;
      }
      toWrite.push(c);
    } catch (e) {
      results.push({ change: c, status: 'failed', reason: (e as Error).message });
    }
  }
  const snapshotFile = snapshotPath(opts.dataDir, plan.site);
  const snapshot: WpSnapshot = {
    kind: 'wordpress',
    version: 1,
    site: plan.site,
    user: client.creds.user,
    createdAt: new Date().toISOString(),
    results: [...results, ...toWrite.map((change) => ({ change, status: 'planned' as const }))],
  };
  writeJson(snapshotFile, snapshot); // before any write
  for (const c of toWrite) {
    let r: WpChangeResult;
    try {
      await client.post(c.route, bodyFor(c.field, c.after));
      const now = await readCurrent(client, c);
      r = same(now, c.after)
        ? { change: c, status: 'applied' }
        : {
            change: c,
            status: 'failed',
            reason: `wrote the value but read back ${JSON.stringify(now)}; the field may not be writable over REST`,
          };
    } catch (e) {
      r = { change: c, status: 'failed', reason: (e as Error).message };
    }
    results.push(r);
    snapshot.results = snapshot.results.map((x) => (x.change.id === c.id ? r : x));
    writeJson(snapshotFile, snapshot);
  }
  return { dryRun: false, snapshotFile, results };
}

function show(v: unknown): string {
  if (typeof v === 'string')
    return v.includes('\n')
      ? `\n${v
          .split('\n')
          .map((l) => '      ' + l)
          .join('\n')}`
      : JSON.stringify(v);
  return JSON.stringify(v);
}

/** Human-readable plan / outcome, one block per change. */
export function renderWpPlan(plan: WpPlan, results?: WpChangeResult[]): string {
  const lines = [
    `WordPress: ${plan.info.url} (${plan.info.seoPlugin === 'none' ? 'no SEO plugin' : plan.info.seoPlugin}${plan.info.helper ? `, AVC helper ${plan.info.helper}` : ', no AVC helper'})`,
    `${plan.changes.length} change(s), ${plan.skipped.length} skipped`,
    '',
  ];
  for (const c of plan.changes) {
    const r = results?.find((x) => x.change.id === c.id);
    lines.push(
      `${r ? `[${r.status}] ` : ''}${c.kind}  ${c.url ?? c.route}  (${c.field} via ${c.via})`,
    );
    lines.push(`  - ${show(c.before)}`, `  + ${show(c.after)}`);
    if (c.note) lines.push(`  note: ${c.note}`);
    if (r?.reason) lines.push(`  ${r.reason}`);
  }
  if (plan.skipped.length) {
    lines.push('', 'Skipped:');
    for (const s of plan.skipped.slice(0, 50))
      lines.push(`  ${s.checkId}${s.url ? ` ${s.url}` : ''}: ${s.reason}`);
  }
  return lines.join('\n');
}

export async function rollbackWordPress(
  snapshotFile: string,
  client: WpClient,
  opts: { force?: boolean; dryRun?: boolean } = {},
): Promise<WpChangeResult[]> {
  const snap = readJson<WpSnapshot>(snapshotFile);
  if (snap.kind !== 'wordpress') throw new Error(`${snapshotFile} is not a WordPress snapshot`);
  const out: WpChangeResult[] = [];
  for (const r of [...snap.results].reverse()) {
    if (r.status !== 'applied') continue;
    const c = r.change;
    try {
      const now = await readCurrent(client, c);
      if (!opts.force && !same(now, c.after)) {
        out.push({
          change: c,
          status: 'skipped',
          reason: 'changed again since AVC wrote it; use --force to restore anyway',
        });
        continue;
      }
      if (opts.dryRun) {
        out.push({ change: c, status: 'planned' });
        continue;
      }
      await client.post(c.route, bodyFor(c.field, c.before));
      out.push({ change: c, status: 'applied' });
    } catch (e) {
      out.push({ change: c, status: 'failed', reason: (e as Error).message });
    }
  }
  return out;
}
