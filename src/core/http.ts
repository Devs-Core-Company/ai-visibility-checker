/**
 * The one HTTP client the app uses for crawling. Built on Node's fetch.
 *
 * - Redirects are followed by hand so every hop is recorded (status + URL).
 * - TTFB is the time until response headers arrive for the final hop.
 * - Bodies are capped at `maxBytes`; anything longer is cut and `truncated` set.
 * - Text is decoded with the charset from the Content-Type header, a BOM, or a
 *   <meta charset> in the first bytes, in that order; UTF-8 otherwise.
 * - Header names are lower-cased. Repeated headers are joined with ", ".
 * - It never throws: network errors come back as status 0 with `error` set.
 *
 * Proxies: Node's fetch does not read HTTPS_PROXY by itself. On Node 22.21+ and
 * 24+, start the app with NODE_USE_ENV_PROXY=1 (plus HTTPS_PROXY / HTTP_PROXY /
 * NO_PROXY) and Node routes these requests through the proxy. No extra
 * dependency is needed.
 */
import type { FetchResult, Fetcher, RedirectHop } from './types.js';
import { bareHost } from './url.js';

export interface FetcherOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  headers?: Record<string, string>;
  /** Basic auth or a Cookie header, for password-protected staging sites. */
  auth?: { user: string; pass: string } | { cookie: string };
  /**
   * Only send `auth` to this host (and its www/apex twin). Strongly
   * recommended, so credentials never leak to third-party hosts.
   */
  authHost?: string;
  /** Minimum gap between requests to the same host, across all callers. Default 0. */
  perHostDelayMs?: number;
  /** Default 10. */
  maxRedirects?: number;
}

const rawBodies = new WeakMap<FetchResult, Buffer>();

/**
 * The undecoded body bytes of a result from this fetcher (for gzip files,
 * images, PDFs). Undefined for results from another Fetcher.
 */
export function rawBody(result: FetchResult): Buffer | undefined {
  return rawBodies.get(result);
}

const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

type FetchOpts = NonNullable<Parameters<Fetcher['fetch']>[1]>;

export function createFetcher(
  options: FetcherOptions,
): Fetcher & { readonly options: FetcherOptions } {
  const maxRedirects = options.maxRedirects ?? 10;
  const nextSlot = new Map<string, number>();

  async function politeWait(host: string): Promise<void> {
    const gap = options.perHostDelayMs ?? 0;
    if (gap <= 0) return;
    const now = Date.now();
    const slot = Math.max(now, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + gap);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }

  function authHeaders(url: URL): Record<string, string> {
    const auth = options.auth;
    if (!auth) return {};
    if (options.authHost && bareHost(url.hostname) !== bareHost(options.authHost)) return {};
    if ('cookie' in auth) return { cookie: auth.cookie };
    const token = Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
    return { authorization: `Basic ${token}` };
  }

  async function doFetch(url: string, opts: FetchOpts = {}): Promise<FetchResult> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? options.timeoutMs;
    const maxBytes = opts.maxBytes ?? options.maxBytes;
    const follow = opts.followRedirects ?? true;
    let method = opts.method ?? 'GET';
    let body = opts.body;
    const redirects: RedirectHop[] = [];
    const deadline = started + timeoutMs;

    const fail = (current: string, error: string, status = 0): FetchResult => ({
      url,
      finalUrl: current,
      status,
      ok: false,
      headers: {},
      redirects,
      body: '',
      bytes: 0,
      truncated: false,
      contentType: '',
      ttfbMs: 0,
      totalMs: Date.now() - started,
      error,
    });

    let current: URL;
    try {
      current = new URL(url);
    } catch {
      return fail(url, 'Invalid URL');
    }
    if (current.protocol !== 'http:' && current.protocol !== 'https:')
      return fail(url, `Unsupported protocol ${current.protocol}`);

    for (let hop = 0; ; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return fail(current.toString(), `Timed out after ${timeoutMs} ms`);
      await politeWait(current.host);

      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('timeout')),
        Math.max(1, deadline - Date.now()),
      );
      const hopStart = Date.now();
      let res: Response;
      try {
        res = await fetch(current, {
          method,
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: DEFAULT_ACCEPT,
            'accept-language': 'en-GB,en;q=0.9',
            // Stated explicitly (fetch decodes the body either way) so compression checks can
            // rely on what was offered.
            'accept-encoding': 'gzip, deflate, br',
            ...options.headers,
            ...authHeaders(current),
            ...opts.headers,
            'user-agent': opts.userAgent ?? options.userAgent,
          },
        });
      } catch (e) {
        clearTimeout(timer);
        return fail(current.toString(), describeError(e, timeoutMs, controller.signal.aborted));
      }
      const ttfbMs = Date.now() - hopStart;
      const headers = lowerHeaders(res.headers);
      const location = headers.location;

      if (res.status >= 300 && res.status < 400 && location && follow) {
        await res.body?.cancel().catch(() => {});
        clearTimeout(timer);
        redirects.push({ url: current.toString(), status: res.status });
        if (hop >= maxRedirects)
          return {
            ...fail(
              current.toString(),
              `Too many redirects (more than ${maxRedirects})`,
              res.status,
            ),
            headers,
          };
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return {
            ...fail(current.toString(), `Invalid redirect target: ${location}`, res.status),
            headers,
          };
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:')
          return {
            ...fail(current.toString(), `Redirect to unsupported URL: ${location}`, res.status),
            headers,
          };
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
        }
        if (
          redirects.some((h) => h.url === next.toString()) ||
          next.toString() === current.toString()
        ) {
          redirects.push({ url: next.toString(), status: 0 });
          return { ...fail(next.toString(), 'Redirect loop', res.status), headers };
        }
        current = next;
        continue;
      }

      // Final response: read the body up to the cap.
      let buf: Buffer = Buffer.alloc(0);
      let bytes = 0;
      let truncated = false;
      let readError: string | undefined;
      if (method !== 'HEAD' && res.body) {
        const chunks: Uint8Array[] = [];
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const room = maxBytes - bytes;
            if (value.byteLength > room) {
              if (room > 0) chunks.push(value.subarray(0, room));
              bytes += Math.max(0, room);
              truncated = true;
              await reader.cancel().catch(() => {});
              break;
            }
            chunks.push(value);
            bytes += value.byteLength;
          }
        } catch (e) {
          truncated = bytes > 0;
          readError = describeError(e, timeoutMs, controller.signal.aborted);
        }
        buf = Buffer.concat(chunks);
      }
      clearTimeout(timer);

      const contentType = headers['content-type'] ?? '';
      const text = buf.length ? decodeBody(buf, contentType) : '';
      const result: FetchResult = {
        url,
        finalUrl: current.toString(),
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        headers,
        redirects,
        body: text,
        bytes: bytes || Number(headers['content-length']) || 0,
        truncated,
        contentType,
        ttfbMs,
        totalMs: Date.now() - started,
      };
      // A read that failed with nothing read is a failed fetch; a partial one is kept.
      if (readError) result.error = readError;
      if (method === 'HEAD') result.bytes = Number(headers['content-length']) || 0;
      if (buf.length) rawBodies.set(result, buf);
      return result;
    }
  }

  return {
    options,
    fetch: async (url, opts) => {
      try {
        return await doFetch(url, opts);
      } catch (e) {
        // Belt and braces: the contract says never throw.
        return {
          url,
          finalUrl: url,
          status: 0,
          ok: false,
          headers: {},
          redirects: [],
          body: '',
          bytes: 0,
          truncated: false,
          contentType: '',
          ttfbMs: 0,
          totalMs: 0,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  };
}

function lowerHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    const k = key.toLowerCase();
    out[k] = out[k] && k !== 'set-cookie' ? `${out[k]}, ${value}` : value;
  });
  const cookies = h.getSetCookie?.();
  if (cookies?.length) out['set-cookie'] = cookies.join('\n');
  return out;
}

/** Find the charset: header, then BOM, then <meta>, else UTF-8. */
export function detectCharset(buf: Buffer, contentType: string): string {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  if (fromHeader) return fromHeader.toLowerCase();
  const head = buf.subarray(0, 2048).toString('latin1');
  const meta =
    /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head)?.[1];
  return (meta ?? 'utf-8').toLowerCase();
}

export function decodeBody(buf: Buffer, contentType: string): string {
  const charset = detectCharset(buf, contentType);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function describeError(e: unknown, timeoutMs: number, aborted: boolean): string {
  if (aborted) return `Timed out after ${timeoutMs} ms`;
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const code = err?.cause?.code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'DNS lookup failed: the domain could not be found';
    case 'ECONNREFUSED':
      return 'Connection refused';
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return 'Connection reset by the server';
    case 'CERT_HAS_EXPIRED':
      return 'TLS certificate has expired';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'TLS certificate is self-signed';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'TLS certificate does not match the host name';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'TLS certificate chain is incomplete';
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return `Timed out after ${timeoutMs} ms`;
  }
  const msg = err?.cause?.message ?? err?.message ?? String(e);
  return code ? `${code}: ${msg}` : msg;
}
