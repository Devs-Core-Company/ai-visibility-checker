#!/usr/bin/env node
// Builds the Claude Desktop extension: build/ai-visibility-checker-<version>.mcpb
//
//   npm run bundle:mcpb
//
// The bundle holds the compiled server (dist/), the launcher, the dashboard assets and the
// production dependencies. Its manifest declares a settings form (user_config) that Claude
// Desktop shows under Settings → Extensions → AI Visibility Checker. Key fields are marked
// sensitive, so Claude Desktop masks them and keeps them in the OS secure storage, then passes
// them to the server as the usual environment variables (OPENAI_API_KEY, …). The form is built
// from SECRET_FIELDS in src/core/secrets.ts, so it always matches what the app reads.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
const stage = join(out, 'mcpb');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

console.log('1/5 Compiling');
run(npm, ['run', 'compile']);

// Only these keys get a field: the AI engines plus the common data sources. Every other key
// still works from the OS keychain (`avc keys`) or an environment variable.
const { SECRET_FIELDS } = await import(pathToFileURL(join(root, 'dist/core/secrets.js')).href);
const IN_FORM = new Set([
  'gateway',
  'openai',
  'anthropic',
  'google-ai',
  'perplexity',
  'xai',
  'psi',
  'bing',
]);
const fields = SECRET_FIELDS.filter((f) => IN_FORM.has(f.id));
const configKey = (id) => `${id.replace(/-/g, '_')}_key`;

const userConfig = {};
const env = {
  // Lets AVC label these keys "from Claude Desktop settings" instead of "env".
  AVC_KEY_SOURCE: 'claude-desktop',
  AVC_MAX_RUN_USD: '${user_config.max_run_usd}',
  AVC_MAX_MONTH_USD: '${user_config.max_month_usd}',
};
for (const f of fields) {
  userConfig[configKey(f.id)] = {
    type: 'string',
    title: `${f.label} API key`,
    description: `Optional. ${f.unlocks}${f.getAt ? ` Get one at ${f.getAt}` : ''}`,
    sensitive: true,
    required: false,
  };
  env[f.env[0]] = `\${user_config.${configKey(f.id)}}`;
}
userConfig.max_run_usd = {
  type: 'number',
  title: 'Spend cap per AI visibility run (USD)',
  description: 'A run stops before it would pass this. AI keys are only used after you confirm.',
  default: 3,
  min: 0,
  max: 100,
};
userConfig.max_month_usd = {
  type: 'number',
  title: 'Spend cap per calendar month (USD)',
  description: 'No run starts once this month’s estimated spend reaches the cap.',
  default: 30,
  min: 0,
  max: 1000,
};

// The tool list shown on the extension's page, read from the real server so it never drifts.
async function listServerTools() {
  process.env.AVC_DATA_DIR = mkdtempSync(join(tmpdir(), 'avc-mcpb-'));
  process.env.AVC_SECRET_STORE = 'file';
  const { buildMcpServer } = await import(pathToFileURL(join(root, 'dist/mcp/server.js')).href);
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildMcpServer().connect(a);
  const client = new Client({ name: 'build-mcpb', version: pkg.version });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  // First sentence only: the page shows a list, not the full instructions for the model.
  return tools.map((t) => ({
    name: t.name,
    description: (t.title ? `${t.title}: ` : '') + (t.description ?? '').split(/(?<=\.)\s/)[0],
  }));
}
const tools = await listServerTools();

const manifest = {
  manifest_version: '0.3',
  name: 'ai-visibility-checker',
  display_name: 'AI Visibility Checker',
  version: pkg.version,
  description:
    'Audit your website for Google and AI engines, and check whether ChatGPT, Claude, Gemini and Perplexity name you. Runs on your computer.',
  long_description:
    'AI Visibility Checker by Devs Core audits your own website the way Google and AI engines see it, and tells you what to fix first.\n\n' +
    '**What it does**\n' +
    '- Crawls your site and runs more than 600 checks: technical SEO, content, AI crawler access (GPTBot, ClaudeBot, PerplexityBot and others), AEO/GEO readiness and agentic-web standards (llms.txt, MCP, A2A).\n' +
    '- Ranks the fixes by impact, with stack-aware steps (Next.js, WordPress, Shopify and more) and a ready prompt for a coding agent. WordPress fixes can be applied after a dry run, with a rollback.\n' +
    '- With your own AI keys, checks whether ChatGPT, Claude, Gemini and Perplexity name and cite your brand, and against which competitors. It shows the cost first and runs only after you confirm, within your spend caps.\n' +
    '- Generates llms.txt, robots.txt rules for AI crawlers and Organization JSON-LD from the audit.\n\n' +
    '**Everything runs on your computer.** Audits, history and keys stay on your machine; pages are fetched from your site directly.\n\n' +
    '**Keys are optional.** Audits need none. Add AI keys below to measure whether AI engines name you; without them those steps are skipped and the results say so. ' +
    'Keys entered here are kept by Claude Desktop in your system’s secure storage and passed only to this extension on your computer. They are sent only to the provider each key belongs to, never to Devs Core. ' +
    'Keys you saved with `avc keys` (in your OS keychain) are used too; keys entered here take precedence.',
  author: { name: 'Devs Core', email: 'contact@devs-core.com', url: 'https://devs-core.com' },
  repository: {
    type: 'git',
    url: 'https://github.com/Devs-Core-Company/ai-visibility-checker.git',
  },
  homepage: pkg.homepage,
  documentation: 'https://github.com/Devs-Core-Company/ai-visibility-checker/blob/main/docs/MCP.md',
  support: 'https://github.com/Devs-Core-Company/ai-visibility-checker/issues',
  privacy_policies: ['https://devs-core.com/privacy'],
  icon: 'public/icon.png',
  license: pkg.license,
  keywords: ['seo', 'ai-visibility', 'geo', 'aeo', 'llms-txt', 'audit', 'ai-crawlers', 'schema'],
  server: {
    type: 'node',
    entry_point: 'bin/avc.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/bin/avc.mjs', 'mcp'],
      env,
    },
  },
  tools,
  compatibility: {
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: { node: '>=22.5.0' },
  },
  user_config: userConfig,
};

console.log('2/5 Staging files');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const p of ['bin', 'dist', 'public', 'LICENSE', 'NOTICE', 'README.md', 'package-lock.json'])
  if (existsSync(join(root, p))) cpSync(join(root, p), join(stage, p), { recursive: true });
// No src/: the launcher then always runs the compiled dist/, with no TypeScript step at startup.
const { devDependencies: _dev, scripts: _scripts, ...prodPkg } = pkg;
writeFileSync(join(stage, 'package.json'), JSON.stringify(prodPkg, null, 2) + '\n');
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(
  join(stage, '.mcpbignore'),
  ['*.map', '**/*.d.ts', '**/*.md', '!README.md'].join('\n') + '\n',
);

console.log('3/5 Installing production dependencies');
run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);

console.log('4/5 Validating the manifest');
run(npx, ['-y', MCPB_CLI, 'validate', join(stage, 'manifest.json')]);

console.log('5/5 Packing');
const file = join(out, `ai-visibility-checker-${pkg.version}.mcpb`);
rmSync(file, { force: true });
run(npx, ['-y', MCPB_CLI, 'pack', stage, file]);
console.log(
  `\nBuilt ${file}\nInstall: double-click it, or drag it into Claude Desktop → Settings → Extensions.`,
);
