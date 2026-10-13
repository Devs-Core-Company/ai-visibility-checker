import { accessSync, constants, mkdirSync } from 'node:fs';
import { findChrome } from '../../crawl/render.js';
import { connectionStatus } from '../../connect/index.js';
import { APP_VERSION } from '../../core/version.js';
import { userConfigPath } from '../../core/config.js';
import { c } from '../output.js';
import { allSites, engines, getConfig, getStore, monthSpend } from '../services.js';

export interface DoctorItem {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  help?: string;
}

export async function doctorReport(opts: { test?: boolean } = {}): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  items.push({
    name: 'Node.js',
    status: nodeOk ? 'ok' : 'fail',
    detail: process.versions.node,
    help: nodeOk ? undefined : 'Install Node 22.5+ or 24 from https://nodejs.org.',
  });
  try {
    await import('node:sqlite');
    items.push({ name: 'SQLite (node:sqlite)', status: 'ok', detail: 'available' });
  } catch {
    items.push({
      name: 'SQLite (node:sqlite)',
      status: 'fail',
      detail: 'not available',
      help: 'Use Node 22.5 or newer.',
    });
  }

  const chrome = findChrome();
  items.push({
    name: 'Chrome / Chromium',
    status: chrome ? 'ok' : 'warn',
    detail: chrome ?? 'not found',
    help: chrome
      ? undefined
      : 'Optional: install Chrome, or set AVC_CHROME_PATH, to compare raw HTML with what JavaScript renders.',
  });

  const config = getConfig();
  try {
    mkdirSync(config.dataDir, { recursive: true });
    accessSync(config.dataDir, constants.W_OK);
    items.push({ name: 'Data folder', status: 'ok', detail: config.dataDir });
  } catch (e) {
    items.push({
      name: 'Data folder',
      status: 'fail',
      detail: `${config.dataDir} is not writable`,
      help: 'Set AVC_DATA_DIR to a folder you own.',
    });
  }
  try {
    const store = getStore(config);
    items.push({ name: 'Database', status: 'ok', detail: store.path });
  } catch (e) {
    items.push({ name: 'Database', status: 'fail', detail: (e as Error).message });
  }
  items.push({ name: 'User config', status: 'info', detail: userConfigPath() });

  const eng = engines(config);
  const live = eng.filter((e) => e.available && e.via !== 'mock');
  items.push({
    name: 'AI engines',
    status: live.length ? 'ok' : 'warn',
    detail: live.length
      ? live.map((e) => `${e.label} (${e.via})`).join(', ')
      : config.ai.mock
        ? 'mock mode (sample answers)'
        : 'no keys: audits work, AI visibility uses sample answers',
    help: live.length
      ? undefined
      : 'Set AI_GATEWAY_API_KEY, or OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / PERPLEXITY_API_KEY.',
  });
  items.push({
    name: 'AI spend',
    status: 'info',
    detail: `$${monthSpend(config).toFixed(2)} this month · caps $${config.ai.maxRunUsd} a run, $${config.ai.maxMonthUsd} a month`,
  });

  const sites = allSites(config).filter((s) => s.configured);
  items.push({
    name: 'Sites',
    status: sites.length ? 'ok' : 'info',
    detail: sites.length ? sites.map((s) => s.id).join(', ') : 'none configured',
    help: sites.length ? undefined : 'Run `avc init`.',
  });
  const conns = await connectionStatus(sites[0], config, { test: Boolean(opts.test) });
  for (const r of conns)
    items.push({
      name: `  ${r.label}`,
      status: r.ok === false ? 'fail' : r.ok === true || r.configured ? 'ok' : 'info',
      detail: r.detail,
      help: r.help,
    });
  const alerts = config.alerts?.webhookUrl || config.alerts?.email?.to;
  items.push({
    name: 'Alerts',
    status: alerts ? 'ok' : 'info',
    detail: alerts
      ? [config.alerts?.webhookUrl ? 'webhook' : '', config.alerts?.email?.to ? 'email' : '']
          .filter(Boolean)
          .join(' + ')
      : 'not set',
  });
  return items;
}

export async function cmdDoctor(opts: { json?: boolean }): Promise<void> {
  const items = await doctorReport();
  if (opts.json) {
    process.stdout.write(JSON.stringify({ version: APP_VERSION, items }, null, 2) + '\n');
    return;
  }
  console.log(c.bold(`AI Visibility Checker ${APP_VERSION}`) + c.dim(' · doctor\n'));
  const icon = { ok: c.green('✓'), warn: c.yellow('!'), fail: c.red('✗'), info: c.dim('·') };
  for (const i of items) {
    console.log(`${icon[i.status]} ${i.name.padEnd(26)} ${i.detail}`);
    if (i.help && i.status !== 'ok') console.log(`  ${''.padEnd(26)} ${c.dim(i.help)}`);
  }
  if (items.some((i) => i.status === 'fail')) process.exitCode = 1;
}
