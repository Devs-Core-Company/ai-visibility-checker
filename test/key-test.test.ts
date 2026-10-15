import { describe, expect, it } from 'vitest';
import { canTestKey, testKey } from '../src/core/key-test.js';
import { dropUnfilledPlaceholders } from '../src/core/secrets.js';

const KEY = 'sk-test-abcdefghijklmnop';

function fakeFetch(status: number, body: unknown = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('key tests', () => {
  it('sends the key in a header, never in the URL', async () => {
    for (const id of ['gateway', 'openai', 'anthropic', 'google-ai', 'xai']) {
      const f = fakeFetch(200);
      await testKey(id, KEY, f.impl);
      expect(f.calls[0]!.url).not.toContain(KEY);
      expect(JSON.stringify(f.calls[0]!.headers)).toContain(KEY);
    }
  });

  it('reports accepted, rejected and the gateway balance without echoing the key', async () => {
    const ok = await testKey('gateway', KEY, fakeFetch(200, { balance: '12.50' }).impl);
    expect(ok).toEqual({ ok: true, message: expect.stringMatching(/accepted.*\$12\.50/) });
    const bad = await testKey('openai', KEY, fakeFetch(401).impl);
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/rejected the key \(HTTP 401\)/);
    expect(bad.message).not.toContain(KEY);
  });

  it('has no free test for Perplexity and says so', async () => {
    expect(canTestKey('perplexity')).toBe(false);
    expect((await testKey('perplexity', KEY)).ok).toBeNull();
  });
});

describe('Claude Desktop extension placeholders', () => {
  it('drops optional settings the user left empty', () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: '${user_config.openai_key}',
      ANTHROPIC_API_KEY: 'sk-ant-real',
    };
    dropUnfilledPlaceholders(env);
    expect(env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-real' });
  });
});
