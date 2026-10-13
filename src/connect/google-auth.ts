/**
 * Google sign-in for Search Console, GA4 and the Indexing API, without googleapis.
 *
 * Two ways in:
 *  (a) a service-account JSON key file (config.google.serviceAccountFile): we sign
 *      a JWT with RS256 (node:crypto) and swap it for an access token;
 *  (b) an OAuth "Desktop app" client (config.google.clientId/clientSecret): the user
 *      signs in once through `googleLogin` (loopback redirect on 127.0.0.1 + PKCE),
 *      and the refresh token is stored at <dataDir>/tokens/google.json (mode 600).
 */
import { createHash, createSign, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { AvcConfig } from '../core/config.js';
import { ConnectError, type FetchFn } from './google-api.js';

export const GOOGLE_SCOPES = {
  searchConsole: 'https://www.googleapis.com/auth/webmasters.readonly',
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
  indexing: 'https://www.googleapis.com/auth/indexing',
} as const;

/** What `avc connect google` asks for by default. */
export const DEFAULT_GOOGLE_SCOPES = [GOOGLE_SCOPES.searchConsole, GOOGLE_SCOPES.analytics];

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface GoogleAuthOptions {
  fetch?: FetchFn;
  tokenUrl?: string;
  authUrl?: string;
  now?: () => number;
}

export interface GoogleLoginOptions extends GoogleAuthOptions {
  /** Called with the consent URL. Default: print it and try to open the system browser. */
  openBrowser?: (url: string) => void | Promise<void>;
  /** Where to print messages. Default console.log. */
  log?: (msg: string) => void;
  /** How long to wait for the browser redirect. Default 5 minutes. */
  timeoutMs?: number;
}

export interface StoredGoogleToken {
  refresh_token: string;
  scope: string;
  client_id: string;
  obtained_at: string;
  email?: string;
}

interface ServiceAccountKey {
  type?: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

const memo = new Map<string, { token: string; expires: number }>();

/** Forget cached access tokens (tests, after logout). */
export function clearGoogleTokenCache(): void {
  memo.clear();
}

export function googleTokenPath(config: Pick<AvcConfig, 'dataDir'>): string {
  return join(config.dataDir, 'tokens', 'google.json');
}

export function readStoredGoogleToken(config: Pick<AvcConfig, 'dataDir'>): StoredGoogleToken | null {
  const p = googleTokenPath(config);
  if (!existsSync(p)) return null;
  try {
    const t = JSON.parse(readFileSync(p, 'utf8')) as StoredGoogleToken;
    return t.refresh_token ? t : null;
  } catch {
    return null;
  }
}

function saveStoredGoogleToken(config: Pick<AvcConfig, 'dataDir'>, t: StoredGoogleToken): void {
  const dir = join(config.dataDir, 'tokens');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = googleTokenPath(config);
  writeFileSync(p, JSON.stringify(t, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* windows */
  }
}

/** Remove the stored refresh token (it is not revoked at Google; do that at myaccount.google.com/permissions). */
export function googleLogout(config: Pick<AvcConfig, 'dataDir'>): boolean {
  const p = googleTokenPath(config);
  memo.clear();
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

/** Which Google auth method is available, without network calls. */
export function googleAuthMethod(
  config: AvcConfig,
): 'service-account' | 'oauth' | 'oauth-not-signed-in' | 'none' {
  if (config.google?.serviceAccountFile) return 'service-account';
  if (readStoredGoogleToken(config)) return 'oauth';
  if (config.google?.clientId) return 'oauth-not-signed-in';
  return 'none';
}

/** The identity that needs access in GSC/GA4: the service-account email, or the signed-in user. */
export function googlePrincipal(config: AvcConfig): string {
  const sa = config.google?.serviceAccountFile;
  if (sa) {
    try {
      return `Service account ${loadServiceAccount(sa).client_email}`;
    } catch {
      return 'The service account';
    }
  }
  const t = readStoredGoogleToken(config);
  return t?.email ? `Google account ${t.email}` : 'Your Google account';
}

/**
 * Get a short-lived access token for `scopes`. Uses the service account when one
 * is configured, otherwise the stored OAuth refresh token. Throws a ConnectError
 * that says what to do when neither is set up.
 */
export async function getGoogleAccessToken(
  config: AvcConfig,
  scopes: string[] = DEFAULT_GOOGLE_SCOPES,
  opts: GoogleAuthOptions = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  const sa = config.google?.serviceAccountFile;
  const stored = sa ? null : readStoredGoogleToken(config);
  const key = `${sa ?? stored?.refresh_token ?? ''}|${[...scopes].sort().join(' ')}`;
  const hit = memo.get(key);
  if (hit && hit.expires > now() + 60_000) return hit.token;

  let res: { token: string; expiresIn: number };
  if (sa) {
    res = await serviceAccountToken(sa, scopes, opts);
  } else if (stored) {
    res = await refreshToken(config, stored, scopes, opts);
  } else if (config.google?.clientId) {
    throw new ConnectError(
      'Not signed in to Google yet.',
      'Run `avc connect google` to sign in once in your browser.',
    );
  } else {
    throw new ConnectError(
      'Google is not connected.',
      'Either set google.serviceAccountFile (or GOOGLE_APPLICATION_CREDENTIALS) to a service-account key, or create an OAuth "Desktop app" client, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, and run `avc connect google`. See docs/CONNECTIONS.md.',
    );
  }
  memo.set(key, { token: res.token, expires: now() + res.expiresIn * 1000 });
  return res.token;
}

// ---------------------------------------------------------------------------
// Service account (JWT bearer, RFC 7523)
// ---------------------------------------------------------------------------

function loadServiceAccount(path: string): ServiceAccountKey {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConnectError(
      `Could not read the service-account key file ${path} (${(e as Error).message}).`,
      'Check google.serviceAccountFile / GOOGLE_APPLICATION_CREDENTIALS points to the downloaded JSON key.',
    );
  }
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(raw) as ServiceAccountKey;
  } catch {
    throw new ConnectError(`${path} is not valid JSON.`, 'Download a new JSON key for the service account.');
  }
  if (!key.client_email || !key.private_key) {
    throw new ConnectError(
      `${path} is not a service-account key (no client_email / private_key).`,
      'In Google Cloud → IAM & Admin → Service accounts → Keys, create a JSON key and use that file.',
    );
  }
  return key;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Build and sign the JWT assertion. Exported for tests. */
export function signServiceAccountJwt(
  key: Pick<ServiceAccountKey, 'client_email' | 'private_key' | 'private_key_id'>,
  scopes: string[],
  aud: string,
  nowSec: number,
): string {
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (key.private_key_id) header.kid = key.private_key_id;
  const claims = {
    iss: key.client_email,
    scope: scopes.join(' '),
    aud,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  return `${input}.${signer.sign(key.private_key).toString('base64url')}`;
}

async function serviceAccountToken(
  path: string,
  scopes: string[],
  opts: GoogleAuthOptions,
): Promise<{ token: string; expiresIn: number }> {
  const key = loadServiceAccount(path);
  const tokenUrl = opts.tokenUrl ?? key.token_uri ?? GOOGLE_TOKEN_URL;
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  let assertion: string;
  try {
    assertion = signServiceAccountJwt(key, scopes, tokenUrl, nowSec);
  } catch (e) {
    throw new ConnectError(
      `Could not sign with the service-account private key (${(e as Error).message}).`,
      'The key file may be damaged; create a new JSON key.',
    );
  }
  const body = await postToken(
    tokenUrl,
    { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion },
    opts,
  );
  if (!body.access_token) {
    throw new ConnectError(
      `Google refused the service-account sign-in: ${body.error_description || body.error || 'no token'}.`,
      'Check the key has not been deleted or disabled in Google Cloud → IAM & Admin → Service accounts.',
    );
  }
  return { token: body.access_token, expiresIn: body.expires_in ?? 3600 };
}

// ---------------------------------------------------------------------------
// OAuth installed app: refresh + loopback/PKCE login
// ---------------------------------------------------------------------------

async function refreshToken(
  config: AvcConfig,
  stored: StoredGoogleToken,
  scopes: string[],
  opts: GoogleAuthOptions,
): Promise<{ token: string; expiresIn: number }> {
  const clientId = config.google?.clientId ?? stored.client_id;
  const clientSecret = config.google?.clientSecret;
  if (!clientId) {
    throw new ConnectError(
      'A Google sign-in is stored but no OAuth client id is configured.',
      'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (the Desktop app client you signed in with).',
    );
  }
  const granted = new Set((stored.scope || '').split(/\s+/).filter(Boolean));
  const missing = scopes.filter((s) => !granted.has(s));
  if (granted.size && missing.length) {
    throw new ConnectError(
      `Your Google sign-in does not include ${missing.map(scopeLabel).join(', ')}.`,
      'Run `avc connect google` again and tick every permission on the consent screen.',
    );
  }
  const params: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
    client_id: clientId,
  };
  if (clientSecret) params.client_secret = clientSecret;
  const body = await postToken(opts.tokenUrl ?? GOOGLE_TOKEN_URL, params, opts);
  if (!body.access_token) {
    const revoked = body.error === 'invalid_grant';
    throw new ConnectError(
      revoked
        ? 'Your Google sign-in has expired or was revoked.'
        : `Google refused the token refresh: ${body.error_description || body.error || 'no token'}.`,
      revoked
        ? 'Run `avc connect google` to sign in again. (Apps left in "Testing" status in the OAuth consent screen expire sign-ins after 7 days; publish the app to avoid this.)'
        : 'Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET match the client you signed in with.',
    );
  }
  return { token: body.access_token, expiresIn: body.expires_in ?? 3600 };
}

function scopeLabel(s: string): string {
  if (s === GOOGLE_SCOPES.searchConsole) return 'Search Console (read)';
  if (s === GOOGLE_SCOPES.analytics) return 'Google Analytics (read)';
  if (s === GOOGLE_SCOPES.indexing) return 'Indexing API';
  return s;
}

async function postToken(
  url: string,
  params: Record<string, string>,
  opts: GoogleAuthOptions,
): Promise<TokenResponse> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    throw new ConnectError(
      `Could not reach Google's sign-in server (${(e as Error).message}).`,
      'Check your internet connection or proxy settings.',
    );
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    return { error: `HTTP ${res.status}`, error_description: text.slice(0, 200) };
  }
}

/** PKCE verifier + S256 challenge (RFC 7636). */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Sign in with a Google account in the browser and store the refresh token.
 * Starts a one-shot server on 127.0.0.1 (random port), opens the consent page,
 * waits for the redirect, swaps the code (with the PKCE verifier) for tokens.
 * Returns an access token for `scopes`.
 */
export async function googleLogin(
  config: AvcConfig,
  scopes: string[] = DEFAULT_GOOGLE_SCOPES,
  opts: GoogleLoginOptions = {},
): Promise<string> {
  const clientId = config.google?.clientId;
  const clientSecret = config.google?.clientSecret;
  if (!clientId) {
    throw new ConnectError(
      'No Google OAuth client is configured.',
      'In Google Cloud → APIs & Services → Credentials, create an OAuth client id of type "Desktop app", then set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (or google.clientId / google.clientSecret in ~/.avc/config.json). See docs/CONNECTIONS.md.',
    );
  }
  const log = opts.log ?? ((m: string) => console.log(m));
  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString('hex');
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  let resolveCode!: (code: string) => void;
  let rejectCode!: (e: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const err = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    const page = (title: string, text: string) =>
      `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;padding:3em;max-width:40em"><h1>${title}</h1><p>${text}</p></body>`;
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Sign-in not completed', 'The response did not match this sign-in attempt. Run the command again.'));
      return;
    }
    if (err || !code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Sign-in not completed', `Google returned: ${err ?? 'no code'}. You can close this tab.`));
      rejectCode(
        new ConnectError(
          `Google sign-in was not completed (${err ?? 'no code returned'}).`,
          err === 'access_denied'
            ? 'Run `avc connect google` again and allow access. If your app is in "Testing", add your Google account as a test user on the OAuth consent screen.'
            : 'Run `avc connect google` again.',
        ),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page('Connected', 'AI Visibility Checker is now connected to Google. You can close this tab.'));
    resolveCode(code);
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const auth = new URL(opts.authUrl ?? GOOGLE_AUTH_URL);
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ['openid', 'email', ...scopes].join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  }).toString();

  const timer = setTimeout(
    () =>
      rejectCode(
        new ConnectError('Timed out waiting for the Google sign-in.', 'Run `avc connect google` again.'),
      ),
    timeoutMs,
  );
  try {
    log(`Open this link to connect Google (it should open by itself):\n\n  ${auth.toString()}\n`);
    await (opts.openBrowser ?? openInBrowser)(auth.toString());
    const code = await codePromise;
    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    };
    if (clientSecret) params.client_secret = clientSecret;
    const body = await postToken(opts.tokenUrl ?? GOOGLE_TOKEN_URL, params, opts);
    if (!body.access_token || !body.refresh_token) {
      throw new ConnectError(
        `Google did not return a refresh token (${body.error_description || body.error || 'missing refresh_token'}).`,
        body.error === 'invalid_client'
          ? 'Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, and that the client type is "Desktop app".'
          : 'Remove the app at myaccount.google.com/permissions and run `avc connect google` again.',
      );
    }
    const stored: StoredGoogleToken = {
      refresh_token: body.refresh_token,
      scope: body.scope ?? scopes.join(' '),
      client_id: clientId,
      obtained_at: new Date((opts.now ?? Date.now)()).toISOString(),
    };
    const email = emailFromIdToken(body.id_token);
    if (email) stored.email = email;
    saveStoredGoogleToken(config, stored);
    memo.clear();
    memo.set(`${stored.refresh_token}|${[...scopes].sort().join(' ')}`, {
      token: body.access_token,
      expires: (opts.now ?? Date.now)() + (body.expires_in ?? 3600) * 1000,
    });
    return body.access_token;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')) as {
      email?: string;
    };
    return payload.email;
  } catch {
    return undefined;
  }
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* no browser: the printed link is enough */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

/** Convenience namespace, as named in docs/ARCHITECTURE.md. */
export const googleAuth = {
  getAccessToken: getGoogleAccessToken,
  login: googleLogin,
  logout: googleLogout,
  method: googleAuthMethod,
  principal: googlePrincipal,
  scopes: GOOGLE_SCOPES,
};
