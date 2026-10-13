/**
 * URL helpers shared by the crawler and the checks. Pure functions, no I/O.
 */

/** Query parameters that only track a visit and never change the page. */
export const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'utm_place',
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'fbclid',
  'msclkid',
  'yclid',
  'twclid',
  'li_fat_id',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'hsctatracking',
  'igshid',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  'ref_src',
]);

export interface NormaliseOptions {
  /** Remove utm_*, gclid, fbclid and similar. Default false. */
  stripTracking?: boolean;
  /** Sort query parameters so ?b=1&a=2 and ?a=2&b=1 match. Default false. */
  sortQuery?: boolean;
  /** Remove a trailing slash from non-root paths. Default false. */
  stripTrailingSlash?: boolean;
}

export function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Canonical form used as the crawler's map key: lower-case scheme and host,
 * default port and fragment dropped, path percent-encoding made consistent,
 * query kept. Returns the input unchanged when it cannot be parsed.
 */
export function normaliseUrl(input: string, opts: NormaliseOptions = {}): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return input;
  }
  u.hash = '';
  // WHATWG URL already lower-cases scheme/host and drops default ports.
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))
    u.port = '';
  if (u.hostname.endsWith('.')) u.hostname = u.hostname.slice(0, -1);
  u.pathname = normalisePathEncoding(u.pathname || '/');
  if (opts.stripTrailingSlash && u.pathname.length > 1 && u.pathname.endsWith('/'))
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  if (u.search) {
    const params = new URLSearchParams(u.search);
    if (opts.stripTracking) {
      for (const key of [...params.keys()]) {
        const k = key.toLowerCase();
        if (TRACKING_PARAMS.has(k) || k.startsWith('utm_')) params.delete(key);
      }
    }
    if (opts.sortQuery) params.sort();
    const qs = opts.stripTracking || opts.sortQuery ? params.toString() : u.search.slice(1);
    u.search = qs ? `?${qs}` : '';
  }
  let out = u.toString();
  // URL keeps a bare "?" when search was set to "?": drop it.
  if (out.endsWith('?')) out = out.slice(0, -1);
  return out;
}

/** Upper-case percent escapes and decode unreserved characters (RFC 3986 §6.2.2). */
function normalisePathEncoding(path: string): string {
  return path.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => {
    const code = parseInt(hex, 16);
    const ch = String.fromCharCode(code);
    if (/[A-Za-z0-9\-._~]/.test(ch)) return ch;
    return `%${hex.toUpperCase()}`;
  });
}

/** Resolve a (possibly relative) href against a base. Null for javascript:, mailto: etc. */
export function resolveUrl(href: string | null | undefined, base: string): string | null {
  if (href == null) return null;
  const h = href.trim();
  if (!h) return null;
  if (/^(javascript|mailto|tel|sms|data|blob|about|file|ftp|chrome|intent|whatsapp|skype|callto):/i.test(h))
    return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Host without a leading "www.", lower-case. */
export function bareHost(urlOrHost: string): string {
  let host = urlOrHost;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrHost)) host = new URL(urlOrHost).hostname;
  } catch {
    /* keep */
  }
  return host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

/**
 * Whether `url` belongs to the same site as `origin`. The www and apex
 * variants count as the same site; scheme differences (http vs https) too.
 */
export function sameSite(url: string, origin: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(origin);
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return false;
    const portA = a.port || (a.protocol === 'https:' ? '443' : '80');
    const portB = b.port || (b.protocol === 'https:' ? '443' : '80');
    // Non-default ports must match exactly (local dev servers, staging).
    if ((a.port || b.port) && portA !== portB) return false;
    return bareHost(a.hostname) === bareHost(b.hostname);
  } catch {
    return false;
  }
}

/** Same origin, strictly (scheme + host + port). */
export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Path plus query, e.g. "/blog/post?page=2". "/" when unparsable. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return '/';
  }
}

/** Lower-case extension of the last path segment, without the dot, or ''. */
export function extensionOf(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? '';
  }
  const last = path.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0 || dot === last.length - 1) return '';
  return last.slice(dot + 1).toLowerCase();
}

export const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'svg',
  'ico',
  'bmp',
  'tif',
  'tiff',
  'heic',
]);
export const DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'csv',
  'txt',
  'epub',
]);
export const MEDIA_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'mov',
  'avi',
  'mkv',
  'mp3',
  'wav',
  'ogg',
  'm4a',
  'flac',
]);
export const ASSET_EXTENSIONS = new Set([
  'css',
  'js',
  'mjs',
  'map',
  'json',
  'xml',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'zip',
  'gz',
  'tar',
  'rar',
  '7z',
  'exe',
  'dmg',
  'msi',
  'apk',
  'iso',
  'bin',
]);
const HTML_EXTENSIONS = new Set(['', 'html', 'htm', 'xhtml', 'php', 'asp', 'aspx', 'jsp', 'cfm', 'shtml']);

export function isImageUrl(url: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(url));
}
export function isDocumentUrl(url: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extensionOf(url));
}
export function isMediaUrl(url: string): boolean {
  return MEDIA_EXTENSIONS.has(extensionOf(url));
}
/** Extension suggests an HTML page (no extension, .html, .php …). Unknown extensions count as HTML. */
export function looksLikeHtmlUrl(url: string): boolean {
  const ext = extensionOf(url);
  if (HTML_EXTENSIONS.has(ext)) return true;
  return !(
    IMAGE_EXTENSIONS.has(ext) ||
    DOCUMENT_EXTENSIONS.has(ext) ||
    MEDIA_EXTENSIONS.has(ext) ||
    ASSET_EXTENSIONS.has(ext)
  );
}

/** Whether a content-type header is an HTML document. */
export function isHtmlContentType(ct: string | null | undefined): boolean {
  if (!ct) return false;
  const t = ct.toLowerCase();
  return t.includes('text/html') || t.includes('application/xhtml+xml');
}

/** Number of path segments: "/" → 0, "/a/b/" → 2. */
export function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}
