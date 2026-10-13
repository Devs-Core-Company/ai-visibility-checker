/**
 * Small shared helpers for the connectors: an injectable fetch type, a typed
 * error with a plain "what to do" hint, Google API error translation, retries
 * and a concurrency-limited map.
 */

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** An error a person can act on: `message` says what failed, `hint` says what to do. */
export class ConnectError extends Error {
  constructor(
    message: string,
    public hint?: string,
    public status?: number,
  ) {
    super(hint ? `${message} ${hint}` : message);
    this.name = 'ConnectError';
  }
}

export interface GoogleApiContext {
  accessToken: string;
  fetch?: FetchFn;
  /** Override the API host (tests, proxies). */
  baseUrl?: string;
  /** Who is calling: service-account email or 'your Google account'. Used in error hints. */
  principal?: string;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { reason?: string; metadata?: Record<string, string> }[];
  };
  error_description?: string;
}

/**
 * Turn a Google API error response into a ConnectError that tells the user
 * exactly what to change. `api` is the product name, e.g. 'Google Search Console API'.
 */
export function googleError(
  api: string,
  status: number,
  bodyText: string,
  opts: { principal?: string; resource?: string; where?: string } = {},
): ConnectError {
  let body: GoogleErrorBody = {};
  try {
    body = JSON.parse(bodyText) as GoogleErrorBody;
  } catch {
    /* not JSON */
  }
  const msg =
    body.error?.message || body.error_description || bodyText.slice(0, 300) || `HTTP ${status}`;
  const reasons = (body.error?.details ?? []).map((d) => d.reason ?? '');
  const meta = (body.error?.details ?? []).find((d) => d.metadata?.activationUrl)?.metadata;
  const who = opts.principal || 'your Google account';

  if (
    reasons.includes('SERVICE_DISABLED') ||
    /has not been used in project|is disabled|API has not been enabled/i.test(msg)
  ) {
    const link = meta?.activationUrl || 'https://console.cloud.google.com/apis/library';
    return new ConnectError(
      `${api} is not enabled in your Google Cloud project.`,
      `Enable it at ${link}, wait a few minutes, then try again.`,
      status,
    );
  }
  if (status === 401) {
    return new ConnectError(
      `${api} rejected the access token (${msg}).`,
      'Run `avc connect google` again to sign in, or check the service-account key file.',
      status,
    );
  }
  if (status === 403) {
    const where =
      opts.where ||
      'Give it access in the product settings (Search Console: Settings → Users and permissions; GA4: Admin → Property access management).';
    return new ConnectError(
      `${who} has no access to ${opts.resource ?? 'this resource'} in ${api} (${msg}).`,
      where,
      status,
    );
  }
  if (status === 404) {
    return new ConnectError(
      `${api}: ${opts.resource ?? 'resource'} was not found (${msg}).`,
      'Check the property id in your site connection settings.',
      status,
    );
  }
  if (status === 429) {
    return new ConnectError(
      `${api} quota exceeded (${msg}).`,
      'Wait a while and try again, or lower the sample size.',
      status,
    );
  }
  return new ConnectError(`${api} returned HTTP ${status}: ${msg}`, undefined, status);
}

/** Fetch JSON from a Google API with a bearer token; retries 429/5xx a couple of times. */
export async function googleJson<T>(
  ctx: GoogleApiContext,
  api: string,
  url: string,
  init: {
    method?: string;
    body?: unknown;
    resource?: string;
    where?: string;
    retries?: number;
  } = {},
): Promise<T> {
  const f = ctx.fetch ?? fetch;
  const retries = init.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(url, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers: {
          authorization: `Bearer ${ctx.accessToken}`,
          accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new ConnectError(
        `Could not reach ${api}: ${(e as Error).message}.`,
        'Check your internet connection or proxy settings.',
      );
    }
    if (res.ok) return (await res.json()) as T;
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(retryDelay(res, attempt));
      continue;
    }
    throw googleError(api, res.status, text, {
      principal: ctx.principal,
      resource: init.resource,
      where: init.where,
    });
  }
}

export function retryDelay(res: Response, attempt: number): number {
  const ra = Number(res.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 60_000);
  return Math.min(1000 * 2 ** attempt, 30_000);
}

/** Map with at most `limit` promises in flight; keeps input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** YYYY-MM-DD in UTC. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}
