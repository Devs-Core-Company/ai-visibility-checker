import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AvcConfig } from '../src/core/config.js';
import type { AuditResult, PageSummary } from '../src/core/types.js';
import { applyFixes } from '../src/fixes/apply/index.js';
import { rollback } from '../src/fixes/apply/rollback.js';
import { altFromFilename, imageSrcsFromIssue, WpClient } from '../src/fixes/apply/wordpress.js';

const USER = 'editor';
const PASS = 'abcd efgh ijkl mnop';

interface Post {
  id: number;
  slug: string;
  type: 'pages' | 'posts';
  seo: { title: string; description: string; noindex: boolean };
}

let state: {
  helper: boolean;
  posts: Post[];
  media: { id: number; source_url: string; alt_text: string }[];
  settings: Record<string, unknown>;
  writes: string[];
};

function reset(helper = true) {
  state = {
    helper,
    posts: [
      { id: 2, slug: 'about', type: 'pages', seo: { title: '', description: '', noindex: false } },
      {
        id: 7,
        slug: 'fix-a-leak',
        type: 'posts',
        seo: { title: 'Leak', description: 'Old', noindex: true },
      },
      { id: 9, slug: 'home', type: 'pages', seo: { title: '', description: '', noindex: false } },
    ],
    media: [
      { id: 30, source_url: '', alt_text: '' },
      { id: 31, source_url: '', alt_text: '' },
    ],
    settings: { show_on_front: 'page', page_on_front: 9, avc_robots_txt: '', avc_llms_txt: '' },
    writes: [],
  };
}

let server: Server;
let base = '';

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((res) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => res(s ? JSON.parse(s) : {}));
  });
}

function link(p: Post): string {
  return p.slug === 'home'
    ? `${base}/`
    : p.type === 'pages'
      ? `${base}/${p.slug}/`
      : `${base}/blog/${p.slug}/`;
}

function view(p: Post) {
  return { id: p.id, link: link(p), meta: {}, ...(state.helper ? { avc_seo: { ...p.seo } } : {}) };
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (!url.pathname.startsWith('/wp-json')) return send(404, { message: 'nope' });
    const auth = req.headers.authorization ?? '';
    const ok = auth === 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
    const route = url.pathname.slice('/wp-json'.length) || '/';
    if (route === '/') {
      return send(200, {
        name: 'Acme',
        namespaces: ['wp/v2', 'yoast/v1', ...(state.helper ? ['avc/v1'] : [])],
      });
    }
    if (!ok) return send(401, { code: 'rest_not_logged_in', message: 'Not logged in' });
    if (route === '/avc/v1/status' && state.helper)
      return send(200, { helper: '1.0.0', seoPlugin: 'yoast' });
    if (route === '/wp/v2/users/me')
      return send(200, { id: 1, capabilities: { manage_options: true, edit_posts: true } });
    if (route === '/wp/v2/settings') {
      if (req.method === 'POST') {
        const b = await body(req);
        for (const [k, v] of Object.entries(b)) {
          if (!(k in state.settings)) return send(400, { message: `unknown setting ${k}` });
          state.settings[k] = v;
        }
        state.writes.push(`settings:${Object.keys(b).join(',')}`);
      }
      return send(200, state.settings);
    }
    let m = /^\/wp\/v2\/(pages|posts)$/.exec(route);
    if (m)
      return send(
        200,
        state.posts
          .filter((p) => p.type === m![1] && p.slug === url.searchParams.get('slug'))
          .map(view),
      );
    m = /^\/wp\/v2\/(pages|posts)\/(\d+)$/.exec(route);
    if (m) {
      const p = state.posts.find((x) => x.type === m![1] && x.id === Number(m![2]));
      if (!p) return send(404, { message: 'not found' });
      if (req.method === 'POST') {
        const b = (await body(req)) as {
          avc_seo?: Partial<Post['seo']>;
          meta?: Record<string, unknown>;
        };
        if (b.avc_seo && state.helper) Object.assign(p.seo, b.avc_seo);
        state.writes.push(`${route}:${JSON.stringify(b)}`);
      }
      return send(200, view(p));
    }
    if (route === '/wp/v2/media') {
      const q = url.searchParams.get('search') ?? '';
      return send(
        200,
        state.media.filter((x) => x.source_url.includes(q)),
      );
    }
    m = /^\/wp\/v2\/media\/(\d+)$/.exec(route);
    if (m) {
      const md = state.media.find((x) => x.id === Number(m![1]))!;
      if (req.method === 'POST') {
        const b = await body(req);
        md.alt_text = String(b.alt_text);
        state.writes.push(`${route}:${JSON.stringify(b)}`);
      }
      return send(200, md);
    }
    return send(404, { message: `no route ${route}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

let dataDir: string;
beforeEach(() => {
  reset();
  state.media[0].source_url = `${base}/wp-content/uploads/2026/01/blue-boiler-front-panel.jpg`;
  state.media[1].source_url = `${base}/wp-content/uploads/2026/01/IMG_4821.jpg`;
  dataDir = mkdtempSync(join(tmpdir(), 'avc-wp-'));
});

function page(path: string, over: Partial<PageSummary> = {}): PageSummary {
  const url = base + path;
  return {
    url,
    finalUrl: url,
    status: 200,
    depth: 1,
    title: null,
    metaDescription: null,
    h1: null,
    wordCount: 300,
    canonical: url,
    indexable: true,
    inlinks: 2,
    outlinks: 4,
    bytes: 1000,
    ttfbMs: 50,
    schemaTypes: [],
    issues: 1,
    inSitemap: true,
    ...over,
  };
}

function audit(): AuditResult {
  const pages = [
    page('/', { title: 'Acme Plumbing – Leeds plumbers', metaDescription: 'Plumbers in Leeds.' }),
    page('/about/', { title: null, h1: 'About Acme Plumbing' }),
    page('/blog/fix-a-leak/', { title: 'Leak | Acme Plumbing', h1: 'How to fix a dripping tap' }),
  ];
  return {
    id: 'x',
    version: '1',
    site: base,
    startUrl: base,
    at: '',
    stack: { id: 'wordpress', confidence: 1, signals: [], seoPlugin: 'yoast' },
    stats: {} as AuditResult['stats'],
    pages,
    issues: [
      { checkId: 'onpage.title-missing', url: `${base}/about/`, message: 'No title' },
      { checkId: 'onpage.title-too-short', url: `${base}/blog/fix-a-leak/`, message: 'Short' },
      { checkId: 'crawlability.noindex', url: `${base}/blog/fix-a-leak/`, message: 'noindex' },
      {
        checkId: 'images.alt-missing',
        url: `${base}/about/`,
        message: 'alt',
        evidence: `<img src="${base}/wp-content/uploads/2026/01/blue-boiler-front-panel-300x200.jpg">`,
      },
      {
        checkId: 'images.alt-missing',
        url: `${base}/about/`,
        message: 'alt',
        data: { src: `${base}/wp-content/uploads/2026/01/IMG_4821.jpg` },
      },
      { checkId: 'ai-crawlers.claudebot-blocked', message: 'blocked' },
      { checkId: 'llms-txt.missing', message: 'none' },
    ],
    checks: {},
    score: { overall: 0, grade: 'F', pillars: [] },
    priorities: [],
    probes: [],
    botFetches: [],
    robots: {
      found: true,
      status: 200,
      body: 'User-agent: *\nDisallow: /wp-admin/\n\nUser-agent: ClaudeBot\nDisallow: /\n',
    },
    sitemaps: [{ url: `${base}/sitemap_index.xml`, found: true, urls: 3, errors: [] }],
    external: {},
  };
}

function config(): AvcConfig {
  return {
    dataDir,
    sites: [
      {
        id: 'acme',
        url: base,
        connections: { wordpress: { url: base, user: USER, appPassword: PASS } },
      },
    ],
    ai: { mock: true, maxRunUsd: 1, maxMonthUsd: 1 },
    server: { port: 0, host: '127.0.0.1' },
  };
}

describe('WordPress helpers', () => {
  it('derives alt text only from descriptive file names', () => {
    expect(
      altFromFilename('https://x/wp-content/uploads/blue-boiler-front-panel-300x200.jpg'),
    ).toBe('Blue boiler front panel');
    expect(altFromFilename('https://x/IMG_4821.jpg')).toBeNull();
    expect(altFromFilename('https://x/a3f9c2d1e4b5a6c7.png')).toBeNull();
  });

  it('reads image sources from issues', () => {
    expect(
      imageSrcsFromIssue({ checkId: 'x', message: '', evidence: '<img src="/a/b.webp" alt>' }),
    ).toEqual(['/a/b.webp']);
  });

  it('rejects a wrong password at discovery', async () => {
    const c = new WpClient({ url: base, user: USER, appPassword: 'wrong' });
    await expect(c.discover()).rejects.toThrow(/Not logged in/);
  });
});

describe('applyFixes → wordpress', () => {
  it('dry run plans without writing', async () => {
    const out = await applyFixes({
      result: audit(),
      config: config(),
      target: 'wordpress',
      dryRun: true,
    });
    expect(out.target).toBe('wordpress');
    if (out.target !== 'wordpress') return;
    const kinds = out.plan.changes.map((c) => `${c.kind}:${c.url ?? c.route}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        `seo-title:${base}/about/`,
        `seo-title:${base}/blog/fix-a-leak/`,
        `noindex:${base}/blog/fix-a-leak/`,
        `image-alt:${base}/wp-content/uploads/2026/01/blue-boiler-front-panel-300x200.jpg`,
        'robots-txt:/wp/v2/settings',
        'llms-txt:/wp/v2/settings',
      ]),
    );
    expect(
      out.plan.skipped.some((s) => /IMG_4821/.test(s.url ?? '') && /human/.test(s.reason)),
    ).toBe(true);
    const title = out.plan.changes.find(
      (c) => c.kind === 'seo-title' && c.url?.endsWith('/about/'),
    )!;
    expect(title).toMatchObject({
      field: 'avc_seo.title',
      before: '',
      after: 'About Acme Plumbing',
      via: 'helper',
    });
    expect(out.planned).toBe(out.plan.changes.length);
    expect(state.writes).toEqual([]);
    expect(out.summary).toContain('Dry run');
  });

  it('applies with a snapshot and rolls back', async () => {
    const out = await applyFixes({
      result: audit(),
      config: config(),
      target: 'wordpress',
      dryRun: false,
    });
    if (out.target !== 'wordpress') throw new Error('target');
    expect(out.failed).toBe(0);
    expect(out.applied).toBe(out.plan.changes.length);
    const about = state.posts.find((p) => p.slug === 'about')!;
    expect(about.seo.title).toBe('About Acme Plumbing');
    expect(state.posts.find((p) => p.slug === 'fix-a-leak')!.seo.title).toBe(
      'How to fix a dripping tap – Acme Plumbing',
    );
    expect(state.posts.find((p) => p.slug === 'fix-a-leak')!.seo.noindex).toBe(false);
    expect(state.media[0].alt_text).toBe('Blue boiler front panel');
    expect(state.media[1].alt_text).toBe('');
    // ClaudeBot (training) opt-out is kept; search and user bots get the * paths
    expect(String(state.settings.avc_robots_txt)).toMatch(
      /User-agent: Claude-SearchBot[\s\S]*?Disallow: \/wp-admin\//,
    );
    expect(String(state.settings.avc_robots_txt)).toMatch(
      /User-agent: ClaudeBot[\s\S]*?Disallow: \/\n/,
    );
    expect(String(state.settings.avc_llms_txt)).toContain('# Acme Plumbing');
    // snapshot exists with before-values
    const snap = JSON.parse(readFileSync(out.snapshotFile!, 'utf8'));
    expect(snap.kind).toBe('wordpress');
    expect(snap.results.every((r: { status: string }) => r.status === 'applied')).toBe(true);
    expect(out.snapshotFile!.startsWith(join(dataDir, 'rollback', '127.0.0.1'))).toBe(true);

    // someone edits the alt text afterwards: rollback leaves it alone
    state.media[0].alt_text = 'Edited by a human';
    const rb = await rollback(out.snapshotFile!, { config: config() });
    expect(rb.target).toBe('wordpress');
    expect(about.seo.title).toBe('');
    expect(state.posts.find((p) => p.slug === 'fix-a-leak')!.seo.noindex).toBe(true);
    expect(state.settings.avc_robots_txt).toBe('');
    expect(state.media[0].alt_text).toBe('Edited by a human');
    expect(rb.results.find((r) => r.change.kind === 'image-alt')?.status).toBe('skipped');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('skips a change whose value moved since the plan', async () => {
    const { planWordPressFixes, applyWordPressPlan } =
      await import('../src/fixes/apply/wordpress.js');
    const client = new WpClient({ url: base, user: USER, appPassword: PASS });
    const plan = await planWordPressFixes(audit(), client, { only: ['onpage.title-*'] });
    expect(plan.changes.every((c) => c.kind === 'seo-title')).toBe(true);
    state.posts.find((p) => p.slug === 'about')!.seo.title = 'Changed meanwhile';
    const res = await applyWordPressPlan(plan, client, { dryRun: false, dataDir });
    expect(res.results.find((r) => r.change.url?.endsWith('/about/'))?.status).toBe('skipped');
    expect(state.posts.find((p) => p.slug === 'about')!.seo.title).toBe('Changed meanwhile');
  });

  it('without the helper, skips SEO fields and robots with an install hint but still fixes alt text', async () => {
    reset(false);
    state.media[0].source_url = `${base}/wp-content/uploads/2026/01/blue-boiler-front-panel.jpg`;
    state.media[1].source_url = `${base}/wp-content/uploads/2026/01/IMG_4821.jpg`;
    const out = await applyFixes({
      result: audit(),
      config: config(),
      target: 'wordpress',
      dryRun: true,
    });
    if (out.target !== 'wordpress') throw new Error('target');
    expect(out.plan.changes.map((c) => c.kind)).toEqual(['image-alt']);
    expect(
      out.plan.skipped.filter((s) => /avc-helper\.php/.test(s.reason)).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('explains a missing password', async () => {
    const cfg = config();
    delete cfg.sites[0].connections!.wordpress!.appPassword;
    const prev = process.env.AVC_WP_APP_PASSWORD;
    delete process.env.AVC_WP_APP_PASSWORD;
    await expect(
      applyFixes({ result: audit(), config: cfg, target: 'wordpress', dryRun: true }),
    ).rejects.toThrow(/Application Password/);
    if (prev) process.env.AVC_WP_APP_PASSWORD = prev;
  });
});

describe('AVC helper mu-plugin (PHP)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync: write } = await import('node:fs');
  const { WP_HELPER_PHP } = await import('../src/fixes/apply/wp-helper.js');
  let php = true;
  try {
    execFileSync('php', ['-v']);
  } catch {
    php = false;
  }
  it.skipIf(!php)('maps fields to Yoast meta and serves robots.txt from the option', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avc-php-'));
    write(join(dir, 'avc-helper.php'), WP_HELPER_PHP);
    write(
      join(dir, 'run.php'),
      `<?php
define('ABSPATH', '/');
define('WPSEO_VERSION', '25.0');
$GLOBALS['meta'] = array(); $GLOBALS['opts'] = array('avc_robots_txt' => "User-agent: *\\nAllow: /\\n"); $GLOBALS['hooks'] = array();
function add_action($h, $cb, $p = 10) { $GLOBALS['hooks'][$h][] = $cb; }
function add_filter($h, $cb, $p = 10) { $GLOBALS['hooks'][$h][] = $cb; }
function get_post_meta($id, $k, $single) { return $GLOBALS['meta'][$id][$k] ?? ''; }
function update_post_meta($id, $k, $v) { $GLOBALS['meta'][$id][$k] = $v; }
function get_option($k, $d = '') { return $GLOBALS['opts'][$k] ?? $d; }
function sanitize_text_field($s) { return trim(strip_tags($s)); }
function sanitize_textarea_field($s) { return trim(strip_tags($s)); }
require __DIR__ . '/avc-helper.php';
avc_helper_set_seo(5, array('title' => 'New <b>title</b>', 'description' => 'Desc', 'noindex' => false));
$robots = $GLOBALS['hooks']['robots_txt'][0]('generated');
echo json_encode(array('meta' => $GLOBALS['meta'][5], 'get' => avc_helper_get_seo(5), 'robots' => $robots, 'plugin' => avc_helper_seo_plugin()));
`,
    );
    const out = JSON.parse(execFileSync('php', [join(dir, 'run.php')], { encoding: 'utf8' }));
    expect(out.plugin).toBe('yoast');
    expect(out.meta).toEqual({
      _yoast_wpseo_title: 'New title',
      _yoast_wpseo_metadesc: 'Desc',
      '_yoast_wpseo_meta-robots-noindex': '2',
    });
    expect(out.get).toEqual({
      title: 'New title',
      description: 'Desc',
      noindex: false,
      canonical: '',
    });
    expect(out.robots).toBe('User-agent: *\nAllow: /\n');
    rmSync(dir, { recursive: true, force: true });
  });
});
