/**
 * Agentic-web readiness (pillar 'agentic'; categories 'agentic' and
 * 'agentic-commerce'): can AI agents discover, understand and act on the site?
 *
 * Maturity, stated honestly in each finding (October 2026):
 * - Stable standards: OAuth AS metadata (RFC 8414), protected resource metadata
 *   (RFC 9728), OpenID Discovery, api-catalog (RFC 9727), OpenAPI, schema.org
 *   actions, RSS/Atom, accessible forms.
 * - Specified and in real use, still evolving: MCP (authorisation builds on
 *   RFC 9728), A2A agent cards.
 * - Drafts and proposals: MCP server cards, Web Bot Auth, WebMCP, Content
 *   Signals / IETF aipref, markdown negotiation, NLWeb, x402, ACP, UCP.
 * Missing emerging pieces are 'info' and never scored as failures of a basic
 * business site.
 */
import type { Check, Issue, PageData, ProbeResult, SiteContext } from '../core/types.js';
import { botByToken } from '../agentic/bots.js';
import {
  validateAgentCard,
  validateApiCatalog,
  validateMcpCard,
  validateOAuthAS,
  validateOpenApi,
  validateOpenId,
  validatePRM,
  validateSignatureDirectory,
  validateUcpProfile,
  validateX402,
  inspectFeed,
  toolInputSchemaProblems,
  type AiPreference,
  type Validation,
} from '../agentic/validate.js';
import {
  ev,
  found,
  has,
  homePage,
  htmlPages,
  isArticleLike,
  isIndexable,
  isJsonType,
  issue,
  looksHtml,
  memo,
  nodesOfType,
  pageCheck,
  pageDoc,
  plural,
  probe,
  probesRan,
  robotsUsable,
  safeUrl,
  siteCheck,
  siteNodesOfType,
  str,
  strList,
  vb,
  type AiDef,
  type JsonNode,
} from './_ai-util.js';

const REF = {
  mcp: 'https://modelcontextprotocol.io/specification',
  mcpAuth: 'https://modelcontextprotocol.io/specification/draft/basic/authorization',
  a2a: 'https://a2a-protocol.org/latest/specification/',
  rfc8414: 'https://www.rfc-editor.org/rfc/rfc8414',
  rfc9728: 'https://www.rfc-editor.org/rfc/rfc9728',
  rfc9727: 'https://www.rfc-editor.org/rfc/rfc9727',
  oidc: 'https://openid.net/specs/openid-connect-discovery-1_0.html',
  openapi: 'https://spec.openapis.org/oas/latest.html',
  wba: 'https://datatracker.ietf.org/doc/draft-meunier-http-message-signatures-directory/',
  webmcp: 'https://github.com/webmachinelearning/webmcp',
  signals: 'https://contentsignals.org/',
  aipref: 'https://datatracker.ietf.org/wg/aipref/about/',
  nlweb: 'https://github.com/nlweb-ai/NLWeb',
  x402: 'https://www.x402.org/',
  acp: 'https://www.agenticcommerce.dev/',
  ucp: 'https://ucp.dev/',
  actions: 'https://schema.org/docs/actions.html',
  product: 'https://developers.google.com/search/docs/appearance/structured-data/product',
  aiplugin: 'https://platform.openai.com/docs/actions/introduction',
  spawning: 'https://site.spawning.ai/spawning-ai-txt',
  rfc8615: 'https://www.rfc-editor.org/rfc/rfc8615',
};

const A = { category: 'agentic', pillar: 'agentic' } as const;
const C = { category: 'agentic-commerce', pillar: 'agentic' } as const;
const agentic = (d: Omit<AiDef, 'category' | 'pillar'>): AiDef => ({
  ...A,
  tags: ['agentic'],
  ...d,
});
const commerce = (d: Omit<AiDef, 'category' | 'pillar'>): AiDef => ({
  ...C,
  tags: ['agentic', 'commerce'],
  ...d,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mcpCard(site: SiteContext): ProbeResult | undefined {
  return found(site, 'mcp-server-card') ?? found(site, 'mcp-json');
}

function a2aCard(site: SiteContext): ProbeResult | undefined {
  return found(site, 'a2a-agent-card') ?? found(site, 'a2a-agent-json');
}

function openapi(site: SiteContext): ProbeResult | undefined {
  return (
    found(site, 'openapi-linked') ?? found(site, 'openapi-json') ?? found(site, 'openapi-yaml')
  );
}

/** The site exposes an API or sign-in, so agent-facing discovery is relevant. */
function hasApiSignals(site: SiteContext): boolean {
  return Boolean(
    found(site, 'oauth-as') ||
    found(site, 'oauth-prm') ||
    found(site, 'openid-config') ||
    openapi(site) ||
    found(site, 'api-catalog'),
  );
}

function listIssues(
  id: string,
  what: string,
  v: Validation,
  url: string,
  kind: 'errors' | 'warnings' = 'errors',
): Issue | null {
  const list = v[kind];
  if (!list.length) return null;
  return issue(id, `${what}: ${plural(list.length, kind === 'errors' ? 'error' : 'gap')}.`, {
    evidence: ev(list),
    data: { [kind]: list, url },
  });
}

function robotsBlocks(site: SiteContext, purpose: 'search' | 'user' | 'training'): string[] {
  if (!robotsUsable(site)) return [];
  const tokens = {
    search: ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot'],
    user: ['ChatGPT-User', 'Claude-User'],
    training: ['GPTBot', 'ClaudeBot', 'Google-Extended', 'CCBot'],
  }[purpose];
  return tokens.filter((t) => {
    try {
      return botByToken(t) && site.robots.isAllowed(`${site.origin}/`, t) === false;
    } catch {
      return false;
    }
  });
}

function aiPrefs(site: SiteContext): AiPreference[] {
  const p = probe(site, 'robots-ai-signals');
  return Array.isArray(p?.parsed) ? (p!.parsed as AiPreference[]) : [];
}

function productPages(site: SiteContext): { page: PageData; node: JsonNode }[] {
  return memo(site, 'productNodes', () =>
    siteNodesOfType(site, ['Product', 'ProductGroup']).filter(({ page }) => isIndexable(page)),
  );
}

function offersOf(node: JsonNode): JsonNode[] {
  const o = node.offers;
  const list = (Array.isArray(o) ? o : o ? [o] : []) as JsonNode[];
  const out: JsonNode[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    if (Array.isArray(x.offers)) out.push(...(x.offers as JsonNode[]));
    else out.push(x);
  }
  return out;
}

function inlineScripts(page: PageData): string {
  const html = `${page.html}\n${page.rendered?.html ?? ''}`;
  return [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]!)
    .join('\n');
}

const KEY_FORM =
  /(contact|enquir|quote|book|booking|reserv|appointment|demo|signup|sign-up|register|subscribe|order|checkout|apply|callback|request)/i;

function keyForms(page: PageData) {
  const doc = pageDoc(page);
  if (!doc) return [];
  return [...doc.querySelectorAll('form')]
    .map((f) => f as unknown as Element)
    .filter((f) => {
      const role = f.getAttribute('role');
      const isSearch =
        role === 'search' ||
        f.querySelector(
          'input[type="search"], input[name="q"], input[name="s"], input[name="query"]',
        );
      const fields = f.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select',
      ).length;
      return !isSearch && fields >= 2;
    });
}

/**
 * URLs (resolved against `base`) that do not respond: network error, 404, 410 or 5xx.
 * Other 4xx (405 for a GET to a POST endpoint, 401/403 behind auth) mean something is there.
 * Each entry is "url (status)".
 */
async function deadUrls(site: SiteContext, urls: string[], base: string): Promise<string[]> {
  const out: string[] = [];
  for (const raw of urls) {
    const u = safeUrl(raw, base)?.toString();
    if (!u || !/^https?:/.test(u)) continue;
    const known = [...(site.probes?.values() ?? [])].find((x) => x.url === u && x.status);
    let status = known?.status ?? null;
    if (status === null) {
      try {
        const r = await site.fetcher.fetch(u, { timeoutMs: 10_000, maxBytes: 64 * 1024 });
        status = r.status;
      } catch {
        status = 0;
      }
    }
    if (status === 0 || status === 404 || status === 410 || status >= 500)
      out.push(`${u} (${status ? `HTTP ${status}` : 'no response'})`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export const checks: Check[] = [
  // --- Discovery documents -------------------------------------------------

  siteCheck(
    agentic({
      id: 'agentic.no-agent-discovery',
      title: 'No agent discovery documents',
      why: 'Agents look for machine-readable descriptions of what a site offers: an MCP server card, an A2A agent card, an API catalog or OpenAPI. None is expected of a typical business site today; they matter once you offer bookings, data or an app that agents could use directly.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Nothing to do unless you have a service an agent could use. If you do, start with an OpenAPI description listed in /.well-known/api-catalog, then consider an MCP server.',
      refs: [REF.rfc9727, REF.mcp],
    }),
    (site) => {
      if (!probesRan(site)) return null;
      const any = mcpCard(site) || a2aCard(site) || found(site, 'api-catalog') || openapi(site);
      return any
        ? null
        : issue(
            'agentic.no-agent-discovery',
            'None of /.well-known/mcp*, agent-card.json, api-catalog or openapi.json was found.',
          );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.mcp-card-missing',
      title: 'API or sign-in present but no MCP discovery document',
      why: 'The site exposes an API or OAuth server, so it could serve AI agents. An MCP server card (a draft at the MCP project) lets clients find your server and its auth requirements without manual setup.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'If you run or plan an MCP server, publish its card at /.well-known/mcp/server-card.json with the server name, endpoint, transport and authentication.',
      refs: [REF.mcp],
      tags: ['agentic', 'mcp'],
    }),
    (site) =>
      probesRan(site) && hasApiSignals(site) && !mcpCard(site)
        ? issue('agentic.mcp-card-missing', 'API signals found but no MCP discovery document.')
        : null,
  ),

  siteCheck(
    agentic({
      id: 'agentic.mcp-card-invalid',
      title: 'MCP discovery document is invalid',
      why: 'A published MCP card that clients cannot parse, or that has no usable endpoint, is worse than none: automated clients fail with no explanation.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Fix the listed errors. At minimum: a server name, an HTTPS endpoint URL, and the transport type.',
      refs: [REF.mcp],
      tags: ['agentic', 'mcp'],
    }),
    (site) => {
      const p = mcpCard(site);
      if (!p) return null;
      if (p.parsed === undefined)
        return issue('agentic.mcp-card-invalid', `${p.url} is not valid JSON.`, {
          evidence: (p.body ?? '').slice(0, 200),
        });
      return listIssues(
        'agentic.mcp-card-invalid',
        `${p.url} has problems`,
        validateMcpCard(p.parsed),
        p.url,
      );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.mcp-card-incomplete',
      title: 'MCP discovery document lacks useful detail',
      why: 'Clients decide whether to connect from the card alone. Without a description, version or list of tools, the server is hard to choose.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add the missing fields listed with this finding.',
      refs: [REF.mcp],
      tags: ['agentic', 'mcp'],
    }),
    (site) => {
      const p = mcpCard(site);
      if (!p || p.parsed === undefined) return null;
      const v = validateMcpCard(p.parsed);
      return v.valid
        ? listIssues('agentic.mcp-card-incomplete', `${p.url} could say more`, v, p.url, 'warnings')
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.mcp-auth-no-prm',
      title: 'MCP server needs auth but no protected resource metadata',
      why: 'MCP authorisation is built on OAuth protected resource metadata (RFC 9728): clients fetch it to find your authorisation server. Without it, a compliant client cannot start sign-in.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Serve /.well-known/oauth-protected-resource (or the path-specific variant for your MCP endpoint) naming your authorisation server, and return a WWW-Authenticate header pointing to it on 401.',
      refs: [REF.mcpAuth, REF.rfc9728],
      tags: ['agentic', 'mcp', 'oauth'],
    }),
    (site) => {
      const p = mcpCard(site);
      if (!p?.parsed) return null;
      const v = validateMcpCard(p.parsed);
      return v.info.authRequired && !found(site, 'oauth-prm')
        ? issue(
            'agentic.mcp-auth-no-prm',
            'The MCP card declares authentication but /.well-known/oauth-protected-resource was not found.',
          )
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.a2a-card-invalid',
      title: 'A2A agent card is invalid',
      why: 'A2A clients read the agent card to learn your agent’s endpoint, skills and authentication. Missing required fields mean clients reject it.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Fix the listed errors: name, description, version, an HTTPS url, capabilities, default input/output modes and at least one described skill.',
      refs: [REF.a2a],
      tags: ['agentic', 'a2a'],
    }),
    (site) => {
      const p = a2aCard(site);
      if (!p) return null;
      if (p.parsed === undefined)
        return issue('agentic.a2a-card-invalid', `${p.url} is not valid JSON.`);
      return listIssues(
        'agentic.a2a-card-invalid',
        `${p.url} has problems`,
        validateAgentCard(p.parsed),
        p.url,
      );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.a2a-endpoint-unreachable',
      title: 'A2A agent endpoint does not respond',
      why: 'The url in the agent card is where A2A clients send messages. If it returns 404 or does not answer, every client that discovers your agent fails at the first call.',
      severity: 'high',
      fixTier: 'guided',
      fix: 'Deploy the A2A endpoint at the url the card gives (and any additionalInterfaces), or correct the card to point at the live endpoint.',
      refs: [REF.a2a],
      tags: ['agentic', 'a2a'],
    }),
    async (site) => {
      const p = a2aCard(site);
      if (!p || !p.parsed || typeof p.parsed !== 'object') return null;
      const card = p.parsed as JsonNode;
      const urls = new Set<string>();
      if (typeof card.url === 'string') urls.add(card.url);
      for (const key of ['additionalInterfaces', 'supportedInterfaces'])
        for (const i of (Array.isArray(card[key]) ? card[key] : []) as JsonNode[])
          if (i && typeof i.url === 'string') urls.add(i.url);
      const dead = await deadUrls(site, [...urls].slice(0, 5), p.url);
      return dead.length
        ? issue(
            'agentic.a2a-endpoint-unreachable',
            `The agent card's endpoint ${vb(dead.length, 'does', 'do')} not respond: ${dead.join(', ')}.`,
            { evidence: ev(dead), data: { card: p.url } },
          )
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.a2a-card-incomplete',
      title: 'A2A agent card lacks recommended detail',
      why: 'Skills without examples, no declared security schemes or no provider make it harder for other agents to pick and safely call yours.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add the fields listed with this finding.',
      refs: [REF.a2a],
      tags: ['agentic', 'a2a'],
    }),
    (site) => {
      const p = a2aCard(site);
      if (!p?.parsed) return null;
      const v = validateAgentCard(p.parsed);
      return v.valid
        ? listIssues('agentic.a2a-card-incomplete', `${p.url} could say more`, v, p.url, 'warnings')
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.a2a-legacy-path',
      title: 'A2A card only at the old /.well-known/agent.json path',
      why: 'Current A2A versions look for /.well-known/agent-card.json. Clients following the current spec will not find a card that exists only at agent.json.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Serve the card at /.well-known/agent-card.json (keep agent.json as a redirect or copy for older clients).',
      refs: [REF.a2a],
      tags: ['agentic', 'a2a'],
    }),
    (site) =>
      found(site, 'a2a-agent-json') && !found(site, 'a2a-agent-card')
        ? issue(
            'agentic.a2a-legacy-path',
            'Agent card found at /.well-known/agent.json but not at agent-card.json.',
          )
        : null,
  ),

  // --- OAuth / OpenID --------------------------------------------------------

  siteCheck(
    agentic({
      id: 'agentic.oauth-as-invalid',
      title: 'OAuth authorisation server metadata is invalid',
      why: 'Agents and MCP clients configure sign-in automatically from this document (RFC 8414). Missing required fields stop them.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Fix the listed errors so the document has issuer, authorization_endpoint, token_endpoint and response_types_supported.',
      refs: [REF.rfc8414],
      tags: ['agentic', 'oauth'],
    }),
    (site) => {
      const p = found(site, 'oauth-as');
      if (!p) return null;
      if (p.parsed === undefined)
        return issue('agentic.oauth-as-invalid', `${p.url} is not valid JSON.`);
      const v = validateOAuthAS(p.parsed);
      return listIssues(
        'agentic.oauth-as-invalid',
        'Authorisation server metadata has problems',
        v,
        p.url,
      );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.oauth-issuer-mismatch',
      title: 'OAuth or OpenID issuer does not match where it is served',
      why: 'RFC 8414 and OpenID Discovery require clients to reject metadata whose issuer differs from the URL it was fetched for. This is a common cause of “invalid issuer” sign-in failures.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Make "issuer" exactly the origin (and path, if any) the metadata is served under, or serve the metadata from the issuer’s own origin.',
      refs: [REF.rfc8414, REF.oidc],
      tags: ['agentic', 'oauth'],
    }),
    (site) => {
      const out: Issue[] = [];
      const as = found(site, 'oauth-as');
      const oidc = found(site, 'openid-config');
      for (const [p, label] of [
        [as, 'oauth-authorization-server'],
        [oidc, 'openid-configuration'],
      ] as const) {
        if (!p?.parsed || typeof p.parsed !== 'object') continue;
        const iss = str((p.parsed as JsonNode).issuer);
        if (iss && iss.replace(/\/$/, '') !== site.origin.replace(/\/$/, ''))
          out.push(
            issue(
              'agentic.oauth-issuer-mismatch',
              `${label} says issuer ${iss}, but it is served from ${site.origin}.`,
              { evidence: p.url },
            ),
          );
      }
      return out;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.oauth-no-pkce',
      title: 'Authorisation server does not advertise PKCE S256',
      why: 'OAuth 2.1 and the MCP authorisation spec require PKCE with S256. MCP clients refuse to proceed when code_challenge_methods_supported does not list it.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Support PKCE and add "code_challenge_methods_supported": ["S256"] to the metadata.',
      refs: [REF.mcpAuth, REF.rfc8414],
      tags: ['agentic', 'oauth'],
    }),
    (site) => {
      const p = found(site, 'oauth-as') ?? found(site, 'openid-config');
      if (!p?.parsed || typeof p.parsed !== 'object') return null;
      const m = (p.parsed as JsonNode).code_challenge_methods_supported;
      return Array.isArray(m) && m.includes('S256')
        ? null
        : issue(
            'agentic.oauth-no-pkce',
            'code_challenge_methods_supported does not include S256.',
            { evidence: p.url },
          );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.oauth-no-registration',
      title: 'No way for new AI clients to register',
      why: 'MCP clients are not known to you in advance. Dynamic client registration or client ID metadata documents let them obtain a client ID; without either, each client needs manual setup.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Support client ID metadata documents (client_id_metadata_document_supported) or dynamic client registration (registration_endpoint), with whatever approval policy suits you.',
      refs: [REF.mcpAuth],
      tags: ['agentic', 'oauth'],
    }),
    (site) => {
      const p = found(site, 'oauth-as') ?? found(site, 'openid-config');
      if (
        !p?.parsed ||
        typeof p.parsed !== 'object' ||
        !(mcpCard(site) || found(site, 'oauth-prm'))
      )
        return null;
      const m = p.parsed as JsonNode;
      return m.registration_endpoint || m.client_id_metadata_document_supported === true
        ? null
        : issue(
            'agentic.oauth-no-registration',
            'No registration_endpoint and no client ID metadata document support.',
          );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.prm-invalid',
      title: 'Protected resource metadata is invalid',
      why: 'RFC 9728 metadata tells clients which authorisation server protects your API or MCP server. If "resource" is missing or does not match, compliant clients reject it.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Fix the listed errors: "resource" must equal the resource URL, and "authorization_servers" should list your issuer.',
      refs: [REF.rfc9728],
      tags: ['agentic', 'oauth'],
    }),
    (site) => {
      const p = found(site, 'oauth-prm');
      if (!p) return null;
      if (p.parsed === undefined)
        return issue('agentic.prm-invalid', `${p.url} is not valid JSON.`);
      return listIssues(
        'agentic.prm-invalid',
        'Protected resource metadata has problems',
        validatePRM(p.parsed, site.origin),
        p.url,
      );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.prm-as-unreachable',
      title: 'The authorisation server named in resource metadata has no metadata',
      why: 'A client follows authorization_servers to the issuer’s RFC 8414 or OpenID metadata. If that is missing, sign-in cannot start.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Publish /.well-known/oauth-authorization-server (or openid-configuration) at the issuer named in authorization_servers.',
      refs: [REF.rfc9728, REF.rfc8414],
      tags: ['agentic', 'oauth'],
    }),
    async (site) => {
      const p = found(site, 'oauth-prm');
      if (!p?.parsed) return null;
      const servers = validatePRM(p.parsed).info.authorizationServers as string[];
      const iss = servers?.[0];
      const u = iss ? safeUrl(iss) : null;
      if (!u) return null;
      if (u.origin === site.origin && (found(site, 'oauth-as') || found(site, 'openid-config')))
        return null;
      const path = u.pathname.replace(/\/$/, '');
      for (const wk of ['oauth-authorization-server', 'openid-configuration']) {
        const url = `${u.origin}/.well-known/${wk}${path}`;
        try {
          const r = await site.fetcher.fetch(url, { timeoutMs: 10_000, maxBytes: 200_000 });
          if (r.status === 200 && !looksHtml(r.body, r.contentType)) return null;
        } catch {
          return null; // network trouble is not a finding
        }
      }
      return issue(
        'agentic.prm-as-unreachable',
        `No metadata found for authorisation server ${iss}.`,
      );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.openid-invalid',
      title: 'OpenID configuration is missing required fields',
      why: 'OpenID Connect clients, including agent frameworks, rely on the required discovery fields to sign users in.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add the missing fields listed with this finding.',
      refs: [REF.oidc],
      tags: ['agentic', 'oauth'],
    }),
    (site) => {
      const p = found(site, 'openid-config');
      if (!p) return null;
      if (p.parsed === undefined)
        return issue('agentic.openid-invalid', `${p.url} is not valid JSON.`);
      return listIssues(
        'agentic.openid-invalid',
        'OpenID configuration has problems',
        validateOpenId(p.parsed),
        p.url,
      );
    },
  ),

  // --- APIs ---------------------------------------------------------------------

  siteCheck(
    agentic({
      id: 'agentic.api-catalog-missing',
      title: 'API description found but no API catalog',
      why: 'RFC 9727 defines /.well-known/api-catalog so agents can find your APIs from the domain alone. Without it, your OpenAPI file is only found by guessing.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Serve /.well-known/api-catalog as application/linkset+json with a linkset entry whose service-desc points to your OpenAPI file.',
      refs: [REF.rfc9727],
      tags: ['agentic', 'api'],
    }),
    (site) =>
      openapi(site) && !found(site, 'api-catalog')
        ? issue(
            'agentic.api-catalog-missing',
            `OpenAPI found at ${openapi(site)!.url} but no /.well-known/api-catalog.`,
          )
        : null,
  ),

  siteCheck(
    agentic({
      id: 'agentic.api-catalog-invalid',
      title: 'API catalog is invalid',
      why: 'An api-catalog that is not a valid RFC 9264 linkset cannot be read by the clients it is meant for.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use the linkset JSON format: {"linkset": [{"anchor": "https://api.example.com/", "service-desc": [{"href": "…/openapi.json", "type": "application/vnd.oai.openapi+json"}]}]}.',
      refs: [REF.rfc9727],
      tags: ['agentic', 'api'],
    }),
    (site) => {
      const p = found(site, 'api-catalog');
      if (!p) return null;
      if (p.parsed === undefined)
        return issue('agentic.api-catalog-invalid', `${p.url} is not valid JSON.`);
      const v = validateApiCatalog(p.parsed, p.contentType);
      return v.errors.length
        ? listIssues('agentic.api-catalog-invalid', 'API catalog has problems', v, p.url)
        : listIssues(
            'agentic.api-catalog-invalid',
            'API catalog could be improved',
            v,
            p.url,
            'warnings',
          );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.api-catalog-broken-link',
      title: 'API catalog links to a missing document',
      why: 'Agents follow the api-catalog to the OpenAPI description (service-desc), documentation (service-doc) and metadata. A link that returns 404 leaves them with an API they cannot describe or call.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Publish the documents at the hrefs in /.well-known/api-catalog, or correct the hrefs to their real locations.',
      refs: [REF.rfc9727, 'https://www.rfc-editor.org/rfc/rfc8631'],
      tags: ['agentic', 'api'],
    }),
    async (site) => {
      const p = found(site, 'api-catalog');
      if (!p || !p.parsed || typeof p.parsed !== 'object') return null;
      const linkset = (p.parsed as JsonNode).linkset;
      const hrefs: string[] = [];
      for (const ctx of (Array.isArray(linkset) ? linkset : []) as JsonNode[]) {
        if (!ctx || typeof ctx !== 'object') continue;
        for (const rel of ['service-desc', 'service-doc', 'service-meta', 'status'])
          for (const t of (Array.isArray(ctx[rel]) ? ctx[rel] : []) as JsonNode[])
            if (t && typeof t.href === 'string') hrefs.push(`${rel} ${t.href}`);
      }
      const byUrl = new Map(hrefs.slice(0, 10).map((h) => [h.split(' ')[1]!, h.split(' ')[0]!]));
      const dead = await deadUrls(site, [...byUrl.keys()], p.url);
      return dead.length
        ? issue(
            'agentic.api-catalog-broken-link',
            `${plural(dead.length, 'link')} in the API catalog ${vb(dead.length, 'is', 'are')} broken.`,
            { evidence: ev(dead.map((d) => `${byUrl.get(d.split(' ')[0]!) ?? ''} ${d}`.trim())) },
          )
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.openapi-invalid',
      title: 'OpenAPI description is invalid',
      why: 'Agent frameworks turn OpenAPI operations into tools. A document without openapi, info or paths produces no tools.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Fix the listed errors and validate the file with an OpenAPI linter.',
      refs: [REF.openapi],
      tags: ['agentic', 'api'],
    }),
    (site) => {
      const p = openapi(site);
      if (!p) return null;
      return listIssues(
        'agentic.openapi-invalid',
        `${p.url} has problems`,
        validateOpenApi(p.parsed, p.body),
        p.url,
      );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.openapi-undescribed',
      title: 'API operations lack descriptions',
      why: 'An agent chooses which operation to call from its summary and description. Undescribed operations are guessed at or ignored.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Add a summary and description to every operation, saying when to use it.',
      refs: [REF.openapi],
      tags: ['agentic', 'api'],
    }),
    (site) => {
      const p = openapi(site);
      if (!p?.parsed) return null;
      const v = validateOpenApi(p.parsed);
      return v.valid
        ? listIssues('agentic.openapi-undescribed', `${p.url} could say more`, v, p.url, 'warnings')
        : null;
    },
  ),

  // --- Web Bot Auth -----------------------------------------------------------

  siteCheck(
    agentic({
      id: 'agentic.web-bot-auth-invalid',
      title: 'Web Bot Auth key directory has problems',
      why: 'If you operate an agent or crawler, this directory (an IETF draft) publishes the keys verifiers use to check your signed requests. An invalid or unsigned directory means your requests cannot be verified.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Publish a JWKS of Ed25519 public keys as application/http-message-signatures-directory+json, and sign the response.',
      refs: [REF.wba],
      tags: ['agentic', 'web-bot-auth'],
    }),
    (site) => {
      const p = found(site, 'web-bot-auth');
      if (!p) return null;
      if (p.parsed === undefined)
        return issue('agentic.web-bot-auth-invalid', `${p.url} is not valid JSON.`);
      const v = validateSignatureDirectory(p.parsed, p.headers);
      const leaked = v.errors.some((e) => e.includes('private key'));
      const all = [...v.errors, ...v.warnings];
      return all.length
        ? issue(
            'agentic.web-bot-auth-invalid',
            `Signatures directory: ${plural(all.length, 'problem')}.`,
            { severity: leaked ? 'critical' : undefined, evidence: ev(all) },
          )
        : null;
    },
  ),

  // --- Markdown for agents ----------------------------------------------------

  siteCheck(
    agentic({
      id: 'agentic.markdown-negotiation-missing',
      title: 'No markdown version of pages for agents',
      why: 'Some agents ask for pages with Accept: text/markdown to save tokens and avoid HTML clutter, and some CDNs now offer this conversion. It is an emerging convention; HTML still works for every engine.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Optionally answer Accept: text/markdown with a markdown rendering of the page (with Vary: Accept), or enable your CDN’s markdown conversion.',
      tags: ['agentic', 'markdown'],
    }),
    (site) => {
      const home = probe(site, 'md-home');
      const art = probe(site, 'md-article');
      const sfx = probe(site, 'md-suffix');
      if (!home || home.status === null) return null;
      return home.found || art?.found || sfx?.found
        ? null
        : issue(
            'agentic.markdown-negotiation-missing',
            'Requests with Accept: text/markdown returned HTML.',
          );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.markdown-no-vary',
      title: 'Markdown negotiation without Vary: Accept',
      why: 'When the same URL returns markdown or HTML depending on Accept, caches must be told with Vary: Accept. Otherwise a CDN can serve markdown to browsers or HTML to agents.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add "Vary: Accept" to responses from negotiated URLs.',
      tags: ['agentic', 'markdown'],
    }),
    (site) => {
      const hits = ['md-home', 'md-article']
        .map((id) => found(site, id))
        .filter((p): p is ProbeResult => Boolean(p));
      const bad = hits.filter((p) => !/\baccept\b/i.test(p.headers?.['vary'] ?? ''));
      return bad.length
        ? issue('agentic.markdown-no-vary', 'Markdown is negotiated without Vary: Accept.', {
            evidence: ev(bad.map((p) => `${p.url}: Vary: ${p.headers?.['vary'] ?? '(none)'}`)),
          })
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.markdown-is-html',
      title: 'Markdown response is really HTML',
      why: 'A response labelled text/markdown that contains an HTML document confuses agents that trusted the label.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Convert the page to markdown before serving it as text/markdown, or stop labelling HTML as markdown.',
      tags: ['agentic', 'markdown'],
    }),
    (site) => {
      const bad = ['md-home', 'md-article', 'md-suffix']
        .map((id) => probe(site, id))
        .filter((p): p is ProbeResult =>
          Boolean(
            p &&
            p.status === 200 &&
            /markdown/i.test(p.contentType ?? '') &&
            /^\s*<(!doctype|html)/i.test(p.body ?? ''),
          ),
        );
      return bad.length
        ? issue('agentic.markdown-is-html', 'A text/markdown response contains an HTML document.', {
            evidence: ev(bad.map((p) => p.url)),
          })
        : null;
    },
  ),

  // --- WebMCP and operable forms ---------------------------------------------

  siteCheck(
    agentic({
      id: 'agentic.webmcp-not-used',
      title: 'Key forms are not exposed as WebMCP tools',
      why: 'WebMCP (a W3C community draft, in early browser trials) lets a page declare forms as tools an in-browser agent can call with toolname and tooldescription attributes, instead of guessing which fields to fill. Optional today; low effort for contact and booking forms.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add toolname="request_quote" and tooldescription="…" to key forms, and give each input a clear name and label.',
      refs: [REF.webmcp],
      tags: ['agentic', 'webmcp'],
    }),
    (site) => {
      const pages = htmlPages(site).filter((p) => keyForms(p).length);
      if (!pages.length) return null;
      const annotated = pages.some(
        (p) =>
          p.forms?.some((f) => f.toolname) ||
          /\btoolname\s*=/i.test(p.html) ||
          /navigator\.modelContext/.test(p.html) ||
          Boolean(p.rendered?.webmcpTools?.length),
      );
      return annotated
        ? null
        : issue(
            'agentic.webmcp-not-used',
            `${plural(pages.length, 'page')} with contact, booking or sign-up forms; none declares WebMCP tools.`,
            { evidence: ev(pages.slice(0, 5).map((p) => p.url)) },
          );
    },
  ),

  pageCheck(
    agentic({
      id: 'agentic.webmcp-form-incomplete',
      title: 'WebMCP form tool is incomplete',
      why: 'An agent sees only the tool name, description and field names. A tool without a description, or fields without names, cannot be used reliably.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Give the form a tooldescription saying what it does, and give every field a name (and toolparamdescription where the label is unclear).',
      refs: [REF.webmcp],
      tags: ['agentic', 'webmcp'],
    }),
    (page) => {
      const doc = pageDoc(page);
      if (!doc) return null;
      const forms = [...doc.querySelectorAll('form[toolname]')].map((f) => f as unknown as Element);
      const problems: string[] = [];
      for (const f of forms) {
        const name = f.getAttribute('toolname') ?? '';
        if (!/^[a-zA-Z][\w-]{1,63}$/.test(name))
          problems.push(`toolname "${name}" should be a short identifier`);
        if (!(f.getAttribute('tooldescription') ?? '').trim())
          problems.push(`"${name}" has no tooldescription`);
        const unnamed = [
          ...f.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]), textarea, select',
          ),
        ].filter((i) => !(i as unknown as Element).getAttribute('name')).length;
        if (unnamed) problems.push(`"${name}" has ${unnamed} field(s) without a name`);
      }
      return problems.length
        ? issue(
            'agentic.webmcp-form-incomplete',
            `${plural(problems.length, 'problem')} with WebMCP form tools.`,
            { url: page.url, evidence: ev(problems) },
          )
        : null;
    },
  ),

  pageCheck(
    agentic({
      id: 'agentic.webmcp-tool-incomplete',
      title: 'Script-registered WebMCP tool lacks description or schema',
      why: 'Tools registered with navigator.modelContext need a description and an input schema; agents rely on both to call them correctly.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Pass description and inputSchema (JSON Schema) for every tool you register.',
      refs: [REF.webmcp],
      tags: ['agentic', 'webmcp'],
    }),
    (page) => {
      // Tools registered at runtime (captured in the browser render, any script) come first.
      const live = page.rendered?.webmcpTools ?? [];
      if (live.length) {
        const badLive = live.filter((t) => !t.description || !t.hasSchema);
        return badLive.length
          ? issue(
              'agentic.webmcp-tool-incomplete',
              `${plural(badLive.length, 'registered tool')} without description or inputSchema (seen at runtime).`,
              {
                url: page.url,
                evidence: ev(
                  badLive.map(
                    (t) =>
                      `${t.name || '(unnamed)'}: ${!t.description ? 'no description' : ''}${!t.description && !t.hasSchema ? ', ' : ''}${!t.hasSchema ? 'no inputSchema' : ''}`,
                  ),
                ),
              },
            )
          : null;
      }
      const js = inlineScripts(page);
      if (!/navigator\.modelContext/.test(js)) return null;
      const calls = [...js.matchAll(/(registerTool|provideContext)\s*\(([\s\S]{0,1500}?)\)\s*;?/g)];
      const bad = calls.filter(
        (m) => !/description\s*:/.test(m[2]!) || !/inputSchema\s*:/.test(m[2]!),
      );
      return bad.length
        ? issue(
            'agentic.webmcp-tool-incomplete',
            `${plural(bad.length, 'tool registration')} without description or inputSchema.`,
            { url: page.url, evidence: ev(bad.map((m) => m[0]!.slice(0, 120))) },
          )
        : null;
    },
  ),

  pageCheck(
    agentic({
      id: 'agentic.webmcp-schema-invalid',
      title: 'WebMCP tool input schema is not valid JSON Schema',
      why: 'Agents build their tool calls from the inputSchema. A schema with an unknown type (such as "text" or "datetime"), a "required" that is not a list, or properties that are not schemas is rejected or misread, so the tool cannot be called correctly.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Make inputSchema a JSON Schema object: {"type": "object", "properties": {"date": {"type": "string", "format": "date"}}, "required": ["date"]}. Types must be one of string, number, integer, boolean, object, array or null.',
      refs: [REF.webmcp, 'https://json-schema.org/draft/2020-12/json-schema-validation'],
      tags: ['agentic', 'webmcp'],
    }),
    (page) => {
      const live = page.rendered?.webmcpTools ?? [];
      const bad: string[] = [];
      for (const t of live) {
        if (t.inputSchema === undefined) continue;
        const problems = toolInputSchemaProblems(t.inputSchema);
        if (problems.length)
          bad.push(`${t.name || '(unnamed)'}: ${problems.slice(0, 4).join('; ')}`);
      }
      return bad.length
        ? issue(
            'agentic.webmcp-schema-invalid',
            `${plural(bad.length, 'registered tool')} with an invalid inputSchema (seen at runtime).`,
            { url: page.url, evidence: ev(bad) },
          )
        : null;
    },
  ),

  pageCheck(
    agentic({
      id: 'agentic.form-unlabelled',
      title: 'Form fields an agent cannot identify',
      why: 'Browsing agents fill forms through the accessibility tree. Fields with no label, aria-label or descriptive name appear as anonymous text boxes, so the agent guesses or gives up.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Give every field a visible <label for> (or aria-label) and a meaningful name attribute.',
      refs: ['https://www.w3.org/WAI/tutorials/forms/labels/'],
      tags: ['agentic', 'forms', 'a11y'],
    }),
    (page) => {
      const forms = keyForms(page);
      if (!forms.length) return null;
      const doc = pageDoc(page)!;
      let unlabelled = 0;
      for (const f of forms)
        for (const el of f.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, select',
        )) {
          const i = el as unknown as Element;
          const id = i.getAttribute('id');
          const labelled =
            (id && doc.querySelector(`label[for="${id}"]`)) ||
            i.closest('label') ||
            i.getAttribute('aria-label') ||
            i.getAttribute('aria-labelledby') ||
            i.getAttribute('title');
          if (!labelled) unlabelled++;
        }
      return unlabelled
        ? issue('agentic.form-unlabelled', `${plural(unlabelled, 'form field')} without a label.`, {
            url: page.url,
          })
        : null;
    },
  ),

  pageCheck(
    agentic({
      id: 'agentic.form-no-autocomplete',
      title: 'Contact fields without autocomplete hints',
      why: 'autocomplete="email", "tel", "name" tell browsers and agents exactly what each field wants, so they can fill it from the user’s details without guessing.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add autocomplete attributes (name, email, tel, organization, postal-code…) to personal-detail fields.',
      refs: ['https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill'],
      tags: ['agentic', 'forms'],
    }),
    (page) => {
      const forms = keyForms(page);
      let missing = 0;
      for (const f of forms)
        for (const el of f.querySelectorAll(
          'input[type="email"], input[type="tel"], input[name*="email" i], input[name*="phone" i], input[name*="name" i]',
        )) {
          const i = el as unknown as Element;
          if (!i.getAttribute('autocomplete')) missing++;
        }
      return missing >= 2
        ? issue(
            'agentic.form-no-autocomplete',
            `${missing} personal-detail fields have no autocomplete attribute.`,
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    agentic({
      id: 'agentic.captcha-only-form',
      title: 'Captcha-protected form is the only way to get in touch',
      why: 'Agents acting for a person cannot solve captchas. If the form is the only contact route, the person’s agent cannot reach you; a visible email or phone gives it another way.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Show an email address or phone number next to the form, or use invisible bot protection that scores rather than challenges.',
      tags: ['agentic', 'forms'],
    }),
    (page) => {
      if (!keyForms(page).length) return null;
      if (
        !/(g-recaptcha|grecaptcha|h-captcha|hcaptcha|cf-turnstile|friendlycaptcha|frc-captcha)/i.test(
          page.html,
        )
      )
        return null;
      const alt = page.links.some((l) => /^(mailto|tel):/i.test(l.href));
      return alt
        ? null
        : issue(
            'agentic.captcha-only-form',
            'The form uses a captcha and the page shows no email or phone link.',
            { url: page.url },
          );
    },
  ),

  pageCheck(
    agentic({
      id: 'agentic.icon-only-controls',
      title: 'Buttons and links without accessible names',
      why: 'Agents operate pages through the accessibility tree. Icon-only buttons and links with no text or aria-label are anonymous there, so the agent cannot tell “menu” from “add to basket”.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Give icon-only controls an aria-label (or visually hidden text) describing the action.',
      refs: ['https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html'],
      tags: ['agentic', 'a11y'],
    }),
    (page) => {
      const doc = pageDoc(page);
      if (!doc) return null;
      let n = 0;
      for (const el of doc.querySelectorAll('button, a[href], [role="button"]')) {
        const e = el as unknown as Element;
        const text = (e.textContent ?? '').trim();
        if (
          text ||
          e.getAttribute('aria-label') ||
          e.getAttribute('aria-labelledby') ||
          e.getAttribute('title')
        )
          continue;
        const img = e.querySelector('img[alt]:not([alt=""]), svg title');
        if (img) continue;
        n++;
      }
      return n >= 3
        ? issue('agentic.icon-only-controls', `${n} buttons or links have no accessible name.`, {
            url: page.url,
          })
        : null;
    },
  ),

  pageCheck(
    agentic({
      id: 'agentic.div-buttons',
      title: 'Clickable elements that are not buttons or links',
      why: 'A <div onclick> is not exposed as a control in the accessibility tree, so browsing agents (and keyboard users) cannot find or activate it.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use <button> or <a href> for anything clickable, or add role="button", tabindex="0" and keyboard handling.',
      tags: ['agentic', 'a11y'],
    }),
    (page) => {
      const doc = pageDoc(page);
      if (!doc) return null;
      const n = [
        ...doc.querySelectorAll('div[onclick], span[onclick], li[onclick], img[onclick]'),
      ].filter((e) => !(e as unknown as Element).getAttribute('role')).length;
      return n >= 2
        ? issue('agentic.div-buttons', `${n} clickable elements are not buttons or links.`, {
            url: page.url,
          })
        : null;
    },
  ),

  // --- schema.org actions -------------------------------------------------------

  siteCheck(
    agentic({
      id: 'agentic.no-search-action',
      title: 'Site search not described with SearchAction',
      why: 'A WebSite potentialAction of type SearchAction tells agents how to query your site search directly with a URL template.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add to the WebSite JSON-LD: "potentialAction": {"@type": "SearchAction", "target": {"@type": "EntryPoint", "urlTemplate": "https://example.com/search?q={search_term_string}"}, "query-input": "required name=search_term_string"}.',
      refs: [REF.actions],
      tags: ['agentic', 'schema'],
    }),
    (site) => {
      const home = homePage(site);
      if (!home?.html) return null;
      const hasSearch =
        /<form[^>]*(role=["']search["']|action=["'][^"']*search)|<input[^>]+type=["']search["']/i.test(
          home.html,
        );
      if (!hasSearch) return null;
      const any = siteNodesOfType(site, ['SearchAction']).length;
      return any
        ? null
        : issue(
            'agentic.no-search-action',
            'The home page has a search form but no SearchAction markup.',
            { url: home.url },
          );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.search-action-invalid',
      title: 'SearchAction markup cannot be used',
      why: 'A SearchAction whose target has no {placeholder}, or whose query-input does not name it, gives an agent a template it cannot fill.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use a urlTemplate with {search_term_string} and "query-input": "required name=search_term_string".',
      refs: [REF.actions],
      tags: ['agentic', 'schema'],
    }),
    (site) => {
      const bad: string[] = [];
      for (const { node } of siteNodesOfType(site, ['SearchAction'])) {
        const t = node.target as JsonNode | string | undefined;
        const tpl =
          typeof t === 'string' ? t : t && typeof t === 'object' ? str(t.urlTemplate) : null;
        const m = tpl?.match(/\{([^}]+)\}/);
        const qi =
          str(node['query-input']) ?? str((node['query-input'] as JsonNode | undefined)?.valueName);
        if (!tpl || !m) bad.push(`target "${tpl ?? '(none)'}" has no {placeholder}`);
        else if (!qi || !qi.includes(m[1]!)) bad.push(`query-input does not name {${m[1]}}`);
      }
      return bad.length
        ? issue('agentic.search-action-invalid', 'SearchAction markup is incomplete.', {
            evidence: ev([...new Set(bad)]),
          })
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.business-actions-missing',
      title: 'Bookable business without action markup',
      why: 'schema.org ReserveAction, OrderAction and ScheduleAction let assistants offer “book a table” or “order” directly with your own booking URL, instead of a third-party aggregator’s.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add potentialAction (ReserveAction / OrderAction / ScheduleAction with an EntryPoint urlTemplate) to your LocalBusiness schema, pointing at your booking or ordering page.',
      refs: [REF.actions],
      tags: ['agentic', 'schema'],
    }),
    (site) => {
      const types = [
        'Restaurant',
        'FoodEstablishment',
        'LodgingBusiness',
        'Hotel',
        'MedicalBusiness',
        'Dentist',
        'HealthAndBeautyBusiness',
        'BeautySalon',
        'HairSalon',
        'DaySpa',
        'SportsActivityLocation',
        'AutomotiveBusiness',
      ];
      const biz = siteNodesOfType(site, types);
      if (!biz.length) return null;
      const actions = siteNodesOfType(site, [
        'ReserveAction',
        'OrderAction',
        'ScheduleAction',
        'BuyAction',
      ]).length;
      const home = homePage(site);
      const books = home?.links.some((l) =>
        /(book|reserv|order|appointment|schedule)/i.test(`${l.href} ${l.text}`),
      );
      return !actions && books
        ? issue(
            'agentic.business-actions-missing',
            `${String(biz[0]!.node['@type'])} schema without Reserve/Order/Schedule actions, although the site links to booking or ordering.`,
          )
        : null;
    },
  ),

  // --- NLWeb -------------------------------------------------------------------

  siteCheck(
    agentic({
      id: 'agentic.nlweb-error',
      title: 'Natural-language /ask endpoint returns errors',
      why: 'An /ask endpoint (the NLWeb convention) that errors tells agents your conversational interface is broken. NLWeb is an open project, not a standard; only relevant if you deployed it.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Check the NLWeb service logs, or remove the route if it is not in use.',
      refs: [REF.nlweb],
      tags: ['agentic', 'nlweb'],
    }),
    (site) => {
      const p = probe(site, 'nlweb-ask');
      if (!p?.status || p.status < 500) return null;
      if (!isJsonType(p.contentType) && !/nlweb|query_id|message_type/i.test(p.body ?? ''))
        return null;
      return issue('agentic.nlweb-error', `/ask returned ${p.status}.`, {
        evidence: (p.body ?? '').slice(0, 200),
      });
    },
  ),

  // --- AI preference signals ------------------------------------------------------

  siteCheck(
    agentic({
      id: 'agentic.ai-preferences-missing',
      title: 'No AI usage preferences in robots.txt',
      why: 'robots.txt controls crawling, not use. Content-Signal lines (published by Cloudflare) and the IETF aipref Content-Usage vocabulary (in draft) let you say separately whether content may be used for search, AI answers and training. Adoption by AI companies is still limited.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add a line such as "Content-Signal: search=yes, ai-input=yes, ai-train=no" under User-agent: * to state your preference.',
      refs: [REF.signals, REF.aipref],
      tags: ['agentic', 'aipref'],
    }),
    (site) =>
      robotsUsable(site) && probe(site, 'robots-ai-signals') && !aiPrefs(site).length
        ? issue(
            'agentic.ai-preferences-missing',
            'robots.txt has no Content-Signal or Content-Usage line.',
          )
        : null,
  ),

  siteCheck(
    agentic({
      id: 'agentic.ai-preferences-invalid',
      title: 'AI preference lines are malformed',
      why: 'A preference that does not follow the vocabulary (unknown keys, values other than yes/no) will be ignored by any parser that does read it.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Use the documented keys and values, e.g. "Content-Signal: search=yes, ai-input=yes, ai-train=no".',
      refs: [REF.signals, REF.aipref],
      tags: ['agentic', 'aipref'],
    }),
    (site) => {
      const bad = aiPrefs(site).filter((p) => p.problems.length);
      return bad.length
        ? issue(
            'agentic.ai-preferences-invalid',
            `${plural(bad.length, 'preference line')} ${vb(bad.length, 'has', 'have')} problems.`,
            { evidence: ev(bad.map((p) => `line ${p.line}: ${p.problems.join(' ')}`)) },
          )
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.ai-preferences-conflict',
      title: 'AI preferences contradict robots.txt rules',
      why: 'Saying search=yes or ai-input=yes while blocking the bots that do that work sends opposite instructions; the block wins, and the stated preference is meaningless.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Make the two agree: allow the search and user bots, or change the preference to match your rules.',
      refs: [REF.signals],
      tags: ['agentic', 'aipref'],
    }),
    (site) => {
      const out: string[] = [];
      for (const p of aiPrefs(site)) {
        if (p.values['search'] === 'yes' || p.values['search'] === 'y') {
          const b = robotsBlocks(site, 'search');
          if (b.length)
            out.push(`line ${p.line} says search=yes but ${b.join(', ')} are disallowed`);
        }
        if (p.values['ai-input'] === 'yes') {
          const b = robotsBlocks(site, 'user');
          if (b.length)
            out.push(`line ${p.line} says ai-input=yes but ${b.join(', ')} are disallowed`);
        }
      }
      return out.length
        ? issue(
            'agentic.ai-preferences-conflict',
            'Content preferences and robots.txt rules disagree.',
            { evidence: ev(out) },
          )
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.ai-txt-only',
      title: 'AI restrictions only in ai.txt',
      why: 'ai.txt (a Spawning proposal) is read by few AI crawlers. If it carries restrictions that robots.txt does not, the major crawlers will not see them.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Put the rules that matter in robots.txt (per-bot groups) and, for use preferences, a Content-Signal line.',
      refs: [REF.spawning],
      tags: ['agentic', 'aipref'],
    }),
    (site) => {
      const p = found(site, 'ai-txt');
      if (!p?.body || !/disallow\s*:\s*\S/i.test(p.body)) return null;
      return robotsBlocks(site, 'training').length
        ? null
        : issue(
            'agentic.ai-txt-only',
            '/ai.txt disallows AI use but robots.txt does not block training crawlers.',
            { evidence: p.body.slice(0, 300) },
          );
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.ai-plugin-legacy',
      title: 'Legacy ChatGPT plugin manifest still published',
      why: 'ChatGPT plugins were retired in 2024. The ai-plugin.json manifest is no longer read by ChatGPT; it may point at an API that has also gone stale.',
      severity: 'low',
      fixTier: 'manual',
      fix: 'Remove /.well-known/ai-plugin.json, or replace it with an OpenAPI file in an api-catalog and, if relevant, an MCP server.',
      refs: [REF.aiplugin],
      tags: ['agentic'],
    }),
    (site) =>
      found(site, 'ai-plugin')
        ? issue('agentic.ai-plugin-legacy', '/.well-known/ai-plugin.json is published.')
        : null,
  ),

  // --- Feeds ---------------------------------------------------------------------

  siteCheck(
    agentic({
      id: 'agentic.feed-missing',
      title: 'Articles but no RSS or Atom feed',
      why: 'Feeds are the oldest agent interface on the web: aggregators, readers and many AI tools use them to learn what is new without recrawling the site.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Publish an RSS or Atom feed of your articles and link it with <link rel="alternate" type="application/rss+xml"> in the page head.',
      refs: ['https://www.rssboard.org/rss-specification'],
      tags: ['agentic', 'feed'],
    }),
    (site) => {
      const p = probe(site, 'feed');
      if (!p || p.found) return null;
      const articles = htmlPages(site).filter(isArticleLike).length;
      return articles >= 3
        ? issue('agentic.feed-missing', `${articles} articles and no feed found.`)
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.feed-invalid',
      title: 'Feed has no items',
      why: 'An advertised feed that is empty tells readers and agents nothing has been published.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Make the feed list recent articles (title, link, date, summary).',
      tags: ['agentic', 'feed'],
    }),
    (site) => {
      const p = found(site, 'feed');
      if (!p?.body) return null;
      const f = inspectFeed(p.body);
      return f.kind && f.items === 0
        ? issue(
            'agentic.feed-invalid',
            `The ${f.kind.toUpperCase()} feed at ${p.url} has no items.`,
          )
        : null;
    },
  ),

  // --- Hygiene of the well-known documents ------------------------------------------

  siteCheck(
    agentic({
      id: 'agentic.wellknown-wrong-type',
      title: 'Discovery documents served with the wrong content type',
      why: 'Clients may refuse JSON metadata served as text/html or text/plain, and some frameworks check the media type strictly.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Serve these files as application/json (api-catalog as application/linkset+json).',
      refs: [REF.rfc8615],
      tags: ['agentic'],
    }),
    (site) => {
      const ids = [
        'mcp-server-card',
        'mcp-json',
        'a2a-agent-card',
        'a2a-agent-json',
        'oauth-as',
        'oauth-prm',
        'openid-config',
        'api-catalog',
      ];
      const bad = ids
        .map((id) => found(site, id))
        .filter((p): p is ProbeResult => Boolean(p && !isJsonType(p.contentType)));
      return bad.length
        ? issue(
            'agentic.wellknown-wrong-type',
            `${plural(bad.length, 'document')} not served as JSON.`,
            { evidence: ev(bad.map((p) => `${p.url}: ${p.contentType || '(none)'}`)) },
          )
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.wellknown-no-cors',
      title: 'Discovery documents not readable from browsers',
      why: 'Browser-based agents and MCP clients fetch metadata from other origins. Without Access-Control-Allow-Origin the browser blocks the response.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Send "Access-Control-Allow-Origin: *" on public discovery documents (they contain no secrets).',
      refs: [REF.mcpAuth],
      tags: ['agentic'],
    }),
    (site) => {
      const ids = [
        'mcp-server-card',
        'mcp-json',
        'a2a-agent-card',
        'oauth-as',
        'oauth-prm',
        'openid-config',
      ];
      const bad = ids
        .map((id) => found(site, id))
        .filter((p): p is ProbeResult =>
          Boolean(p && p.headers && !p.headers['access-control-allow-origin']),
        );
      return bad.length
        ? issue(
            'agentic.wellknown-no-cors',
            `${plural(bad.length, 'document')} without CORS headers.`,
            { evidence: ev(bad.map((p) => p.url)) },
          )
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.wellknown-redirect-offsite',
      title: 'Discovery documents redirect to another host',
      why: 'Some clients do not follow redirects for /.well-known resources, and OAuth metadata fetched from another host fails the issuer check.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Serve the document directly from this origin.',
      refs: [REF.rfc8615],
      tags: ['agentic'],
    }),
    (site) => {
      const bad: string[] = [];
      for (const p of site.probes?.values() ?? []) {
        const fin = p.headers?.['x-avc-final-url'];
        if (!p.found || !fin || !p.url.includes('/.well-known/')) continue;
        if (safeUrl(fin)?.host !== safeUrl(p.url)?.host) bad.push(`${p.url} → ${fin}`);
      }
      return bad.length
        ? issue(
            'agentic.wellknown-redirect-offsite',
            `${plural(bad.length, 'document')} ${vb(bad.length, 'redirects', 'redirect')} to another host.`,
            { evidence: ev(bad) },
          )
        : null;
    },
  ),

  siteCheck(
    agentic({
      id: 'agentic.discovery-blocked-by-robots',
      title: 'robots.txt blocks AI bots from llms.txt or /.well-known',
      why: 'Publishing discovery files and then disallowing them for AI bots means compliant agents will not read them.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Allow /llms.txt and /.well-known/ for AI bots (add "Allow: /.well-known/" and "Allow: /llms.txt").',
      tags: ['agentic', 'robots'],
    }),
    (site) => {
      if (!robotsUsable(site)) return null;
      const urls = [...(site.probes?.values() ?? [])]
        .filter((p) => p.found && (p.url.includes('/.well-known/') || p.url.endsWith('/llms.txt')))
        .map((p) => p.url);
      const bad: string[] = [];
      for (const u of urls)
        for (const t of ['OAI-SearchBot', 'ClaudeBot', 'ChatGPT-User', 'PerplexityBot'])
          try {
            if (
              site.robots.isAllowed(u, t) === false &&
              site.robots.isAllowed(`${site.origin}/`, t) !== false
            ) {
              bad.push(`${u} (${t})`);
              break;
            }
          } catch {
            /* ignore */
          }
      return bad.length
        ? issue(
            'agentic.discovery-blocked-by-robots',
            `${plural(bad.length, 'discovery file')} disallowed for AI bots.`,
            { evidence: ev(bad) },
          )
        : null;
    },
  ),

  // --- Commerce -------------------------------------------------------------------

  pageCheck(
    commerce({
      id: 'agentic-commerce.product-no-identifier',
      title: 'Product without a stable identifier',
      why: 'Shopping agents match products across sites by GTIN, MPN or SKU. Without one they cannot be sure your product is the one the user wants, and fall back to retailers that provide it.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add gtin (or gtin13/gtin12), mpn and sku to the Product JSON-LD.',
      refs: [REF.product],
    }),
    (page) => {
      if (!isIndexable(page)) return null;
      const nodes = nodesOfType(page, ['Product']);
      const bad = nodes.filter(
        (n) =>
          !['sku', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'mpn', 'productID', 'isbn'].some(
            (k) => has(n, k),
          ),
      );
      return bad.length
        ? issue(
            'agentic-commerce.product-no-identifier',
            `${plural(bad.length, 'Product')} without sku, gtin or mpn.`,
            { url: page.url, evidence: ev(bad.map((n) => str(n.name) ?? '(unnamed)')) },
          )
        : null;
    },
  ),

  pageCheck(
    commerce({
      id: 'agentic-commerce.offer-incomplete',
      title: 'Product offer missing price, currency or availability',
      why: 'An agent cannot quote or buy what it cannot price. price, priceCurrency and availability are the minimum for any shopping answer.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Give each Offer price, priceCurrency (ISO 4217), availability (schema.org/InStock…) and url.',
      refs: [REF.product],
    }),
    (page) => {
      if (!isIndexable(page)) return null;
      const problems: string[] = [];
      for (const n of nodesOfType(page, ['Product'])) {
        const offers = offersOf(n);
        if (!offers.length) {
          problems.push(`${str(n.name) ?? 'Product'}: no offers`);
          continue;
        }
        for (const o of offers) {
          const missing = ['priceCurrency', 'availability'].filter((k) => !has(o, k));
          if (!has(o, 'price') && !has(o, 'lowPrice') && !has(o, 'priceSpecification'))
            missing.unshift('price');
          if (missing.length)
            problems.push(`${str(n.name) ?? 'Product'}: offer lacks ${missing.join(', ')}`);
        }
      }
      return problems.length
        ? issue(
            'agentic-commerce.offer-incomplete',
            `${plural(problems.length, 'offer problem')}.`,
            { url: page.url, evidence: ev(problems) },
          )
        : null;
    },
  ),

  pageCheck(
    commerce({
      id: 'agentic-commerce.no-policies',
      title: 'Offers without shipping or returns information',
      why: 'Shopping assistants compare total cost and return terms. Shipping details and a return policy in the markup let them answer “does it ship to me, can I return it” from your data.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Add shippingDetails and hasMerchantReturnPolicy to offers, or a MerchantReturnPolicy on the Organization.',
      refs: [
        'https://developers.google.com/search/docs/appearance/structured-data/merchant-listing',
      ],
    }),
    (page, site) => {
      if (!isIndexable(page)) return null;
      const offers = nodesOfType(page, ['Product']).flatMap(offersOf);
      if (!offers.length) return null;
      const orgPolicy = memo(
        site,
        'orgReturnPolicy',
        () => siteNodesOfType(site, ['MerchantReturnPolicy']).length > 0,
      );
      const lacking = offers.filter(
        (o) => !has(o, 'shippingDetails') && !has(o, 'hasMerchantReturnPolicy'),
      );
      return lacking.length === offers.length && !orgPolicy
        ? issue(
            'agentic-commerce.no-policies',
            'No shippingDetails or return policy in the product markup.',
            { url: page.url },
          )
        : null;
    },
  ),

  pageCheck(
    commerce({
      id: 'agentic-commerce.unstable-product-url',
      title: 'Product reachable only through a parameterised URL',
      why: 'Agents store and revisit product URLs. Session IDs, tracking parameters or variant-only query strings without a clean canonical break those links.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Give each product a clean canonical URL and use it as the Offer url and Product url.',
    }),
    (page) => {
      if (!page.isHtml || !nodesOfType(page, ['Product']).length) return null;
      const u = safeUrl(page.finalUrl || page.url);
      if (!u || !u.search) return null;
      const unstable = /(sessionid|sid|jsessionid|phpsessid|utm_|gclid|fbclid|ref=)/i.test(
        u.search,
      );
      const canon = page.canonical ? safeUrl(page.canonical) : null;
      return unstable && (!canon || canon.search)
        ? issue(
            'agentic-commerce.unstable-product-url',
            'Product page URL carries session or tracking parameters and has no clean canonical.',
            { url: page.url },
          )
        : null;
    },
  ),

  siteCheck(
    commerce({
      id: 'agentic-commerce.no-checkout-protocol',
      title: 'Shop with no agent checkout protocol',
      why: 'Agent checkout protocols are new: the Agentic Commerce Protocol (OpenAI and Stripe), the Universal Commerce Protocol (Google and partners) and x402 payments. Early adopters can be bought from inside an assistant; most shops have none yet, and platform integrations (Shopify, Stripe, Google Merchant Center) are the usual route in.',
      severity: 'info',
      fixTier: 'manual',
      fix: 'Check whether your commerce platform or payment provider offers ACP or UCP support, and keep product data (identifiers, prices, availability) complete so you are ready when it does.',
      refs: [REF.acp, REF.ucp, REF.x402],
    }),
    (site) => {
      if (productPages(site).length < 3 || !probesRan(site)) return null;
      const home = homePage(site);
      const mentions = /agentic.?commerce|\bacp\b|universal.?commerce/i.test(
        `${home?.html ?? ''}${probe(site, 'api-catalog')?.body ?? ''}`,
      );
      const mpp = /x-payment-info/.test(openapi(site)?.body ?? '');
      return found(site, 'ucp-profile') ||
        found(site, 'x402-discovery') ||
        found(site, 'acp-json') ||
        mpp ||
        mentions
        ? null
        : issue(
            'agentic-commerce.no-checkout-protocol',
            `${productPages(site).length} product pages and no UCP profile, ACP discovery file, x402 discovery, MPP payment info or ACP reference found.`,
          );
    },
  ),

  siteCheck(
    commerce({
      id: 'agentic-commerce.ucp-invalid',
      title: 'UCP business profile is invalid',
      why: 'Agents read /.well-known/ucp to learn which commerce capabilities you support. An invalid profile stops them at the first step.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Fix the listed errors against the current UCP specification.',
      refs: [REF.ucp],
    }),
    (site) => {
      const p = found(site, 'ucp-profile');
      if (!p) return null;
      if (p.parsed === undefined)
        return issue('agentic-commerce.ucp-invalid', `${p.url} is not valid JSON.`);
      const v = validateUcpProfile(p.parsed);
      return (
        listIssues('agentic-commerce.ucp-invalid', 'UCP profile has problems', v, p.url) ??
        listIssues(
          'agentic-commerce.ucp-invalid',
          'UCP profile could say more',
          v,
          p.url,
          'warnings',
        )
      );
    },
  ),

  siteCheck(
    commerce({
      id: 'agentic-commerce.x402-invalid',
      title: 'x402 payment endpoint is misconfigured',
      why: 'x402 lets an agent pay for a resource after an HTTP 402 response describing the payment. If the advertised resource does not answer 402, or the payment requirements are malformed, agents cannot pay.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Return 402 with a JSON body containing x402Version and an accepts list (scheme, network, amount, payTo, asset) for unpaid requests.',
      refs: [REF.x402],
    }),
    (site) => {
      const r = probe(site, 'x402-resource');
      if (!r || r.status === null) return null;
      if (r.status !== 402)
        return issue(
          'agentic-commerce.x402-invalid',
          `The advertised paid resource returned ${r.status}, not 402.`,
          { evidence: r.url },
        );
      const header = r.headers?.['payment-required'];
      if (r.parsed === undefined && header) return null; // v2 header form; not decoded here
      return listIssues(
        'agentic-commerce.x402-invalid',
        'Payment requirements have problems',
        validateX402(r.parsed),
        r.url,
      );
    },
  ),

  siteCheck(
    commerce({
      id: 'agentic-commerce.products-without-schema',
      title: 'Shop pages without Product markup',
      why: 'Shopping agents and AI answers read prices and availability from Product schema. Product pages without it must be scraped, which is error-prone.',
      severity: 'medium',
      fixTier: 'guided',
      fix: 'Add Product JSON-LD with name, image, identifiers and offers to every product page (most shop platforms and SEO plugins can).',
      refs: [REF.product],
    }),
    (site) => {
      const shopPaths = htmlPages(site).filter(
        (p) =>
          isIndexable(p) &&
          /\/(products?|shop|store|item|p)\/[^/]+/i.test(safeUrl(p.url)?.pathname ?? ''),
      );
      if (shopPaths.length < 3) return null;
      const without = shopPaths.filter((p) => !nodesOfType(p, ['Product', 'ProductGroup']).length);
      return without.length / shopPaths.length > 0.5
        ? issue(
            'agentic-commerce.products-without-schema',
            `${without.length} of ${shopPaths.length} product-like pages have no Product markup.`,
            { evidence: ev(without.slice(0, 6).map((p) => p.url)) },
          )
        : null;
    },
  ),
];

/** Exposed for tests. */
export const _internal = { keyForms, offersOf, hasApiSignals, strList };

// ---------------------------------------------------------------------------
// Added for feature parity: Link headers, DNS-AID, auth.md, agent skills, ACP
// ---------------------------------------------------------------------------

/** Validate an agent skills discovery index (/.well-known/agent-skills/index.json). */
export function validateSkillsIndex(data: unknown): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: Record<string, unknown> = {};
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { valid: false, errors: ['The index is not a JSON object.'], warnings, info };
  const d = data as JsonNode;
  const skills = d.skills;
  if (!Array.isArray(skills) || !skills.length) errors.push('"skills" must be a non-empty array.');
  else {
    info.skills = skills.length;
    skills.slice(0, 50).forEach((sk, i) => {
      const x = (sk ?? {}) as JsonNode;
      for (const k of ['name', 'description', 'url'])
        if (!str(x[k])) errors.push(`skills[${i}] has no "${k}".`);
      if (!str(x.sha256) && !str(x.digest))
        warnings.push(`skills[${i}] has no sha256 digest, so agents cannot verify it.`);
    });
  }
  if (!str(d.$schema)) warnings.push('No "$schema" field naming the index version.');
  return { valid: !errors.length, errors, warnings, info };
}

/** Validate an ACP discovery file (/.well-known/acp.json). */
export function validateAcp(data: unknown): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { valid: false, errors: ['The file is not a JSON object.'], warnings, info: {} };
  const d = data as JsonNode;
  const protocol = (d.protocol ?? {}) as JsonNode;
  if (String(str(protocol.name) ?? '').toLowerCase() !== 'acp')
    errors.push('protocol.name is not "acp".');
  if (!str(protocol.version)) errors.push('protocol.version is missing.');
  const base = str(d.api_base_url) ?? str(d.apiBaseUrl);
  if (!base) errors.push('api_base_url is missing.');
  else if (!/^https:\/\//i.test(base)) errors.push('api_base_url must be an https URL.');
  const caps = (d.capabilities ?? {}) as JsonNode;
  if (!caps || !Array.isArray(caps.services) || !caps.services.length)
    warnings.push('capabilities.services lists nothing.');
  return { valid: !errors.length, errors, warnings, info: {} };
}

checks.push(
  siteCheck(
    agentic({
      id: 'agentic.link-header-missing',
      title: 'Discovery documents not advertised in a Link header',
      why: 'RFC 8288 Link headers let an agent learn where your API catalog, service docs or agent card live from a single request to the home page, without guessing well-known paths. RFC 9727 recommends rel="api-catalog" for exactly this.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add a Link header to the home page response for each discovery document, e.g. Link: </.well-known/api-catalog>; rel="api-catalog", </docs/api>; rel="service-doc".',
      refs: ['https://www.rfc-editor.org/rfc/rfc8288', REF.rfc9727],
    }),
    (site) => {
      if (!probesRan(site)) return null;
      const docs = ['api-catalog', 'mcp-server-card', 'mcp-json', 'a2a-agent-card', 'openapi-json']
        .map((id) => found(site, id))
        .filter((x): x is ProbeResult => Boolean(x));
      if (!docs.length) return null;
      const links = (probe(site, 'link-headers')?.parsed ?? {}) as Record<string, string[]>;
      const advertised = Object.values(links).flat();
      const missing = docs.filter(
        (d) => !advertised.some((h) => h.split('?')[0] === d.url.split('?')[0]),
      );
      if (!missing.length) return null;
      return issue(
        'agentic.link-header-missing',
        `${plural(missing.length, 'discovery document')} published but not linked from the home page's Link header.`,
        { evidence: ev(missing.map((d) => d.url)) },
      );
    },
  ),
  siteCheck(
    agentic({
      id: 'agentic.dns-aid-missing',
      title: 'Agent endpoints not published in DNS (DNS-AID)',
      why: "DNS for AI Discovery is an IETF draft that lets agents find a domain's MCP or A2A endpoints through SVCB records (for example _mcp._agents.example.com), before any HTTP request. Early, but cheap to add once you publish an agent.",
      severity: 'info',
      fixTier: 'guided',
      fix: 'Add a ServiceMode SVCB (or HTTPS) record at _mcp._agents.<your domain> and/or _a2a._agents.<your domain> pointing at the endpoint host, with alpn and port parameters. Sign the zone with DNSSEC.',
      refs: [
        'https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/',
        'https://www.rfc-editor.org/rfc/rfc9460',
      ],
    }),
    (site) => {
      const p = probe(site, 'dns-aid');
      if (!p || p.found || p.status === null) return null;
      const r = p.parsed as { checked?: string[] } | undefined;
      return issue(
        'agentic.dns-aid-missing',
        'The site publishes an agent card but no DNS-AID records were found.',
        { evidence: ev(r?.checked ?? []) },
      );
    },
  ),
  siteCheck(
    agentic({
      id: 'agentic.auth-md-missing',
      title: 'No auth.md telling agents how to sign up',
      why: 'auth.md is a proposed plain-language file at the site root that tells AI agents how to register and authenticate with your API. It complements OAuth metadata, which says where the endpoints are but not the steps or policies. A proposal, not a standard.',
      severity: 'info',
      fixTier: 'guided',
      fix: 'Serve /auth.md (text/markdown) describing how an agent gets credentials: the registration URL, supported grant types, scopes and any human approval step. Link it from your protected resource metadata.',
      refs: ['https://github.com/workos/auth.md', REF.rfc9728],
    }),
    (site) => {
      if (!probesRan(site) || found(site, 'auth-md')) return null;
      if (!found(site, 'oauth-prm') && !found(site, 'oauth-as')) return null;
      return issue('agentic.auth-md-missing', 'OAuth discovery is published but /auth.md is not.');
    },
  ),
  siteCheck(
    agentic({
      id: 'agentic.agent-skills-invalid',
      title: 'Agent skills index is invalid',
      why: 'An agent skills index (/.well-known/agent-skills/index.json, a Cloudflare-led proposal) lists skills agents can download and use with your service. Entries without a name, description, URL or digest are skipped or cannot be verified.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Give each entry a name, description, url and sha256 digest of the skill file, and a $schema field for the index version.',
      refs: ['https://github.com/cloudflare/agent-skills-discovery-rfc'],
    }),
    (site) => {
      const p = found(site, 'agent-skills');
      if (!p) return null;
      if (p.parsed === undefined)
        return issue('agentic.agent-skills-invalid', `${p.url} is not valid JSON.`);
      const v = validateSkillsIndex(p.parsed);
      return (
        listIssues('agentic.agent-skills-invalid', 'Agent skills index has problems', v, p.url) ??
        listIssues(
          'agentic.agent-skills-invalid',
          'Agent skills index could say more',
          v,
          p.url,
          'warnings',
        )
      );
    },
  ),
  siteCheck(
    commerce({
      id: 'agentic-commerce.acp-invalid',
      title: 'ACP discovery file is invalid',
      why: 'Agents that support the Agentic Commerce Protocol read /.well-known/acp.json to learn the protocol version and where your checkout API lives. Missing fields stop them before checkout.',
      severity: 'low',
      fixTier: 'guided',
      fix: 'Include protocol.name "acp", protocol.version, an https api_base_url and capabilities.services, following the current ACP specification.',
      refs: [REF.acp],
    }),
    (site) => {
      const p = found(site, 'acp-json');
      if (!p) return null;
      if (p.parsed === undefined)
        return issue('agentic-commerce.acp-invalid', `${p.url} is not valid JSON.`);
      const v = validateAcp(p.parsed);
      return (
        listIssues('agentic-commerce.acp-invalid', 'ACP discovery file has problems', v, p.url) ??
        listIssues(
          'agentic-commerce.acp-invalid',
          'ACP discovery file could say more',
          v,
          p.url,
          'warnings',
        )
      );
    },
  ),
);
