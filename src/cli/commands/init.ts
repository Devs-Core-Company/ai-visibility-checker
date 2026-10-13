import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteConfig } from '../../core/config.js';
import { siteIdFromUrl, userConfigPath } from '../../core/config.js';
import { ask, interactive } from '../ask.js';
import { c, ok, warn } from '../output.js';
import { engines, getConfig, toUrl, upsertUserSite } from '../services.js';

interface InitOpts {
  url?: string;
  brand?: string;
  competitors?: string[];
  user?: boolean;
  yes?: boolean;
}

export async function cmdInit(opts: InitOpts): Promise<void> {
  const quiet = opts.yes || !interactive();
  console.log(c.bold('AI Visibility Checker: set up a site'));
  console.log(
    c.dim(
      'Answers go into a config file. Keys never do; they go in ~/.avc/config.json or env vars.\n',
    ),
  );

  let url = opts.url ?? '';
  if (!url && !quiet) url = await ask('Your site URL', 'https://');
  if (!url || url === 'https://')
    throw new Error('A site URL is needed. Pass --url https://yoursite.com.');
  url = toUrl(url);
  const id = siteIdFromUrl(url);
  const defName = id.split('.')[0].replace(/^./, (x) => x.toUpperCase());

  const name = opts.brand ?? (quiet ? defName : await ask('Brand name, as people say it', defName));
  let competitors = opts.competitors ?? [];
  if (!competitors.length && !quiet) {
    const raw = await ask('Main competitors, comma-separated (optional)', '');
    competitors = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  let location = '';
  if (!quiet) location = await ask('Where you operate, if it matters (optional)', '');

  const site: SiteConfig = {
    id,
    url,
    brand: {
      name,
      ...(location ? { location } : {}),
      competitors: competitors.map((n) =>
        /\./.test(n) ? { name: n.split('.')[0], domain: n } : { name: n },
      ),
    },
    crawl: { maxPages: 500, render: 'auto' },
  };

  if (opts.user) {
    upsertUserSite(site);
    ok(`Saved ${id} to ${userConfigPath()}`);
  } else {
    const file = join(process.cwd(), 'avc.config.json');
    let existing: { sites?: SiteConfig[] } & Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        existing = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        warn(`${file} is not valid JSON; leaving it alone.`);
        throw new Error('Fix or remove avc.config.json, then run `avc init` again.');
      }
    }
    const sites = (existing.sites ?? []).filter((s) => s.id !== id);
    sites.push(site);
    writeFileSync(file, JSON.stringify({ ...existing, sites }, null, 2) + '\n');
    ok(`Saved ${id} to ${file}`);
    console.log(c.dim('  This file is safe to commit. Do not put keys in it.'));
  }

  const config = getConfig(true);
  const status = engines(config);
  const live = status.filter((e) => e.available && e.via !== 'mock');
  console.log('\n' + c.bold('Keys'));
  if (live.length) {
    console.log(`  AI engines ready: ${live.map((e) => `${e.label} (${e.via})`).join(', ')}`);
  } else {
    console.log('  No AI keys yet. Audits work without them. To track AI visibility, set either:');
    console.log(
      `    ${c.cyan('AI_GATEWAY_API_KEY')}  one Vercel AI Gateway key for every engine, or`,
    );
    console.log(
      `    ${c.cyan('OPENAI_API_KEY')}, ${c.cyan('ANTHROPIC_API_KEY')}, ${c.cyan('GOOGLE_GENERATIVE_AI_API_KEY')}, ${c.cyan('PERPLEXITY_API_KEY')}`,
    );
    console.log(
      `  Or save them in the dashboard: ${c.cyan('avc ui')} → Settings. Spend caps: $${config.ai.maxRunUsd} a run, $${config.ai.maxMonthUsd} a month.`,
    );
  }
  console.log(
    '  Search Console, GA4, PageSpeed, Bing, logs, WordPress: ' +
      c.cyan(`avc connect <source> ${id}`),
  );

  console.log('\n' + c.bold('Next'));
  console.log(`  ${c.cyan(`avc audit ${id}`)}              full audit`);
  console.log(`  ${c.cyan(`avc prompts suggest ${id}`)}    prompts to track`);
  console.log(`  ${c.cyan(`avc visibility ${id}`)}         ask the AI engines`);
  console.log(`  ${c.cyan('avc ui')}                       dashboard`);
}
