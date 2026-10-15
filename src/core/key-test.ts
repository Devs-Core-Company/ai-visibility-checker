/**
 * "Does this key work?" with one free request to the provider: a model list or a balance
 * endpoint, never a paid generation. The key goes in a request header only (never in a URL,
 * where logs and proxies keep it), and nothing about the key is returned.
 */
import { secretField } from './secrets.js';

export interface KeyTestResult {
  ok: boolean | null; // null: no free check exists for this key
  message: string;
}

interface Probe {
  url: string;
  headers(key: string): Record<string, string>;
  /** Extra detail from a successful response (e.g. the gateway balance). */
  detail?(body: unknown): string | undefined;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

const PROBES: Record<string, Probe> = {
  gateway: {
    url: 'https://ai-gateway.vercel.sh/v1/credits',
    headers: bearer,
    detail: (b) => {
      const balance = (b as { balance?: string })?.balance;
      return balance ? `Balance: $${balance}.` : undefined;
    },
  },
  openai: { url: 'https://api.openai.com/v1/models', headers: bearer },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  'google-ai': {
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: (key) => ({ 'x-goog-api-key': key }),
  },
  xai: { url: 'https://api.x.ai/v1/models', headers: bearer },
};

/** Whether a free check exists for this key id. */
export const canTestKey = (id: string): boolean => id in PROBES;

export async function testKey(
  id: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyTestResult> {
  const field = secretField(id);
  const probe = PROBES[id];
  if (!field) return { ok: false, message: `Unknown key "${id}".` };
  if (!probe)
    return {
      ok: null,
      message: `${field.label} has no free way to check a key; it is checked the first time it is used.`,
    };
  if (!key) return { ok: false, message: `No ${field.label} key is set.` };
  try {
    const res = await fetchImpl(probe.url, {
      headers: { ...probe.headers(key), Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      let extra: string | undefined;
      try {
        extra = probe.detail?.(await res.json());
      } catch {
        /* the status is what matters */
      }
      return { ok: true, message: `${field.label} accepted the key.${extra ? ` ${extra}` : ''}` };
    }
    if (res.status === 401 || res.status === 403)
      return { ok: false, message: `${field.label} rejected the key (HTTP ${res.status}).` };
    if (res.status === 429)
      return {
        ok: true,
        message: `${field.label} accepted the key but is rate-limiting it right now (HTTP 429).`,
      };
    return {
      ok: false,
      message: `${field.label} answered HTTP ${res.status}; the key could not be confirmed.`,
    };
  } catch (e) {
    return {
      ok: false,
      message: `Could not reach ${field.label}: ${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message}.`,
    };
  }
}
