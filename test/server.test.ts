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
