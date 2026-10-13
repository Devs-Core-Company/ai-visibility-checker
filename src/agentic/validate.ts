/**
 * Shape validators for the agentic-web discovery documents. Written from the
 * specs, deliberately lenient where a spec is still a draft: an error means a
 * consumer following the spec would fail; a warning means it would work but
 * lose something.
 */

export interface Validation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Useful extracted values (endpoints, names, counts). */
  info: Record<string, unknown>;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
function isUrl(v: unknown): boolean {
  if (!isStr(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}
function isHttps(v: unknown): boolean {
  return isStr(v) && /^https:\/\//i.test(v);
}
function isLocal(v: unknown): boolean {
  return isStr(v) && /^https?:\/\/(localhost|127\.|\[::1\])/i.test(v);
}
function done(
  errors: string[],
  warnings: string[],
  info: Record<string, unknown> = {},
): Validation {
  return { valid: errors.length === 0, errors, warnings, info };
}
function notObject(what: string): Validation {
  return done([`${what} is not a JSON object.`], []);
}

// ---------------------------------------------------------------------------
// A2A Agent Card (a2a-protocol.org; /.well-known/agent-card.json)
// ---------------------------------------------------------------------------

export function validateAgentCard(card: unknown): Validation {
  if (!isObj(card)) return notObject('The agent card');
  const e: string[] = [];
  const w: string[] = [];
  if (!isStr(card.name)) e.push('Missing "name".');
  if (!isStr(card.description))
    e.push('Missing "description" — agents use it to decide whether to call you.');
  if (!isStr(card.version)) w.push('Missing "version" of your agent.');
  if (!isStr(card.protocolVersion))
    w.push('Missing "protocolVersion", so clients must guess which A2A version you speak.');

  // v0.x: url (+ preferredTransport, additionalInterfaces). v1: supportedInterfaces[].url.
  const endpoints: string[] = [];
  if (isStr(card.url)) endpoints.push(card.url);
  for (const key of ['supportedInterfaces', 'additionalInterfaces']) {
    const list = card[key];
    if (Array.isArray(list))
      for (const i of list) if (isObj(i) && isStr(i.url)) endpoints.push(i.url);
  }
  if (!endpoints.length) e.push('No endpoint: set "url" (or "supportedInterfaces" with a url).');
  for (const u of endpoints) {
    if (!isUrl(u)) e.push(`Endpoint "${u}" is not an absolute URL.`);
    else if (!isHttps(u) && !isLocal(u))
      e.push(`Endpoint "${u}" is not HTTPS; A2A requires TLS in production.`);
  }

  if (!isObj(card.capabilities))
    e.push('Missing "capabilities" object (streaming, pushNotifications…).');
  for (const key of ['defaultInputModes', 'defaultOutputModes']) {
    if (!Array.isArray(card[key]) || !(card[key] as unknown[]).length)
      e.push(`Missing "${key}" (MIME types such as text/plain).`);
  }
  const skills = Array.isArray(card.skills) ? card.skills : null;
  if (!skills) e.push('Missing "skills" array.');
  else if (!skills.length)
    e.push('"skills" is empty: an agent with no skills gives clients nothing to call.');
  else {
    skills.forEach((s, i) => {
      if (!isObj(s)) return e.push(`Skill ${i + 1} is not an object.`);
      const label = isStr(s.name) ? `"${s.name}"` : `${i + 1}`;
      if (!isStr(s.id)) e.push(`Skill ${label} has no "id".`);
      if (!isStr(s.name)) e.push(`Skill ${i + 1} has no "name".`);
      if (!isStr(s.description)) e.push(`Skill ${label} has no "description".`);
      if (!Array.isArray(s.tags)) w.push(`Skill ${label} has no "tags".`);
      if (!Array.isArray(s.examples) || !s.examples.length)
        w.push(`Skill ${label} has no "examples" prompts.`);
    });
  }
  const schemes = card.securitySchemes;
  const hasAuth = isObj(schemes) && Object.keys(schemes).length > 0;
  if (!hasAuth) w.push('No "securitySchemes": clients will assume the agent is open to anyone.');
  if (!isObj(card.provider) || !isStr((card.provider as Obj).organization))
    w.push('No "provider.organization" naming who runs the agent.');
  if (!isStr(card.documentationUrl)) w.push('No "documentationUrl".');
  return done(e, w, {
    name: card.name,
    endpoints,
    skills: skills?.length ?? 0,
    hasAuth,
    protocolVersion: card.protocolVersion,
  });
}

// ---------------------------------------------------------------------------
// MCP server card / discovery document (MCP SEP drafts; /.well-known/mcp*)
// ---------------------------------------------------------------------------

export function validateMcpCard(card: unknown): Validation {
  if (!isObj(card)) return notObject('The MCP discovery document');
  const e: string[] = [];
  const w: string[] = [];
  const serverInfo = isObj(card.serverInfo)
    ? card.serverInfo
    : isObj(card.server)
      ? (card.server as Obj)
      : card;
  const name = isStr(serverInfo.name) ? serverInfo.name : isStr(card.name) ? card.name : null;
  if (!name) e.push('No server name ("serverInfo.name" or "name").');
  if (!isStr(serverInfo.version) && !isStr(card.version)) w.push('No server version.');
  if (!isStr(card.description) && !isStr(serverInfo.description) && !isStr(serverInfo.title))
    w.push('No description or title for the server.');

  // Endpoints in the shapes in current use: transport.endpoint, url, endpoint,
  // remotes[] (registry server.json), servers[] / mcp_servers[] (site-level lists).
  const endpoints: string[] = [];
  const push = (v: unknown) => {
    if (isStr(v)) endpoints.push(v);
  };
  if (isObj(card.transport)) {
    push((card.transport as Obj).endpoint);
    push((card.transport as Obj).url);
  }
  push(card.url);
  push(card.endpoint);
  for (const key of ['remotes', 'servers', 'mcp_servers', 'endpoints', 'transports']) {
    const list = card[key];
    if (Array.isArray(list))
      for (const r of list) {
        if (isStr(r)) push(r);
        else if (isObj(r)) {
          push(r.url);
          push(r.endpoint);
        }
      }
  }
  if (!endpoints.length)
    e.push('No endpoint URL for the server (transport.endpoint, url or remotes[].url).');
  const absolute = endpoints.map((u) => u);
  for (const u of absolute) {
    if (/^\//.test(u)) continue; // relative to the origin is allowed by the card drafts
    if (!isUrl(u)) e.push(`Endpoint "${u}" is not a URL.`);
    else if (!isHttps(u) && !isLocal(u)) e.push(`Endpoint "${u}" is not HTTPS.`);
  }

  const auth = isObj(card.authentication)
    ? (card.authentication as Obj)
    : isObj(card.auth)
      ? (card.auth as Obj)
      : null;
  const authRequired = auth
    ? auth.required === true || (Array.isArray(auth.schemes) && auth.schemes.length > 0)
    : false;
  const listed = (k: string) =>
    Array.isArray(card[k]) ||
    card[k] === 'dynamic' ||
    (isObj(card.capabilities) && k in (card.capabilities as Obj));
  const hasTools = listed('tools');
  if (!hasTools && !listed('resources') && !listed('prompts'))
    w.push(
      'No tools, resources or prompts declared, so a client cannot tell what the server offers before connecting.',
    );
  if (
    !isStr(card.protocolVersion) &&
    !(Array.isArray(card.protocolVersions) && card.protocolVersions.length)
  )
    w.push('No "protocolVersion".');
  return done(e, w, { name, endpoints, authRequired, hasTools });
}

// ---------------------------------------------------------------------------
// OAuth 2.0 Authorization Server Metadata (RFC 8414)
// ---------------------------------------------------------------------------

export function validateOAuthAS(meta: unknown, expectedIssuer?: string): Validation {
  if (!isObj(meta)) return notObject('The authorization server metadata');
  const e: string[] = [];
  const w: string[] = [];
  if (!isStr(meta.issuer)) e.push('Missing "issuer" (required).');
  else {
    if (!isHttps(meta.issuer) && !isLocal(meta.issuer)) e.push('"issuer" must be an https URL.');
    if (/[?#]/.test(meta.issuer)) e.push('"issuer" must not contain a query or fragment.');
    if (expectedIssuer && meta.issuer.replace(/\/$/, '') !== expectedIssuer.replace(/\/$/, ''))
      e.push(
        `"issuer" is ${meta.issuer} but the document was served for ${expectedIssuer}; RFC 8414 §3.3 says clients must reject that.`,
      );
  }
  const grants = Array.isArray(meta.grant_types_supported)
    ? (meta.grant_types_supported as string[])
    : ['authorization_code', 'implicit'];
  const usesAuthz = grants.includes('authorization_code') || grants.includes('implicit');
  if (usesAuthz && !isUrl(meta.authorization_endpoint)) e.push('Missing "authorization_endpoint".');
  if (!(grants.length === 1 && grants[0] === 'implicit') && !isUrl(meta.token_endpoint))
    e.push('Missing "token_endpoint".');
  if (!Array.isArray(meta.response_types_supported) || !meta.response_types_supported.length)
    e.push('Missing "response_types_supported" (required).');
  const pkce = Array.isArray(meta.code_challenge_methods_supported)
    ? (meta.code_challenge_methods_supported as string[])
    : [];
  if (!pkce.includes('S256'))
    w.push(
      '"code_challenge_methods_supported" does not list S256 (PKCE), which OAuth 2.1 and MCP clients require.',
    );
  const dcr = isUrl(meta.registration_endpoint);
  const cimd = meta.client_id_metadata_document_supported === true;
  if (!dcr && !cimd)
    w.push(
      'No "registration_endpoint" and no client ID metadata document support, so new AI clients cannot register themselves.',
    );
  if (!isUrl(meta.jwks_uri)) w.push('No "jwks_uri".');
  return done(e, w, { issuer: meta.issuer, pkceS256: pkce.includes('S256'), dcr, cimd });
}

// ---------------------------------------------------------------------------
// OAuth 2.0 Protected Resource Metadata (RFC 9728)
// ---------------------------------------------------------------------------

export function validatePRM(meta: unknown, expectedResource?: string): Validation {
  if (!isObj(meta)) return notObject('The protected resource metadata');
  const e: string[] = [];
  const w: string[] = [];
  if (!isStr(meta.resource)) e.push('Missing "resource" (required).');
  else {
    if (!isHttps(meta.resource) && !isLocal(meta.resource))
      e.push('"resource" must be an https URL.');
    if (
      expectedResource &&
      meta.resource.replace(/\/$/, '') !== expectedResource.replace(/\/$/, '')
    )
      e.push(
        `"resource" is ${meta.resource} but the document was served for ${expectedResource}; RFC 9728 §3.3 says clients must reject that.`,
      );
  }
  const servers = Array.isArray(meta.authorization_servers)
    ? (meta.authorization_servers as unknown[]).filter(isStr)
    : [];
  if (!servers.length)
    w.push('No "authorization_servers", so a client cannot find where to get a token.');
  for (const s of servers)
    if (!isHttps(s) && !isLocal(s)) e.push(`Authorization server "${s}" is not an https URL.`);
  if (!Array.isArray(meta.scopes_supported)) w.push('No "scopes_supported".');
  return done(e, w, { resource: meta.resource, authorizationServers: servers });
}

// ---------------------------------------------------------------------------
// OpenID Connect Discovery 1.0
// ---------------------------------------------------------------------------

export function validateOpenId(meta: unknown, expectedIssuer?: string): Validation {
  if (!isObj(meta)) return notObject('The OpenID configuration');
  const e: string[] = [];
  const w: string[] = [];
  for (const k of ['issuer', 'authorization_endpoint', 'jwks_uri'])
    if (!isStr(meta[k])) e.push(`Missing "${k}".`);
  for (const k of [
    'response_types_supported',
    'subject_types_supported',
    'id_token_signing_alg_values_supported',
  ])
    if (!Array.isArray(meta[k]) || !(meta[k] as unknown[]).length) e.push(`Missing "${k}".`);
  if (!isStr(meta.token_endpoint))
    w.push('Missing "token_endpoint" (required unless only the implicit flow is used).');
  if (
    isStr(meta.issuer) &&
    expectedIssuer &&
    meta.issuer.replace(/\/$/, '') !== expectedIssuer.replace(/\/$/, '')
  )
    e.push(`"issuer" is ${meta.issuer} but the document was served for ${expectedIssuer}.`);
  return done(e, w, { issuer: meta.issuer });
}

// ---------------------------------------------------------------------------
// API catalog (RFC 9727, Linkset JSON per RFC 9264)
// ---------------------------------------------------------------------------

export function validateApiCatalog(doc: unknown, contentType?: string): Validation {
  if (!isObj(doc)) return notObject('The API catalog');
  const e: string[] = [];
  const w: string[] = [];
  const linkset = doc.linkset;
  if (!Array.isArray(linkset))
    return done(['Missing top-level "linkset" array (RFC 9264 JSON format).'], []);
  const serviceDescs: string[] = [];
  let anchors = 0;
  for (const ctx of linkset) {
    if (!isObj(ctx)) continue;
    if (isStr(ctx.anchor)) anchors++;
    for (const rel of ['service-desc', 'service-doc', 'service-meta', 'item']) {
      const targets = ctx[rel];
      if (targets !== undefined && !Array.isArray(targets))
        e.push(`"${rel}" must be an array of target objects.`);
      if (Array.isArray(targets))
        for (const t of targets) {
          if (!isObj(t) || !isStr(t.href)) e.push(`A "${rel}" entry has no "href".`);
          else if (rel === 'service-desc') serviceDescs.push(t.href);
        }
    }
  }
  if (!linkset.length) e.push('"linkset" is empty.');
  if (linkset.length && !anchors)
    w.push(
      'No "anchor" on any link context, so clients cannot tell which API each entry describes.',
    );
  if (contentType && !/application\/linkset\+json/i.test(contentType))
    w.push(`Served as ${contentType}; RFC 9727 asks for application/linkset+json.`);
  return done(e, w, { serviceDescs, entries: linkset.length });
}

// ---------------------------------------------------------------------------
// OpenAPI description
// ---------------------------------------------------------------------------

export function validateOpenApi(doc: unknown, rawText?: string): Validation {
  if (!isObj(doc)) {
    // YAML: check the essentials textually.
    if (rawText && /^\s*(openapi|swagger)\s*:/m.test(rawText)) {
      const e: string[] = [];
      if (!/^\s*info\s*:/m.test(rawText)) e.push('Missing "info".');
      if (!/^\s*paths\s*:/m.test(rawText) && !/^\s*webhooks\s*:/m.test(rawText))
        e.push('Missing "paths".');
      return done(e, [], { format: 'yaml' });
    }
    return notObject('The OpenAPI document');
  }
  const e: string[] = [];
  const w: string[] = [];
  if (!isStr(doc.openapi) && !isStr(doc.swagger)) e.push('Missing "openapi" version field.');
  if (isStr(doc.swagger)) w.push('Swagger 2.0; most agent frameworks expect OpenAPI 3.x.');
  if (!isObj(doc.info) || !isStr((doc.info as Obj).title)) e.push('Missing "info.title".');
  if (!isObj(doc.paths) && !isObj(doc.webhooks)) e.push('Missing "paths".');
  const paths = isObj(doc.paths) ? Object.keys(doc.paths as Obj).length : 0;
  let opsWithoutDescription = 0;
  if (isObj(doc.paths))
    for (const item of Object.values(doc.paths as Obj))
      if (isObj(item))
        for (const [m, op] of Object.entries(item))
          if (
            /^(get|put|post|delete|patch)$/.test(m) &&
            isObj(op) &&
            !isStr(op.summary) &&
            !isStr(op.description)
          )
            opsWithoutDescription++;
  if (opsWithoutDescription)
    w.push(
      `${opsWithoutDescription} operation(s) have no summary or description for an agent to read.`,
    );
  return done(e, w, { paths, format: 'json' });
}

// ---------------------------------------------------------------------------
// Web Bot Auth key directory (HTTP Message Signatures directory draft)
// ---------------------------------------------------------------------------

export function validateSignatureDirectory(
  doc: unknown,
  headers: Record<string, string> = {},
): Validation {
  if (!isObj(doc)) return notObject('The signatures directory');
  const e: string[] = [];
  const w: string[] = [];
  const keys = Array.isArray(doc.keys) ? doc.keys : null;
  if (!keys) e.push('Missing "keys" array (a JWKS).');
  else if (!keys.length) e.push('"keys" is empty.');
  else
    keys.forEach((k, i) => {
      if (!isObj(k)) return e.push(`Key ${i + 1} is not an object.`);
      if (!isStr(k.kty)) e.push(`Key ${i + 1} has no "kty".`);
      if (k.kty === 'OKP' && k.crv !== 'Ed25519')
        w.push(
          `Key ${i + 1} uses ${String(k.crv)}; the draft's examples and most verifiers expect Ed25519.`,
        );
      if (!isStr(k.x) && !isStr(k.n)) e.push(`Key ${i + 1} has no public key material.`);
      if (isStr(k.d))
        e.push(`Key ${i + 1} includes a private key ("d"). Remove it and rotate the key now.`);
    });
  const ct = headers['content-type'] ?? '';
  if (ct && !/application\/http-message-signatures-directory\+json/i.test(ct))
    w.push(`Served as ${ct}; the draft uses application/http-message-signatures-directory+json.`);
  if (!headers['signature'] || !headers['signature-input'])
    w.push(
      'The response is not signed (no Signature / Signature-Input headers), so verifiers cannot prove the directory is yours.',
    );
  return done(e, w, { keys: keys?.length ?? 0 });
}

// ---------------------------------------------------------------------------
// Legacy ChatGPT plugin manifest
// ---------------------------------------------------------------------------

export function validateAiPlugin(doc: unknown): Validation {
  if (!isObj(doc)) return notObject('ai-plugin.json');
  const e: string[] = [];
  if (!isStr(doc.name_for_model)) e.push('Missing "name_for_model".');
  if (!isObj(doc.api) || !isStr((doc.api as Obj).url)) e.push('Missing "api.url".');
  return done(e, [], { api: isObj(doc.api) ? (doc.api as Obj).url : undefined });
}

// ---------------------------------------------------------------------------
// x402 payment requirements (HTTP 402 body)
// ---------------------------------------------------------------------------

export function validateX402(doc: unknown): Validation {
  if (!isObj(doc)) return notObject('The 402 payment requirements');
  const e: string[] = [];
  const w: string[] = [];
  if (doc.x402Version === undefined) e.push('Missing "x402Version".');
  const accepts = Array.isArray(doc.accepts) ? doc.accepts : null;
  if (!accepts || !accepts.length) e.push('Missing or empty "accepts" list of payment options.');
  else
    accepts.forEach((a, i) => {
      if (!isObj(a)) return e.push(`Payment option ${i + 1} is not an object.`);
      for (const k of ['scheme', 'network', 'payTo'])
        if (!isStr(a[k])) e.push(`Payment option ${i + 1} has no "${k}".`);
      if (!isStr(a.maxAmountRequired) && !isStr(a.amount) && typeof a.amount !== 'number')
        e.push(`Payment option ${i + 1} has no amount.`);
      if (!isStr(a.description))
        w.push(`Payment option ${i + 1} has no "description" of what is being bought.`);
    });
  return done(e, w, { options: accepts?.length ?? 0 });
}

// ---------------------------------------------------------------------------
// Universal Commerce Protocol business profile (/.well-known/ucp)
// ---------------------------------------------------------------------------

export function validateUcpProfile(doc: unknown): Validation {
  if (!isObj(doc)) return notObject('The UCP profile');
  const e: string[] = [];
  const w: string[] = [];
  const root = isObj(doc.ucp) ? (doc.ucp as Obj) : doc;
  if (!isStr(root.version)) e.push('Missing "version".');
  const services = root.services;
  const caps = root.capabilities;
  if (!services && !caps) e.push('No "services" or "capabilities" declared.');
  if (!caps) w.push('No "capabilities" (e.g. checkout), so agents cannot tell what they can do.');
  return done(e, w, {});
}

// ---------------------------------------------------------------------------
// robots.txt AI preference lines: Content-Signal and IETF aipref Content-Usage
// ---------------------------------------------------------------------------

export interface AiPreference {
  key: 'content-signal' | 'content-usage';
  line: number;
  raw: string;
  values: Record<string, string>;
  problems: string[];
}

const SIGNAL_KEYS = ['search', 'ai-input', 'ai-train'];
const USAGE_KEYS = ['train-ai', 'train-genai', 'search', 'ai-use', 'bots', 'tdm'];

export function parseAiPreference(key: string, value: string, line: number): AiPreference | null {
  const k = key.toLowerCase();
  if (k !== 'content-signal' && k !== 'content-usage') return null;
  const values: Record<string, string> = {};
  const problems: string[] = [];
  // Content-Usage may carry a path before the vocabulary: "Content-Usage: /blog/ train-ai=n".
  const body = k === 'content-usage' ? value.replace(/^\/\S*\s+/, '') : value;
  for (const part of body.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^([a-z0-9-]+)=([a-z]+)$/i);
    if (!m) {
      problems.push(`"${part}" is not key=value.`);
      continue;
    }
    const name = m[1]!.toLowerCase();
    const v = m[2]!.toLowerCase();
    values[name] = v;
    const known = k === 'content-signal' ? SIGNAL_KEYS : USAGE_KEYS;
    if (!known.includes(name))
      problems.push(`Unknown key "${name}" (expected ${known.join(', ')}).`);
    const okValues = k === 'content-signal' ? ['yes', 'no'] : ['y', 'n', 'yes', 'no'];
    if (!okValues.includes(v)) problems.push(`"${name}=${v}" should be ${okValues.join(' or ')}.`);
  }
  if (!Object.keys(values).length) problems.push('No preferences declared on the line.');
  return { key: k, line, raw: `${key}: ${value}`, values, problems };
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

export function inspectFeed(body: string): {
  kind: 'rss' | 'atom' | 'json' | null;
  items: number;
  newest?: string;
} {
  if (/<rss[\s>]/i.test(body) || /<rdf:RDF/i.test(body)) {
    const items = (body.match(/<item[\s>]/gi) ?? []).length;
    const d = body.match(/<pubDate>([^<]+)<\/pubDate>/i)?.[1];
    return { kind: 'rss', items, newest: d };
  }
  if (/<feed[\s>]/i.test(body) && /xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(body)) {
    const items = (body.match(/<entry[\s>]/gi) ?? []).length;
    const d = body.match(/<updated>([^<]+)<\/updated>/i)?.[1];
    return { kind: 'atom', items, newest: d };
  }
  try {
    const j = JSON.parse(body) as Obj;
    if (isStr(j.version) && /jsonfeed/.test(j.version) && Array.isArray(j.items))
      return { kind: 'json', items: j.items.length };
  } catch {
    /* not JSON */
  }
  return { kind: null, items: 0 };
}
