#!/usr/bin/env node
// Launcher for `avc`. Uses the compiled build (dist/) when it exists, as in Docker
// or a local `npm run compile`. Otherwise it runs the TypeScript source through tsx,
// so installing straight from GitHub needs no build step.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, 'dist', 'cli.js');

if (existsSync(built)) {
  await import(pathToFileURL(built).href);
} else {
  const { register } = await import('tsx/esm/api');
  register({ tsconfig: join(root, 'tsconfig.json') });
  await import(pathToFileURL(join(root, 'src', 'cli.ts')).href);
}
