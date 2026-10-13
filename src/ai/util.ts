import { createHash } from 'node:crypto';

/** Small helpers shared by the AI visibility engine. Pure, no I/O. */

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return url
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('/')[0]!;
  }
}

/** True when `host` is `domain` or a subdomain of it. */
export function sameSite(host: string, domain: string): boolean {
  const h = hostOf(host);
  const d = hostOf(domain);
  return Boolean(h && d && (h === d || h.endsWith(`.${d}`)));
}

const SUFFIX =
  /\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|pvt|private|sdn|bhd|pte|ag|sa|bv|oy|ab)\b\.?/g;

export function normBrand(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.(com|net|org|io|co|ai|app|dev|uk|my|sg|bd|in|au|ca|de)\b/g, '')
    .replace(SUFFIX, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Loose brand equality: "Acme Ltd" = "ACME" = "acme.com". Short names must match exactly. */
export function sameBrand(a: string, b: string): boolean {
  const x = normBrand(a);
  const y = normBrand(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short) && short.length / long.length >= 0.6;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary, case-insensitive search for any of the names. */
export function mentionsAny(text: string, names: string[]): boolean {
  return names.some((n) => {
    const name = n.trim();
    if (name.length < 2) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}($|[^\\p{L}\\p{N}])`, 'iu').test(
      text,
    );
  });
}

export function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/** Stable prompt id, so runs can be compared prompt by prompt. */
export function promptId(kind: string, text: string): string {
  return `p_${sha1(`${kind}:${text.toLowerCase().replace(/\s+/g, ' ').trim()}`).slice(0, 10)}`;
}

/** Deterministic PRNG (mulberry32) seeded from a string. */
export function seeded(seed: string): () => number {
  let a = Number.parseInt(sha1(seed).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function describeError(error: unknown): string {
  const e = error as { name?: string; message?: string; statusCode?: number; lastError?: unknown };
  if (!e || typeof e !== 'object') return String(error);
  const inner = e.lastError ? ` <- ${describeError(e.lastError)}` : '';
  return `${e.name ?? 'Error'}${e.statusCode ? ` ${e.statusCode}` : ''}: ${(e.message ?? '').slice(0, 200)}${inner}`;
}

/** Combine a caller's signal with a timeout. */
export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

export function uniq<T>(items: T[], key: (t: T) => string = (t) => String(t)): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = key(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const STOP = new Set(
  'a an and the of for in on to with by at from is are be can do does how what which who best top good great i my me we our you your should need find recommend recommendation recommendations company companies provider providers service services agency agencies firm firms near vs versus or it its this that there their them reliable rated'.split(
    ' ',
  ),
);

/** Content words of a prompt or title, crudely singularised. */
export function keywords(text: string): string[] {
  return uniq(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)),
  );
}
