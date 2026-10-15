/**
 * App configuration: where data lives and which keys/connections are set.
 *
 * Precedence: CLI flags > environment variables > project file (./avc.config.json)
 * > secret store > user file (~/.avc/config.json) > defaults.
 *
 * Secrets (see SECRET_FIELDS) live in env vars or the OS secret store (./secrets.ts), never
 * in a config file: saving moves them out of the user file, a user file from an older
 * version is migrated on load, and secrets found in the project file, which people commit,
 * are ignored with a warning.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  SECRET_FIELDS,
  deletePath,
  getPath,
  secretStore,
  setPath,
  wordpressSecretId,
} from './secrets.js';
import type { BrandProfile, EngineId, TrackedPrompt } from './types.js';

export interface AvcConfig {
  /** Data directory: database, OAuth tokens, rollback snapshots. Default ~/.avc */
  dataDir: string;
  sites: SiteConfig[];
  ai: {
    /** Vercel AI Gateway key — one key for every engine. */
    gatewayKey?: string;
    openaiKey?: string;
    /** OpenAI-compatible endpoint for the writer, judge and embeddings (OpenRouter, Groq, DeepSeek, Ollama…). */
    openaiBaseUrl?: string;
    anthropicKey?: string;
    googleKey?: string;
    perplexityKey?: string;
    xaiKey?: string;
    /** Use fake answers (no spend). */
    mock?: boolean;
    /** Hard ceiling per visibility run, USD. Default 3. */
    maxRunUsd: number;
    /** Hard ceiling per calendar month, USD. Default 30. */
    maxMonthUsd: number;
    models?: Partial<Record<EngineId | 'judge' | 'writer', string>>;
  };
  google?: {
    /** OAuth client for an installed app (Desktop type) — from Google Cloud console. */
    clientId?: string;
    clientSecret?: string;
    /** Or a service-account JSON key file path (added as a user on the GSC property / GA4). */
    serviceAccountFile?: string;
    psiKey?: string;
  };
  bing?: { apiKey?: string };
  alerts?: {
    webhookUrl?: string; // Slack/Discord/Teams-compatible incoming webhook
    email?: { to: string; from?: string; smtpUrl?: string };
  };
  server: { port: number; host: string };
  /** Spelling and grammar with LanguageTool. Off unless a server is set or the public API is opted into. */
  spelling?: {
    /** e.g. http://localhost:8081 for a self-hosted LanguageTool server. */
    server?: string;
    /** Opt in to the free public API (api.languagetool.org): page text leaves your machine. */
    usePublicApi?: boolean;
    /** Pages to check per audit. Default 25 (10 on the public API). */
    maxPages?: number;
    /** Language code, or 'auto' (default: the page's lang attribute). */
    language?: string;
    /** Words never flagged (brand and product names). */
    ignore?: string[];
  };
  /** Google Safe Browsing API key for outbound link checks. */
  safeBrowsing?: { key?: string };
  /** Page embeddings for meaning-based duplicates and off-topic pages. Off by default. */
  embeddings?: {
    enabled?: boolean;
    /** e.g. 'text-embedding-3-small' (OpenAI) or 'openai/text-embedding-3-small' (AI Gateway). */
    model?: string;
    /** Cosine similarity at or above which two pages count as the same meaning. Default 0.92. */
    threshold?: number;
    maxPages?: number;
  };
  /** Backlink metrics from your own provider subscription. */
  backlinks?: {
    provider?: 'moz' | 'ahrefs' | 'majestic';
    mozToken?: string;
    ahrefsToken?: string;
    majesticKey?: string;
  };
  /** Your own fix guidance, replacing or adding to the built-in recipes per check id. */
  fixes?: {
    overrides?: Record<string, { steps?: string[]; note?: string; replace?: boolean }>;
  };
  /** White-label branding for HTML and PDF reports. */
  report?: { brandName?: string; brandColor?: string; brandLogo?: string; brandContact?: string };
  /** Named crawl profiles: `avc audit <url> --profile <name>`. */
  profiles?: Record<string, CrawlProfile>;
}

/** Saved crawl settings (any crawl option except credentials). */
export type CrawlProfile = Partial<
  Omit<import('./types.js').CrawlOptions, 'startUrl' | 'auth' | 'headers'>
> & { description?: string };

export interface SiteConfig {
  id: string; // slug of the host
  url: string; // start URL
  brand?: Partial<BrandProfile>;
  prompts?: TrackedPrompt[];
  crawl?: {
    maxPages?: number;
    maxDepth?: number;
    render?: boolean | 'auto';
    include?: string[];
    exclude?: string[];
    /** A named profile from `profiles`, or a platform preset ("auto", "wordpress", …). */
    profile?: string;
    preset?: string;
  };
  connections?: {
    gscProperty?: string; // 'sc-domain:example.com' or 'https://example.com/'
    ga4Property?: string; // 'properties/123456'
    logs?: string[]; // paths/globs of access logs
    repoPath?: string; // local source of the site
    wordpress?: { url: string; user: string; appPassword?: string }; // appPassword may come from env AVC_WP_APP_PASSWORD
  };
  schedule?: { audit?: string; visibility?: string }; // cron expressions
}

export const DEFAULTS: AvcConfig = {
  dataDir: process.env.AVC_DATA_DIR || join(homedir(), '.avc'),
  sites: [],
  ai: { maxRunUsd: 3, maxMonthUsd: 30 },
  server: { port: 4317, host: '127.0.0.1' },
};

export function userConfigPath(dataDir = DEFAULTS.dataDir): string {
  return join(dataDir, 'config.json');
}

function readJson(path: string): Partial<AvcConfig> {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<AvcConfig>) : {};
  } catch {
    return {};
  }
}

function envOverrides(): Partial<AvcConfig> {
  const e = process.env;
  const ai: Partial<AvcConfig['ai']> = {};
  if (e.AI_GATEWAY_API_KEY) ai.gatewayKey = e.AI_GATEWAY_API_KEY;
  if (e.OPENAI_API_KEY) ai.openaiKey = e.OPENAI_API_KEY;
  if (e.OPENAI_BASE_URL) ai.openaiBaseUrl = e.OPENAI_BASE_URL;
  if (e.ANTHROPIC_API_KEY) ai.anthropicKey = e.ANTHROPIC_API_KEY;
  if (e.GOOGLE_GENERATIVE_AI_API_KEY || e.GEMINI_API_KEY)
    ai.googleKey = e.GOOGLE_GENERATIVE_AI_API_KEY || e.GEMINI_API_KEY;
  if (e.PERPLEXITY_API_KEY) ai.perplexityKey = e.PERPLEXITY_API_KEY;
  if (e.XAI_API_KEY) ai.xaiKey = e.XAI_API_KEY;
  if (e.AVC_LLM_MOCK === '1' || e.AVC_LLM_MOCK === 'true') ai.mock = true;
  if (e.AVC_MAX_RUN_USD) ai.maxRunUsd = Number(e.AVC_MAX_RUN_USD);
  if (e.AVC_MAX_MONTH_USD) ai.maxMonthUsd = Number(e.AVC_MAX_MONTH_USD);
  const google: NonNullable<AvcConfig['google']> = {};
  if (e.GOOGLE_CLIENT_ID) google.clientId = e.GOOGLE_CLIENT_ID;
  if (e.GOOGLE_CLIENT_SECRET) google.clientSecret = e.GOOGLE_CLIENT_SECRET;
  if (e.GOOGLE_APPLICATION_CREDENTIALS)
    google.serviceAccountFile = e.GOOGLE_APPLICATION_CREDENTIALS;
  if (e.PSI_API_KEY) google.psiKey = e.PSI_API_KEY;
  const out: Partial<AvcConfig> = { ai: ai as AvcConfig['ai'], google };
  if (e.BING_WEBMASTER_API_KEY) out.bing = { apiKey: e.BING_WEBMASTER_API_KEY };
  if (e.AVC_WEBHOOK_URL || e.AVC_ALERT_EMAIL)
    out.alerts = {
      webhookUrl: e.AVC_WEBHOOK_URL,
      email: e.AVC_ALERT_EMAIL
        ? { to: e.AVC_ALERT_EMAIL, smtpUrl: e.AVC_SMTP_URL, from: e.AVC_SMTP_FROM }
        : undefined,
    };
  if (e.AVC_LANGUAGETOOL_URL)
    out.spelling = {
      server: e.AVC_LANGUAGETOOL_URL,
      ...(e.AVC_LANGUAGETOOL_IGNORE ? { ignore: e.AVC_LANGUAGETOOL_IGNORE.split(',') } : {}),
    };
  if (e.AVC_SAFE_BROWSING_KEY) out.safeBrowsing = { key: e.AVC_SAFE_BROWSING_KEY };
  if (e.AVC_EMBEDDINGS === '1' || e.AVC_EMBEDDINGS === 'true' || e.AVC_EMBED_MODEL)
    out.embeddings = { enabled: true, ...(e.AVC_EMBED_MODEL ? { model: e.AVC_EMBED_MODEL } : {}) };
  if (e.AVC_MOZ_TOKEN || e.AVC_AHREFS_TOKEN || e.AVC_MAJESTIC_KEY)
    out.backlinks = {
      provider: e.AVC_MOZ_TOKEN ? 'moz' : e.AVC_AHREFS_TOKEN ? 'ahrefs' : 'majestic',
      mozToken: e.AVC_MOZ_TOKEN,
      ahrefsToken: e.AVC_AHREFS_TOKEN,
      majesticKey: e.AVC_MAJESTIC_KEY,
    };
  if (e.AVC_PORT)
    out.server = { port: Number(e.AVC_PORT), host: e.AVC_HOST || DEFAULTS.server.host };
  return out;
}

function merge(...parts: Partial<AvcConfig>[]): AvcConfig {
  const out: AvcConfig = structuredClone(DEFAULTS);
  for (const p of parts) {
    if (p.dataDir) out.dataDir = p.dataDir;
    if (p.sites?.length) {
      // Merge by id so sites added from the dashboard (user file) and the project file
      // both show; the later source wins for the same id.
      const byId = new Map(out.sites.map((x) => [x.id, x]));
      for (const site of p.sites) byId.set(site.id, { ...byId.get(site.id), ...site });
      out.sites = [...byId.values()];
    }
    if (p.ai) out.ai = { ...out.ai, ...strip(p.ai) };
    if (p.google) out.google = { ...out.google, ...strip(p.google) };
    if (p.bing) out.bing = { ...out.bing, ...strip(p.bing) };
    if (p.alerts) {
      const email = p.alerts.email
        ? ({ ...out.alerts?.email, ...strip(p.alerts.email) } as NonNullable<
            AvcConfig['alerts']
          >['email'])
        : out.alerts?.email;
      out.alerts = { ...out.alerts, ...strip(p.alerts), ...(email ? { email } : {}) };
    }
    if (p.server) out.server = { ...out.server, ...strip(p.server) };
    if (p.spelling) out.spelling = { ...out.spelling, ...strip(p.spelling) };
    if (p.safeBrowsing) out.safeBrowsing = { ...out.safeBrowsing, ...strip(p.safeBrowsing) };
    if (p.embeddings) out.embeddings = { ...out.embeddings, ...strip(p.embeddings) };
    if (p.backlinks) out.backlinks = { ...out.backlinks, ...strip(p.backlinks) };
    if (p.fixes) out.fixes = { overrides: { ...out.fixes?.overrides, ...p.fixes.overrides } };
    if (p.report) out.report = { ...out.report, ...strip(p.report) };
    if (p.profiles) out.profiles = { ...out.profiles, ...p.profiles };
  }
  return out;
}

function strip<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== ''),
  ) as Partial<T>;
}

let cached: AvcConfig | null = null;
const warned = new Set<string>();

/** One stderr line per process (stdout may be the MCP protocol). */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  process.stderr.write(`[avc] ${message}\n`);
}

/** Secret values found in a config object, keyed by secret id. */
export function secretsIn(obj: Partial<AvcConfig>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of SECRET_FIELDS) {
    const v = getPath(obj, f.path);
    if (typeof v === 'string' && v) out[f.id] = v;
  }
  for (const site of obj.sites ?? []) {
    const v = site.connections?.wordpress?.appPassword;
    if (v) out[wordpressSecretId(site.id)] = v;
  }
  return out;
}

/** A copy of obj with every secret removed. */
export function withoutSecrets<T extends Partial<AvcConfig>>(obj: T): T {
  const copy = structuredClone(obj) as Record<string, unknown>;
  for (const f of SECRET_FIELDS) deletePath(copy, f.path);
  for (const site of (copy.sites as SiteConfig[] | undefined) ?? [])
    if (site.connections?.wordpress) delete site.connections.wordpress.appPassword;
  return copy as T;
}

/** Stored secrets shaped as a partial config, so they merge like any other source. */
function storedSecrets(): Partial<AvcConfig> {
  let values: Record<string, string>;
  try {
    values = secretStore().getAll();
  } catch (e) {
    warnOnce(`Could not read stored keys: ${(e as Error).message}`);
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const f of SECRET_FIELDS) if (values[f.id]) setPath(out, f.path, values[f.id]);
  return out as Partial<AvcConfig>;
}

/** Put each site's WordPress application password back from the store. */
function attachSitePasswords(config: AvcConfig): void {
  let values: Record<string, string> = {};
  try {
    values = secretStore().getAll();
  } catch {
    return;
  }
  for (const site of config.sites) {
    const pw = values[wordpressSecretId(site.id)];
    if (pw && site.connections?.wordpress && !site.connections.wordpress.appPassword)
      site.connections.wordpress.appPassword = pw;
  }
}

function writeUserFile(obj: Partial<AvcConfig>): void {
  const path = userConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch {
    /* windows */
  }
}

/** Move keys an older version saved in ~/.avc/config.json into the secret store. */
function migrateUserFile(user: Partial<AvcConfig>): Partial<AvcConfig> {
  const found = secretsIn(user);
  const ids = Object.keys(found);
  if (!ids.length) return user;
  try {
    const store = secretStore();
    const existing = store.getAll();
    // A key already in the store is newer than one left behind in the file.
    store.setMany(
      Object.fromEntries(ids.filter((id) => !existing[id]).map((id) => [id, found[id]!])),
    );
    const clean = withoutSecrets(user);
    writeUserFile(clean);
    warnOnce(`Moved ${ids.length} key(s) out of ${userConfigPath()} into ${store.where}.`);
    return clean;
  } catch (e) {
    warnOnce(
      `${ids.length} key(s) are still in ${userConfigPath()}: ${(e as Error).message}. Run \`avc keys\` to check.`,
    );
    return user;
  }
}

export function loadConfig(opts: { projectFile?: string; reload?: boolean } = {}): AvcConfig {
  if (cached && !opts.reload) return cached;
  const user = migrateUserFile(readJson(userConfigPath()));
  const projectPath = opts.projectFile ?? join(process.cwd(), 'avc.config.json');
  let project = readJson(projectPath);
  if (Object.keys(secretsIn(project)).length) {
    warnOnce(
      `${projectPath} contains API keys or passwords. They are ignored: project files get committed. Remove them and run \`avc keys setup\` instead.`,
    );
    project = withoutSecrets(project);
  }
  cached = merge(user, storedSecrets(), project, envOverrides());
  attachSitePasswords(cached);
  mkdirSync(cached.dataDir, { recursive: true });
  return cached;
}

/**
 * Save secrets to the secret store. A non-empty string sets a key, an empty string or null
 * removes it, and a missing entry leaves it unchanged.
 */
export function saveSecrets(values: Record<string, string | null>): void {
  secretStore().setMany(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v ?? ''])));
  cached = null;
}

/** Persist to the user file (~/.avc/config.json, mode 600). Secrets go to the secret store. */
export function saveUserConfig(patch: Partial<AvcConfig>): AvcConfig {
  const current = readJson(userConfigPath());
  const next = { ...current, ...patch } as Partial<AvcConfig>;
  const secrets = secretsIn(next);
  if (Object.keys(secrets).length) saveSecrets(secrets);
  writeUserFile(withoutSecrets(next));
  cached = null;
  return loadConfig({ reload: true });
}

export function siteIdFromUrl(url: string): string {
  return new URL(url).host
    .replace(/^www\./, '')
    .replace(/[^a-z0-9.-]/gi, '-')
    .toLowerCase();
}
