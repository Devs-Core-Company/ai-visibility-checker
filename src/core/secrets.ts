/**
 * Secrets (API keys, tokens, passwords) stay on this computer, in the operating system's own
 * credential store when there is one:
 *
 *   macOS    Keychain (the `security` tool)
 *   Linux    Secret Service / GNOME Keyring / KWallet (the `secret-tool` tool)
 *   Windows  a file encrypted with DPAPI for the current user (PowerShell)
 *   other    ~/.avc/secrets.json, readable only by you (mode 600)
 *
 * Every key is kept together as one JSON item, so a run reads the store once. A secret value
 * is never passed on a command line (other users can read process arguments); it goes to the
 * helper tool on stdin. Environment variables always win over stored values, so CI and Docker
 * keep working unchanged.
 *
 * Set AVC_SECRET_STORE=file to use the file even where a keychain exists (Docker, CI, tests),
 * or AVC_SECRET_STORE=keychain to fail loudly when the keychain cannot be used.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SERVICE = 'ai-visibility-checker';
const ACCOUNT = 'secrets';

export type SecretBackendId = 'keychain' | 'secret-service' | 'dpapi' | 'file';

/**
 * Where a secret's current value comes from. `claude-desktop`: the Claude Desktop extension's
 * settings, which Claude passes in as environment variables (see manifest.json).
 */
export type SecretSource = 'env' | 'claude-desktop' | 'store' | 'none';

/** Set by the Claude Desktop extension manifest, so keys from its settings can be labelled. */
export const fromClaudeDesktop = (): boolean => process.env.AVC_KEY_SOURCE === 'claude-desktop';

/**
 * A host that fills env vars from a template (the Claude Desktop extension manifest) can pass
 * an optional field it has no value for as the literal "${user_config.x}" or as "". Treat both
 * as unset, so they never count as a key.
 */
export function dropUnfilledPlaceholders(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && /^\$\{user_config\.[^}]*\}$/.test(value)) delete env[name];
}

export type SecretGroup = 'ai' | 'data' | 'alerts';

export interface SecretField {
  /** Stable id used by `avc keys set <id>`. */
  id: string;
  /** Location in AvcConfig, e.g. ['ai', 'openaiKey']. */
  path: string[];
  /** Environment variables that set it (first wins). */
  env: string[];
  label: string;
  group: SecretGroup;
  /** What stops working without it, in plain words. */
  unlocks: string;
  /** Where to get one. */
  getAt?: string;
}

export const SECRET_FIELDS: SecretField[] = [
  {
    id: 'gateway',
    path: ['ai', 'gatewayKey'],
    env: ['AI_GATEWAY_API_KEY'],
    label: 'Vercel AI Gateway',
    group: 'ai',
    unlocks: 'One key for every AI engine (ChatGPT, Claude, Gemini, Perplexity, Grok, DeepSeek).',
    getAt: 'https://vercel.com/ai-gateway',
  },
  {
    id: 'openai',
    path: ['ai', 'openaiKey'],
    env: ['OPENAI_API_KEY'],
    label: 'OpenAI',
    group: 'ai',
    unlocks: 'ChatGPT answers, answer grading, prompt writing and embeddings.',
    getAt: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    path: ['ai', 'anthropicKey'],
    env: ['ANTHROPIC_API_KEY'],
    label: 'Anthropic',
    group: 'ai',
    unlocks: 'Claude answers.',
    getAt: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'google-ai',
    path: ['ai', 'googleKey'],
    env: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
    label: 'Google Gemini',
    group: 'ai',
    unlocks: 'Gemini answers.',
    getAt: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'perplexity',
    path: ['ai', 'perplexityKey'],
    env: ['PERPLEXITY_API_KEY'],
    label: 'Perplexity',
    group: 'ai',
    unlocks: 'Perplexity answers.',
    getAt: 'https://www.perplexity.ai/settings/api',
  },
  {
    id: 'xai',
    path: ['ai', 'xaiKey'],
    env: ['XAI_API_KEY'],
    label: 'xAI',
    group: 'ai',
    unlocks: 'Grok answers.',
    getAt: 'https://console.x.ai',
  },
  {
    id: 'psi',
    path: ['google', 'psiKey'],
    env: ['PSI_API_KEY'],
    label: 'PageSpeed Insights',
    group: 'data',
    unlocks: 'Core Web Vitals checks at full rate (they run slowly without a key).',
    getAt: 'https://developers.google.com/speed/docs/insights/v5/get-started',
  },
  {
    id: 'google-oauth-secret',
    path: ['google', 'clientSecret'],
    env: ['GOOGLE_CLIENT_SECRET'],
    label: 'Google OAuth client secret',
    group: 'data',
    unlocks: 'Search Console and GA4 checks.',
  },
  {
    id: 'bing',
    path: ['bing', 'apiKey'],
    env: ['BING_WEBMASTER_API_KEY'],
    label: 'Bing Webmaster Tools',
    group: 'data',
    unlocks: 'Bing index data (Bing grounds ChatGPT search and Copilot).',
    getAt: 'https://www.bing.com/webmasters',
  },
  {
    id: 'safe-browsing',
    path: ['safeBrowsing', 'key'],
    env: ['AVC_SAFE_BROWSING_KEY'],
    label: 'Google Safe Browsing',
    group: 'data',
    unlocks: 'Malware and phishing checks on outbound links.',
  },
  {
    id: 'moz',
    path: ['backlinks', 'mozToken'],
    env: ['AVC_MOZ_TOKEN'],
    label: 'Moz',
    group: 'data',
    unlocks: 'Backlink metrics.',
  },
  {
    id: 'ahrefs',
    path: ['backlinks', 'ahrefsToken'],
    env: ['AVC_AHREFS_TOKEN'],
    label: 'Ahrefs',
    group: 'data',
    unlocks: 'Backlink metrics.',
  },
  {
    id: 'majestic',
    path: ['backlinks', 'majesticKey'],
    env: ['AVC_MAJESTIC_KEY'],
    label: 'Majestic',
    group: 'data',
    unlocks: 'Backlink metrics.',
  },
  {
    id: 'smtp',
    path: ['alerts', 'email', 'smtpUrl'],
    env: ['AVC_SMTP_URL'],
    label: 'SMTP URL (with password)',
    group: 'alerts',
    unlocks: 'Email alerts.',
  },
];

/** Per-site WordPress application passwords are stored as `wordpress:<siteId>`. */
export const wordpressSecretId = (siteId: string): string => `wordpress:${siteId}`;

export function secretField(id: string): SecretField | undefined {
  return SECRET_FIELDS.find((f) => f.id === id);
}

export function envValue(field: SecretField): string | undefined {
  for (const name of field.env) if (process.env[name]) return process.env[name];
  return undefined;
}

// ---------------------------------------------------------------------------
// Path helpers (config objects are plain JSON)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

export function getPath(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Obj)[key];
  }
  return cur;
}

export function setPath(obj: Obj, path: string[], value: unknown): void {
  let cur = obj;
  for (const key of path.slice(0, -1)) {
    if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
    cur = cur[key] as Obj;
  }
  cur[path[path.length - 1]!] = value;
}

/** Delete a value and any objects left empty above it. */
export function deletePath(obj: Obj, path: string[]): void {
  const parents: Obj[] = [];
  let cur = obj;
  for (const key of path.slice(0, -1)) {
    if (!cur[key] || typeof cur[key] !== 'object') return;
    parents.push(cur);
    cur = cur[key] as Obj;
  }
  delete cur[path[path.length - 1]!];
  for (let i = path.length - 2; i >= 0; i--) {
    const parent = parents[i]!;
    const child = parent[path[i]!] as Obj;
    if (Object.keys(child).length) break;
    delete parent[path[i]!];
  }
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

interface Backend {
  id: SecretBackendId;
  /** Shown to the user: where the keys are. */
  describe(): string;
  read(): Record<string, string>;
  write(values: Record<string, string>): void;
}

const dataDir = (): string => process.env.AVC_DATA_DIR || join(homedir(), '.avc');

function run(cmd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv) {
  const r = spawnSync(cmd, args, {
    input,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', r };
}

function parseBlob(text: string): Record<string, string> {
  const raw = text.trim();
  if (!raw) return {};
  // Stored as base64 so the value never needs quoting for the helper tools.
  const json = /^[A-Za-z0-9+/=]+$/.test(raw) ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== 'object') return {};
  return Object.fromEntries(
    Object.entries(parsed as Obj).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
}

const toBlob = (values: Record<string, string>): string =>
  Buffer.from(JSON.stringify(values), 'utf8').toString('base64');

export const fileBackend = (dir = dataDir()): Backend => {
  const path = join(dir, 'secrets.json');
  return {
    id: 'file',
    describe: () => `${path} (readable only by you)`,
    read() {
      if (!existsSync(path)) return {};
      return parseBlob(readFileSync(path, 'utf8'));
    },
    write(values) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!Object.keys(values).length) {
        rmSync(path, { force: true });
        return;
      }
      writeFileSync(path, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {
        /* windows: the user profile folder is already private */
      }
    },
  };
};

const macKeychain: Backend = {
  id: 'keychain',
  describe: () => 'macOS Keychain (item "ai-visibility-checker")',
  read() {
    const r = run('/usr/bin/security', [
      'find-generic-password',
      '-s',
      SERVICE,
      '-a',
      ACCOUNT,
      '-w',
    ]);
    if (r.ok) return parseBlob(r.stdout);
    // 44 = errSecItemNotFound: nothing stored yet.
    if (r.r.status === 44) return {};
    throw new Error(`Could not read the macOS Keychain: ${r.stderr.trim() || 'unknown error'}`);
  },
  write(values) {
    if (!Object.keys(values).length) {
      run('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
      return;
    }
    // `security -i` reads the command from stdin, so the value is not in any process's argv.
    const r = run(
      '/usr/bin/security',
      ['-i'],
      `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "AI Visibility Checker keys" -w ${toBlob(values)}\n`,
    );
    if (!r.ok || /error/i.test(r.stderr))
      throw new Error(
        `Could not save to the macOS Keychain: ${r.stderr.trim() || 'unknown error'}`,
      );
  },
};

const secretService: Backend = {
  id: 'secret-service',
  describe: () => 'your system keyring (Secret Service)',
  read() {
    const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
    if (r.ok) return parseBlob(r.stdout);
    // secret-tool exits 1 with no output when nothing is stored.
    if (r.r.status === 1 && !r.stderr.trim()) return {};
    throw new Error(`Could not read the system keyring: ${r.stderr.trim() || 'unknown error'}`);
  },
  write(values) {
    if (!Object.keys(values).length) {
      run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]);
      return;
    }
    const r = run(
      'secret-tool',
      ['store', '--label=AI Visibility Checker keys', 'service', SERVICE, 'account', ACCOUNT],
      toBlob(values),
    );
    if (!r.ok) throw new Error(`Could not save to the system keyring: ${r.stderr.trim()}`);
  },
};

const windowsDpapi = (dir = dataDir()): Backend => {
  const path = join(dir, 'secrets.dpapi');
  const ps = (script: string, input?: string) =>
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], input, {
      AVC_SECRET_PATH: path,
    });
  const prelude = 'Add-Type -AssemblyName System.Security;';
  return {
    id: 'dpapi',
    describe: () => `${path} (encrypted for your Windows account)`,
    read() {
      if (!existsSync(path)) return {};
      const r = ps(
        `${prelude}$e=[IO.File]::ReadAllBytes($env:AVC_SECRET_PATH);` +
          `$b=[Security.Cryptography.ProtectedData]::Unprotect($e,$null,'CurrentUser');` +
          `[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))`,
      );
      if (!r.ok) throw new Error(`Could not decrypt ${path}: ${r.stderr.trim()}`);
      return parseBlob(r.stdout);
    },
    write(values) {
      mkdirSync(dir, { recursive: true });
      if (!Object.keys(values).length) {
        rmSync(path, { force: true });
        return;
      }
      const r = ps(
        `${prelude}$s=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($s);` +
          `$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');` +
          `[IO.File]::WriteAllBytes($env:AVC_SECRET_PATH,$e)`,
        toBlob(values),
      );
      if (!r.ok) throw new Error(`Could not encrypt ${path}: ${r.stderr.trim()}`);
    },
  };
};

function platformBackend(): Backend | null {
  if (process.platform === 'darwin' && existsSync('/usr/bin/security')) return macKeychain;
  if (process.platform === 'win32') return windowsDpapi();
  if (process.platform === 'linux' && process.env.DBUS_SESSION_BUS_ADDRESS) {
    const probe = run('secret-tool', ['--version']);
    if (probe.ok || probe.r.status === 0) return secretService;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface SecretStore {
  backend: SecretBackendId;
  where: string;
  /** Set when the OS store failed and the file is used instead. */
  fallbackReason?: string;
  getAll(): Record<string, string>;
  get(id: string): string | undefined;
  /** Save several values at once; an empty string removes that key. */
  setMany(values: Record<string, string>): void;
}

let cached: { key: string; store: SecretStore } | null = null;

function makeStore(primary: Backend, fallback: Backend | null, required: boolean): SecretStore {
  let backend = primary;
  let fallbackReason: string | undefined;
  let values: Record<string, string> | null = null;

  const load = (): Record<string, string> => {
    if (values) return values;
    try {
      values = backend.read();
    } catch (e) {
      if (required || !fallback) throw e;
      fallbackReason = (e as Error).message;
      backend = fallback;
      values = backend.read();
    }
    return values;
  };

  const store: SecretStore = {
    get backend() {
      load();
      return backend.id;
    },
    get where() {
      load();
      return backend.describe();
    },
    get fallbackReason() {
      return fallbackReason;
    },
    getAll: () => ({ ...load() }),
    get: (id) => load()[id] || undefined,
    setMany(patch) {
      const next = { ...load() };
      for (const [id, v] of Object.entries(patch)) {
        if (v) next[id] = v;
        else delete next[id];
      }
      try {
        backend.write(next);
      } catch (e) {
        if (required || !fallback || backend === fallback) throw e;
        fallbackReason = (e as Error).message;
        backend = fallback;
        backend.write(next);
      }
      values = next;
    },
  };
  return store;
}

/** The secret store for this machine (cached per data dir and AVC_SECRET_STORE). */
export function secretStore(): SecretStore {
  const mode = (process.env.AVC_SECRET_STORE || 'auto').toLowerCase();
  const key = `${mode}|${dataDir()}`;
  if (cached?.key === key) return cached.store;
  const file = fileBackend();
  const os = mode === 'file' ? null : platformBackend();
  let store: SecretStore;
  if (mode === 'keychain') {
    if (!os) throw new Error('AVC_SECRET_STORE=keychain, but no OS keychain is available here.');
    store = makeStore(os, null, true);
  } else {
    store = os ? makeStore(os, file, false) : makeStore(file, null, false);
  }
  cached = { key, store };
  return store;
}

/** Forget the cached store (tests, or after the environment changes). */
export function resetSecretStore(): void {
  cached = null;
}

/** Where a field's value comes from right now, without revealing it. */
export function secretSource(field: SecretField): SecretSource {
  if (envValue(field)) return fromClaudeDesktop() ? 'claude-desktop' : 'env';
  try {
    if (secretStore().get(field.id)) return 'store';
  } catch {
    /* unreadable store counts as not set */
  }
  return 'none';
}

/** A safe display of a secret: whether it is set, never any of its characters. */
export function maskSecret(value: string | undefined): string {
  return value ? 'set' : 'not set';
}
