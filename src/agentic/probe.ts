/**
 * Agentic-web origin probe. One pass of GET requests (never POST) for the
 * files and endpoints AI crawlers and agents look for, bounded to ~30
 * requests with four in flight. Fills site.probes keyed by probe id.
 *
 * Probe ids (stable; checks key on them):
 *   llms-txt, llms-full-txt, mcp-json, mcp-server-card, a2a-agent-card,
 *   a2a-agent-json, oauth-as, oauth-prm, openid-config, api-catalog,
 *   openapi-json, openapi-yaml, openapi-linked, web-bot-auth, ai-plugin,
 *   ai-txt, security-txt, nlweb-ask, md-home, md-article, md-suffix,
 *   feed, x402-discovery, x402-resource, ucp-profile,
 *   robots-ai-signals (no request), link-headers (no request)
 */
import type { FetchResult, PageData, ProbeResult, SiteContext } from '../core/types.js';
import {
  homePage,
  isArticleLike,
  isJsonType,
  looksHtml,
  mapLimit,
  parseRobots,
  safeUrl,
  topLinkedPages,
} from '../checks/_ai-util.js';
import { parseLlmsTxt } from './llms.js';
import { parseAiPreference, validateApiCatalog } from './validate.js';

const CONCURRENCY = 4;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const BODY_KEEP = 20 * 1024;

type Kind = 'json' | 'text' | 'markdown' | 'feed' | 'any';

interface Spec {
  id: string;
  path: string;
  kind: Kind;
  headers?: Record<string, string>;
  /** Treat a 402 as found (x402). */
  accept402?: boolean;
}

const ACCEPT: Record<Kind, string> = {
  json: 'application/json, application/linkset+json;q=0.9, */*;q=0.5',
  text: 'text/plain, text/markdown;q=0.9, */*;q=0.5',
  markdown: 'text/markdown',
  feed: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, */*;q=0.5',
  any: '*/*',
};

const FIXED: Spec[] = [
  { id: 'llms-txt', path: '/llms.txt', kind: 'text' },
  { id: 'llms-full-txt', path: '/llms-full.txt', kind: 'text' },
  { id: 'mcp-json', path: '/.well-known/mcp.json', kind: 'json' },
  { id: 'mcp-server-card', path: '/.well-known/mcp/server-card.json', kind: 'json' },
  { id: 'a2a-agent-card', path: '/.well-known/agent-card.json', kind: 'json' },
  { id: 'a2a-agent-json', path: '/.well-known/agent.json', kind: 'json' },
  { id: 'oauth-as', path: '/.well-known/oauth-authorization-server', kind: 'json' },
  { id: 'oauth-prm', path: '/.well-known/oauth-protected-resource', kind: 'json' },
  { id: 'openid-config', path: '/.well-known/openid-configuration', kind: 'json' },
  {
    id: 'api-catalog',
    path: '/.well-known/api-catalog',
    kind: 'json',
    headers: { accept: 'application/linkset+json, application/json;q=0.9' },
  },
  { id: 'openapi-json', path: '/openapi.json', kind: 'json' },
  { id: 'openapi-yaml', path: '/openapi.yaml', kind: 'text' },
  { id: 'web-bot-auth', path: '/.well-known/http-message-signatures-directory', kind: 'json' },
  { id: 'ai-plugin', path: '/.well-known/ai-plugin.json', kind: 'json' },
  { id: 'ai-txt', path: '/ai.txt', kind: 'text' },
  { id: 'security-txt', path: '/.well-known/security.txt', kind: 'text' },
  // NLWeb's /ask is a GET endpoint; with no query it should answer with a JSON error, which is enough to recognise it.
  { id: 'nlweb-ask', path: '/ask', kind: 'json' },
  { id: 'x402-discovery', path: '/.well-known/x402', kind: 'json' },
  { id: 'ucp-profile', path: '/.well-known/ucp', kind: 'json' },
];

function failed(id: string, url: string, error: string): ProbeResult {
  return { id, url, status: null, found: false, error };
}

function judge(spec: Spec, res: FetchResult): { found: boolean; parsed?: unknown } {
  const ok = (res.status >= 200 && res.status < 300) || (spec.accept402 && res.status === 402);
  if (!ok) return { found: false };
  const body = res.body ?? '';
  const ct = res.contentType || res.headers?.['content-type'] || '';
  switch (spec.kind) {
    case 'json': {
      if (looksHtml(body, ct)) return { found: false };
      try {
        return { found: true, parsed: JSON.parse(body) };
      } catch {
        // Served, but not JSON. Found-but-invalid is a finding of its own.
        return { found: body.trim().length > 0 && isJsonType(ct), parsed: undefined };
      }
    }
    case 'text':
      return { found: body.trim().length > 0 && !looksHtml(body, ct) };
    case 'markdown': {
      const isMd = /markdown/i.test(ct) || (/text\/plain/i.test(ct) && !looksHtml(body));
      return { found: isMd && body.trim().length > 0 };
    }
    case 'feed':
      return { found: /<(rss|feed|rdf:RDF)[\s>]/i.test(body) || /jsonfeed/i.test(body) };
    default:
      return { found: true };
  }
}

async function run(site: SiteContext, spec: Spec): Promise<ProbeResult> {
  const url = safeUrl(spec.path, site.origin)?.toString() ?? `${site.origin}${spec.path}`;
  try {
    const res = await site.fetcher.fetch(url, {
      headers: { accept: ACCEPT[spec.kind], ...spec.headers },
      timeoutMs: Math.min(site.options?.timeoutMs ?? TIMEOUT_MS, TIMEOUT_MS),
      maxBytes: MAX_BYTES,
    });
    const { found, parsed } = judge(spec, res);
    const out: ProbeResult = {
      id: spec.id,
      url,
      status: res.status || null,
      found,
      contentType: res.contentType || res.headers?.['content-type'],
      bytes: res.bytes,
      body: (res.body ?? '').slice(0, BODY_KEEP),
      headers: res.headers,
      ...(res.error ? { error: res.error } : {}),
    };
    if (parsed !== undefined) out.parsed = parsed;
    if (found && spec.id === 'llms-txt')
      out.parsed = parseLlmsTxt(res.body ?? '', res.finalUrl || url);
    if (res.finalUrl && res.finalUrl !== url)
      out.headers = { ...res.headers, 'x-avc-final-url': res.finalUrl };
    if (res.truncated) out.headers = { ...out.headers, 'x-avc-truncated': '1' };
    return out;
  } catch (e) {
    return failed(spec.id, url, e instanceof Error ? e.message : String(e));
  }
}

/** Parse a Link header into rel → hrefs. */
export function parseLinkHeader(value: string | undefined, base: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!value) return out;
  for (const m of value.matchAll(/<([^>]+)>\s*((?:;\s*[^;,]+)*)/g)) {
    const href = safeUrl(m[1]!, base)?.toString() ?? m[1]!;
    const rel = m[2]!.match(/rel\s*=\s*"?([^";]+)"?/i)?.[1];
    if (!rel) continue;
    for (const r of rel.toLowerCase().split(/\s+/)) (out[r] ??= []).push(href);
  }
  return out;
}

function pickArticle(site: SiteContext): PageData | undefined {
  const home = homePage(site);
  const candidates = [...site.pages.values()].filter(
    (p) => p !== home && p.isHtml && p.status === 200,
  );
  return candidates.find(isArticleLike) ?? topLinkedPages(site, 1)[0];
}

function feedUrl(home: PageData | undefined): string | null {
  if (!home?.html) return null;
  const m = home.html.match(/<link\b[^>]*type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i)?.[0];
  const href = m?.match(/href=["']([^"']+)["']/i)?.[1];
  return href ? (safeUrl(href, home.finalUrl || home.url)?.toString() ?? null) : null;
}

/**
 * Run every probe and fill site.probes. Never throws; failures are recorded
 * on the ProbeResult (status null, error set).
 */
export async function runAgenticProbes(site: SiteContext): Promise<void> {
  if (!site.probes) site.probes = new Map();
  const home = homePage(site);
  const article = pickArticle(site);
  const specs: Spec[] = [...FIXED];

  // Markdown negotiation and .md variants.
  specs.push({ id: 'md-home', path: new URL(site.startUrl).pathname || '/', kind: 'markdown' });
  if (article) {
    const u = new URL(article.finalUrl || article.url);
    specs.push({ id: 'md-article', path: u.pathname + u.search, kind: 'markdown' });
    const p = u.pathname.replace(/\/$/, '') || '/index';
    specs.push({
      id: 'md-suffix',
      path: `${p}.md`,
      kind: 'text',
      headers: { accept: 'text/markdown, text/plain;q=0.9' },
    });
  }

  // Feed: advertised link first, else the common default.
  const advertised = feedUrl(home);
  specs.push({
    id: 'feed',
    path: advertised ? new URL(advertised).pathname + new URL(advertised).search : '/feed',
    kind: 'feed',
  });

  const results = await mapLimit(specs, CONCURRENCY, (s) => run(site, s));
  for (const r of results) site.probes.set(r.id, r);

  // Second round (at most two requests): an OpenAPI description the catalog
  // points to, and a paid resource the x402 discovery file lists.
  const follow: Spec[] = [];
  const catalog = site.probes.get('api-catalog');
  if (catalog?.found) {
    const v = validateApiCatalog(catalog.parsed, catalog.contentType);
    const desc = (v.info.serviceDescs as string[] | undefined)?.[0];
    const u = desc ? safeUrl(desc, site.origin) : null;
    if (u && u.origin === site.origin)
      follow.push({ id: 'openapi-linked', path: u.pathname + u.search, kind: 'json' });
  }
  const x402 = site.probes.get('x402-discovery');
  if (x402?.found && x402.parsed && typeof x402.parsed === 'object') {
    const p = x402.parsed as Record<string, unknown>;
    const list = (p.resources ?? p.items ?? p.endpoints) as unknown;
    const first = Array.isArray(list) ? list[0] : undefined;
    const href =
      typeof first === 'string'
        ? first
        : ((first as Record<string, unknown> | undefined)?.resource ??
          (first as Record<string, unknown> | undefined)?.url);
    const u = typeof href === 'string' ? safeUrl(href, site.origin) : null;
    if (u && u.origin === site.origin)
      follow.push({
        id: 'x402-resource',
        path: u.pathname + u.search,
        kind: 'json',
        accept402: true,
      });
  }
  for (const r of await mapLimit(follow, 2, (s) => run(site, s))) site.probes.set(r.id, r);

  // No-request probes derived from data we already have.
  const robots = parseRobots(site.robots?.found ? site.robots.body : '');
  const prefs = robots.extras
    .map((x) => parseAiPreference(x.key, x.value, x.line))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  site.probes.set('robots-ai-signals', {
    id: 'robots-ai-signals',
    url: site.robots?.url ?? `${site.origin}/robots.txt`,
    status: site.robots?.status ?? null,
    found: prefs.length > 0,
    parsed: prefs,
  });

  const headers = home?.headers ?? site.browserFetch?.headers ?? {};
  const links = parseLinkHeader(headers['link'], site.origin);
  site.probes.set('link-headers', {
    id: 'link-headers',
    url: home?.finalUrl ?? site.startUrl,
    status: home?.status ?? null,
    found: Object.keys(links).length > 0,
    parsed: links,
    headers: headers['link'] ? { link: headers['link'] } : {},
  });
}
