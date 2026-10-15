import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureServer } from './fixtures/serve.js';

// Isolate data and config before any app module loads (config reads env at import time).
const dataDir = mkdtempSync(join(tmpdir(), 'avc-server-'));
process.env.AVC_DATA_DIR = dataDir;
process.env.AVC_LLM_MOCK = '1';

const PORT = 4317;
const HOST = `127.0.0.1:${PORT}`;
const TOKEN = 'test-token-123';

type App = ReturnType<typeof import('../src/server/app.js').createApp>;
let app: App;
let fixture: FixtureServer;
let siteId = '';
let auditId = '';

function req(path: string, init: RequestInit & { cookie?: boolean; host?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set('host', init.host ?? HOST);
  if (init.cookie !== false) headers.set('cookie', `avc_session=${TOKEN}`);
  return app.request(`http://${init.host ?? HOST}${path}`, { ...init, headers });
}

beforeAll(async () => {
  const { startFixtureServer } = await import('./fixtures/serve.js');
  const { createApp } = await import('../src/server/app.js');
  const services = await import('../src/cli/services.js');
  fixture = await startFixtureServer();
  const site = services.resolveSite(fixture.url);
  siteId = site.id;
  services.upsertUserSite({ ...site, brand: { name: 'Northwind Joinery' } });
  const result = await services.audit({
    url: fixture.url,
    site: services.resolveSite(siteId, services.getConfig(true)),
    maxPages: 30,
    render: false,
  });
  auditId = result.id;
  app = createApp({ token: TOKEN, port: PORT });
}, 120_000);

afterAll(async () => {
  await fixture?.close();
});

describe('dashboard security', () => {
  it('refuses an unexpected Host header (DNS rebinding)', async () => {
    const res = await req('/', { host: 'evil.example:4317' });
    expect(res.status).toBe(403);
  });

  it('refuses requests without the session cookie', async () => {
    const res = await req('/', { cookie: false });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Open the link from your terminal');
  });

  it('refuses a wrong token in the URL', async () => {
    const res = await req('/?token=nope', { cookie: false });
    expect(res.status).toBe(401);
  });

  it('turns the URL token into an HttpOnly SameSite=Strict cookie and strips it', async () => {
    const res = await req(`/?token=${TOKEN}`, { cookie: false });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`avc_session=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('refuses cross-origin form posts', async () => {
    const res = await req('/sites', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'url=https://x.example',
    });
    expect(res.status).toBe(403);
  });

  it('sends a strict CSP and no-sniff', async () => {
    const res = await req('/');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves the static assets', async () => {
    const css = await req('/assets/app.css', { cookie: false });
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect((await req('/assets/../package.json', { cookie: false })).status).not.toBe(200);
    expect((await req('/assets/secret.json', { cookie: false })).status).toBe(404);
  });
});

describe('dashboard pages', () => {
  const pages = () => [
    '/',
    `/s/${siteId}`,
    `/s/${siteId}/run`,
    `/s/${siteId}/issues`,
    `/s/${siteId}/issues?severity=high&q=title`,
    `/s/${siteId}/pages`,
    `/s/${siteId}/crawlers`,
    `/s/${siteId}/agentic`,
    `/s/${siteId}/visibility`,
    `/s/${siteId}/fixes`,
    `/s/${siteId}/connections`,
    `/s/${siteId}/history`,
    '/settings',
    '/checks',
  ];

  it('renders every page', async () => {
    for (const p of pages()) {
      const res = await req(p);
      const body = await res.text();
      expect(res.status, `${p}: ${body.slice(0, 300)}`).toBe(200);
      expect(body.startsWith('<!doctype html>')).toBe(true);
      expect(body).toContain('AI Visibility Checker');
    }
  }, 60_000);

  it('shows the score on the overview', async () => {
    const body = await (await req(`/s/${siteId}`)).text();
    expect(body).toContain('AI Visibility Score');
    expect(body).toContain(`/a/${auditId}/export/html`);
  });

  it('opens a page detail', async () => {
    const res = await req(`/s/${siteId}/page?url=${encodeURIComponent(fixture.url + '/')}`);
    const alt =
      res.status === 404
        ? await req(`/s/${siteId}/page?url=${encodeURIComponent(fixture.url)}`)
        : res;
    expect(alt.status).toBe(200);
    expect(await alt.text()).toContain('Raw vs rendered');
  });

  it('exports every format', async () => {
    for (const f of ['html', 'md', 'json', 'sarif', 'csv-issues', 'csv-pages']) {
      const res = await req(`/a/${auditId}/export/${f}`);
      expect(res.status, f).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('attachment');
    }
  });

  it('downloads a generated llms.txt', async () => {
    const res = await req(`/s/${siteId}/generate/llms-txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^# /);
  });

  it('adds a site from the form', async () => {
    const res = await req('/sites', {
      method: 'POST',
      headers: { origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'url=https%3A%2F%2Fnew-site.example&name=New',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/s/new-site.example');
    expect(await (await req('/')).text()).toContain('new-site.example');
  });

  it('saves prompts', async () => {
    const res = await req(`/s/${siteId}/prompts`, {
      method: 'POST',
      headers: { origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: `prompts=${encodeURIComponent('[category] best joiners in Leeds\n[no-search] who is Northwind Joinery')}`,
    });
    expect(res.status).toBe(303);
    const body = await (await req(`/s/${siteId}/visibility`)).text();
    expect(body).toContain('best joiners in Leeds');
  });

  it('runs a mock AI visibility job and streams progress', async () => {
    const res = await req(`/s/${siteId}/visibility`, {
      method: 'POST',
      headers: { origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'confirm=on&engines=chatgpt&repeats=1&prompts=best%20joiners%20in%20Leeds',
    });
    expect(res.status).toBe(303);
    const jobPath = res.headers.get('location')!;
    expect(jobPath).toMatch(/^\/jobs\//);
    const events = await (await req(`${jobPath}/events`)).text();
    expect(events).toContain('event: done');
    const page = await (await req(`/s/${siteId}/visibility`)).text();
    expect(page).toContain('Share of voice');
  }, 120_000);

  it('returns 404 for an unknown site', async () => {
    expect((await req('/s/nope.example')).status).toBe(404);
  });
});

describe('dashboard: site graph, snippets, ask and new exports', () => {
  it('renders the site graph page and its data', async () => {
    const page = await req(`/s/${siteId}/graph`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Internal link graph');
    expect(html).toContain('/assets/graph.js');
    const data = (await (await req(`/s/${siteId}/graph.json`)).json()) as {
      nodes: unknown[];
      edges: unknown[];
    };
    expect(data.nodes.length).toBeGreaterThan(3);
    expect(data.edges.length).toBeGreaterThan(3);
    expect((await req('/assets/graph.js')).status).toBe(200);
  });

  it('renders snippet previews and answers questions', async () => {
    const serp = await req(`/s/${siteId}/serp?all=1`);
    expect(serp.status).toBe(200);
    expect(await serp.text()).toMatch(/indexable pages/);
    const ask = await req(`/s/${siteId}/ask`, {
      method: 'POST',
      headers: { origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'q=what+should+I+fix+first',
    });
    expect(ask.status).toBe(200);
    expect(await ask.text()).toMatch(/Start with these/);
  });

  it('exports Excel', async () => {
    const res = await req(`/a/${auditId}/export/xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/spreadsheetml/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('dashboard: resources, page filters and screenshots', () => {
  it('lists resources and filters pages', async () => {
    const res = await req(`/s/${siteId}/resources?type=image`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/resources/);
    const pages = await req(`/s/${siteId}/pages?minDepth=1&maxWords=100000`);
    expect(pages.status).toBe(200);
  });

  it('refuses screenshots of other sites', async () => {
    const res = await req(
      `/s/${siteId}/screenshot?url=${encodeURIComponent('https://example.org/')}`,
    );
    expect(res.status).toBe(400);
  });
});

describe('dashboard: page filter builder', () => {
  it('matches rules and filters the table', async () => {
    const { matchRule } = await import('../src/server/pages/site.js');
    const row = {
      url: 'https://e.com/blog/a',
      wordCount: 120,
      title: null,
      schemaTypes: ['Article'],
    };
    expect(matchRule(row as never, { field: 'url', op: 'contains', value: '/BLOG/' })).toBe(true);
    expect(matchRule(row as never, { field: 'wordCount', op: 'lt', value: '200' })).toBe(true);
    expect(matchRule(row as never, { field: 'title', op: 'empty', value: '' })).toBe(true);
    expect(matchRule(row as never, { field: 'schemaTypes', op: 'equals', value: 'article' })).toBe(
      true,
    );
    const res = await req(`/s/${siteId}/pages?f1=url&o1=contains&v1=about&f2=status&o2=lt&v2=400`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/about');
    expect(html).not.toContain('/services/kitchens');
  });
});

describe('API keys page', () => {
  const KEY = 'sk-dashboard-secret-9876543210';
  const post = (path: string, body: string) =>
    req(path, {
      method: 'POST',
      headers: { origin: `http://${HOST}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

  it('saves a key to the secret store and only ever shows dots', async () => {
    const res = await post('/keys', `openai=${KEY}`);
    expect(res.status).toBe(303);
    const { secretStore } = await import('../src/core/secrets.js');
    expect(secretStore().get('openai')).toBe(KEY);
    const html = await (await req('/keys')).text();
    expect(html).not.toContain(KEY);
    expect(html).not.toContain(KEY.slice(-4));
    expect(html).toContain('••••••••');
    expect(html).toContain('type="password"');
    // Not in the settings page or the user config file either.
    expect(await (await req('/settings')).text()).not.toContain(KEY);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(dataDir, 'config.json'), 'utf8')).not.toContain(KEY);
  });

  it('removes a saved key', async () => {
    await post('/keys/remove/openai', '');
    const { secretStore } = await import('../src/core/secrets.js');
    expect(secretStore().get('openai')).toBeUndefined();
  });

  it('refuses a cross-origin save', async () => {
    const res = await req('/keys', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `openai=${KEY}`,
    });
    expect(res.status).toBe(403);
  });

  it('accepts a form post with Origin: null from the same page, as Chrome sends it', async () => {
    const ok = await req('/keys', {
      method: 'POST',
      headers: {
        origin: 'null',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'anthropic=sk-ant-null-origin-123',
    });
    expect(ok.status).toBe(303);
    const forged = await req('/keys', {
      method: 'POST',
      headers: {
        origin: 'null',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'anthropic=sk-ant-attacker-0000',
    });
    expect(forged.status).toBe(403);
    await post('/keys/remove/anthropic', '');
  });

  it('says when a key has no free test', async () => {
    const res = await post('/keys/test/perplexity', 'perplexity=pplx-abcdefghij');
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toMatch(/no free way/);
  });
});
