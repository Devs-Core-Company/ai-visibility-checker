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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const manifest = {
  manifest_version: '0.3',
  name: 'ai-visibility-checker',
  display_name: 'AI Visibility Checker',
  version: pkg.version,
  description:
    'Audit your website for Google and AI engines, and check whether ChatGPT, Claude, Gemini and Perplexity name you. Runs on your computer.',
  long_description:
    'Technical SEO, AEO/GEO, AI crawler access and agentic-web checks for your own site, plus AI visibility runs with your own API keys.\n\n' +
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
  license: pkg.license,
  keywords: ['seo', 'ai-visibility', 'geo', 'aeo', 'llms-txt', 'audit'],
  server: {
    type: 'node',
    entry_point: 'bin/avc.mjs',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/bin/avc.mjs', 'mcp'],
      env,
    },
  },
  tools_generated: true,
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
