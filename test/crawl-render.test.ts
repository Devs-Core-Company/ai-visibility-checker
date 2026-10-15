import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from './fixtures/serve.js';
import { crawlSite } from '../src/crawl/index.js';
import { chromeArgs, findChrome, renderPages } from '../src/crawl/render.js';
import type { PageData } from '../src/core/types.js';

let fx: FixtureServer;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(async () => {
  await fx.close();
});

const chrome = findChrome();

describe('render', () => {
  it('skips cleanly, with a reason, when the browser cannot start', async () => {
    // An executable that is not a browser: the launch fails at once, wherever the tests run.
    // (A path that does not exist would fall back to auto-detection and launch the machine's
    // real Chrome, which is slow and made this test time out on busy CI runners.)
    const logs: string[] = [];
    const page = {
      isHtml: true,
      status: 200,
      url: `${fx.url}/app`,
      finalUrl: `${fx.url}/app`,
    } as PageData;
    const r = await renderPages([page], {
      chromePath: process.execPath,
      limit: 1,
      log: (_l, m) => logs.push(m),
    });
    expect(r).toMatchObject({ rendered: 0, skipped: true, chromePath: process.execPath });
    expect(r.reason).toMatch(/could not start/);
  }, 20_000);

  it.skipIf(!chrome)(
    'renders the JS page in auto mode and fills rendered fields',
    async () => {
      const site = await crawlSite({
        startUrl: fx.url,
        delayMs: 0,
        render: 'auto',
        renderLimit: 6,
        checkImages: false,
        useSitemaps: false,
        exclude: ['/slow'],
      });
      const app = site.pages.get(`${fx.url}/app`)!;
      expect(app.wordCount).toBe(0);
      expect(app.rendered).toBeDefined();
      expect(app.rendered!.wordCount).toBeGreaterThan(200);
      expect(app.rendered!.headings[0]).toEqual({ level: 1, text: 'Kitchen planner' });
      expect(app.rendered!.consoleErrors.join(' ')).toContain('planner demo error');
      const home = site.pages.get(`${fx.url}/`)!;
      expect(home.rendered?.structuredData.flatMap((s) => s.types)).toContain('Organization');
      expect(home.rendered?.timings?.domContentLoaded).toBeGreaterThan(0);
      expect(site.stats.rendered).toBeGreaterThanOrEqual(2);
      expect(site.stats.rendered).toBeLessThanOrEqual(6);
    },
    90_000,
  );
});

describe('chromeArgs', () => {
  it('never overrides Playwright’s --disable-features list (that re-enables background calls)', () => {
    for (const mobile of [true, false]) {
      const args = chromeArgs({ mobile, concurrency: 3 });
      expect(args.some((a) => a.startsWith('--disable-features'))).toBe(false);
      expect(args).toContain('--disable-background-networking');
    }
  });
});
