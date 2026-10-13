#!/usr/bin/env node
// Launcher for `avc`. Uses the compiled build (dist/) when it exists and is up to date, as
// in Docker or after `npm run compile`. Otherwise it runs the TypeScript source through tsx,
// so installing straight from GitHub needs no build step, and editing src/ in a checkout
// never silently runs an older build.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'dist', 'cli.js');
const src = join(root, 'src');

/** Newest modification time of any file under dir (ms), or 0. */
function newest(dir) {
  let max = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    max = Math.max(max, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return max;
}

const useBuilt =
  existsSync(built) && (!existsSync(src) || statSync(built).mtimeMs >= newest(src));

if (useBuilt) {
  await import(pathToFileURL(built).href);
} else {
  const { register } = await import('tsx/esm/api');
  register({ tsconfig: join(root, 'tsconfig.json') });
  await import(pathToFileURL(join(src, 'cli.ts')).href);
}
