import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AvcConfig } from '../src/core/config.js';
import {
  AI_REFERRER_REGEX,
  aiAssistantFromSource,
  clearGoogleTokenCache,
  collectGa4,
  collectGsc,
  getGoogleAccessToken,
  googleLogin,
  googleTokenPath,
  normaliseGa4Property,
  pickGscProperty,
  readStoredGoogleToken,
  type FetchFn,
} from '../src/connect/index.js';

function cfg(google: AvcConfig['google'] = {}): AvcConfig {
  return {
    dataDir: mkdtempSync(join(tmpdir(), 'avc-google-')),
    sites: [],
    ai: { maxRunUsd: 3, maxMonthUsd: 30 },
    google,
    server: { port: 4317, host: '127.0.0.1' },
  };
}

type Call = { url: string; init?: RequestInit };
function mockFetch(
  handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const f: FetchFn = async (input, init) => {
    calls.push({ url: String(input), init });
    return handler(new URL(String(input)), init);
  };
  return { f, calls };
}
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => clearGoogleTokenCache());

describe('service account', () => {
  it('signs a valid RS256 JWT and caches the token', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const c = cfg();
    const keyFile = join(c.dataDir, 'sa.json');
    writeFileSync(
      keyFile,
      JSON.stringify({
        type: 'service_account',
        client_email: 'avc@proj.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        private_key_id: 'kid1',
      }),
    );
    c.google = { serviceAccountFile: keyFile };
    const { f, calls } = mockFetch(async (_u, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [h, p, s] = body.get('assertion')!.split('.');
      const v = createVerify('RSA-SHA256');
      v.update(`${h}.${p}`);
      expect(v.verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      expect(claims.iss).toBe('avc@proj.iam.gserviceaccount.com');
      expect(claims.scope).toContain('webmasters.readonly');
      expect(claims.exp - claims.iat).toBe(3600);
      expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
        alg: 'RS256',
        typ: 'JWT',
        kid: 'kid1',
      });
      return json({ access_token: 'sa-token', expires_in: 3600 });
    });
    expect(await getGoogleAccessToken(c, undefined, { fetch: f })).toBe('sa-token');
    expect(await getGoogleAccessToken(c, undefined, { fetch: f })).toBe('sa-token');
    expect(calls).toHaveLength(1);
  });

  it('explains a bad key file', async () => {
    const c = cfg({ serviceAccountFile: '/nope/key.json' });
    await expect(getGoogleAccessToken(c)).rejects.toThrow(
      /Could not read the service-account key file/,
    );
  });
});

describe('OAuth', () => {
  it('tells the user how to connect when nothing is set', async () => {
    await expect(getGoogleAccessToken(cfg())).rejects.toThrow(/Google is not connected/);
    await expect(getGoogleAccessToken(cfg({ clientId: 'x' }))).rejects.toThrow(
      /avc connect google/,
    );
  });

  it('runs the loopback + PKCE login, stores the refresh token (600) and refreshes', async () => {
    const c = cfg({ clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh' });
    let challenge = '';
    const { f } = mockFetch(async (_u, init) => {
      const b = new URLSearchParams(String(init?.body));
      if (b.get('grant_type') === 'authorization_code') {
        expect(b.get('code')).toBe('the-code');
        const { createHash } = await import('node:crypto');
        expect(createHash('sha256').update(b.get('code_verifier')!).digest('base64url')).toBe(
          challenge,
        );
        expect(b.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        const idPayload = Buffer.from(JSON.stringify({ email: 'owner@example.com' })).toString(
          'base64url',
        );
        return json({
          access_token: 'at-1',
          refresh_token: 'rt-1',
          expires_in: 3599,
          scope:
            'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly',
          id_token: `x.${idPayload}.y`,
        });
      }
      expect(b.get('grant_type')).toBe('refresh_token');
      expect(b.get('refresh_token')).toBe('rt-1');
      expect(b.get('client_secret')).toBe('shh');
      return json({ access_token: 'at-2', expires_in: 3600 });
    });
    const token = await googleLogin(c, undefined, {
      fetch: f,
      log: () => {},
      openBrowser: (url) => {
        const u = new URL(url);
        expect(u.searchParams.get('code_challenge_method')).toBe('S256');
        expect(u.searchParams.get('access_type')).toBe('offline');
        challenge = u.searchParams.get('code_challenge')!;
        const redirect = `${u.searchParams.get('redirect_uri')}/?code=the-code&state=${u.searchParams.get('state')}`;
        get(redirect, (res) => res.resume());
      },
    });
    expect(token).toBe('at-1');
    const stored = readStoredGoogleToken(c)!;
    expect(stored).toMatchObject({ refresh_token: 'rt-1', email: 'owner@example.com' });
    if (process.platform !== 'win32') expect(statSync(googleTokenPath(c)).mode & 0o777).toBe(0o600);
    clearGoogleTokenCache();
    expect(await getGoogleAccessToken(c, undefined, { fetch: f })).toBe('at-2');
  });

  it('rejects a wrong state and reports a revoked token clearly', async () => {
    const c = cfg({ clientId: 'cid' });
    writeFileSync(join(c.dataDir, 'x'), '');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(c.dataDir, 'tokens'), { recursive: true });
    writeFileSync(
      googleTokenPath(c),
      JSON.stringify({ refresh_token: 'rt', scope: '', client_id: 'cid', obtained_at: '' }),
    );
    const { f } = mockFetch(() => json({ error: 'invalid_grant' }, 400));
    await expect(getGoogleAccessToken(c, undefined, { fetch: f })).rejects.toThrow(
      /expired or was revoked/,
    );
  });

  it('asks to sign in again when scopes are missing', async () => {
    const c = cfg({ clientId: 'cid' });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(c.dataDir, 'tokens'), { recursive: true });
    writeFileSync(
      googleTokenPath(c),
      JSON.stringify({
        refresh_token: 'rt',
        scope: 'https://www.googleapis.com/auth/webmasters.readonly',
        client_id: 'cid',
        obtained_at: '',
      }),
    );
    await expect(getGoogleAccessToken(c)).rejects.toThrow(/Google Analytics \(read\)/);
    expect(readFileSync(googleTokenPath(c), 'utf8')).toContain('rt');
  });
});

describe('Search Console', () => {
  const props = [
    { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://blog.example.com/', permissionLevel: 'siteFullUser' },
    { siteUrl: 'https://other.com/', permissionLevel: 'siteOwner' },
    { siteUrl: 'https://www.example.com/', permissionLevel: 'siteUnverifiedUser' },
  ];
  it('picks the right property', () => {
    expect(pickGscProperty('https://blog.example.com/post', props)).toBe(
      'https://blog.example.com/',
    );
    expect(pickGscProperty('https://www.example.com/', props)).toBe('sc-domain:example.com');
    expect(pickGscProperty('https://shop.example.com/x', props)).toBe('sc-domain:example.com');
    expect(pickGscProperty('https://nope.org/', props)).toBeNull();
    expect(
      pickGscProperty('https://other.com/en/page', [
        { siteUrl: 'https://other.com/', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://other.com/en/', permissionLevel: 'siteOwner' },
      ]),
    ).toBe('https://other.com/');
  });

  it('collects totals, pages, queries, sitemaps and inspections', async () => {
    const { f, calls } = mockFetch(async (u, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
      if (u.pathname === '/webmasters/v3/sites') return json({ siteEntry: props });
      if (u.pathname.endsWith('/searchAnalytics/query')) {
        const b = JSON.parse(String(init?.body));
        expect(b.startDate).toBe('2026-09-15');
        expect(b.endDate).toBe('2026-10-12');
        if (!b.dimensions)
          return json({ rows: [{ clicks: 120, impressions: 4000, ctr: 0.03, position: 11.2 }] });
        if (b.dimensions[0] === 'page')
          return json({
            rows: [
              {
                keys: ['https://www.example.com/'],
                clicks: 80,
                impressions: 2000,
                ctr: 0.04,
                position: 6,
              },
            ],
          });
        return json({
          rows: [
            { keys: ['example agency'], clicks: 30, impressions: 300, ctr: 0.1, position: 2.1 },
          ],
        });
      }
      if (u.pathname.endsWith('/sitemaps'))
        return json({
          sitemap: [
            {
              path: 'https://www.example.com/sitemap.xml',
              errors: '0',
              warnings: '1',
              contents: [{ type: 'web', submitted: '42' }],
            },
          ],
        });
      if (u.pathname === '/v1/urlInspection/index:inspect') {
        const b = JSON.parse(String(init?.body));
        expect(b.siteUrl).toBe('sc-domain:example.com');
        if (b.inspectionUrl.endsWith('/broken'))
          return json({ error: { code: 500, message: 'boom' } }, 400);
        return json({
          inspectionResult: {
            indexStatusResult: {
              verdict: 'PASS',
              coverageState: 'Submitted and indexed',
              googleCanonical: b.inspectionUrl,
              lastCrawlTime: '2026-10-01T10:00:00Z',
            },
          },
        });
      }
      return json({}, 404);
    });
    const d = await collectGsc(
      { accessToken: 'tok', fetch: f, baseUrl: 'http://gsc.test' },
      'https://www.example.com/',
      {
        now: new Date('2026-10-13T12:00:00Z'),
        inspect: ['https://www.example.com/', 'https://www.example.com/broken'],
        inspectDelayMs: 0,
      },
    );
    expect(d.property).toBe('sc-domain:example.com');
    expect(d.totals.clicks).toBe(120);
    expect(d.pages[0].url).toBe('https://www.example.com/');
    expect(d.queries[0].query).toBe('example agency');
    expect(d.sitemaps?.[0]).toMatchObject({
      warnings: 1,
      contents: [{ type: 'web', submitted: 42 }],
    });
    expect(d.inspections?.[0]).toMatchObject({
      verdict: 'PASS',
      lastCrawl: '2026-10-01T10:00:00Z',
    });
    expect(d.inspections?.[1].verdict).toBe('ERROR');
    expect(calls.some((c) => c.url.includes(encodeURIComponent('sc-domain:example.com')))).toBe(
      true,
    );
  });

  it('turns API errors into instructions', async () => {
    const { f } = mockFetch(() =>
      json(
        {
          error: {
            code: 403,
            message:
              'Google Search Console API has not been used in project 123 before or it is disabled.',
            status: 'PERMISSION_DENIED',
            details: [
              {
                reason: 'SERVICE_DISABLED',
                metadata: {
                  activationUrl:
                    'https://console.developers.google.com/apis/api/searchconsole.googleapis.com/overview?project=123',
                },
              },
            ],
          },
        },
        403,
      ),
    );
    await expect(
      collectGsc({ accessToken: 't', fetch: f }, 'https://example.com/'),
    ).rejects.toThrow(/not enabled.*searchconsole\.googleapis\.com/);
    const { f: f2 } = mockFetch(() =>
      json(
        {
          error: {
            code: 403,
            message: "User does not have sufficient permission for site 'sc-domain:example.com'.",
          },
        },
        403,
      ),
    );
    await expect(
      collectGsc(
        { accessToken: 't', fetch: f2, principal: 'Service account a@b.iam' },
        'https://example.com/',
        {
          property: 'sc-domain:example.com',
        },
      ),
    ).rejects.toThrow(/Service account a@b\.iam has no access.*Users and permissions/);
  });
});

describe('GA4', () => {
  it('recognises AI assistant sources', () => {
    for (const s of [
      'chatgpt.com',
      'chat.openai.com',
      'perplexity.ai',
      'www.perplexity.ai',
      'gemini.google.com',
      'claude.ai',
      'copilot.microsoft.com',
      'edgeservices.bing.com',
      'you.com',
      'chat.deepseek.com',
      'grok.com',
      'chat.mistral.ai',
      'meta.ai',
      'phind.com',
      'chatgpt',
    ])
      expect(AI_REFERRER_REGEX.test(s), s).toBe(true);
    for (const s of [
      'google',
      'bing.com',
      'bayou.com',
      'facebook.com',
      '(direct)',
      'openai.com',
      'news.google.com',
    ])
      expect(AI_REFERRER_REGEX.test(s), s).toBe(false);
    expect(aiAssistantFromSource('https://chatgpt.com/')).toBe('ChatGPT');
    expect(aiAssistantFromSource('edgeservices.bing.com')).toBe('Microsoft Copilot');
    expect(normaliseGa4Property('123456789')).toBe('properties/123456789');
  });

  it('collects AI referrals and landing pages', async () => {
    const { f } = mockFetch(async (u, init) => {
      expect(u.pathname).toBe('/v1beta/properties/123456:runReport');
      const b = JSON.parse(String(init?.body));
      expect(b.dimensionFilter.filter.stringFilter.matchType).toBe('FULL_REGEXP');
      if (b.dimensions.length === 1)
        return json({
          rows: [
            {
              dimensionValues: [{ value: 'chatgpt.com' }],
              metricValues: [{ value: '41' }, { value: '30' }, { value: '3' }],
            },
            {
              dimensionValues: [{ value: 'perplexity.ai' }],
              metricValues: [{ value: '7' }, { value: '5' }, { value: '0' }],
            },
          ],
        });
      return json({
        rows: [
          {
            dimensionValues: [{ value: 'chatgpt.com' }, { value: '/pricing' }],
            metricValues: [{ value: '20' }],
          },
        ],
      });
    });
    const d = await collectGa4(
      { accessToken: 't', fetch: f, baseUrl: 'http://ga.test' },
      'properties/123456',
      {
        now: new Date('2026-10-13T00:00:00Z'),
      },
    );
    expect(d.range).toEqual({ start: '2026-09-15', end: '2026-10-12' });
    expect(d.aiReferrals[0]).toEqual({
      source: 'chatgpt.com',
      sessions: 41,
      engagedSessions: 30,
      conversions: 3,
    });
    expect(d.landingPages).toEqual([{ source: 'chatgpt.com', path: '/pricing', sessions: 20 }]);
  });
});
